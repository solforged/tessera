use std::path::PathBuf;

use axum::{Json, extract::State};
use serde::Serialize;

use crate::error::ApiError;
use crate::state::{AppState, run};
use crate::{BUILD, VERSION, launch_agent_path};

#[derive(Serialize)]
pub(crate) struct NotebookSize {
    size: u64,
}

/// What the workshop takes on disk, for Settings › About. Each file counts once, including its write-ahead log.
pub(crate) async fn notebook_size(
    State(state): State<AppState>,
) -> Result<Json<NotebookSize>, ApiError> {
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || crate::backups::backup_size(&info.path, false))
        .await
        .map_err(ApiError::internal)?
        .map(|size| Json(NotebookSize { size }))
}

#[derive(Serialize)]
pub(crate) struct LaunchAgentInfo {
    installed: bool,
    path: Option<PathBuf>,
}

#[derive(Serialize)]
pub(crate) struct ServiceInfo {
    version: &'static str,
    /// See [`BUILD`].
    build: Option<&'static str>,
    port: u16,
    assets: &'static str,
    launch_agent: LaunchAgentInfo,
}

pub(crate) async fn service_info(
    State(state): State<AppState>,
) -> Result<Json<ServiceInfo>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let path = dirs::home_dir().map(|home| launch_agent_path(&home));
        let installed = path
            .as_ref()
            .map(|path| path.try_exists())
            .transpose()
            .map_err(ApiError::internal)?
            .unwrap_or(false);
        Ok(Json(ServiceInfo {
            version: VERSION,
            build: BUILD,
            port: state.port,
            assets: if state.assets.is_some() {
                "directory"
            } else if cfg!(feature = "embed-web") {
                "embedded"
            } else {
                "none"
            },
            launch_agent: LaunchAgentInfo { installed, path },
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
        routing::get,
    };
    use parking_lot::Mutex;
    use tessera_core::Notebook;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use crate::agent;
    use crate::library;
    use crate::pairing;
    use crate::state::{AppState, hub_objects};

    #[tokio::test]
    async fn notebook_size_counts_every_file_in_the_workshop_folder() {
        let dir = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(dir.path().join("notebook")).unwrap(),
        ));
        let info = notebook.lock().info().unwrap();
        let changes = broadcast::channel(32).0;
        let library =
            library::Library::start(notebook.clone(), changes.clone(), library::extract).unwrap();
        let app = Router::new()
            .route("/api/notebook/size", get(notebook_size))
            .with_state(AppState {
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
        async fn size(app: &Router) -> u64 {
            let response = app
                .clone()
                .oneshot(
                    Request::get("/api/notebook/size")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value["size"].as_u64().unwrap()
        }
        let before = size(&app).await;
        assert!(before > 0);
        std::fs::create_dir_all(info.path.join("objects/ab")).unwrap();
        std::fs::write(info.path.join("objects/ab/object"), [0; 4096]).unwrap();
        assert_eq!(size(&app).await, before + 4096);
    }
}
