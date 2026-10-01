use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};

use crate::storage::{
    block_at, block_columns, not_found, stored, validate_date, validate_id, validation,
};
use crate::{Backlink, Block, Change, Notebook, PageView, Result, Revision, Row, SearchHit};

fn sql_limit(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

fn fts_query(query: &str) -> String {
    let mut matched = String::with_capacity(query.len() + 3);
    for word in query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        if !matched.is_empty() {
            matched.push_str(" AND ");
        }
        matched.push('"');
        matched.push_str(word);
        matched.push_str("\"*");
    }
    matched
}

fn prefix_end(prefix: &str) -> Option<String> {
    let mut end = prefix.to_owned();
    while let Some(last) = end.pop() {
        let mut next = u32::from(last) + 1;
        if (0xD800..=0xDFFF).contains(&next) {
            next = 0xE000;
        }
        if let Some(next) = char::from_u32(next) {
            end.push(next);
            return Some(end);
        }
    }
    None
}

impl Notebook {
    /// Read one live block, including an archived block.
    pub fn block(&self, id: &str) -> Result<Block> {
        validate_id(id)?;
        stored(&self.conn, id)?
            .filter(|row| row.deletion_id.is_none())
            .map(|row| row.block)
            .ok_or_else(|| not_found(id))
    }

    /// Fetch the page's rows once, then its external reference targets once.
    pub fn page(&self, id: &str) -> Result<PageView> {
        validate_id(id)?;
        let blocks = self
            .conn
            .prepare_cached(concat!(
                "SELECT ",
                block_columns!("b"),
                " FROM blocks b WHERE b.page_id = ?1 AND b.deletion_id IS NULL
             ORDER BY b.parent_id, b.ordinal, b.id"
            ))?
            .query_map([id], |row| block_at(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let capacity = blocks.len().saturating_sub(1);
        let mut root = None;
        let mut children: HashMap<String, Vec<Block>> = HashMap::new();
        for block in blocks {
            if let Some(parent) = &block.parent_id {
                children.entry(parent.clone()).or_default().push(block);
            } else if block.id == id {
                root = Some(block);
            }
        }
        let root = root.ok_or_else(|| not_found(id))?;
        let mut rows = Vec::with_capacity(capacity);
        let mut stack = Vec::new();
        if let Some(children) = children.remove(id) {
            stack.extend(children.into_iter().rev().map(|block| (block, 0)));
        }
        while let Some((block, depth)) = stack.pop() {
            if let Some(children) = children.remove(&block.id) {
                stack.extend(children.into_iter().rev().map(|block| (block, depth + 1)));
            }
            rows.push(Row { block, depth });
        }
        let targets = self
            .conn
            .prepare_cached(concat!(
                "SELECT DISTINCT ",
                block_columns!("b"),
                " FROM blocks s
             JOIN links l ON l.source_id = s.id JOIN blocks b ON b.id = l.target_id
             WHERE s.page_id = ?1 AND s.deletion_id IS NULL
               AND b.deletion_id IS NULL AND b.page_id != ?1 ORDER BY b.id"
            ))?
            .query_map([id], |row| block_at(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PageView {
            root,
            rows,
            targets,
        })
    }

    /// Live pages by Unicode-lowercase title, then journal days newest first.
    pub fn roots(&self) -> Result<Vec<Block>> {
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            block_columns!("b"),
            " FROM blocks b WHERE b.parent_id IS NULL AND b.deletion_id IS NULL
             ORDER BY CASE b.kind WHEN 'page' THEN 0 ELSE 1 END,
             CASE WHEN b.kind = 'page' THEN b.title_key END,
             CASE WHEN b.kind = 'journal' THEN b.text END DESC, b.id"
        ))?;
        Ok(statement
            .query_map([], |row| block_at(row, 0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn journal(&self, date: &str) -> Result<Option<Block>> {
        validate_date(date)?;
        Ok(self
            .conn
            .prepare_cached(concat!(
                "SELECT ",
                block_columns!("b"),
                " FROM blocks b
             WHERE b.kind = 'journal' AND b.deletion_id IS NULL AND b.text = ?1"
            ))?
            .query_row([date], |row| block_at(row, 0))
            .optional()?)
    }

    /// Distinct live sources, rather than one backlink per occurrence.
    pub fn backlinks(&self, id: &str, limit: usize) -> Result<Vec<Backlink>> {
        validate_id(id)?;
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT DISTINCT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            " FROM links l
             JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id
             WHERE l.target_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
               AND EXISTS (SELECT 1 FROM blocks t WHERE t.id = ?1 AND t.deletion_id IS NULL)
             ORDER BY b.id LIMIT ?2"
        ))?;
        Ok(statement
            .query_map(params![id, sql_limit(limit)], |row| {
                Ok(Backlink {
                    source: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Indexed Unicode-lowercase page-title prefix, then FTS word prefixes.
    pub fn complete(&self, query: &str, limit: usize) -> Result<Vec<Block>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let prefix = query.to_lowercase();
        let end = prefix_end(&prefix);
        let sql = if end.is_some() {
            concat!(
                "SELECT ",
                block_columns!("b"),
                " FROM blocks b
                WHERE b.kind = 'page' AND b.deletion_id IS NULL
                AND b.title_key >= ?1 AND b.title_key < ?3 ORDER BY b.title_key, b.id LIMIT ?2"
            )
        } else {
            concat!(
                "SELECT ",
                block_columns!("b"),
                " FROM blocks b
                WHERE b.kind = 'page' AND b.deletion_id IS NULL
                AND b.title_key >= ?1 ORDER BY b.title_key, b.id LIMIT ?2"
            )
        };
        let mut statement = self.conn.prepare_cached(sql)?;
        let collect = |row: &rusqlite::Row<'_>| block_at(row, 0);
        let mut result = if let Some(end) = end {
            statement
                .query_map(params![prefix, sql_limit(limit), end], collect)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            statement
                .query_map(params![prefix, sql_limit(limit)], collect)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if result.len() == limit {
            return Ok(result);
        }
        let matched = fts_query(query);
        if matched.is_empty() {
            return Ok(result);
        }
        let seen: HashSet<&str> = result.iter().map(|block| block.id.as_str()).collect();
        // Rank narrow rowid-to-ID records before fetching authored text.
        // FTS and search_blocks contain only live rows, maintained atomically.
        let additional = self
            .conn
            .prepare_cached(concat!(
                "WITH hits AS MATERIALIZED (
                 SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts
                 JOIN search_blocks s ON s.rowid = blocks_fts.rowid
                 WHERE blocks_fts MATCH ?1 ORDER BY score, s.block_id LIMIT ?2
             ) SELECT ",
                block_columns!("b"),
                " FROM hits h JOIN blocks b ON b.id = h.id ORDER BY h.score, b.id"
            ))?
            .query_map(params![matched, sql_limit(limit)], |row| block_at(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let additional: Vec<_> = additional
            .into_iter()
            .filter(|block| !seen.contains(block.id.as_str()))
            .take(limit - result.len())
            .collect();
        result.extend(additional);
        Ok(result)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let matched = fts_query(query);
        if matched.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare_cached(concat!(
            "WITH hits AS MATERIALIZED (
                 SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts
                 JOIN search_blocks s ON s.rowid = blocks_fts.rowid
                 WHERE blocks_fts MATCH ?1 ORDER BY score, s.block_id LIMIT ?2
             ) SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            " FROM hits h
             JOIN blocks b ON b.id = h.id JOIN blocks p ON p.id = b.page_id
             WHERE p.deletion_id IS NULL ORDER BY h.score, b.id"
        ))?;
        Ok(statement
            .query_map(params![matched, sql_limit(limit)], |row| {
                Ok(SearchHit {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn changes_since(&self, seq: i64, limit: usize) -> Result<Vec<Change>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT c.seq, c.actor, c.reason, c.created_at, r.block_id, r.revision
             FROM (SELECT * FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2) c
             LEFT JOIN change_revisions r ON r.change_seq = c.seq ORDER BY c.seq, r.position",
        )?;
        let mut cursor = statement.query(params![seq, sql_limit(limit)])?;
        let mut changes: Vec<Change> = Vec::new();
        while let Some(row) = cursor.next()? {
            let seq = row.get(0)?;
            if changes.last().is_none_or(|change| change.seq != seq) {
                let actor: String = row.get(1)?;
                changes.push(Change {
                    seq,
                    actor: serde_json::from_str(&actor)
                        .map_err(|error| validation(format!("invalid stored actor: {error}")))?,
                    reason: row.get(2)?,
                    created_at: row.get(3)?,
                    revisions: Vec::new(),
                });
            }
            if let Some(id) = row.get::<_, Option<String>>(4)? {
                changes
                    .last_mut()
                    .expect("change exists")
                    .revisions
                    .push(Revision {
                        id,
                        revision: row.get(5)?,
                    });
            }
        }
        Ok(changes)
    }
}
