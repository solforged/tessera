use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
};
use tessera_core::now_ms;
use tessera_core::{
    Agenda, BlockCapabilities, CardPreviews, CardQuery, CardQueryResult, CardUnit, Deck,
    PositionQuery, PositionQueryResult, ProjectRecord, ReviewEvent, ReviewSession, TagDeck,
    TaskOccurrence, TaskQuery, TaskQueryResult, TaskView, WorkSession,
};
use tessera_core::{QuestionQuery, QuestionRow};
use tessera_core::{RelationQuery, RelationRow};

use crate::error::ApiError;
use crate::run::read;
use crate::state::WorkshopState;

pub(crate) async fn block(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<BlockCapabilities>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.capabilities(&id))
        .await
        .map(Json)
}

pub(crate) async fn task_occurrences(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<TaskOccurrence>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.task_occurrences(&id))
        .await
        .map(Json)
}

pub(crate) async fn work_sessions(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<WorkSession>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.work_sessions(&id))
        .await
        .map(Json)
}

pub(crate) async fn active_work_session(
    State(state): State<WorkshopState>,
) -> Result<Json<Option<WorkSession>>, ApiError> {
    read(&state, |workshop| workshop.active_work_session())
        .await
        .map(Json)
}

pub(crate) async fn projects(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<ProjectRecord>>, ApiError> {
    read(&state, |workshop| workshop.projects()).await.map(Json)
}

pub(crate) async fn positions(
    State(state): State<WorkshopState>,
    query: Result<Query<PositionQuery>, QueryRejection>,
) -> Result<Json<PositionQueryResult>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.positions(&query))
        .await
        .map(Json)
}

pub(crate) async fn relations(
    State(state): State<WorkshopState>,
    query: Result<Query<RelationQuery>, QueryRejection>,
) -> Result<Json<Vec<RelationRow>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.relations(&query))
        .await
        .map(Json)
}

pub(crate) async fn questions(
    State(state): State<WorkshopState>,
    query: Result<Query<QuestionQuery>, QueryRejection>,
) -> Result<Json<Vec<QuestionRow>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.questions(&query))
        .await
        .map(Json)
}

#[derive(serde::Deserialize)]
pub(crate) struct RevisitQuery {
    due: Option<String>,
}

pub(crate) async fn revisits(
    State(state): State<WorkshopState>,
    query: Result<Query<RevisitQuery>, QueryRejection>,
) -> Result<Json<Vec<tessera_core::RevisitRow>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |workshop| {
        workshop.revisits(query.due.as_deref().unwrap_or("today"), now_ms())
    })
    .await
    .map(Json)
}

pub(crate) async fn revisit_events(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::RevisitEvent>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.revisit_events(&id))
        .await
        .map(Json)
}

pub(crate) async fn task_query(
    State(state): State<WorkshopState>,
    body: Result<Json<TaskQuery>, JsonRejection>,
) -> Result<Json<TaskQueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.task_query(&query))
        .await
        .map(Json)
}

pub(crate) async fn agenda(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Agenda>, ApiError> {
    let Path(date) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.agenda(&date))
        .await
        .map(Json)
}

pub(crate) async fn task_views(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<TaskView>>, ApiError> {
    read(&state, |workshop| workshop.task_views())
        .await
        .map(Json)
}

pub(crate) async fn task_view(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<TaskView>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.task_view(&id))
        .await
        .map(Json)
}

pub(crate) async fn source_cards(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<CardUnit>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.source_cards(&id))
        .await
        .map(Json)
}

pub(crate) async fn page_cards(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<CardUnit>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.page_cards(&id))
        .await
        .map(Json)
}

pub(crate) async fn card(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<CardUnit>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.card(&id))
        .await
        .map(Json)
}

pub(crate) async fn card_query(
    State(state): State<WorkshopState>,
    body: Result<Json<CardQuery>, JsonRejection>,
) -> Result<Json<CardQueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    read(&state, move |workshop| {
        workshop.card_query(&query, now_ms())
    })
    .await
    .map(Json)
}

pub(crate) async fn card_previews(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<CardPreviews>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    // The core computes both current and reset previews from this one timestamp.
    read(&state, move |workshop| {
        workshop.card_previews(&id, now_ms())
    })
    .await
    .map(Json)
}

pub(crate) async fn card_reviews(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<ReviewEvent>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.review_events(&id))
        .await
        .map(Json)
}

pub(crate) async fn decks(State(state): State<WorkshopState>) -> Result<Json<Vec<Deck>>, ApiError> {
    read(&state, |workshop| workshop.decks()).await.map(Json)
}

pub(crate) async fn tag_decks(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<TagDeck>>, ApiError> {
    read(&state, |workshop| workshop.tag_decks())
        .await
        .map(Json)
}

pub(crate) async fn deck(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Deck>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.deck(&id))
        .await
        .map(Json)
}

pub(crate) async fn review_sessions(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<ReviewSession>>, ApiError> {
    read(&state, |workshop| workshop.review_sessions())
        .await
        .map(Json)
}

pub(crate) async fn review_session(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<ReviewSession>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |workshop| workshop.review_session(&id))
        .await
        .map(Json)
}
