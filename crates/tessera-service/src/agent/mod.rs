//! Machine-local provider settings and notebook-attributed streaming agent turns.

mod provider;
mod store;
mod tools;

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode,
    routing::{get, post},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;
use ulid::Ulid;

use crate::{AppState, error::ApiError};
use provider::Message;
use store::{Provider, Providers, SaveProviders, Store, invalid};

const EXPIRY: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_secs(25);

pub(crate) struct Runtime {
    store: Mutex<Store>,
    turns: Mutex<HashMap<String, Arc<Turn>>>,
    client: reqwest::Client,
}

impl Runtime {
    pub fn new(path: Option<PathBuf>) -> Result<Self, String> {
        Ok(Self {
            store: Mutex::new(Store::new(path)),
            turns: Mutex::default(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }

    fn turn(&self, id: &str) -> Result<Arc<Turn>, ApiError> {
        self.turns
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(ApiError::not_found)
    }
}

#[derive(Clone, Serialize)]
struct Event {
    n: u64,
    #[serde(flatten)]
    kind: EventKind,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum EventKind {
    Text {
        delta: String,
    },
    Tool {
        name: String,
        summary: String,
    },
    Edit {
        seq: i64,
        summary: String,
        page: Option<String>,
        blocks: Vec<String>,
    },
    Error {
        message: String,
    },
    Done {
        stop: Stop,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Stop {
    End,
    Cancelled,
    Limit,
    Error,
}

#[derive(Default)]
struct Log {
    events: Vec<Event>,
    done: bool,
}

struct Turn {
    log: Mutex<Log>,
    changed: watch::Sender<u64>,
    cancel: watch::Sender<bool>,
}

impl Turn {
    fn new() -> Self {
        Self {
            log: Mutex::default(),
            changed: watch::channel(0).0,
            cancel: watch::channel(false).0,
        }
    }

    fn push(&self, kind: EventKind) {
        let mut log = self.log.lock();
        if log.done {
            return;
        }
        if matches!(kind, EventKind::Done { .. }) {
            log.done = true;
        }
        let n = log.events.len() as u64 + 1;
        log.events.push(Event { n, kind });
        self.changed.send_replace(n);
    }

    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    fn snapshot(&self, after: u64) -> Events {
        let log = self.log.lock();
        let offset = usize::try_from(after)
            .unwrap_or(usize::MAX)
            .min(log.events.len());
        Events {
            events: log.events[offset..].to_vec(),
            done: log.done,
        }
    }
}

#[derive(Serialize)]
struct Events {
    events: Vec<Event>,
    done: bool,
}

#[derive(Deserialize)]
struct ThreadMessage {
    role: Role,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    User,
    Assistant,
}

#[derive(Deserialize)]
struct ContextRef {
    page_id: String,
    block_id: Option<String>,
}

#[derive(Deserialize)]
struct Start {
    provider: String,
    prompt: String,
    messages: Vec<ThreadMessage>,
    context: Vec<ContextRef>,
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/providers", get(providers).put(save_providers))
        .route("/api/agent/providers/{id}/test", post(test_provider))
        .route("/api/agent/turns", post(start))
        .route("/api/agent/turns/{id}/events", get(events))
        .route("/api/agent/turns/{id}/cancel", post(cancel))
}

async fn access_store<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&Store) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let runtime = state.agent.clone();
    tokio::task::spawn_blocking(move || operation(&runtime.store.lock()))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "agent_storage",
                "Couldn't open the agent settings.",
            )
        })?
}

async fn providers(State(state): State<AppState>) -> Result<Json<Providers>, ApiError> {
    access_store(&state, Store::list).await.map(Json)
}

async fn save_providers(
    State(state): State<AppState>,
    body: Result<Json<SaveProviders>, JsonRejection>,
) -> Result<Json<Providers>, ApiError> {
    let Json(input) = body.map_err(|_| invalid("Invalid provider settings."))?;
    access_store(&state, move |store| store.save(input))
        .await
        .map(Json)
}

async fn test_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let provider = access_store(&state, move |store| store.get(&id)).await?;
    tokio::time::timeout(
        Duration::from_secs(60),
        provider::complete(
            &state.agent.client,
            &provider,
            "Reply briefly.",
            &[Message::User("Say OK.".into())],
            &[],
            32,
            |_| {},
        ),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "agent_provider",
            "The provider test timed out.",
        )
    })?
    .map_err(provider::Failure::api)?;
    Ok(Json(json!({"ok":true})))
}

async fn start(
    State(state): State<AppState>,
    body: Result<Json<Start>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = body.map_err(ApiError::from)?;
    if request.prompt.trim().is_empty() {
        return Err(invalid("A prompt is required."));
    }
    let id = request.provider.clone();
    let provider = access_store(&state, move |store| store.get(&id)).await?;
    let id = Ulid::generate().to_string();
    let turn = Arc::new(Turn::new());
    state.agent.turns.lock().insert(id.clone(), turn.clone());
    let runtime = Arc::downgrade(&state.agent);
    let running = turn.clone();
    let job = tokio::spawn(run_turn(state, provider, request, running));
    let expires = id.clone();
    tokio::spawn(async move {
        let stop = match job.await {
            Ok(Ok(stop)) => stop,
            Ok(Err(message)) => {
                turn.push(EventKind::Error { message });
                Stop::Error
            }
            Err(_) => {
                turn.push(EventKind::Error {
                    message: "The agent stopped on an error.".into(),
                });
                Stop::Error
            }
        };
        turn.push(EventKind::Done {
            stop: if turn.cancelled() {
                Stop::Cancelled
            } else {
                stop
            },
        });
        tokio::time::sleep(EXPIRY).await;
        if let Some(runtime) = runtime.upgrade() {
            runtime.turns.lock().remove(&expires);
        }
    });
    Ok(Json(json!({"turn":id})))
}

#[derive(Default, Deserialize)]
struct After {
    #[serde(default)]
    after: u64,
}

async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: Result<Query<After>, QueryRejection>,
) -> Result<Json<Events>, ApiError> {
    let Query(After { after }) = query.map_err(ApiError::from)?;
    let turn = state.agent.turn(&id)?;
    let mut changed = turn.changed.subscribe();
    let _ = tokio::time::timeout(POLL, async {
        loop {
            let snapshot = turn.snapshot(after);
            if snapshot.done || !snapshot.events.is_empty() {
                break;
            }
            if changed.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    Ok(Json(turn.snapshot(after)))
}

async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.agent.turn(&id)?.cancel.send_replace(true);
    Ok(StatusCode::NO_CONTENT)
}

async fn run_turn(
    state: AppState,
    provider: Provider,
    request: Start,
    turn: Arc<Turn>,
) -> Result<Stop, String> {
    let mut cancelled = turn.cancel.subscribe();
    let notebook = state.notebook.clone();
    let system =
        tokio::task::spawn_blocking(move || tools::context(&notebook.lock(), &request.context))
            .await
            .map_err(|_| "Cannot read notebook context.".to_owned())?
            .map_err(|e| provider.redact(&e.to_string()))?;
    let actor = format!("{} · {}", provider.name, provider.model);
    let reason: String = request.prompt.trim().chars().take(200).collect();
    let mut history: Vec<Message> = request
        .messages
        .into_iter()
        .map(|m| match m.role {
            Role::User => Message::User(m.text),
            Role::Assistant => Message::Assistant {
                text: m.text,
                calls: Vec::new(),
            },
        })
        .collect();
    history.push(Message::User(request.prompt));
    let definitions = tools::definitions();
    for _ in 0..12 {
        if turn.cancelled() {
            return Ok(Stop::Cancelled);
        }
        let reply = tokio::select! {
            biased;
            _ = cancelled.changed() => return Ok(Stop::Cancelled),
            reply = provider::complete(&state.agent.client, &provider, &system, &history, &definitions, 4096, |delta| {
                turn.push(EventKind::Text { delta: delta.to_owned() });
            }) => reply.map_err(|e| e.message)?,
        };
        if reply.calls.is_empty() {
            return Ok(Stop::End);
        }
        let assistant = history.len();
        let count = reply.calls.len();
        history.push(Message::Assistant {
            text: reply.text,
            calls: reply.calls,
        });
        for index in 0..count {
            let Message::Assistant { calls, .. } = &history[assistant] else {
                unreachable!()
            };
            let call = &calls[index];
            let call_id = call.id.clone();
            if turn.cancelled() {
                return Ok(Stop::Cancelled);
            }
            let args = serde_json::from_str::<Value>(&call.arguments)
                .map_err(|_| "Tool arguments must be valid JSON.".to_owned());
            let result = match args {
                Err(error) => Err(error),
                Ok(args) => {
                    let notebook = state.notebook.clone();
                    let changes = state.changes.clone();
                    let running = turn.clone();
                    let name = call.name.clone();
                    let actor = actor.clone();
                    let reason = reason.clone();
                    // Await a started notebook operation even when cancelled: its edit event
                    // must be delivered before done, never after it.
                    tokio::task::spawn_blocking(move || {
                        let mut notebook = notebook.lock();
                        if running.cancelled() {
                            return Err("Turn cancelled.".to_owned());
                        }
                        tools::execute(&mut notebook, &changes, &name, &args, &actor, &reason)
                            .map_err(|e| e.to_string())
                    })
                    .await
                    .map_err(|_| "The notebook tool failed.".to_owned())?
                }
            };
            let (text, error) = match result {
                Ok((text, event)) => {
                    turn.push(event);
                    (text, false)
                }
                Err(message) => (provider.redact(&message), true),
            };
            history.push(Message::Result {
                id: call_id,
                text,
                error,
            });
        }
    }
    Ok(Stop::Limit)
}
