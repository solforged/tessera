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
use crate::limits::{Limit, default_limit};
use crate::run::{read, run};
use crate::state::WorkshopState;
use tessera_core::{
    Actor, Backlink, BlockInPage, Committed, Completion, FieldDetail, FieldKind, FieldsView,
    KindIndex, NameMatch, NoteIndex, QueryResult, SettingsView, TypeInfo, View,
};
use tessera_core::{IncomingFieldValue, PageReferences, ReferenceCount, UnlinkedMentions};

#[derive(Deserialize)]
pub(crate) struct ReviewStatsQuery {
    deck: Option<String>,
    date: Option<String>,
}
pub(crate) async fn review_stats(
    State(state): State<WorkshopState>,
    query: Result<Query<ReviewStatsQuery>, QueryRejection>,
) -> Result<Json<tessera_core::ReviewStats>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        let date = query
            .date
            .map(Ok)
            .unwrap_or_else(|| notebook.today(tessera_core::now_ms()))?;
        notebook.review_stats(query.deck.as_deref(), &date)
    })
    .await
    .map(Json)
}
pub(crate) async fn review_session_events(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::ReviewEvent>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| {
        notebook.review_session_events(&id)
    })
    .await
    .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct TextQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
}
pub(crate) async fn backlinks(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<Vec<Backlink>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.backlinks(&id, query.limit))
        .await
        .map(Json)
}
pub(crate) async fn incoming_fields(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<IncomingFieldValue>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.incoming_field_values(&id))
        .await
        .map(Json)
}
pub(crate) async fn page_references(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<PageReferences>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.page_references(&id, query.limit)
    })
    .await
    .map(Json)
}
pub(crate) async fn reference_counts(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<ReferenceCount>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.reference_counts(&id))
        .await
        .map(Json)
}
pub(crate) async fn unlinked_mentions(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<UnlinkedMentions>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.unlinked_mentions(&id, query.limit)
    })
    .await
    .map(Json)
}
pub(crate) async fn members(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Limit>, QueryRejection>,
) -> Result<Json<Vec<BlockInPage>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.members(&id, query.limit))
        .await
        .map(Json)
}
pub(crate) async fn fields(
    State(state): State<WorkshopState>,
) -> Result<Json<FieldsView>, ApiError> {
    read(&state, |notebook| notebook.fields()).await.map(Json)
}
#[derive(Deserialize)]
pub(crate) struct FieldDetailQuery {
    kind: Option<FieldKind>,
    limit: Option<usize>,
}
pub(crate) async fn field_detail(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<FieldDetailQuery>, QueryRejection>,
) -> Result<Json<FieldDetail>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.field_detail(&id, query.kind, query.limit)
    })
    .await
    .map(Json)
}
/// People and groups, including members of types that refine them: the pages that can hold perspectives.
pub(crate) async fn entities(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<String>>, ApiError> {
    read(&state, |notebook| notebook.entities()).await.map(Json)
}
pub(crate) async fn types(
    State(state): State<WorkshopState>,
) -> Result<Json<Vec<TypeInfo>>, ApiError> {
    read(&state, |notebook| notebook.types()).await.map(Json)
}
pub(crate) async fn type_info(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<TypeInfo>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.type_info(&id))
        .await
        .map(Json)
}
pub(crate) async fn card_templates(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<tessera_core::CardTemplateInfo>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.card_templates(&id))
        .await
        .map(Json)
}
#[derive(Deserialize)]
pub(crate) struct TemplateForecastQuery {
    days: Option<usize>,
}
pub(crate) async fn card_template_forecast(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<TemplateForecastQuery>, QueryRejection>,
) -> Result<Json<tessera_core::CardTemplateForecast>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(query) = query.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| {
        notebook.card_template_forecast(&id, query.days.unwrap_or(14), tessera_core::now_ms())
    })
    .await
    .map(Json)
}
pub(crate) async fn note_index(
    State(state): State<WorkshopState>,
) -> Result<Json<NoteIndex>, ApiError> {
    read(&state, |notebook| notebook.note_index())
        .await
        .map(Json)
}
pub(crate) async fn kind_notes(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<KindIndex>, ApiError> {
    let Path(key) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.kind_notes(&key))
        .await
        .map(Json)
}
pub(crate) async fn spread(
    State(state): State<WorkshopState>,
    body: Result<Json<Vec<String>>, JsonRejection>,
) -> Result<Json<tessera_core::Spread>, ApiError> {
    let Json(ids) = body.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| notebook.spread(&ids))
        .await
        .map(Json)
}
pub(crate) async fn saved_spread(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<tessera_core::Spread>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.saved_spread(&id))
        .await
        .map(Json)
}
pub(crate) async fn query(
    State(state): State<WorkshopState>,
    body: Result<Json<tessera_core::Query>, JsonRejection>,
) -> Result<Json<QueryResult>, ApiError> {
    let Json(query) = body.map_err(ApiError::from)?;
    run(&state.notebook, move |notebook| notebook.query(&query))
        .await
        .map(Json)
}
pub(crate) async fn views(State(state): State<WorkshopState>) -> Result<Json<Vec<View>>, ApiError> {
    read(&state, |notebook| notebook.views()).await.map(Json)
}
pub(crate) async fn settings(
    State(state): State<WorkshopState>,
) -> Result<Json<SettingsView>, ApiError> {
    read(&state, |notebook| {
        notebook.settings_view(tessera_core::now_ms())
    })
    .await
    .map(Json)
}
pub(crate) async fn view(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<View>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.view(&id))
        .await
        .map(Json)
}
pub(crate) async fn complete(
    State(state): State<WorkshopState>,
    query: Result<Query<TextQuery>, QueryRejection>,
) -> Result<Json<Vec<Completion>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.complete(&query.q, query.limit)
    })
    .await
    .map(Json)
}
pub(crate) async fn resolve_name(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<NameMatch>>, ApiError> {
    let Path(name) = path.map_err(ApiError::from)?;
    read(&state, move |notebook| notebook.resolve_name(&name))
        .await
        .map(Json)
}
pub(crate) async fn starting_template(
    State(state): State<WorkshopState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Option<Committed>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let mut committed = notebook.apply_starting_template(&id, Actor::Person)?;
        if let Some(committed) = &mut committed {
            editor_receipt(notebook, &changes, committed)?;
        }
        Ok(committed)
    })
    .await
    .map(Json)
}
pub(crate) async fn search(
    State(state): State<WorkshopState>,
    query: Result<Query<TextQuery>, QueryRejection>,
) -> Result<Json<Vec<BlockInPage>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    read(&state, move |notebook| {
        notebook.search(&query.q, query.limit)
    })
    .await
    .map(Json)
}
