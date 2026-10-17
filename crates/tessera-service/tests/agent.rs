use std::{
    collections::VecDeque,
    convert::Infallible,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::Response,
    routing::post,
};
use futures_util::Stream;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::{Actor, AgentEdit, AgentRequest, NoteBlock, NoteTarget, Notebook};
use tower::ServiceExt;

async fn request(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

fn embedded(dir: &std::path::Path) -> (Router, tessera_service::EmbeddedHandles) {
    tessera_service::embedded_router_with_paths(
        Notebook::open(dir.join("notebook")).unwrap(),
        dir.join("agent.json"),
        None,
    )
    .unwrap()
}

async fn save(app: &Router, protocol: &str, base: &str, key: Option<Value>) -> Value {
    let mut provider = json!({"id":"local","name":"Test provider","protocol":protocol,"base_url":base,"model":"model"});
    if let Some(key) = key {
        provider["api_key"] = key;
    }
    let (status, body) = request(
        app,
        "PUT",
        "/api/agent/providers",
        json!({"providers":[provider],"default":"local"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn providers_round_trip_keeps_clears_and_never_returns_keys() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = embedded(dir.path());
    for key in [Some(json!("super-secret-key")), None, Some(Value::Null)] {
        let saved = save(&app, "openai", "https://api.example/v1/", key).await;
        assert_eq!(saved["providers"][0]["has_key"], true);
        assert!(!saved.to_string().contains("super-secret-key"));
        assert!(saved["providers"][0].get("api_key").is_none());
        let stored: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("agent.json")).unwrap()).unwrap();
        assert_eq!(stored["providers"][0]["api_key"], "super-secret-key");
        let (_, listed) = request(&app, "GET", "/api/agent/providers", Value::Null).await;
        assert_eq!(listed, saved);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("agent.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    // Another notebook on this machine sees the same settings, not notebook data.
    let (other, _) = tessera_service::embedded_router_with_paths(
        Notebook::open(dir.path().join("other")).unwrap(),
        dir.path().join("agent.json"),
        None,
    )
    .unwrap();
    assert_eq!(
        request(&other, "GET", "/api/agent/providers", Value::Null)
            .await
            .1["providers"][0]["has_key"],
        true
    );
    let cleared = save(&app, "openai", "https://api.example/v1", Some(json!(""))).await;
    assert_eq!(cleared["providers"][0]["has_key"], false);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("agent.json")).unwrap()).unwrap();
    assert_eq!(stored["providers"][0]["api_key"], "");
    for (key, value) in [
        ("name", ""),
        ("model", ""),
        ("protocol", "unknown"),
        ("base_url", "file:///tmp/key"),
    ] {
        let mut provider = json!({"name":"Valid","model":"model","protocol":"openai","base_url":"https://api.example/v1"});
        provider[key] = json!(value);
        let (status, _) = request(
            &app,
            "PUT",
            "/api/agent/providers",
            json!({"providers":[provider],"default":null}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, saved) = request(&app, "PUT", "/api/agent/providers", json!({"providers":[{"name":"New","protocol":"anthropic","base_url":"https://api.anthropic.com","model":"model"}],"default":null})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(ulid::Ulid::from_string(saved["providers"][0]["id"].as_str().unwrap()).is_ok());
}

#[derive(Clone)]
struct Fake {
    protocol: &'static str,
    requests: Arc<Mutex<Vec<Value>>>,
    cancelled: Arc<AtomicBool>,
    reject: Arc<AtomicBool>,
}

struct Frames {
    chunks: VecDeque<Bytes>,
    pending: bool,
    cancelled: Arc<AtomicBool>,
}

impl Stream for Frames {
    type Item = Result<Bytes, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(chunk) = self.chunks.pop_front() {
            Poll::Ready(Some(Ok(chunk)))
        } else if self.pending {
            Poll::Pending
        } else {
            Poll::Ready(None)
        }
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        if self.pending {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

fn sse(fake: &Fake, events: Vec<Value>, pending: bool) -> Response {
    let mut text = String::from(": heartbeat\r\n\r\n");
    for event in events {
        text.push_str(&format!("event: message\r\ndata: {event}\r\n\r\n"));
    }
    if fake.protocol == "openai" && !pending {
        text.push_str("data: [DONE]\n\n");
    }
    // Cut within UTF-8, JSON tokens and SSE boundaries, not just whole events.
    let chunks = text
        .as_bytes()
        .chunks(7)
        .map(Bytes::copy_from_slice)
        .collect();
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(Frames {
            chunks,
            pending,
            cancelled: fake.cancelled.clone(),
        }))
        .unwrap()
}

fn text_events(protocol: &str, text: &str) -> Vec<Value> {
    if protocol == "openai" {
        vec![json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})]
    } else {
        vec![
            json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
            json!({"type":"content_block_stop","index":0}),
        ]
    }
}

fn end_events(protocol: &str, tools: bool) -> Vec<Value> {
    if protocol == "openai" {
        vec![
            json!({"choices":[{"index":0,"delta":{},"finish_reason":if tools {"tool_calls"} else {"stop"}}]}),
        ]
    } else {
        vec![
            json!({"type":"message_delta","delta":{"stop_reason":if tools {"tool_use"} else {"end_turn"}}}),
            json!({"type":"message_stop"}),
        ]
    }
}

fn call_events(protocol: &str, name: &str, arguments: &str) -> Vec<Value> {
    let split = arguments.len() / 2;
    let (a, b) = arguments.split_at(split);
    if protocol == "openai" {
        vec![
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":name,"arguments":a}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":b}}]}}]}),
        ]
    } else {
        vec![
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":name,"input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":a}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":b}}),
            json!({"type":"content_block_stop","index":1}),
        ]
    }
}

async fn fake_provider(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], "model");
    if fake.protocol == "openai" {
        assert_eq!(headers["authorization"], "Bearer test-key");
    } else {
        assert_eq!(headers["x-api-key"], "test-key");
        assert_eq!(headers["anthropic-version"], "2023-06-01");
    }
    fake.requests.lock().push(body.clone());
    let messages = body["messages"].as_array().unwrap();
    let prompt = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .filter_map(|m| m["content"].as_str())
        .next_back()
        .unwrap();
    if prompt == "fail" || fake.reject.load(Ordering::SeqCst) {
        return Response::builder()
            .status(429)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":"Quota exceeded for test-key"}}).to_string(),
            ))
            .unwrap();
    }
    if prompt == "wait" {
        return sse(&fake, text_events(fake.protocol, "Waiting"), true);
    }
    if body.get("tools").is_none() {
        let mut events = text_events(fake.protocol, "OK");
        events.extend(end_events(fake.protocol, false));
        return sse(&fake, events, false);
    }
    let last = messages.last().unwrap();
    let result = if fake.protocol == "openai" {
        (last["role"] == "tool").then(|| last["content"].as_str().unwrap())
    } else {
        last["content"]
            .as_array()
            .and_then(|c| c.first())
            .filter(|c| c["type"] == "tool_result")
            .map(|c| c["content"].as_str().unwrap())
    };
    let mut events;
    if let Some(result) = result.filter(|_| prompt != "loop") {
        if prompt == "bad tool" {
            assert!(result.contains("Unknown tool"));
            if fake.protocol == "anthropic" {
                assert_eq!(last["content"][0]["is_error"], true);
            }
        } else {
            let receipt: Value = serde_json::from_str(result).unwrap();
            assert!(receipt["summary"].as_str().unwrap().contains("Inbox"));
            assert_eq!(receipt["blocks"].as_array().unwrap().len(), 3);
        }
        events = text_events(fake.protocol, "Saved.");
        events.extend(end_events(fake.protocol, false));
    } else {
        let system = if fake.protocol == "openai" {
            &messages[0]["content"]
        } else {
            &body["system"]
        };
        if prompt == "capture" {
            let system = system.as_str().unwrap();
            assert!(system.contains("# Context <!-- "));
            assert!(system.contains("- Context detail <!-- "));
            assert!(system.contains("[[Title]]"));
            assert!(messages.iter().any(|m| m["content"] == "Earlier question"));
            assert!(
                messages.iter().any(|m| m["content"] == "Earlier answer"
                    || m["content"][0]["text"] == "Earlier answer")
            );
        }
        events = text_events(fake.protocol, "I’ll add it. ");
        if matches!(prompt, "bad tool" | "loop") {
            events.extend(call_events(fake.protocol, "missing_tool", "{}"));
        } else {
            events.extend(call_events(
                fake.protocol,
                "add_note",
                &json!({"target":{"page":"Inbox"},"text":"First note\n  Child note\nSecond note"})
                    .to_string(),
            ));
        }
        events.extend(end_events(fake.protocol, true));
    }
    sse(&fake, events, false)
}

async fn start(app: &Router, prompt: &str, context: Value) -> String {
    let (status, body) = request(app, "POST", "/api/agent/turns", json!({"provider":"local","prompt":prompt,"messages":[{"role":"user","text":"Earlier question"},{"role":"assistant","text":"Earlier answer"}],"context":context})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["turn"].as_str().unwrap().to_owned()
}

async fn collect(app: &Router, turn: &str, after: u64) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut events = Vec::new();
        let mut n = after;
        loop {
            let (status, body) = request(
                app,
                "GET",
                &format!("/api/agent/turns/{turn}/events?after={n}"),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            for event in body["events"].as_array().unwrap() {
                n += 1;
                assert_eq!(event["n"], n);
                events.push(event.clone());
            }
            if body["done"] == true {
                return events;
            }
        }
    })
    .await
    .unwrap()
}

async fn protocol_turn(protocol: &'static str) {
    let dir = tempfile::tempdir().unwrap();
    let (app, handles) = embedded(dir.path());
    let context = handles
        .notebook
        .lock()
        .agent_edit(&AgentRequest {
            actor: Actor::Person,
            reason: None,
            edit: AgentEdit::AddNote {
                target: NoteTarget::Page {
                    title: "Context".into(),
                },
                blocks: vec![NoteBlock {
                    text: "Context detail".into(),
                    heading: None,
                    task: None,
                    children: Vec::new(),
                }],
            },
        })
        .unwrap();
    let fake = Fake {
        protocol,
        requests: Arc::default(),
        cancelled: Arc::default(),
        reject: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let provider_app = Router::new()
        .route(
            if protocol == "openai" {
                "/v1/chat/completions"
            } else {
                "/v1/messages"
            },
            post(fake_provider),
        )
        .with_state(fake.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, provider_app).await.unwrap();
    });
    save(
        &app,
        protocol,
        &if protocol == "openai" {
            format!("{base}/v1")
        } else {
            base
        },
        Some(json!("test-key")),
    )
    .await;
    let (status, tested) =
        request(&app, "POST", "/api/agent/providers/local/test", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tested, json!({"ok":true}));
    fake.reject.store(true, Ordering::SeqCst);
    let (status, rejected) =
        request(&app, "POST", "/api/agent/providers/local/test", Value::Null).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Quota exceeded")
    );
    assert!(!rejected.to_string().contains("test-key"));
    fake.reject.store(false, Ordering::SeqCst);
    let turn = start(
        &app,
        "capture",
        json!([{"page_id":context.page.unwrap().id}]),
    )
    .await;
    let events = collect(&app, &turn, 0).await;
    assert_eq!(
        events
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["text", "edit", "text", "done"]
    );
    assert_eq!(events[0]["delta"], "I’ll add it. ");
    assert_eq!(events[2]["delta"], "Saved.");
    assert_eq!(events.last().unwrap()["stop"], "end");
    {
        let notebook = handles.notebook.lock();
        let page = notebook.page_by_title("Inbox").unwrap().unwrap();
        assert_eq!(events[1]["page"], page.id);
        let page = notebook.page(&page.id).unwrap();
        assert_eq!(
            page.rows
                .iter()
                .map(|r| (r.block.text.as_str(), r.depth))
                .collect::<Vec<_>>(),
            [("First note", 0), ("Child note", 1), ("Second note", 0)]
        );
        let changes = notebook.agent_changes(10).unwrap();
        assert_eq!(
            changes[0].actor,
            Actor::Agent {
                name: "Test provider · model".into()
            }
        );
        assert_eq!(changes[0].reason.as_deref(), Some("capture"));
        assert_eq!(events[1]["seq"], changes[0].seq);
    }
    let (_, finished) = request(
        &app,
        "GET",
        &format!("/api/agent/turns/{turn}/events?after=4"),
        Value::Null,
    )
    .await;
    assert_eq!(finished, json!({"events":[],"done":true}));
    // A tool failure returns to the model, which can still answer normally.
    let bad = start(&app, "bad tool", json!([])).await;
    let bad_events = collect(&app, &bad, 0).await;
    assert_eq!(bad_events.last().unwrap()["stop"], "end");
    assert!(!bad_events.iter().any(|e| e["kind"] == "error"));
    let failed = start(&app, "fail", json!([])).await;
    let errors = collect(&app, &failed, 0).await;
    assert!(errors[0]["message"].as_str().unwrap().contains("HTTP 429"));
    assert!(
        errors[0]["message"]
            .as_str()
            .unwrap()
            .contains("Quota exceeded")
    );
    assert!(!serde_json::to_string(&errors).unwrap().contains("test-key"));
    assert_eq!(errors.last().unwrap()["stop"], "error");
    let before = fake.requests.lock().len();
    let looping = start(&app, "loop", json!([])).await;
    assert_eq!(
        collect(&app, &looping, 0).await.last().unwrap()["stop"],
        "limit"
    );
    assert_eq!(fake.requests.lock().len() - before, 12);
    let waiting = start(&app, "wait", json!([])).await;
    let (_, first) = tokio::time::timeout(
        Duration::from_secs(5),
        request(
            &app,
            "GET",
            &format!("/api/agent/turns/{waiting}/events?after=0"),
            Value::Null,
        ),
    )
    .await
    .unwrap();
    assert_eq!(first["done"], false);
    assert_eq!(first["events"][0]["delta"], "Waiting");
    tokio::time::pause();
    let began = tokio::time::Instant::now();
    let (_, idle) = request(
        &app,
        "GET",
        &format!("/api/agent/turns/{waiting}/events?after=1"),
        Value::Null,
    )
    .await;
    assert_eq!(idle, json!({"events":[],"done":false}));
    // Tokio's timer wheel rounds the deadline up to the next millisecond.
    assert!((Duration::from_secs(25)..=Duration::from_millis(25_001)).contains(&began.elapsed()));
    tokio::time::resume();
    let poll_app = app.clone();
    let poll_turn = waiting.clone();
    let poll = tokio::spawn(async move { collect(&poll_app, &poll_turn, 1).await });
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/agent/turns/{waiting}/cancel"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let events = tokio::time::timeout(Duration::from_secs(3), poll)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["stop"], "cancelled");
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fake.cancelled.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/agent/turns/unknown/events?after=0",
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    server.abort();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(601)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/agent/turns/{waiting}/events?after=0"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn openai_streams_edits_and_cancels() {
    protocol_turn("openai").await;
}

#[tokio::test]
async fn anthropic_streams_edits_and_cancels() {
    protocol_turn("anthropic").await;
}
