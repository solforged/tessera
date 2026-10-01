use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde_json::{Value, json};

use crate::corpus::Corpus;

// These are the actual core projections and query shapes, including both page
// reads and both completion paths. Keep them aligned with core reads.rs.
const COLUMNS: &str = "b.id, b.kind, b.parent_id, b.page_id, b.text, b.heading, b.archived, b.revision, b.created_at, b.updated_at";

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
                "SELECT DISTINCT {COLUMNS} FROM blocks s JOIN links l ON l.source_id = s.id JOIN blocks b ON b.id = l.target_id WHERE s.page_id = ?1 AND s.deletion_id IS NULL AND b.deletion_id IS NULL AND b.page_id != ?1 ORDER BY b.id"
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
                "SELECT {COLUMNS} FROM blocks b WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.title_key >= ?1 AND b.title_key < ?3 ORDER BY b.title_key, b.id LIMIT ?2"
            ),
            vec![json!(query), json!(30), json!(end)],
        )?;
        let matched = format!("\"{query}\"*");
        let candidates = "WITH hits AS MATERIALIZED (SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts JOIN search_blocks s ON s.rowid = blocks_fts.rowid WHERE blocks_fts MATCH ?1 ORDER BY score, s.block_id LIMIT ?2)";
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
