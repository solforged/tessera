//! Saved queries, decks and workshop settings.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use super::Engine;
use crate::storage::{not_found, not_found_as, validate_id, validation};
use crate::{Error, Operation, Result, Revision, SettingRevision};

pub(crate) struct SavedViewSpec {
    pub table: &'static str,
    pub what: &'static str,
    pub delete_missing_conflicts: bool,
}

pub(crate) const VIEWS_SPEC: SavedViewSpec = SavedViewSpec {
    table: "views",
    what: "view",
    delete_missing_conflicts: false,
};

pub(crate) const DECKS_SPEC: SavedViewSpec = SavedViewSpec {
    table: "decks",
    what: "deck",
    delete_missing_conflicts: true,
};

pub(crate) const TASK_VIEWS_SPEC: SavedViewSpec = SavedViewSpec {
    table: "task_views",
    what: "task view",
    delete_missing_conflicts: false,
};

pub(crate) const LIBRARY_VIEWS_SPEC: SavedViewSpec = SavedViewSpec {
    table: "library_views",
    what: "library view",
    delete_missing_conflicts: false,
};

pub(crate) struct SavedViewRow<Q> {
    pub id: String,
    pub name: String,
    pub query: Q,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn saved_view_at<Q: DeserializeOwned>(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SavedViewRow<Q>> {
    let json: String = row.get(2)?;
    let query = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(SavedViewRow {
        id: row.get(0)?,
        name: row.get(1)?,
        query,
        revision: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub(crate) fn read_saved_views<V, Q, F>(
    conn: &Connection,
    table: &'static str,
    build: F,
) -> Result<Vec<V>>
where
    Q: DeserializeOwned,
    F: Fn(SavedViewRow<Q>) -> V,
{
    let sql = format!("SELECT id, name, query, revision, created_at, updated_at FROM {table}");
    let mut rows = conn
        .prepare_cached(&sql)?
        .query_map([], saved_view_at::<Q>)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.sort_by_cached_key(|row| (row.name.to_lowercase(), row.id.clone()));
    Ok(rows.into_iter().map(build).collect())
}

pub(crate) fn read_saved_view<V, Q, F>(
    conn: &Connection,
    table: &'static str,
    not_found_what: Option<&'static str>,
    id: &str,
    build: F,
) -> Result<V>
where
    Q: DeserializeOwned,
    F: FnOnce(SavedViewRow<Q>) -> V,
{
    validate_id(id)?;
    let sql = format!(
        "SELECT id, name, query, revision, created_at, updated_at FROM {table} WHERE id = ?1"
    );
    conn.prepare_cached(&sql)?
        .query_row([id], saved_view_at::<Q>)
        .optional()?
        .map(build)
        .ok_or_else(|| match not_found_what {
            Some(what) => not_found_as(what, id),
            None => not_found(id),
        })
}

pub(crate) struct SavedViewWrite<'a, Q> {
    pub id: &'a str,
    pub base_revision: Option<i64>,
    pub name: &'a str,
    pub query: &'a Q,
    pub now: i64,
    pub index: usize,
}

pub(crate) fn save_saved_view<Q: Serialize>(
    conn: &Connection,
    spec: &SavedViewSpec,
    write: SavedViewWrite<'_, Q>,
    validate: impl FnOnce(&Connection, &Q) -> Result<()>,
) -> Result<Revision> {
    let SavedViewWrite {
        id,
        base_revision,
        name,
        query,
        now,
        index,
    } = write;
    validate_id(id)?;
    let found = saved_view_revision(conn, spec.table, id)?;
    if found != base_revision {
        return Err(Error::Conflict {
            op_index: index,
            what: spec.what,
            id: id.to_owned(),
            expected: base_revision.unwrap_or(0),
            found,
        });
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(validation(format!(
            "{} name must contain 1 to 120 characters",
            spec.what
        )));
    }
    validate(conn, query)?;
    let revision = found
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| validation(format!("{} revision overflow", spec.what)))?;
    let sql = format!(
        "INSERT INTO {}(id, name, query, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query,
             revision = excluded.revision, updated_at = excluded.updated_at",
        spec.table
    );
    conn.execute(
        &sql,
        params![
            id,
            name,
            serde_json::to_string(query).expect("saved query serializes"),
            revision,
            now
        ],
    )?;
    Ok(Revision {
        id: id.to_owned(),
        revision,
    })
}

pub(crate) fn delete_saved_view(
    conn: &Connection,
    spec: &SavedViewSpec,
    id: &str,
    base_revision: i64,
    index: usize,
) -> Result<Revision> {
    validate_id(id)?;
    let found = saved_view_revision(conn, spec.table, id)?;
    if !spec.delete_missing_conflicts && found.is_none() {
        return Err(not_found(id));
    }
    if found != Some(base_revision) {
        return Err(Error::Conflict {
            op_index: index,
            what: spec.what,
            id: id.to_owned(),
            expected: base_revision,
            found,
        });
    }
    let revision = base_revision
        .checked_add(1)
        .ok_or_else(|| validation(format!("{} revision overflow", spec.what)))?;
    let sql = format!("DELETE FROM {} WHERE id = ?1", spec.table);
    conn.execute(&sql, [id])?;
    Ok(Revision {
        id: id.to_owned(),
        revision,
    })
}

fn saved_view_revision(conn: &Connection, table: &'static str, id: &str) -> Result<Option<i64>> {
    let sql = format!("SELECT revision FROM {table} WHERE id = ?1");
    Ok(conn
        .prepare_cached(&sql)?
        .query_row([id], |row| row.get(0))
        .optional()?)
}

impl Engine<'_, '_> {
    pub(super) fn apply_save_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SaveView {
                id,
                base_revision,
                name,
                query,
            } => {
                let revision = save_saved_view(
                    self.tx,
                    &VIEWS_SPEC,
                    SavedViewWrite {
                        id,
                        base_revision: *base_revision,
                        name,
                        query,
                        now: self.now,
                        index,
                    },
                    crate::query::validate_saved_query,
                )?;
                self.views.insert(revision.id.clone(), revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_delete_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::DeleteView { id, base_revision } => {
                let revision = delete_saved_view(self.tx, &VIEWS_SPEC, id, *base_revision, index)?;
                self.views.insert(revision.id.clone(), revision);
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
}
