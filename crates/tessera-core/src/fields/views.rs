use std::collections::{HashMap, HashSet};

use rusqlite::params;

use crate::model::{
    FieldChoiceCandidate, FieldChoiceValue, FieldDetail, FieldInterpretation, FieldOptionUse,
    FieldOwner, FieldOwnerValues, FieldSummary, FieldTemplate, FieldType, FieldValue,
    FieldValueUse, IncomingFieldValue,
};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, validate_id};
use crate::{CountsAs, FieldKind, FieldsView, Reading, Result, Workshop};

use super::{ReadingContext, definitions, definitions_for, page_id, reference};

impl Workshop {
    pub fn fields(&self) -> Result<FieldsView> {
        let mut fields: Vec<FieldSummary> = definitions(&self.conn)?
            .into_iter()
            .map(|definition| FieldSummary {
                definition,
                owners: 0,
                types: Vec::new(),
            })
            .collect();
        let indices: HashMap<_, _> = fields
            .iter()
            .enumerate()
            .map(|(index, field)| (field.definition.id.clone(), index))
            .collect();
        let mut owners = HashSet::new();
        let mut entries = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT l.target_id, e.text, e.parent_id FROM links l
             JOIN blocks e ON e.id = l.source_id
             JOIN blocks o ON o.id = e.parent_id
             WHERE e.deletion_id IS NULL AND o.deletion_id IS NULL
             AND e.rowid NOT IN (SELECT rowid FROM hidden)"
        ))?;
        let mut cursor = entries.query([])?;
        while let Some(row) = cursor.next()? {
            let field: String = row.get(0)?;
            let Some(&index) = indices.get(&field) else {
                continue;
            };
            let text: String = row.get(1)?;
            if reference(&text) == Some(field.as_str())
                && owners.insert((index, row.get::<_, String>(2)?))
            {
                fields[index].owners += 1;
            }
        }
        // Task-backed fields count their canonical readings, not synthetic child entries.
        let task_counts = self.conn.query_row(
            concat!(
                hidden_blocks!(),
                "SELECT COUNT(json_extract(t.state, '$.status')),
                    COUNT(json_extract(t.state, '$.scheduled')),
                    COUNT(json_extract(t.state, '$.deadline')),
                    COUNT(json_extract(t.state, '$.priority')),
                    COUNT(json_extract(t.state, '$.repeater'))
             FROM tasks t JOIN blocks b ON b.id = t.block_id
             WHERE t.active = 1 AND b.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden)"
            ),
            [],
            |row| {
                Ok([
                    row.get::<_, i64>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ])
            },
        )?;
        for field in &mut fields {
            if let Some(index) = ["status", "scheduled", "deadline", "priority", "repeat"]
                .iter()
                .position(|name| *name == field.definition.name)
            {
                field.owners = task_counts[index] as usize;
            }
        }
        if let Some(index) = fields
            .iter()
            .position(|field| field.definition.name == "project")
        {
            for owner in crate::task_query::project_memberships(&self.conn)?.into_keys() {
                if owners.insert((index, owner)) {
                    fields[index].owners += 1;
                }
            }
        }
        let mut templates = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT f.field_id, b.id, b.text FROM type_fields f
             JOIN blocks b ON b.id = f.type_id
             WHERE b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY b.text COLLATE NOCASE, b.id"
        ))?;
        let mut cursor = templates.query([])?;
        while let Some(row) = cursor.next()? {
            if let Some(&index) = indices.get(&row.get::<_, String>(0)?) {
                fields[index].types.push(FieldType {
                    id: row.get(1)?,
                    name: row.get(2)?,
                });
            }
        }
        Ok(FieldsView {
            page_id: page_id(&self.conn)?.ok_or_else(|| not_found("Fields"))?,
            fields,
        })
    }

    /// Relation field values whose whole text references `target`, so the target can read them back, such as
    /// `← qualifies`. Archived definitions, and values, entries or owners that are hidden, are left out.
    pub fn incoming_field_values(&self, target: &str) -> Result<Vec<IncomingFieldValue>> {
        validate_id(target)?;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT fv.field_id, d.text, o.id, o.text, p.id, p.text, v.id, v.text
             FROM links l
             JOIN field_values fv ON fv.value_id = l.source_id
             JOIN fields f ON f.block_id = fv.field_id AND f.kind = 'instance'
             JOIN blocks d ON d.id = fv.field_id
             JOIN blocks v ON v.id = fv.value_id
             JOIN blocks o ON o.id = fv.owner_id
             JOIN blocks p ON p.id = o.page_id
             WHERE l.target_id = ?1
               AND d.deletion_id IS NULL AND d.archived = 0
               AND v.deletion_id IS NULL AND o.deletion_id IS NULL AND p.deletion_id IS NULL
               AND v.rowid NOT IN (SELECT rowid FROM hidden)
               AND o.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY lower(d.text), fv.field_id, o.id, fv.ordinal"
        ))?;
        let rows = statement.query_map([target], |row| {
            Ok((
                IncomingFieldValue {
                    field_id: row.get(0)?,
                    field_name: row.get(1)?,
                    counts_as: None,
                    owner: FieldOwner {
                        id: row.get(2)?,
                        text: row.get(3)?,
                        page_id: row.get(4)?,
                        page_title: row.get(5)?,
                    },
                    value_id: row.get(6)?,
                },
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut incoming = Vec::new();
        let mut counts: HashMap<String, Option<CountsAs>> = HashMap::new();
        for row in rows {
            let (mut value, text) = row?;
            if !counts.contains_key(&value.field_id) {
                let counted = definitions_for(&self.conn, Some(&value.field_id))?
                    .first()
                    .and_then(|definition| definition.counts_as);
                counts.insert(value.field_id.clone(), counted);
            }
            value.counts_as = counts[&value.field_id];
            // A link inside longer text is a mention, not this relation's value.
            if reference(&text) == Some(target)
                && !incoming
                    .iter()
                    .any(|seen: &IncomingFieldValue| seen.value_id == value.value_id)
            {
                incoming.push(value);
            }
        }
        Ok(incoming)
    }

    /// Read a field and its consequences without changing authored blocks.
    pub fn field_detail(
        &self,
        id: &str,
        kind: Option<FieldKind>,
        limit: Option<usize>,
    ) -> Result<FieldDetail> {
        validate_id(id)?;
        let definition = definitions_for(&self.conn, Some(id))?
            .pop()
            .ok_or_else(|| not_found(id))?;
        let task_path = match crate::built_in::task_field(&definition.name).map(|field| field.name)
        {
            Some("status") => Some("$.status"),
            Some("scheduled") => Some("$.scheduled"),
            Some("deadline") => Some("$.deadline"),
            Some("priority") => Some("$.priority"),
            Some("repeat") => Some("$.repeater"),
            _ => None,
        };
        let kind = kind.unwrap_or(definition.kind);
        let mut definition = definition;
        // A built-in field previewed as a relation reads against the Links to that changing its kind files.
        if kind == FieldKind::Instance
            && definition.kind != kind
            && definition.targets.is_empty()
            && let Some(field) = crate::built_in::field_named(&definition.name)
        {
            definition.targets = crate::built_in::targets(&self.conn, field)?;
        }
        let option_uses = if kind == FieldKind::Choice {
            definition
                .options
                .iter()
                .map(|option| FieldOptionUse {
                    option_id: option.id.clone(),
                    uses: 0,
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut detail = FieldDetail {
            field: FieldSummary {
                definition,
                owners: 0,
                types: Vec::new(),
            },
            kind,
            owners_total: 0,
            values_total: 0,
            empty_total: 0,
            problems_total: 0,
            templates: Vec::new(),
            option_uses,
            owners: Vec::new(),
            problems: Vec::new(),
            readable: Vec::new(),
            choice_candidates: Vec::new(),
            interpretations: Vec::new(),
            entries: Vec::new(),
        };
        let option_indices: HashMap<_, _> = detail
            .option_uses
            .iter()
            .enumerate()
            .map(|(index, option)| (option.option_id.clone(), index))
            .collect();
        let mut choice_values = Vec::<(i64, FieldChoiceValue)>::new();
        let mut interpretation_indices = HashMap::<String, usize>::new();
        // Entries, including empty ones, follow the register's whole-reference
        // and hidden-ancestor rules. Values and targets join once, not per row.
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT o.id, o.text, o.page_id, p.text, e.id, e.text, v.id, v.text, v.revision, v.rowid, ",
            block_columns!("t"),
            " FROM links l JOIN blocks e ON e.id = l.source_id
              JOIN blocks o ON o.id = e.parent_id JOIN blocks p ON p.id = o.page_id
              LEFT JOIN blocks v ON v.parent_id = e.id AND v.deletion_id IS NULL AND v.archived = 0
              LEFT JOIN links vl ON vl.source_id = v.id AND vl.occurrence = 0
              LEFT JOIN blocks t ON t.id = vl.target_id AND t.deletion_id IS NULL
              WHERE l.target_id = ?1 AND l.occurrence = 0 AND ?2 IS NULL
              AND e.deletion_id IS NULL AND o.deletion_id IS NULL AND p.deletion_id IS NULL
              AND e.rowid NOT IN (SELECT rowid FROM hidden)
              ORDER BY o.text COLLATE NOCASE, o.id, e.ordinal, e.id, v.ordinal, v.id"
        ))?;
        let mut cursor = statement.query(params![id, task_path])?;
        let mut reader = ReadingContext::new(&self.conn);
        let limit = limit.unwrap_or(12).min(500);
        let mut owner_id = String::new();
        let mut entry_id = String::new();
        let mut entry_empty = false;
        let mut seen_project_owners = HashSet::new();
        let mut seen_project_values = HashMap::<String, HashSet<String>>::new();
        while let Some(row) = cursor.next()? {
            let entry_text: String = row.get(5)?;
            if reference(&entry_text) != Some(id) {
                continue;
            }
            let owner = FieldOwner {
                id: row.get(0)?,
                text: row.get(1)?,
                page_id: row.get(2)?,
                page_title: row.get(3)?,
            };
            let entry: String = row.get(4)?;
            if owner.id != owner_id {
                owner_id.clone_from(&owner.id);
                if detail.field.definition.name == "project" {
                    seen_project_owners.insert(owner.id.clone());
                }
                detail.owners_total += 1;
                if detail.owners.len() < limit {
                    detail.owners.push(FieldOwnerValues {
                        owner: owner.clone(),
                        entry_id: entry.clone(),
                        values: Vec::new(),
                    });
                }
            }
            if entry != entry_id {
                detail.entries.push(entry.clone());
                detail.empty_total += usize::from(entry_empty);
                entry_id.clone_from(&entry);
                entry_empty = true;
            }
            let Some(text) = row
                .get::<_, Option<String>>(7)?
                .filter(|text| !text.trim().is_empty())
            else {
                continue;
            };
            entry_empty = false;
            detail.values_total += 1;
            let target = if matches!(row.get_ref(10)?, rusqlite::types::ValueRef::Null) {
                None
            } else {
                Some(block_at(row, 10)?)
            };
            let reading = reader.read(kind, &detail.field.definition, &text, target.as_ref())?;
            let index = *interpretation_indices
                .entry(text.clone())
                .or_insert_with(|| {
                    let index = detail.interpretations.len();
                    detail.interpretations.push(FieldInterpretation {
                        text: text.clone(),
                        reading: reading.clone(),
                        values: Vec::new(),
                    });
                    index
                });
            detail.interpretations[index].values.push(FieldChoiceValue {
                id: row.get(6)?,
                text: text.clone(),
                revision: row.get(8)?,
                page_id: owner.page_id.clone(),
            });
            if kind == FieldKind::Choice && matches!(reading, Reading::Problem { .. }) {
                choice_values.push((
                    row.get(9)?,
                    FieldChoiceValue {
                        id: row.get(6)?,
                        text: text.clone(),
                        revision: row.get(8)?,
                        page_id: owner.page_id.clone(),
                    },
                ));
            }
            if let Reading::Value {
                target: Some(target),
                ..
            } = &reading
                && let Some(&index) = option_indices.get(target)
            {
                detail.option_uses[index].uses += 1;
            }
            if detail.field.definition.name == "project"
                && let Reading::Value {
                    target: Some(target),
                    ..
                } = &reading
            {
                if let Some(values) = seen_project_values.get_mut(&owner.id) {
                    if !values.contains(target) {
                        values.insert(target.clone());
                    }
                } else {
                    seen_project_values.insert(owner.id.clone(), HashSet::from([target.clone()]));
                }
            }
            let value = FieldValue {
                id: row.get(6)?,
                text,
                reading,
            };
            if let Some(visible) = detail
                .owners
                .last_mut()
                .filter(|item| item.owner.id == owner.id)
            {
                visible.values.push(value.clone());
            }
            let destination = if matches!(value.reading, Reading::Problem { .. }) {
                detail.problems_total += 1;
                (detail.problems.len() < 100).then_some(&mut detail.problems)
            } else {
                (detail.readable.len() < 12).then_some(&mut detail.readable)
            };
            if let Some(destination) = destination {
                destination.push(FieldValueUse {
                    owner,
                    entry_id: entry,
                    value,
                });
            }
        }
        // Row identity preserves insertion order even within one timestamp/batch.
        // Samples stay in owner order; conversion names use first appearance.
        choice_values.sort_unstable_by_key(|(order, _)| *order);
        if !choice_values.is_empty() {
            let mut candidate_indices = HashMap::<String, usize>::new();
            let option_names: HashMap<_, _> = detail
                .field
                .definition
                .options
                .iter()
                .rev()
                .map(|option| (option.text.trim().to_lowercase(), &option.id))
                .collect();
            for (_, value) in choice_values {
                let name = value.text.trim();
                let key = name.to_lowercase();
                let index = match candidate_indices.entry(key) {
                    std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let index = detail.choice_candidates.len();
                        detail.choice_candidates.push(FieldChoiceCandidate {
                            text: name.to_owned(),
                            option_id: option_names.get(entry.key()).map(|id| (*id).clone()),
                            values: Vec::new(),
                        });
                        entry.insert(index);
                        index
                    }
                };
                detail.choice_candidates[index].values.push(value);
            }
        }
        detail.empty_total += usize::from(entry_empty);
        if detail.field.definition.name == "project" {
            for (owner, projects) in crate::task_query::project_memberships(&self.conn)? {
                let authored = seen_project_values.get(&owner);
                for project in projects {
                    if !authored.is_some_and(|values| values.contains(&project)) {
                        detail.values_total += 1;
                    }
                }
                if seen_project_owners.insert(owner) {
                    detail.owners_total += 1;
                }
            }
        }
        if let Some(path) = task_path {
            detail.owners_total = self.conn.query_row(
                concat!(
                    hidden_blocks!(),
                    "SELECT COUNT(json_extract(t.state, ?1))
                     FROM tasks t JOIN blocks b ON b.id = t.block_id
                     WHERE t.active = 1 AND b.deletion_id IS NULL
                     AND b.rowid NOT IN (SELECT rowid FROM hidden)"
                ),
                [path],
                |row| row.get::<_, i64>(0),
            )? as usize;
            detail.values_total = detail.owners_total;
        }
        detail.field.owners = detail.owners_total;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT t.id, t.text, f.position + 1, COUNT(DISTINCT CASE WHEN p.id IS NOT NULL THEN b.id END)
             FROM type_fields f JOIN blocks t ON t.id = f.type_id
             LEFT JOIN memberships m ON m.type_id = t.id
             LEFT JOIN blocks b ON b.id = m.block_id AND b.deletion_id IS NULL
                 AND b.rowid NOT IN (SELECT rowid FROM hidden)
             LEFT JOIN blocks p ON p.id = b.page_id AND p.deletion_id IS NULL
             WHERE f.field_id = ?1 AND t.deletion_id IS NULL
                 AND t.rowid NOT IN (SELECT rowid FROM hidden)
             GROUP BY t.id ORDER BY t.text COLLATE NOCASE, t.id"
        ))?;
        let mut cursor = statement.query([id])?;
        while let Some(row) = cursor.next()? {
            detail.field.types.push(FieldType {
                id: row.get(0)?,
                name: row.get(1)?,
            });
            detail.templates.push(FieldTemplate {
                type_id: row.get(0)?,
                name: row.get(1)?,
                position: row.get::<_, i64>(2)? as usize,
                members: row.get::<_, i64>(3)? as usize,
            });
        }
        Ok(detail)
    }
}
