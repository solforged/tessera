//! The loopback HTTP and WebSocket service that owns one notebook. Browser windows, the CLI and
//! agents reach the notebook only through its operation API.
//! `GET /api/service` reports local runtime details. `POST /api/backups` takes a
//! portable snapshot, and `GET /api/backups` lists completed snapshots newest first.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod assets;
mod capabilities;
mod error;
pub mod library;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod pairing;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod replica;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod security;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod sharing;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod sync;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub mod sync_client;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub use replica::start_sync_runner;

use parking_lot::Mutex;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::net::Ipv4Addr;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use anyhow::Context;
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    routing::{get, post},
};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    middleware,
    response::Response,
};
use serde::Deserialize;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use serde::Serialize;
use tessera_core::{
    Actor, AgentChange, AgentReceipt, AgentRequest, Backlink, Batch, Block, BlockInPage,
    ChangeEvent, Committed, Completion, FieldsView, KindIndex, NameMatch, NoteIndex, NoteKind,
    Notebook, NotebookInfo, PageView, QueryResult, SettingsView, TypeInfo, UndoReceipt, View,
};
use tokio::sync::broadcast;

use crate::error::ApiError;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub use crate::security::validate_dev_origin;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use tessera_core::NotebookOwnership;

pub const DEFAULT_PORT: u16 = 4318;

/// The workspace version shared by every Tessera binary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The commit a release or `mise run ship` built from; absent in development builds.
pub const BUILD: Option<&str> = option_env!("TESSERA_BUILD");

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub const LAUNCH_AGENT_LABEL: &str = "dev.tessera.serve";

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
/// The per-user launch agent location. This does not invoke launchctl.
pub fn launch_agent_path(home: &std::path::Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub struct Config {
    /// Notebook directory; created if missing.
    pub notebook: PathBuf,
    pub port: u16,
    /// Separate authenticated sync listener; defaults to the editor port plus one.
    pub sync_port: Option<u16>,
    /// Override embedded browser assets with a built directory (`web/dist`).
    pub assets: Option<PathBuf>,
    /// Extra allowed browser origin for the Vite dev server.
    pub dev_origin: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    notebook: Arc<Mutex<Notebook>>,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    assets: Option<Arc<PathBuf>>,
    changes: broadcast::Sender<i64>,
    library: library::Library,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    port: u16,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    backup: Arc<tokio::sync::Mutex<()>>,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    sync_port: u16,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pairing: Arc<Mutex<pairing::Pairing>>,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    sharing: Arc<tokio::sync::Mutex<()>>,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    replica: Arc<replica::ReplicaRuntime>,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
/// Build the HTTP router. `port` must be the port the listener actually bound,
/// because host and origin checks compare against it.
pub fn router(
    notebook: Notebook,
    port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
) -> Result<Router, String> {
    let sync_port = port
        .checked_add(1)
        .ok_or("the sync port needs an explicit value")?;
    Ok(routers(notebook, port, sync_port, assets, dev_origin)?.0)
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn routers(
    notebook: Notebook,
    port: u16,
    sync_port: u16,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
) -> Result<(Router, Router), String> {
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
        sync_port,
        pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
        sharing: Arc::new(tokio::sync::Mutex::new(())),
        replica: Arc::default(),
    };
    replica::start(
        state.notebook.clone(),
        state.changes.clone(),
        &state.replica,
    );
    let sync = sync::routes()
        .layer(middleware::from_fn_with_state(
            state.clone(),
            pairing::authenticate,
        ))
        .merge(pairing::public_routes())
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found() })
        .with_state(state.clone());
    let editor = notebook_routes()
        .route("/api/service", get(service_info))
        .route("/api/backups", get(backups).post(create_backup))
        .route("/api/changes/stream", get(change_stream))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
        .merge(sync::routes())
        .merge(pairing::editor_routes())
        .layer(middleware::from_fn_with_state(policy, security::protect))
        .with_state(state);
    Ok((editor, sync))
}

/// The notebook and commit notifications backing an embedded router.
pub struct EmbeddedHandles {
    pub notebook: Arc<Mutex<Notebook>>,
    pub changes: broadcast::Sender<i64>,
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pub replica: Arc<replica::ReplicaRuntime>,
}

/// Build the notebook and library API for a host that runs the notebook in its own process,
/// such as the browser worker or the Android app. It has no socket, so it omits the host and
/// origin policy, static assets, backups, service details and the WebSocket change stream;
/// hosts deliver changes from [`EmbeddedHandles`]. Natively, call it inside a Tokio runtime.
/// The browser worker ingests queued uploads before this returns.
pub fn embedded_router(notebook: Notebook) -> Result<(Router, EmbeddedHandles), String> {
    let notebook = Arc::new(Mutex::new(notebook));
    let changes = broadcast::channel(256).0;
    let library = library::Library::start(notebook.clone(), changes.clone(), library::extract)?;
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    let replica = Arc::default();
    let handles = EmbeddedHandles {
        notebook: notebook.clone(),
        changes: changes.clone(),
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        replica: Arc::clone(&replica),
    };
    let state = AppState {
        notebook,
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        assets: None,
        changes,
        library,
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        port: 0,
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        backup: Arc::new(tokio::sync::Mutex::new(())),
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        sync_port: 0,
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        sharing: Arc::new(tokio::sync::Mutex::new(())),
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        replica,
    };
    let router = notebook_routes()
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
        .with_state(state);
    Ok((router, handles))
}

fn notebook_routes() -> Router<AppState> {
    let routes = Router::new()
        .route("/api/notebook", get(notebook_info))
        .route("/api/settings", get(settings))
        .route("/api/roots", get(roots))
        .route("/api/pages/{id}", get(page))
        .route("/api/pages/by-title/{title}", get(page_by_title))
        .route("/api/pages/{id}/kinds", get(note_kinds))
        .route("/api/pages/{id}/aliases", post(add_alias))
        .route("/api/names/{name}", get(resolve_name))
        .route("/api/index", get(note_index))
        .route("/api/index/{key}", get(kind_notes))
        .route("/api/journal/written", get(written_journal_dates))
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
        .route("/api/positions", get(capabilities::positions))
        .route("/api/questions", get(capabilities::questions))
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
        .route("/api/review/stats", get(review_stats))
        .route(
            "/api/review-sessions/{id}/reviews",
            get(review_session_events),
        )
        .route("/api/types", get(types))
        .route("/api/types/{id}", get(type_info))
        .route("/api/types/{id}/starting-template", post(starting_template))
        .route("/api/fields", get(fields))
        .route("/api/query", post(query))
        .route("/api/views", get(views))
        .route("/api/views/{id}", get(view))
        .route("/api/complete", get(complete))
        .route("/api/search", get(search))
        .route("/api/changes", get(changes))
        .route("/api/batches", post(apply))
        .route("/api/agent-changes", get(agent_changes).post(agent_edit))
        .route("/api/agent-changes/{seq}/undo", post(undo_agent_change));
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    let routes = routes.merge(replica::routes());
    routes
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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
    let sync_port = config.sync_port.map(Ok).unwrap_or_else(|| {
        port.checked_add(1)
            .context("specify --sync-port when the editor port is 65535")
    })?;
    let sync_listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, sync_port))
        .await
        .context("cannot bind the local sync port")?;
    let sync_port = sync_listener.local_addr()?.port();
    ownership.record(Some(port))?;
    let (app, sync_app) = routers(notebook, port, sync_port, config.assets, config.dev_origin)
        .map_err(anyhow::Error::msg)?;
    tracing::info!(url = %format_args!("http://127.0.0.1:{port}"), "service listening");
    tracing::info!(url = %format_args!("http://127.0.0.1:{sync_port}"), "sync listening");
    tracing::info!(path = %path.display(), "notebook opened");
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut editor_stopped = stopped.clone();
    let mut sync_stopped = stopped;
    let servers = async {
        tokio::try_join!(
            axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = editor_stopped.wait_for(|stop| *stop).await;
            }),
            axum::serve(sync_listener, sync_app).with_graceful_shutdown(async move {
                let _ = sync_stopped.wait_for(|stop| *stop).await;
            }),
        )
    };
    let signal = async move {
        shutdown.await;
        let _ = stop.send(true);
    };
    tokio::pin!(servers);
    tokio::select! {
        result = &mut servers => { result?; }
        () = signal => { servers.await?; }
    }
    drop(ownership);
    tracing::info!("service stopped");
    Ok(())
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Serialize)]
struct LaunchAgentInfo {
    installed: bool,
    path: Option<PathBuf>,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Serialize)]
struct ServiceInfo {
    version: &'static str,
    /// See [`BUILD`].
    build: Option<&'static str>,
    port: u16,
    assets: &'static str,
    launch_agent: LaunchAgentInfo,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Serialize)]
struct BackupInfo {
    path: PathBuf,
    created_at: i64,
    object_count: u64,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Serialize)]
struct CreatedBackup {
    path: PathBuf,
    #[serde(flatten)]
    manifest: tessera_core::BackupManifest,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn backup_directory(info: &NotebookInfo) -> Result<PathBuf, ApiError> {
    tessera_core::backup_directory(&info.path, &info.id).map_err(ApiError::internal)
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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
        match tessera_core::backup_beside(&info.path) {
            Ok((path, manifest)) => Ok(Json(CreatedBackup { path, manifest })),
            Err(tessera_core::Error::Io(error))
                if error.kind() == std::io::ErrorKind::AlreadyExists =>
            {
                Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "conflict",
                    "A backup already exists for this second.",
                ))
            }
            Err(error) => Err(ApiError::from(error)),
        }
    })
    .await
    .map_err(ApiError::internal)?
}

#[derive(Deserialize)]
struct ReviewStatsQuery {
    deck: Option<String>,
    date: Option<String>,
}

async fn review_stats(
    State(state): State<AppState>,
    query: Result<Query<ReviewStatsQuery>, QueryRejection>,
) -> Result<Json<tessera_core::ReviewStats>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        let date = query
            .date
            .map(Ok)
            .unwrap_or_else(|| notebook.today(tessera_core::now_ms()))?;
        notebook.review_stats(query.deck.as_deref(), &date)
    })
    .await
    .map(Json)
}

async fn review_session_events(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::ReviewEvent>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.review_session_events(&id))
        .await
        .map(Json)
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

async fn types(State(state): State<AppState>) -> Result<Json<Vec<TypeInfo>>, ApiError> {
    run(&state, |notebook| notebook.types()).await.map(Json)
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

#[derive(Deserialize)]
struct JournalRange {
    from: String,
    to: String,
}

async fn written_journal_dates(
    State(state): State<AppState>,
    query: Result<Query<JournalRange>, QueryRejection>,
) -> Result<Json<Vec<String>>, ApiError> {
    let Query(range) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.written_journal_dates(&range.from, &range.to)
    })
    .await
    .map(Json)
}

async fn note_index(State(state): State<AppState>) -> Result<Json<NoteIndex>, ApiError> {
    run(&state, |notebook| notebook.note_index())
        .await
        .map(Json)
}

async fn kind_notes(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<KindIndex>, ApiError> {
    let Path(key) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.kind_notes(&key))
        .await
        .map(Json)
}

async fn note_kinds(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<NoteKind>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.note_kinds(&id))
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
        notebook.settings_view(tessera_core::now_ms())
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
) -> Result<Json<Vec<Completion>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.complete(&query.q, query.limit)
    })
    .await
    .map(Json)
}

async fn resolve_name(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<NameMatch>>, ApiError> {
    let Path(name) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.resolve_name(&name))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct AliasRequest {
    name: String,
}

async fn add_alias(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    body: Result<Json<AliasRequest>, JsonRejection>,
) -> Result<Json<Option<Committed>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Json(AliasRequest { name }) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let mut committed = notebook.add_alias(&id, &name, Actor::Person)?;
        if let Some(committed) = &mut committed {
            editor_receipt(notebook, &changes, committed)?;
        }
        Ok(committed)
    })
    .await
    .map(Json)
}

async fn starting_template(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Option<Committed>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let mut committed = notebook.apply_starting_template(&id, Actor::Person)?;
        if let Some(committed) = &mut committed {
            editor_receipt(notebook, &changes, committed)?;
        }
        Ok(committed)
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Deserialize)]
struct StreamQuery {
    #[serde(default)]
    after: i64,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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
                    // Notifications are wakeups; editor cursors are local, not changes.seq.
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

fn editor_receipt(
    notebook: &Notebook,
    changes: &broadcast::Sender<i64>,
    committed: &mut Committed,
) -> tessera_core::Result<()> {
    committed.seq = notebook.editor_change_cursor(committed.seq)?;
    if !committed.replayed {
        // Publish while the writer lock is still held, in arrival order.
        let _ = changes.send(committed.seq);
    }
    Ok(())
}

async fn apply(
    State(state): State<AppState>,
    body: Result<Json<Batch>, JsonRejection>,
) -> Result<Json<Committed>, ApiError> {
    let Json(batch) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let mut committed = notebook.apply(&batch)?;
        editor_receipt(notebook, &changes, &mut committed)?;
        Ok(committed)
    })
    .await
    .map(Json)
}

/// The agent write path: add a note, edit, move or delete a block, or set a
/// task, as one attributed batch that records its own undo.
async fn agent_edit(
    State(state): State<AppState>,
    body: Result<Json<AgentRequest>, JsonRejection>,
) -> Result<Json<AgentReceipt>, ApiError> {
    let Json(request) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let mut receipt = notebook.agent_edit(&request)?;
        editor_receipt(notebook, &changes, &mut receipt.committed)?;
        Ok(receipt)
    })
    .await
    .map(Json)
}

async fn agent_changes(
    State(state): State<AppState>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<Vec<AgentChange>>, ApiError> {
    let Query(Limit { limit }) = query.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.agent_changes(limit))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct UndoRequest {
    actor: Actor,
}

async fn undo_agent_change(
    State(state): State<AppState>,
    path: Result<Path<i64>, PathRejection>,
    body: Result<Json<UndoRequest>, JsonRejection>,
) -> Result<Json<UndoReceipt>, ApiError> {
    let Path(seq) = path.map_err(ApiError::from)?;
    let Json(UndoRequest { actor }) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |notebook| {
        let mut receipt = notebook.undo_agent_change(seq, &actor)?;
        editor_receipt(notebook, &changes, &mut receipt.committed)?;
        Ok(receipt)
    })
    .await
    .map(Json)
}

/// Run on a blocking runtime thread natively, or inline in the browser worker.
async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        operation(&mut state.notebook.lock()).map_err(ApiError::from)
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        let notebook = state.notebook.clone();
        tokio::task::spawn_blocking(move || {
            let mut notebook = notebook.lock();
            operation(&mut notebook).map_err(ApiError::from)
        })
        .await
        .map_err(ApiError::internal)?
    }
}

#[cfg(all(test, not(all(target_arch = "wasm32", target_os = "unknown"))))]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn alias_routes_keep_json_shapes_and_publish_only_committed_changes() {
        async fn request(
            app: &Router,
            method: &str,
            path: &str,
            body: Option<serde_json::Value>,
        ) -> serde_json::Value {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{method} {path}");
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice(&bytes).unwrap()
        }

        let dir = tempfile::tempdir().unwrap();
        let mut notebook = Notebook::open(dir.path()).unwrap();
        let page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let kind = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![
                    tessera_core::Operation::CreatePage {
                        id: page.into(),
                        title: "Cicero".into(),
                    },
                    tessera_core::Operation::CreatePage {
                        id: kind.into(),
                        title: "Person".into(),
                    },
                    tessera_core::Operation::AddType {
                        id: page.into(),
                        base_revision: 1,
                        title: "Person".into(),
                    },
                ],
            })
            .unwrap();
        let (app, handles) = embedded_router(notebook).unwrap();
        let mut notifications = handles.changes.subscribe();
        let aliases = format!("/api/pages/{page}/aliases");
        let committed = request(
            &app,
            "POST",
            &aliases,
            Some(serde_json::json!({"name": "Tully"})),
        )
        .await;
        let seq = committed["seq"].as_i64().unwrap();
        assert_eq!(notifications.try_recv().unwrap(), seq);
        let event = handles
            .notebook
            .lock()
            .changes_since(seq - 1, 1)
            .unwrap()
            .remove(0);
        assert_eq!(event.actor, Actor::Person);
        assert!(event.restructured_pages.iter().any(|id| id == page));
        assert!(
            request(
                &app,
                "POST",
                &aliases,
                Some(serde_json::json!({"name": "TÚLLY"}))
            )
            .await
            .is_null()
        );
        assert!(matches!(
            notifications.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        let matches = request(&app, "GET", "/api/names/tully", None).await;
        assert_eq!(matches[0]["page"]["id"], page);
        assert_eq!(matches[0]["alias"], "Tully");
        assert_eq!(
            request(&app, "GET", "/api/names/Cicero", None).await[0]["alias"],
            serde_json::Value::Null
        );
        let completion = request(&app, "GET", "/api/complete?q=tul&limit=1", None).await;
        assert_eq!(completion[0]["id"], page);
        assert_eq!(completion[0]["alias"], "Tully");
        assert!(completion[0].get("block").is_none());
        assert!(
            request(&app, "GET", "/api/complete?q=Cic&limit=1", None).await[0]["alias"].is_null()
        );
        let index = request(&app, "GET", "/api/index/person", None).await;
        assert_eq!(index["notes"][0]["id"], page);
        assert!(index["notes"][0]["sort_as"].is_null());
        assert_eq!(index["see"][0]["alias"], "Tully");
        assert_eq!(
            index["see"][0]["targets"],
            serde_json::json!([{"id": page, "title": "Cicero"}])
        );
        let template = format!("/api/types/{kind}/starting-template");
        let committed = request(&app, "POST", &template, None).await;
        let seq = committed["seq"].as_i64().unwrap();
        assert_eq!(notifications.try_recv().unwrap(), seq);
        let event = handles
            .notebook
            .lock()
            .changes_since(seq - 1, 1)
            .unwrap()
            .remove(0);
        assert_eq!(event.actor, Actor::Person);
        assert_eq!(
            handles
                .notebook
                .lock()
                .type_info(kind)
                .unwrap()
                .fields
                .len(),
            3
        );
        assert!(request(&app, "POST", &template, None).await.is_null());
        assert!(matches!(
            notifications.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

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
                sync_port: 4501,
                pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
                sharing: Arc::new(tokio::sync::Mutex::new(())),
                replica: Arc::default(),
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
