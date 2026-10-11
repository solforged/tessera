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
    include_str!("../migrations/013_citation_triage.sql"),
    include_str!("../migrations/014_citation_color.sql"),
    include_str!("../migrations/015_resurfacing.sql"),
    include_str!("../migrations/016_positions.sql"),
    include_str!("../migrations/017_questions.sql"),
    include_str!("../migrations/018_reading_position.sql"),
    include_str!("../migrations/019_agent_changes.sql"),
    include_str!("../migrations/020_fsrs_child_cards.sql"),
    include_str!("../migrations/021_provisional_pages.sql"),
    include_str!("../migrations/022_change_identity.sql"),
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
        let create = Some(crate::storage::TypeCreation {
            change_id: None,
            now: now_ms(),
        });
        while let Some((id, text, deleted)) = sources.pop() {
            let create = create.filter(|_| found < 3 && !deleted);
            for created in derive_memberships(&tx, &id, &text, create)? {
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
    if found < 20 {
        crate::review_store::backfill_fsrs(&tx)?;
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
    fn fsrs_replays_history_and_resets_without_rewriting_evidence() {
        use crate::scheduler::{Grade, new_card, schedule};
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        for migration in &MIGRATIONS[..19] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 19).unwrap();
        let id = |n: u128| ulid::Ulid::from(n).to_string();
        conn.execute(
            "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
             VALUES (?1, 'page', ?1, 1024, 'Cards', 'cards', 1, 0, 0)", [id(1)],
        ).unwrap();
        let legacy = r#"{"ease_factor":2.5,"interval_days":6,"repetitions":2,"lapses":0,"due_at":999,"last_reviewed_at":123}"#;
        for n in 2..=4 {
            conn.execute(
                "INSERT INTO blocks(id, kind, parent_id, page_id, ordinal, text, revision, created_at, updated_at)
                 VALUES (?1, 'block', ?2, ?2, ?3, 'front>>back', 1, 0, 0)",
                params![id(n), id(1), n as i64],
            ).unwrap();
            conn.execute(
                "INSERT INTO card_units VALUES (?1, ?2, 'forward', 'forward', 1, 1, 'front', 'back', 7, ?3, 0, 0)",
                params![id(n + 10), id(n), legacy],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO changes(seq, actor, created_at, operations_hash, operations, committed)
             VALUES (1, 'person', 0, '', '[]', '{}')",
            [],
        )
        .unwrap();
        let day = 86_400_000;
        let histories = [
            (
                12,
                vec![
                    (Some(Grade::Good), day),
                    (Some(Grade::Again), 9 * day),
                    (Some(Grade::Easy), 9 * day),
                ],
            ),
            (
                13,
                vec![
                    (Some(Grade::Good), day),
                    (None, 2 * day),
                    (Some(Grade::Hard), 2 * day),
                ],
            ),
        ];
        let mut expected = Vec::new();
        let mut event_id = 100;
        for (card_id, history) in &histories {
            let mut state = new_card(0);
            for &(grade, at) in history {
                let grade_json = grade.map(|grade| {
                    serde_json::to_value(grade)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned()
                });
                conn.execute(
                    "INSERT INTO review_events VALUES (?1, ?2, NULL, ?3, ?4, 'front', 'back', 1, 1, ?5, ?5, ?6, 1)",
                    params![id(event_id), id(*card_id), if grade.is_some() { "grade" } else { "reset" }, grade_json, legacy, at],
                ).unwrap();
                // Deliberately reverse IDs; equal timestamps must sort by rowid.
                event_id -= 1;
                state = grade.map_or_else(|| new_card(at), |grade| schedule(&state, grade, at));
            }
            expected.push((*card_id, state));
        }
        let evidence = |conn: &Connection| {
            conn.prepare(
                "SELECT rowid, id, before_state, after_state FROM review_events ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        let before = evidence(&conn);
        migrate(&mut conn).unwrap();
        assert_eq!(evidence(&conn), before);
        for (card_id, expected) in expected {
            let card = crate::card_store::card(&conn, &id(card_id)).unwrap();
            assert_eq!(card.schedule, expected);
            assert_eq!(card.revision, 7);
            assert!(card.schedule.stability.is_some());
        }
        assert_eq!(
            crate::card_store::card(&conn, &id(14)).unwrap().schedule,
            new_card(0)
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM review_events WHERE scheduler_version = 'sm-2'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            6
        );
        assert!(
            conn.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query([])
                .unwrap()
                .next()
                .unwrap()
                .is_none()
        );
        let schedule_before: String = conn
            .query_row(
                "SELECT schedule FROM card_units WHERE id = ?1",
                [id(12)],
                |r| r.get(0),
            )
            .unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT schedule FROM card_units WHERE id = ?1",
                [id(12)],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            schedule_before
        );
    }

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
