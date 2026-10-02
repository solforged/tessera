//! The loopback HTTP and WebSocket service that owns one notebook. Browser windows, the CLI and
//! agents reach the notebook only through its operation API.

mod assets;
mod error;
mod ownership;
mod security;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    middleware,
    response::Response,
    routing::{get, post},
};
use serde::Deserialize;
use tessera_core::{
    Backlink, Batch, Block, BlockInPage, ChangeEvent, Committed, Notebook, NotebookInfo, PageView,
};
use tokio::sync::broadcast;

use crate::error::ApiError;
use crate::ownership::Ownership;
pub use crate::security::validate_dev_origin;

pub const DEFAULT_PORT: u16 = 4318;

pub struct Config {
    /// Notebook directory; created if missing.
    pub notebook: PathBuf,
    pub port: u16,
    /// Built browser editor (`web/dist`). Without it only `/api` is served.
    pub assets: Option<PathBuf>,
    /// Extra allowed browser origin for the Vite dev server.
    pub dev_origin: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    notebook: Arc<Mutex<Notebook>>,
    assets: Option<Arc<PathBuf>>,
    changes: broadcast::Sender<i64>,
}

/// Build the HTTP router. `port` must be the port the listener actually bound,
/// because host and origin checks compare against it.
pub fn router(
    notebook: Notebook,
    port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
) -> Result<Router, String> {
    let policy = security::RequestPolicy::new(port, dev_origin)?;
    let state = AppState {
        notebook: Arc::new(Mutex::new(notebook)),
        assets: assets.map(Arc::new),
        changes: broadcast::channel(256).0,
    };
    Ok(Router::new()
        .route("/api/notebook", get(notebook_info))
        .route("/api/roots", get(roots))
        .route("/api/pages/{id}", get(page))
        .route("/api/pages/by-title/{title}", get(page_by_title))
        .route("/api/journal/{date}", get(journal))
        .route("/api/blocks/{id}", get(block))
        .route("/api/blocks/{id}/backlinks", get(backlinks))
        .route("/api/types/{id}/members", get(members))
        .route("/api/complete", get(complete))
        .route("/api/search", get(search))
        .route("/api/changes", get(changes))
        .route("/api/changes/stream", get(change_stream))
        .route("/api/batches", post(apply))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(policy, security::protect))
        .with_state(state))
}

/// Hold exclusive notebook ownership, bind loopback, and drain on termination.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    if let Some(origin) = &config.dev_origin {
        validate_dev_origin(origin).map_err(anyhow::Error::msg)?;
    }
    let dir = config.notebook.clone();
    let requested_port = config.port;
    let (notebook, mut ownership) = tokio::task::spawn_blocking(move || {
        let ownership = Ownership::acquire(&dir, requested_port)?;
        let notebook = Notebook::open(&dir)
            .with_context(|| format!("cannot open notebook {}", dir.display()))?;
        Ok::<_, anyhow::Error>((notebook, ownership))
    }).await??;
    let shutdown = shutdown_signal().context("cannot register service shutdown signals")?;
    let path = notebook.info()?.path;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .context("cannot bind the local HTTP port")?;
    let port = listener.local_addr()?.port();
    ownership.record(Some(port))?;
    let app =
        router(notebook, port, config.assets, config.dev_origin).map_err(anyhow::Error::msg)?;
    eprintln!("tessera: http://127.0.0.1:{port}");
    eprintln!("tessera: notebook {}", path.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    drop(ownership);
    Ok(())
}

fn shutdown_signal() -> std::io::Result<impl Future<Output = ()>> {
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    Ok(async move {
        #[cfg(unix)]
        let terminated = async move {
            let _ = terminate.recv().await;
        };
        #[cfg(not(unix))]
        let terminated = std::future::pending::<()>();
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    eprintln!("tessera: Ctrl-C handler failed; draining service: {error}");
                }
            }
            () = terminated => {}
        }
    })
}

async fn notebook_info(State(state): State<AppState>) -> Result<Json<NotebookInfo>, ApiError> {
    run(&state, |notebook| notebook.info()).await.map(Json)
}

#[derive(Deserialize)]
struct Limit {
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    50
}

#[derive(Deserialize)]
struct TextQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Deserialize)]
struct ChangesQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "default_limit")]
    limit: usize,
}

async fn roots(State(state): State<AppState>) -> Result<Json<Vec<Block>>, ApiError> {
    run(&state, |notebook| notebook.roots()).await.map(Json)
}

async fn page(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<PageView>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.page(&id))
        .await
        .map(Json)
}

async fn page_by_title(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(title) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook
            .page_by_title(&title)?
            .ok_or(tessera_core::Error::NotFound {
                id: title,
                op_index: None,
            })
    })
    .await
    .map(Json)
}

async fn journal(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(date) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook
            .journal(&date)?
            .ok_or(tessera_core::Error::NotFound {
                id: date,
                op_index: None,
            })
    })
    .await
    .map(Json)
}

async fn block(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.block(&id))
        .await
        .map(Json)
}

async fn backlinks(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<Vec<Backlink>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.backlinks(&id, query.limit))
        .await
        .map(Json)
}

async fn members(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<Vec<BlockInPage>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.members(&id, query.limit))
        .await
        .map(Json)
}

async fn complete(
    State(state): State<AppState>,
    query: Result<Query<TextQuery>, QueryRejection>,
) -> Result<Json<Vec<Block>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.complete(&query.q, query.limit)
    })
    .await
    .map(Json)
}

async fn search(
    State(state): State<AppState>,
    query: Result<Query<TextQuery>, QueryRejection>,
) -> Result<Json<Vec<BlockInPage>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.search(&query.q, query.limit)
    })
    .await
    .map(Json)
}

async fn changes(
    State(state): State<AppState>,
    query: Result<Query<ChangesQuery>, QueryRejection>,
) -> Result<Json<Vec<ChangeEvent>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.changes_since(query.after, query.limit)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct StreamQuery {
    #[serde(default)]
    after: i64,
}

async fn change_stream(
    State(state): State<AppState>,
    query: Result<Query<StreamQuery>, QueryRejection>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    // Subscribe before reading history. A commit in either phase is observed
    // by history, the receiver, or both; the cursor removes the overlap.
    let receiver = state.changes.subscribe();
    Ok(upgrade.on_upgrade(move |socket| stream_changes(socket, state, receiver, query.after)))
}

async fn catch_up(socket: &mut WebSocket, state: &AppState, after: &mut i64) -> Result<(), ()> {
    loop {
        let cursor = *after;
        let changes = run(state, move |notebook| notebook.changes_since(cursor, 100))
            .await
            .map_err(|_| ())?;
        if changes.is_empty() {
            return Ok(());
        }
        for change in changes {
            if change.seq > *after {
                let text = serde_json::to_string(&change).map_err(|_| ())?;
                socket
                    .send(Message::Text(text.into()))
                    .await
                    .map_err(|_| ())?;
                *after = change.seq;
            }
        }
    }
}

async fn stream_changes(
    mut socket: WebSocket,
    state: AppState,
    mut receiver: broadcast::Receiver<i64>,
    mut after: i64,
) {
    if catch_up(&mut socket, &state, &mut after).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            notification = receiver.recv() => {
                match notification {
                    Ok(seq) if seq <= after => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                    // A slow consumer may overflow notifications, never history.
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                }
                if catch_up(&mut socket, &state, &mut after).await.is_err() {
                    return;
                }
            }
            message = socket.recv() => {
                if matches!(message, None | Some(Err(_)) | Some(Ok(Message::Close(_)))) {
                    return;
                }
            }
        }
    }
}

async fn apply(
    State(state): State<AppState>,
    body: Result<Json<Batch>, JsonRejection>,
) -> Result<Json<Committed>, ApiError> {
    let Json(batch) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let committed = notebook.apply(&batch)?;
        if !committed.replayed {
            // Publish while the writer lock is still held, in commit order.
            let _ = changes.send(committed.seq);
        }
        Ok(committed)
    })
    .await
    .map(Json)
}

/// Run a notebook operation off the async runtime.
async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    let notebook = state.notebook.clone();
    tokio::task::spawn_blocking(move || {
        let mut notebook = notebook
            .lock()
            .map_err(|_| ApiError::internal("notebook lock poisoned"))?;
        operation(&mut notebook).map_err(ApiError::from)
    })
    .await
    .map_err(ApiError::internal)?
}
