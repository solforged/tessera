use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};

use crate::reads::{entity_pages, hidden_blocks};
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    BlockCapabilities, BlockInPage, FieldOption, Notebook, PositionField, PositionInfo,
    PositionQuery, PositionQueryResult, PositionQuestion, PositionRow, Result, SubjectCriteria,
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
    crate::relation_store::guard_other(conn, id, "a perspective")?;
    Ok(conn
        .prepare_cached(
            "INSERT INTO positions(block_id, active) VALUES (?1, 1)
         ON CONFLICT(block_id) DO UPDATE SET active = 1 WHERE positions.active = 0",
        )?
        .execute([id])?
        != 0)
}

/// A holder is a person or group; anything else keeps the perspective and reports one of these.
pub const NO_HOLDER: &str = "Start with a link to the person or group who holds this.";
pub const NOT_ENTITY: &str = "The holder is not filed as a person or group.";

/// Resolve both links together, without skipping an invalid first or second link.
/// An optional ID set keeps page loads and receipts set-based.
pub(crate) fn derive(
    conn: &Connection,
    ids: Option<&[String]>,
) -> Result<HashMap<String, PositionInfo>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        ", candidates AS (
            SELECT b.id, b.page_id,
                (SELECT target_id FROM links WHERE source_id = b.id ORDER BY occurrence LIMIT 1) AS first_id,
                (SELECT target_id FROM links WHERE source_id = b.id ORDER BY occurrence LIMIT 1 OFFSET 1) AS second_id
            FROM positions pos JOIN blocks b ON b.id = pos.block_id
            WHERE pos.active = 1 AND (?1 IS NULL OR b.id IN (SELECT value FROM json_each(?1)))
        ), ",
        entity_pages!(),
        "SELECT c.id, c.page_id, CASE WHEN h.deletion_id IS NULL THEN h.id END,
            CASE WHEN h.id IS NOT NULL AND s.id != h.id THEN s.id END,
            h.id IN (SELECT id FROM entity_pages),
            CASE WHEN h.deletion_id IS NOT NULL THEN h.id END,
            CASE WHEN h.deletion_id IS NOT NULL THEN h.text END
        FROM candidates c
        LEFT JOIN blocks h ON h.id = c.first_id AND h.kind = 'page'
            AND h.parent_id IS NULL
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
                row.get::<_, Option<bool>>(4)?.unwrap_or(false),
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        },
    )?;
    let mut result = HashMap::new();
    for row in rows {
        let (id, page, holder_id, subject, entity, deleted_id, deleted_text) = row?;
        let deleted_holder = if let Some(id) = deleted_id {
            let mut labels = conn.prepare_cached("SELECT text FROM blocks WHERE id = ?1")?;
            Some(FieldOption {
                id,
                text: crate::fields::target_label(
                    deleted_text.as_deref().unwrap_or_default(),
                    &mut |target| {
                        labels
                            .query_row([target], |row| row.get(0))
                            .optional()
                            .ok()
                            .flatten()
                    },
                ),
            })
        } else {
            None
        };
        let subject_id = match subject {
            Some(subject) => subject,
            None => crate::question_store::nearest_question_ancestor(conn, &id)?.unwrap_or(page),
        };
        let problem = if deleted_holder.is_some() {
            Some(
                "The linked holder was deleted. Change holder to repair this attribution."
                    .to_owned(),
            )
        } else {
            match (&holder_id, entity) {
                (None, _) => Some(NO_HOLDER.to_owned()),
                (Some(_), false) => Some(NOT_ENTITY.to_owned()),
                (Some(_), true) => None,
            }
        };
        result.insert(
            id,
            PositionInfo {
                holder_id,
                subject_id,
                deleted_holder,
                problem,
            },
        );
    }
    Ok(result)
}

pub(crate) fn subject_counts(conn: &Connection) -> Result<HashMap<String, usize>> {
    let ids = conn
        .prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT b.id FROM positions pos JOIN blocks b ON b.id = pos.block_id
             JOIN blocks root ON root.id = b.page_id
             WHERE pos.active = 1 AND b.deletion_id IS NULL AND root.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden)"
        ))?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    let mut counts = HashMap::new();
    for info in derive(conn, Some(&ids))?.into_values() {
        *counts.entry(info.subject_id).or_default() += 1;
    }
    Ok(counts)
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
    /// Every page that can hold a perspective, in one read for the holder pickers.
    pub fn entities(&self) -> Result<Vec<String>> {
        Ok(self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                ", ",
                entity_pages!(),
                "SELECT e.id FROM entity_pages e JOIN blocks b ON b.id = e.id
                 WHERE b.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY b.title_key, b.id"
            ))?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn positions(&self, query: &PositionQuery) -> Result<PositionQueryResult> {
        if query.holder.is_none() && query.subject.is_none() {
            return Err(validation("A holder or subject is required"));
        }
        for id in [&query.holder, &query.subject].into_iter().flatten() {
            validate_id(id)?;
        }
        let mut positions = derive(&self.conn, None)?;
        positions.retain(|_, info| {
            (query.subject.is_some()
                || query
                    .holder
                    .as_ref()
                    .is_none_or(|holder| info.holder_id.as_ref() == Some(holder)))
                && query
                    .subject
                    .as_ref()
                    .is_none_or(|subject| &info.subject_id == subject)
        });
        let ids =
            serde_json::to_string(&positions.keys().collect::<Vec<_>>()).expect("IDs serialize");
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
            ORDER BY p.id, o.path"
        ))?;
        let rows = statement.query_map([&ids], |row| {
            Ok(BlockInPage {
                block: block_at(row, 0)?,
                page: block_at(row, 10)?,
            })
        })?;
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
                deleted_holder: info.deleted_holder,
                fields: Vec::new(),
            });
        }
        let definitions: HashMap<_, _> = crate::fields::definitions(&self.conn)?
            .into_iter()
            .map(|field| (field.id, field.name))
            .collect();
        let mut entries: HashMap<String, Vec<PositionField>> = HashMap::new();
        let mut statement = self.conn.prepare_cached(
            "SELECT e.parent_id, e.id, e.text, v.id, v.text
             FROM blocks e LEFT JOIN blocks v ON v.parent_id = e.id
               AND v.deletion_id IS NULL AND v.archived = 0
             WHERE e.parent_id IN (SELECT value FROM json_each(?1))
               AND e.deletion_id IS NULL AND e.archived = 0
             ORDER BY e.parent_id, e.ordinal, e.id, v.ordinal, v.id",
        )?;
        let mut cursor = statement.query([&ids])?;
        while let Some(row) = cursor.next()? {
            let text: String = row.get(2)?;
            let Some(field) =
                crate::fields::reference(&text).filter(|id| definitions.contains_key(*id))
            else {
                continue;
            };
            let owner: String = row.get(0)?;
            let entry_id: String = row.get(1)?;
            let fields = entries.entry(owner).or_default();
            if fields.last().is_none_or(|entry| entry.entry_id != entry_id) {
                fields.push(PositionField {
                    field_id: field.into(),
                    entry_id,
                    values: Vec::new(),
                });
            }
            if let Some(id) = row.get::<_, Option<String>>(3)? {
                fields
                    .last_mut()
                    .expect("entry inserted")
                    .values
                    .push(FieldOption {
                        id,
                        text: row.get(4)?,
                    });
            }
        }
        let mut criteria = SubjectCriteria::default();
        if let Some(subject) = &query.subject {
            criteria.fields = self
                .conn
                .prepare_cached(
                    "SELECT field_id FROM subject_criteria WHERE subject_id = ?1 ORDER BY position",
                )?
                .query_map([subject], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            criteria.explicit = !criteria.fields.is_empty();
        }
        let mut seen = HashSet::new();
        for row in &mut result {
            row.fields = entries.remove(&row.block.block.id).unwrap_or_default();
            if !criteria.explicit {
                for field in &row.fields {
                    let name = definitions[&field.field_id].trim();
                    if !name.eq_ignore_ascii_case("gist")
                        && !name.eq_ignore_ascii_case("work")
                        && !name.eq_ignore_ascii_case("account")
                        && seen.insert(field.field_id.clone())
                    {
                        criteria.fields.push(field.field_id.clone());
                    }
                }
            }
        }
        let questions = if let Some(subject) = &query.subject {
            self.position_questions(subject, &criteria.fields, &result)?
        } else {
            Vec::new()
        };
        result.retain(|row| {
            query
                .holder
                .as_ref()
                .is_none_or(|holder| row.holder_id.as_ref() == Some(holder))
        });
        if let Some(limit) = query.limit {
            result.truncate(limit as usize);
        }
        Ok(PositionQueryResult {
            rows: result,
            criteria,
            questions,
        })
    }

    fn position_questions(
        &self,
        subject: &str,
        criteria: &[String],
        positions: &[PositionRow],
    ) -> Result<Vec<PositionQuestion>> {
        let holders: HashSet<_> = positions
            .iter()
            .filter_map(|row| row.holder_id.as_deref())
            .collect();
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            ", outline(id, path) AS (
                SELECT id, '' FROM blocks WHERE id = ?1
                UNION ALL
                SELECT b.id, o.path || '/' || printf('%020d', b.ordinal) || b.id
                FROM blocks b JOIN outline o ON b.parent_id = o.id
                WHERE b.deletion_id IS NULL AND b.archived = 0
                  AND NOT EXISTS (SELECT 1 FROM positions WHERE block_id = b.id AND active = 1)
            ) SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", l.target_id
            FROM outline o JOIN blocks b ON b.id = o.id
            JOIN blocks p ON p.id = b.page_id JOIN questions q ON q.block_id = b.id AND q.active = 1
            LEFT JOIN links l ON l.source_id = b.id
            WHERE b.id != ?1 AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
            ORDER BY o.path, l.occurrence"
        ))?;
        let mut cursor = statement.query([subject])?;
        let mut blocks: Vec<(BlockInPage, Option<String>, Vec<String>)> = Vec::new();
        while let Some(row) = cursor.next()? {
            let id: String = row.get(0)?;
            if blocks
                .last()
                .is_none_or(|(block, _, _)| block.block.id != id)
            {
                blocks.push((
                    BlockInPage {
                        block: block_at(row, 0)?,
                        page: block_at(row, 10)?,
                    },
                    None,
                    Vec::new(),
                ));
            }
            let (_, criterion, scope) = blocks.last_mut().expect("question inserted");
            if let Some(target) = row.get::<_, Option<String>>(20)? {
                if criterion.is_none() && criteria.contains(&target) {
                    *criterion = Some(target.clone());
                }
                if holders.contains(target.as_str()) && !scope.contains(&target) {
                    scope.push(target);
                }
            }
        }
        let ids: Vec<_> = blocks
            .iter()
            .map(|(block, _, _)| block.block.id.clone())
            .collect();
        let mut infos: HashMap<_, _> = crate::task_store::capabilities_for(&self.conn, &ids)?
            .into_iter()
            .filter_map(|cap| cap.question.map(|info| (cap.block_id, info)))
            .collect();
        Ok(blocks
            .into_iter()
            .filter_map(|(block, criterion, holders)| {
                let info = infos.remove(&block.block.id)?;
                Some(PositionQuestion {
                    block,
                    info,
                    criterion,
                    holders,
                })
            })
            .collect())
    }
}
