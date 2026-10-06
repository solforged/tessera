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
    include_str!("../migrations/009_action_learning.sql"),
    include_str!("../migrations/010_field_kinds.sql"),
    include_str!("../migrations/011_library.sql"),
    include_str!("../migrations/012_library_views.sql"),
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
    if found < 9 {
        crate::card_store::rebuild(&tx, now_ms())?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    for version in found + 1..=SCHEMA_VERSION {
        tracing::info!(version, "migration applied");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;

    #[test]
    fn action_learning_backfills_literal_cards_without_replacing_sources() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        for migration in &MIGRATIONS[..8] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 8).unwrap();
        let page = ulid::Ulid::from(1u128).to_string();
        let source = ulid::Ulid::from(2u128).to_string();
        let field_text = ulid::Ulid::from(3u128).to_string();
        conn.execute(
            "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
             VALUES (?1, 'page', ?1, 1024, 'Title >> is not a card', 'title >> is not a card', 4, 10, 20)",
            [&page],
        ).unwrap();
        for (id, ordinal, text) in [
            (&source, 1024, "Question>>Answer"),
            (&field_text, 2048, "Author::Example"),
        ] {
            conn.execute(
                "INSERT INTO blocks(id, kind, parent_id, page_id, ordinal, text, revision, created_at, updated_at)
                 VALUES (?1, 'block', ?2, ?2, ?3, ?4, 7, 10, 20)",
                params![id, page, ordinal, text],
            ).unwrap();
        }

        migrate(&mut conn).unwrap();
        let sources = conn
            .prepare(
                "SELECT id, text, revision, created_at, updated_at FROM blocks
             WHERE id IN (?1, ?2, ?3) ORDER BY id",
            )
            .unwrap()
            .query_map(params![page, source, field_text], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            sources,
            vec![
                (page, "Title >> is not a card".into(), 4, 10, 20),
                (source.clone(), "Question>>Answer".into(), 7, 10, 20),
                (field_text, "Author::Example".into(), 7, 10, 20),
            ]
        );
        let card_id: String = conn
            .query_row(
                "SELECT id FROM card_units WHERE source_block_id = ?1",
                [&source],
                |row| row.get(0),
            )
            .unwrap();
        let card = crate::card_store::card(&conn, &card_id).unwrap();
        assert_eq!(
            (card.key.as_str(), card.front.as_str(), card.back.as_str()),
            ("forward", "Question", "Answer")
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM card_units", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );

        let schedule =
            crate::scheduler::schedule(&card.schedule, crate::scheduler::Grade::Good, 1000);
        conn.execute(
            "UPDATE card_units SET schedule = ?1, revision = revision + 1 WHERE id = ?2",
            params![serde_json::to_string(&schedule).unwrap(), card_id],
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let reopened = crate::card_store::card(&conn, &card_id).unwrap();
        assert_eq!(reopened.schedule, schedule);
        assert_eq!(reopened.id, card.id);
        assert_eq!(reopened.revision, card.revision + 1);
        assert_eq!(reopened.definition_revision, card.definition_revision);
    }
}
