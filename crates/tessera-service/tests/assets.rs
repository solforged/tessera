use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use tessera_core::Notebook;
use tower::ServiceExt;

const PORT: u16 = 4397;

fn app(root: &std::path::Path, assets: Option<std::path::PathBuf>) -> Router {
    tessera_service::router(
        Notebook::open(root.join("notebook")).unwrap(),
        PORT,
        assets,
        None,
    )
    .unwrap()
}

async fn request(app: Router, method: Method, path: &str) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", format!("127.0.0.1:{PORT}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn filesystem_override_routes_cache_headers_and_head() {
    let root = tempfile::tempdir().unwrap();
    let dist = root.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>override").unwrap();
    std::fs::write(dist.join("assets/index-Ab12_-xy.js"), "const answer = 42;").unwrap();
    let app = app(root.path(), Some(dist));
    let index = request(app.clone(), Method::GET, "/journal/today").await;
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(index.headers()["content-type"], "text/html; charset=utf-8");
    assert_eq!(index.headers()["cache-control"], "no-store");
    assert_eq!(
        &to_bytes(index.into_body(), usize::MAX).await.unwrap()[..],
        b"<!doctype html>override"
    );
    let script = request(app.clone(), Method::GET, "/assets/index-Ab12_-xy.js").await;
    assert_eq!(
        script.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        script.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(script.headers()["x-content-type-options"], "nosniff");
    assert!(script.headers().contains_key("content-security-policy"));
    let forbidden = app
        .clone()
        .oneshot(
            Request::get("/assets/index-Ab12_-xy.js")
                .header("host", "evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert_eq!(forbidden.headers()["cache-control"], "no-store");
    let head = request(app.clone(), Method::HEAD, "/assets/index-Ab12_-xy.js").await;
    assert_eq!(head.headers()["content-length"], "18");
    assert!(
        to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    for path in [
        "/api/unknown",
        "/api",
        "/assets/missing.js",
        "/notebook/notebook.db",
        "/%2e%2e/secret",
        "/.env",
        "/../outside.js",
    ] {
        assert_eq!(
            request(app.clone(), Method::GET, path).await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert_eq!(
        request(app, Method::POST, "/").await.status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[cfg(not(feature = "embed-web"))]
#[tokio::test]
async fn no_feature_and_no_override_is_api_only() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        request(app(root.path(), None), Method::GET, "/")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[cfg(feature = "embed-web")]
#[tokio::test]
async fn embedded_index_and_client_routes_work_without_filesystem_assets() {
    let root = tempfile::tempdir().unwrap();
    let app = app(root.path(), None);
    let index = request(app.clone(), Method::GET, "/").await;
    assert_eq!(index.status(), StatusCode::OK);
    let bytes = to_bytes(index.into_body(), usize::MAX).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("<html"));
    let route = request(app.clone(), Method::GET, "/journal/today").await;
    assert_eq!(
        to_bytes(route.into_body(), usize::MAX).await.unwrap(),
        bytes
    );
    let head = request(app.clone(), Method::HEAD, "/").await;
    assert_eq!(head.headers()["content-length"], bytes.len().to_string());
    assert!(
        to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        request(app, Method::GET, "/api/unknown").await.status(),
        StatusCode::NOT_FOUND
    );
}

#[cfg(unix)]
#[tokio::test]
async fn filesystem_assets_refuse_symlinks_outside_root() {
    let root = tempfile::tempdir().unwrap();
    let dist = root.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(root.path().join("secret.js"), "secret").unwrap();
    std::os::unix::fs::symlink(root.path().join("secret.js"), dist.join("leak.js")).unwrap();
    assert_eq!(
        request(app(root.path(), Some(dist)), Method::GET, "/leak.js")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}
