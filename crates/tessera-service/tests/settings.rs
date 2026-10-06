use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tessera_core::Notebook;
use tower::ServiceExt;

const PORT: u16 = 4396;

async fn request(app: &Router, method: &str, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", format!("127.0.0.1:{PORT}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn service_reports_version_bound_port_assets_and_launch_agent() {
    let dir = tempfile::tempdir().unwrap();
    for assets in [None, Some(dir.path().join("web"))] {
        let notebook = Notebook::open(dir.path().join("notebook")).unwrap();
        let mode = if assets.is_some() {
            "directory"
        } else if cfg!(feature = "embed-web") {
            "embedded"
        } else {
            "none"
        };
        let app = tessera_service::router(notebook, PORT, assets, None).unwrap();
        let (status, info) = request(&app, "GET", "/api/service").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(info["port"], PORT);
        assert_eq!(info["assets"], mode);
        let path = dirs::home_dir().map(|home| tessera_service::launch_agent_path(&home));
        assert_eq!(info["launch_agent"]["path"], json!(path));
        assert_eq!(
            info["launch_agent"]["installed"],
            path.is_some_and(|path| path.exists())
        );
    }
    assert_eq!(
        tessera_service::launch_agent_path(dir.path()),
        dir.path()
            .join("Library/LaunchAgents/dev.tessera.serve.plist")
    );
}

#[tokio::test]
async fn backups_create_portable_snapshot_and_list_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let notebook = Notebook::open(dir.path().join("notebook")).unwrap();
    let info = notebook.info().unwrap();
    let sha = notebook.put_object(b"backup route object").unwrap();
    let app = tessera_service::router(notebook, PORT, None, None).unwrap();
    assert_eq!(
        request(&app, "GET", "/api/backups").await,
        (StatusCode::OK, json!([]))
    );
    let directory = info.path.parent().unwrap().join("backups").join(&info.id);
    let older = directory.join("2000-01-01T00-00-00");
    let mut manifest = tessera_core::backup(&info.path, &older).unwrap();
    manifest.created_at = 946684800000;
    std::fs::write(
        older.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::create_dir(directory.join("interrupted")).unwrap();

    let (status, created) = request(&app, "POST", "/api/backups").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["notebook_id"], info.id);
    assert_eq!(created["schema_version"], tessera_core::SCHEMA_VERSION);
    assert_eq!(created["object_count"], 1);
    assert!(created["db_page_count"].as_u64().unwrap() > 0);
    let path = std::path::Path::new(created["path"].as_str().unwrap());
    assert_eq!(path.parent(), Some(directory.as_path()));
    let timestamp = path.file_name().unwrap().to_str().unwrap();
    assert_eq!(timestamp.len(), 19);
    assert!(jiff::civil::DateTime::strptime("%Y-%m-%dT%H-%M-%S", timestamp).is_ok());
    let snapshot = Notebook::open(path).unwrap();
    assert_eq!(snapshot.info().unwrap().id, info.id);
    assert_eq!(snapshot.read_object(&sha).unwrap(), b"backup route object");
    let (status, listed) = request(&app, "GET", "/api/backups").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed,
        json!([
            { "path": path, "created_at": created["created_at"], "object_count": 1 },
            { "path": older, "created_at": manifest.created_at, "object_count": 1 },
        ])
    );
}
