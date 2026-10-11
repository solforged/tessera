//! In-process replica orchestration. Network work never owns the notebook lock.
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use axum::{Json, Router, extract::State, routing::{get, post}, http::StatusCode, response::{IntoResponse, Response}};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tessera_core::{Notebook, sync::{self, Hub, NotebookAccess, PulledChange, IntegrateReport}};
use tokio::sync::{broadcast, Notify};
use crate::{AppState, EmbeddedHandles, sync_client::{HttpHub, HubError, Pairing}};

#[derive(Debug, Clone, Serialize)]
pub struct LastError { pub code: String, pub message: String }
impl LastError {
    fn from_error(error: anyhow::Error) -> Self {
        for source in error.chain() {
            if let Some(error) = source.downcast_ref::<HubError>() { return Self { code: error.code.clone(), message: error.message.clone() }; }
        }
        let message = error.to_string();
        let code = if message.contains("retired") { "retired" } else if message.contains("schema") { "schema_mismatch" } else { "hub_unreachable" };
        Self { code: code.into(), message }
    }
    fn new(code: &str, message: &str) -> Self { Self { code: code.into(), message: message.into() } }
}
impl IntoResponse for LastError {
    fn into_response(self) -> Response {
        let status = match self.code.as_str() { "already_replica" => StatusCode::CONFLICT, "bad_code" => StatusCode::FORBIDDEN, "expired_code" => StatusCode::GONE, "schema_mismatch" => StatusCode::CONFLICT, _ => StatusCode::BAD_GATEWAY };
        (status, Json(serde_json::json!({"code":self.code,"message":self.message}))).into_response()
    }
}
#[derive(Default)]
struct Memory {
    syncing: bool, last_error: Option<LastError>, retired: bool, completed: u64,
    pairing: Option<(String, Pairing)>,
}
#[derive(Default)]
pub struct ReplicaRuntime {
    gate: Arc<tokio::sync::Mutex<()>>, memory: Mutex<Memory>, wake: Arc<Notify>, started: AtomicBool,
    abort: Mutex<Option<tokio::task::AbortHandle>>,
}
impl Drop for ReplicaRuntime {
    fn drop(&mut self) { if let Some(abort) = self.abort.get_mut().take() { abort.abort(); } }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/sync/state", get(state))
        .route("/api/sync/run", post(run_now)).route("/api/sync/join", post(join))
        .route("/api/sync/reclone", post(reclone)).route("/api/sync/conflicts", get(conflicts))
}
async fn state(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    state_value(state.notebook, state.replica).await.map(Json)
}
async fn state_value(notebook: Arc<Mutex<Notebook>>, runtime: Arc<ReplicaRuntime>) -> Result<serde_json::Value, LastError> {
    tokio::task::spawn_blocking(move || {
        let n = notebook.lock();
        let status = n.sync_status()?;
        let Some(status) = status else { return anyhow::Ok(serde_json::json!({"role":if n.sync_replicas()?.is_empty() {"none"} else {"hub"},"replica":null})); };
        let credentials = n.sync_hub_credentials()?.expect("replica credentials row");
        let conflicts = n.sync_replica_conflicts()?;
        let offline = n.sync_offline_files()?;
        let memory = runtime.memory.lock();
        anyhow::Ok(serde_json::json!({"role":"replica","replica":{
            "hub_url":status.hub_url,"hub_name":credentials.hub_name,"device_name":credentials.device_name,
            "device_id":status.device_id,"pending":status.pending,"unapplied":status.unapplied,
            "synced_at":credentials.synced_at,"syncing":memory.syncing,"last_error":memory.last_error,
            "retired":memory.retired,"kept_copies":conflicts.kept.len(),"rejected":conflicts.rejected.len(),"offline":offline
        }}))
    }).await.map_err(|e| LastError::from_error(e.into()))?.map_err(LastError::from_error)
}

struct LockedNotebook { notebook: Arc<Mutex<Notebook>>, changes: broadcast::Sender<i64> }
impl NotebookAccess for LockedNotebook {
    fn with_notebook<T>(&mut self, step: impl FnOnce(&mut Notebook) -> tessera_core::Result<T>) -> tessera_core::Result<T> { step(&mut self.notebook.lock()) }
    fn integrate(&mut self, changes: &[PulledChange]) -> tessera_core::Result<IntegrateReport> {
        let mut n = self.notebook.lock();
        let result = n.sync_integrate(changes);
        // An interrupted rebase can have applied a page; notify even on failure.
        let _ = self.changes.send(i64::MAX);
        result
    }
}
fn hub_for(n: &Notebook) -> anyhow::Result<Option<HttpHub>> {
    let Some(status) = n.sync_status()? else { return Ok(None); };
    let credentials = n.sync_hub_credentials()?.expect("replica credentials row");
    Ok(Some(HttpHub::new(&status.hub_url, credentials.key.as_deref())?))
}

async fn synchronize(notebook: Arc<Mutex<Notebook>>, changes: broadcast::Sender<i64>, runtime: Arc<ReplicaRuntime>) {
    let completed = runtime.memory.lock().completed;
    let guard = runtime.gate.clone().lock_owned().await;
    if runtime.memory.lock().completed != completed { return; }
    runtime.memory.lock().syncing = true;
    let result_runtime = runtime.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let result = (|| {
            let hub = hub_for(&notebook.lock())?;
            if let Some(mut hub) = hub {
                sync::sync_with(&mut LockedNotebook { notebook: notebook.clone(), changes }, &mut hub)?;
                notebook.lock().sync_mark_synced()?;
            }
            anyhow::Ok(())
        })();
        finish(&runtime, result);
    }).await;
    if let Err(error) = work { finish(&result_runtime, Err(error.into())); }
}
fn finish(runtime: &ReplicaRuntime, result: anyhow::Result<()>) {
    let mut memory = runtime.memory.lock();
    memory.syncing = false;
    memory.completed += 1;
    memory.last_error = result.err().map(LastError::from_error);
    memory.retired = memory.last_error.as_ref().is_some_and(|e| e.code == "retired");
}
async fn run_now(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    synchronize(state.notebook.clone(), state.changes.clone(), state.replica.clone()).await;
    state_value(state.notebook, state.replica).await.map(Json)
}

#[derive(Deserialize)]
struct Join { url: String, code: String, name: String }
async fn join(State(state): State<AppState>, Json(request): Json<Join>) -> Result<Json<serde_json::Value>, LastError> {
    let guard = state.replica.gate.clone().lock_owned().await;
    // Reject before consuming the one-time code, including queued duplicate joins.
    if state.notebook.lock().sync_status().map_err(|e| LastError::from_error(e.into()))?.is_some() {
        return Err(LastError::new("already_replica", "This notebook is already a replica."));
    }
    state.replica.memory.lock().syncing = true;
    let worker = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let result = join_blocking(&worker, request);
        finish(&worker.replica, result.as_ref().map(|_| ()).map_err(|e| anyhow::anyhow!(e.to_string())));
        result
    }).await.map_err(|e| LastError::from_error(e.into()))?;
    result.map_err(LastError::from_error)?;
    state.replica.wake.notify_one();
    state_value(state.notebook, state.replica).await.map(Json)
}
fn join_blocking(state: &AppState, request: Join) -> anyhow::Result<()> {
    let cached = state.replica.memory.lock().pairing.clone();
    let paired = match cached {
        Some((url, paired)) if url == request.url && paired.device.name == request.name => paired,
        _ => HttpHub::new(&request.url, None)?.pair(&request.code, &request.name)?,
    };
    state.replica.memory.lock().pairing = Some((request.url.clone(), paired.clone()));
    let mut hub = HttpHub::new(&request.url, Some(&paired.key))?;
    replace(state, &mut hub, Some(&paired))?;
    state.replica.memory.lock().pairing = None;
    Ok(())
}
async fn reclone(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    let guard = state.replica.gate.clone().lock_owned().await;
    state.replica.memory.lock().syncing = true;
    let worker = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let result = (|| {
            let mut hub = hub_for(&worker.notebook.lock())?.ok_or_else(|| anyhow::anyhow!("this notebook is not a replica"))?;
            replace(&worker, &mut hub, None)
        })();
        finish(&worker.replica, result.as_ref().map(|_| ()).map_err(|e| anyhow::anyhow!(e.to_string())));
        result
    }).await.map_err(|e| LastError::from_error(e.into()))?;
    result.map_err(LastError::from_error)?;
    state_value(state.notebook, state.replica).await.map(Json)
}

fn replace(state: &AppState, hub: &mut HttpHub, paired: Option<&Pairing>) -> anyhow::Result<()> {
    let (directory, old, credentials) = {
        let n = state.notebook.lock();
        (n.info()?.path, n.sync_status()?, n.sync_hub_credentials()?)
    };
    let mut local = LockedNotebook { notebook: state.notebook.clone(), changes: state.changes.clone() };
    // Import uses a key-owned temporary replica ID, never the unrelated notebook's ID.
    let importer = if paired.is_some() {
        let (ticket, path) = hub.download(&directory)?;
        std::fs::remove_file(path)?;
        Some(ticket.device_id)
    } else { None };
    loop {
        let generation = state.notebook.lock().sync_generation()?;
        if let Some(device) = &importer { sync::sync_import(&mut local, hub, device)?; }
        if old.is_some() { sync::sync_send(&mut local, hub)?; }
        let (ticket, path) = hub.download(&directory)?;
        let mut n = state.notebook.lock();
        if n.sync_generation()? != generation {
            drop(n);
            hub.retire(&ticket.device_id)?;
            std::fs::remove_file(path)?;
            continue;
        }
        n.sync_install_clone(&path, &hub.base, &ticket, if paired.is_some() {"before-pairing"} else {"retired"})?;
        if let Some(paired) = paired {
            n.sync_set_hub_credentials(Some(&paired.key), Some(&paired.hub.name), Some(&paired.device.name))?;
        } else if let Some(credentials) = &credentials {
            n.sync_set_hub_credentials(credentials.key.as_deref(), credentials.hub_name.as_deref(), credentials.device_name.as_deref())?;
        }
        n.sync_mark_synced()?;
        let _ = state.changes.send(i64::MAX);
        drop(n);
        std::fs::remove_file(path)?;
        break;
    }
    // Retirement follows the successful install; failures cannot discard local edits.
    if let Some(old) = old { hub.retire(&old.device_id)?; }
    if let Some(importer) = importer { hub.retire(&importer)?; }
    state.library.kick();
    Ok(())
}
async fn conflicts(State(state): State<AppState>) -> Result<Json<sync::ReplicaConflicts>, crate::error::ApiError> {
    crate::run(&state, |n| n.sync_replica_conflicts()).await.map(Json)
}

/// Start once for a host's embedded notebook. Dropping the router and handles
/// stops the runner. It is harmless on an unpaired notebook and wakes after join.
pub fn start_sync_runner(handles: &EmbeddedHandles) {
    start(handles.notebook.clone(), handles.changes.clone(), &handles.replica);
}
pub(crate) fn start(notebook: Arc<Mutex<Notebook>>, changes: broadcast::Sender<i64>, runtime: &Arc<ReplicaRuntime>) {
    if runtime.started.swap(true, Ordering::AcqRel) { return; }
    let weak = Arc::downgrade(runtime);
    let mut notifications = changes.subscribe();
    let wake = runtime.wake.clone();
    let task = tokio::spawn(async move {
        let mut due = tokio::time::Instant::now();
        let mut backoff = Duration::from_secs(5);
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(due) => {},
                _ = wake.notified() => {},
                notification = notifications.recv() => {
                    if matches!(notification, Err(broadcast::error::RecvError::Closed)) { return; }
                    let Some(runtime) = weak.upgrade() else { return; };
                    let soon = tokio::time::Instant::now() + Duration::from_secs(3);
                    // A local edit must not bypass network-error backoff.
                    if runtime.memory.lock().last_error.is_none() { due = due.min(soon); }
                    continue;
                }
            }
            let Some(runtime) = weak.upgrade() else { return; };
            synchronize(notebook.clone(), changes.clone(), runtime.clone()).await;
            let failed = runtime.memory.lock().last_error.is_some();
            if failed { due = tokio::time::Instant::now() + backoff; backoff = (backoff * 2).min(Duration::from_secs(300)); }
            else { backoff = Duration::from_secs(5); due = tokio::time::Instant::now() + Duration::from_secs(180); }
        }
    });
    *runtime.abort.lock() = Some(task.abort_handle());
}
