//! Hub routes for replicas. See "Protocol" in `docs/sync.md`.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::pairing::run_authorized;
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tessera_core::sync::{PULL_LIMIT, PushedChange, SnapshotContent, UnloggedRows};
use tessera_core::sync_devices::PairedDevice;

use crate::{AppState, error::ApiError, run};

/// The schema version a replica runs; every sync request carries it.
pub(crate) const SCHEMA_HEADER: &str = "x-tessera-schema";
pub(crate) const VERSION_HEADER: &str = "x-tessera-version";
pub(crate) const BUILD_HEADER: &str = "x-tessera-build";
/// The clone ticket, beside the database bytes it describes.
pub(crate) const TICKET_HEADER: &str = "x-tessera-clone";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Attempt {
    pub at: i64,
    pub first_at: i64,
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub count: u64,
}

pub(crate) fn record_attempt(
    attempts: &mut std::collections::VecDeque<Attempt>,
    at: i64,
    ok: bool,
    code: Option<&str>,
    message: Option<&str>,
) {
    if let Some(latest) = attempts.front_mut()
        && latest.ok == ok
        && latest.code.as_deref() == code
    {
        latest.at = at;
        latest.message = message.map(str::to_owned);
        latest.count += 1;
        return;
    }
    attempts.push_front(Attempt {
        at,
        first_at: at,
        ok,
        code: code.map(str::to_owned),
        message: message.map(str::to_owned),
        count: 1,
    });
    attempts.truncate(20);
}

#[derive(Default, Serialize)]
pub(crate) struct DeviceHealth {
    pub version: Option<crate::SyncVersion>,
    pub last_attempt_at: Option<i64>,
    pub refused: Option<Refused>,
    pub attempts: std::collections::VecDeque<Attempt>,
}

#[derive(Serialize)]
pub(crate) struct Refused {
    pub code: String,
    pub message: String,
    pub since: i64,
    pub attempts: u64,
}

pub(crate) fn reported_version(headers: &HeaderMap) -> Option<crate::SyncVersion> {
    Some(crate::SyncVersion {
        schema: headers.get(SCHEMA_HEADER)?.to_str().ok()?.parse().ok()?,
        version: headers
            .get(VERSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        build: headers
            .get(BUILD_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    })
}

pub(crate) async fn version_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        SCHEMA_HEADER,
        HeaderValue::from(tessera_core::SCHEMA_VERSION),
    );
    headers.insert(VERSION_HEADER, HeaderValue::from_static(crate::VERSION));
    if let Some(build) = crate::BUILD
        && let Ok(build) = HeaderValue::from_str(build)
    {
        headers.insert(BUILD_HEADER, build);
    }
    response
}

pub(crate) async fn record_health(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let paired = request.extensions().get::<PairedDevice>().cloned();
    let version = reported_version(request.headers());
    let response = next.run(request).await;
    if let Some(paired) = paired {
        let at = tessera_core::now_ms();
        let ok = response.status().is_success();
        let failure = response.extensions().get::<crate::error::ApiFailure>();
        let code = (!ok).then(|| failure.map_or("http_error", |e| e.code));
        let message =
            (!ok).then(|| failure.map_or("The sync request failed.", |e| e.message.as_str()));
        let mut health = state.sync_health.lock();
        let health = health.entry(paired.id).or_default();
        if version.is_some() {
            health.version = version;
        }
        health.last_attempt_at = Some(at);
        record_attempt(&mut health.attempts, at, ok, code, message);
        if ok {
            health.refused = None;
        } else {
            let previous = health.refused.take();
            health.refused = Some(Refused {
                code: code.unwrap().into(),
                message: message.unwrap().into(),
                since: previous.as_ref().map_or(at, |r| r.since),
                attempts: previous.map_or(1, |r| r.attempts + 1),
            });
        }
    }
    response
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sync/clone", post(clone))
        .route("/api/sync/push", post(push))
        .route("/api/sync/pull", post(pull))
        .route("/api/sync/snapshots/missing", post(missing_snapshots))
        .route("/api/sync/snapshots/content", post(snapshot_content))
        .route("/api/sync/snapshots", post(store_snapshots))
        .route("/api/sync/objects/missing", post(missing_objects))
        .route("/api/sync/objects/{sha}", get(object).put(store_object))
        .route("/api/sync/rows", post(exchange_rows))
        .route("/api/sync/retire", post(retire))
        // Book text and long offline runs of edits outgrow the default limit.
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024))
}

fn same_schema(headers: &HeaderMap) -> Result<(), ApiError> {
    let version: u32 = headers
        .get(SCHEMA_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("sync requests need an {SCHEMA_HEADER} header"),
            )
        })?;
    if version != tessera_core::SCHEMA_VERSION {
        return Err(
            ApiError::new(
                StatusCode::CONFLICT,
                "schema_mismatch",
                format!("this hub uses schema {} and the replica uses {version}; run the same Tessera version on both", tessera_core::SCHEMA_VERSION),
            ).with_details(
                serde_json::json!({
                    "hub": crate::SyncVersion::current(),
                    "replica_schema": version,
                }),
            ),
        );
    }
    Ok(())
}

/// Distinguishes clone files written at the same time.
static CLONES: AtomicU64 = AtomicU64::new(0);

async fn clone(
    State(state): State<AppState>,
    paired: Option<Extension<PairedDevice>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    // Only the copy needs the notebook. Removing the hub's own state and
    // compacting run after it is released, and the file is streamed.
    let (snapshot, path) = run(&state, move |notebook| {
        let path = notebook.info()?.path.join(format!(
            "sync-clone-{}-{}.tmp",
            std::process::id(),
            CLONES.fetch_add(1, Ordering::Relaxed)
        ));
        match notebook.sync_clone_for_device(&path, paired.as_ref().map(|p| p.id.as_str())) {
            Ok(snapshot) => Ok((snapshot, path)),
            Err(error) => {
                let _ = std::fs::remove_file(&path);
                Err(error)
            }
        }
    })
    .await?;
    let finished: tessera_core::Result<_> = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            let ticket = snapshot.finish()?;
            // The open file stays readable after its name is gone, so a
            // dropped connection leaves nothing behind.
            let file = std::fs::File::open(&path)?;
            let length = file.metadata()?.len();
            std::fs::remove_file(&path)?;
            tessera_core::Result::Ok((ticket, file, length))
        })
        .await
        .map_err(ApiError::internal)?
    };
    let (ticket, file, length) = match finished {
        Ok(finished) => finished,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error.into());
        }
    };
    let ticket = serde_json::to_string(&ticket).map_err(ApiError::internal)?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(
        tokio::fs::File::from_std(file),
    ));
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.sqlite3"),
    );
    headers.insert(
        TICKET_HEADER,
        HeaderValue::from_str(&ticket).map_err(ApiError::internal)?,
    );
    Ok(response)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct PushRequest {
    pub device: String,
    pub changes: Vec<PushedChange>,
}

async fn push(
    State(state): State<AppState>,
    paired: Option<Extension<PairedDevice>>,
    headers: HeaderMap,
    request: Result<Json<PushRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let notify = state.changes.clone();
    // A paired device's name, else the replica ID for loopback clones.
    let device = paired
        .as_ref()
        .map_or_else(|| request.device.clone(), |p| p.name.clone());
    let receipts = run_authorized(&state, paired, request.device.clone(), move |notebook| {
        let receipts = notebook.sync_push(&request.device, &request.changes)?;
        if let Some(seq) = receipts
            .iter()
            .map(|receipt| match receipt.outcome {
                tessera_core::sync::PushOutcome::Accepted { seq }
                | tessera_core::sync::PushOutcome::Rejected { seq, .. } => seq,
            })
            .max()
        {
            let _ = notify.send(seq);
        }
        Ok(receipts)
    })
    .await?;
    if !receipts.is_empty() {
        let rejected = receipts
            .iter()
            .filter(|receipt| {
                matches!(
                    receipt.outcome,
                    tessera_core::sync::PushOutcome::Rejected { .. }
                )
            })
            .count();
        tracing::info!(
            %device,
            accepted = receipts.len() - rejected,
            rejected,
            "sync push received"
        );
    }
    Ok(Json(receipts).into_response())
}

#[derive(Serialize, Deserialize)]
pub(crate) struct PullRequest {
    pub device: String,
    pub acknowledged: i64,
    pub after: i64,
}

async fn pull(
    State(state): State<AppState>,
    paired: Option<Extension<PairedDevice>>,
    headers: HeaderMap,
    request: Result<Json<PullRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let pull = run_authorized(&state, paired, request.device.clone(), move |notebook| {
        notebook.sync_pull(
            &request.device,
            request.acknowledged,
            request.after,
            PULL_LIMIT,
        )
    })
    .await?;
    Ok(Json(pull).into_response())
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SnapshotIds {
    pub ids: Vec<String>,
}

async fn missing_snapshots(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<SnapshotIds>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let ids = run(&state, move |notebook| {
        notebook.sync_missing_snapshots(&request.ids)
    })
    .await?;
    Ok(Json(SnapshotIds { ids }).into_response())
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ContentRequest {
    pub ids: Vec<String>,
    /// The first passage to send of the first snapshot.
    pub from: i64,
}

async fn snapshot_content(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<ContentRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let content = run(&state, move |notebook| {
        notebook.sync_snapshot_content(&request.ids, request.from)
    })
    .await?;
    Ok(Json(content).into_response())
}

async fn store_snapshots(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<Vec<SnapshotContent>>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    same_schema(&headers)?;
    let Json(content) = request?;
    run(&state, move |notebook| {
        notebook.sync_store_snapshots(&content)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn missing_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<SnapshotIds>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let ids = run(&state, move |notebook| {
        notebook.sync_missing_objects(&request.ids)
    })
    .await?;
    Ok(Json(SnapshotIds { ids }).into_response())
}

async fn object(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sha): Path<String>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let bytes = run(&state, move |notebook| notebook.sync_object(&sha))
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

async fn store_object(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sha): Path<String>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    same_schema(&headers)?;
    run(&state, move |notebook| {
        notebook.sync_store_object(&sha, &body)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct RowsRequest {
    pub device: String,
    pub rows: UnloggedRows,
    pub after: i64,
}

async fn exchange_rows(
    State(state): State<AppState>,
    paired: Option<Extension<PairedDevice>>,
    headers: HeaderMap,
    request: Result<Json<RowsRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let pull = run_authorized(&state, paired, request.device.clone(), move |notebook| {
        notebook.sync_exchange_rows(&request.device, &request.rows, request.after)
    })
    .await?;
    Ok(Json(pull).into_response())
}

#[derive(Serialize, Deserialize)]
pub(crate) struct RetireRequest {
    pub device: String,
}

async fn retire(
    State(state): State<AppState>,
    paired: Option<Extension<PairedDevice>>,
    headers: HeaderMap,
    request: Result<Json<RetireRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    run_authorized(&state, paired, request.device.clone(), move |notebook| {
        notebook.sync_retire(&request.device)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A stored file. A replica that does not have it yet fetches it from its
/// hub and keeps it, so opening a book brings its images.
pub(crate) async fn object_or_fetch(state: &AppState, sha: String) -> Result<Vec<u8>, ApiError> {
    use tessera_core::sync::Hub;
    let notebook = state.notebook.clone();
    tokio::task::spawn_blocking(move || {
        let (url, credentials) = {
            let n = notebook.lock();
            if let Some(bytes) = n.sync_object(&sha)? {
                return Ok(bytes);
            }
            (
                n.sync_status()?.ok_or_else(ApiError::not_found)?.hub_url,
                n.sync_hub_credentials()?,
            )
        };
        let unreachable = |error: anyhow::Error| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "hub_unreachable",
                format!("This file is on the hub, which did not answer: {error}"),
            )
        };
        let mut hub = crate::sync_client::HttpHub::new(
            &url,
            credentials
                .as_ref()
                .and_then(|credentials| credentials.key.as_deref()),
        )
        .map_err(unreachable)?;
        let bytes = hub
            .object(&sha)
            .map_err(|e| unreachable(e.into()))?
            .ok_or_else(ApiError::not_found)?;
        notebook.lock().sync_store_object(&sha, &bytes)?;
        Ok(bytes)
    })
    .await
    .map_err(ApiError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempts_keep_only_the_twenty_newest_outcomes() {
        let mut attempts = std::collections::VecDeque::new();
        for at in 0..30 {
            record_attempt(&mut attempts, at, at % 2 == 0, None, None);
        }
        assert_eq!(attempts.len(), 20);
        assert_eq!(attempts.front().unwrap().at, 29);
        assert_eq!(attempts.back().unwrap().at, 10);
        record_attempt(&mut attempts, 30, false, None, Some("latest"));
        assert_eq!(attempts.len(), 20);
        assert_eq!(attempts[0].count, 2);
        assert_eq!(attempts[0].at, 30);
        assert_eq!(attempts[0].first_at, 29);
        assert_eq!(attempts[0].message.as_deref(), Some("latest"));
    }
}
