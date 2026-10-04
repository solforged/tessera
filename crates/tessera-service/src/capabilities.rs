use axum::{
    Json,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
};
use tessera_core::{
    Agenda, BlockCapabilities, CardPreviews, CardQuery, CardQueryResult, CardUnit, Deck,
    ProjectRecord, ReviewEvent, ReviewSession, TaskOccurrence, TaskQuery, TaskQueryResult,
    TaskView, WorkSession,
};

use crate::{AppState, error::ApiError, run};

pub(crate) async fn block(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<BlockCapabilities>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.capabilities(&id))
        .await
        .map(Json)
}

pub(crate) async fn task_occurrences(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<TaskOccurrence>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.task_occurrences(&id))
        .await
        .map(Json)
}

pub(crate) async fn work_sessions(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<WorkSession>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.work_sessions(&id))
        .await
        .map(Json)
}

pub(crate) async fn active_work_session(
    State(state): State<AppState>,
) -> Result<Json<Option<WorkSession>>, ApiError> {
    run(&state, |notebook| notebook.active_work_session())
        .await
        .map(Json)
}

pub(crate) async fn projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectRecord>>, ApiError> {
    run(&state, |notebook| notebook.projects()).await.map(Json)
}

pub(crate) async fn task_query(
    State(state): State<AppState>,
    body: Result<Json<TaskQuery>, JsonRejection>,
) -> Result<Json<TaskQueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.task_query(&query))
        .await
        .map(Json)
}

pub(crate) async fn agenda(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Agenda>, ApiError> {
    let Path(date) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.agenda(&date))
        .await
        .map(Json)
}

pub(crate) async fn task_views(
    State(state): State<AppState>,
) -> Result<Json<Vec<TaskView>>, ApiError> {
    run(&state, |notebook| notebook.task_views())
        .await
        .map(Json)
}

pub(crate) async fn task_view(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<TaskView>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.task_view(&id))
        .await
        .map(Json)
}

pub(crate) async fn source_cards(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<CardUnit>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.source_cards(&id))
        .await
        .map(Json)
}

pub(crate) async fn card(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<CardUnit>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.card(&id))
        .await
        .map(Json)
}

pub(crate) async fn card_query(
    State(state): State<AppState>,
    body: Result<Json<CardQuery>, JsonRejection>,
) -> Result<Json<CardQueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    run(&state, move |notebook| {
        notebook.card_query(&query, now_ms())
    })
    .await
    .map(Json)
}

pub(crate) async fn card_previews(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<CardPreviews>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    // The core computes both current and reset previews from this one timestamp.
    run(&state, move |notebook| {
        notebook.card_previews(&id, now_ms())
    })
    .await
    .map(Json)
}

pub(crate) async fn card_reviews(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<ReviewEvent>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.review_events(&id))
        .await
        .map(Json)
}

pub(crate) async fn decks(State(state): State<AppState>) -> Result<Json<Vec<Deck>>, ApiError> {
    run(&state, |notebook| notebook.decks()).await.map(Json)
}

pub(crate) async fn deck(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Deck>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.deck(&id))
        .await
        .map(Json)
}

pub(crate) async fn review_sessions(
    State(state): State<AppState>,
) -> Result<Json<Vec<ReviewSession>>, ApiError> {
    run(&state, |notebook| notebook.review_sessions())
        .await
        .map(Json)
}

pub(crate) async fn review_session(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<ReviewSession>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |notebook| notebook.review_session(&id))
        .await
        .map(Json)
}

fn now_ms() -> i64 {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after 1970");
    i64::try_from(elapsed.as_millis()).expect("timestamp fits in i64")
}
