//! The loopback HTTP and WebSocket service that owns one notebook. Browser windows, the CLI and
//! agents reach the notebook only through its operation API.
//! `GET /api/service` reports local runtime details. `POST /api/backups` takes a
//! portable snapshot, and `GET /api/backups` lists completed snapshots newest first.

mod assets;
mod capabilities;
mod error;
pub mod library;
mod security;

use parking_lot::Mutex;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;

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
use serde::{Deserialize, Serialize};
use tessera_core::{
    Backlink, Batch, Block, BlockInPage, ChangeEvent, Committed, FieldsView, Notebook,
    NotebookInfo, PageView, QueryResult, SettingsView, TypeInfo, View,
};
use tokio::sync::broadcast;

use crate::error::ApiError;
pub use crate::security::validate_dev_origin;
use tessera_core::NotebookOwnership;

pub const DEFAULT_PORT: u16 = 4318;

pub const LAUNCH_AGENT_LABEL: &str = "dev.tessera.serve";

/// The per-user launch agent location. This does not invoke launchctl.
pub fn launch_agent_path(home: &std::path::Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}

pub struct Config {
    /// Notebook directory; created if missing.
    pub notebook: PathBuf,
    pub port: u16,
    /// Override embedded browser assets with a built directory (`web/dist`).
    pub assets: Option<PathBuf>,
    /// Extra allowed browser origin for the Vite dev server.
    pub dev_origin: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    notebook: Arc<Mutex<Notebook>>,
    assets: Option<Arc<PathBuf>>,
    changes: broadcast::Sender<i64>,
    library: library::Library,
    port: u16,
    backup: Arc<tokio::sync::Mutex<()>>,
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
    let notebook = Arc::new(Mutex::new(notebook));
    let notifications = broadcast::channel(256).0;
    let library =
        library::Library::start(notebook.clone(), notifications.clone(), library::extract)?;
    let state = AppState {
        notebook,
        assets: assets.map(Arc::new),
        changes: notifications,
        library,
        port,
        backup: Arc::new(tokio::sync::Mutex::new(())),
    };
    Ok(Router::new()
        .route("/api/notebook", get(notebook_info))
        .route("/api/service", get(service_info))
        .route("/api/backups", get(backups).post(create_backup))
        .route("/api/settings", get(settings))
        .route("/api/roots", get(roots))
        .route("/api/pages/{id}", get(page))
        .route("/api/pages/by-title/{title}", get(page_by_title))
        .route("/api/journal/{date}", get(journal))
        .route("/api/blocks/{id}", get(block))
        .route("/api/blocks/{id}/backlinks", get(backlinks))
        .route("/api/types/{id}/members", get(members))
        .route("/api/blocks/{id}/capabilities", get(capabilities::block))
        .route(
            "/api/blocks/{id}/task-occurrences",
            get(capabilities::task_occurrences),
        )
        .route(
            "/api/blocks/{id}/work-sessions",
            get(capabilities::work_sessions),
        )
        .route(
            "/api/work-sessions/active",
            get(capabilities::active_work_session),
        )
        .route("/api/projects", get(capabilities::projects))
        .route("/api/tasks/query", post(capabilities::task_query))
        .route("/api/agenda/{date}", get(capabilities::agenda))
        .route("/api/task-views", get(capabilities::task_views))
        .route("/api/task-views/{id}", get(capabilities::task_view))
        .route("/api/blocks/{id}/cards", get(capabilities::source_cards))
        .route("/api/cards/{id}", get(capabilities::card))
        .route("/api/cards/query", post(capabilities::card_query))
        .route("/api/cards/{id}/previews", get(capabilities::card_previews))
        .route("/api/cards/{id}/reviews", get(capabilities::card_reviews))
        .route("/api/decks", get(capabilities::decks))
        .route("/api/decks/{id}", get(capabilities::deck))
        .route("/api/review-sessions", get(capabilities::review_sessions))
        .route(
            "/api/review-sessions/{id}",
            get(capabilities::review_session),
        )
        .route("/api/types/{id}", get(type_info))
        .route("/api/fields", get(fields))
        .route("/api/query", post(query))
        .route("/api/views", get(views))
        .route("/api/views/{id}", get(view))
        .route("/api/complete", get(complete))
        .route("/api/search", get(search))
        .route("/api/changes", get(changes))
        .route("/api/changes/stream", get(change_stream))
        .route("/api/batches", post(apply))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
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
        let ownership = NotebookOwnership::acquire(&dir, requested_port)?;
        let notebook = Notebook::open(&dir)
            .with_context(|| format!("cannot open notebook {}", dir.display()))?;
        Ok::<_, anyhow::Error>((notebook, ownership))
    })
    .await??;
    let shutdown = shutdown_signal().context("cannot register service shutdown signals")?;
    let path = notebook.info()?.path;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .context("cannot bind the local HTTP port")?;
    let port = listener.local_addr()?.port();
    ownership.record(Some(port))?;
    let app =
        router(notebook, port, config.assets, config.dev_origin).map_err(anyhow::Error::msg)?;
    tracing::info!(url = %format_args!("http://127.0.0.1:{port}"), "service listening");
    tracing::info!(path = %path.display(), "notebook opened");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    drop(ownership);
    tracing::info!("service stopped");
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
                    tracing::error!(%error, "Ctrl-C handler failed; draining service");
                }
            }
            () = terminated => {}
        }
        tracing::info!("service shutting down");
    })
}

async fn notebook_info(State(state): State<AppState>) -> Result<Json<NotebookInfo>, ApiError> {
    run(&state, |notebook| notebook.info()).await.map(Json)
}

#[derive(Serialize)]
struct LaunchAgentInfo {
    installed: bool,
    path: Option<PathBuf>,
}

#[derive(Serialize)]
struct ServiceInfo {
    version: &'static str,
    /// The commit `scripts/ship` built from; absent in development builds.
    build: Option<&'static str>,
    port: u16,
    assets: &'static str,
    launch_agent: LaunchAgentInfo,
}

async fn service_info(State(state): State<AppState>) -> Result<Json<ServiceInfo>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let path = dirs::home_dir().map(|home| launch_agent_path(&home));
        let installed = path
            .as_ref()
            .map(|path| path.try_exists())
            .transpose()
            .map_err(ApiError::internal)?
            .unwrap_or(false);
        Ok(Json(ServiceInfo {
            version: env!("CARGO_PKG_VERSION"),
            build: option_env!("TESSERA_BUILD"),
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

#[derive(Serialize)]
struct BackupInfo {
    path: PathBuf,
    created_at: i64,
    object_count: u64,
}

#[derive(Serialize)]
struct CreatedBackup {
    path: PathBuf,
    #[serde(flatten)]
    manifest: tessera_core::BackupManifest,
}

fn backup_directory(info: &NotebookInfo) -> Result<PathBuf, ApiError> {
    let parent = info
        .path
        .parent()
        .ok_or_else(|| ApiError::internal("The notebook has no parent directory."))?;
    Ok(parent.join("backups").join(&info.id))
}

async fn backups(State(state): State<AppState>) -> Result<Json<Vec<BackupInfo>>, ApiError> {
    let info = run(&state, |notebook| notebook.info()).await?;
    tokio::task::spawn_blocking(move || {
        let entries = match std::fs::read_dir(backup_directory(&info)?) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Json(Vec::new()));
            }
            Err(error) => return Err(ApiError::internal(error)),
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry.map_err(ApiError::internal)?;
            if !entry.file_type().map_err(ApiError::internal)?.is_dir() {
                continue;
            }
            // The manifest is published last. An interrupted backup is not listed.
            let file = match std::fs::File::open(entry.path().join("manifest.json")) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(ApiError::internal(error)),
            };
            let manifest: tessera_core::BackupManifest =
                serde_json::from_reader(file).map_err(ApiError::internal)?;
            if manifest.notebook_id == info.id {
                backups.push(BackupInfo {
                    path: entry.path(),
                    created_at: manifest.created_at,
                    object_count: manifest.object_count,
                });
            }
        }
        backups.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.path.cmp(&a.path))
        });
        Ok(Json(backups))
    })
    .await
    .map_err(ApiError::internal)?
}

async fn create_backup(State(state): State<AppState>) -> Result<Json<CreatedBackup>, ApiError> {
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
        let _guard = guard;
        let directory = backup_directory(&info)?;
        std::fs::create_dir_all(&directory).map_err(ApiError::internal)?;
        let path = directory.join(
            jiff::Timestamp::now()
                .strftime("%Y-%m-%dT%H-%M-%S")
                .to_string(),
        );
        match std::fs::create_dir(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "conflict",
                    "A backup already exists for this second.",
                ));
            }
            Err(error) => return Err(ApiError::internal(error)),
        }
        let manifest = tessera_core::backup(&info.path, &path).map_err(ApiError::from)?;
        Ok(Json(CreatedBackup { path, manifest }))
    })
    .await
    .map_err(ApiError::internal)?
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

async fn fields(State(state): State<AppState>) -> Result<Json<FieldsView>, ApiError> {
    run(&state, |notebook| notebook.fields()).await.map(Json)
}

async fn type_info(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<TypeInfo>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.type_info(&id))
        .await
        .map(Json)
}

async fn query(
    State(state): State<AppState>,
    body: Result<Json<tessera_core::Query>, JsonRejection>,
) -> Result<Json<QueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.query(&query))
        .await
        .map(Json)
}

async fn views(State(state): State<AppState>) -> Result<Json<Vec<View>>, ApiError> {
    run(&state, |notebook| notebook.views()).await.map(Json)
}

async fn settings(State(state): State<AppState>) -> Result<Json<SettingsView>, ApiError> {
    run(&state, |notebook| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is after 1970");
        notebook.settings_view(i64::try_from(now.as_millis()).expect("timestamp fits in i64"))
    })
    .await
    .map(Json)
}

async fn view(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<View>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.view(&id))
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
        let mut notebook = notebook.lock();
        operation(&mut notebook).map_err(ApiError::from)
    })
    .await
    .map_err(ApiError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

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
        let backup = Arc::new(tokio::sync::Mutex::new(()));
        let app = Router::new()
            .route("/api/backups", post(create_backup))
            .with_state(AppState {
                notebook,
                assets: None,
                changes,
                library,
                port: 4396,
                backup: backup.clone(),
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
        assert_eq!(error["error"]["message"], "A backup is already running.");
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
}
