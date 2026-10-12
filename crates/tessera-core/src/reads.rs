use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};

use crate::storage::{
    block_at, block_columns, not_found, stored, validate_date, validate_id, validation,
};
use crate::{
    Backlink, Block, BlockInPage, ChangeEvent, Committed, Completion, Notebook, PageView, Result,
    Row,
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

// Aliases are discovered through their page, not as separate value-block hits.
macro_rules! alias_values {
    () => {
        "SELECT v.value_id FROM field_values v
         JOIN blocks d ON d.id = v.field_id JOIN blocks p ON p.id = d.parent_id
         WHERE lower(d.text) = 'aliases' AND d.deletion_id IS NULL AND d.archived = 0
           AND p.kind = 'page' AND p.title_key = 'fields' AND p.deletion_id IS NULL"
    };
}

impl Notebook {
    /// Read one live block, including an archived block.
    pub fn block(&self, id: &str) -> Result<Block> {
        validate_id(id)?;
        let mut block = stored(&self.conn, id)?
            .filter(|row| row.deletion_id.is_none())
            .map(|row| row.block)
            .ok_or_else(|| not_found(id))?;
        self.mark_kept_copies(std::iter::once(&mut block))?;
        Ok(block)
    }

    /// One indexed lookup for the whole payload, not one query per block.
    pub(crate) fn mark_kept_copies<'a>(
        &self,
        blocks: impl Iterator<Item = &'a mut Block>,
    ) -> Result<()> {
        let mut blocks: HashMap<_, _> = blocks
            .map(|block| (block.id.as_str(), &mut block.kept_copy))
            .collect();
        let ids =
            serde_json::to_string(&blocks.keys().collect::<Vec<_>>()).expect("block IDs serialize");
        let mut statement = self.conn.prepare_cached(
            "SELECT c.id, c.block_id, c.origin,
                    CASE WHEN c.origin = local.device_id THEN
                        COALESCE(d.name, (SELECT device_name FROM sync_hub WHERE singleton = 1))
                    ELSE d.name END,
                    c.origin = local.device_id
             FROM json_each(?1) ids
             JOIN sync_conflicts c ON c.id = ids.value
             JOIN blocks b ON b.id = c.id
             CROSS JOIN replica local
             LEFT JOIN sync_replicas r ON r.device_id = c.origin
             LEFT JOIN sync_devices d ON d.id = r.paired_device
             WHERE c.kind = 'copy' AND c.settled_at IS NULL AND b.deletion_id IS NULL",
        )?;
        let mut rows = statement.query([ids])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if let Some(marker) = blocks.get_mut(id.as_str()) {
                **marker = Some(crate::KeptCopy {
                    of: row.get(1)?,
                    origin: row.get(2)?,
                    origin_name: row.get(3)?,
                    mine: row.get(4)?,
                });
            }
        }
        Ok(())
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
        let mut root = root.ok_or_else(|| not_found(id))?;
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
        let mut targets = self
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
        self.mark_kept_copies(
            std::iter::once(&mut root)
                .chain(rows.iter_mut().map(|row| &mut row.block))
                .chain(targets.iter_mut()),
        )?;
        Ok(PageView {
            root,
            root_manual_types: manual_types.remove(id).unwrap_or_default(),
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

    /// Written dates in an inclusive ledger range of at most 366 days.
    /// Only visible, live descendants count, using the index summary's text rule.
    pub fn written_journal_dates(&self, from: &str, to: &str) -> Result<Vec<String>> {
        let days = crate::calendar::days_between(from, to)?;
        if !(0..=365).contains(&days) {
            return Err(validation("journal ledger range must span 1 to 366 days"));
        }
        let mut statement = self.conn.prepare_cached(
            "WITH RECURSIVE below(date, id, text) AS (
                 SELECT p.text, b.id, b.text FROM blocks p JOIN blocks b ON b.parent_id = p.id
                 WHERE p.kind = 'journal' AND p.text BETWEEN ?1 AND ?2
                   AND p.deletion_id IS NULL AND p.archived = 0
                   AND b.deletion_id IS NULL AND b.archived = 0
                 UNION ALL
                 SELECT s.date, b.id, b.text FROM blocks b JOIN below s ON b.parent_id = s.id
                 WHERE b.deletion_id IS NULL AND b.archived = 0
             ) SELECT date, text FROM below ORDER BY date",
        )?;
        let mut rows = statement.query(params![from, to])?;
        let mut dates: Vec<String> = Vec::new();
        while let Some(row) = rows.next()? {
            let text = row.get_ref(1)?.as_str().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            if !text.trim().is_empty() {
                let date = row.get_ref(0)?.as_str().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                if dates.last().is_none_or(|last| last != date) {
                    dates.push(date.to_owned());
                }
            }
        }
        Ok(dates)
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

    /// Indexed page-title prefixes, then folded aliases, then FTS word prefixes.
    pub fn complete(&self, query: &str, limit: usize) -> Result<Vec<Completion>> {
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
        let collect = |row: &rusqlite::Row<'_>| {
            Ok(Completion {
                block: block_at(row, 0)?,
                alias: None,
            })
        };
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
        let folded = crate::aliases::fold(query);
        let single_word = !folded.contains(' ');
        let mut aliases = self.aliases_by_page()?;
        if !aliases.is_empty() {
            let mut pages = self.conn.prepare_cached(
                "SELECT id FROM blocks WHERE parent_id IS NULL AND kind = 'page'
                 AND deletion_id IS NULL AND archived = 0 ORDER BY title_key, id",
            )?;
            let mut cursor = pages.query([])?;
            while let Some(row) = cursor.next()? {
                let id: String = row.get(0)?;
                if result.iter().any(|completion| completion.block.id == id) {
                    continue;
                }
                let Some(names) = aliases.remove(&id) else {
                    continue;
                };
                let alias = names.into_iter().find(|name| {
                    let name = crate::aliases::fold(name);
                    name.starts_with(&folded)
                        || (single_word
                            && name
                                .split_whitespace()
                                .any(|word| word.starts_with(&folded)))
                });
                if let Some(alias) = alias {
                    result.push(Completion {
                        block: self.block(&id)?,
                        alias: Some(alias),
                    });
                    if result.len() == limit {
                        return Ok(result);
                    }
                }
            }
        }
        let matched = fts_query(query);
        if matched.is_empty() {
            return Ok(result);
        }
        let seen: HashSet<&str> = result
            .iter()
            .map(|completion| completion.block.id.as_str())
            .collect();
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
                   AND s.block_id NOT IN (",
                alias_values!(),
                ")
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
            .map(|block| Completion { block, alias: None })
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
                   AND s.block_id NOT IN (",
            alias_values!(),
            ")
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

    /// Local editor arrival cursor. Hub sequence numbers may change on rebase.
    pub fn editor_cursor(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM editor_events", [], |r| {
                r.get(0)
            })?)
    }

    /// The first local editor event for a log receipt, including idempotent
    /// retries after a rebase moved the log's sequence numbers.
    pub fn editor_change_cursor(&self, change_seq: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE((SELECT MIN(e.seq) FROM editor_events e WHERE e.change_id = c.change_id), c.seq) FROM changes c WHERE c.seq = ?1",
            [change_seq], |row| row.get(0),
        )?)
    }

    pub fn changes_since(&self, seq: i64, limit: usize) -> Result<Vec<ChangeEvent>> {
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT c.seq, c.actor, c.reason, c.created_at, c.restructured_pages, json_extract(r.value, '$.id'), ",
            block_columns!("b"),
            ", b.deletion_id, c.views, c.committed
             FROM (SELECT * FROM editor_events WHERE seq > ?1 ORDER BY seq LIMIT ?2) c
             LEFT JOIN json_each(c.committed, '$.revisions') r
             LEFT JOIN blocks b ON b.id = json_extract(r.value, '$.id') ORDER BY c.seq, r.key",
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

/// Record a commit in local editor arrival order, independently of hub seq.
pub(crate) fn record_editor_event(
    conn: &rusqlite::Connection,
    seq: i64,
    synced: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO editor_events(seq, change_id, actor, reason, created_at, committed, restructured_pages, views)
         SELECT MAX(?1, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'editor_events'), 0) + 1),
                change_id, CASE WHEN ?2 THEN '{\"kind\":\"client\",\"name\":\"sync\"}' ELSE actor END,
                reason, created_at, committed,
                CASE WHEN ?2 THEN
                  (SELECT json_group_array(page) FROM (
                    SELECT value AS page FROM json_each(changes.restructured_pages)
                    UNION SELECT b.page_id FROM json_each(changes.committed, '$.revisions') r
                    JOIN blocks b ON b.id = json_extract(r.value, '$.id')))
                ELSE restructured_pages END, views
         FROM changes WHERE seq = ?1",
        params![seq, synced],
    )?;
    Ok(())
}
