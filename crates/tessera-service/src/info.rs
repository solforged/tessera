#[cfg(feature = "hub")]
use std::path::PathBuf;

use axum::{Json, extract::State};
use serde::Serialize;

use crate::error::ApiError;
use crate::state::AppState;
#[cfg(feature = "hub")]
use crate::{BUILD, VERSION, launch_agent_path};

#[derive(Serialize, ts_rs::TS)]
pub(crate) struct WorkshopSize {
    size: u64,
}

/// What the workshop takes on disk, for Settings › About. Each file counts once, including its write-ahead log.
pub(crate) async fn workshop_size(
    State(state): State<AppState>,
) -> Result<Json<WorkshopSize>, ApiError> {
    let path = state.info.read().path.clone();
    tokio::task::spawn_blocking(move || crate::backups::backup_size(&path, false))
        .await
        .map_err(ApiError::internal)?
        .map(|size| Json(WorkshopSize { size }))
}

#[cfg(feature = "hub")]
#[derive(Serialize, ts_rs::TS)]
pub(crate) struct LaunchAgentInfo {
    installed: bool,
    path: Option<PathBuf>,
}

#[cfg(feature = "hub")]
#[derive(Serialize, ts_rs::TS)]
pub(crate) struct ServiceInfo {
    version: &'static str,
    /// The commit a release or `ts-ship` built from; absent in development builds.
    build: Option<&'static str>,
    port: u16,
    #[ts(type = "\"embedded\" | \"directory\" | \"none\"")]
    assets: &'static str,
    launch_agent: LaunchAgentInfo,
}

#[cfg(feature = "hub")]
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
    use tessera_core::Workshop;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use crate::agent;
    use crate::library;
    use crate::state::AppState;

    #[tokio::test]
    async fn workshop_size_counts_every_file_in_the_workshop_folder() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Arc::new(Mutex::new(
            Workshop::open(dir.path().join("notebook")).unwrap(),
        ));
        let info = workshop.lock().info().unwrap();
        let changes = broadcast::channel(32).0;
        let library =
            library::Library::start(workshop.clone(), changes.clone(), library::extract).unwrap();
        let replica: Arc<crate::replica::ReplicaRuntime> = Arc::default();
        let app = Router::new()
            .route("/api/notebook/size", get(workshop_size))
            .with_state(AppState::embedded(
                workshop,
                Arc::new(parking_lot::RwLock::new(info.clone())),
                None,
                changes,
                library,
                replica,
                Arc::new(tokio::sync::Mutex::new(None)),
                Some(dir.path().join("backups")),
                Arc::new(agent::Runtime::new(Some(dir.path().join("agent.json"))).unwrap()),
            ));
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
