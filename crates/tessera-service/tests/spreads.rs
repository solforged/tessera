use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use tessera_core::Notebook;
use tower::ServiceExt;

async fn request(app: &Router, method: Method, path: &str, value: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:14342")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&value).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn native_and_embedded_spreads_derive_ids_and_list_saved_pages() {
    for embedded in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let notebook = Notebook::open(dir.path()).unwrap();
        let app = if embedded {
            tessera_service::embedded_router(notebook).unwrap().0
        } else {
            tessera_service::router(notebook, 14342, None, None, None).unwrap()
        };
        let id = |n| ulid::Ulid::from(n).to_string();
        let (status, _) = request(&app, Method::POST, "/api/batches", json!({"actor":{"kind":"person"},"operations":[
            {"op":"create_page","id":id(1),"title":"First"},
            {"op":"create_page","id":id(2),"title":"Second"},
            {"op":"create_page","id":id(3),"title":"Saved spread"},
            {"op":"set_spread","id":id(3),"base_revision":1,"spread":true},
            {"op":"insert","id":id(4),"parent_id":id(3),"after":null,"text":format!("[[{}]]", id(2)),"heading":null},
            {"op":"insert","id":id(5),"parent_id":id(3),"after":id(4),"text":format!("[[{}]]", id(1)),"heading":null}
        ]})).await;
        assert_eq!(status, StatusCode::OK);
        let (status, spread) =
            request(&app, Method::POST, "/api/spreads", json!([id(1), id(2)])).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(spread["note_ids"], json!([id(1), id(2)]));
        assert_eq!(spread["columns"][0]["title"], "First");
        assert_eq!(spread["references"], json!([]));
        let (status, spread) = request(
            &app,
            Method::GET,
            &format!("/api/pages/{}/spread", id(3)),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(spread["note_ids"], json!([id(2), id(1)]));
        assert_eq!(spread["references"][0]["block_id"], id(4));
        let (_, index) = request(&app, Method::GET, "/api/index", Value::Null).await;
        assert_eq!(
            index["spreads"],
            json!([{"id":id(3),"title":"Saved spread"}])
        );
        let (status, _) = request(&app, Method::POST, "/api/spreads", json!([id(1), id(1)])).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}
