use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, quote_target, validate_id, validation};
use crate::{Block, Error, Notebook, QuoteState, QuoteStatus, QuotedRow, Result, Row, Subtree};

const MAX_ROWS: usize = 200;
const MAX_TEXT_BYTES: usize = 64 * 1024;

fn validate(block: &Block, quote: &QuoteState) -> Result<()> {
    validate_id(&quote.target_id)?;
    if block.id == quote.target_id {
        return Err(validation("a block cannot quote itself"));
    }
    if quote_target(&block.text) != Some(quote.target_id.as_str()) {
        return Err(validation("quote target must match the block text"));
    }
    let Some(root) = quote.rows.first() else {
        return Err(validation("quote must contain its root row"));
    };
    if root.id != quote.target_id || root.depth != 0 {
        return Err(validation("quote root must match its target at depth zero"));
    }
    if quote.rows.len() > MAX_ROWS {
        return Err(validation("quote exceeds 200 rows"));
    }
    let mut ids = HashSet::with_capacity(quote.rows.len());
    let mut bytes = 0;
    let mut previous_depth = 0;
    for (index, row) in quote.rows.iter().enumerate() {
        validate_id(&row.id)?;
        if !ids.insert(&row.id) {
            return Err(validation("quote row IDs must be unique"));
        }
        if index > 0 && (row.depth == 0 || row.depth > previous_depth + 1) {
            return Err(validation("invalid quote depth sequence"));
        }
        if row
            .heading
            .is_some_and(|heading| !(1..=3).contains(&heading))
            || row.revision < 1
        {
            return Err(validation("invalid quote heading or revision"));
        }
        bytes += row.text.len();
        if bytes > MAX_TEXT_BYTES {
            return Err(validation("quote exceeds 64 KiB of text"));
        }
        previous_depth = row.depth;
    }
    Ok(())
}

pub(crate) fn set(conn: &Connection, block: &Block, quote: Option<&QuoteState>) -> Result<bool> {
    let Some(quote) = quote else {
        return Ok(conn
            .prepare_cached("DELETE FROM quotes WHERE block_id = ?1")?
            .execute([&block.id])?
            != 0);
    };
    crate::image_store::guard_quote(conn, &block.id)?;
    validate(block, quote)?;
    let state = serde_json::to_string(quote).expect("quote state serializes");
    Ok(conn
        .prepare_cached(
            "INSERT INTO quotes(block_id, target_id, state) VALUES (?1, ?2, ?3)
             ON CONFLICT(block_id) DO UPDATE SET target_id = excluded.target_id, state = excluded.state
             WHERE quotes.state != excluded.state",
        )?
        .execute(params![block.id, quote.target_id, state])?
        != 0)
}

/// Keep the snapshot's root identity consistent without changing its frozen text.
/// Inert and deleted quote rows also follow page redirection.
pub(crate) fn redirect(conn: &Connection, from: &str, into: &str) -> Result<Vec<String>> {
    let live = conn
        .prepare_cached(
            "SELECT q.block_id FROM quotes q JOIN blocks b ON b.id = q.block_id
             WHERE q.target_id = ?1 AND b.deletion_id IS NULL ORDER BY q.block_id",
        )?
        .query_map([from], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    conn.prepare_cached(
        "UPDATE quotes SET target_id = ?2,
         state = json_set(state, '$.target_id', ?2, '$.rows[0].id', ?2) WHERE target_id = ?1",
    )?
    .execute(params![from, into])?;
    Ok(live)
}

impl Notebook {
    /// A visible block and its visible descendants in preorder, root depth 0.
    pub fn subtree(&self, id: &str, limit: usize) -> Result<Subtree> {
        validate_id(id)?;
        // Queue the recursive walk by its sibling-order path, so LIMIT bounds
        // traversal as well as the returned rows. The sign prefix preserves
        // the full signed ordinal ordering, including negative ordinals.
        let mut rows = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            ", tree(id, depth, path) AS (
                 SELECT b.id, 0, '' FROM blocks b WHERE b.id = ?1
                   AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
                 UNION ALL
                 SELECT b.id, t.depth + 1,
                     t.path || printf('%s%016llx:%s/', CASE WHEN b.ordinal < 0 THEN '0' ELSE '1' END,
                                      b.ordinal & 9223372036854775807, b.id)
                 FROM tree t JOIN blocks b ON b.parent_id = t.id
                 WHERE b.deletion_id IS NULL AND b.archived = 0
                 ORDER BY 3 LIMIT ?2
             ) SELECT ", block_columns!("b"), ", t.depth
             FROM tree t JOIN blocks b ON b.id = t.id ORDER BY t.path"
        ))?.query_map(params![id, i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX)], |row| {
            Ok(Row { block: block_at(row, 0)?, depth: row.get(10)?, manual_types: Vec::new() })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Err(not_found(id));
        }
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        let mut memberships: HashMap<_, _> = rows
            .iter_mut()
            .map(|row| (row.block.id.as_str(), &mut row.manual_types))
            .collect();
        let ids =
            serde_json::to_string(&memberships.keys().collect::<Vec<_>>()).expect("IDs serialize");
        let mut statement = self.conn.prepare_cached(
            "SELECT m.block_id, m.title FROM json_each(?1) ids
             JOIN memberships m ON m.block_id = ids.value WHERE m.manual = 1
             ORDER BY m.block_id, m.title_key",
        )?;
        let mut values = statement.query([ids])?;
        while let Some(value) = values.next()? {
            let id: String = value.get(0)?;
            memberships
                .get_mut(id.as_str())
                .expect("selected subtree ID")
                .push(value.get(1)?);
        }
        drop(memberships);
        self.mark_kept_copies(rows.iter_mut().map(|row| &mut row.block))?;
        Ok(Subtree { rows, truncated })
    }

    /// Capture source text and revisions; applying SetQuote never reads the source.
    pub fn quote_snapshot(&self, target_id: &str, captured_at: i64) -> Result<QuoteState> {
        let subtree = self.subtree(target_id, MAX_ROWS)?;
        let mut quote = QuoteState {
            target_id: target_id.to_owned(),
            captured_at,
            rows: Vec::with_capacity(subtree.rows.len()),
            truncated: subtree.truncated,
        };
        let mut bytes = 0;
        for row in subtree.rows {
            bytes += row.block.text.len();
            if bytes > MAX_TEXT_BYTES {
                if quote.rows.is_empty() {
                    return Err(validation("quote root exceeds 64 KiB of text"));
                }
                quote.truncated = true;
                break;
            }
            quote.rows.push(QuotedRow {
                id: row.block.id,
                depth: row.depth,
                text: row.block.text,
                heading: row.block.heading,
                revision: row.block.revision,
            });
        }
        Ok(quote)
    }

    /// Compare each active quote on the page with one bounded live subtree walk.
    pub fn quote_status(&self, page_id: &str) -> Result<Vec<QuoteStatus>> {
        validate_id(page_id)?;
        let page_exists: bool = self.conn.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1 AND parent_id IS NULL AND deletion_id IS NULL)",
        )?.query_row([page_id], |row| row.get(0))?;
        if !page_exists {
            return Err(not_found(page_id));
        }
        let quotes = self
            .conn
            .prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT q.block_id, b.text, q.state FROM quotes q JOIN blocks b ON b.id = q.block_id
             WHERE b.page_id = ?1 AND b.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY q.block_id"
        ))?
            .query_map([page_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut statuses = Vec::with_capacity(quotes.len());
        for (block_id, text, state) in quotes {
            let quote: QuoteState = serde_json::from_str(&state).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            if quote_target(&text) != Some(quote.target_id.as_str()) {
                continue;
            }
            let live = match self.subtree(&quote.target_id, MAX_ROWS) {
                Ok(live) => live,
                Err(Error::NotFound { .. }) => {
                    statuses.push(QuoteStatus {
                        block_id,
                        source_live: false,
                        changed: true,
                    });
                    continue;
                }
                Err(error) => return Err(error),
            };
            let mut bytes = 0;
            let current: HashMap<_, _> = live
                .rows
                .iter()
                .take_while(|row| {
                    bytes += row.block.text.len();
                    bytes <= MAX_TEXT_BYTES
                })
                .map(|row| (row.block.id.as_str(), row.block.revision))
                .collect();
            let changed = current.len() != quote.rows.len()
                || quote
                    .rows
                    .iter()
                    .any(|row| current.get(row.id.as_str()) != Some(&row.revision));
            statuses.push(QuoteStatus {
                block_id,
                source_live: true,
                changed,
            });
        }
        Ok(statuses)
    }
}
