use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State, rejection::PathRejection},
    routing::{get, post},
};
use serde::Serialize;
use tessera_core::NotebookInfo;

use crate::error::ApiError;
use crate::state::{AppState, run};

pub(crate) fn backup_routes() -> Router<AppState> {
    Router::new()
        .route("/api/backups", get(backups).post(create_backup))
        .route("/api/backups/{name}", axum::routing::delete(delete_backup))
        .route("/api/backups/{name}/restore", post(restore_backup))
        .route(
            "/api/backups/others/{workshop_id}",
            axum::routing::delete(delete_other_backups),
        )
}

#[derive(Serialize)]
struct BackupInfo {
    path: PathBuf,
    name: String,
    created_at: i64,
    object_count: u64,
    size: u64,
    /// What an update or restore safety backup was taken before.
    safety: Option<tessera_core::Safety>,
}

#[derive(Serialize)]
struct OtherBackups {
    workshop_id: String,
    /// The folder name recorded by its newest backup, when it recorded one.
    name: Option<String>,
    count: usize,
    size: u64,
    newest_at: Option<i64>,
    path: PathBuf,
}

#[derive(Serialize)]
struct Backups {
    backups: Vec<BackupInfo>,
    store_size: u64,
    others: Vec<OtherBackups>,
    /// The latest automatic backup's failure, until a later backup succeeds.
    automatic_failure: Option<BackupFailure>,
}

/// Serializes store backups. It holds the latest automatic backup failure,
/// which lives only in memory: a restart retries within two minutes.
pub(crate) type BackupLock = Arc<tokio::sync::Mutex<Option<BackupFailure>>>;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackupFailure {
    pub(crate) at: i64,
    pub(crate) message: String,
}

#[derive(Serialize)]
struct CreatedBackup {
    created: bool,
    backups: Backups,
}

#[derive(Serialize)]
struct RestoringBackup {
    restoring: bool,
    backup: BackupInfo,
    safety: Option<BackupInfo>,
}

fn backup_store(state: &AppState) -> Result<PathBuf, ApiError> {
    state.backup_store.clone().ok_or_else(ApiError::not_found)
}

fn backup_directory(store: &std::path::Path, info: &NotebookInfo) -> Result<PathBuf, ApiError> {
    tessera_core::backup_directory(store, &info.id).map_err(ApiError::from)
}

pub(crate) fn backup_size(path: &std::path::Path, exclusive: bool) -> Result<u64, ApiError> {
    fn visit(
        path: &std::path::Path,
        exclusive: bool,
        seen: &mut std::collections::HashSet<(u64, u64)>,
    ) -> std::io::Result<u64> {
        let entries = match std::fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut size = 0;
        for entry in entries {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                size += visit(&entry.path(), exclusive, seen)?;
            } else if kind.is_file() {
                let metadata = entry.metadata()?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if (exclusive && metadata.nlink() > 1)
                        || !seen.insert((metadata.dev(), metadata.ino()))
                    {
                        continue;
                    }
                }
                size += metadata.len();
            }
        }
        Ok(size)
    }
    visit(path, exclusive, &mut std::collections::HashSet::new()).map_err(ApiError::internal)
}

fn valid_workshop_id(id: &str) -> bool {
    id.parse::<ulid::Ulid>()
        .is_ok_and(|value| value.to_string() == id)
}

fn backup_info(
    path: PathBuf,
    manifest: tessera_core::BackupManifest,
) -> Result<BackupInfo, ApiError> {
    Ok(BackupInfo {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size: backup_size(&path, true)?,
        path,
        created_at: manifest.created_at,
        object_count: manifest.object_count,
        safety: manifest.safety,
    })
}

fn list_backups(store: &std::path::Path, info: &NotebookInfo) -> Result<Backups, ApiError> {
    let backups = tessera_core::finished_backups(store, &info.id)
        .map_err(ApiError::from)?
        .into_iter()
        .map(|(path, manifest)| backup_info(path, manifest))
        .collect::<Result<Vec<_>, ApiError>>()?;
    let mut others = Vec::new();
    match std::fs::read_dir(store) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(ApiError::internal)?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if id == info.id
                    || !valid_workshop_id(&id)
                    || !entry.file_type().map_err(ApiError::internal)?.is_dir()
                {
                    continue;
                }
                let finished =
                    tessera_core::finished_backups(store, &id).map_err(ApiError::from)?;
                others.push(OtherBackups {
                    name: finished
                        .first()
                        .and_then(|(_, manifest)| manifest.workshop_name.clone()),
                    workshop_id: id,
                    count: finished.len(),
                    newest_at: finished.first().map(|(_, manifest)| manifest.created_at),
                    size: backup_size(&entry.path(), false)?,
                    path: entry.path(),
                });
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(ApiError::internal(error)),
    }
    others.sort_by(|a, b| {
        b.newest_at
            .cmp(&a.newest_at)
            .then_with(|| a.workshop_id.cmp(&b.workshop_id))
    });
    Ok(Backups {
        backups,
        store_size: backup_size(&backup_directory(store, info)?, false)?,
        others,
        automatic_failure: None,
    })
}

async fn backups(State(state): State<AppState>) -> Result<Json<Backups>, ApiError> {
    let store = backup_store(&state)?;
    let guard = state.backup.clone().lock_owned().await;
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || {
        let failure = guard.clone();
        list_backups(&store, &info).map(|backups| {
            Json(Backups {
                automatic_failure: failure,
                ..backups
            })
        })
    })
    .await
    .map_err(ApiError::internal)?
}

fn validate_backup_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_path",
            "The backup name must be one plain path component.",
        ));
    }
    Ok(())
}

async fn delete_backup(
    State(state): State<AppState>,
    name: Result<Path<String>, PathRejection>,
) -> Result<Json<Backups>, ApiError> {
    let store = backup_store(&state)?;
    let Path(name) = name.map_err(ApiError::from)?;
    validate_backup_name(&name)?;
    let guard = state.backup.clone().lock_owned().await;
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || {
        let backups = list_backups(&store, &info)?.backups;
        let index = backups
            .iter()
            .position(|backup| backup.name == name)
            .ok_or_else(ApiError::not_found)?;
        if index == 0 {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "conflict",
                "The newest backup is kept as a restore point.",
            ));
        }
        std::fs::remove_dir_all(&backups[index].path).map_err(ApiError::internal)?;
        list_backups(&store, &info).map(|backups| {
            Json(Backups {
                automatic_failure: guard.clone(),
                ..backups
            })
        })
    })
    .await
    .map_err(ApiError::internal)?
}

async fn restore_backup(
    State(state): State<AppState>,
    name: Result<Path<String>, PathRejection>,
) -> Result<(axum::http::StatusCode, Json<RestoringBackup>), ApiError> {
    let Path(name) = name.map_err(ApiError::from)?;
    validate_backup_name(&name)?;
    let switcher = state.switcher.clone().ok_or_else(|| {
        ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "not_found",
            "This service cannot restore while serving a workshop by path.",
        )
    })?;
    let conflict = || {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "conflict",
            "A backup or workshop switch is already running.",
        )
    };
    let guard = state
        .backup
        .clone()
        .try_lock_owned()
        .map_err(|_| conflict())?;
    let transition = switcher
        .transition
        .clone()
        .try_lock_owned()
        .map_err(|_| conflict())?;
    if switcher.request.borrow().is_some() {
        return Err(conflict());
    }
    let store = backup_store(&state)?;
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || {
        // Both guards outlive cancellation, including publishing the restart request.
        let (_guard, _transition) = (guard, transition);
        let backup = list_backups(&store, &info)?
            .backups
            .into_iter()
            .find(|backup| backup.name == name)
            .ok_or_else(ApiError::not_found)?;
        let saved = tessera_core::backup_to_store_preserving(&info.path, &store, &backup.path)
            .map_err(ApiError::internal)?;
        let safety = if saved.created {
            Some(backup_info(saved.path, saved.manifest)?)
        } else {
            None
        };
        let source = std::fs::canonicalize(&backup.path).map_err(ApiError::internal)?;
        crate::serve::write_pending_restore(&info.path, source).map_err(ApiError::internal)?;
        switcher.request.send_replace(Some(info.path));
        Ok((
            axum::http::StatusCode::ACCEPTED,
            Json(RestoringBackup {
                restoring: true,
                backup,
                safety,
            }),
        ))
    })
    .await
    .map_err(ApiError::internal)?
}

async fn delete_other_backups(
    State(state): State<AppState>,
    id: Result<Path<String>, PathRejection>,
) -> Result<Json<Backups>, ApiError> {
    let store = backup_store(&state)?;
    let Path(id) = id.map_err(ApiError::from)?;
    if !valid_workshop_id(&id) {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_path",
            "The workshop id must be a ULID.",
        ));
    }
    let guard = state.backup.clone().lock_owned().await;
    let info = run(&state, |notebook| notebook.info()).await?;
    if info.id == id {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "conflict",
            "Delete the open workshop's backups one at a time.",
        ));
    }
    tokio::task::spawn_blocking(move || {
        let other = list_backups(&store, &info)?
            .others
            .into_iter()
            .find(|other| other.workshop_id == id)
            .ok_or_else(ApiError::not_found)?;
        std::fs::remove_dir_all(other.path).map_err(ApiError::internal)?;
        list_backups(&store, &info).map(|backups| {
            Json(Backups {
                automatic_failure: guard.clone(),
                ..backups
            })
        })
    })
    .await
    .map_err(ApiError::internal)?
}

async fn create_backup(State(state): State<AppState>) -> Result<Json<CreatedBackup>, ApiError> {
    let store = backup_store(&state)?;
    let guard = state.backup.clone().try_lock_owned().map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "conflict",
            "A backup is already running.",
        )
    })?;
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || {
        // Keep the guard here so cancelling the HTTP request cannot release it early.
        let mut guard = guard;
        let backup = tessera_core::backup_to_store(&info.path, &store).map_err(ApiError::from)?;
        // A backup that works answers the automatic one's failure.
        *guard = None;
        Ok(Json(CreatedBackup {
            created: backup.created,
            backups: list_backups(&store, &info)?,
        }))
    })
    .await
    .map_err(ApiError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
        routing::post,
    };
    use parking_lot::Mutex;
    use tessera_core::Notebook;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use crate::agent;
    use crate::library;
    use crate::pairing;
    use crate::state::hub_objects;

    #[tokio::test]
    async fn backup_rejects_concurrent_requests_and_releases_guard_after_failure() {
        let dir = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(dir.path().join("notebook")).unwrap(),
        ));
        let info = notebook.lock().info().unwrap();
        let changes = broadcast::channel(32).0;
        let library =
            library::Library::start(notebook.clone(), changes.clone(), library::extract).unwrap();
        let backup = Arc::new(tokio::sync::Mutex::new(None));
        let app = Router::new()
            .route("/api/backups", post(create_backup))
            .with_state(AppState {
                notebook,
                assets: None,
                changes,
                library,
                objects: hub_objects(),
                port: 4396,
                backup: backup.clone(),
                backup_store: Some(dir.path().join("backups")),
                sync_port: 4501,
                pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
                sharing: Arc::new(tokio::sync::Mutex::new(())),
                replica: Arc::default(),
                sync_health: Arc::default(),
                switcher: None,
                agent: Arc::new(agent::Runtime::new(Some(dir.path().join("agent.json"))).unwrap()),
            });
        let guard = backup.clone().try_lock_owned().unwrap();
        let response = app
            .clone()
            .oneshot(Request::post("/api/backups").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error["error"]["code"], "conflict");
        drop(guard);

        let blocked = info.path.parent().unwrap().join("backups");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let response = app
            .clone()
            .oneshot(Request::post("/api/backups").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(backup.try_lock().is_ok());
        std::fs::remove_file(blocked).unwrap();
        let response = app
            .oneshot(Request::post("/api/backups").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(backup.try_lock().is_ok());
    }

    #[tokio::test]
    async fn automatic_failures_list_until_a_backup_succeeds() {
        async fn json(app: &Router, method: &str) -> serde_json::Value {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/api/backups")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{method}");
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice(&bytes).unwrap()
        }
        let dir = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(dir.path().join("notebook")).unwrap(),
        ));
        let changes = broadcast::channel(32).0;
        let library =
            library::Library::start(notebook.clone(), changes.clone(), library::extract).unwrap();
        let backup = Arc::new(tokio::sync::Mutex::new(Some(BackupFailure {
            at: 7,
            message: "disk full".into(),
        })));
        let app = backup_routes().with_state(AppState {
            notebook,
            assets: None,
            changes,
            library,
            objects: hub_objects(),
            port: 4396,
            backup,
            backup_store: Some(dir.path().join("backups")),
            sync_port: 4501,
            pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
            sharing: Arc::new(tokio::sync::Mutex::new(())),
            replica: Arc::default(),
            sync_health: Arc::default(),
            switcher: None,
            agent: Arc::new(agent::Runtime::new(Some(dir.path().join("agent.json"))).unwrap()),
        });
        let listed = json(&app, "GET").await;
        assert_eq!(
            listed["automatic_failure"],
            serde_json::json!({"at": 7, "message": "disk full"})
        );
        let created = json(&app, "POST").await;
        assert!(created["backups"]["automatic_failure"].is_null());
        assert!(json(&app, "GET").await["automatic_failure"].is_null());
    }

    fn backup_fixture() -> (tempfile::TempDir, Router, NotebookInfo) {
        let dir = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(dir.path().join("notebook")).unwrap(),
        ));
        let info = notebook.lock().info().unwrap();
        let changes = broadcast::channel(32).0;
        let library =
            library::Library::start(notebook.clone(), changes.clone(), library::extract).unwrap();
        let app = backup_routes().with_state(AppState {
            notebook,
            assets: None,
            changes,
            library,
            objects: hub_objects(),
            port: 4561,
            backup: Arc::new(tokio::sync::Mutex::new(None)),
            backup_store: Some(dir.path().join("backups")),
            sync_port: 4562,
            pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
            sharing: Arc::new(tokio::sync::Mutex::new(())),
            replica: Arc::default(),
            sync_health: Arc::default(),
            switcher: None,
            agent: Arc::new(agent::Runtime::new(Some(dir.path().join("agent.json"))).unwrap()),
        });
        for created_at in 1..=4 {
            let path = backup_directory(&info.path.parent().unwrap().join("backups"), &info)
                .ok()
                .unwrap()
                .join(format!("backup-{created_at}"));
            std::fs::create_dir_all(path.join("objects/nested")).unwrap();
            std::fs::write(path.join("notebook.db"), b"database").unwrap();
            std::fs::write(path.join("objects/nested/object"), b"object").unwrap();
            let manifest = tessera_core::BackupManifest {
                notebook_id: info.id.clone(),
                schema_version: 1,
                created_at,
                object_count: 1,
                db_page_count: 1,
                database_sha256: String::new(),
                safety: None,
                workshop_name: None,
            };
            std::fs::write(
                path.join("manifest.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }
        (dir, app, info)
    }

    #[tokio::test]
    async fn delete_backup_refuses_newest() {
        let (_dir, app, info) = backup_fixture();
        let response = app
            .oneshot(
                Request::delete("/api/backups/backup-4")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(
            backup_directory(&info.path.parent().unwrap().join("backups"), &info)
                .ok()
                .unwrap()
                .join("backup-4")
                .exists()
        );
    }

    #[tokio::test]
    async fn delete_backup_refuses_traversal_names() {
        let (_dir, app, _info) = backup_fixture();
        for name in ["", ".", "..", "../backup", "backup/child", "backup\\child"] {
            assert!(validate_backup_name(name).is_err());
        }
        for path in [
            "/api/backups/%2e%2e",
            "/api/backups/a%2Fb",
            "/api/backups/a%5Cb",
        ] {
            let response = app
                .clone()
                .oneshot(Request::delete(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        }
    }

    #[tokio::test]
    async fn delete_backup_removes_earlier_and_returns_new_list() {
        let (_dir, app, info) = backup_fixture();
        let response = app
            .clone()
            .oneshot(
                Request::delete("/api/backups/backup-2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let values: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(values["backups"].as_array().unwrap().len(), 3);
        assert_eq!(values["backups"][0]["created_at"], 4);
        assert!(
            !backup_directory(&info.path.parent().unwrap().join("backups"), &info)
                .ok()
                .unwrap()
                .join("backup-2")
                .exists()
        );
        let response = app
            .oneshot(
                Request::delete("/api/backups/unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn backup_routes_ignore_unfinished_and_foreign_manifests() {
        let (_dir, app, info) = backup_fixture();
        let root = backup_directory(&info.path.parent().unwrap().join("backups"), &info)
            .ok()
            .unwrap();
        std::fs::create_dir(root.join("unfinished")).unwrap();
        std::fs::write(root.join("unfinished/notebook.db"), b"in progress").unwrap();
        std::fs::create_dir(root.join("foreign")).unwrap();
        let foreign = tessera_core::BackupManifest {
            notebook_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            schema_version: 1,
            created_at: 0,
            object_count: 0,
            db_page_count: 1,
            database_sha256: String::new(),
            safety: None,
            workshop_name: None,
        };
        std::fs::write(
            root.join("foreign/manifest.json"),
            serde_json::to_vec(&foreign).unwrap(),
        )
        .unwrap();
        for name in ["foreign", "unfinished"] {
            let response = app
                .clone()
                .oneshot(
                    Request::delete(format!("/api/backups/{name}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(root.join(name).exists());
        }
        let response = app
            .oneshot(Request::get("/api/backups").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let listed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(listed["backups"].as_array().unwrap().len(), 4);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn backup_sizes_count_nested_regular_files_without_following_symlinks() {
        let (dir, app, info) = backup_fixture();
        let root = backup_directory(&info.path.parent().unwrap().join("backups"), &info)
            .ok()
            .unwrap();
        let path = root.join("backup-4");
        std::fs::write(dir.path().join("outside"), [0; 1024]).unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside"), path.join("objects/link")).unwrap();
        std::os::unix::fs::symlink(dir.path(), path.join("objects/directory-link")).unwrap();
        std::os::unix::fs::symlink(&path, root.join("directory-link")).unwrap();
        let expected = 14 + std::fs::metadata(path.join("manifest.json")).unwrap().len();
        let response = app
            .oneshot(Request::get("/api/backups").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let values: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(values["backups"].as_array().unwrap().len(), 4);
        assert_eq!(values["backups"][0]["size"], expected);
    }
}
