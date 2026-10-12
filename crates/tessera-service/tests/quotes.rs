use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use tessera_core::Notebook;
use tower::ServiceExt;

async fn request(app: &Router, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:14339")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn native_and_embedded_quote_routes_freeze_rows_and_report_changes() {
    for embedded in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let nb = Notebook::open(dir.path()).unwrap();
        let app = if embedded {
            tessera_service::embedded_router(nb).unwrap().0
        } else {
            tessera_service::router(nb, 14339, None, None).unwrap()
        };
        let id = |n| ulid::Ulid::from(n).to_string();
        let (page, source, child, quote_row) = (id(1), id(2), id(3), id(4));
        let batch = |ops| json!({"actor":{"kind":"person"},"operations":ops});
        let (status, _) = request(&app, Method::POST, "/api/batches", batch(json!([
            {"op":"create_page","id":page,"title":"Quotes"},
            {"op":"insert","id":source,"parent_id":page,"after":null,"text":"Before","heading":null},
            {"op":"insert","id":child,"parent_id":source,"after":null,"text":"Nested","heading":2}
        ]))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, subtree) = request(
            &app,
            Method::GET,
            &format!("/api/blocks/{source}/subtree?limit=1"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(subtree["truncated"], true);
        assert_eq!(subtree["rows"][0]["depth"], 0);
        let (status, snapshot) = request(
            &app,
            Method::GET,
            &format!("/api/blocks/{source}/quote-snapshot"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(snapshot["captured_at"].as_i64().unwrap() > 0);
        assert_eq!(snapshot["rows"].as_array().unwrap().len(), 2);
        let (status, receipt) = request(&app, Method::POST, "/api/batches", batch(json!([
            {"op":"insert","id":quote_row,"parent_id":page,"after":source,"text":format!("(({source}))"),"heading":null},
            {"op":"set_quote","id":quote_row,"base_revision":1,"quote":snapshot}
        ]))).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            receipt["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|caps| caps["quote"] == snapshot)
        );
        let (status, _) = request(
            &app,
            Method::POST,
            "/api/batches",
            batch(json!([
                {"op":"edit_text","id":source,"base_revision":1,"text":"After"}
            ])),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, statuses) = request(
            &app,
            Method::GET,
            &format!("/api/pages/{page}/quote-status"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            statuses,
            json!([{"block_id":quote_row,"source_live":true,"changed":true}])
        );
        let (_, page_view) = request(
            &app,
            Method::GET,
            &format!("/api/pages/{page}"),
            Value::Null,
        )
        .await;
        assert!(
            page_view["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|caps| caps["quote"] == snapshot)
        );
        let (status, _) = request(
            &app,
            Method::GET,
            "/api/blocks/bad/quote-snapshot",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = request(
            &app,
            Method::GET,
            &format!("/api/blocks/{source}/subtree?limit=-1"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request(
            &app,
            Method::GET,
            &format!("/api/pages/{}/quote-status", id(999)),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
