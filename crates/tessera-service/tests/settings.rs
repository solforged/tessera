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
        let app = tessera_service::router(notebook, PORT, assets, None, None).unwrap();
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

/// Move a store backup's timestamp back one day, so retention keeps it beside a new one.
fn age_a_day(path: &std::path::Path) {
    let manifest = path.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["created_at"] = (value["created_at"].as_i64().unwrap() - 86_400_000).into();
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[tokio::test]
async fn backups_create_skip_and_list_portable_snapshots_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    let notebook = Notebook::open(dir.path().join("workshop")).unwrap();
    let info = notebook.info().unwrap();
    let sha = notebook.put_object(b"backup route object").unwrap();
    let app = tessera_service::router(notebook, PORT, None, None, Some(store.clone())).unwrap();
    assert_eq!(
        request(&app, "GET", "/api/backups").await,
        (
            StatusCode::OK,
            json!({"backups": [], "store_size": 0, "others": []})
        )
    );

    let (status, created) = request(&app, "POST", "/api/backups").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["created"], true);
    let saved = &created["backups"]["backups"][0];
    assert_eq!(saved["object_count"], 1);
    let path = std::path::Path::new(saved["path"].as_str().unwrap());
    assert_eq!(path.parent(), Some(store.join(&info.id).as_path()));
    assert_eq!(saved["name"], path.file_name().unwrap().to_str().unwrap());
    let own_size = std::fs::metadata(path.join("notebook.db")).unwrap().len()
        + std::fs::metadata(path.join("manifest.json")).unwrap().len();
    assert_eq!(saved["size"], own_size);
    assert_eq!(
        created["backups"]["store_size"],
        own_size + b"backup route object".len() as u64
    );
    let (status, skipped) = request(&app, "POST", "/api/backups").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(skipped["created"], false);
    assert_eq!(skipped["backups"], created["backups"]);
    // Yesterday's backup survives today's, since retention keeps one per day.
    age_a_day(path);

    // A new object changes the backup even without changing database bytes.
    let notebook = Notebook::open(&info.path).unwrap();
    notebook.put_object(b"a second object").unwrap();
    drop(notebook);
    let (status, edited) = request(&app, "POST", "/api/backups").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["created"], true);
    let listed = request(&app, "GET", "/api/backups").await.1;
    assert_eq!(listed, edited["backups"]);
    assert_eq!(listed["backups"].as_array().unwrap().len(), 2);
    assert_eq!(listed["backups"][0]["object_count"], 2);
    assert_eq!(listed["backups"][1]["name"], saved["name"]);
    let own_sizes: u64 = listed["backups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|backup| backup["size"].as_u64().unwrap())
        .sum();
    assert_eq!(
        listed["store_size"],
        own_sizes + b"backup route object".len() as u64 + b"a second object".len() as u64
    );
    let snapshot = Notebook::open(path).unwrap();
    assert_eq!(snapshot.info().unwrap().id, info.id);
    assert_eq!(snapshot.read_object(&sha).unwrap(), b"backup route object");
}

#[tokio::test]
async fn other_backups_list_and_delete_without_removing_the_open_workshop() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    let notebook = Notebook::open(dir.path().join("workshop")).unwrap();
    let info = notebook.info().unwrap();
    let current = tessera_core::backup_to_store(&info.path, &store).unwrap();
    let other = Notebook::open(dir.path().join("other")).unwrap();
    let other_info = other.info().unwrap();
    other.put_object(b"other workshop object").unwrap();
    let first = tessera_core::backup_to_store(&other_info.path, &store).unwrap();
    age_a_day(&first.path);
    other.put_object(b"second other object").unwrap();
    let second = tessera_core::backup_to_store(&other_info.path, &store).unwrap();
    let app = tessera_service::router(notebook, PORT, None, None, Some(store.clone())).unwrap();
    let listed = request(&app, "GET", "/api/backups").await.1;
    let expected_size: u64 = [&first.path, &second.path]
        .into_iter()
        .map(|path| {
            std::fs::metadata(path.join("notebook.db")).unwrap().len()
                + std::fs::metadata(path.join("manifest.json")).unwrap().len()
        })
        .sum::<u64>()
        + b"other workshop object".len() as u64
        + b"second other object".len() as u64;
    assert_eq!(
        listed["others"],
        json!([{
            "workshop_id": other_info.id, "count": 2, "size": expected_size,
            "newest_at": second.manifest.created_at, "path": store.join(&other_info.id),
        }])
    );
    assert_eq!(
        request(&app, "DELETE", &format!("/api/backups/others/{}", info.id))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert!(current.path.exists());
    for id in ["bad", "%2e%2e", "a%2Fb", "01ARZ3NDEKTSV4RRFFQ69G5FAI"] {
        assert_eq!(
            request(&app, "DELETE", &format!("/api/backups/others/{id}"))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, deleted) = request(
        &app,
        "DELETE",
        &format!("/api/backups/others/{}", other_info.id),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["others"], json!([]));
    assert!(!store.join(&other_info.id).exists());
    assert!(current.path.exists());
}

#[tokio::test]
async fn unavailable_backup_store_returns_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let notebook = Notebook::open(dir.path()).unwrap();
    let app = tessera_service::router(notebook, PORT, None, None, None).unwrap();
    for (method, path) in [
        ("GET", "/api/backups"),
        ("POST", "/api/backups"),
        ("DELETE", "/api/backups/name"),
        ("DELETE", "/api/backups/others/01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ] {
        assert_eq!(request(&app, method, path).await.0, StatusCode::NOT_FOUND);
    }
}
