use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Router,
    extract::{DefaultBodyLimit, State},
    middleware,
    response::Response,
    routing::get,
};
use parking_lot::Mutex;
use tessera_core::Notebook;
use tokio::sync::broadcast;

use crate::agent;
use crate::assets;
use crate::error::ApiError;
use crate::info::{notebook_size, service_info};
use crate::notebooks;
use crate::pairing;
use crate::replica;
use crate::security;
use crate::state::{AppState, hub_objects, run};
use crate::stream::change_stream;
use crate::sync;
use crate::{backups, library};
use tessera_api::images;

pub fn router(
    notebook: Notebook,
    port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
    backup_store: Option<PathBuf>,
) -> Result<Router, String> {
    let sync_port = port
        .checked_add(1)
        .ok_or("the sync port needs an explicit value")?;
    Ok(routers(
        notebook,
        port,
        sync_port,
        assets,
        dev_origin,
        None,
        None,
        backup_store,
    )?
    .0)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn routers(
    notebook: Notebook,
    port: u16,
    sync_port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
    switcher: Option<Arc<notebooks::Switcher>>,
    agent_path: Option<PathBuf>,
    backup_store: Option<PathBuf>,
) -> Result<(Router, Router, AppState), String> {
    let policy = security::RequestPolicy::new(port, dev_origin)?;
    let readers = tessera_api::Readers::open(&notebook).map_err(|error| error.to_string())?;
    let notebook = Arc::new(Mutex::new(notebook));
    let notifications = broadcast::channel(256).0;
    let library =
        library::Library::start(notebook.clone(), notifications.clone(), library::extract)?;
    let state = AppState {
        notebook,
        readers: Some(readers),
        assets: assets.map(Arc::new),
        changes: notifications,
        library,
        objects: hub_objects(),
        port,
        backup: Arc::new(tokio::sync::Mutex::new(None)),
        backup_store,
        sync_port,
        pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
        sharing: Arc::new(tokio::sync::Mutex::new(())),
        replica: Arc::default(),
        sync_health: Arc::default(),
        switcher,
        agent: Arc::new(agent::Runtime::new(agent_path)?),
    };
    replica::start(
        state.notebook.clone(),
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
    let editor = notebook_routes()
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
        .layer(middleware::from_fn_with_state(state.clone(), same_notebook))
        .layer(middleware::from_fn_with_state(policy, security::protect))
        .with_state(state.clone());
    Ok((editor, sync, state))
}

/// Refuse a window's request meant for another notebook, named by the `X-Tessera-Notebook`
/// header or, for the change stream, the `notebook` query parameter. A switch or a replica
/// reclone changes the notebook behind a port; an old window must not write into the new one.
pub(crate) async fn same_notebook(
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
        match run(&state, |notebook| notebook.info()).await {
            Ok(info) if info.id != expected => {
                return ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "notebook_changed",
                    format!("The service now has {} open.", info.path.display()),
                )
                .into_response();
            }
            Ok(_) => {}
            Err(error) => return error.into_response(),
        }
    }
    next.run(request).await
}

pub(crate) fn notebook_routes() -> Router<AppState> {
    tessera_api::workshop_routes()
        .route("/api/notebook/size", get(notebook_size))
        .merge(replica::routes())
}

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

#[cfg(test)]
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
        let notebook = Notebook::open(dir.path().join("workshop")).unwrap();
        let (editor, _sync, state) = routers(
            notebook,
            4318,
            4319,
            None,
            None,
            None,
            Some(dir.path().join("agent.json")),
            None,
        )
        .unwrap();
        // Hold the writer as a long save or sync apply would.
        let writer = state.notebook.clone();
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
