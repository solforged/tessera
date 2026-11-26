use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tessera_core::{Workshop, WorkshopInfo};
use tokio::sync::broadcast;

use crate::agent;
use crate::backups::BackupLock;
use crate::error::ApiError;
use crate::library;
#[cfg(feature = "hub")]
use crate::notebooks;
#[cfg(feature = "hub")]
use crate::pairing;
use crate::replica;
#[cfg(feature = "hub")]
use crate::sync;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) workshop: Arc<Mutex<Workshop>>,
    /// Cached workshop identity and directory, refreshed when a clone replaces the database.
    pub(crate) info: Arc<RwLock<WorkshopInfo>>,
    /// Read-only connections, so reads do not queue behind saves.
    pub(crate) readers: Option<tessera_api::Readers>,
    #[cfg(feature = "hub")]
    pub(crate) assets: Option<Arc<PathBuf>>,
    pub(crate) changes: broadcast::Sender<i64>,
    pub(crate) library: library::Library,
    pub(crate) objects: tessera_api::ObjectReader,
    #[cfg(feature = "hub")]
    pub(crate) port: u16,
    pub(crate) backup: BackupLock,
    pub(crate) backup_store: Option<PathBuf>,
    #[cfg(feature = "hub")]
    pub(crate) sync_port: u16,
    #[cfg(feature = "hub")]
    pub(crate) pairing: Arc<Mutex<pairing::Pairing>>,
    #[cfg(feature = "hub")]
    pub(crate) sharing: Arc<tokio::sync::Mutex<()>>,
    pub(crate) replica: Arc<replica::ReplicaRuntime>,
    #[cfg(feature = "hub")]
    pub(crate) sync_health: Arc<Mutex<std::collections::HashMap<String, sync::DeviceHealth>>>,
    #[cfg(feature = "hub")]
    pub(crate) switcher: Option<Arc<notebooks::Switcher>>,
    pub(crate) agent: Arc<agent::Runtime>,
    #[cfg_attr(not(feature = "hub"), allow(dead_code))]
    pub(crate) shutdown: tokio::sync::watch::Receiver<bool>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn embedded(
        workshop: Arc<Mutex<Workshop>>,
        info: Arc<RwLock<WorkshopInfo>>,
        readers: Option<tessera_api::Readers>,
        changes: broadcast::Sender<i64>,
        library: library::Library,
        replica: Arc<replica::ReplicaRuntime>,
        backup: BackupLock,
        backup_store: Option<PathBuf>,
        agent: Arc<agent::Runtime>,
    ) -> Self {
        Self {
            workshop,
            info,
            readers,
            #[cfg(feature = "hub")]
            assets: None,
            changes,
            library,
            objects: hub_objects(replica.clone()),
            #[cfg(feature = "hub")]
            port: 0,
            backup,
            backup_store,
            #[cfg(feature = "hub")]
            sync_port: 0,
            #[cfg(feature = "hub")]
            pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
            #[cfg(feature = "hub")]
            sharing: Arc::new(tokio::sync::Mutex::new(())),
            replica,
            #[cfg(feature = "hub")]
            sync_health: Arc::default(),
            #[cfg(feature = "hub")]
            switcher: None,
            agent,
            shutdown: tokio::sync::watch::channel(false).1,
        }
    }
}

pub(crate) fn hub_objects(replica: Arc<replica::ReplicaRuntime>) -> tessera_api::ObjectReader {
    Arc::new(move |workshop, readers, sha| {
        let replica = replica.clone();
        Box::pin(replica::object_or_fetch(workshop, readers, replica, sha))
    })
}

impl axum::extract::FromRef<AppState> for tessera_api::WorkshopState {
    fn from_ref(state: &AppState) -> Self {
        tessera_api::WorkshopState::from_parts(
            state.workshop.clone(),
            state.changes.clone(),
            state.library.clone(),
        )
        .with_readers(state.readers.clone())
        .with_objects(state.objects.clone())
    }
}

#[cfg(feature = "hub")]
pub(crate) async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&mut tessera_core::Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tessera_api::run(&state.workshop, operation).await
}

/// Run a read against one snapshot of the workshop, beside the writer.
pub(crate) async fn read<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&tessera_core::Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    use axum::extract::FromRef;
    tessera_api::read(&tessera_api::WorkshopState::from_ref(state), operation).await
}
