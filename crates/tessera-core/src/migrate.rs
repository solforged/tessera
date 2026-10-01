use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::notebook::now_ms;
use crate::storage::derive_memberships;

/// Ordered schema migrations. Version N is the Nth entry; never edit or
/// reorder a released entry, only append.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_notebook.sql"),
    include_str!("../migrations/002_outline.sql"),
    include_str!("../migrations/003_types_changes.sql"),
];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// Bring the schema up to [`SCHEMA_VERSION`] in one transaction.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let found: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    if found == SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for sql in &MIGRATIONS[found as usize..] {
        tx.execute_batch(sql)?;
    }
    if found < 3 {
        // Once on upgrade, derive tags from the authored rows already present.
        // Generated pages are schema backfill, not a new user-authored batch.
        let mut sources = tx
            .prepare("SELECT id, text FROM blocks WHERE deletion_id IS NULL ORDER BY id")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let now = now_ms();
        while let Some((id, text)) = sources.pop() {
            for created in derive_memberships(&tx, &id, &text, now)? {
                let text = tx.query_row(
                    "SELECT text FROM blocks WHERE id = ?1",
                    [&created.id],
                    |row| row.get(0),
                )?;
                sources.push((created.id, text));
            }
        }
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}
