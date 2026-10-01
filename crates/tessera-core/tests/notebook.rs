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
