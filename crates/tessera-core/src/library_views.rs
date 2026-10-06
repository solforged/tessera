use rusqlite::{Connection, OptionalExtension, params};

use crate::library::LibraryView;
use crate::library_store::json_at;
use crate::storage::{not_found, validate_id, validation};
use crate::{Error, Notebook, Operation, Result, Revision};

fn stored_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryView> {
    Ok(LibraryView {
        id: row.get(0)?,
        name: row.get(1)?,
        query: json_at(row, 2)?,
        revision: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub(crate) fn apply_view(
    conn: &Connection,
    operation: &Operation,
    now: i64,
    index: usize,
) -> Result<Revision> {
    let (id, expected) = match operation {
        Operation::SaveLibraryView {
            id, base_revision, ..
        } => (id, *base_revision),
        Operation::DeleteLibraryView { id, base_revision } => (id, Some(*base_revision)),
        _ => return Err(validation("not a library view operation")),
    };
    validate_id(id)?;
    let found = conn
        .prepare_cached("SELECT revision FROM library_views WHERE id = ?1")?
        .query_row([id], |row| row.get::<_, i64>(0))
        .optional()?;
    if matches!(operation, Operation::DeleteLibraryView { .. }) && found.is_none() {
        return Err(not_found(id));
    }
    if found != expected {
        return Err(Error::Conflict {
            op_index: index,
            id: id.clone(),
            expected: expected.unwrap_or(0),
            found,
        });
    }
    let revision = found
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| validation("library view revision overflow"))?;
    match operation {
        Operation::SaveLibraryView { name, query, .. } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 120 {
                return Err(validation(
                    "library view name must contain 1 to 120 characters",
                ));
            }
            conn.execute(
                "INSERT INTO library_views(id, name, query, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query,
                 revision = excluded.revision, updated_at = excluded.updated_at",
                params![
                    id,
                    name,
                    serde_json::to_string(query).expect("library query serializes"),
                    revision,
                    now
                ],
            )?;
        }
        Operation::DeleteLibraryView { .. } => {
            conn.execute("DELETE FROM library_views WHERE id = ?1", [id])?;
        }
        _ => unreachable!("library view operation checked"),
    }
    Ok(Revision {
        id: id.clone(),
        revision,
    })
}

impl Notebook {
    pub fn library_views(&self) -> Result<Vec<LibraryView>> {
        let mut views = self
            .conn
            .prepare_cached(
                "SELECT id, name, query, revision, created_at, updated_at FROM library_views",
            )?
            .query_map([], stored_view)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        views.sort_by_cached_key(|view| (view.name.to_lowercase(), view.id.clone()));
        Ok(views)
    }
}
