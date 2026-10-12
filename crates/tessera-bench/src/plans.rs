use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde_json::{Value, json};

use crate::corpus::{Corpus, references};

// These are the actual core projections and query shapes, including both page
// reads and both completion paths. Keep them aligned with core reads.rs.
const COLUMNS: &str = "b.id, b.kind, b.parent_id, b.page_id, b.text, b.heading, b.archived, b.revision, b.created_at, b.updated_at";
const HIDDEN: &str = "WITH RECURSIVE hidden(rowid, id) AS MATERIALIZED (
    SELECT rowid, id FROM blocks WHERE archived = 1 AND deletion_id IS NULL
    UNION
    SELECT b.rowid, b.id FROM blocks b JOIN hidden h ON b.parent_id = h.id
    WHERE b.deletion_id IS NULL
)";

pub fn save(dir: &Path, results: &Path, size: usize, corpus: &Corpus, stamp: u128) -> Result<()> {
    let connection = Connection::open_with_flags(
        dir.join(tessera_core::DATABASE_FILE),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut plans = Vec::new();
    for (&rows, id) in &corpus.pages {
        capture(
            &connection,
            &mut plans,
            &format!("page_{rows}"),
            format!(
                "SELECT {COLUMNS} FROM blocks b WHERE b.page_id = ?1 AND b.deletion_id IS NULL ORDER BY b.parent_id, b.ordinal, b.id"
            ),
            vec![json!(id)],
        )?;
        capture(
            &connection,
            &mut plans,
            &format!("page_targets_{rows}"),
            format!(
                "WITH targets(id) AS (SELECT l.target_id FROM blocks s JOIN links l ON l.source_id = s.id JOIN blocks t ON t.id = l.target_id WHERE s.page_id = ?1 AND s.deletion_id IS NULL AND t.page_id != ?1 UNION SELECT m.type_id FROM blocks s JOIN memberships m ON m.block_id = s.id WHERE s.page_id = ?1 AND s.deletion_id IS NULL) SELECT {COLUMNS} FROM targets t JOIN blocks b ON b.id = t.id WHERE b.deletion_id IS NULL ORDER BY b.id"
            ),
            vec![json!(id)],
        )?;
    }
    for (query, end) in [
        ("page", "pagf"),
        ("cobalt", "cobalu"),
        ("needle000001", "needle000002"),
        ("absentword", "absentwore"),
    ] {
        capture(
            &connection,
            &mut plans,
            &format!("completion_title:{query}"),
            format!(
                "SELECT {COLUMNS} FROM blocks b WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.archived = 0 AND b.title_key >= ?1 AND b.title_key < ?3 ORDER BY b.title_key, b.id LIMIT ?2"
            ),
            vec![json!(query), json!(30), json!(end)],
        )?;
        let matched = format!("\"{query}\"*");
        let candidates = format!(
            "{HIDDEN}, hits AS MATERIALIZED (SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts JOIN search_blocks s ON s.rowid = blocks_fts.rowid WHERE blocks_fts MATCH ?1 AND blocks_fts.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY score, s.block_id LIMIT ?2)"
        );
        capture(
            &connection,
            &mut plans,
            &format!("completion_fts:{query}"),
            format!(
                "{candidates} SELECT {COLUMNS} FROM hits h JOIN blocks b ON b.id = h.id ORDER BY h.score, b.id"
            ),
            vec![json!(matched), json!(30)],
        )?;
        capture(
            &connection,
            &mut plans,
            &format!("search:{query}"),
            format!(
                "{candidates} SELECT {COLUMNS}, {} FROM hits h JOIN blocks b ON b.id = h.id JOIN blocks p ON p.id = b.page_id WHERE p.deletion_id IS NULL ORDER BY h.score, b.id",
                COLUMNS.replace("b.", "p.")
            ),
            vec![json!(matched), json!(30)],
        )?;
    }
    capture(
        &connection,
        &mut plans,
        "page_by_title",
        format!(
            "SELECT {COLUMNS} FROM blocks b WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.title_key = ?1"
        ),
        vec![json!("page 00000")],
    )?;
    let type_id = corpus
        .model
        .blocks
        .values()
        .find(|block| block.text == "Page 00000")
        .unwrap()
        .id
        .clone();
    capture(
        &connection,
        &mut plans,
        "members",
        format!(
            "{HIDDEN} SELECT {COLUMNS}, {} FROM memberships m JOIN blocks b ON b.id = m.block_id JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id WHERE m.type_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND t.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY m.block_id LIMIT ?2",
            COLUMNS.replace("b.", "p.")
        ),
        vec![json!(type_id), json!(100)],
    )?;
    let target = corpus
        .model
        .blocks
        .values()
        .find_map(|block| {
            references(&block.text)
                .into_iter()
                .find(|target| corpus.model.blocks.contains_key(target))
        })
        .expect("corpus contains a referenced target");
    capture(
        &connection,
        &mut plans,
        "backlinks",
        format!(
            "{HIDDEN} SELECT DISTINCT {COLUMNS}, {} FROM links l JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id WHERE l.target_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden) AND EXISTS (SELECT 1 FROM blocks t WHERE t.id = ?1 AND t.deletion_id IS NULL AND t.rowid NOT IN (SELECT rowid FROM hidden)) ORDER BY b.id LIMIT ?2",
            COLUMNS.replace("b.", "p.")
        ),
        vec![json!(target), json!(100)],
    )?;
    let page = &corpus.model.blocks[&target].page;
    // Keep these CTEs aligned with core references.rs.
    let links = format!(
        "{HIDDEN}, page_links AS MATERIALIZED (
            SELECT b.id AS source_id, b.page_id, t.id AS target_id, MIN(l.occurrence) AS occurrence
            FROM blocks t JOIN links l ON l.target_id = t.id
            JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id
            WHERE t.page_id = ?1 AND t.deletion_id IS NULL
              AND b.deletion_id IS NULL AND p.deletion_id IS NULL
              AND t.rowid NOT IN (SELECT rowid FROM hidden)
              AND b.rowid NOT IN (SELECT rowid FROM hidden)
            GROUP BY b.id, t.id)"
    );
    capture(
        &connection,
        &mut plans,
        "page_references",
        format!(
            "{links}, sources AS MATERIALIZED (
                SELECT source_id, page_id FROM page_links WHERE page_id != ?1 GROUP BY source_id
            ), newest AS (
                SELECT page_id, MAX(source_id) AS newest FROM sources GROUP BY page_id
            ), ancestry(source_id, parent_id, path) AS (
                SELECT s.source_id, b.parent_id,
                       (CASE WHEN b.ordinal < 0 THEN '0' ELSE '1' END) ||
                       printf('%016llx', b.ordinal & 9223372036854775807) || b.id || '/'
                FROM sources s JOIN blocks b ON b.id = s.source_id
                UNION ALL
                SELECT a.source_id, b.parent_id,
                       (CASE WHEN b.ordinal < 0 THEN '0' ELSE '1' END) ||
                       printf('%016llx', b.ordinal & 9223372036854775807) || b.id || '/' || a.path
                FROM ancestry a JOIN blocks b ON b.id = a.parent_id
            ), selected AS MATERIALIZED (
                SELECT s.source_id, s.page_id, n.newest, a.path
                FROM sources s JOIN newest n ON n.page_id = s.page_id
                JOIN ancestry a ON a.source_id = s.source_id AND a.parent_id IS NULL
                ORDER BY n.newest DESC, a.path LIMIT ?2
            ) SELECT root.kind, root.parent_id, (SELECT COUNT(*) FROM sources), {COLUMNS}, {}, l.target_id
              FROM blocks root LEFT JOIN selected s ON 1
              LEFT JOIN blocks b ON b.id = s.source_id LEFT JOIN blocks p ON p.id = s.page_id
              LEFT JOIN page_links l ON l.source_id = s.source_id
              WHERE root.id = ?1 AND root.deletion_id IS NULL
              ORDER BY s.newest DESC, s.path, l.occurrence",
            COLUMNS.replace("b.", "p.")
        ),
        vec![json!(page), json!(100)],
    )?;
    capture(
        &connection,
        &mut plans,
        "reference_counts",
        format!(
            "{links}, counts AS (
                SELECT target_id, COUNT(*) AS count FROM page_links
                WHERE source_id != target_id GROUP BY target_id
            ) SELECT root.kind, root.parent_id, c.target_id, c.count
              FROM blocks root LEFT JOIN counts c ON 1
              WHERE root.id = ?1 AND root.deletion_id IS NULL ORDER BY c.target_id"
        ),
        vec![json!(page)],
    )?;
    std::fs::write(
        results.join(format!("plans-{size}-{stamp}.json")),
        serde_json::to_vec_pretty(
            &json!({ "size": size, "logical_hash": corpus.logical_hash, "sqlite_version": rusqlite::version(), "plans": plans }),
        )?,
    )?;
    Ok(())
}

fn capture(
    connection: &Connection,
    plans: &mut Vec<Value>,
    operation: &str,
    sql: String,
    parameters: Vec<Value>,
) -> Result<()> {
    let bindings = parameters
        .iter()
        .map(|value| match value {
            Value::String(text) => rusqlite::types::Value::Text(text.clone()),
            Value::Number(number) => rusqlite::types::Value::Integer(number.as_i64().unwrap()),
            _ => unreachable!("query plan parameters are text or integers"),
        })
        .collect::<Vec<_>>();
    let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let steps = statement.query_map(params_from_iter(bindings), |row| Ok(json!({ "id": row.get::<_, i64>(0)?, "parent": row.get::<_, i64>(1)?, "detail": row.get::<_, String>(3)? })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    plans.push(
        json!({ "operation": operation, "sql": sql, "parameters": parameters, "steps": steps }),
    );
    Ok(())
}
