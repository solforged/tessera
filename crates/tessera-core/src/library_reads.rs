use crate::library::*;
use crate::library_store::{
    enum_at, json, json_at, source, source_at, source_columns, source_siglum,
};
use crate::reads::{fts_query, hidden_blocks};
use crate::storage::{block_at, block_columns, not_found, validation};
use crate::{Actor, Batch, BlockCapabilities, BlockInPage, Direction, Notebook, Operation, Result};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;

macro_rules! passage_columns {
    () => {
        "p.id, p.ordinal, p.kind, p.level, p.text, p.locator,
         p.anchor, p.resource, p.marks, p.start"
    };
}
fn passage_at(r: &rusqlite::Row<'_>, n: usize) -> rusqlite::Result<Passage> {
    Ok(Passage {
        id: r.get(n)?,
        ordinal: r.get(n + 1)?,
        kind: enum_at(r, n + 2)?,
        level: r.get(n + 3)?,
        text: r.get(n + 4)?,
        locator: r.get(n + 5)?,
        anchor: r.get(n + 6)?,
        resource: r.get(n + 7)?,
        marks: json_at(r, n + 8)?,
        start: r.get(n + 9)?,
    })
}

fn publication_year(published: Option<&str>) -> Option<i32> {
    let year = published?.get(..4)?;
    (year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| year.parse::<i32>().ok())
        .flatten()
        .filter(|year| *year > 0)
}

fn publication_decade(published: Option<&str>) -> Option<i32> {
    publication_year(published).map(|year| year / 10 * 10)
}

/// A language's primary subtag, so names, `en`, `en-US`, `en_GB` and `eng` browse as one language.
fn language_code(value: &str) -> String {
    let normalized = normalize_language_name(value);
    let primary = normalized
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let code = match primary.as_str() {
        "eng" => "en",
        "fre" | "fra" => "fr",
        "ger" | "deu" => "de",
        "spa" => "es",
        "ita" => "it",
        "lat" => "la",
        "rus" => "ru",
        "por" => "pt",
        "dut" | "nld" => "nl",
        "chi" | "zho" => "zh",
        "jpn" => "ja",
        _ => {
            return isolang::Language::from_639_3(&primary)
                .and_then(|language| language.to_639_1())
                .map_or_else(|| primary, str::to_owned);
        }
    };
    code.to_owned()
}

fn count_value(counts: &mut HashMap<String, usize>, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        if let Some(count) = counts.get_mut(value) {
            *count += 1;
        } else {
            counts.insert(value.to_owned(), 1);
        }
    }
}

fn value_facets(counts: HashMap<String, usize>) -> Vec<ValueFacet> {
    let mut facets: Vec<_> = counts
        .into_iter()
        .map(|(value, count)| ValueFacet { value, count })
        .collect();
    facets.sort_by_cached_key(|facet| (std::cmp::Reverse(facet.count), facet.value.to_lowercase()));
    facets
}
pub(crate) fn passage(conn: &Connection, id: &str) -> Result<Passage> {
    let mut statement = conn.prepare_cached(concat!(
        "SELECT ",
        passage_columns!(),
        " FROM passages p
         WHERE p.id = ?1"
    ))?;
    statement
        .query_row([id], |r| passage_at(r, 0))
        .optional()?
        .ok_or_else(|| not_found(id))
}

fn toc(conn: &Connection, snapshot: &str) -> Result<Vec<TocEntry>> {
    // Old EPUB imports may have saved the NCX's lone "Start" entry. The
    // embedded HTML contents survived as linked passage text; repair only
    // derived navigation, keeping snapshot, passage and citation identities.
    let sparse: bool = conn.query_row(
        "SELECT format = 'epub' AND json_array_length(toc) < 3 FROM snapshots WHERE id = ?1",
        [snapshot],
        |r| r.get(0),
    )?;
    if sparse {
        let mut candidates = conn.prepare_cached(
            "SELECT text, marks FROM passages WHERE snapshot_id = ?1
             AND json_array_length(marks) >= 3 ORDER BY ordinal",
        )?;
        let mut rows = candidates.query([snapshot])?;
        while let Some(row) = rows.next()? {
            let text: String = row.get(0)?;
            let marks: Vec<Mark> = json_at(row, 1)?;
            let links: Vec<_> = marks
                .iter()
                .filter(|mark| matches!(mark.kind, MarkKind::Internal { .. }))
                .collect();
            let length = text.encode_utf16().count();
            if links.len() < 3
                || links
                    .iter()
                    .map(|mark| (mark.end - mark.start) as usize)
                    .sum::<usize>()
                    * 5
                    < length * 4
            {
                continue;
            }
            let units: Vec<_> = text.encode_utf16().collect();
            let entries: Vec<_> = links
                .into_iter()
                .filter_map(|mark| {
                    let MarkKind::Internal { locator } = &mark.kind else {
                        return None;
                    };
                    let title = String::from_utf16_lossy(
                        units.get(mark.start as usize..mark.end as usize)?,
                    );
                    Some(TocEntry {
                        title,
                        locator: locator.clone(),
                        level: 1,
                        ordinal: None,
                        start: None,
                    })
                })
                .collect();
            if entries.len() >= 3 {
                conn.execute(
                    "UPDATE snapshots SET toc = ?2 WHERE id = ?1",
                    params![snapshot, json(&entries)],
                )?;
                break;
            }
        }
    }
    // Each entry finds its passage by locator or ID through their indexes, and
    // by element anchor in one pass over the passages that have one. An OR
    // across the three columns scanned every passage once per entry.
    let mut statement = conn.prepare_cached(
        "WITH e AS MATERIALIZED (
             SELECT CAST(e.key AS INTEGER) AS k, json_extract(e.value, '$.title') AS title,
                    json_extract(e.value, '$.locator') AS locator,
                    json_extract(e.value, '$.level') AS level
             FROM snapshots s, json_each(s.toc) e
             WHERE s.id = ?1
         ), hits AS (
             SELECT e.k, p.ordinal, p.start
             FROM e JOIN passages p ON p.snapshot_id = ?1 AND p.locator = e.locator
             UNION ALL
             SELECT e.k, p.ordinal, p.start
             FROM e JOIN passages p ON p.id = e.locator AND p.snapshot_id = ?1
             UNION ALL
             SELECT e.k, p.ordinal, p.start
             FROM passages p CROSS JOIN e
             WHERE p.snapshot_id = ?1 AND p.anchor IS NOT NULL AND p.anchor = e.locator
         )
         SELECT e.title, e.locator, e.level, MIN(h.ordinal), MIN(h.start)
         FROM e LEFT JOIN hits h ON h.k = e.k
         GROUP BY e.k
         ORDER BY e.k",
    )?;
    Ok(statement
        .query_map([snapshot], |r| {
            Ok(TocEntry {
                title: r.get(0)?,
                locator: r.get(1)?,
                level: r.get(2)?,
                ordinal: r.get(3)?,
                start: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

// Each range is joined to its passages once; capability sidecars do not query per block.
pub(crate) fn citations(
    conn: &Connection,
    ids: Option<&[String]>,
    snapshot: Option<&str>,
    visible: bool,
    range: Option<(i64, i64)>,
) -> Result<Vec<Citation>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        "SELECT c.id, c.block_id, c.snapshot_id,
                c.start_passage, c.start_offset, c.end_passage, c.end_offset,
                (SELECT source_id
                 FROM source_snapshots a
                 WHERE a.snapshot_id = c.snapshot_id
                 ORDER BY a.change_seq, a.rowid
                 LIMIT 1),
                first.locator, p.ordinal, p.text, first.ordinal, last.ordinal, c.triage, c.color, first.start + c.start_offset
         FROM citations c
         JOIN blocks b ON b.id = c.block_id
         JOIN passages first ON first.id = c.start_passage
         JOIN passages last ON last.id = c.end_passage
         JOIN passages p ON p.snapshot_id = c.snapshot_id
             AND p.ordinal BETWEEN first.ordinal AND last.ordinal
         WHERE c.active = 1 AND b.deletion_id IS NULL
         AND (?1 IS NULL OR c.block_id IN (SELECT value FROM json_each(?1)))
         AND (?2 IS NULL OR c.snapshot_id = ?2)
         AND (?3 = 0 OR b.id NOT IN (SELECT id FROM hidden))
         AND (?4 IS NULL OR (
             first.ordinal < ?5
             AND (last.ordinal > ?4 OR (last.ordinal = ?4 AND c.end_offset > 0))
         ))
         ORDER BY c.created_seq, c.id, p.ordinal"
    ))?;
    let mut rows = statement.query(params![
        ids.map(json),
        snapshot,
        visible,
        range.map(|r| r.0),
        range.map(|r| r.1)
    ])?;
    let mut result: Vec<Citation> = vec![];
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        if result.last().is_none_or(|c| c.id != id) {
            result.push(Citation {
                id,
                block_id: r.get(1)?,
                snapshot_id: r.get(2)?,
                start: PassagePoint {
                    passage_id: r.get(3)?,
                    offset: r.get(4)?,
                },
                end: PassagePoint {
                    passage_id: r.get(5)?,
                    offset: r.get(6)?,
                },
                source_id: r.get(7)?,
                quote: String::new(),
                locator: r.get(8)?,
                ordinal: r.get(11)?,
                position: Some(r.get(15)?),
                chapter_title: None,
                triage: r.get(13)?,
                color: r.get(14)?,
            });
        }
        let c = result.last_mut().expect("citation inserted");
        let ordinal: i64 = r.get(9)?;
        let text: String = r.get(10)?;
        let first: i64 = r.get(11)?;
        let last: i64 = r.get(12)?;
        if ordinal != first {
            c.quote.push_str("\n\n");
        }
        let start = if ordinal == first {
            c.start.offset as usize
        } else {
            0
        };
        let end = if ordinal == last {
            c.end.offset as usize
        } else {
            text.encode_utf16().count()
        };
        let units: Vec<_> = text.encode_utf16().skip(start).take(end - start).collect();
        c.quote.push_str(&String::from_utf16_lossy(&units));
    }
    let mut sections = HashMap::new();
    for citation in &mut result {
        if !sections.contains_key(&citation.snapshot_id) {
            sections.insert(
                citation.snapshot_id.clone(),
                toc(conn, &citation.snapshot_id)?,
            );
        }
        citation.chapter_title = sections[&citation.snapshot_id]
            .iter()
            .filter(|entry| {
                entry
                    .ordinal
                    .is_some_and(|ordinal| ordinal <= citation.ordinal)
            })
            .max_by_key(|entry| entry.ordinal)
            .map(|entry| entry.title.clone());
    }
    Ok(result)
}
pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    let ids: Vec<_> = capabilities.iter().map(|c| c.block_id.clone()).collect();
    let mut statement = conn.prepare_cached(concat!(
        "SELECT ",
        source_columns!(),
        ", b.text FROM sources s
         JOIN blocks b ON b.id = s.block_id
         WHERE s.active = 1 AND b.deletion_id IS NULL
         AND s.block_id IN (SELECT value FROM json_each(?1))"
    ))?;
    let source_rows = statement
        .query_map([json(&ids)], |row| {
            Ok((source_at(row)?, row.get::<_, String>(10)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let source_ids: Vec<_> = source_rows
        .iter()
        .map(|(source, _)| source.block_id.clone())
        .collect();
    let mut fields = crate::library_export::field_readings(conn, &source_ids)?;
    let mut sources: HashMap<_, _> = source_rows
        .into_iter()
        .map(|(mut source, title)| {
            let readings = fields.remove(&source.block_id).unwrap_or_default();
            source_siglum(&mut source, &title, &readings);
            (source.block_id.clone(), source)
        })
        .collect();
    let mut cited: HashMap<String, Vec<Citation>> = HashMap::new();
    for c in citations(conn, Some(&ids), None, false, None)? {
        cited.entry(c.block_id.clone()).or_default().push(c);
    }
    for c in &mut capabilities {
        c.source = sources.remove(&c.block_id);
        c.citations = cited.remove(&c.block_id).unwrap_or_default();
    }
    Ok(capabilities)
}
fn position(conn: &Connection, snapshot: &str) -> Result<Option<ReadingPosition>> {
    Ok(conn
        .query_row(
            "SELECT snapshot_id, passage_ordinal, updated_at
             FROM reading_positions
             WHERE snapshot_id = ?1",
            [snapshot],
            |r| {
                Ok(ReadingPosition {
                    snapshot_id: r.get(0)?,
                    passage_ordinal: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()?)
}
/// The reading position as a share of the text: the characters before the
/// passage it rests on. The library, the source header and the reader agree.
pub(crate) fn progress(conn: &Connection, snapshot: &str) -> Result<f64> {
    Ok(conn
        .query_row(
            "SELECT CAST(p.start AS REAL) / s.text_length
             FROM reading_positions rp
             JOIN snapshots s ON s.id = rp.snapshot_id
             JOIN passages p ON p.snapshot_id = rp.snapshot_id AND p.ordinal = rp.passage_ordinal
             WHERE rp.snapshot_id = ?1 AND s.text_length > 0",
            [snapshot],
            |r| r.get::<_, f64>(0),
        )
        .optional()?
        .unwrap_or(0.0)
        .clamp(0.0, 1.0))
}
impl Notebook {
    pub fn source(&self, id: &str) -> Result<SourceView> {
        let page = self.block(id)?;
        let source = source(&self.conn, id)?.ok_or_else(|| not_found(id))?;
        let mut statement = self.conn.prepare_cached(
            "SELECT s.id, s.sha256, s.format, s.media_type, s.metadata,
                    s.passage_count, s.text_length, a.attached_at, a.change_seq
             FROM source_snapshots a
             JOIN snapshots s ON s.id = a.snapshot_id
             WHERE a.source_id = ?1
             ORDER BY a.change_seq DESC, a.rowid DESC",
        )?;
        let snapshots = statement
            .query_map([id], |r| {
                Ok(SnapshotSummary {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    format: enum_at(r, 2)?,
                    media_type: r.get(3)?,
                    metadata: json_at(r, 4)?,
                    passage_count: r.get(5)?,
                    text_length: r.get(6)?,
                    attached_at: r.get(7)?,
                    change_seq: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let (toc, pos, progress) = if let Some(snapshot) = &source.current_snapshot_id {
            (
                toc(&self.conn, snapshot)?,
                position(&self.conn, snapshot)?,
                progress(&self.conn, snapshot)?,
            )
        } else {
            (vec![], None, 0.0)
        };
        Ok(SourceView {
            source,
            page,
            snapshots,
            toc,
            position: pos,
            progress,
        })
    }
    pub fn passage(&self, id: &str) -> Result<Passage> {
        passage(&self.conn, id)
    }
    pub fn passages(&self, snapshot: &str, from: i64, limit: usize) -> Result<PassagePage> {
        if from < 0 || limit > 500 {
            return Err(validation(
                "Passages require a nonnegative ordinal and a limit of at most 500.",
            ));
        }
        let total = self
            .conn
            .query_row(
                "SELECT passage_count
                 FROM snapshots
                 WHERE id = ?1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found(snapshot))?;
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            passage_columns!(),
            " FROM passages p
             WHERE p.snapshot_id = ?1 AND p.ordinal >= ?2
             ORDER BY p.ordinal
             LIMIT ?3"
        ))?;
        let passages = statement
            .query_map(params![snapshot, from, limit as i64], |r| passage_at(r, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let citations = if passages.is_empty() {
            vec![]
        } else {
            citations(
                &self.conn,
                None,
                Some(snapshot),
                true,
                Some((from, from + passages.len() as i64)),
            )?
        };
        Ok(PassagePage {
            passages,
            citations,
            total,
            toc: toc(&self.conn, snapshot)?,
        })
    }
    /// The ordinal of the passage with this ID, locator or element anchor.
    pub fn locate(&self, snapshot: &str, at: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT ordinal
                 FROM passages
                 WHERE snapshot_id = ?1 AND (id = ?2 OR locator = ?2 OR anchor = ?2)
                 ORDER BY ordinal
                 LIMIT 1",
                params![snapshot, at],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn search_passages(
        &self,
        q: &str,
        source_id: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<PassageHit>> {
        let query = fts_query(q);
        if query.is_empty() {
            return Ok(vec![]);
        }
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT s.block_id, b.text, p.snapshot_id, ",
            passage_columns!(),
            ", snippet(passages_fts, 0, ?5, ?6, ' … ', 24)
             FROM passages_fts
             JOIN passages p ON p.rowid = passages_fts.rowid
             JOIN source_snapshots a ON a.snapshot_id = p.snapshot_id
             JOIN sources s ON s.block_id = a.source_id
             JOIN blocks b ON b.id = s.block_id
             WHERE passages_fts MATCH ?1 AND s.active = 1 AND b.deletion_id IS NULL
             AND b.id NOT IN (SELECT id FROM hidden)
             AND ((?2 IS NOT NULL AND s.block_id = ?2) OR (?2 IS NULL AND a.snapshot_id = (
                 SELECT snapshot_id
                 FROM source_snapshots newest
                 WHERE newest.source_id = s.block_id
                 ORDER BY newest.change_seq DESC, newest.rowid DESC
                 LIMIT 1
             )))
             ORDER BY rank, p.ordinal, s.block_id, p.snapshot_id, p.id
             LIMIT ?3 OFFSET ?4"
        ))?;
        // Choose markers absent from every returned passage, including unusual control characters in source text.
        // Only a collision needs another query; the wire response contains structured text, never these markers.
        let mut start = "\u{1f}".to_owned();
        let mut end = "\u{1e}".to_owned();
        loop {
            let rows = statement
                .query_map(
                    params![
                        query,
                        source_id,
                        limit.min(500) as i64,
                        i64::try_from(offset).unwrap_or(i64::MAX),
                        start,
                        end,
                    ],
                    |r| {
                        Ok((
                            PassageHit {
                                source_id: r.get(0)?,
                                title: r.get(1)?,
                                snapshot_id: r.get(2)?,
                                passage: passage_at(r, 3)?,
                                snippet_parts: Vec::new(),
                            },
                            r.get::<_, String>(13)?,
                        ))
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.iter().any(|(hit, _)| {
                hit.passage.text.contains(start.as_str()) || hit.passage.text.contains(end.as_str())
            }) {
                start.push('\u{1f}');
                end.push('\u{1e}');
                continue;
            }
            return Ok(rows
                .into_iter()
                .map(|(mut hit, marked)| {
                    for (index, part) in marked.split(start.as_str()).enumerate() {
                        if index == 0 {
                            if !part.is_empty() {
                                hit.snippet_parts.push(SnippetPart {
                                    text: part.to_owned(),
                                    r#match: false,
                                });
                            }
                        } else if let Some((matched, rest)) = part.split_once(end.as_str()) {
                            hit.snippet_parts.push(SnippetPart {
                                text: matched.to_owned(),
                                r#match: true,
                            });
                            if !rest.is_empty() {
                                hit.snippet_parts.push(SnippetPart {
                                    text: rest.to_owned(),
                                    r#match: false,
                                });
                            }
                        }
                    }
                    hit
                })
                .collect());
        }
    }
    pub fn set_reading_position(
        &mut self,
        snapshot: &str,
        ordinal: i64,
    ) -> Result<ReadingProgress> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT passage_count
                 FROM snapshots
                 WHERE id = ?1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found(snapshot))?;
        if ordinal < 0 || ordinal >= count {
            return Err(validation("Reading positions must be inside the snapshot."));
        }
        let id: String = self
            .conn
            .query_row(
                "SELECT a.source_id
                 FROM source_snapshots a
                 JOIN sources s ON s.block_id = a.source_id
                 JOIN blocks b ON b.id = s.block_id
                 WHERE a.snapshot_id = ?1 AND s.active = 1 AND b.deletion_id IS NULL
                 ORDER BY a.change_seq, a.rowid
                 LIMIT 1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found(snapshot))?;
        let source = source(&self.conn, &id)?.ok_or_else(|| not_found(&id))?;
        let seq = if source.state == ReadingState::Inbox {
            let mut state = source.source_state();
            state.state = ReadingState::Reading;
            Some(
                self.apply(&Batch {
                    actor: Actor::Client {
                        name: "reader".into(),
                    },
                    reason: None,
                    idempotency_key: None,
                    operations: vec![Operation::SetSource {
                        id: id.clone(),
                        base_revision: self.block(&id)?.revision,
                        source: Some(state),
                    }],
                })?
                .seq,
            )
        } else {
            None
        };
        let now = crate::notebook::now_ms();
        let tx = self.conn.transaction()?;
        let stamp = crate::unlogged::stamp(&tx, now)?;
        tx.execute(
            "INSERT INTO reading_positions (snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(snapshot_id) DO UPDATE
             SET passage_ordinal = excluded.passage_ordinal, updated_at = excluded.updated_at,
                 hlc = excluded.hlc, device = excluded.device, sync_seq = excluded.sync_seq",
            params![snapshot, ordinal, now, stamp.hlc, stamp.device, stamp.seq],
        )?;
        tx.execute(
            "UPDATE sources
             SET last_read_at = ?1
             WHERE block_id = ?2",
            params![now, id],
        )?;
        tx.commit()?;
        Ok(ReadingProgress {
            position: ReadingPosition {
                snapshot_id: snapshot.into(),
                passage_ordinal: ordinal,
                updated_at: now,
            },
            progress: progress(&self.conn, snapshot)?,
            state_changed: seq.is_some(),
            seq,
        })
    }
    pub fn highlights(&self, query: &HighlightQuery) -> Result<HighlightResult> {
        self.highlight_rows(query, None)
    }
    pub(crate) fn highlight_rows(
        &self,
        query: &HighlightQuery,
        ids: Option<&[String]>,
    ) -> Result<HighlightResult> {
        for color in &query.colors {
            if color != "none" {
                crate::library_store::validate_color(Some(color))?;
            }
        }
        let tags: Vec<_> = query
            .tags
            .iter()
            .map(|tag| crate::storage::title_key(tag))
            .collect();
        let citations = citations(&self.conn, ids, None, true, None)?;
        let ids_json = ids.map(json);
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", (SELECT COUNT(*) FROM blocks child
                 WHERE child.parent_id = b.id AND child.deletion_id IS NULL AND child.archived = 0
                 AND TRIM(child.text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') <> ''
             ), EXISTS(
                 SELECT 1 FROM card_units card
                 WHERE card.source_block_id = b.id AND card.active = 1
             ) OR EXISTS(
                 SELECT 1 FROM links l
                 JOIN blocks incoming ON incoming.id = l.source_id
                 WHERE l.target_id = b.id AND incoming.deletion_id IS NULL
             ), (SELECT json_group_array(title) FROM (
                 SELECT title FROM memberships WHERE block_id = b.id AND manual = 0 ORDER BY title_key
             ))
             FROM blocks b
             JOIN blocks p ON p.id = b.page_id
             WHERE b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
             AND EXISTS(SELECT 1 FROM citations c WHERE c.block_id = b.id AND c.active = 1)
             AND NOT EXISTS(
                 SELECT 1 FROM json_each(?1) wanted
                 WHERE NOT EXISTS(
                     SELECT 1 FROM memberships m
                     WHERE m.block_id = b.id AND m.manual = 0 AND m.title_key = wanted.value
                 )
             )
             AND (?2 IS NULL OR b.id IN (SELECT value FROM json_each(?2)))"
        ))?;
        let mut blocks: HashMap<String, (BlockInPage, u32, bool, Vec<String>)> = statement
            .query_map(params![json(&tags), ids_json.as_deref()], |r| {
                let block = block_at(r, 0)?;
                Ok((
                    block.id.clone(),
                    (
                        BlockInPage {
                            block,
                            page: block_at(r, 10)?,
                        },
                        r.get(20)?,
                        r.get(21)?,
                        json_at(r, 22)?,
                    ),
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT id, text
             FROM blocks
             WHERE kind = 'page' AND (?1 IS NULL OR id IN (
                 SELECT a.source_id FROM source_snapshots a JOIN citations c ON c.snapshot_id = a.snapshot_id
                 WHERE c.block_id IN (SELECT value FROM json_each(?1))
             ))",
        )?;
        let titles: HashMap<String, String> = statement
            .query_map([ids_json.as_deref()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT c.id, changes.created_at
             FROM citations c JOIN changes ON changes.seq = c.created_seq
             WHERE c.active = 1 AND (?1 IS NULL OR c.block_id IN (SELECT value FROM json_each(?1)))",
        )?;
        let created: HashMap<String, i64> = statement
            .query_map([ids_json.as_deref()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut rows = vec![];
        // Newest first; the helper returns creation order.
        for citation in citations.into_iter().rev() {
            if query
                .source_id
                .as_ref()
                .is_some_and(|id| *id != citation.source_id)
            {
                continue;
            }
            if !query.colors.is_empty()
                && !query
                    .colors
                    .iter()
                    .any(|color| match citation.color.as_deref() {
                        Some(value) => value == color,
                        None => color == "none",
                    })
            {
                continue;
            }
            let Some((block, notes, derived, tags)) = blocks.get_mut(&citation.block_id) else {
                continue;
            };
            let processed = citation
                .triage
                .as_deref()
                .map(|value| value == "processed")
                .unwrap_or(*notes > 0 || *derived);
            if query.unprocessed && processed {
                continue;
            }
            rows.push(HighlightRow {
                block: block.clone(),
                source_title: titles.get(&citation.source_id).cloned().unwrap_or_default(),
                triage: citation.triage.clone(),
                color: citation.color.clone(),
                tags: tags.clone(),
                created_at: created[&citation.id],
                citation,
                processed,
                notes: *notes,
            });
        }
        let total = rows.len();
        rows.truncate(query.limit.unwrap_or(100));
        Ok(HighlightResult { rows, total })
    }
    /// Live Collections values, including archived owners/entries/values so
    /// deleting a collection cannot leave hidden memberships as broken links.
    pub fn collection_values(&self, id: &str) -> Result<Vec<crate::Block>> {
        crate::storage::validate_id(id)?;
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            block_columns!("v"),
            ", e.text, d.id
             FROM links l JOIN blocks v ON v.id = l.source_id
             JOIN blocks e ON e.id = v.parent_id
             JOIN links el ON el.source_id = e.id AND el.occurrence = 0
             JOIN blocks d ON d.id = el.target_id
             JOIN blocks register ON register.id = d.parent_id
             JOIN fields f ON f.block_id = d.id
             WHERE l.target_id = ?1 AND l.occurrence = 0
             AND v.deletion_id IS NULL AND e.deletion_id IS NULL
             AND d.deletion_id IS NULL AND register.deletion_id IS NULL
             AND register.kind = 'page' AND register.title_key = 'fields'
             AND lower(d.text) = 'collections' AND f.kind = 'instance'
             ORDER BY v.id"
        ))?;
        let rows = statement.query_map([id], |row| {
            Ok((
                block_at(row, 0)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })?;
        let mut values = Vec::new();
        for row in rows {
            let (value, entry, field) = row?;
            if crate::fields::reference(&entry) == Some(field.as_str())
                && crate::fields::reference(&value.text) == Some(id)
            {
                values.push(value);
            }
        }
        Ok(values)
    }

    pub fn library(&self, query: &LibraryQuery) -> Result<LibraryResult> {
        self.library_rows(query, query.limit.unwrap_or(100))
    }
    pub(crate) fn library_rows(&self, query: &LibraryQuery, limit: usize) -> Result<LibraryResult> {
        // Start from links_target, then field_values_value: collection membership
        // narrows the source IDs before loading metadata, snapshots and covers.
        let collection_sources = if let Some(id) = &query.collection_id {
            let mut statement = self.conn.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT fv.owner_id, v.text FROM links l
                 JOIN field_values fv ON fv.value_id = l.source_id
                 JOIN blocks v ON v.id = fv.value_id
                 JOIN blocks d ON d.id = fv.field_id
                 JOIN fields f ON f.block_id = d.id
                 JOIN blocks c ON c.id = l.target_id
                 WHERE l.target_id = ?1 AND l.occurrence = 0
                 AND lower(d.text) = 'collections' AND f.kind = 'instance'
                 AND d.deletion_id IS NULL AND c.deletion_id IS NULL
                 AND v.id NOT IN (SELECT id FROM hidden)
                 AND d.id NOT IN (SELECT id FROM hidden)"
            ))?;
            let candidates = statement.query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut owners = Vec::new();
            for candidate in candidates {
                let (owner, text) = candidate?;
                if crate::fields::reference(&text) == Some(id.as_str()) {
                    owners.push(owner);
                }
            }
            Some(json(&owners))
        } else {
            None
        };
        // State tabs remain notebook-wide, even while viewing one collection.
        let mut counts = if query.collection_id.is_some() {
            self.conn
                .prepare_cached(concat!(
                    hidden_blocks!(),
                    "SELECT COUNT(*) FILTER (WHERE s.state = 'inbox'),
                    COUNT(*) FILTER (WHERE s.state = 'reading'),
                    COUNT(*) FILTER (WHERE s.state = 'finished'),
                    COUNT(*) FILTER (WHERE s.state = 'abandoned')
             FROM sources s JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL
             AND b.id NOT IN (SELECT id FROM hidden)"
                ))?
                .query_row([], |r| {
                    Ok(LibraryCounts {
                        inbox: r.get::<_, i64>(0)? as usize,
                        reading: r.get::<_, i64>(1)? as usize,
                        finished: r.get::<_, i64>(2)? as usize,
                        abandoned: r.get::<_, i64>(3)? as usize,
                    })
                })?
        } else {
            LibraryCounts::default()
        };
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            source_columns!(),
            ", ",
            block_columns!("b"),
            " FROM sources s
             JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
             AND (?1 IS NULL OR b.id IN (SELECT value FROM json_each(?1)))"
        ))?;
        let sources = statement
            .query_map([collection_sources], |r| {
                Ok((source_at(r)?, block_at(r, 10)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let ids: Vec<_> = sources.iter().map(|(s, _)| s.block_id.clone()).collect();
        let mut people_by_source = HashMap::new();
        let mut fields_by_source = crate::library_export::field_readings_with_people(
            &self.conn,
            &ids,
            &mut people_by_source,
        )?;
        let snapshot_ids: Vec<_> = sources
            .iter()
            .filter_map(|(s, _)| s.current_snapshot_id.as_ref())
            .collect();
        let mut statement = self.conn.prepare_cached(
            "SELECT id, format, json_extract(metadata, '$.cover') FROM snapshots
             WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let snapshots: HashMap<String, (String, Option<String>)> = statement
            .query_map([json(&snapshot_ids)], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT s.id, CAST(p.start AS REAL) / s.text_length, rp.passage_ordinal
             FROM snapshots s
             JOIN reading_positions rp ON rp.snapshot_id = s.id
             JOIN passages p ON p.snapshot_id = s.id AND p.ordinal = rp.passage_ordinal
             WHERE s.id IN (SELECT value FROM json_each(?1)) AND s.text_length > 0",
        )?;
        let positions: HashMap<String, (f64, i64)> = statement
            .query_map([json(&snapshot_ids)], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let highlights = self.highlights(&HighlightQuery {
            limit: Some(usize::MAX),
            ..Default::default()
        })?;
        let mut totals: HashMap<String, (usize, usize)> = HashMap::new();
        for h in highlights.rows {
            let n = totals.entry(h.citation.source_id).or_default();
            n.0 += 1;
            n.1 += usize::from(!h.processed);
        }
        let mut rows = vec![];
        let mut linked_people: HashMap<String, PersonFacet> = HashMap::new();
        let mut unlinked_people: HashMap<String, PersonFacet> = HashMap::new();
        let mut decades: HashMap<i32, usize> = HashMap::new();
        let mut years: HashMap<i32, usize> = HashMap::new();
        let mut publishers = HashMap::new();
        let mut languages = HashMap::new();
        let text = query
            .text
            .as_ref()
            .map(|s| s.to_lowercase())
            .filter(|s| !s.is_empty());
        let query_languages: Vec<_> = query
            .languages
            .iter()
            .map(|value| normalize_language_name(value).to_owned())
            .collect();
        for (mut source, page) in sources {
            if query.collection_id.is_none() {
                match source.state {
                    ReadingState::Inbox => counts.inbox += 1,
                    ReadingState::Reading => counts.reading += 1,
                    ReadingState::Finished => counts.finished += 1,
                    ReadingState::Abandoned => counts.abandoned += 1,
                }
            }
            if !query.states.is_empty() && !query.states.contains(&source.state)
                || query.format.is_some_and(|f| f != source.format)
            {
                continue;
            }
            let fields = fields_by_source
                .remove(&source.block_id)
                .unwrap_or_default();
            source_siglum(&mut source, &page.text, &fields);
            let creators = crate::library_export::creators(&fields).to_vec();
            if let Some(text) = &text
                && !page.text.to_lowercase().contains(text.as_str())
                && !creators
                    .iter()
                    .any(|s| s.to_lowercase().contains(text.as_str()))
            {
                continue;
            }
            let people = people_by_source
                .remove(&source.block_id)
                .unwrap_or_default();
            let published = fields.get("published").and_then(|values| values.first());
            let publisher = fields.get("publisher").and_then(|values| values.first());
            let language = fields
                .get("language")
                .and_then(|values| values.first())
                .map(|value| language_code(value));
            let year = publication_year(published.map(String::as_str));
            let decade = publication_decade(published.map(String::as_str));
            for (index, person) in people.iter().enumerate() {
                if people[..index].iter().any(|previous| match &person.id {
                    Some(id) => previous.id.as_ref() == Some(id),
                    None => previous.id.is_none() && previous.name == person.name,
                }) {
                    continue;
                }
                let (counts, key) = match &person.id {
                    Some(id) => (&mut linked_people, id),
                    None => (&mut unlinked_people, &person.name),
                };
                if let Some(facet) = counts.get_mut(key) {
                    facet.count += 1;
                } else {
                    counts.insert(
                        key.clone(),
                        PersonFacet {
                            id: person.id.clone(),
                            name: person.name.clone(),
                            count: 1,
                        },
                    );
                }
            }
            if let Some(decade) = decade {
                *decades.entry(decade).or_default() += 1;
            }
            if let Some(year) = year {
                *years.entry(year).or_default() += 1;
            }
            count_value(&mut publishers, publisher.map(String::as_str));
            count_value(&mut languages, language.as_deref());
            if (!query.people.is_empty()
                && !people.iter().any(|person| {
                    person
                        .id
                        .as_ref()
                        .is_some_and(|id| query.people.contains(id))
                }))
                || (!query.publishers.is_empty()
                    && !publisher.is_some_and(|value| query.publishers.contains(value)))
                || (!query.decades.is_empty()
                    && !decade.is_some_and(|value| query.decades.contains(&value)))
                || (!query.years.is_empty()
                    && !year.is_some_and(|value| query.years.contains(&value)))
                || (!query.languages.is_empty()
                    && !language
                        .as_ref()
                        .is_some_and(|value| query_languages.contains(value)))
            {
                continue;
            }
            let progress = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| positions.get(id))
                .map_or(0.0, |(progress, _)| *progress);
            let (highlights, unprocessed) = totals.remove(&source.block_id).unwrap_or_default();
            let snapshot = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| snapshots.get(id));
            let cover = fields
                .get("cover")
                .and_then(|values| values.first())
                .cloned()
                .or_else(|| snapshot.and_then(|(_, cover)| cover.clone()));
            rows.push(LibraryRow {
                page,
                source,
                creators,
                people,
                publisher: publisher.cloned(),
                language,
                published: published.cloned(),
                site: fields.get("site").and_then(|v| v.first()).cloned(),
                cover,
                snapshot_format: snapshot.map(|(format, _)| format.clone()),
                progress,
                section: None,
                highlights,
                unprocessed,
            });
        }
        let mut people: Vec<_> = linked_people
            .into_values()
            .chain(unlinked_people.into_values())
            .collect();
        people.sort_by_cached_key(|facet| {
            (
                std::cmp::Reverse(facet.count),
                crate::library_ingest::family_name(&facet.name).to_lowercase(),
                facet.name.clone(),
                facet.id.clone(),
            )
        });
        let mut decades: Vec<_> = decades
            .into_iter()
            .map(|(decade, count)| DecadeFacet { decade, count })
            .collect();
        decades.sort_unstable_by_key(|facet| std::cmp::Reverse(facet.decade));
        let mut years: Vec<_> = years
            .into_iter()
            .map(|(year, count)| YearFacet { year, count })
            .collect();
        years.sort_unstable_by_key(|facet| std::cmp::Reverse(facet.year));
        let facets = LibraryFacets {
            people,
            decades,
            years,
            publishers: value_facets(publishers),
            languages: value_facets(languages),
        };
        if query.sort == LibrarySort::Title {
            rows.sort_by_cached_key(|row| {
                (crate::aliases::fold(&row.page.text), row.page.id.clone())
            });
            if query.direction == Direction::Desc {
                rows.reverse();
            }
        } else {
            rows.sort_by(|a, b| {
                let cmp = match query.sort {
                    LibrarySort::Added => a.source.added_at.cmp(&b.source.added_at),
                    LibrarySort::Title => unreachable!("title sort keys are cached"),
                    LibrarySort::Author => a
                        .creators
                        .first()
                        .map(|s| crate::library_ingest::family_name(s))
                        .into_iter()
                        .flat_map(str::chars)
                        .flat_map(char::to_lowercase)
                        .cmp(
                            b.creators
                                .first()
                                .map(|s| crate::library_ingest::family_name(s))
                                .into_iter()
                                .flat_map(str::chars)
                                .flat_map(char::to_lowercase),
                        ),
                    LibrarySort::Year => a
                        .published
                        .as_deref()
                        .and_then(|s| s.get(..4))
                        .cmp(&b.published.as_deref().and_then(|s| s.get(..4))),
                    LibrarySort::LastRead => a.source.last_read_at.cmp(&b.source.last_read_at),
                    LibrarySort::Progress => a.progress.total_cmp(&b.progress),
                }
                .then_with(|| a.page.id.cmp(&b.page.id));
                if query.direction == Direction::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            });
        }
        let total = rows.len();
        rows.truncate(limit);
        // The innermost contents entry at or before the reading position.
        for row in &mut rows {
            if let Some((snapshot, (_, ordinal))) = row
                .source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| positions.get(id).map(|position| (id, position)))
            {
                row.section = toc(&self.conn, snapshot)?
                    .into_iter()
                    .filter(|entry| entry.ordinal.is_some_and(|start| start <= *ordinal))
                    .max_by_key(|entry| entry.ordinal)
                    .map(|entry| entry.title);
            }
        }
        Ok(LibraryResult {
            rows,
            total,
            counts,
            facets,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_facets_skip_blank_readings_without_changing_exact_values() {
        let mut counts = HashMap::new();
        for value in [None, Some(""), Some(" \t\n"), Some("\u{2003}")] {
            count_value(&mut counts, value);
        }
        assert!(counts.is_empty());
        for value in ["Publisher", "Publisher", " Publisher "] {
            count_value(&mut counts, Some(value));
        }
        let facets = value_facets(counts);
        assert_eq!(facets.len(), 2);
        assert_eq!(facets[0].value, "Publisher");
        assert_eq!(facets[0].count, 2);
        assert_eq!(facets[1].value, " Publisher ");
        assert_eq!(facets[1].count, 1);
    }
}
