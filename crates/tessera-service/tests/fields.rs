use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tessera_core::Notebook;
use tower::ServiceExt;

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
async fn request(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:4318")
                .header("content-type", "application/json")
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(serde_json::to_vec(&body).unwrap())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn fields_queries_and_saved_views_round_trip_through_http_and_conflict_envelopes() {
    let dir = tempfile::tempdir().unwrap();
    let app =
        tessera_service::router(Notebook::open(dir.path()).unwrap(), 4318, None, None).unwrap();
    let (status, fields) = request(&app, "GET", "/api/fields", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let operations = json!([
        {"op":"create_page","id":id(1),"title":"Books"},
        {"op":"insert","id":id(10),"parent_id":fields["page_id"],"after":null,"text":"Year","heading":null},
        {"op":"set_field_kind","id":id(10),"base_revision":1,"kind":"number"},
        {"op":"insert","id":id(100),"parent_id":id(1),"after":null,"text":"A book #books","heading":null},
        {"op":"insert","id":id(200),"parent_id":id(100),"after":null,"text":format!("[[{}]]",id(10)),"heading":null},
        {"op":"insert","id":id(300),"parent_id":id(200),"after":null,"text":"1984","heading":null},
        {"op":"set_type_fields","type_id":id(1),"base_revision":1,"fields":[id(10)]}
    ]);
    let (status, _) = request(
        &app,
        "POST",
        "/api/batches",
        json!({"actor":{"kind":"person"},"operations":operations}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let query = json!({"type":id(1),"text":null,"filters":[{"field":id(10),"op":"gte","value":"1970"}],"sort":[{"by":"field","field":id(10),"direction":"desc"}],"limit":10});
    let (status, result) = request(&app, "POST", "/api/query", query.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["total"], 1);
    assert_eq!(result["rows"][0]["block"]["block"]["id"], id(100));
    assert_eq!(
        result["rows"][0]["values"][id(10)][0]["reading"],
        json!({"ok":true,"value":1984.0,"target":null})
    );
    let (status, info) = request(&app, "GET", &format!("/api/types/{}", id(1)), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["members"], 1);
    assert_eq!(info["fields"], json!([id(10)]));
    let (status, _) = request(&app, "GET", &format!("/api/types/{}", id(100)), Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, error) = request(
        &app,
        "POST",
        "/api/query",
        json!({"type":null,"text":null,"filters":[],"sort":[],"limit":null}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "validation");
    let save = json!({"actor":{"kind":"person"},"operations":[{"op":"save_view","id":id(500),"base_revision":null,"name":" Books since 1970 ","query":query}]});
    let (status, committed) = request(&app, "POST", "/api/batches", save.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(committed["revisions"], json!([{"id":id(500),"revision":1}]));
    let (status, views) = request(&app, "GET", "/api/views", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(views[0]["query"], query);
    assert_eq!(views[0]["name"], "Books since 1970");
    let (status, view) =
        request(&app, "GET", &format!("/api/views/{}", id(500)), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view, views[0]);
    let (status, error) = request(&app, "POST", "/api/batches", save).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "conflict");
    let (_, events) = request(&app, "GET", "/api/changes?after=1", Value::Null).await;
    assert_eq!(events[0]["views"], json!([id(500)]));
    assert_eq!(events[0]["removed"], json!([]));
}
