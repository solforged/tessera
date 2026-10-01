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
