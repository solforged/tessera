use rusqlite::{Connection, TransactionBehavior};

use crate::error::{Error, Result};
use crate::notebook::now_ms;
use crate::storage::derive_memberships;

const UNICODE_TITLE_KEYS: &str = include_str!("../migrations/047_unicode_title_keys.sql");

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
    include_str!("../migrations/023_sync.sql"),
    include_str!("../migrations/024_sync_library.sql"),
    include_str!("../migrations/025_reference_indexes.sql"),
    include_str!("../migrations/026_retired_replicas.sql"),
    include_str!("../migrations/027_paired_devices.sql"),
    include_str!("../migrations/028_editor_events.sql"),
    include_str!("../migrations/029_subject_criteria.sql"),
    include_str!("../migrations/030_card_templates.sql"),
    include_str!("../migrations/031_type_presentation.sql"),
    include_str!("../migrations/032_card_hold.sql"),
    include_str!("../migrations/033_field_targets.sql"),
    include_str!("../migrations/034_descriptor_cards.sql"),
    include_str!("../migrations/035_review_undos.sql"),
    include_str!("../migrations/036_quotes.sql"),
    include_str!("../migrations/037_field_hide.sql"),
    include_str!("../migrations/038_reference_search.sql"),
    include_str!("../migrations/039_instance_filters.sql"),
    include_str!("../migrations/040_relations.sql"),
    include_str!("../migrations/041_spreads.sql"),
    include_str!("../migrations/042_note_revisits.sql"),
    include_str!("../migrations/043_field_roles.sql"),
    include_str!("../migrations/044_field_spans.sql"),
    include_str!("../migrations/045_field_counts_as.sql"),
    include_str!("../migrations/046_field_links_sources.sql"),
    UNICODE_TITLE_KEYS,
    include_str!("../migrations/048_images.sql"),
    include_str!("../migrations/049_occlusions.sql"),
    include_str!("../migrations/050_strict_tables.sql"),
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
    tx.create_scalar_function(
        "tessera_title_key",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| Ok(crate::storage::title_key(context.get_raw(0).as_str()?)),
    )?;
    for sql in &MIGRATIONS[found as usize..] {
        tx.execute_batch(sql)?;
    }
    if found < 39 {
        crate::query::migrate_instance_filters(&tx)?;
    }
    if found < 35 {
        crate::review_store::backfill_event_order(&tx)?;
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
    if found < 36 {
        let mut statement = tx.prepare("SELECT id, text FROM blocks WHERE text LIKE '%((%))%'")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let text: String = row.get(1)?;
            if crate::storage::quote_target(&text).is_some() {
                crate::storage::derive_links(&tx, &id, &text)?;
            }
        }
    }
    crate::fields::ensure_page(&tx)?;
    crate::fields::rebuild(&tx)?;
    if found < 20 {
        crate::review_store::backfill_fsrs(&tx)?;
    }
    if found < 34 {
        crate::card_store::rebuild(&tx, now_ms())?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    conn.remove_function("tessera_title_key", 1)?;
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
        let mut operations = Vec::new();
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
                operations.push(match grade {
                    Some(grade) => crate::Operation::GradeCard {
                        id: id(*card_id),
                        base_revision: 1,
                        definition_revision: 1,
                        event_id: id(event_id),
                        session_id: None,
                        grade,
                        reset: false,
                        shown_front: "front".into(),
                        shown_back: "back".into(),
                        reviewed_at: at,
                    },
                    None => crate::Operation::ResetCard {
                        id: id(*card_id),
                        base_revision: 1,
                        event_id: id(event_id),
                        session_id: None,
                        reviewed_at: at,
                    },
                });
                // Deliberately reverse IDs; equal timestamps must follow commands.
                event_id -= 1;
                state = grade.map_or_else(|| new_card(at), |grade| schedule(&state, grade, at));
            }
            expected.push((*card_id, state));
        }
        conn.execute(
            "UPDATE changes SET operations = ?1 WHERE seq = 1",
            [serde_json::to_string(&operations).unwrap()],
        )
        .unwrap();
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
        let tx = conn.transaction().unwrap();
        crate::review_store::apply(
            &tx,
            &crate::Operation::UndoGrade {
                id: id(13),
                base_revision: 7,
                review_id: id(95),
                event_id: id(1000),
                session_revision: None,
                undone_at: 2 * day,
            },
            2 * day,
            1,
            0,
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            crate::card_store::card(&conn, &id(13)).unwrap().schedule,
            new_card(2 * day)
        );
        crate::review_store::backfill_fsrs(&conn).unwrap();
        assert_eq!(
            crate::card_store::card(&conn, &id(13)).unwrap().schedule,
            new_card(2 * day)
        );
        assert_eq!(evidence(&conn), before);
    }

    #[test]
    fn strict_rebuild_keeps_library_rows_rowids_search_and_the_editor_cursor() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn.create_scalar_function(
            "tessera_title_key",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            |context| Ok(crate::storage::title_key(context.get_raw(0).as_str()?)),
        )
        .unwrap();
        for migration in &MIGRATIONS[..49] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 49).unwrap();
        let id = |n: u128| ulid::Ulid::from(n).to_string();
        conn.execute(
            "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
             VALUES (?1, 'page', ?1, 1024, 'Book', 'book', 1, 0, 0)",
            [id(1)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO changes(seq, actor, created_at, operations_hash, operations, committed)
             VALUES (1, 'person', 0, '', '[]', '{}')",
            [],
        )
        .unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO snapshots VALUES ('{snap}', 'abc', 'epub', 'application/epub+zip', '{{}}', '[]', 2, 20, 5);
             INSERT INTO passages(rowid, id, snapshot_id, ordinal, kind, level, text, locator, anchor, resource, marks, start)
                 VALUES (7, '{p1}', '{snap}', 0, 'paragraph', NULL, 'First evidence', 'c#1', NULL, NULL, '[]', 0),
                        (9, '{p2}', '{snap}', 1, 'paragraph', 2, 'Second evidence', 'c#2', NULL, NULL, '[]', 15);
             INSERT INTO snapshot_resources VALUES ('{snap}', 'cover.jpg', 'def', 'image/jpeg');
             INSERT INTO sources VALUES ('{page}', 1, 'epub', 'reading', NULL, 'book', 'Book2026', 1, 2, NULL);
             INSERT INTO source_snapshots VALUES ('{page}', '{snap}', 3, 1);
             INSERT INTO reading_positions(snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq)
                 VALUES ('{snap}', 1, 4, 10, 'dev', 2);
             INSERT INTO citations(id, block_id, active, snapshot_id, start_passage, start_offset, end_passage, end_offset, created_seq, triage, color, resurface_muted_at)
                 VALUES ('{cite}', '{page}', 1, '{snap}', '{p1}', 0, '{p2}', 6, 1, 'processed', 'green', NULL);
             INSERT INTO highlight_surfacings(citation_id, date, shown_at, action, acted_at, hlc, device, sync_seq)
                 VALUES ('{cite}', '2026-10-16', 5, 'kept', 6, 11, 'dev', 3);
             INSERT INTO ingest_jobs VALUES ('{job}', 'url', 'https://example.org', 'example', NULL, 'done', 1, NULL, NULL, '{page}', '{snap}', 7, 8);
             INSERT INTO editor_events(seq, change_id, actor, reason, created_at, committed, restructured_pages, views)
                 VALUES (1, NULL, 'person', NULL, 0, '{{}}', '[]', '[]'), (2, NULL, 'person', NULL, 0, '{{}}', '[]', '[]');
             DELETE FROM editor_events WHERE seq = 2;
             INSERT INTO card_templates VALUES ('{tpl}', '{page}', 'Author', 'Who wrote {{{{title}}}}?', '{{{{author}}}}', 0, 1, 20, 1, 0, 0);
             INSERT INTO type_presentation VALUES ('{page}', 'Books', 'book');
             INSERT INTO field_targets VALUES ('{page}', '{page}', 3);",
            snap = id(10), p1 = id(11), p2 = id(12), page = id(1), cite = id(13), job = id(14), tpl = id(17),
        ))
        .unwrap();
        let rows = |conn: &Connection, sql: &str| -> Vec<Vec<String>> {
            let mut statement = conn.prepare(sql).unwrap();
            let width = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..width)
                        .map(|index| {
                            Ok(format!(
                                "{:?}",
                                row.get::<_, rusqlite::types::Value>(index)?
                            ))
                        })
                        .collect()
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        const TABLES: &[&str] = &[
            "snapshots",
            "passages",
            "snapshot_resources",
            "sources",
            "source_snapshots",
            "reading_positions",
            "citations",
            "ingest_jobs",
            "highlight_surfacings",
            "editor_events",
            "card_templates",
            "type_presentation",
            "field_targets",
        ];
        let before: Vec<_> = TABLES
            .iter()
            .map(|table| {
                rows(
                    &conn,
                    &format!("SELECT rowid, * FROM {table} ORDER BY rowid"),
                )
            })
            .collect();

        migrate(&mut conn).unwrap();

        let after: Vec<_> = TABLES
            .iter()
            .map(|table| {
                rows(
                    &conn,
                    &format!("SELECT rowid, * FROM {table} ORDER BY rowid"),
                )
            })
            .collect();
        assert_eq!(after, before);
        for table in TABLES {
            let strict: bool = conn
                .query_row(
                    "SELECT strict FROM pragma_table_list WHERE name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(strict, "{table} is not STRICT");
        }
        assert!(
            conn.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query([])
                .unwrap()
                .next()
                .unwrap()
                .is_none()
        );
        // The full-text index still reaches the passage rows by rowid.
        assert_eq!(
            rows(
                &conn,
                "SELECT p.id FROM passages_fts f JOIN passages p ON p.rowid = f.rowid WHERE passages_fts MATCH 'second'"
            ),
            vec![vec![format!("Text({:?})", id(12))]]
        );
        conn.execute(
            "INSERT INTO passages(id, snapshot_id, ordinal, kind, text, locator, marks, start)
             VALUES (?1, ?2, 2, 'paragraph', 'Third evidence', 'c#3', '[]', 30)",
            [id(15), id(10)],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM passages_fts WHERE passages_fts MATCH 'third'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        // The editor cursor journal keeps counting from where it was.
        conn.execute(
            "INSERT INTO editor_events(change_id, actor, reason, created_at, committed, restructured_pages, views)
             VALUES (NULL, 'person', NULL, 0, '{}', '[]', '[]')",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT MAX(seq) FROM editor_events", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        // Strict typing now holds.
        assert!(
            conn.execute(
                "INSERT INTO ingest_jobs VALUES (?1, 'url', 'x', 'x', NULL, 'queued', 'many', NULL, NULL, NULL, NULL, 0, 0)",
                [id(16)],
            )
            .is_err()
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

    #[test]
    fn unicode_title_upgrade_preserves_legacy_collisions_and_membership_targets() {
        assert_eq!(caseless::UNICODE_VERSION, (16, 0, 0));
        let mut conn = Connection::open_in_memory().unwrap();
        let previous_version = MIGRATIONS
            .iter()
            .position(|sql| *sql == UNICODE_TITLE_KEYS)
            .unwrap();
        for sql in &MIGRATIONS[..previous_version] {
            conn.execute_batch(sql).unwrap();
        }
        let first = ulid::Ulid::from(1_u128).to_string();
        let second = ulid::Ulid::from(2_u128).to_string();
        let owner = ulid::Ulid::from(3_u128).to_string();
        for (id, text) in [
            (&first, "café"),
            (&second, "cafe\u{301}"),
            (&owner, "Owner"),
        ] {
            conn.execute(
                "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
                 VALUES (?1, 'page', ?1, 1024, ?2, ?3, 1, 0, 0)",
                params![id, text, text.to_lowercase()],
            ).unwrap();
        }
        for (id, title) in [(&first, "café"), (&second, "cafe\u{301}")] {
            conn.execute(
                "INSERT INTO memberships(block_id, title_key, type_id, manual, title) VALUES (?1, ?2, ?3, 1, ?4)",
                params![owner, title.to_lowercase(), id, title],
            ).unwrap();
        }
        conn.pragma_update(None, "user_version", previous_version as u32)
            .unwrap();
        migrate(&mut conn).unwrap();
        // Only the Unicode upgrade is re-run: undo the migrations after it.
        conn.execute_batch("DROP TABLE occlusions; DROP TABLE images;")
            .unwrap();
        conn.pragma_update(None, "user_version", previous_version as u32)
            .unwrap();
        migrate(&mut conn).unwrap();
        let titles = conn
            .prepare("SELECT id, text, title_key FROM blocks WHERE id IN (?1, ?2) ORDER BY id")
            .unwrap()
            .query_map(params![first, second], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            titles,
            vec![
                (first.clone(), "café".into(), "café".into()),
                (second.clone(), "cafe\u{301}".into(), "café".into()),
            ]
        );
        let targets = conn
            .prepare("SELECT type_id FROM memberships WHERE block_id = ?1 ORDER BY type_id")
            .unwrap()
            .query_map([owner], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(targets, vec![first, second]);
        assert!(conn.execute(
            "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
             VALUES (?1, 'page', ?1, 1024, 'CAFÉ', 'café', 1, 0, 0)",
            [ulid::Ulid::from(4_u128).to_string()],
        ).is_err());
        migrate(&mut conn).unwrap();
    }
}
