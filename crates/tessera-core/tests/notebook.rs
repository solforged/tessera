use tessera_core::{DATABASE_FILE, Error, Notebook, SCHEMA_VERSION};

#[test]
fn reopening_keeps_the_notebook_identity() {
    let dir = tempfile::tempdir().unwrap();
    let first = Notebook::open(dir.path().join("nb"))
        .unwrap()
        .info()
        .unwrap();
    let second = Notebook::open(dir.path().join("nb"))
        .unwrap()
        .info()
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.schema_version, SCHEMA_VERSION);
}

#[test]
fn opens_with_durable_wal_settings() {
    let dir = tempfile::tempdir().unwrap();
    Notebook::open(dir.path()).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn refuses_a_notebook_from_a_newer_schema_without_touching_it() {
    let dir = tempfile::tempdir().unwrap();
    Notebook::open(dir.path()).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    drop(conn);

    let error = Notebook::open(dir.path())
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
    let notebook_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&notebook_id],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    let mut notebook = Notebook::open(dir.path()).unwrap();
    assert_eq!(notebook.info().unwrap().id, notebook_id);
    assert_eq!(notebook.info().unwrap().created_at, 123);
    let page_id = ulid::Ulid::from(2u128).to_string();
    notebook
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
    assert_eq!(notebook.page(&page_id).unwrap().root.text, "Migrated page");
}

#[test]
fn concurrent_openers_upgrade_a_wal_notebook_once_and_preserve_identity() {
    const OPENERS: usize = 4;
    let dir = tempfile::tempdir().unwrap();
    let mut conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    let notebook_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&notebook_id],
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
                let result = Notebook::open(path).and_then(|notebook| notebook.info());
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
            assert_eq!(info.id, notebook_id);
            assert_eq!(info.created_at, 123);
            assert_eq!(info.schema_version, SCHEMA_VERSION);
        }
    });
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let reopened = Notebook::open(dir.path()).unwrap().info().unwrap();
    assert_eq!(reopened.id, notebook_id);
    assert_eq!(reopened.created_at, 123);
}

#[test]
fn failed_upgrade_rolls_back_schema_changes_and_releases_the_writer_slot() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    let notebook_id = ulid::Ulid::from(1u128).to_string();
    conn.execute(
        "INSERT INTO notebook(singleton, id, created_at) VALUES (1, ?1, 123)",
        [&notebook_id],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    // Migration 2 must fail after creating changes and deletion_events.
    conn.execute_batch("CREATE TABLE blocks (unrelated TEXT)")
        .unwrap();

    assert!(matches!(Notebook::open(dir.path()), Err(Error::Sqlite(_))));
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
    let info = Notebook::open(dir.path()).unwrap().info().unwrap();
    assert_eq!(info.id, notebook_id);
    assert_eq!(info.created_at, 123);
    assert_eq!(info.schema_version, SCHEMA_VERSION);
}
