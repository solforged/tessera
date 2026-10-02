use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tessera_core::{Actor, Batch, Committed, Notebook, Operation, PageView, SCHEMA_VERSION};
use tower::ServiceExt;

const PORT: u16 = 4318;

fn app(dir: &std::path::Path, assets: Option<std::path::PathBuf>, dev: Option<&str>) -> Router {
    let notebook = Notebook::open(dir.join("nb")).unwrap();
    tessera_service::router(notebook, PORT, assets, dev.map(str::to_string)).unwrap()
}

async fn send(app: Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, Vec<u8>) {
    let mut request = Request::get(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, body.to_vec())
}

#[tokio::test]
async fn same_origin_request_reads_notebook_info() {
    let dir = tempfile::tempdir().unwrap();
    let (status, body) = send(
        app(dir.path(), None, None),
        "/api/notebook",
        &[
            ("host", "127.0.0.1:4318"),
            ("origin", "http://127.0.0.1:4318"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let info: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(info["schema_version"], SCHEMA_VERSION);
    assert_eq!(info["id"].as_str().unwrap().len(), 26);
}

#[tokio::test]
async fn rejects_foreign_origins_and_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let cases: &[&[(&str, &str)]] = &[
        // A website the user visits must not read the notebook.
        &[
            ("host", "127.0.0.1:4318"),
            ("origin", "https://example.com"),
        ],
        // DNS rebinding: a foreign name resolving to loopback.
        &[("host", "evil.example:4318")],
        // A cross-site resource load without an Origin header.
        &[("host", "127.0.0.1:4318"), ("sec-fetch-site", "cross-site")],
        // The Vite origin is only allowed when configured.
        &[
            ("host", "127.0.0.1:4318"),
            ("origin", "http://127.0.0.1:5173"),
        ],
    ];
    for headers in cases {
        let (status, _) = send(app(dir.path(), None, None), "/api/notebook", headers).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{headers:?}");
    }
}

#[tokio::test]
async fn configured_dev_origin_is_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let (status, _) = send(
        app(dir.path(), None, Some("http://127.0.0.1:5173")),
        "/api/notebook",
        &[
            ("host", "127.0.0.1:4318"),
            ("origin", "http://127.0.0.1:5173"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn assets_never_expose_dotfiles_or_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("dist");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(assets.join(".env"), "secret").unwrap();
    std::fs::write(dir.path().join("outside.js"), "secret").unwrap();

    let host = [("host", "127.0.0.1:4318")];
    let (status, body) = send(app(dir.path(), Some(assets.clone()), None), "/", &host).await;
    assert_eq!(
        (status, body.as_slice()),
        (StatusCode::OK, b"<!doctype html>".as_slice())
    );
    for path in [
        "/.env",
        "/../outside.js",
        "/%2e%2e/outside.js",
        "/nb/notebook.db",
    ] {
        let (status, _) = send(app(dir.path(), Some(assets.clone()), None), path, &host).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

async fn batch(app: Router, operations: Vec<Operation>) -> (StatusCode, serde_json::Value) {
    let body = serde_json::to_vec(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
    let response = app
        .oneshot(
            Request::post("/api/batches")
                .header("host", "127.0.0.1:4318")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

const PAGE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BLOCK: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

async fn seed(app: Router) -> Committed {
    let (status, body) = batch(
        app,
        vec![
            Operation::CreatePage {
                id: PAGE.into(),
                title: "HTTP page".into(),
            },
            Operation::Insert {
                id: BLOCK.into(),
                parent_id: PAGE.into(),
                after: None,
                text: "Original".into(),
                heading: Some(2),
            },
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_value(body).unwrap()
}

#[tokio::test]
async fn batch_round_trip_then_page_read() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path(), None, None);
    let committed = seed(app.clone()).await;
    assert_eq!(committed.seq, 1);
    assert_eq!(
        committed
            .revisions
            .iter()
            .map(|r| (&*r.id, r.revision))
            .collect::<Vec<_>>(),
        vec![(PAGE, 1), (BLOCK, 1)]
    );
    let (status, body) = send(
        app,
        &format!("/api/pages/{PAGE}"),
        &[("host", "127.0.0.1:4318")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let page: PageView = serde_json::from_slice(&body).unwrap();
    assert_eq!(page.root.id, PAGE);
    assert_eq!(page.root.text, "HTTP page");
    assert_eq!(page.rows[0].block.id, BLOCK);
    assert_eq!(page.rows[0].block.text, "Original");
    assert_eq!(page.rows[0].block.heading, Some(2));
    assert_eq!(page.rows[0].depth, 0);
}

#[tokio::test]
async fn stale_batch_returns_details_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path(), None, None);
    seed(app.clone()).await;
    let (status, _) = batch(
        app.clone(),
        vec![Operation::EditText {
            id: BLOCK.into(),
            base_revision: 1,
            text: "Current".into(),
        }],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = batch(
        app.clone(),
        vec![
            Operation::EditText {
                id: PAGE.into(),
                base_revision: 1,
                text: "Must roll back".into(),
            },
            Operation::EditText {
                id: BLOCK.into(),
                base_revision: 1,
                text: "Stale".into(),
            },
        ],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "conflict");
    assert_eq!(
        error["error"]["details"],
        serde_json::json!({
            "op_index": 1, "id": BLOCK, "expected": 1, "found": 2,
        })
    );
    let (_, body) = send(
        app.clone(),
        &format!("/api/pages/{PAGE}"),
        &[("host", "127.0.0.1:4318")],
    )
    .await;
    let page: PageView = serde_json::from_slice(&body).unwrap();
    assert_eq!(page.root.text, "HTTP page");
    assert_eq!(page.root.revision, 1);
    assert_eq!(page.rows[0].block.text, "Current");
    let (_, body) = send(app, "/api/changes?after=2", &[("host", "127.0.0.1:4318")]).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!([])
    );
}

#[tokio::test]
async fn validation_returns_422() {
    let dir = tempfile::tempdir().unwrap();
    let (status, error) = batch(
        app(dir.path(), None, None),
        vec![Operation::CreatePage {
            id: PAGE.into(),
            title: String::new(),
        }],
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "validation");
    assert_eq!(error["error"]["details"]["op_index"], 0);
}

#[tokio::test]
async fn absent_journal_returns_404() {
    let dir = tempfile::tempdir().unwrap();
    let (status, body) = send(
        app(dir.path(), None, None),
        "/api/journal/2026-10-01",
        &[("host", "127.0.0.1:4318")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["error"]["code"],
        "not_found"
    );
}

#[tokio::test]
async fn malformed_requests_keep_json_errors() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path(), None, None);
    let cases = [
        (
            Request::get("/api/complete?limit=bad")
                .header("host", "127.0.0.1:4318")
                .body(Body::empty())
                .unwrap(),
            "invalid_query",
        ),
        (
            Request::get("/api/blocks/%FF")
                .header("host", "127.0.0.1:4318")
                .body(Body::empty())
                .unwrap(),
            "invalid_path",
        ),
        (
            Request::post("/api/batches")
                .header("host", "127.0.0.1:4318")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
            "invalid_json",
        ),
    ];
    for (request, code) in cases {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["error"]["code"], code);
    }
}

#[tokio::test]
async fn settings_batch_changes_calendar_date_and_announces_keys() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path(), None, None);
    let host = [("host", "127.0.0.1:4318")];
    let (_, body) = send(app.clone(), "/api/settings", &host).await;
    let initial: tessera_core::SettingsView = serde_json::from_slice(&body).unwrap();
    let mut revision = None;
    let mut different = false;
    // These zones are 26 hours apart, so at least one differs from the host date.
    for zone in ["Pacific/Kiritimati", "Etc/GMT+12"] {
        let (status, receipt) = batch(
            app.clone(),
            vec![Operation::SetSetting {
                key: "time_zone".into(),
                base_revision: revision,
                value: zone.into(),
            }],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        revision = Some(receipt["settings"][0]["revision"].as_i64().unwrap());
        assert_eq!(receipt["revisions"], serde_json::json!([]));
        let (status, body) = send(app.clone(), "/api/settings", &host).await;
        assert_eq!(status, StatusCode::OK);
        let settings: tessera_core::SettingsView = serde_json::from_slice(&body).unwrap();
        assert_eq!(settings.time_zone, zone);
        assert_eq!(settings.settings[0].value, zone);
        assert_eq!(settings.settings[0].revision, revision.unwrap());
        different |= settings.today != initial.today;
    }
    assert!(different);
    let (_, body) = send(app, "/api/changes?after=0", &host).await;
    let changes: Vec<tessera_core::ChangeEvent> = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|event| event.settings.as_slice())
            .collect::<Vec<_>>(),
        vec![["time_zone".to_string()].as_slice(); 2]
    );
    assert!(
        changes
            .iter()
            .all(|event| event.blocks.is_empty() && event.removed.is_empty())
    );
}
