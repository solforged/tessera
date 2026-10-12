//! Schema upgrades retain one exportable, restorable pre-upgrade notebook.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use rusqlite::Connection;
use serde_json::{Value, json};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, install};
use tessera_core::{Notebook, SCHEMA_VERSION};
use tessera_web::{
    export_upgrade_copy, handle, is_empty, open, reset, restore_upgrade_copy, upgrade_copy,
};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_dedicated_worker);

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

#[wasm_bindgen_test]
async fn upgrade_copy_precedes_migration_and_can_be_exported_restored_and_erased() {
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
                    {"op": "create_page", "id": page, "title": "Before upgrade"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
    drop(notebook);
    let conn = Connection::open("/demo/notebook.db").unwrap();
    conn.execute_batch("DROP TABLE quotes; PRAGMA user_version = 35;")
        .unwrap();
    drop(conn);
    let bytes = pool.export_db("/demo/notebook.db").unwrap();
    let previous_copy = format!("/demo-upgrade-34-1-{}.db", bytes.len());
    pool.import_db(&previous_copy, &bytes).unwrap();
    let before = js_sys::Date::now() as i64;
    let info: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    let after = js_sys::Date::now() as i64;
    assert_eq!(info["id"], id);
    assert_eq!(info["schema_version"], SCHEMA_VERSION);
    assert!(!pool.exists(&previous_copy).unwrap());
    let metadata: Value = serde_json::from_str(&upgrade_copy().unwrap().unwrap()).unwrap();
    assert_eq!(metadata["schema_version"], 35);
    let created_at = metadata["created_at"].as_i64().unwrap();
    assert!((before..=after).contains(&created_at));
    let copy = export_upgrade_copy().unwrap().to_vec();
    assert_eq!(metadata["size"], copy.len());
    assert_eq!(u32::from_be_bytes(copy[60..64].try_into().unwrap()), 35);
    pool.import_db("/inspect/notebook.db", &copy).unwrap();
    let conn = Connection::open("/inspect/notebook.db").unwrap();
    let quotes: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'quotes')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!quotes, "the copy was taken after migration");
    drop(conn);
    pool.delete_db("/inspect/notebook.db").unwrap();
    open().await.unwrap();
    assert_eq!(export_upgrade_copy().unwrap().to_vec(), copy);

    let new_page = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    assert_eq!(
        request(
            "POST",
            "/api/batches",
            json!({
                "actor": {"kind": "person"}, "operations": [
                    {"op": "create_page", "id": new_page, "title": "After upgrade"}
                ]
            })
        )
        .await
        .0,
        200
    );
    let restored: Value = serde_json::from_str(&restore_upgrade_copy().await.unwrap()).unwrap();
    assert_eq!(restored["id"], id);
    assert_eq!(restored["schema_version"], SCHEMA_VERSION);
    let (status, page) = request("GET", &format!("/api/pages/{page}"), Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(page["root"]["text"], "Before upgrade");
    assert_eq!(
        request("GET", &format!("/api/pages/{new_page}"), Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(export_upgrade_copy().unwrap().to_vec(), copy);
    assert_eq!(
        serde_json::from_str::<Value>(&upgrade_copy().unwrap().unwrap()).unwrap(),
        metadata
    );
    reset().await.unwrap();
    assert!(is_empty().unwrap());
    assert!(upgrade_copy().unwrap().is_none());
    assert_eq!(pool.list(), vec!["/demo/notebook.db"]);
}
