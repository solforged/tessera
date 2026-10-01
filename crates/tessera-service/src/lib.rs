//! The loopback service that owns one notebook. Browser windows, the CLI and
//! agents reach the notebook only through its operation API.

mod assets;
mod error;
mod security;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    middleware,
    routing::get,
};
use tessera_core::{Notebook, NotebookInfo};

use crate::error::ApiError;
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
    };
    Ok(Router::new()
        .route("/api/notebook", get(notebook_info))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(policy, security::protect))
        .with_state(state))
}

/// Open the notebook, bind loopback and serve until Ctrl-C.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    if let Some(origin) = &config.dev_origin {
        validate_dev_origin(origin).map_err(anyhow::Error::msg)?;
    }
    let dir = config.notebook.clone();
    let notebook = tokio::task::spawn_blocking(move || Notebook::open(&dir))
        .await?
        .with_context(|| format!("cannot open notebook {}", config.notebook.display()))?;
    let path = notebook.info()?.path;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .context("cannot bind the local HTTP port")?;
    let port = listener.local_addr()?.port();
    let app =
        router(notebook, port, config.assets, config.dev_origin).map_err(anyhow::Error::msg)?;
    eprintln!("tessera: http://127.0.0.1:{port}");
    eprintln!("tessera: notebook {}", path.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn notebook_info(State(state): State<AppState>) -> Result<Json<NotebookInfo>, ApiError> {
    run(&state, |notebook| notebook.info()).await.map(Json)
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
