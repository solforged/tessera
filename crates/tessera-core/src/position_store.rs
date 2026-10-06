use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    BlockCapabilities, BlockInPage, Notebook, PositionInfo, PositionQuery, PositionRow, Result,
};

pub(crate) fn validate_source(conn: &Connection, id: &str) -> Result<()> {
    validate_id(id)?;
    let kind: Option<String> = conn
        .prepare_cached("SELECT kind FROM blocks WHERE id = ?1 AND deletion_id IS NULL")?
        .query_row([id], |row| row.get(0))
        .optional()?;
    match kind.as_deref() {
        Some("block") => Ok(()),
        Some(_) => Err(validation("Only ordinary blocks can be perspectives")),
        None => Err(validation("Perspective block does not exist")),
    }
}

pub(crate) fn set(conn: &Connection, id: &str, active: bool) -> Result<bool> {
    if !active {
        return Ok(conn
            .prepare_cached("UPDATE positions SET active = 0 WHERE block_id = ?1 AND active = 1")?
            .execute([id])?
            != 0);
    }
    Ok(conn
        .prepare_cached(
            "INSERT INTO positions(block_id, active) VALUES (?1, 1)
         ON CONFLICT(block_id) DO UPDATE SET active = 1 WHERE positions.active = 0",
        )?
        .execute([id])?
        != 0)
}

/// Integration seam: the question capability lane supplies ancestor lookup.
pub(crate) fn nearest_question_ancestor(
    _conn: &Connection,
    _block_id: &str,
) -> Result<Option<String>> {
    Ok(None)
}

/// Resolve both links together, without skipping an invalid first or second link.
/// An optional ID set keeps page loads and receipts set-based.
fn derive(conn: &Connection, ids: Option<&[String]>) -> Result<HashMap<String, PositionInfo>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        ", candidates AS (
            SELECT b.id, b.page_id,
                (SELECT target_id FROM links WHERE source_id = b.id ORDER BY occurrence LIMIT 1) AS first_id,
                (SELECT target_id FROM links WHERE source_id = b.id ORDER BY occurrence LIMIT 1 OFFSET 1) AS second_id
            FROM positions pos JOIN blocks b ON b.id = pos.block_id
            WHERE pos.active = 1 AND (?1 IS NULL OR b.id IN (SELECT value FROM json_each(?1)))
        )
        SELECT c.id, c.page_id, h.id,
            CASE WHEN h.id IS NOT NULL AND s.id != h.id THEN s.id END
        FROM candidates c
        LEFT JOIN blocks h ON h.id = c.first_id AND h.kind = 'page'
            AND h.parent_id IS NULL AND h.deletion_id IS NULL
            AND h.rowid NOT IN (SELECT rowid FROM hidden)
        LEFT JOIN blocks s ON s.id = c.second_id AND s.kind IN ('block', 'page')
            AND s.deletion_id IS NULL AND s.rowid NOT IN (SELECT rowid FROM hidden)"
    ))?;
    let rows = statement.query_map(
        [ids.map(|ids| serde_json::to_string(ids).expect("block IDs serialize"))],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    )?;
    let mut result = HashMap::new();
    for row in rows {
        let (id, page, holder_id, subject) = row?;
        let subject_id = match subject {
            Some(subject) => subject,
            None => nearest_question_ancestor(conn, &id)?.unwrap_or(page),
        };
        result.insert(
            id,
            PositionInfo {
                holder_id,
                subject_id,
            },
        );
    }
    Ok(result)
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut values: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    let ids: Vec<_> = values.iter().map(|value| value.block_id.clone()).collect();
    let mut positions = derive(conn, Some(&ids))?;
    for value in &mut values {
        value.position = positions.remove(&value.block_id);
        value.merge_protected |= value.position.is_some();
    }
    Ok(values)
}

impl Notebook {
    pub fn positions(&self, query: &PositionQuery) -> Result<Vec<PositionRow>> {
        if query.holder.is_none() && query.subject.is_none() {
            return Err(validation("A holder or subject is required"));
        }
        for id in [&query.holder, &query.subject].into_iter().flatten() {
            validate_id(id)?;
        }
        let mut positions = derive(&self.conn, None)?;
        positions.retain(|_, info| {
            query
                .holder
                .as_ref()
                .is_none_or(|holder| info.holder_id.as_ref() == Some(holder))
                && query
                    .subject
                    .as_ref()
                    .is_none_or(|subject| &info.subject_id == subject)
        });
        let ids: Vec<_> = positions.keys().collect();
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            ", siblings AS (
                SELECT id, parent_id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY ordinal, id) AS rank
                FROM blocks WHERE deletion_id IS NULL
            ), outline(id, path) AS (
                SELECT id, '' FROM siblings WHERE parent_id IS NULL
                UNION ALL
                SELECT s.id, o.path || '/' || printf('%020d', s.rank)
                FROM siblings s JOIN outline o ON s.parent_id = o.id
            ) SELECT ",
            block_columns!("b"), ", ", block_columns!("p"),
            " FROM blocks b JOIN blocks p ON p.id = b.page_id
            JOIN outline o ON o.id = b.id
            WHERE b.id IN (SELECT value FROM json_each(?1))
                AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                AND b.rowid NOT IN (SELECT rowid FROM hidden)
            ORDER BY p.id, o.path LIMIT ?2"
        ))?;
        let rows = statement.query_map(
            params![
                serde_json::to_string(&ids).expect("block IDs serialize"),
                query.limit.map(i64::from).unwrap_or(-1)
            ],
            |row| {
                Ok(BlockInPage {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            },
        )?;
        let mut result = Vec::new();
        for row in rows {
            let block = row?;
            let info = positions
                .remove(&block.block.id)
                .expect("selected position exists");
            result.push(PositionRow {
                block,
                holder_id: info.holder_id,
                subject_id: info.subject_id,
            });
        }
        Ok(result)
    }
}
