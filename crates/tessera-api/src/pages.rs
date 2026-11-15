use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
};
use serde::Deserialize;

use crate::error::ApiError;
use crate::history::editor_receipt;
use crate::limits::Limit;
use crate::run::{read, run};
use crate::state::WorkshopState;
use tessera_core::NotebookInfo;
use tessera_core::{Actor, Block, Committed, NoteKind, PageView};

pub(crate) async fn notebook_info(
    State(state): State<WorkshopState>,
) -> Result<Json<NotebookInfo>, ApiError> {
    read(&state, |notebook| notebook.info()).await.map(Json)
}

pub(crate) async fn roots(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<Block>>, ApiError> {
    read(&state, |notebook| notebook.roots()).await.map(Json)
}
pub(crate) async fn page(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<PageView>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.page(&id))
        .await
        .map(Json)
}
pub(crate) async fn page_by_title(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(title) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook
            .page_by_name(&title)?
            .ok_or(tessera_core::Error::NotFound {
                what: "atom",
                id: title,
                op_index: None,
            })
    })
    .await
    .map(Json)
}
pub(crate) async fn journal(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(date) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook
            .journal(&date)?
            .ok_or(tessera_core::Error::NotFound {
                what: "atom",
                id: date,
                op_index: None,
            })
    })
    .await
    .map(Json)
}
pub(crate) async fn block(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Block>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.block(&id))
        .await
        .map(Json)
}
pub(crate) async fn subtree(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<tessera_core::Subtree>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.subtree(&id, query.limit))
        .await
        .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct SubtreesRead {
    ids: Vec<String>,
    #[serde(default = "subtree_rows")]
    per_id: usize,
    #[serde(default = "subtree_total")]
    total: usize,
}
fn subtree_rows() -> usize {
    200
}
fn subtree_total() -> usize {
    4096
}
pub(crate) async fn subtrees(
    State(state): State<WorkshopState>,
    body: Result<Json<SubtreesRead>, JsonRejection>,
) -> Result<Json<tessera_core::BatchSubtrees>, ApiError> {
    let Json(body) = body.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| {
        notebook.subtrees(&body.ids, body.per_id, body.total)
    })
    .await
    .map(Json)
}
pub(crate) async fn stream_arrivals(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::StreamArrival>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.stream_arrivals(&id, &notebook.today(tessera_core::now_ms())?, 100, 200)
    })
    .await
    .map(Json)
}
pub(crate) async fn quote_snapshot(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<tessera_core::QuoteState>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.quote_snapshot(&id, tessera_core::now_ms())
    })
    .await
    .map(Json)
}
pub(crate) async fn quote_status(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::QuoteStatus>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.quote_status(&id))
        .await
        .map(Json)
}
pub(crate) async fn deleted_pages(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<tessera_core::DeletedPage>>, ApiError> {
    read(&state, |notebook| notebook.deleted_pages())
        .await
        .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct AliasRequest {
    name: String,
}
pub(crate) async fn add_alias(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    body: Result<Json<AliasRequest>, JsonRejection>,
) -> Result<Json<Option<Committed>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Json(AliasRequest { name }) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let mut committed = notebook.add_alias(&id, &name, Actor::Person)?;
        if let Some(committed) = &mut committed {
            editor_receipt(notebook, &changes, committed)?;
        }
        Ok(committed)
    })
    .await
    .map(Json)
}
pub(crate) async fn note_kinds(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<NoteKind>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.note_kinds(&id))
        .await
        .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct JournalRange {
    from: String,
    to: String,
}
pub(crate) async fn written_journal_dates(
    State(state): State<WorkshopState>,
    query: Result<Query<JournalRange>, QueryRejection>,
) -> Result<Json<Vec<String>>, ApiError> {
    let Query(range) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.written_journal_dates(&range.from, &range.to)
    })
    .await
    .map(Json)
}
