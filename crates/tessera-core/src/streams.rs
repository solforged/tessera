use std::collections::HashSet;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::calendar::add_days;
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{Block, Error, Notebook, Result, Row};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSubtree {
    pub id: String,
    pub page: Option<Block>,
    pub rows: Vec<Row>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSubtrees {
    pub trees: Vec<BatchSubtree>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamArrival {
    pub block: Block,
    pub page: Block,
    pub anchor_id: String,
}

impl Notebook {
    /// One bounded read for live embeds. Missing/hidden roots have no rows and
    /// are not truncated; a root omitted by a row cap is marked truncated.
    pub fn subtrees(&self, ids: &[String], per_id: usize, total: usize) -> Result<BatchSubtrees> {
        if ids.len() > 256 {
            return Err(validation("at most 256 subtree IDs are allowed"));
        }
        for id in ids {
            validate_id(id)?;
        }
        let mut remaining = total.min(4096);
        let mut trees = Vec::with_capacity(ids.len());
        let mut seen = HashSet::with_capacity(ids.len());
        for id in ids {
            if !seen.insert(id) {
                continue;
            }
            let tree = match self.subtree(id, per_id.min(200).min(remaining)) {
                Ok(tree) => tree,
                Err(Error::NotFound { .. }) => {
                    trees.push(BatchSubtree {
                        id: id.clone(),
                        page: None,
                        rows: Vec::new(),
                        truncated: false,
                    });
                    continue;
                }
                Err(error) => return Err(error),
            };
            remaining -= tree.rows.len();
            let page = tree
                .rows
                .first()
                .map(|row| self.block(&row.block.page_id))
                .transpose()?;
            trees.push(BatchSubtree {
                id: id.clone(),
                page,
                rows: tree.rows,
                truncated: tree.truncated,
            });
        }
        Ok(BatchSubtrees {
            truncated: trees.iter().any(|tree| tree.truncated),
            trees,
        })
    }

    /// Direct children of journal anchors linking this page, newest day first.
    /// The date window and child count are hard bounded; filing is represented
    /// solely by whole-row references anywhere in the destination outline.
    pub fn stream_arrivals(
        &self,
        id: &str,
        date: &str,
        days: usize,
        limit: usize,
    ) -> Result<Vec<StreamArrival>> {
        validate_id(id)?;
        let since = add_days(date, -(days.clamp(1, 100) as i64 - 1))?;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT DISTINCT ", block_columns!("c"), ", ", block_columns!("p"), ", a.id
             FROM links l JOIN blocks a ON a.id = l.source_id
             JOIN blocks p ON p.id = a.page_id
             JOIN blocks c ON c.parent_id = a.id
             WHERE l.target_id = ?1 AND p.kind = 'journal'
               AND p.text >= ?2 AND p.text <= ?3
               AND a.deletion_id IS NULL AND p.deletion_id IS NULL AND c.deletion_id IS NULL
               AND c.rowid NOT IN (SELECT rowid FROM hidden)
               AND EXISTS (SELECT 1 FROM blocks s WHERE s.id = ?1 AND s.parent_id IS NULL AND s.deletion_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM blocks f WHERE f.page_id = ?1
                   AND f.parent_id IS NOT NULL AND f.deletion_id IS NULL
                   AND trim(f.text, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = '[[' || c.id || ']]')
             ORDER BY p.text DESC, a.id, c.ordinal, c.id LIMIT ?4"
        ))?;
        Ok(statement
            .query_map(params![id, since, date, limit.min(200) as i64], |row| {
                Ok(StreamArrival {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                    anchor_id: row.get(20)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
}
