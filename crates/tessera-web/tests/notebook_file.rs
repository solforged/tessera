//! Notebook files include committed pages and embedded library objects.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use rusqlite::Connection;
use serde_json::{Value, json};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, OpfsSAHPoolUtil, install};
use tessera_core::SCHEMA_VERSION;
use tessera_web::{
    export_notebook, export_upgrade_copy, handle, is_empty, open, reset, restore_notebook,
    restore_upgrade_copy, upgrade_copy,
};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_dedicated_worker);

const PAGE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXTURE: &str = "/fixture/notebook.db";
const SNAPSHOT: &str = "INSERT INTO snapshots VALUES (
    'snapshot', 'book-hash', 'epub', 'application/epub+zip', '{}', '[]', 0, 0, 0);";

async fn request(method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = handle(
        method.into(),
        path.into(),
        vec!["content-type".into(), "application/json".into()],
        if body.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(&body).unwrap()
        },
    )
    .await
    .unwrap();
    (
        response.status(),
        serde_json::from_slice(&response.body().to_vec()).unwrap(),
    )
}

fn modify(pool: &OpfsSAHPoolUtil, bytes: &[u8], sql: &str) -> Vec<u8> {
    pool.import_db(FIXTURE, bytes).unwrap();
    let conn = Connection::open(FIXTURE).unwrap();
    conn.execute_batch(sql).unwrap();
    drop(conn);
    let bytes = pool.export_db(FIXTURE).unwrap();
    pool.delete_db(FIXTURE).unwrap();
    bytes
}

fn message(error: JsValue) -> String {
    error.dyn_into::<js_sys::Error>().unwrap().message().into()
}

#[wasm_bindgen_test]
async fn round_trip_and_invalid_files_leave_the_current_notebook_untouched() {
    let info: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .unwrap();
    assert!(is_empty().unwrap());
    assert!(upgrade_copy().unwrap().is_none());
    assert!(message(export_upgrade_copy().unwrap_err()).starts_with("internal:"));
    assert!(message(restore_upgrade_copy().await.unwrap_err()).starts_with("internal:"));
    let (status, _) = request(
        "POST",
        "/api/batches",
        json!({"actor": {"kind": "person"}, "operations": [
            {"op": "create_page", "id": PAGE, "title": "Portable page"}
        ]}),
    )
    .await;
    assert_eq!(status, 200);
    let page_path = format!("/api/pages/{PAGE}");
    let (status, page) = request("GET", &page_path, Value::Null).await;
    assert_eq!(status, 200);
    let bytes = export_notebook().unwrap().to_vec();
    reset().await.unwrap();
    assert!(is_empty().unwrap());
    assert_eq!(request("GET", &page_path, Value::Null).await.0, 404);
    let restored: Value = serde_json::from_str(&restore_notebook(bytes).await.unwrap()).unwrap();
    assert_eq!(restored["id"], info["id"]);
    assert!(!is_empty().unwrap());
    assert_eq!(
        request("GET", &page_path, Value::Null).await,
        (200, page.clone())
    );

    let bytes = export_notebook().unwrap().to_vec();
    let mut newer = bytes.clone();
    newer[60..64].copy_from_slice(&(SCHEMA_VERSION + 1).to_be_bytes());
    let truncated = bytes[..bytes.len() / 2].to_vec();
    let mut damaged = bytes.clone();
    damaged[100] = 0;
    let no_notebook = modify(&pool, &bytes, "DROP TABLE notebook;");
    let missing_book = modify(&pool, &bytes, SNAPSHOT);
    let desktop = modify(
        &pool,
        &bytes,
        &format!("{SNAPSHOT} DROP TABLE browser_objects;"),
    );
    let missing_resource = modify(
        &pool,
        &bytes,
        &format!(
            "{SNAPSHOT}
             INSERT INTO browser_objects VALUES ('book-hash', X'010203');
             INSERT INTO snapshot_resources VALUES ('snapshot', 'cover.png', 'cover-hash', 'image/png');"
        ),
    );
    for (bad, expected) in [
        (
            b"not a database".to_vec(),
            "This file is not a Tessera backup.",
        ),
        (no_notebook, "This file is not a Tessera backup."),
        (
            newer,
            "This backup comes from a newer version of Tessera than this page runs.",
        ),
        (truncated, "This backup is damaged and cannot be restored."),
        (damaged, "This backup is damaged and cannot be restored."),
        (
            missing_book,
            "This backup's books are stored outside it, so it cannot be restored here.",
        ),
        (
            desktop,
            "This backup's books are stored outside it, so it cannot be restored here.",
        ),
        (
            missing_resource,
            "This backup's books are stored outside it, so it cannot be restored here.",
        ),
    ] {
        let error = restore_notebook(bad).await.unwrap_err();
        assert_eq!(message(error), format!("invalid: {expected}"));
        assert_eq!(
            request("GET", &page_path, Value::Null).await,
            (200, page.clone())
        );
        assert_eq!(export_notebook().unwrap().to_vec(), bytes);
        assert!(
            !pool
                .list()
                .iter()
                .any(|name| name.starts_with("/demo-restore/"))
        );
    }

    let embedded = modify(
        &pool,
        &bytes,
        &format!(
            "{SNAPSHOT}
             INSERT INTO browser_objects VALUES ('book-hash', X'010203');
             INSERT INTO browser_objects VALUES ('cover-hash', X'040506');
             INSERT INTO snapshot_resources VALUES ('snapshot', 'cover.png', 'cover-hash', 'image/png');"
        ),
    );
    restore_notebook(embedded).await.unwrap();
    let exported = export_notebook().unwrap().to_vec();
    pool.import_db(FIXTURE, &exported).unwrap();
    let conn = Connection::open(FIXTURE).unwrap();
    let objects: i64 = conn
        .query_row("SELECT count(*) FROM browser_objects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(objects, 2);
    drop(conn);
    pool.delete_db(FIXTURE).unwrap();

    // Reset also removes unfinished imports, journals, and an earlier upgrade copy.
    for filename in [
        "/demo-restore/notebook.db",
        "/demo-restore/notebook.db-journal",
        "/demo/notebook.db-wal",
        "/demo/notebook.db-shm",
        "/demo-upgrade-35-123-100.db",
    ] {
        pool.import_db_unchecked(filename, &exported).unwrap();
    }
    reset().await.unwrap();
    assert!(is_empty().unwrap());
    assert!(upgrade_copy().unwrap().is_none());
    assert_eq!(pool.list(), vec!["/demo/notebook.db"]);
    assert_eq!(request("GET", &page_path, Value::Null).await.0, 404);
}
