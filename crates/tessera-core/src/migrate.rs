use rusqlite::Connection;

use crate::error::{Error, Result};

/// Ordered schema migrations. Version N is the Nth entry; never edit or
/// reorder a released entry, only append.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/001_notebook.sql")];

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
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}
