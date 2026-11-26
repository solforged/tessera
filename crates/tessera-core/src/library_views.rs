use rusqlite::Connection;

use crate::library::LibraryView;
use crate::operations::views::{
    LIBRARY_VIEWS_SPEC, SavedViewRow, SavedViewWrite, delete_saved_view, read_saved_views,
    save_saved_view,
};
use crate::storage::validation;
use crate::{Operation, Result, Revision, Workshop};

fn build_view(row: SavedViewRow<crate::library::LibraryQuery>) -> LibraryView {
    LibraryView {
        id: row.id,
        name: row.name,
        query: row.query,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(crate) fn apply_view(
    conn: &Connection,
    operation: &Operation,
    now: i64,
    index: usize,
) -> Result<Revision> {
    match operation {
        Operation::SaveLibraryView {
            id,
            base_revision,
            name,
            query,
        } => save_saved_view(
            conn,
            &LIBRARY_VIEWS_SPEC,
            SavedViewWrite {
                id,
                base_revision: *base_revision,
                name,
                query,
                now,
                index,
            },
            |_, _| Ok(()),
        ),
        Operation::DeleteLibraryView { id, base_revision } => {
            delete_saved_view(conn, &LIBRARY_VIEWS_SPEC, id, *base_revision, index)
        }
        _ => Err(validation("not a library view operation")),
    }
}

impl Workshop {
    pub fn library_views(&self) -> Result<Vec<LibraryView>> {
        read_saved_views(&self.conn, LIBRARY_VIEWS_SPEC.table, build_view)
    }
}
