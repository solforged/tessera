//! The loopback HTTP and WebSocket service that owns one workshop. Browser windows, the CLI and
//! agents reach the workshop only through its operation API.
//! `GET /api/service` reports local runtime details. `POST /api/backups` takes a
//! portable snapshot, and `GET /api/backups` lists completed snapshots newest first.
//! `DELETE /api/backups/{name}` removes an earlier snapshot. Retention is automatic.
//! `DELETE /api/backups/others/{workshop_id}` removes another workshop's backups.
//! `GET /api/check` verifies the workshop and `POST /api/check/repair` rebuilds its derived tables.
//! `GET /api/notebook/size` reports the bytes the open workshop's folder holds: its database and every stored object.
//! `/api/notebooks` lists known workshops and switches the service to another one.

mod agent;
pub mod agent_outline;
pub mod agent_render;
pub mod agent_tools;
#[cfg(feature = "hub")]
mod assets;
mod backups;
mod daily_backup;
mod embedded;
mod error;
mod info;
#[cfg(feature = "hub")]
pub mod migration;
#[cfg(feature = "hub")]
pub mod notebooks;
#[cfg(feature = "hub")]
mod pairing;
mod replica;
mod router;
#[cfg(feature = "hub")]
mod security;
#[cfg(feature = "hub")]
mod serve;
#[cfg(feature = "hub")]
mod sharing;
pub(crate) mod state;
#[cfg(feature = "hub")]
mod stream;
#[cfg(feature = "hub")]
mod sync;
pub mod sync_client;
#[cfg(all(test, feature = "hub"))]
mod wire_types;

pub use replica::start_sync_runner;
#[cfg(feature = "hub")]
pub use security::validate_dev_origin;
pub(crate) use tessera_api::editor_receipt;
pub use tessera_api::{BLOCK_REVISION_HEADER, library};
pub use tessera_core::paths;

pub use embedded::{EmbeddedHandles, embedded_router, embedded_router_with_paths};
#[cfg(feature = "hub")]
pub use router::router;
#[cfg(feature = "hub")]
pub use serve::{Config, Restart, serve};

pub(crate) use backups::BackupFailure;
#[cfg(feature = "hub")]
pub(crate) use backups::BackupLock;
#[cfg(feature = "hub")]
pub(crate) use state::run;
pub(crate) use state::{AppState, read};

use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 4318;

/// The workspace version shared by every Tessera binary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The commit a release or `mise run ship` built from; absent in development builds.
pub const BUILD: Option<&str> = option_env!("TESSERA_BUILD");

/// What a device running Tessera reports about itself. A peer that reports only its schema
/// leaves `version` and `build` null.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
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
