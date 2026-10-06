use crate::library::*;
use crate::library_store::{enum_at, json, json_at, source, source_at, source_columns};
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
    let mut statement = conn.prepare_cached(
        "SELECT json_extract(e.value, '$.title'), json_extract(e.value, '$.locator'),
                json_extract(e.value, '$.level'), MIN(p.ordinal)
         FROM snapshots s, json_each(s.toc) e
         LEFT JOIN passages p ON p.snapshot_id = s.id
             AND (p.id = json_extract(e.value, '$.locator')
                 OR p.locator = json_extract(e.value, '$.locator')
                 OR p.anchor = json_extract(e.value, '$.locator'))
         WHERE s.id = ?1
         GROUP BY e.key
         ORDER BY CAST(e.key AS INTEGER)",
    )?;
    Ok(statement
        .query_map([snapshot], |r| {
            Ok(TocEntry {
                title: r.get(0)?,
                locator: r.get(1)?,
                level: r.get(2)?,
                ordinal: r.get(3)?,
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
                first.locator, p.ordinal, p.text, first.ordinal, last.ordinal, c.triage, c.color
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
        " FROM sources s
         JOIN blocks b ON b.id = s.block_id
         WHERE s.active = 1 AND b.deletion_id IS NULL
         AND s.block_id IN (SELECT value FROM json_each(?1))"
    ))?;
    let mut sources: HashMap<_, _> = statement
        .query_map([json(&ids)], source_at)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|s| (s.block_id.clone(), s))
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
            "SELECT snapshot_id, passage_ordinal, covered, updated_at
             FROM reading_positions
             WHERE snapshot_id = ?1",
            [snapshot],
            |r| {
                Ok(ReadingPosition {
                    snapshot_id: r.get(0)?,
                    passage_ordinal: r.get(1)?,
                    covered: json_at(r, 2)?,
                    updated_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}
pub(crate) fn progress(conn: &Connection, snapshot: &str) -> Result<f64> {
    let total: i64 = conn.query_row(
        "SELECT text_length
         FROM snapshots
         WHERE id = ?1",
        [snapshot],
        |r| r.get(0),
    )?;
    if total == 0 {
        return Ok(0.0);
    }
    let Some(pos) = position(conn, snapshot)? else {
        return Ok(0.0);
    };
    let covered: i64 = conn.query_row(
        "SELECT COALESCE(SUM(COALESCE((
             SELECT next.start
             FROM passages next
             WHERE next.snapshot_id = p.snapshot_id AND next.ordinal = p.ordinal + 1
         ), ?3) - p.start), 0)
         FROM passages p
         WHERE p.snapshot_id = ?1
         AND EXISTS(
             SELECT 1 FROM json_each(?2) r
             WHERE p.ordinal >= json_extract(r.value, '$[0]')
             AND p.ordinal < json_extract(r.value, '$[1]')
         )",
        params![snapshot, json(&pos.covered), total],
        |r| r.get(0),
    )?;
    Ok((covered as f64 / total as f64).clamp(0.0, 1.0))
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
    ) -> Result<Vec<PassageHit>> {
        let query = fts_query(q);
        if query.is_empty() {
            return Ok(vec![]);
        }
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT s.block_id, b.text, p.snapshot_id, ",
            passage_columns!(),
            ", snippet(passages_fts, 0, '[', ']', ' … ', 24)
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
             ORDER BY rank, p.ordinal, s.block_id
             LIMIT ?3"
        ))?;
        Ok(statement
            .query_map(params![query, source_id, limit.min(500) as i64], |r| {
                Ok(PassageHit {
                    source_id: r.get(0)?,
                    title: r.get(1)?,
                    snapshot_id: r.get(2)?,
                    passage: passage_at(r, 3)?,
                    snippet: r.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn set_reading_position(
        &mut self,
        snapshot: &str,
        ordinal: i64,
        seen: (i64, i64),
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
        if ordinal < 0 || ordinal >= count || seen.0 < 0 || seen.0 > seen.1 || seen.1 > count {
            return Err(validation(
                "Reading positions and coverage must be inside the snapshot.",
            ));
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
        let mut covered = position(&self.conn, snapshot)?
            .map(|p| p.covered)
            .unwrap_or_default();
        if seen.0 < seen.1 {
            covered.push(seen);
        }
        covered.sort_unstable();
        let mut merged: Vec<(i64, i64)> = vec![];
        for range in covered {
            if let Some(last) = merged.last_mut().filter(|last| last.1 >= range.0) {
                last.1 = last.1.max(range.1);
            } else {
                merged.push(range);
            }
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO reading_positions
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(snapshot_id) DO UPDATE
             SET passage_ordinal = excluded.passage_ordinal,
                 covered = excluded.covered, updated_at = excluded.updated_at",
            params![snapshot, ordinal, json(&merged), now],
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
                covered: merged,
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
            crate::library_store::validate_color(Some(color))?;
        }
        let tags: Vec<_> = query.tags.iter().map(|tag| tag.to_lowercase()).collect();
        let citations = citations(&self.conn, ids, None, true, None)?;
        let ids_json = ids.map(json);
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", EXISTS(
                 SELECT 1 FROM blocks child
                 WHERE child.parent_id = b.id AND child.deletion_id IS NULL AND TRIM(child.text) <> ''
             ) OR EXISTS(
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
        let mut blocks: HashMap<String, (BlockInPage, bool, Vec<String>)> = statement
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
                        json_at(r, 21)?,
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
                && !citation
                    .color
                    .as_ref()
                    .is_some_and(|color| query.colors.contains(color))
            {
                continue;
            }
            let Some((block, derived, tags)) = blocks.get_mut(&citation.block_id) else {
                continue;
            };
            let processed = citation
                .triage
                .as_deref()
                .map(|value| value == "processed")
                .unwrap_or(*derived);
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
            });
        }
        let total = rows.len();
        rows.truncate(query.limit.unwrap_or(100));
        Ok(HighlightResult { rows, total })
    }
    pub fn library(&self, query: &LibraryQuery) -> Result<LibraryResult> {
        self.library_rows(query, query.limit.unwrap_or(100))
    }
    pub(crate) fn library_rows(&self, query: &LibraryQuery, limit: usize) -> Result<LibraryResult> {
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            source_columns!(),
            ", ",
            block_columns!("b"),
            " FROM sources s
             JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)"
        ))?;
        let sources = statement
            .query_map([], |r| Ok((source_at(r)?, block_at(r, 10)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let ids: Vec<_> = sources.iter().map(|(s, _)| s.block_id.clone()).collect();
        let mut fields_by_source = crate::library_export::field_readings(self, &ids)?;
        let snapshot_ids: Vec<_> = sources
            .iter()
            .filter_map(|(s, _)| s.current_snapshot_id.as_ref())
            .collect();
        let mut statement = self.conn.prepare_cached(
            "SELECT id, json_extract(metadata, '$.cover') FROM snapshots
             WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let covers: HashMap<String, Option<String>> = statement
            .query_map([json(&snapshot_ids)], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT s.id,
                    CAST(SUM(COALESCE(next.start, s.text_length) - p.start) AS REAL) / s.text_length
             FROM snapshots s
             JOIN reading_positions rp ON rp.snapshot_id = s.id
             JOIN passages p ON p.snapshot_id = s.id
             LEFT JOIN passages next ON next.snapshot_id = s.id AND next.ordinal = p.ordinal + 1
             WHERE s.id IN (SELECT value FROM json_each(?1)) AND s.text_length > 0
             AND EXISTS(
                 SELECT 1 FROM json_each(rp.covered) r
                 WHERE p.ordinal >= json_extract(r.value, '$[0]')
                 AND p.ordinal < json_extract(r.value, '$[1]')
             )
             GROUP BY s.id",
        )?;
        let progresses: HashMap<String, f64> = statement
            .query_map([json(&snapshot_ids)], |r| Ok((r.get(0)?, r.get(1)?)))?
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
        let mut counts = LibraryCounts::default();
        let text = query
            .text
            .as_ref()
            .map(|s| s.to_lowercase())
            .filter(|s| !s.is_empty());
        for (source, page) in sources {
            match source.state {
                ReadingState::Inbox => counts.inbox += 1,
                ReadingState::Reading => counts.reading += 1,
                ReadingState::Finished => counts.finished += 1,
                ReadingState::Abandoned => counts.abandoned += 1,
            }
            if !query.states.is_empty() && !query.states.contains(&source.state)
                || query.format.is_some_and(|f| f != source.format)
            {
                continue;
            }
            let fields = fields_by_source
                .remove(&source.block_id)
                .unwrap_or_default();
            let creators = fields.get("author").cloned().unwrap_or_default();
            if let Some(text) = &text
                && !page.text.to_lowercase().contains(text.as_str())
                && !creators
                    .iter()
                    .any(|s| s.to_lowercase().contains(text.as_str()))
            {
                continue;
            }
            let progress = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| progresses.get(id))
                .copied()
                .unwrap_or(0.0);
            let (highlights, unprocessed) = totals.remove(&source.block_id).unwrap_or_default();
            let cover = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| covers.get(id))
                .cloned()
                .flatten();
            rows.push(LibraryRow {
                page,
                source,
                creators,
                published: fields.get("published").and_then(|v| v.first()).cloned(),
                site: fields.get("site").and_then(|v| v.first()).cloned(),
                cover,
                progress,
                highlights,
                unprocessed,
            });
        }
        rows.sort_by(|a, b| {
            let cmp = match query.sort {
                LibrarySort::Added => a.source.added_at.cmp(&b.source.added_at),
                LibrarySort::Title => a.page.text.to_lowercase().cmp(&b.page.text.to_lowercase()),
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
        let total = rows.len();
        rows.truncate(limit);
        Ok(LibraryResult {
            rows,
            total,
            counts,
        })
    }
}
