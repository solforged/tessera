use rusqlite::{Connection, TransactionBehavior};

use crate::error::{Error, Result};
use crate::notebook::now_ms;
use crate::storage::derive_memberships;

/// Ordered schema migrations. Version N is the Nth entry; never edit or
/// reorder a released entry, only append.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_notebook.sql"),
    include_str!("../migrations/002_outline.sql"),
    include_str!("../migrations/003_types_changes.sql"),
    include_str!("../migrations/004_archived_discovery.sql"),
    include_str!("../migrations/005_membership_titles.sql"),
    include_str!("../migrations/006_fields_views.sql"),
    include_str!("../migrations/007_manual_memberships.sql"),
    include_str!("../migrations/008_settings.sql"),
];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// Bring the schema up to [`SCHEMA_VERSION`] in one transaction.
/// Acquire the writer slot before reading the version so concurrent opens
/// decide against the schema committed by the preceding upgrader.
pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let found: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    if found == SCHEMA_VERSION {
        crate::fields::ensure_page(&tx)?;
        tx.commit()?;
        return Ok(());
    }
    for sql in &MIGRATIONS[found as usize..] {
        tx.execute_batch(sql)?;
    }
    if found < 7 {
        // Rebuild raw mentions, including tombstones. Only the original tag
        // migration creates missing pages; later rebuilds must not resurrect them.
        let mut sources = tx
            .prepare("SELECT id, text, deletion_id IS NOT NULL FROM blocks ORDER BY id")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let now = now_ms();
        while let Some((id, text, deleted)) = sources.pop() {
            for created in derive_memberships(&tx, &id, &text, now, found < 3 && !deleted)? {
                let text = tx.query_row(
                    "SELECT text FROM blocks WHERE id = ?1",
                    [&created.id],
                    |row| row.get(0),
                )?;
                sources.push((created.id, text, false));
            }
        }
    }
    crate::fields::ensure_page(&tx)?;
    crate::fields::rebuild(&tx)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}
