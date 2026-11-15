use tessera_core::{Actor, Batch, DATABASE_FILE, Error, Operation, SCHEMA_VERSION, Workshop};

#[test]
fn reopening_keeps_the_workshop_identity() {
    let dir = tempfile::tempdir().unwrap();
    let first = Workshop::open(dir.path().join("nb"))
        .unwrap()
        .info()
        .unwrap();
    let second = Workshop::open(dir.path().join("nb"))
        .unwrap()
        .info()
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.schema_version, SCHEMA_VERSION);
}

#[test]
fn opens_with_durable_wal_settings() {
    let dir = tempfile::tempdir().unwrap();
    Workshop::open(dir.path()).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn refuses_a_workshop_from_a_newer_schema_without_touching_it() {
    let dir = tempfile::tempdir().unwrap();
    Workshop::open(dir.path()).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    drop(conn);

    let error = Workshop::open(dir.path())
        .err()
        .expect("newer schema must fail");
    assert!(matches!(error, Error::SchemaTooNew { found, .. } if found == SCHEMA_VERSION + 1));

    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION + 1);
}

#[test]
fn migrating_the_first_schema_preserves_identity_and_enables_outline_operations() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    let workshop_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&workshop_id],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    let mut workshop = Workshop::open(dir.path()).unwrap();
    assert_eq!(workshop.info().unwrap().id, workshop_id);
    assert_eq!(workshop.info().unwrap().created_at, 123);
    let page_id = ulid::Ulid::from(2u128).to_string();
    workshop
        .apply(&tessera_core::Batch {
            actor: tessera_core::Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![tessera_core::Operation::CreatePage {
                id: page_id.clone(),
                title: "Migrated page".into(),
            }],
        })
        .unwrap();
    assert_eq!(workshop.page(&page_id).unwrap().root.text, "Migrated page");
}

#[test]
fn concurrent_openers_upgrade_a_wal_workshop_once_and_preserve_identity() {
    const OPENERS: usize = 4;
    let dir = tempfile::tempdir().unwrap();
    let mut conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    let workshop_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&workshop_id],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();

    // Keep the writer slot occupied while independent openers enter migration.
    // WAL still allows them to read schema 1; that read must happen only after
    // acquiring the writer slot, otherwise every opener decides to upgrade.
    let writer = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(OPENERS + 1));
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..OPENERS {
            let barrier = std::sync::Arc::clone(&barrier);
            let send = send.clone();
            let path = dir.path();
            scope.spawn(move || {
                barrier.wait();
                let result = Workshop::open(path).and_then(|workshop| workshop.info());
                send.send(result).unwrap();
            });
        }
        drop(send);
        barrier.wait();
        let early = receive.recv_timeout(std::time::Duration::from_millis(250));
        writer.commit().unwrap();
        let mut results = Vec::with_capacity(OPENERS);
        match early {
            Ok(result) => results.push(result),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("openers disconnected: {error}"),
        }
        results.extend(receive);
        assert_eq!(results.len(), OPENERS);
        for result in results {
            let info = result.expect("every independent concurrent opener must succeed");
            assert_eq!(info.id, workshop_id);
            assert_eq!(info.created_at, 123);
            assert_eq!(info.schema_version, SCHEMA_VERSION);
        }
    });
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let reopened = Workshop::open(dir.path()).unwrap().info().unwrap();
    assert_eq!(reopened.id, workshop_id);
    assert_eq!(reopened.created_at, 123);
}

#[test]
fn failed_upgrade_rolls_back_schema_changes_and_releases_the_writer_slot() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    let workshop_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&workshop_id],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    // Migration 2 must fail after creating changes and deletion_events.
    conn.execute_batch("CREATE TABLE blocks (unrelated TEXT)")
        .unwrap();

    assert!(matches!(Workshop::open(dir.path()), Err(Error::Sqlite(_))));
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let tables = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(tables, vec!["blocks", "notebook"]);

    conn.execute_batch("DROP TABLE blocks").unwrap();
    let info = Workshop::open(dir.path()).unwrap().info().unwrap();
    assert_eq!(info.id, workshop_id);
    assert_eq!(info.created_at, 123);
    assert_eq!(info.schema_version, SCHEMA_VERSION);
}

fn setting_batch(key: &str, base_revision: Option<i64>, value: &str) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: vec![Operation::SetSetting {
            key: key.into(),
            base_revision,
            value: value.into(),
        }],
    }
}

#[test]
fn settings_create_update_and_replay_without_block_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    let mut batch = setting_batch("vim", None, "true");
    batch.idempotency_key = Some("setting-create".into());
    let created = workshop.apply(&batch).unwrap();
    assert!(created.revisions.is_empty());
    assert_eq!(created.settings[0].key, "vim");
    assert_eq!(created.settings[0].revision, 1);
    let replay = workshop.apply(&batch).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.settings, created.settings);
    workshop
        .apply(&setting_batch("vim", Some(1), "false"))
        .unwrap();
    drop(workshop);
    let workshop = Workshop::open(dir.path()).unwrap();
    let settings = workshop.settings().unwrap();
    assert_eq!(settings[0].value, "false");
    assert_eq!(settings[0].revision, 2);
    assert!(settings[0].updated_at > 0);
    let changes = workshop.changes_since(0, 10).unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].settings, ["vim"]);
    assert!(changes[0].blocks.is_empty() && changes[0].removed.is_empty());
}

#[test]
fn stale_setting_revision_rejects_the_whole_batch() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    workshop.apply(&setting_batch("vim", None, "true")).unwrap();
    workshop
        .apply(&setting_batch("vim", Some(1), "false"))
        .unwrap();
    let mut batch = setting_batch("time_zone", None, "Pacific/Kiritimati");
    batch.operations.push(Operation::SetSetting {
        key: "vim".into(),
        base_revision: Some(1),
        value: "true".into(),
    });
    assert!(matches!(
        workshop.apply(&batch),
        Err(Error::Conflict {
            op_index: 1,
            expected: 1,
            found: Some(2),
            ..
        })
    ));
    assert_eq!(workshop.settings().unwrap().len(), 1);
    assert_eq!(workshop.settings().unwrap()[0].value, "false");
    assert!(matches!(
        workshop.apply(&setting_batch("vim", None, "true")),
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        workshop.apply(&setting_batch("time_zone", Some(1), "UTC")),
        Err(Error::Conflict { found: None, .. })
    ));
    assert!(workshop.changes_since(2, 10).unwrap().is_empty());
}

#[test]
fn view_delete_confirmation_accepts_boolean_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    workshop
        .apply(&setting_batch("confirm_view_delete", None, "false"))
        .unwrap();
    workshop
        .apply(&setting_batch("confirm_view_delete", Some(1), "true"))
        .unwrap();
    let settings = workshop.settings().unwrap();
    assert_eq!(settings[0].key, "confirm_view_delete");
    assert_eq!(settings[0].value, "true");
    assert_eq!(settings[0].revision, 2);
}

#[test]
fn invalid_time_zone_boolean_and_unknown_settings_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    for (key, value) in [
        ("time_zone", "Mars/Olympus"),
        ("time_zone", "+03:00"),
        ("vim", "yes"),
        ("confirm_view_delete", "yes"),
        ("confirm_view_delete", ""),
        ("confirm_view_delete", "TRUE"),
        ("unknown", "true"),
    ] {
        assert!(matches!(
            workshop.apply(&setting_batch(key, None, value)),
            Err(Error::Validation { .. })
        ));
    }
    assert!(workshop.settings().unwrap().is_empty());
    assert!(workshop.changes_since(0, 10).unwrap().is_empty());
}

const TODAY_TEMPLATE: &str = r#"{"sections":[{"id":"plan","name":"Plan","on":true},{"id":"inbox","name":"Inbox","on":true},{"id":"reading","name":"Reading","on":true},{"id":"notes","name":"Notes","on":true},{"id":"research","name":"Research to revisit","on":true},{"id":"highlights","name":"From your highlights","on":false}],"capture":"inbox","links":"link","tiles":{"agenda":true,"review":true,"reading":true}}"#;

#[test]
fn today_template_accepts_a_complete_template_and_rejects_broken_ones() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    workshop
        .apply(&setting_batch("today_template", None, TODAY_TEMPLATE))
        .unwrap();
    for value in [
        "{}".to_owned(),
        TODAY_TEMPLATE.replace(r#"{"id":"reading","name":"Reading","on":true},"#, ""),
        TODAY_TEMPLATE.replace(r#""capture":"inbox""#, r#""capture":"plan""#),
        TODAY_TEMPLATE.replace(
            r#""name":"Notes","on":true"#,
            r#""name":"Notes","on":false"#,
        ),
        TODAY_TEMPLATE.replace(r#""name":"Reading""#, r#""name":"inbox""#),
        TODAY_TEMPLATE.replace(r#""links":"link""#, r#""links":"page""#),
    ] {
        assert!(matches!(
            workshop.apply(&setting_batch("today_template", Some(1), &value)),
            Err(Error::Validation { .. })
        ));
    }
    assert_eq!(workshop.settings().unwrap()[0].revision, 1);
}

#[test]
fn today_uses_workshop_time_zone_across_midnight() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    let instant: jiff::Timestamp = "2026-10-02T10:30:00Z".parse().unwrap();
    workshop
        .apply(&setting_batch("time_zone", None, "Pacific/Kiritimati"))
        .unwrap();
    assert_eq!(
        workshop.today(instant.as_millisecond()).unwrap(),
        "2026-10-03"
    );
    workshop
        .apply(&setting_batch("time_zone", Some(1), "America/Los_Angeles"))
        .unwrap();
    assert_eq!(
        workshop.today(instant.as_millisecond()).unwrap(),
        "2026-10-02"
    );
}

#[test]
fn unset_time_zone_uses_service_host_local_zone() {
    let dir = tempfile::tempdir().unwrap();
    let workshop = Workshop::open(dir.path()).unwrap();
    let instant: jiff::Timestamp = "2026-10-02T10:30:00Z".parse().unwrap();
    let host_zone = jiff::tz::TimeZone::system();
    let view = workshop.settings_view(instant.as_millisecond()).unwrap();
    assert_eq!(view.time_zone, host_zone.iana_name().unwrap_or("UTC"));
    assert_eq!(view.today, instant.to_zoned(host_zone).date().to_string());
}

fn page(id: &str, title: &str) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: vec![Operation::CreatePage {
            id: id.into(),
            title: title.into(),
        }],
    }
}

#[test]
fn a_reader_sees_commits_and_holds_one_snapshot_per_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    let reader = workshop.reader().unwrap();
    let before = reader.read(|workshop| workshop.roots()).unwrap().len();

    workshop
        .apply(&page("01JREADER0000000000000000A", "First"))
        .unwrap();
    assert_eq!(
        reader.read(|workshop| workshop.roots()).unwrap().len(),
        before + 1
    );

    // A commit that lands inside a read is not seen until the next one.
    let (first, second) = reader
        .read(|snapshot| {
            let first = snapshot.roots()?.len();
            workshop.apply(&page("01JREADER0000000000000000B", "Second"))?;
            Ok((first, snapshot.roots()?.len()))
        })
        .unwrap();
    assert_eq!((first, second), (before + 1, before + 1));
    assert_eq!(
        reader.read(|workshop| workshop.roots()).unwrap().len(),
        before + 2
    );
}

#[test]
fn a_reader_refuses_to_write() {
    let dir = tempfile::tempdir().unwrap();
    let workshop = Workshop::open(dir.path()).unwrap();
    let reader = workshop.reader().unwrap();
    // Resuming ingest jobs is a write that takes `&self`.
    let error = reader
        .read(|workshop| workshop.resume_ingest())
        .expect_err("a write through the reader must fail");
    let Error::Sqlite(error) = error else {
        panic!("unexpected error: {error}");
    };
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ReadOnly)
    );
}
