use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use serde_json::{Value, json};
use tessera_core::{Notebook, TaskState};
use tower::ServiceExt;

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn app(dir: &std::path::Path) -> Router {
    tessera_service::router(Notebook::open(dir).unwrap(), 4318, None, None).unwrap()
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:4318");
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&body).unwrap())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn get(app: &Router, path: &str) -> Value {
    let (status, body) = request(app, Method::GET, path, None).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}

async fn post(app: &Router, path: &str, body: Value) -> Value {
    let (status, body) = request(app, Method::POST, path, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}

fn batch(operations: Value) -> Value {
    json!({"actor": {"kind": "person"}, "operations": operations})
}

async fn commit(app: &Router, operations: Value) -> Value {
    post(app, "/api/batches", batch(operations)).await
}

fn insert(value: u128, parent: u128, text: &str) -> Value {
    json!({"op": "insert", "id": id(value), "parent_id": id(parent), "after": null,
        "text": text, "heading": null})
}

#[tokio::test]
async fn task_sources_recurrence_and_work_history_survive_reversal_and_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    commit(
        &app,
        json!([
            {"op": "create_page", "id": id(1), "title": "Language study"},
            insert(2, 1, "Translate a passage"),
            insert(3, 2, "Z Hittite exercise"),
            insert(4, 2, "A Hittite note")
        ]),
    )
    .await;
    let mut task = serde_json::to_value(TaskState::default()).unwrap();
    task["scheduled"] = json!("2026-10-03");
    task["scheduled_time"] = json!("09:00");
    task["repeater"] = json!({"every": 1, "unit": "day", "mode": "fixed"});
    let enabled = commit(
        &app,
        json!([
            {"op": "set_project", "id": id(2), "base_revision": 1,
                "project": {"outcome": "Read the passage", "deadline": null, "status": "active"}},
            {"op": "set_task", "id": id(3), "base_revision": 1, "task": task}
        ]),
    )
    .await;
    let capability = get(&app, &format!("/api/blocks/{}/capabilities", id(3))).await;
    assert_eq!(capability["task"], task);
    assert_eq!(capability["merge_protected"], true);
    assert!(
        enabled["capabilities"]
            .as_array()
            .unwrap()
            .contains(&capability)
    );
    let page = get(&app, &format!("/api/pages/{}", id(1))).await;
    assert!(
        page["capabilities"]
            .as_array()
            .unwrap()
            .contains(&capability)
    );
    let changes = get(
        &app,
        &format!(
            "/api/changes?after={}",
            enabled["seq"].as_i64().unwrap() - 1
        ),
    )
    .await;
    assert!(
        changes[0]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&capability)
    );

    // The source limit cannot truncate the task away behind an ordinary note.
    let query = json!({"context_date": "2026-10-03", "limit": 10,
        "source": {"text": "Hittite", "limit": 1, "filters": [],
            "sort": [{"by": "title", "field": null, "direction": "asc"}]},
        "filter": {"selection": "unfinished", "project_id": id(2),
            "scheduled": {"from": "2026-10-03", "through": "2026-10-03"}}});
    let results = post(&app, "/api/tasks/query", query.clone()).await;
    assert_eq!(results["total"], 1);
    assert_eq!(results["rows"][0]["source"]["block"]["id"], id(3));
    assert_eq!(results["rows"][0]["source"]["page"]["id"], id(1));
    assert_eq!(results["rows"][0]["project_id"], id(2));
    let saved = commit(
        &app,
        json!([
            {"op": "save_task_view", "id": id(40), "base_revision": null,
                "name": "Today's language work", "query": query}
        ]),
    )
    .await;
    assert_eq!(saved["task_views"], json!([{"id": id(40), "revision": 1}]));
    let view = get(&app, &format!("/api/task-views/{}", id(40))).await;
    assert_eq!(view["query"]["context_date"], "2026-10-03");
    assert_eq!(
        post(&app, "/api/tasks/query", view["query"].clone()).await,
        results
    );
    assert_eq!(get(&app, "/api/task-views").await, json!([view]));

    let started = commit(
        &app,
        json!([
            {"op": "start_work", "id": id(3), "base_revision": 2,
                "session_id": id(20), "started_at": 1000, "note": "Dictionary"}
        ]),
    )
    .await;
    assert_eq!(started["work_sessions"][0]["started_at"], 1000);
    assert_eq!(
        get(&app, "/api/work-sessions/active").await,
        started["work_sessions"][0]
    );
    let (status, error) = request(
        &app,
        Method::POST,
        "/api/batches",
        Some(batch(json!([
            {"op": "complete_task", "id": id(3), "base_revision": 3,
                "occurrence_id": id(21), "completed_on": "2026-10-03"}
        ]))),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "validation");
    assert_eq!(
        get(&app, &format!("/api/blocks/{}/task-occurrences", id(3))).await,
        json!([])
    );

    let mut completion = batch(json!([
        {"op": "stop_work", "id": id(3), "base_revision": 3,
            "session_id": id(20), "session_revision": 1, "ended_at": 2000, "note": "Translated"},
        {"op": "complete_task", "id": id(3), "base_revision": 4,
            "occurrence_id": id(21), "completed_on": "2026-10-03"}
    ]));
    completion["idempotency_key"] = json!("stop-and-complete");
    let completed = post(&app, "/api/batches", completion.clone()).await;
    let replay = post(&app, "/api/batches", completion).await;
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["seq"], completed["seq"]);
    assert_eq!(completed["work_sessions"][0]["ended_at"], 2000);
    assert_eq!(
        completed["capabilities"][0]["task"]["scheduled"],
        "2026-10-04"
    );
    assert_eq!(get(&app, "/api/work-sessions/active").await, Value::Null);
    let agenda = get(&app, "/api/agenda/2026-10-03").await;
    assert_eq!(agenda["items"].as_array().unwrap().len(), 1);
    assert_eq!(agenda["items"][0]["source"]["block"]["id"], id(3));
    assert_eq!(agenda["items"][0]["task"]["scheduled"], "2026-10-03");
    assert_eq!(agenda["items"][0]["task"]["status"], "done");
    assert_eq!(agenda["items"][0]["time"], "09:00");

    // Completing the project does not change its recurring action.
    commit(
        &app,
        json!([
            {"op": "set_project", "id": id(2), "base_revision": 2,
                "project": {"outcome": "Read the passage", "deadline": null, "status": "done"}}
        ]),
    )
    .await;
    assert_eq!(
        get(&app, "/api/projects").await[0]["state"]["status"],
        "done"
    );
    assert_eq!(
        get(&app, &format!("/api/blocks/{}/capabilities", id(3))).await["task"]["status"],
        "todo"
    );
    commit(&app, json!([
        {"op": "reverse_task_completion", "id": id(3), "base_revision": 5, "occurrence_id": id(21)},
        {"op": "set_task", "id": id(3), "base_revision": 6, "task": null},
        {"op": "delete", "id": id(3), "base_revision": 7}
    ])).await;
    let history = get(&app, &format!("/api/blocks/{}/task-occurrences", id(3))).await;
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["reversed"], true);
    assert_eq!(history[0]["snapshot"], task);
    let work = get(&app, &format!("/api/blocks/{}/work-sessions", id(3))).await;
    assert_eq!(work.as_array().unwrap().len(), 1);
    assert_eq!(work[0]["started_at"], 1000);
    assert_eq!(work[0]["ended_at"], 2000);
    assert_eq!(work[0]["note"], "Translated");
    assert_eq!(
        get(&app, &format!("/api/blocks/{}/capabilities", id(3))).await["merge_protected"],
        true
    );
    assert_eq!(post(&app, "/api/tasks/query", query).await["total"], 0);
}

#[tokio::test]
async fn card_queue_uses_server_time_and_keeps_review_evidence_after_source_and_deck_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    commit(
        &app,
        json!([
            {"op": "create_page", "id": id(1), "title": "Hittite"},
            insert(2, 1, "water >> wātar")
        ]),
    )
    .await;
    let units = get(&app, &format!("/api/blocks/{}/cards", id(2))).await;
    let card = &units[0];
    let card_id = card["id"].as_str().unwrap();
    let card_path = format!("/api/cards/{card_id}");
    let reviews_path = format!("{card_path}/reviews");
    let queue = post(&app, "/api/cards/query", json!({"selection": "due"})).await;
    assert_eq!(queue["total"], 1);
    assert_eq!(queue["rows"][0]["card"], *card);
    assert_eq!(queue["rows"][0]["source"]["block"]["id"], id(2));
    assert_eq!(queue["rows"][0]["source"]["page"]["id"], id(1));
    let saved = commit(
        &app,
        json!([
            {"op": "save_deck", "id": id(10), "base_revision": null, "name": "Vocabulary",
                "query": {"selection": "all", "source": {"text": "water", "filters": [], "sort": []}}},
            {"op": "start_review_session", "id": id(11), "deck_id": id(10), "started_at": 1000}
        ]),
    )
    .await;
    assert_eq!(saved["decks"], json!([{"id": id(10), "revision": 1}]));
    let deck = get(&app, &format!("/api/decks/{}", id(10))).await;
    assert_eq!(get(&app, "/api/decks").await, json!([deck]));
    assert_eq!(
        post(&app, "/api/cards/query", deck["query"].clone()).await["rows"][0]["card"],
        *card
    );
    let mut grading = batch(json!([
        {"op": "grade_card", "id": card_id, "base_revision": card["revision"],
            "definition_revision": card["definition_revision"], "event_id": id(12),
            "session_id": id(11), "grade": "good", "reset": false,
            "shown_front": card["front"], "shown_back": card["back"], "reviewed_at": 4_000_000_000_000_i64}
    ]));
    grading["idempotency_key"] = json!("grade-vocabulary");
    let graded = post(&app, "/api/batches", grading.clone()).await;
    assert_eq!(
        post(&app, "/api/batches", grading).await["seq"],
        graded["seq"]
    );
    assert_eq!(graded["cards"][0]["id"], card_id);
    assert_eq!(graded["capabilities"][0]["reviewed_cards"], true);
    assert_eq!(graded["revisions"], json!([]));
    // An authored future review time must not become the query's clock.
    assert_eq!(
        post(&app, "/api/cards/query", json!({"selection": "due"})).await["total"],
        0
    );
    assert_eq!(
        post(&app, "/api/cards/query", json!({"selection": "new"})).await["total"],
        0
    );
    assert_eq!(
        post(&app, "/api/cards/query", json!({"selection": "all"})).await["total"],
        1
    );
    let reviewed = get(&app, &card_path).await;
    assert_eq!(
        reviewed["schedule"]["last_reviewed_at"],
        4_000_000_000_000_i64
    );
    let previews = get(&app, &format!("{card_path}/previews")).await;
    assert_eq!(
        previews["current"][2],
        json!({"grade": "good", "interval_days": 6})
    );
    assert_eq!(
        previews["reset"][2],
        json!({"grade": "good", "interval_days": 1})
    );
    let original_history = get(&app, &reviews_path).await;
    assert_eq!(original_history.as_array().unwrap().len(), 1);
    assert_eq!(original_history[0]["shown_back"], "wātar");
    assert_eq!(original_history[0]["created_at"], 4_000_000_000_000_i64);
    let page = get(&app, &format!("/api/pages/{}", id(1))).await;
    assert_eq!(page["capabilities"][0]["reviewed_cards"], true);
    let changes = get(
        &app,
        &format!("/api/changes?after={}", graded["seq"].as_i64().unwrap() - 1),
    )
    .await;
    assert_eq!(changes[0]["cards"], json!([card_id]));
    assert_eq!(changes[0]["capabilities"][0]["reviewed_cards"], true);

    commit(
        &app,
        json!([
            {"op": "edit_text", "id": id(2), "base_revision": 1, "text": "water >> wātar (neuter)"}
        ]),
    )
    .await;
    let current = get(&app, &card_path).await;
    assert_eq!(current["schedule"], reviewed["schedule"]);
    let stale_grade = json!({"op": "grade_card", "id": card_id,
        "base_revision": reviewed["revision"], "definition_revision": reviewed["definition_revision"],
        "event_id": id(13), "session_id": id(11), "grade": "good", "reset": true,
        "shown_front": reviewed["front"], "shown_back": reviewed["back"],
        "reviewed_at": 4_000_000_001_000_i64});
    let (status, error) = request(
        &app,
        Method::POST,
        "/api/batches",
        Some(batch(json!([
            {"op": "delete_deck", "id": id(10), "base_revision": 1}, stale_grade
        ]))),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        error["error"]["details"],
        json!({"op_index": 1, "id": card_id,
        "expected": reviewed["revision"], "found": current["revision"]})
    );
    assert_eq!(get(&app, &format!("/api/decks/{}", id(10))).await, deck);
    assert_eq!(get(&app, &reviews_path).await, original_history);
    let mut grade = stale_grade;
    grade["base_revision"] = current["revision"].clone();
    grade["definition_revision"] = current["definition_revision"].clone();
    let (status, error) = request(
        &app,
        Method::POST,
        "/api/batches",
        Some(batch(json!([grade]))),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "validation");
    grade["shown_back"] = current["back"].clone();
    commit(&app, json!([grade])).await;
    let history = get(&app, &reviews_path).await;
    assert_eq!(history.as_array().unwrap().len(), 3);
    assert_eq!(history[1]["kind"], "reset");
    assert_eq!(history[2]["kind"], "grade");
    assert_eq!(history[2]["shown_back"], "wātar (neuter)");
    commit(
        &app,
        json!([
            {"op": "finish_review_session", "id": id(11), "base_revision": 1,
                "state": "abandoned", "ended_at": 4_000_000_002_000_i64},
            {"op": "delete_deck", "id": id(10), "base_revision": 1},
            {"op": "edit_text", "id": id(2), "base_revision": 2, "text": "A retained source note"},
            {"op": "delete", "id": id(2), "base_revision": 3}
        ]),
    )
    .await;
    assert_eq!(get(&app, "/api/decks").await, json!([]));
    let session = get(&app, &format!("/api/review-sessions/{}", id(11))).await;
    assert_eq!(session["state"], "abandoned");
    assert_eq!(session["deck_id"], id(10));
    assert_eq!(get(&app, "/api/review-sessions").await, json!([session]));
    assert_eq!(get(&app, &reviews_path).await, history);
    assert_eq!(get(&app, &card_path).await["active"], false);
    assert_eq!(
        get(&app, &format!("/api/blocks/{}/cards", id(2))).await[0]["id"],
        card_id
    );
    assert_eq!(
        post(&app, "/api/cards/query", json!({"selection": "all"})).await["total"],
        0
    );
}

#[tokio::test]
async fn capability_query_validation_and_saved_view_conflicts_do_not_mutate_state() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    for (path, body) in [
        ("/api/tasks/query", json!({"context_date": "2026-02-30"})),
        (
            "/api/tasks/query",
            json!({"context_date": "2026-10-03", "filter": {"recent_days": 0}}),
        ),
        (
            "/api/tasks/query",
            json!({"context_date": "2026-10-03", "filter": {
            "scheduled": {"from": "2026-10-04", "through": "2026-10-03"}}}),
        ),
        (
            "/api/tasks/query",
            json!({"context_date": "2026-10-03", "limit": 2001}),
        ),
        ("/api/cards/query", json!({"limit": 2001})),
        (
            "/api/cards/query",
            json!({"source": {"type": "invalid", "filters": [], "sort": []}}),
        ),
    ] {
        let (status, error) = request(&app, Method::POST, path, Some(body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {error}");
        assert_eq!(error["error"]["code"], "validation");
    }
    let (status, error) = request(
        &app,
        Method::POST,
        "/api/cards/query",
        Some(json!({"selection": "unknown"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["error"]["code"], "invalid_json");
    for path in [
        "/api/agenda/2026-02-30",
        "/api/blocks/not-an-id/capabilities",
    ] {
        let (status, error) = request(&app, Method::GET, path, None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"]["code"], "validation");
    }
    for path in [
        format!("/api/cards/{}", id(99)),
        format!("/api/decks/{}", id(99)),
        format!("/api/task-views/{}", id(99)),
        format!("/api/review-sessions/{}", id(99)),
    ] {
        let (status, error) = request(&app, Method::GET, &path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error["error"]["code"], "not_found");
    }
    assert_eq!(get(&app, "/api/changes").await, json!([]));
    let query = json!({"context_date": "2026-10-03", "filter": {"selection": "all"}});
    commit(&app, json!([
        {"op": "save_task_view", "id": id(10), "base_revision": null, "name": "Work", "query": query}
    ])).await;
    commit(&app, json!([
        {"op": "save_task_view", "id": id(10), "base_revision": 1, "name": "Current work", "query": query}
    ])).await;
    let (status, error) = request(&app, Method::POST, "/api/batches", Some(batch(json!([
        {"op": "save_task_view", "id": id(11), "base_revision": null, "name": "Must roll back", "query": query},
        {"op": "delete_task_view", "id": id(10), "base_revision": 1}
    ])))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        error["error"]["details"],
        json!({"op_index": 1, "id": id(10), "expected": 1, "found": 2})
    );
    let views = get(&app, "/api/task-views").await;
    assert_eq!(views.as_array().unwrap().len(), 1);
    assert_eq!(views[0]["revision"], 2);
    assert_eq!(views[0]["name"], "Current work");
    commit(
        &app,
        json!([{"op": "delete_task_view", "id": id(10), "base_revision": 2}]),
    )
    .await;
    assert_eq!(get(&app, "/api/task-views").await, json!([]));
}

#[tokio::test]
async fn capability_reads_share_host_origin_and_method_protection() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    for (host, origin) in [
        ("evil.example:4318", "http://127.0.0.1:4318"),
        ("127.0.0.1:4318", "https://evil.example"),
    ] {
        for (method, path, body) in [
            (Method::GET, "/api/review-sessions", Body::empty()),
            (Method::POST, "/api/cards/query", Body::from("{}")),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("host", host)
                        .header("origin", origin)
                        .header("content-type", "application/json")
                        .body(body)
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
    let (status, error) = request(&app, Method::POST, "/api/decks", Some(json!({}))).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(error["error"]["code"], "method_not_allowed");
    assert_eq!(get(&app, "/api/changes").await, json!([]));
}
