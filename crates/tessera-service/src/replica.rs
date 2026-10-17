//! In-process replica orchestration. Network work never owns the notebook lock.
use crate::{
    AppState, EmbeddedHandles,
    sync_client::{HttpHub, HubError, Pairing},
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tessera_core::{
    Notebook,
    sync::{self, Hub, IntegrateReport, NotebookAccess, PulledChange},
};
use tokio::sync::{Notify, broadcast};

#[derive(Debug, Clone, Serialize)]
pub struct LastError {
    pub code: String,
    pub message: String,
}
impl LastError {
    fn from_error(error: anyhow::Error) -> Self {
        Self::from_ref(&error)
    }
    fn from_ref(error: &anyhow::Error) -> Self {
        for source in error.chain() {
            let hub = source.downcast_ref::<HubError>().or_else(|| {
                source
                    .downcast_ref::<std::io::Error>()
                    .and_then(std::io::Error::get_ref)
                    .and_then(|inner| inner.downcast_ref::<HubError>())
            });
            if let Some(error) = hub {
                return Self {
                    code: error.code.clone(),
                    message: error.message.clone(),
                };
            }
        }
        let message = error.to_string();
        let code = if message.contains("retired") {
            "retired"
        } else if message.contains("schema") {
            "schema_mismatch"
        } else {
            "hub_unreachable"
        };
        Self {
            code: code.into(),
            message,
        }
    }
    /// The hub no longer accepts this phone's key, after Forget on the Mac.
    fn revoked(&self) -> bool {
        matches!(self.code.as_str(), "unpaired" | "wrong_device")
    }
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl IntoResponse for LastError {
    fn into_response(self) -> Response {
        let status = match self.code.as_str() {
            "already_replica" => StatusCode::CONFLICT,
            "bad_code" => StatusCode::FORBIDDEN,
            "expired_code" => StatusCode::GONE,
            "schema_mismatch" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_GATEWAY,
        };
        (
            status,
            Json(serde_json::json!({"code":self.code,"message":self.message})),
        )
            .into_response()
    }
}
#[derive(Default)]
struct Memory {
    syncing: bool,
    last_error: Option<LastError>,
    retired: bool,
    completed: u64,
    pairing: Option<(String, String, Pairing)>,
    hub_version: Option<crate::SyncVersion>,
    failing_since: Option<i64>,
    attempts: std::collections::VecDeque<crate::sync::Attempt>,
}
#[derive(Default)]
pub struct ReplicaRuntime {
    gate: Arc<tokio::sync::Mutex<()>>,
    memory: Mutex<Memory>,
    wake: Arc<Notify>,
    started: AtomicBool,
    abort: Mutex<Option<tokio::task::AbortHandle>>,
}
impl Drop for ReplicaRuntime {
    fn drop(&mut self) {
        if let Some(abort) = self.abort.get_mut().take() {
            abort.abort();
        }
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sync/state", get(state))
        .route("/api/sync/run", post(run_now))
        .route("/api/sync/join", post(join))
        .route("/api/sync/reclone", post(reclone))
        .route("/api/sync/conflicts", get(conflicts))
}
async fn state(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    state_value(state.notebook, state.replica).await.map(Json)
}
async fn state_value(
    notebook: Arc<Mutex<Notebook>>,
    runtime: Arc<ReplicaRuntime>,
) -> Result<serde_json::Value, LastError> {
    tokio::task::spawn_blocking(move || {
        let mut n = notebook.lock();
        let status = n.sync_status()?;
        let Some(status) = status else {
            let role = if n.sync_devices()?.is_empty() && n.sync_replicas()?.is_empty() { "none" } else { "hub" };
            return anyhow::Ok(serde_json::json!({"role":role,"replica":null,"this_device":crate::SyncVersion::current()}));
        };
        let credentials = n.sync_hub_credentials()?.expect("replica credentials row");
        let conflicts = n.sync_replica_conflicts()?;
        let offline = n.sync_offline_files()?;
        let memory = runtime.memory.lock();
        anyhow::Ok(serde_json::json!({"role":"replica","this_device":crate::SyncVersion::current(),"replica":{
            "hub_url":status.hub_url,"hub_name":credentials.hub_name,"device_name":credentials.device_name,
            "device_id":status.device_id,"pending":status.pending,"unapplied":status.unapplied,
            "synced_at":credentials.synced_at,"syncing":memory.syncing,"last_error":memory.last_error,
            "hub_version":memory.hub_version,"failing_since":memory.failing_since,"attempts":memory.attempts,
            "retired":memory.retired,"kept_copies":conflicts.kept.len(),"rejected":conflicts.rejected.len(),"offline":offline
        }}))
    }).await.map_err(|e| LastError::from_error(e.into()))?.map_err(LastError::from_error)
}

struct LockedNotebook {
    notebook: Arc<Mutex<Notebook>>,
    changes: broadcast::Sender<i64>,
}
impl NotebookAccess for LockedNotebook {
    fn with_notebook<T>(
        &mut self,
        step: impl FnOnce(&mut Notebook) -> tessera_core::Result<T>,
    ) -> tessera_core::Result<T> {
        step(&mut self.notebook.lock())
    }
    fn integrate(&mut self, changes: &[PulledChange]) -> tessera_core::Result<IntegrateReport> {
        let mut n = self.notebook.lock();
        let result = n.sync_integrate(changes);
        // An interrupted rebase can have applied a page; notify even on failure.
        let _ = self.changes.send(i64::MAX);
        result
    }
}
fn hub_for(n: &Notebook) -> anyhow::Result<Option<HttpHub>> {
    let Some(status) = n.sync_status()? else {
        return Ok(None);
    };
    let credentials = n.sync_hub_credentials()?.expect("replica credentials row");
    Ok(Some(HttpHub::new(
        &status.hub_url,
        credentials.key.as_deref(),
    )?))
}

async fn synchronize(
    notebook: Arc<Mutex<Notebook>>,
    changes: broadcast::Sender<i64>,
    runtime: Arc<ReplicaRuntime>,
) {
    let completed = runtime.memory.lock().completed;
    let guard = runtime.gate.clone().lock_owned().await;
    if runtime.memory.lock().completed != completed {
        return;
    }
    runtime.memory.lock().syncing = true;
    let result_runtime = runtime.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut hub = None;
        let result = (|| {
            hub = hub_for(&notebook.lock())?;
            if let Some(hub) = hub.as_mut() {
                let report = sync::sync_with(
                    &mut LockedNotebook {
                        notebook: notebook.clone(),
                        changes,
                    },
                    hub,
                )?;
                notebook.lock().sync_mark_synced()?;
                log_sync(&report);
            }
            anyhow::Ok(())
        })();
        finish(
            &runtime,
            &result,
            hub.as_ref().and_then(HttpHub::hub_version),
        );
    })
    .await;
    if let Err(error) = work {
        finish(&result_runtime, &Err(error.into()), None);
    }
}
/// One log line per sync: info when anything moved, debug for idle runs.
fn log_sync(report: &sync::SyncReport) {
    let integrated = &report.integrated;
    let pushed = report.pushed.len();
    let files = report.sent_objects + report.received_objects;
    let rows = report.sent_rows + report.received_rows;
    let snapshots = report.sent_snapshots + report.received_snapshots;
    if pushed + integrated.applied + integrated.replayed + files + rows + snapshots == 0 {
        tracing::debug!("sync finished; nothing to exchange");
        return;
    }
    tracing::info!(
        pushed,
        confirmed = integrated.confirmed,
        pulled = integrated.applied,
        replayed = integrated.replayed,
        unapplied = integrated.unapplied.len(),
        sent_files = report.sent_objects,
        received_files = report.received_objects,
        sent_rows = report.sent_rows,
        received_rows = report.received_rows,
        "sync finished"
    );
}
fn finish(
    runtime: &ReplicaRuntime,
    result: &anyhow::Result<()>,
    hub_version: Option<crate::SyncVersion>,
) {
    let mut memory = runtime.memory.lock();
    memory.syncing = false;
    memory.completed += 1;
    memory.last_error = result.as_ref().err().map(LastError::from_ref);
    let at = tessera_core::now_ms();
    if let Some(version) = hub_version {
        memory.hub_version = Some(version);
    }
    if result.is_ok() {
        memory.failing_since = None;
    } else {
        memory.failing_since.get_or_insert(at);
    }
    let Memory {
        last_error,
        attempts,
        ..
    } = &mut *memory;
    crate::sync::record_attempt(
        attempts,
        at,
        result.is_ok(),
        last_error.as_ref().map(|e| e.code.as_str()),
        last_error.as_ref().map(|e| e.message.as_str()),
    );
    if let Err(error) = result {
        tracing::warn!(%error, "sync failed");
    }
    if result.is_ok() {
        memory.retired = false;
    } else if memory
        .last_error
        .as_ref()
        .is_some_and(|e| e.code == "retired")
    {
        memory.retired = true;
    }
}
async fn run_now(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    synchronize(
        state.notebook.clone(),
        state.changes.clone(),
        state.replica.clone(),
    )
    .await;
    state_value(state.notebook, state.replica).await.map(Json)
}

#[derive(Deserialize)]
struct Join {
    url: String,
    code: String,
    name: String,
}
async fn join(
    State(state): State<AppState>,
    Json(request): Json<Join>,
) -> Result<Json<serde_json::Value>, LastError> {
    let guard = state.replica.gate.clone().lock_owned().await;
    // Reject before consuming the one-time code, including queued duplicate joins.
    // A replica whose key the hub revoked (Forget) may pair again.
    let replica = state
        .notebook
        .lock()
        .sync_status()
        .map_err(|e| LastError::from_error(e.into()))?
        .is_some();
    let revoked = state
        .replica
        .memory
        .lock()
        .last_error
        .as_ref()
        .is_some_and(LastError::revoked);
    if replica && !revoked {
        return Err(LastError::new(
            "already_replica",
            "This workshop is already a replica.",
        ));
    }
    state.replica.memory.lock().syncing = true;
    let worker = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut hub_version = None;
        let result = join_blocking(&worker, request, &mut hub_version);
        finish(&worker.replica, &result, hub_version);
        result
    })
    .await
    .map_err(|e| LastError::from_error(e.into()))?;
    result.map_err(LastError::from_error)?;
    state.replica.wake.notify_one();
    state_value(state.notebook, state.replica).await.map(Json)
}
fn join_blocking(
    state: &AppState,
    request: Join,
    hub_version: &mut Option<crate::SyncVersion>,
) -> anyhow::Result<()> {
    let code: String = request
        .code
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let cached = state.replica.memory.lock().pairing.clone();
    let paired = match cached {
        Some((url, cached_code, paired))
            if url == request.url && cached_code == code && paired.device.name == request.name =>
        {
            paired
        }
        _ => {
            let hub = HttpHub::new(&request.url, None)?;
            let result = hub.pair(&request.code, &request.name);
            *hub_version = hub.hub_version();
            result?
        }
    };
    state.replica.memory.lock().pairing = Some((request.url.clone(), code, paired.clone()));
    let mut hub = HttpHub::new(&request.url, Some(&paired.key))?;
    let result = replace(state, &mut hub, Some(&paired));
    *hub_version = hub.hub_version().or_else(|| hub_version.take());
    result?;
    state.replica.memory.lock().pairing = None;
    Ok(())
}
async fn reclone(State(state): State<AppState>) -> Result<Json<serde_json::Value>, LastError> {
    let guard = state.replica.gate.clone().lock_owned().await;
    state.replica.memory.lock().syncing = true;
    let worker = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut hub = None;
        let result = (|| {
            hub = Some(
                hub_for(&worker.notebook.lock())?
                    .ok_or_else(|| anyhow::anyhow!("this workshop is not a replica"))?,
            );
            replace(&worker, hub.as_mut().expect("replica hub"), None)
        })();
        finish(
            &worker.replica,
            &result,
            hub.as_ref().and_then(HttpHub::hub_version),
        );
        result
    })
    .await
    .map_err(|e| LastError::from_error(e.into()))?;
    result.map_err(LastError::from_error)?;
    state_value(state.notebook, state.replica).await.map(Json)
}

fn replace(state: &AppState, hub: &mut HttpHub, paired: Option<&Pairing>) -> anyhow::Result<()> {
    let (directory, old, credentials) = {
        let n = state.notebook.lock();
        (n.info()?.path, n.sync_status()?, n.sync_hub_credentials()?)
    };
    let credentials = paired
        .map(|paired| tessera_core::sync_devices::HubCredentials {
            key: Some(paired.key.clone()),
            hub_name: Some(paired.hub.name.clone()),
            device_name: Some(paired.device.name.clone()),
            synced_at: None,
        })
        .or(credentials);
    let mut local = LockedNotebook {
        notebook: state.notebook.clone(),
        changes: state.changes.clone(),
    };
    // Import uses a key-owned temporary replica ID, never the unrelated notebook's ID.
    let mut importer = None;
    loop {
        let (generation, has_content) = {
            let n = state.notebook.lock();
            (n.sync_generation()?, n.sync_has_content()?)
        };
        if paired.is_some() && has_content && importer.is_none() {
            let (ticket, path) = hub.download(&directory)?;
            std::fs::remove_file(path)?;
            importer = Some(ticket.device_id);
        }
        // An independent notebook sends its whole log. A re-paired replica's log came
        // from the hub, so it sends only its outbox, under the new key's replica.
        match (&importer, &old) {
            (Some(device), None) => {
                sync::sync_import(&mut local, hub, device)?;
            }
            (Some(device), Some(_)) => {
                sync::sync_send_as(&mut local, hub, device)?;
            }
            (None, Some(_)) if paired.is_none() => {
                sync::sync_send(&mut local, hub)?;
            }
            _ => {}
        }
        let (ticket, path) = hub.download(&directory)?;
        let mut n = state.notebook.lock();
        if n.sync_generation()? != generation {
            drop(n);
            hub.retire(&ticket.device_id)?;
            std::fs::remove_file(path)?;
            continue;
        }
        n.sync_install_clone(
            &path,
            &hub.base,
            &ticket,
            if paired.is_some() {
                "before-pairing"
            } else {
                "retired"
            },
            credentials.as_ref(),
        )?;
        n.sync_mark_synced()?;
        let _ = state.changes.send(i64::MAX);
        drop(n);
        std::fs::remove_file(path)?;
        break;
    }
    // Retirement follows the successful install; failures cannot discard local edits.
    // Forget already retired a re-paired phone's old replica.
    if let Some(old) = old.filter(|_| paired.is_none()) {
        hub.retire(&old.device_id)?;
    }
    if let Some(importer) = importer {
        hub.retire(&importer)?;
    }
    state.library.kick();
    Ok(())
}
async fn conflicts(
    State(state): State<AppState>,
) -> Result<Json<sync::ReplicaConflicts>, crate::error::ApiError> {
    crate::run(&state, |n| n.sync_replica_conflicts())
        .await
        .map(Json)
}

/// Start once for a host's embedded notebook. Dropping the router and handles
/// stops the runner. It is harmless on an unpaired notebook and wakes after join.
pub fn start_sync_runner(handles: &EmbeddedHandles) {
    start(
        handles.notebook.clone(),
        handles.changes.clone(),
        &handles.replica,
    );
}
pub(crate) fn start(
    notebook: Arc<Mutex<Notebook>>,
    changes: broadcast::Sender<i64>,
    runtime: &Arc<ReplicaRuntime>,
) {
    if runtime.started.swap(true, Ordering::AcqRel) {
        return;
    }
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
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            synchronize(notebook.clone(), changes.clone(), runtime.clone()).await;
            let failed = runtime.memory.lock().last_error.is_some();
            if failed {
                due = tokio::time::Instant::now() + backoff;
                backoff = (backoff * 2).min(Duration::from_secs(300));
            } else {
                backoff = Duration::from_secs(5);
                due = tokio::time::Instant::now() + Duration::from_secs(180);
            }
        }
    });
    *runtime.abort.lock() = Some(task.abort_handle());
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[test]
    fn failure_history_coalesces_and_success_clears_the_outage() {
        let runtime = ReplicaRuntime::default();
        let failed = Err(HubError {
            code: "schema_mismatch".into(),
            message: "schema mismatch".into(),
        }
        .into());
        finish(
            &runtime,
            &failed,
            Some(crate::SyncVersion {
                schema: tessera_core::SCHEMA_VERSION + 1,
                version: None,
                build: None,
            }),
        );
        let since = runtime.memory.lock().failing_since.unwrap();
        finish(&runtime, &failed, None);
        {
            let memory = runtime.memory.lock();
            assert_eq!(memory.failing_since, Some(since));
            assert_eq!(
                memory.hub_version.as_ref().unwrap().schema,
                tessera_core::SCHEMA_VERSION + 1
            );
            assert_eq!(memory.attempts.len(), 1);
            assert_eq!(memory.attempts[0].count, 2);
            assert_eq!(memory.attempts[0].first_at, since);
        }
        finish(&runtime, &Ok(()), None);
        let memory = runtime.memory.lock();
        assert!(memory.failing_since.is_none());
        assert!(memory.last_error.is_none());
        assert!(memory.attempts[0].ok);
        assert_eq!(memory.attempts[1].count, 2);
    }
    #[tokio::test]
    async fn join_refuses_existing_replica_before_pairing() {
        let hub_dir = tempfile::tempdir().unwrap();
        let phone_dir = tempfile::tempdir().unwrap();
        let mut hub = Notebook::open(hub_dir.path()).unwrap();
        let ticket = hub
            .sync_clone(&phone_dir.path().join(tessera_core::DATABASE_FILE))
            .unwrap()
            .finish()
            .unwrap();
        let mut phone = Notebook::open(phone_dir.path()).unwrap();
        phone.sync_adopt("http://127.0.0.1:4519", &ticket).unwrap();
        let (app, _handles) = crate::embedded_router(phone).unwrap();
        let response = app
            .oneshot(
                Request::post("/api/sync/join")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        r#"{"url":"http://127.0.0.1:4519","code":"unused","name":"Phone"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["code"], "already_replica");
    }

    #[tokio::test]
    async fn editor_receipts_keep_their_arrival_cursor_after_rebase_and_retry() {
        let hub_dir = tempfile::tempdir().unwrap();
        let phone_dir = tempfile::tempdir().unwrap();
        let mut hub = Notebook::open(hub_dir.path()).unwrap();
        let ticket = hub
            .sync_clone(&phone_dir.path().join(tessera_core::DATABASE_FILE))
            .unwrap()
            .finish()
            .unwrap();
        let mut phone = Notebook::open(phone_dir.path()).unwrap();
        phone.sync_adopt("http://127.0.0.1:4519", &ticket).unwrap();
        let page = |title: &str| tessera_core::Batch {
            actor: tessera_core::Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![tessera_core::Operation::CreatePage {
                id: ulid::Ulid::generate().to_string(),
                title: title.into(),
            }],
        };
        phone.apply(&page("Phone")).unwrap();
        hub.apply(&page("Hub")).unwrap();
        phone.sync_with(&mut hub).unwrap();
        let before = phone.editor_cursor().unwrap();
        let (app, handles) = crate::embedded_router(phone).unwrap();
        let mut batch = page("After rebase");
        batch.idempotency_key = Some("editor-retry".into());
        let mut receipts = Vec::new();
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(
                    Request::post("/api/batches")
                        .header("Content-Type", "application/json")
                        .body(Body::from(serde_json::to_vec(&batch).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let receipt: tessera_core::Committed =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            receipts.push(receipt);
        }
        assert!(receipts[0].seq > before);
        assert_eq!(receipts[0].seq, receipts[1].seq);
        assert!(receipts[1].replayed);
        let events = handles.notebook.lock().changes_since(before, 100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, receipts[0].seq);
    }
}
