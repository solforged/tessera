//! Spreads retain only their capability. Columns and commentary are ordinary outline blocks.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::fields::reference;
use crate::reads::hidden_blocks;
use crate::storage::{not_found, validate_id, validation};
use crate::{BlockKind, NoteKind, Notebook, Result, SeeTarget};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpreadValue {
    pub text: String,
    pub target_id: Option<String>,
    pub shared: bool,
    pub between_columns: bool,
}

impl SpreadValue {
    fn text(text: &str, ids: &[String]) -> Self {
        let target_id = reference(text).map(str::to_owned);
        let between_columns = target_id.as_ref().is_some_and(|id| ids.contains(id));
        Self {
            text: text.to_owned(),
            target_id,
            shared: false,
            between_columns,
        }
    }
    fn link(id: String, text: String, ids: &[String]) -> Self {
        let between_columns = ids.contains(&id);
        Self {
            text,
            target_id: Some(id),
            shared: false,
            between_columns,
        }
    }
    fn key(&self) -> (&str, bool) {
        match &self.target_id {
            Some(id) => (id, true),
            None => (self.text.trim(), false),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpreadColumn {
    pub id: String,
    pub title: String,
    pub kinds: Vec<NoteKind>,
    pub gloss: Vec<SpreadValue>,
    pub sources: Vec<SpreadValue>,
    pub links: Vec<SpreadValue>,
    pub opening: Vec<SpreadValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpreadField {
    pub id: String,
    pub name: String,
    /// Aligned with columns; an absent or empty field is an empty cell.
    pub cells: Vec<Vec<SpreadValue>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpreadReference {
    pub block_id: String,
    pub note_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spread {
    pub note_ids: Vec<String>,
    pub columns: Vec<SpreadColumn>,
    pub fields: Vec<SpreadField>,
    /// Only saved spreads have reference block identities.
    pub references: Vec<SpreadReference>,
}

pub(crate) fn set(conn: &Connection, id: &str, active: bool) -> Result<bool> {
    let previous = conn
        .prepare_cached("SELECT active FROM spreads WHERE block_id=?1")?
        .query_row([id], |row| row.get::<_, bool>(0))
        .optional()?
        .unwrap_or(false);
    if previous == active {
        return Ok(false);
    }
    conn.prepare_cached(
        "INSERT INTO spreads(block_id, active) VALUES (?1, ?2)
        ON CONFLICT(block_id) DO UPDATE SET active=excluded.active",
    )?
    .execute(params![id, active])?;
    Ok(true)
}

fn references(conn: &Connection, page_id: &str) -> Result<Vec<SpreadReference>> {
    let mut statement = conn.prepare_cached(
        "SELECT b.id, b.text, t.id FROM blocks b JOIN links l ON l.source_id=b.id
         JOIN blocks t ON t.id=l.target_id AND t.kind='page' AND t.deletion_id IS NULL
         WHERE b.parent_id=?1 AND b.deletion_id IS NULL AND b.archived=0 ORDER BY b.ordinal, b.id",
    )?;
    let mut rows = statement.query([page_id])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let text: String = row.get(1)?;
        let id: String = row.get(2)?;
        if reference(&text) == Some(id.as_str()) {
            result.push(SpreadReference {
                block_id: row.get(0)?,
                note_id: id,
            });
        }
    }
    Ok(result)
}

fn check_ids(ids: &[String]) -> Result<()> {
    if ids.len() > 5 {
        return Err(validation("A spread has at most five notes."));
    }
    let mut seen = HashSet::new();
    for id in ids {
        validate_id(id)?;
        if !seen.insert(id) {
            return Err(validation("A spread lists each note once."));
        }
    }
    Ok(())
}

/// Ordinary outline edits must keep saved spreads within their column limit too.
pub(crate) fn validate_pages(conn: &Connection, touched: &[crate::Revision]) -> Result<()> {
    if touched.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = touched.iter().map(|revision| &revision.id).collect();
    let mut statement = conn.prepare_cached(
        "SELECT DISTINCT p.id FROM json_each(?1) touched
        JOIN blocks b ON b.id=touched.value JOIN blocks p ON p.id=b.page_id
        JOIN spreads s ON s.block_id=p.id AND s.active=1 WHERE p.deletion_id IS NULL",
    )?;
    let pages = statement.query_map(
        [serde_json::to_string(&ids).expect("IDs serialize")],
        |row| row.get::<_, String>(0),
    )?;
    for page in pages {
        check_ids(
            &references(conn, &page?)?
                .into_iter()
                .map(|item| item.note_id)
                .collect::<Vec<_>>(),
        )?;
    }
    Ok(())
}

/// A value counts once per column, even when the author repeats it in that column.
fn mark_shared<'a>(cells: impl Iterator<Item = &'a mut Vec<SpreadValue>>) {
    let cells: Vec<_> = cells.collect();
    let mut masks: [HashMap<String, u8>; 2] = [HashMap::new(), HashMap::new()];
    for (column, cell) in cells.iter().enumerate() {
        for value in cell.iter() {
            let (key, link) = value.key();
            if key.is_empty() {
                continue;
            }
            let mask = &mut masks[usize::from(link)];
            if let Some(bits) = mask.get_mut(key) {
                *bits |= 1 << column;
            } else {
                mask.insert(key.to_owned(), 1 << column);
            }
        }
    }
    for cell in cells {
        for value in cell {
            let (key, link) = value.key();
            value.shared = masks[usize::from(link)]
                .get(key)
                .is_some_and(|bits| bits.count_ones() > 1);
        }
    }
}

impl Notebook {
    pub(crate) fn saved_spreads(&self) -> Result<Vec<SeeTarget>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT b.id, b.text FROM spreads s JOIN blocks b ON b.id=s.block_id
            WHERE s.active=1 AND b.deletion_id IS NULL AND b.archived=0 ORDER BY b.title_key, b.id",
            )?
            .query_map([], |row| {
                Ok(SeeTarget {
                    id: row.get(0)?,
                    title: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn saved_spread(&self, page_id: &str) -> Result<Spread> {
        validate_id(page_id)?;
        let active = self.conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM spreads s
            JOIN blocks b ON b.id=s.block_id WHERE s.block_id=?1 AND s.active=1 AND b.deletion_id IS NULL)")?
            .query_row([page_id], |row| row.get::<_, bool>(0))?;
        if !active {
            return Err(not_found(page_id));
        }
        let references = references(&self.conn, page_id)?;
        let mut spread = self.spread(
            &references
                .iter()
                .map(|item| item.note_id.clone())
                .collect::<Vec<_>>(),
        )?;
        spread.references = references;
        Ok(spread)
    }

    pub fn spread(&self, ids: &[String]) -> Result<Spread> {
        check_ids(ids)?;
        if ids.is_empty() {
            return Ok(Spread {
                note_ids: Vec::new(),
                columns: Vec::new(),
                fields: Vec::new(),
                references: Vec::new(),
            });
        }
        let definitions = crate::fields::definitions(&self.conn)?;
        let definitions: HashMap<_, _> = definitions
            .iter()
            .map(|field| (field.id.as_str(), field.name.as_str()))
            .collect();
        let mut kinds = self.spread_kinds(ids)?;
        let mut columns = Vec::with_capacity(ids.len());
        let mut fields: Vec<SpreadField> = Vec::new();
        let mut field_indices = HashMap::new();
        for (column_index, id) in ids.iter().enumerate() {
            let page = self.page(id)?;
            if page.root.kind != BlockKind::Page {
                return Err(validation("A spread compares titled notes."));
            }
            let mut column = SpreadColumn {
                id: id.clone(),
                title: page.root.text,
                kinds: kinds.remove(id).unwrap_or_default(),
                gloss: Vec::new(),
                sources: Vec::new(),
                links: Vec::new(),
                opening: Vec::new(),
            };
            let mut hidden = HashSet::new();
            let mut field_blocks = HashSet::new();
            let mut entries = HashMap::new();
            // Gloss heads each column, so it never repeats as a field row.
            let mut gloss_entries = HashSet::new();
            for row in &page.rows {
                let block = &row.block;
                let parent = block.parent_id.as_deref().unwrap_or("");
                if block.archived || hidden.contains(parent) {
                    hidden.insert(block.id.as_str());
                    continue;
                }
                let field = reference(&block.text).filter(|id| definitions.contains_key(id));
                if field.is_some() || field_blocks.contains(parent) {
                    field_blocks.insert(block.id.as_str());
                }
                if row.depth == 0
                    && let Some(field_id) = field
                {
                    if definitions[field_id].trim().eq_ignore_ascii_case("gloss") {
                        gloss_entries.insert(block.id.as_str());
                    } else {
                        let next = fields.len();
                        let index =
                            *field_indices.entry(field_id.to_owned()).or_insert_with(|| {
                                fields.push(SpreadField {
                                    id: field_id.to_owned(),
                                    name: definitions[field_id].to_owned(),
                                    cells: vec![Vec::new(); ids.len()],
                                });
                                next
                            });
                        entries.insert(block.id.as_str(), index);
                    }
                } else if gloss_entries.contains(parent) {
                    column.gloss.push(SpreadValue::text(&block.text, ids));
                } else if let Some(&index) = entries.get(parent) {
                    fields[index].cells[column_index].push(SpreadValue::text(&block.text, ids));
                }
                if column.opening.is_empty()
                    && !field_blocks.contains(block.id.as_str())
                    && block.heading.is_none()
                    && !block.text.trim().is_empty()
                {
                    column.opening.push(SpreadValue::text(&block.text, ids));
                }
            }
            columns.push(column);
        }
        let selected = serde_json::to_string(ids).expect("IDs serialize");
        // References to source pages and passage citations both contribute to Sources.
        let mut statement = self.conn.prepare_cached(concat!(hidden_blocks!(),
            "SELECT DISTINCT b.page_id, t.id, t.text, s.active=1 FROM links l
             JOIN blocks b ON b.id=l.source_id JOIN blocks t ON t.id=l.target_id
             LEFT JOIN sources s ON s.block_id=t.id
             WHERE b.page_id IN (SELECT value FROM json_each(?1)) AND b.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.kind='page' AND t.deletion_id IS NULL
             ORDER BY b.page_id, t.title_key, t.id"))?;
        let mut rows = statement.query([&selected])?;
        while let Some(row) = rows.next()? {
            let owner: String = row.get(0)?;
            let column = &mut columns[ids
                .iter()
                .position(|id| *id == owner)
                .expect("selected owner")];
            let value = SpreadValue::link(row.get(1)?, row.get(2)?, ids);
            if row.get::<_, Option<bool>>(3)?.unwrap_or(false) {
                column.sources.push(value);
            } else {
                column.links.push(value);
            }
        }
        let mut statement = self.conn.prepare_cached(concat!(hidden_blocks!(),
            "SELECT DISTINCT b.page_id, t.id, t.text FROM citations c JOIN blocks b ON b.id=c.block_id
             JOIN source_snapshots a ON a.snapshot_id=c.snapshot_id
             JOIN sources s ON s.block_id=a.source_id AND s.active=1 JOIN blocks t ON t.id=s.block_id
             WHERE b.page_id IN (SELECT value FROM json_each(?1)) AND c.active=1
               AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.deletion_id IS NULL
             ORDER BY b.page_id, t.title_key, t.id"))?;
        let mut rows = statement.query([&selected])?;
        while let Some(row) = rows.next()? {
            let owner: String = row.get(0)?;
            let target: String = row.get(1)?;
            let column = &mut columns[ids
                .iter()
                .position(|id| *id == owner)
                .expect("selected owner")];
            if !column
                .sources
                .iter()
                .any(|value| value.target_id.as_ref() == Some(&target))
            {
                column
                    .sources
                    .push(SpreadValue::link(target, row.get(2)?, ids));
            }
        }
        for field in &mut fields {
            mark_shared(field.cells.iter_mut());
        }
        mark_shared(columns.iter_mut().map(|column| &mut column.gloss));
        mark_shared(columns.iter_mut().map(|column| &mut column.sources));
        mark_shared(columns.iter_mut().map(|column| &mut column.links));
        mark_shared(columns.iter_mut().map(|column| &mut column.opening));
        Ok(Spread {
            note_ids: ids.to_vec(),
            columns,
            fields,
            references: Vec::new(),
        })
    }
}
