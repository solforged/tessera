//! One change-stream loop. The broadcast value is an editor cursor used only as a wakeup.
//! Subscribe before reading history, then catch up by cursor on every wakeup.

use std::future::Future;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use futures_util::future::{Either, select};
use parking_lot::Mutex;
use serde::Deserialize;
use tessera_core::{ChangeEvent, Notebook};
use tokio::sync::broadcast;

use crate::error::ApiError;
use crate::run::{NotebookError, read_notebook};
use crate::state::WorkshopState;

/// Page size for `GET /api/changes` and the service WebSocket. The phone and the
/// browser worker pass their own page size.
pub const CHANGES_PAGE_SIZE: usize = 500;

fn default_changes_limit() -> usize {
    CHANGES_PAGE_SIZE
}

#[derive(Deserialize)]
pub(crate) struct ChangesQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "default_changes_limit")]
    limit: usize,
}

pub(crate) async fn change_head(State(state): State<WorkshopState>) -> Result<Json<i64>, ApiError> {
    crate::run::run(&state.notebook, |notebook| notebook.editor_cursor())
        .await
        .map(Json)
}

pub(crate) async fn changes(
    State(state): State<WorkshopState>,
    query: Result<Query<ChangesQuery>, QueryRejection>,
) -> Result<Json<Vec<ChangeEvent>>, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    crate::run::run(&state.notebook, move |notebook| {
        notebook.changes_since(query.after, query.limit)
    })
    .await
    .map(Json)
}

/// The sink asked the loop to end, or delivery failed.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StreamStop {
    Continue,
    Stop,
}

/// A host that receives each serialized [`ChangeEvent`] and can ask to stop.
pub trait ChangeSink {
    type Error;
    fn emit(&mut self, event: String) -> impl Future<Output = Result<StreamStop, Self::Error>>;
}

pub enum FollowError<E> {
    Workshop(NotebookError),
    Encode(serde_json::Error),
    Sink(E),
}

/// Follow committed editor changes.
///
/// Subscribes before reading history. A commit in either phase is observed by
/// history, the receiver, or both; the cursor removes the overlap. `gate` is
/// checked before each history read and before each event, so a callback that
/// closes its subscription is not followed into a reset workshop. `watch`
/// completes when the host wants to stop for a reason other than the sink, such
/// as a WebSocket close. A pending watch never completes; aborting the task
/// stops a phone stream.
pub async fn follow_changes<S, G, W>(
    changes: &broadcast::Sender<i64>,
    notebook: Arc<Mutex<Notebook>>,
    mut after: i64,
    page_size: usize,
    mut gate: G,
    sink: &mut S,
    watch: W,
) -> Result<(), FollowError<S::Error>>
where
    S: ChangeSink,
    G: FnMut() -> bool,
    W: Future<Output = ()>,
{
    let mut wakeups = changes.subscribe();
    let mut watch = std::pin::pin!(watch);
    if catch_up(&notebook, &mut after, page_size, &mut gate, sink).await? == StreamStop::Stop {
        return Ok(());
    }
    loop {
        let wakeup = std::pin::pin!(wakeups.recv());
        match select(wakeup, watch.as_mut()).await {
            Either::Left((notification, _)) => match notification {
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
                // The value is an editor cursor, not a change sequence. A cursor
                // that has not moved cannot name an event this stream has missed.
                Ok(seq) if seq <= after => continue,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    if catch_up(&notebook, &mut after, page_size, &mut gate, sink).await?
                        == StreamStop::Stop
                    {
                        return Ok(());
                    }
                }
            },
            Either::Right((_, _)) => return Ok(()),
        }
    }
}

async fn catch_up<S, G>(
    notebook: &Arc<Mutex<Notebook>>,
    after: &mut i64,
    page_size: usize,
    gate: &mut G,
    sink: &mut S,
) -> Result<StreamStop, FollowError<S::Error>>
where
    S: ChangeSink,
    G: FnMut() -> bool,
{
    loop {
        if !gate() {
            return Ok(StreamStop::Stop);
        }
        let cursor = *after;
        let changes = read_notebook(notebook, move |notebook| {
            notebook.changes_since(cursor, page_size)
        })
        .await
        .map_err(FollowError::Workshop)?;
        if changes.is_empty() {
            return Ok(StreamStop::Continue);
        }
        for change in changes {
            if !gate() {
                return Ok(StreamStop::Stop);
            }
            if change.seq > *after {
                let text = serde_json::to_string(&change).map_err(FollowError::Encode)?;
                if sink.emit(text).await.map_err(FollowError::Sink)? == StreamStop::Stop {
                    return Ok(StreamStop::Stop);
                }
                *after = change.seq;
            }
        }
    }
}
