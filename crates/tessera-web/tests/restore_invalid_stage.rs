//! An interrupted invalid import must not replace the current workshop.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use serde_json::{Value, json};
use sqlite_wasm_rs::vfs::{VfsFilesManager, transfer::DbTransfer};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, install};
use tessera_core::Workshop;
use tessera_web::{handle, open};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_dedicated_worker);

#[wasm_bindgen_test]
async fn opening_discards_an_invalid_stage_and_keeps_the_live_workshop() {
    let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .unwrap();
    let mut workshop = Workshop::open("/demo").unwrap();
    let id = workshop.info().unwrap().id;
    let page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    workshop
        .apply(
            &serde_json::from_value(json!({
                "actor": {"kind": "person"}, "operations": [
                    {"op": "create_page", "id": page, "title": "Original page"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
    drop(workshop);
    pool.import_db_unchecked("/demo-restore/notebook.db", b"interrupted import")
        .unwrap();
    pool.import_db_unchecked("/demo-restore/notebook.db-journal", b"partial journal")
        .unwrap();

    let info: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    assert_eq!(info["id"], id);
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
    assert_eq!(body["root"]["text"], "Original page");
    assert_eq!(pool.names().unwrap(), vec!["/demo/notebook.db"]);
}
