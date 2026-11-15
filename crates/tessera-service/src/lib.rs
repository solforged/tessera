//! The loopback HTTP and WebSocket service that owns one notebook. Browser windows, the CLI and
//! agents reach the notebook only through its operation API.
//! `GET /api/service` reports local runtime details. `POST /api/backups` takes a
//! portable snapshot, and `GET /api/backups` lists completed snapshots newest first.
//! `DELETE /api/backups/{name}` removes an earlier snapshot. Retention is automatic.
//! `DELETE /api/backups/others/{workshop_id}` removes another workshop's backups.
//! `GET /api/check` verifies the notebook and `POST /api/check/repair` rebuilds its derived tables.
//! `GET /api/notebook/size` reports the bytes the open workshop's folder holds: its database and every stored object.
//! `/api/notebooks` lists known notebooks and switches the service to another one.

mod agent;
pub mod agent_outline;
pub mod agent_render;
mod assets;
mod backups;
mod daily_backup;
mod embedded;
mod error;
mod info;
pub mod migration;
pub mod notebooks;
mod pairing;
mod replica;
mod router;
mod security;
mod serve;
mod sharing;
pub(crate) mod state;
mod stream;
mod sync;
pub mod sync_client;

pub use replica::start_sync_runner;
pub use security::validate_dev_origin;
pub(crate) use tessera_api::editor_receipt;
pub use tessera_api::library;
pub use tessera_core::paths;

pub use embedded::{EmbeddedHandles, embedded_router, embedded_router_with_paths};
pub use router::router;
pub use serve::{Config, Restart, serve};

pub(crate) use backups::{BackupFailure, BackupLock};
pub(crate) use state::{AppState, read, run};

use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 4318;

/// The workspace version shared by every Tessera binary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The commit a release or `ts-ship` built from; absent in development builds.
pub const BUILD: Option<&str> = option_env!("TESSERA_BUILD");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncVersion {
    pub version: Option<String>,
    pub build: Option<String>,
    pub schema: u32,
}

impl SyncVersion {
    pub(crate) fn current() -> Self {
        Self {
            version: Some(VERSION.into()),
            build: BUILD.map(str::to_owned),
            schema: tessera_core::SCHEMA_VERSION,
        }
    }
}

pub const LAUNCH_AGENT_LABEL: &str = "dev.tessera.serve";

/// The per-user launch agent location. This does not invoke launchctl.
pub fn launch_agent_path(home: &std::path::Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}
