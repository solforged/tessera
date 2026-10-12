//! Closing releases OPFS ownership without losing committed notebook writes.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use serde_json::{Value, json};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, install};
use tessera_web::{close, handle, open};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_dedicated_worker);

#[wasm_bindgen_test]
async fn close_releases_handles_and_reopen_keeps_the_last_write() {
    let info: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    let page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let response = handle(
        "POST".into(),
        "/api/batches".into(),
        vec!["content-type".into(), "application/json".into()],
        serde_json::to_vec(&json!({
            "actor": {"kind": "person"},
            "operations": [{"op": "create_page", "id": page, "title": "Written before closing"}]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    close().unwrap();
    close().unwrap();

    // A new pool really acquires the released handles, not just the old SQLite connection.
    let second = install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .unwrap();
    assert!(!second.is_paused());
    assert!(second.exists("/demo/notebook.db").unwrap());
    second.pause_vfs().unwrap();

    let reopened: Value = serde_json::from_str(&open().await.unwrap()).unwrap();
    assert_eq!(reopened["id"], info["id"]);
    let response = handle(
        "GET".into(),
        format!("/api/pages/{page}"),
        Vec::new(),
        Vec::new(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let saved: Value = serde_json::from_slice(&response.body().to_vec()).unwrap();
    assert_eq!(saved["root"]["text"], "Written before closing");
    close().unwrap();
}
