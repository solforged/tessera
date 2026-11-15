//! Field definitions, type fields and subject criteria.

use std::collections::HashSet;

use rusqlite::{OptionalExtension, params};

use super::Engine;
use crate::storage::validation;
use crate::{BlockKind, CountsAs, Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_set_field_kind(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetFieldKind {
                id,
                base_revision,
                kind,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(field) = crate::built_in::task_field(&current.block.text)
                    && field.kind != *kind
                {
                    return Err(validation("Built-in task field formats cannot change."));
                }
                self.tx.execute("INSERT INTO fields(block_id, kind) VALUES (?1, ?2) ON CONFLICT(block_id) DO UPDATE SET kind = excluded.kind",
                    params![id, kind.as_str()])?;
                // A built-in field that becomes a relation links to its built-in types at once, as opening would.
                if *kind == crate::FieldKind::Instance
                    && let Some(field) = crate::built_in::field_named(&current.block.text)
                    && crate::fields::targets(self.tx, id)?.is_empty()
                {
                    let targets = crate::built_in::targets(self.tx, field)?;
                    crate::fields::file_targets(self.tx, id, &targets)?;
                }
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_field_hide(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetFieldHide {
                id,
                base_revision,
                hide,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                self.tx.execute("INSERT INTO fields(block_id, kind, hide) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET hide = excluded.hide",
                    params![id, hide.as_str()])?;
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_field_role(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetFieldRole {
                id,
                base_revision,
                role,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                self.tx.execute("INSERT INTO fields(block_id, kind, role) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET role = excluded.role",
                    params![id, role.as_str()])?;
                if let Some(chosen) = self.new_definitions.get_mut(id) {
                    *chosen = true;
                }
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_field_counts_as(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetFieldCountsAs {
                id,
                base_revision,
                counts_as,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(field) = crate::built_in::field_named(&current.block.text) {
                    return Err(validation(match field.counts_as {
                        Some(counts) => format!(
                            "{} is built in and counts as {}.",
                            field.name,
                            counts.as_str()
                        ),
                        None => format!("{} is built in and counts as nothing.", field.name),
                    }));
                }
                let kind: Option<String> = self
                    .tx
                    .query_row("SELECT kind FROM fields WHERE block_id = ?1", [id], |row| {
                        row.get(0)
                    })
                    .optional()?;
                if counts_as.is_some()
                    && !matches!(kind.as_deref().unwrap_or("text"), "text" | "instance")
                {
                    return Err(validation(
                        "Only text and relation fields count as a creator, contributor or originator.",
                    ));
                }
                self.tx.execute("INSERT INTO fields(block_id, kind, counts_as) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET counts_as = excluded.counts_as",
                    params![id, counts_as.map(CountsAs::as_str)])?;
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_field_targets(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetFieldTargets {
                id,
                base_revision,
                targets,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                let instance: bool = self.tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM fields WHERE block_id = ?1 AND kind = 'instance')",
                    [id],
                    |row| row.get(0),
                )?;
                if !instance {
                    return Err(validation("targets require an Instance field"));
                }
                let mut unique = HashSet::with_capacity(targets.len());
                for target in targets {
                    if !unique.insert(target) {
                        return Err(validation("duplicate field target"));
                    }
                }
                for target in targets
                    .iter()
                    .filter(|target| *target != crate::fields::SOURCE_TARGET)
                {
                    let block = self.live(target)?;
                    if block.block.kind != BlockKind::Page || block.block.archived {
                        return Err(validation("target tag must be a live titled atom"));
                    }
                }
                crate::fields::file_targets(self.tx, id, targets)?;
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_type_fields(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetTypeFields {
                type_id,
                base_revision,
                fields,
            } => {
                let current = self.checked(type_id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("tag must be a titled atom"));
                }
                let mut unique = HashSet::new();
                for field in fields {
                    if !crate::fields::is_definition(self.tx, field)? {
                        return Err(validation(format!(
                            "not a readable field definition: {field}"
                        )));
                    }
                    if !unique.insert(field) {
                        return Err(validation("duplicate field in tag template"));
                    }
                }
                if let Some(problem) =
                    crate::built_in::removal_problem(self.tx, type_id, &current.block.text, fields)?
                {
                    return Err(validation(problem));
                }
                self.tx
                    .execute("DELETE FROM type_fields WHERE type_id = ?1", [type_id])?;
                let mut insert = self.tx.prepare_cached(
                    "INSERT INTO type_fields(type_id, field_id, position) VALUES (?1, ?2, ?3)",
                )?;
                for (position, field) in fields.iter().enumerate() {
                    insert.execute(params![type_id, field, position as i64])?;
                }
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_type_presentation(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetTypePresentation {
                type_id,
                base_revision,
                plural,
                icon,
            } => {
                let current = self.checked(type_id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("tag must be a titled atom"));
                }
                let plural = plural.as_deref().map(str::trim);
                if plural.is_some_and(str::is_empty) {
                    return Err(validation("plural must not be empty"));
                }
                if icon.as_ref().is_some_and(|icon| {
                    icon.is_empty()
                        || icon.len() > 64
                        || !icon
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                }) {
                    return Err(validation("icon must be a short glyph token"));
                }
                self.tx.execute(
                    "INSERT INTO type_presentation(type_id, plural, icon) VALUES (?1, ?2, ?3)
                     ON CONFLICT(type_id) DO UPDATE SET plural = excluded.plural, icon = excluded.icon",
                    params![type_id, plural, icon],
                )?;
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_subject_criteria(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetSubjectCriteria {
                subject_id,
                base_revision,
                fields,
            } => {
                let current = self.checked(subject_id, *base_revision, index, false)?;
                let mut unique = HashSet::with_capacity(fields.len());
                for field in fields {
                    crate::fields::require_definition(self.tx, field)?;
                    if !unique.insert(field) {
                        return Err(validation("duplicate field in subject criteria"));
                    }
                }
                self.tx.execute(
                    "DELETE FROM subject_criteria WHERE subject_id = ?1",
                    [subject_id],
                )?;
                let mut insert = self.tx.prepare_cached(
                    "INSERT INTO subject_criteria(subject_id, field_id, position) VALUES (?1, ?2, ?3)",
                )?;
                for (position, field) in fields.iter().enumerate() {
                    insert.execute(params![subject_id, field, position as i64])?;
                }
                self.bump(&current, true)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
