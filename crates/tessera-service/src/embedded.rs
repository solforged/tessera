use std::path::PathBuf;
use std::sync::Arc;

use axum::{Router, extract::DefaultBodyLimit, middleware};
use parking_lot::Mutex;
use tessera_core::Workshop;
use tokio::sync::broadcast;

use crate::agent;
use crate::daily_backup;
use crate::error::ApiError;
use crate::pairing;
use crate::replica;
use crate::router::{same_workshop, workshop_routes};
use crate::state::{AppState, hub_objects};
use crate::{backups, library};
use tessera_api::images;

pub struct EmbeddedHandles {
    pub workshop: Arc<Mutex<Workshop>>,
    pub changes: broadcast::Sender<i64>,
    pub replica: Arc<replica::ReplicaRuntime>,
    _daily_backup: Option<daily_backup::Task>,
}

/// Build the workshop and library API for a host that runs the workshop in its own process,
/// such as the browser worker or the Android app. It has no socket, so it omits the host and
/// origin policy, static assets, service details and the WebSocket change stream;
/// hosts deliver changes from [`EmbeddedHandles`]. Backups require an explicit store.
/// The browser worker ingests queued uploads before this returns.
pub fn embedded_router(workshop: Workshop) -> Result<(Router, EmbeddedHandles), String> {
    embedded_router_inner(workshop, None, None)
}

/// Build a native embedded router with explicit provider settings and backup storage.
pub fn embedded_router_with_paths(
    workshop: Workshop,
    agent_path: PathBuf,
    backup_store: Option<PathBuf>,
) -> Result<(Router, EmbeddedHandles), String> {
    embedded_router_inner(workshop, Some(agent_path), backup_store)
}

fn embedded_router_inner(
    workshop: Workshop,
    agent_path: Option<PathBuf>,
    backup_store: Option<PathBuf>,
) -> Result<(Router, EmbeddedHandles), String> {
    let workshop = Arc::new(Mutex::new(workshop));
    let changes = broadcast::channel(256).0;
    let library = library::Library::start(workshop.clone(), changes.clone(), library::extract)?;
    let replica = Arc::default();
    let state = AppState {
        readers: None,
        workshop,
        assets: None,
        changes,
        library,
        objects: hub_objects(),
        port: 0,
        backup: Arc::new(tokio::sync::Mutex::new(None)),
        backup_store,
        sync_port: 0,
        pairing: Arc::new(Mutex::new(pairing::Pairing::default())),
        sharing: Arc::new(tokio::sync::Mutex::new(())),
        replica,
        sync_health: Arc::default(),
        switcher: None,
        agent: Arc::new(agent::Runtime::new(agent_path)?),
    };
    let handles = EmbeddedHandles {
        workshop: state.workshop.clone(),
        changes: state.changes.clone(),
        replica: state.replica.clone(),
        _daily_backup: daily_backup::start(&state),
    };
    let router = workshop_routes()
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(library::routes())
        .merge(images::routes());
    // A first pairing swaps the workshop in place; a window bound to the old one reloads on the 409.
    let router = router
        .merge(agent::routes())
        .merge(backups::backup_routes())
        .layer(middleware::from_fn_with_state(state.clone(), same_workshop));
    let router = router.with_state(state);
    Ok((router, handles))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tessera_core::{Actor, Batch, Workshop};
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    #[tokio::test]
    async fn the_embedded_router_refuses_a_window_bound_to_another_workshop() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::open(dir.path()).unwrap();
        let id = workshop.info().unwrap().id;
        let (app, _handles) = embedded_router(workshop).unwrap();
        let get = |workshop: Option<&str>| {
            let mut request = Request::get("/api/roots");
            if let Some(workshop) = workshop {
                request = request.header("X-Tessera-Notebook", workshop);
            }
            app.clone().oneshot(request.body(Body::empty()).unwrap())
        };
        assert_eq!(get(None).await.unwrap().status(), StatusCode::OK);
        assert_eq!(get(Some(&id)).await.unwrap().status(), StatusCode::OK);
        let stale = get(Some("01ARZ3NDEKTSV4RRFFQ69G5FAV")).await.unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(stale.into_body(), usize::MAX).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error["error"]["code"], "notebook_changed");
    }

    #[tokio::test]
    async fn embedded_page_reference_reads_include_children_counts_and_mentions() {
        use tessera_core::Operation;
        let dir = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(dir.path()).unwrap();
        let page = "00000000000000000000000001";
        let child = "00000000000000000000000002";
        let other = "00000000000000000000000003";
        let source = "00000000000000000000000004";
        let mention = "00000000000000000000000005";
        workshop
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![
                    Operation::CreatePage {
                        id: page.into(),
                        title: "Rome".into(),
                    },
                    Operation::CreatePage {
                        id: other.into(),
                        title: "Other".into(),
                    },
                    Operation::Insert {
                        id: child.into(),
                        parent_id: page.into(),
                        after: None,
                        text: "child".into(),
                        heading: None,
                    },
                    Operation::Insert {
                        id: source.into(),
                        parent_id: other.into(),
                        after: None,
                        text: format!("[[{child}]]"),
                        heading: None,
                    },
                    Operation::Insert {
                        id: mention.into(),
                        parent_id: other.into(),
                        after: None,
                        text: "Visit Rome".into(),
                        heading: None,
                    },
                ],
            })
            .unwrap();
        let (app, _handles) = embedded_router(workshop).unwrap();
        for (route, expected) in [
            ("references?limit=1", serde_json::json!({"total": 1})),
            (
                "reference-counts",
                serde_json::json!([{"block_id": child, "count": 1}]),
            ),
            (
                "unlinked-mentions?limit=0",
                serde_json::json!({"total": 1, "rows": []}),
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("/api/pages/{page}/{route}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if route.starts_with("references") {
                assert_eq!(result["total"], expected["total"]);
                assert_eq!(result["groups"][0]["page"]["id"], other);
                assert_eq!(result["groups"][0]["sources"][0]["source"]["id"], source);
                assert_eq!(
                    result["groups"][0]["sources"][0]["targets"],
                    serde_json::json!([child])
                );
            } else {
                assert_eq!(result, expected);
            }
        }
    }

    #[tokio::test]
    async fn change_head_reads_the_local_editor_journal() {
        let dir = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(dir.path()).unwrap();
        workshop
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![tessera_core::Operation::CreatePage {
                    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                    title: "Cursor test".into(),
                }],
            })
            .unwrap();
        let expected = workshop.editor_cursor().unwrap();
        let (app, handles) = embedded_router(workshop).unwrap();
        for head in [expected, 900, 0] {
            if head == 900 {
                // Deliberately diverge from changes.seq without building event payloads.
                let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE))
                    .unwrap();
                conn.execute(
                    "UPDATE editor_events SET seq = 900 WHERE seq = (SELECT MAX(seq) FROM editor_events)",
                    [],
                )
                .unwrap();
            }
            if head == 0 {
                let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE))
                    .unwrap();
                conn.execute("DELETE FROM editor_events", []).unwrap();
            }
            let response = app
                .clone()
                .oneshot(
                    Request::get("/api/changes/head")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(serde_json::from_slice::<i64>(&bytes).unwrap(), head);
            assert_eq!(handles.workshop.lock().editor_cursor().unwrap(), head);
        }
    }

    #[tokio::test]
    async fn alias_routes_keep_json_shapes_and_publish_only_committed_changes() {
        async fn request(
            app: &Router,
            method: &str,
            path: &str,
            body: Option<serde_json::Value>,
        ) -> serde_json::Value {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{method} {path}");
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice(&bytes).unwrap()
        }

        let dir = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(dir.path()).unwrap();
        let page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let kind = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
        let lab = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
        workshop
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![
                    tessera_core::Operation::CreatePage {
                        id: lab.into(),
                        title: "Lab #project".into(),
                    },
                    tessera_core::Operation::CreatePage {
                        id: page.into(),
                        title: "Cicero".into(),
                    },
                    tessera_core::Operation::CreatePage {
                        id: kind.into(),
                        title: "Person".into(),
                    },
                    tessera_core::Operation::AddType {
                        id: page.into(),
                        base_revision: 1,
                        title: "Person".into(),
                    },
                ],
            })
            .unwrap();
        let (app, handles) = embedded_router(workshop).unwrap();
        let mut notifications = handles.changes.subscribe();
        let aliases = format!("/api/pages/{page}/aliases");
        let committed = request(
            &app,
            "POST",
            &aliases,
            Some(serde_json::json!({"name": "Tully"})),
        )
        .await;
        let seq = committed["seq"].as_i64().unwrap();
        assert_eq!(notifications.try_recv().unwrap(), seq);
        let event = handles
            .workshop
            .lock()
            .changes_since(seq - 1, 1)
            .unwrap()
            .remove(0);
        assert_eq!(event.actor, Actor::Person);
        assert!(event.restructured_pages.iter().any(|id| id == page));
        assert!(
            request(
                &app,
                "POST",
                &aliases,
                Some(serde_json::json!({"name": "TÚLLY"}))
            )
            .await
            .is_null()
        );
        assert!(matches!(
            notifications.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        for path in [
            "/api/pages/by-title/Lab",
            "/api/pages/by-title/lab%20%23project",
        ] {
            let found = request(&app, "GET", path, None).await;
            assert_eq!(found["id"], lab);
            assert!(found["text"].as_str().unwrap().starts_with("Lab #[["));
        }
        assert_eq!(
            request(&app, "GET", "/api/names/lab", None).await[0]["page"]["id"],
            lab
        );
        assert_eq!(
            request(&app, "GET", "/api/complete?q=La&limit=1", None).await[0]["id"],
            lab
        );

        let matches = request(&app, "GET", "/api/names/tully", None).await;
        assert_eq!(matches[0]["page"]["id"], page);
        assert_eq!(matches[0]["alias"], "Tully");
        assert_eq!(
            request(&app, "GET", "/api/names/Cicero", None).await[0]["alias"],
            serde_json::Value::Null
        );
        let completion = request(&app, "GET", "/api/complete?q=tul&limit=1", None).await;
        assert_eq!(completion[0]["id"], page);
        assert_eq!(completion[0]["alias"], "Tully");
        assert!(completion[0].get("block").is_none());
        assert!(
            request(&app, "GET", "/api/complete?q=Cic&limit=1", None).await[0]["alias"].is_null()
        );
        let index = request(&app, "GET", "/api/index/person", None).await;
        assert_eq!(index["notes"][0]["id"], page);
        assert!(index["notes"][0]["sort_as"].is_null());
        assert_eq!(index["see"][0]["alias"], "Tully");
        assert_eq!(
            index["see"][0]["targets"],
            serde_json::json!([{"id": page, "title": "Cicero"}])
        );
        let template = format!("/api/types/{kind}/starting-template");
        let committed = request(&app, "POST", &template, None).await;
        let seq = committed["seq"].as_i64().unwrap();
        assert_eq!(notifications.try_recv().unwrap(), seq);
        let event = handles
            .workshop
            .lock()
            .changes_since(seq - 1, 1)
            .unwrap()
            .remove(0);
        assert_eq!(event.actor, Actor::Person);
        assert_eq!(
            handles
                .workshop
                .lock()
                .type_info(kind)
                .unwrap()
                .fields
                .len(),
            3
        );
        assert!(request(&app, "POST", &template, None).await.is_null());
        assert!(matches!(
            notifications.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn by_title_route_finds_a_page_as_a_link_does() {
        async fn get(app: &Router, title: &str) -> (StatusCode, serde_json::Value) {
            let uri = format!(
                "/api/pages/by-title/{}",
                percent_encoding::utf8_percent_encode(title, percent_encoding::NON_ALPHANUMERIC)
            );
            let response = app
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }

        let dir = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(dir.path()).unwrap();
        let spaced = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let hyphened = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
        let cicero = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
        workshop
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: [
                    (spaced, "Fold repro target"),
                    (hyphened, "Fold-repro target"),
                    (cicero, "Cicero"),
                ]
                .into_iter()
                .map(|(id, title)| tessera_core::Operation::CreatePage {
                    id: id.into(),
                    title: title.into(),
                })
                .collect(),
            })
            .unwrap();
        workshop.add_alias(cicero, "Tully", Actor::Person).unwrap();
        let (app, _) = embedded_router(workshop).unwrap();

        // The exact title wins, so titles that differ only in punctuation
        // each reach their own page; another spelling or an alias reaches
        // the one page it matches.
        for (title, id) in [
            ("fold repro target", spaced),
            ("Fold repro target #project", spaced),
            ("Fold-repro target", hyphened),
            ("Cicéro", cicero),
            ("tully", cicero),
        ] {
            let (status, page) = get(&app, title).await;
            assert_eq!(status, StatusCode::OK, "{title}: {page}");
            assert_eq!(page["id"], id, "{title}");
        }
        let (status, error) = get(&app, "fold.repro target").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
        let message = error["error"]["message"].as_str().unwrap();
        assert!(
            message.contains(&format!("Fold repro target ({spaced})"))
                && message.contains(&format!("Fold-repro target ({hyphened})")),
            "{message}"
        );
        let (status, _) = get(&app, "Marcus").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
