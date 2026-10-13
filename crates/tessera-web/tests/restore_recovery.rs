//! A staged notebook survives interruption after the live database is removed.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use rusqlite::Connection;
use serde_json::{Value, json};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, install};
use tessera_core::{Notebook, SCHEMA_VERSION};
use tessera_web::{handle, open, upgrade_copy};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

#[path = "../../tessera-core/tests/common/mod.rs"]
mod common;

wasm_bindgen_test_configure!(run_in_dedicated_worker);

#[wasm_bindgen_test]
async fn opening_finishes_a_staged_restore_without_a_live_database() {
    let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .unwrap();
    let mut notebook = Notebook::open("/demo").unwrap();
    let id = notebook.info().unwrap().id;
    let page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    notebook
        .apply(
            &serde_json::from_value(json!({
                "actor": {"kind": "person"}, "operations": [
                    {"op": "create_page", "id": page, "title": "Recovered page"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
    drop(notebook);
    // Stage a version that still needs migration, as a crash during validation can.
    let conn = Connection::open("/demo/notebook.db").unwrap();
    common::restore_authored_search(&conn);
    conn.execute_batch(
        "DROP TABLE quotes; ALTER TABLE fields DROP COLUMN hide; PRAGMA user_version = 35;",
    )
    .unwrap();
    drop(conn);
    let bytes = pool.export_db("/demo/notebook.db").unwrap();
    pool.import_db("/demo-restore/notebook.db", &bytes).unwrap();
    pool.delete_db("/demo/notebook.db").unwrap();
    assert!(!pool.exists("/demo/notebook.db").unwrap());

    let info: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    assert_eq!(info["id"], id);
    assert_eq!(info["schema_version"], SCHEMA_VERSION);
    let response = handle(
        "GET".into(),
        format!("/api/pages/{page}"),
        Vec::new(),
        Vec::new(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = serde_json::from_slice(&response.body().to_vec()).unwrap();
    assert_eq!(body["root"]["text"], "Recovered page");
    assert!(!pool.exists("/demo-restore/notebook.db").unwrap());
    assert!(upgrade_copy().unwrap().is_none());
    assert_eq!(pool.list(), vec!["/demo/notebook.db"]);
    assert_eq!(
        serde_json::from_str::<Value>(&open().await.unwrap()).unwrap(),
        info
    );
}
