#[cfg(feature = "hub")]
use std::path::PathBuf;
#[cfg(feature = "hub")]
use std::sync::Arc;

#[cfg(feature = "hub")]
use axum::extract::DefaultBodyLimit;
use axum::{Router, extract::State, middleware, response::Response, routing::get};
#[cfg(feature = "hub")]
use parking_lot::{Mutex, RwLock};
#[cfg(feature = "hub")]
use tessera_core::Workshop;
#[cfg(feature = "hub")]
use tokio::sync::broadcast;

#[cfg(feature = "hub")]
use crate::agent;
#[cfg(feature = "hub")]
use crate::assets;
use crate::error::ApiError;
#[cfg(feature = "hub")]
use crate::info::service_info;
use crate::info::workshop_size;
#[cfg(feature = "hub")]
use crate::notebooks;
#[cfg(feature = "hub")]
use crate::pairing;
use crate::replica;
#[cfg(feature = "hub")]
use crate::security;
use crate::state::AppState;
#[cfg(feature = "hub")]
use crate::state::hub_objects;
#[cfg(feature = "hub")]
use crate::stream::change_stream;
#[cfg(feature = "hub")]
use crate::sync;
#[cfg(feature = "hub")]
use crate::{backups, library};
#[cfg(feature = "hub")]
use tessera_api::images;

#[cfg(feature = "hub")]
pub fn router(
    workshop: Workshop,
    port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
    backup_store: Option<PathBuf>,
) -> Result<Router, String> {
    let sync_port = port
        .checked_add(1)
        .ok_or("the sync port needs an explicit value")?;
    Ok(routers(
        workshop,
        port,
        sync_port,
        assets,
        dev_origin,
        None,
        None,
        backup_store,
        tokio::sync::watch::channel(false).1,
    )?
    .0)
}

#[cfg(feature = "hub")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn routers(
    workshop: Workshop,
    port: u16,
    sync_port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
    switcher: Option<Arc<notebooks::Switcher>>,
    agent_path: Option<PathBuf>,
    backup_store: Option<PathBuf>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(Router, Router, AppState), String> {
    let policy = security::RequestPolicy::new(port, dev_origin)?;
    let info = Arc::new(RwLock::new(
        workshop.info().map_err(|error| error.to_string())?,
    ));
    let readers = tessera_api::Readers::open(&workshop).map_err(|error| error.to_string())?;
    let workshop = Arc::new(Mutex::new(workshop));
    let notifications = broadcast::channel(256).0;
    let library =
        library::Library::start(workshop.clone(), notifications.clone(), library::extract)?;
    let replica_runtime: Arc<replica::ReplicaRuntime> = Arc::default();
    let state = AppState {
        workshop,
        info,
        readers: Some(readers),
        assets: assets.map(Arc::new),
        changes: notifications,
        library,
        objects: hub_objects(replica_runtime.clone()),
        port,
        backup: Arc::new(tokio::sync::Mutex::new(None)),
        backup_store,
        sync_port,
        pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
        sharing: Arc::new(tokio::sync::Mutex::new(())),
        replica: replica_runtime,
        sync_health: Arc::default(),
        switcher,
        agent: Arc::new(agent::Runtime::new(agent_path)?),
        shutdown,
    };
    replica::start(
        state.workshop.clone(),
        state.changes.clone(),
        &state.replica,
    );
    let sync = sync::routes()
        .layer(middleware::from_fn_with_state(
            state.clone(),
            sync::record_health,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            pairing::authenticate,
        ))
        .merge(pairing::public_routes())
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found() })
        .layer(middleware::from_fn(sync::version_headers))
        .with_state(state.clone());
    let editor = workshop_routes()
        .route("/api/service", get(service_info))
        .merge(backups::backup_routes())
        .route("/api/changes/stream", get(change_stream))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
        .merge(images::routes())
        .merge(
            sync::routes()
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    sync::record_health,
                ))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    pairing::authenticate_loopback,
                ))
                .layer(middleware::from_fn(sync::version_headers)),
        )
        .merge(pairing::editor_routes())
        .merge(notebooks::routes())
        .merge(agent::routes())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            refuse_while_switching,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), same_workshop))
        .layer(middleware::from_fn_with_state(policy, security::protect))
        .with_state(state.clone());
    Ok((editor, sync, state))
}

/// Refuse a window's request meant for another workshop, named by the `X-Tessera-Notebook`
/// header or, for the change stream, the `notebook` query parameter. A switch or a replica
/// reclone changes the workshop behind a port; an old window must not write into the new one.
pub(crate) async fn same_workshop(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    use axum::response::IntoResponse;
    let expected = request
        .headers()
        .get("x-tessera-notebook")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .uri()
                .query()?
                .split('&')
                .find_map(|pair| pair.strip_prefix("notebook="))
        })
        .map(str::to_owned);
    if let Some(expected) = expected {
        let info = state.info.read();
        if info.id != expected {
            return ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "notebook_changed",
                format!("The service now has {} open.", info.path.display()),
            )
            .into_response();
        }
    }
    next.run(request).await
}

pub(crate) fn workshop_routes() -> Router<AppState> {
    tessera_api::workshop_routes()
        .route("/api/notebook/size", get(workshop_size))
        .merge(replica::routes())
}

#[cfg(feature = "hub")]
async fn refuse_while_switching(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if request.uri().path() == "/api/notebook"
        && matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD
        )
        && state
            .switcher
            .as_ref()
            .is_some_and(|switcher| switcher.request.borrow().is_some())
    {
        return ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "switching",
            "The workshop is reopening.",
        )
        .into_response();
    }
    next.run(request).await
}

#[cfg(all(test, feature = "hub"))]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn a_read_answers_while_the_writer_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::open(dir.path().join("workshop")).unwrap();
        let (editor, _sync, state) = routers(
            workshop,
            4318,
            4319,
            None,
            None,
            None,
            Some(dir.path().join("agent.json")),
            None,
            tokio::sync::watch::channel(false).1,
        )
        .unwrap();
        // Hold the writer as a long save or sync apply would.
        let writer = state.workshop.clone();
        let (held, wait) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _writer = writer.lock();
            held.send(()).unwrap();
            let _ = released.recv();
        });
        wait.recv().unwrap();

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            editor.oneshot(
                Request::get("/api/roots")
                    .header("host", "127.0.0.1:4318")
                    .header("origin", "http://127.0.0.1:4318")
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .expect("the read waited for the writer")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        release.send(()).unwrap();
        holder.join().unwrap();
    }
}
