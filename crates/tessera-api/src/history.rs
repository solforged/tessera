use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
};
use serde::Deserialize;
use tessera_core::Notebook;
use tokio::sync::broadcast;

use crate::error::ApiError;
use crate::limits::default_limit;
use crate::run::run;
use crate::state::WorkshopState;
use tessera_core::{Actor, Batch, Committed};
use tessera_core::{AgentReceipt, AgentRequest, HistoryEntry, UndoReceipt};

pub fn editor_receipt(
    notebook: &Notebook,
    changes: &broadcast::Sender<i64>,
    committed: &mut Committed,
) -> tessera_core::Result<()> {
    committed.seq = notebook.editor_change_cursor(committed.seq)?;
    if !committed.replayed {
        // Publish while the writer lock is still held, in arrival order.
        let _ = changes.send(notebook.editor_cursor()?);
    }
    Ok(())
}
pub(crate) async fn apply(
    State(state): State<WorkshopState>,
    body: Result<Json<Batch>, JsonRejection>,
) -> Result<Json<Committed>, ApiError> {
    let Json(batch) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let mut committed = notebook.apply(&batch)?;
        editor_receipt(notebook, &changes, &mut committed)?;
        Ok(committed)
    })
    .await
    .map(Json)
}
/// The agent write path: add a note, edit, move or delete a block, or set a
/// task, as one attributed batch that records its own undo. An
/// `Idempotency-Key` header makes a resent request return its first receipt.
pub(crate) async fn agent_edit(
    State(state): State<WorkshopState>,
    headers: axum::http::HeaderMap,
    body: Result<Json<AgentRequest>, JsonRejection>,
) -> Result<Json<AgentReceipt>, ApiError> {
    let Json(request) = body.map_err(ApiError::from)?;
    let key = headers
        .get("idempotency-key")
        .map(|value| {
            value.to_str().map(str::to_owned).map_err(|_| {
                ApiError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    "invalid_header",
                    "The Idempotency-Key header must be plain ASCII text.",
                )
            })
        })
        .transpose()?;
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let mut receipt = notebook.agent_edit_keyed(&request, key.as_deref())?;
        editor_receipt(notebook, &changes, &mut receipt.committed)?;
        Ok(receipt)
    })
    .await
    .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct HistoryQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    before: Option<i64>,
}
#[derive(serde::Serialize)]
pub(crate) struct HistoryResponse {
    entries: Vec<HistoryEntry>,
}
pub(crate) async fn history(
    State(state): State<WorkshopState>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<HistoryResponse>, ApiError> {
    let Query(HistoryQuery { limit, before }) = query.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| {
        notebook.history(limit, before)
    })
    .await
    .map(|entries| Json(HistoryResponse { entries }))
}
#[derive(Deserialize)]
pub(crate) struct UndoRequest {
    actor: Actor,
}
pub(crate) async fn undo_change(
    State(state): State<WorkshopState>,
    path: Result<Path<i64>, PathRejection>,
    body: Result<Json<UndoRequest>, JsonRejection>,
) -> Result<Json<UndoReceipt>, ApiError> {
    let Path(seq) = path.map_err(ApiError::from)?;
    let Json(UndoRequest { actor }) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let mut receipt = notebook.undo_change(seq, &actor)?;
        editor_receipt(notebook, &changes, &mut receipt.committed)?;
        Ok(receipt)
    })
    .await
    .map(Json)
}
