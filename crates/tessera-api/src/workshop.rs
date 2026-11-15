use axum::{
    Router,
    extract::{DefaultBodyLimit, FromRef},
    routing::{get, post},
};

use crate::capabilities;
use crate::changes::{change_head, changes};
use crate::check::{check_notebook, repair_notebook};
use crate::error::ApiError;
use crate::history::{agent_edit, apply, history, undo_change};
use crate::images;
use crate::library;
use crate::pages::{
    add_alias, block, deleted_pages, journal, note_kinds, notebook_info, page, page_by_title,
    quote_snapshot, quote_status, roots, stream_arrivals, subtree, subtrees, written_journal_dates,
};
use crate::queries::{
    backlinks, card_template_forecast, card_templates, complete, entities, field_detail, fields,
    incoming_fields, kind_notes, members, note_index, page_references, query, reference_counts,
    resolve_name, review_session_events, review_stats, saved_spread, search, settings, spread,
    starting_template, type_info, types, unlinked_mentions, view, views,
};
use crate::state::{EmbeddedHandles, WorkshopState};

/// Workshop routes shared by every host. Native routers add disk size and replica routes.
pub fn workshop_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    WorkshopState: FromRef<S>,
{
    Router::new()
        .route("/api/notebook", get(notebook_info))
        .route("/api/settings", get(settings))
        .route("/api/roots", get(roots))
        .route("/api/pages/deleted", get(deleted_pages))
        .route("/api/pages/{id}", get(page))
        .route("/api/pages/{id}/cards", get(capabilities::page_cards))
        .route("/api/pages/by-title/{title}", get(page_by_title))
        .route("/api/pages/{id}/kinds", get(note_kinds))
        .route("/api/pages/{id}/aliases", post(add_alias))
        .route("/api/names/{name}", get(resolve_name))
        .route("/api/index", get(note_index))
        .route("/api/index/{key}", get(kind_notes))
        .route("/api/spreads", post(spread))
        .route("/api/pages/{id}/spread", get(saved_spread))
        .route("/api/journal/written", get(written_journal_dates))
        .route("/api/journal/{date}", get(journal))
        .route("/api/blocks/{id}", get(block))
        .route("/api/blocks/{id}/subtree", get(subtree))
        .route("/api/blocks/subtrees", post(subtrees))
        .route("/api/pages/{id}/arrivals", get(stream_arrivals))
        .route("/api/blocks/{id}/quote-snapshot", get(quote_snapshot))
        .route("/api/pages/{id}/quote-status", get(quote_status))
        .route("/api/blocks/{id}/backlinks", get(backlinks))
        .route("/api/blocks/{id}/incoming-fields", get(incoming_fields))
        .route("/api/pages/{id}/references", get(page_references))
        .route("/api/pages/{id}/reference-counts", get(reference_counts))
        .route("/api/pages/{id}/unlinked-mentions", get(unlinked_mentions))
        .route("/api/types/{id}/members", get(members))
        .route("/api/types/{id}/card-templates", get(card_templates))
        .route(
            "/api/card-templates/{id}/forecast",
            get(card_template_forecast),
        )
        .route("/api/blocks/{id}/capabilities", get(capabilities::block))
        .route(
            "/api/blocks/{id}/task-occurrences",
            get(capabilities::task_occurrences),
        )
        .route(
            "/api/blocks/{id}/work-sessions",
            get(capabilities::work_sessions),
        )
        .route(
            "/api/work-sessions/active",
            get(capabilities::active_work_session),
        )
        .route("/api/projects", get(capabilities::projects))
        .route("/api/positions", get(capabilities::positions))
        .route("/api/relations", get(capabilities::relations))
        .route("/api/questions", get(capabilities::questions))
        .route("/api/revisits", get(capabilities::revisits))
        .route(
            "/api/blocks/{id}/revisits",
            get(capabilities::revisit_events),
        )
        .route("/api/tasks/query", post(capabilities::task_query))
        .route("/api/agenda/{date}", get(capabilities::agenda))
        .route("/api/task-views", get(capabilities::task_views))
        .route("/api/task-views/{id}", get(capabilities::task_view))
        .route("/api/blocks/{id}/cards", get(capabilities::source_cards))
        .route("/api/cards/{id}", get(capabilities::card))
        .route("/api/cards/query", post(capabilities::card_query))
        .route("/api/cards/{id}/previews", get(capabilities::card_previews))
        .route("/api/cards/{id}/reviews", get(capabilities::card_reviews))
        .route("/api/decks", get(capabilities::decks))
        .route("/api/tag-decks", get(capabilities::tag_decks))
        .route("/api/decks/{id}", get(capabilities::deck))
        .route("/api/review-sessions", get(capabilities::review_sessions))
        .route(
            "/api/review-sessions/{id}",
            get(capabilities::review_session),
        )
        .route("/api/review/stats", get(review_stats))
        .route(
            "/api/review-sessions/{id}/reviews",
            get(review_session_events),
        )
        .route("/api/types", get(types))
        .route("/api/entities", get(entities))
        .route("/api/types/{id}", get(type_info))
        .route("/api/types/{id}/starting-template", post(starting_template))
        .route("/api/fields", get(fields))
        .route("/api/fields/{id}", get(field_detail))
        .route("/api/query", post(query))
        .route("/api/views", get(views))
        .route("/api/views/{id}", get(view))
        .route("/api/complete", get(complete))
        .route("/api/search", get(search))
        .route("/api/changes", get(changes))
        .route("/api/changes/head", get(change_head))
        .route("/api/check", get(check_notebook))
        .route("/api/check/repair", post(repair_notebook))
        .route("/api/batches", post(apply))
        .route("/api/agent-changes", post(agent_edit))
        .route("/api/history", get(history))
        .route("/api/history/{seq}/undo", post(undo_change))
}

/// Build the notebook and library API for a host that runs the notebook in its own process.
/// It has no socket, so it omits the host and origin policy, static assets, service details
/// and the WebSocket change stream; hosts deliver changes from [`EmbeddedHandles`].
/// The browser worker ingests queued uploads before this returns.
pub fn embedded_router(
    notebook: tessera_core::Notebook,
) -> Result<(Router, EmbeddedHandles), String> {
    let state = WorkshopState::open(notebook)?;
    let handles = EmbeddedHandles {
        notebook: state.notebook.clone(),
        changes: state.changes.clone(),
    };
    let router = workshop_routes()
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
        .merge(images::routes())
        .with_state(state);
    Ok((router, handles))
}
