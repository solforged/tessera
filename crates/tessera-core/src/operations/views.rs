//! Saved queries and workshop settings.

use rusqlite::{OptionalExtension, params};

use super::Engine;
use crate::storage::{not_found, validate_id, validation};
use crate::{Error, Operation, Result, SettingRevision};

impl Engine<'_, '_> {
    pub(super) fn apply_save_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SaveView {
                id,
                base_revision,
                name,
                query,
            } => {
                validate_id(id)?;
                let found = self.view_revision(id)?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        what: "view",
                        id: id.clone(),
                        expected: base_revision.unwrap_or(0),
                        found,
                    });
                }
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 120 {
                    return Err(validation("view name must contain 1 to 120 characters"));
                }
                crate::query::validate_saved_query(self.tx, query)?;
                let revision = found.unwrap_or(0) + 1;
                self.tx.execute(
                    "INSERT INTO views(id, name, query, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                     ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query, revision = excluded.revision, updated_at = excluded.updated_at",
                    params![id, name, serde_json::to_string(query).expect("query serializes"), revision, self.now])?;
                self.touch(id, revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_delete_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::DeleteView { id, base_revision } => {
                validate_id(id)?;
                let found = self.view_revision(id)?.ok_or_else(|| not_found(id))?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        what: "view",
                        id: id.clone(),
                        expected: *base_revision,
                        found: Some(found),
                    });
                }
                self.tx.execute("DELETE FROM views WHERE id = ?1", [id])?;
                self.touch(id, found + 1);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_setting(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetSetting {
                key,
                base_revision,
                value,
            } => {
                crate::settings::validate_setting(key, value)?;
                let found = self
                    .tx
                    .prepare_cached("SELECT revision FROM settings WHERE key = ?1")?
                    .query_row([key], |row| row.get::<_, i64>(0))
                    .optional()?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        what: "setting",
                        id: key.clone(),
                        expected: base_revision.unwrap_or(0),
                        found,
                    });
                }
                let revision = found.unwrap_or(0) + 1;
                self.tx.execute(
                    "INSERT INTO settings(key, value, revision, updated_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at",
                    params![key, value, revision, self.now],
                )?;
                if let Some(setting) = self.settings.iter_mut().find(|setting| setting.key == *key)
                {
                    setting.revision = revision;
                } else {
                    self.settings.push(SettingRevision {
                        key: key.clone(),
                        revision,
                    });
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    fn view_revision(&self, id: &str) -> Result<Option<i64>> {
        Ok(self
            .tx
            .prepare_cached("SELECT revision FROM views WHERE id = ?1")?
            .query_row([id], |row| row.get(0))
            .optional()?)
    }
}
