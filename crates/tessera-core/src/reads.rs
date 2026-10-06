use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};

use crate::storage::{
    block_at, block_columns, not_found, stored, validate_date, validate_id, validation,
};
use crate::{
    Backlink, Block, BlockInPage, ChangeEvent, Committed, Notebook, PageView, Result, Row,
};

fn sql_limit(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

pub(crate) fn fts_query(query: &str) -> String {
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

// Materialize only hidden IDs, using the archived-seed and live-sibling indexes.
// Keeping archived documents in FTS preserves its live-corpus BM25 statistics.
macro_rules! hidden_blocks {
    () => {
        "WITH RECURSIVE hidden(rowid, id) AS MATERIALIZED (
             SELECT rowid, id FROM blocks WHERE archived = 1 AND deletion_id IS NULL
             UNION
             SELECT b.rowid, b.id FROM blocks b JOIN hidden h ON b.parent_id = h.id
             WHERE b.deletion_id IS NULL
         ) "
    };
}
pub(crate) use hidden_blocks;

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
        let mut manual_types: HashMap<String, Vec<String>> = HashMap::new();
        let mut memberships = self.conn.prepare_cached(
            "SELECT m.block_id, m.title FROM memberships m JOIN blocks b ON b.id = m.block_id
             WHERE b.page_id = ?1 AND b.deletion_id IS NULL AND m.manual = 1
             ORDER BY m.block_id, m.title_key",
        )?;
        for row in memberships.query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, title) = row?;
            manual_types.entry(id).or_default().push(title);
        }
        let mut rows = Vec::with_capacity(capacity);
        let mut stack = Vec::new();
        if let Some(children) = children.remove(id) {
            stack.extend(children.into_iter().rev().map(|block| (block, 0)));
        }
        while let Some((block, depth)) = stack.pop() {
            if let Some(children) = children.remove(&block.id) {
                stack.extend(children.into_iter().rev().map(|block| (block, depth + 1)));
            }
            let manual_types = manual_types.remove(&block.id).unwrap_or_default();
            rows.push(Row {
                block,
                depth,
                manual_types,
            });
        }
        let targets = self
            .conn
            .prepare_cached(concat!(
                "WITH targets(id) AS (
                 SELECT l.target_id FROM blocks s JOIN links l ON l.source_id = s.id
                 JOIN blocks t ON t.id = l.target_id
                 WHERE s.page_id = ?1 AND s.deletion_id IS NULL AND t.page_id != ?1
                 UNION
                 SELECT m.type_id FROM blocks s JOIN memberships m ON m.block_id = s.id
                 WHERE s.page_id = ?1 AND s.deletion_id IS NULL
             ) SELECT ",
                block_columns!("b"),
                " FROM targets t JOIN blocks b ON b.id = t.id
                 WHERE b.deletion_id IS NULL ORDER BY b.id"
            ))?
            .query_map([id], |row| block_at(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PageView {
            root,
            rows,
            targets,
            capabilities: crate::task_store::page_capabilities(&self.conn, id)?,
        })
    }

    /// Visible pages by Unicode-lowercase title, then journal days newest first.
    pub fn roots(&self) -> Result<Vec<Block>> {
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            block_columns!("b"),
            " FROM blocks b WHERE b.parent_id IS NULL AND b.deletion_id IS NULL AND b.archived = 0
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

    /// Resolve a live named page by its Unicode-lowercase title.
    pub fn page_by_title(&self, title: &str) -> Result<Option<Block>> {
        Ok(self.conn.prepare_cached(concat!(
            "SELECT ", block_columns!("b"),
            " FROM blocks b WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.title_key = ?1"
        ))?.query_row([title.to_lowercase()], |row| block_at(row, 0)).optional()?)
    }

    /// Distinct visible tagged blocks, with their current source page.
    pub fn members(&self, type_id: &str, limit: usize) -> Result<Vec<BlockInPage>> {
        validate_id(type_id)?;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT DISTINCT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            " FROM memberships m JOIN blocks b ON b.id = m.block_id
             JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id
             WHERE m.type_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
               AND t.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden)
               AND t.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY m.block_id LIMIT ?2"
        ))?;
        Ok(statement
            .query_map(params![type_id, sql_limit(limit)], |row| {
                Ok(BlockInPage {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Distinct visible sources, rather than one backlink per occurrence.
    pub fn backlinks(&self, id: &str, limit: usize) -> Result<Vec<Backlink>> {
        validate_id(id)?;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT DISTINCT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            " FROM links l
             JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id
             WHERE l.target_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden)
               AND EXISTS (SELECT 1 FROM blocks t WHERE t.id = ?1 AND t.deletion_id IS NULL
                           AND t.rowid NOT IN (SELECT rowid FROM hidden))
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
                WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.archived = 0
                AND b.title_key >= ?1 AND b.title_key < ?3 ORDER BY b.title_key, b.id LIMIT ?2"
            )
        } else {
            concat!(
                "SELECT ",
                block_columns!("b"),
                " FROM blocks b
                WHERE b.kind = 'page' AND b.deletion_id IS NULL AND b.archived = 0
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
                hidden_blocks!(),
                ", hits AS MATERIALIZED (
                 SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts
                 JOIN search_blocks s ON s.rowid = blocks_fts.rowid
                 WHERE blocks_fts MATCH ?1 AND blocks_fts.rowid NOT IN (SELECT rowid FROM hidden)
                 ORDER BY score, s.block_id LIMIT ?2
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

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<BlockInPage>> {
        let matched = fts_query(query);
        if matched.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            ", hits AS MATERIALIZED (
                 SELECT s.block_id AS id, bm25(blocks_fts) AS score FROM blocks_fts
                 JOIN search_blocks s ON s.rowid = blocks_fts.rowid
                 WHERE blocks_fts MATCH ?1 AND blocks_fts.rowid NOT IN (SELECT rowid FROM hidden)
                 ORDER BY score, s.block_id LIMIT ?2
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
                Ok(BlockInPage {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn changes_since(&self, seq: i64, limit: usize) -> Result<Vec<ChangeEvent>> {
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT c.seq, c.actor, c.reason, c.created_at, c.restructured_pages, r.block_id, ",
            block_columns!("b"),
            ", b.deletion_id, c.views, c.committed
             FROM (SELECT * FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2) c
             LEFT JOIN change_revisions r ON r.change_seq = c.seq
             LEFT JOIN blocks b ON b.id = r.block_id ORDER BY c.seq, r.position",
        ))?;
        let mut cursor = statement.query(params![seq, sql_limit(limit)])?;
        let mut changes: Vec<ChangeEvent> = Vec::new();
        while let Some(row) = cursor.next()? {
            let seq = row.get(0)?;
            if changes.last().is_none_or(|change| change.seq != seq) {
                let actor: String = row.get(1)?;
                let pages: String = row.get(4)?;
                let committed: Committed = serde_json::from_str(&row.get::<_, String>(18)?)
                    .map_err(|error| validation(format!("invalid stored result: {error}")))?;
                changes.push(ChangeEvent {
                    seq,
                    actor: serde_json::from_str(&actor)
                        .map_err(|error| validation(format!("invalid stored actor: {error}")))?,
                    reason: row.get(2)?,
                    created_at: row.get(3)?,
                    blocks: Vec::new(),
                    removed: Vec::new(),
                    restructured_pages: serde_json::from_str(&pages)
                        .map_err(|error| validation(format!("invalid stored pages: {error}")))?,
                    views: serde_json::from_str(&row.get::<_, String>(17)?)
                        .map_err(|error| validation(format!("invalid stored view IDs: {error}")))?,
                    settings: committed
                        .settings
                        .into_iter()
                        .map(|setting| setting.key)
                        .collect(),
                    capabilities: committed.capabilities,
                    cards: committed.cards.into_iter().map(|card| card.id).collect(),
                    work_sessions: committed
                        .work_sessions
                        .into_iter()
                        .map(|session| session.id)
                        .collect(),
                    review_sessions: committed
                        .review_sessions
                        .into_iter()
                        .map(|session| session.id)
                        .collect(),
                    decks: committed.decks.into_iter().map(|deck| deck.id).collect(),
                    task_views: committed
                        .task_views
                        .into_iter()
                        .map(|view| view.id)
                        .collect(),
                    library_views: committed
                        .library_views
                        .into_iter()
                        .map(|view| view.id)
                        .collect(),
                });
            }
            if let Some(id) = row.get::<_, Option<String>>(5)? {
                let change = changes.last_mut().expect("change exists");
                if change.views.contains(&id) {
                    continue;
                }
                if row.get::<_, Option<String>>(6)?.is_none()
                    || row.get::<_, Option<String>>(16)?.is_some()
                {
                    change.removed.push(id);
                } else {
                    change.blocks.push(block_at(row, 6)?);
                }
            }
        }
        let ids: HashSet<_> = changes
            .iter()
            .flat_map(|change| {
                change
                    .capabilities
                    .iter()
                    .map(|capability| capability.block_id.clone())
            })
            .collect();
        if !ids.is_empty() {
            let mut ids: Vec<_> = ids.into_iter().collect();
            ids.sort_unstable();
            let current: HashMap<_, _> = crate::task_store::capabilities_for(&self.conn, &ids)?
                .into_iter()
                .map(|capability| (capability.block_id.clone(), capability))
                .collect();
            for change in &mut changes {
                // Like block rows, capability rows represent the current state,
                // even when the receipt itself predates a later mutation.
                change.capabilities.retain_mut(|capability| {
                    if let Some(value) = current.get(&capability.block_id) {
                        capability.clone_from(value);
                        true
                    } else {
                        false
                    }
                });
            }
        }
        Ok(changes)
    }
}
