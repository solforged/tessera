//! Hub routes for replicas. See "Protocol" in `docs/sync.md`.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tessera_core::SCHEMA_VERSION;
use tessera_core::sync::{PULL_LIMIT, PushedChange, SnapshotContent, UnloggedRows, check_schema};

use crate::{AppState, error::ApiError, run};

/// The schema version a replica runs; every sync request carries it.
pub(crate) const SCHEMA_HEADER: &str = "x-tessera-schema";
/// The clone ticket, beside the database bytes it describes.
pub(crate) const TICKET_HEADER: &str = "x-tessera-clone";

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
    let version = headers
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
    Ok(check_schema(version)?)
}

/// Distinguishes clone files written at the same time.
static CLONES: AtomicU64 = AtomicU64::new(0);

async fn clone(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    // Only the copy needs the notebook. Removing the hub's own state and
    // compacting run after it is released, and the file is streamed.
    let (snapshot, path) = run(&state, |notebook| {
        let path = notebook.info()?.path.join(format!(
            "sync-clone-{}-{}.tmp",
            std::process::id(),
            CLONES.fetch_add(1, Ordering::Relaxed)
        ));
        match notebook.sync_clone(&path) {
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
    headers: HeaderMap,
    request: Result<Json<PushRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let notify = state.changes.clone();
    let receipts = run(&state, move |notebook| {
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
    headers: HeaderMap,
    request: Result<Json<PullRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let pull = run(&state, move |notebook| {
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

async fn snapshot_content(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<SnapshotIds>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let content = run(&state, move |notebook| {
        notebook.sync_snapshot_content(&request.ids)
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
    headers: HeaderMap,
    request: Result<Json<RowsRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    let pull = run(&state, move |notebook| {
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
    headers: HeaderMap,
    request: Result<Json<RetireRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    same_schema(&headers)?;
    let Json(request) = request?;
    run(&state, move |notebook| {
        notebook.sync_retire(&request.device)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A stored file. A replica that does not have it yet fetches it from its
/// hub and keeps it, so opening a book brings its images.
pub(crate) async fn object_or_fetch(state: &AppState, sha: String) -> Result<Vec<u8>, ApiError> {
    let (local, hub) = {
        let sha = sha.clone();
        run(state, move |notebook| {
            Ok((
                notebook.sync_object(&sha)?,
                notebook.sync_status()?.map(|status| status.hub_url),
            ))
        })
        .await?
    };
    if let Some(bytes) = local {
        return Ok(bytes);
    }
    let hub = hub.ok_or_else(ApiError::not_found)?;
    let unreachable = |error: reqwest::Error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "hub_unreachable",
            format!("This file is on the hub, which did not answer: {error}"),
        )
    };
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(ApiError::internal)?
        .get(format!("{hub}/api/sync/objects/{sha}"))
        .header(SCHEMA_HEADER, SCHEMA_VERSION)
        .send()
        .await
        .map_err(unreachable)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(ApiError::not_found());
    }
    let bytes = response
        .error_for_status()
        .map_err(unreachable)?
        .bytes()
        .await
        .map_err(unreachable)?
        .to_vec();
    let kept = bytes.clone();
    run(state, move |notebook| {
        notebook.sync_store_object(&sha, &kept)
    })
    .await?;
    Ok(bytes)
}
