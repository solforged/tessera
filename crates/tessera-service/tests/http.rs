use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tessera_core::{Notebook, SCHEMA_VERSION};
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
