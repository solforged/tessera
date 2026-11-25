use crate::library::*;
use crate::library_store::{
    enum_at, json, json_at, source, source_at, source_columns, source_siglum,
};
use crate::reads::{fts_query, hidden_blocks};
use crate::storage::{block_at, block_columns, not_found_as, validation};
use crate::{Actor, Batch, BlockCapabilities, BlockInPage, Direction, Operation, Result, Workshop};
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
        .ok_or_else(|| not_found_as("passage", id))
}

/// The snapshot's navigation as stored, or rebuilt in memory for an old EPUB
/// import that saved only the NCX's lone "Start" entry. The embedded HTML
/// contents survived as linked passage text. Only derived navigation is
/// rebuilt, so snapshot, passage and citation identities are kept, and a read
/// writes nothing, as reads on a `query_only` connection must not.
pub(crate) fn effective_toc(conn: &Connection, snapshot: &str) -> Result<String> {
    let (stored, sparse): (String, bool) = conn.query_row(
        "SELECT toc, format = 'epub' AND json_array_length(toc) < 3 FROM snapshots WHERE id = ?1",
        [snapshot],
        |r| Ok((r.get(0)?, r.get(1)?)),
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
                return Ok(json(&entries));
            }
        }
    }
    Ok(stored)
}

fn toc(conn: &Connection, snapshot: &str) -> Result<Vec<TocEntry>> {
    let entries = effective_toc(conn, snapshot)?;
    // Each entry finds its passage by locator or ID through their indexes, and
    // by element anchor in one pass over the passages that have one. An OR
    // across the three columns scanned every passage once per entry.
    let mut statement = conn.prepare_cached(
        "WITH e AS MATERIALIZED (
             SELECT CAST(e.key AS INTEGER) AS k, json_extract(e.value, '$.title') AS title,
                    json_extract(e.value, '$.locator') AS locator,
                    json_extract(e.value, '$.level') AS level
             FROM json_each(?2) e
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
        .query_map(params![snapshot, entries], |r| {
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

mod reader;
mod shelf;

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
