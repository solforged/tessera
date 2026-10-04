use std::time::Duration;

use futures_util::StreamExt;
use tessera_core::{Actor, Batch, Block, BlockInPage, ChangeEvent, Committed, Notebook, Operation};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error, client::IntoClientRequest},
};

const PAGE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BLOCK: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: Some("stream regression".into()),
        idempotency_key: None,
        operations,
    }
}
fn edit(revision: i64, text: &str) -> Batch {
    batch(vec![Operation::EditText {
        id: BLOCK.into(),
        base_revision: revision,
        text: text.into(),
    }])
}
async fn server(nb: Notebook) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = tessera_service::router(nb, port, None, None).unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("127.0.0.1:{port}"), task)
}
async fn commit(client: &reqwest::Client, host: &str, batch: &Batch) -> Committed {
    client
        .post(format!("http://{host}/api/batches"))
        .json(batch)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn catch_up_then_live_has_no_gap_or_duplicate_when_commit_races_subscription() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        Operation::CreatePage {
            id: PAGE.into(),
            title: "Stream".into(),
        },
        Operation::Insert {
            id: BLOCK.into(),
            parent_id: PAGE.into(),
            after: None,
            text: "seed".into(),
            heading: None,
        },
    ]))
    .unwrap();
    // Cross the catch-up query's 100-event page boundary.
    for revision in 1..=120 {
        nb.apply(&edit(revision, &format!("history {revision}")))
            .unwrap();
    }
    let (host, task) = server(nb).await;
    let client = reqwest::Client::new();
    let mut racing = edit(121, "racing commit");
    racing.idempotency_key = Some("race".into());
    let mut request = format!("ws://{host}/api/changes/stream?after=1")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", format!("http://{host}").parse().unwrap());
    let (connected, raced) = tokio::join!(connect_async(request), commit(&client, &host, &racing));
    assert_eq!(raced.seq, 122);
    let (mut socket, _) = connected.unwrap();
    for expected in 2..=122 {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(event.seq, expected);
        assert_eq!(event.actor, Actor::Person);
        assert_eq!(event.blocks[0].id, BLOCK);
        assert!(event.removed.is_empty());
        assert!(event.restructured_pages.is_empty());
    }
    let replay = commit(&client, &host, &racing).await;
    assert!(replay.replayed);
    assert_eq!(replay.seq, 122);
    let live = commit(&client, &host, &edit(122, "live commit")).await;
    assert_eq!(live.seq, 123);
    // A queued duplicate from catch-up/subscription or the replay would be
    // observed here instead of the live event.
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event.seq, 123);
    assert_eq!(event.blocks[0].text, "live commit");
    assert_eq!(event.blocks[0].revision, 123);
    socket.close(None).await.unwrap();
    task.abort();
}

#[tokio::test]
async fn websocket_upgrade_rejects_foreign_origins_and_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let (host, task) = server(Notebook::open(dir.path()).unwrap()).await;
    for (header, value) in [
        ("origin", "https://evil.example"),
        ("host", "evil.example:4318"),
    ] {
        let mut request = format!("ws://{host}/api/changes/stream")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(header, value.parse().unwrap());
        let error = connect_async(request).await.unwrap_err();
        match error {
            Error::Http(response) => assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN),
            other => panic!("expected HTTP origin rejection, got {other}"),
        }
    }
    task.abort();
}

#[tokio::test]
async fn title_and_members_routes_expose_generated_types_with_expected_json_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let (host, task) = server(Notebook::open(dir.path()).unwrap()).await;
    let client = reqwest::Client::new();
    let committed = commit(
        &client,
        &host,
        &batch(vec![
            Operation::CreatePage {
                id: PAGE.into(),
                title: "Notes".into(),
            },
            Operation::Insert {
                id: BLOCK.into(),
                parent_id: PAGE.into(),
                after: None,
                text: "#[[a b]]".into(),
                heading: None,
            },
        ]),
    )
    .await;
    let page: Block = client
        .get(format!("http://{host}/api/pages/by-title/A%20B"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        committed
            .revisions
            .iter()
            .any(|revision| revision.id == page.id)
    );
    let members: Vec<BlockInPage> = client
        .get(format!(
            "http://{host}/api/types/{}/members?limit=1",
            page.id
        ))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(members[0].block.id, BLOCK);
    assert_eq!(members[0].page.id, PAGE);
    let missing = client
        .get(format!("http://{host}/api/pages/by-title/absent"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    let events: Vec<ChangeEvent> = client
        .get(format!("http://{host}/api/changes?after=0"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(events[0].blocks.len(), 3);
    assert!(events[0].blocks.iter().any(|block| block.id == page.id));
    task.abort();
}

#[tokio::test]
async fn rename_receipt_and_live_event_preserve_tag_identity_through_edit_and_inverse() {
    let dir = tempfile::tempdir().unwrap();
    let (host, task) = server(Notebook::open(dir.path()).unwrap()).await;
    let client = reqwest::Client::new();
    let seeded = commit(
        &client,
        &host,
        &batch(vec![
            Operation::CreatePage {
                id: PAGE.into(),
                title: "Notes".into(),
            },
            Operation::Insert {
                id: BLOCK.into(),
                parent_id: PAGE.into(),
                after: None,
                text: "Focus #auditfocus".into(),
                heading: None,
            },
        ]),
    )
    .await;
    let tag: Block = client
        .get(format!("http://{host}/api/pages/by-title/auditfocus"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!(
        "ws://{host}/api/changes/stream?after={}",
        seeded.seq
    ))
    .await
    .unwrap();
    let renamed = commit(
        &client,
        &host,
        &batch(vec![Operation::EditText {
            id: tag.id.clone(),
            base_revision: 1,
            text: "Audit work".into(),
        }]),
    )
    .await;
    assert_eq!(renamed.text_rewrites[0].id, BLOCK);
    assert_eq!(renamed.text_rewrites[0].before, "Focus #auditfocus");
    assert_eq!(renamed.text_rewrites[0].after, "Focus #[[Audit work]]");
    assert_eq!(renamed.text_rewrites[0].revision, 2);
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event.seq, renamed.seq);
    assert_eq!(
        event
            .blocks
            .iter()
            .map(|block| block.id.as_str())
            .collect::<Vec<_>>(),
        vec![tag.id.as_str(), BLOCK]
    );
    assert_eq!(event.blocks[1].text, "Focus #[[Audit work]]");
    let restored = commit(
        &client,
        &host,
        &batch(vec![
            Operation::EditText {
                id: tag.id.clone(),
                base_revision: 2,
                text: "auditfocus".into(),
            },
            Operation::EditText {
                id: BLOCK.into(),
                base_revision: renamed.text_rewrites[0].revision,
                text: renamed.text_rewrites[0].before.clone(),
            },
        ]),
    )
    .await;
    assert_eq!(restored.seq, renamed.seq + 1);
    let source: Block = client
        .get(format!("http://{host}/api/blocks/{BLOCK}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(source.text, "Focus #auditfocus");
    let rerename = commit(
        &client,
        &host,
        &batch(vec![Operation::EditText {
            id: tag.id.clone(),
            base_revision: 3,
            text: "Audit work".into(),
        }]),
    )
    .await;
    commit(
        &client,
        &host,
        &edit(rerename.text_rewrites[0].revision, "Focus #[[Audit work]]."),
    )
    .await;
    let members: Vec<BlockInPage> = client
        .get(format!("http://{host}/api/types/{}/members", tag.id))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(members[0].block.id, BLOCK);
    assert_eq!(members[0].block.text, "Focus #[[Audit work]].");
    let old = client
        .get(format!("http://{host}/api/pages/by-title/auditfocus"))
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), reqwest::StatusCode::NOT_FOUND);
    socket.close(None).await.unwrap();
    task.abort();
}

#[tokio::test]
async fn capability_catch_up_and_live_review_protection_do_not_require_text_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let seeded = nb
        .apply(&batch(vec![
            Operation::CreatePage {
                id: PAGE.into(),
                title: "Vocabulary practice".into(),
            },
            Operation::Insert {
                id: BLOCK.into(),
                parent_id: PAGE.into(),
                after: None,
                text: "water >> wātar".into(),
                heading: None,
            },
        ]))
        .unwrap();
    let card = nb.source_cards(BLOCK).unwrap().remove(0);
    let enabled = nb
        .apply(&batch(vec![Operation::SetTask {
            id: BLOCK.into(),
            base_revision: 1,
            task: Some(tessera_core::TaskState::default()),
        }]))
        .unwrap();
    let (host, task) = server(nb).await;
    let client = reqwest::Client::new();
    let (mut socket, _) = connect_async(format!(
        "ws://{host}/api/changes/stream?after={}",
        seeded.seq
    ))
    .await
    .unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let caught_up: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(caught_up.seq, enabled.seq);
    assert_eq!(caught_up.capabilities, enabled.capabilities);
    assert!(caught_up.capabilities[0].task.is_some());

    let reviewed = commit(
        &client,
        &host,
        &batch(vec![Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: ulid::Ulid::generate().to_string(),
            session_id: None,
            grade: tessera_core::scheduler::Grade::Good,
            reset: false,
            shown_front: card.front,
            shown_back: card.back,
            reviewed_at: 1000,
        }]),
    )
    .await;
    assert!(reviewed.revisions.is_empty());
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let live: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(live.seq, reviewed.seq);
    assert_eq!(live.cards, vec![card.id]);
    assert_eq!(live.capabilities, reviewed.capabilities);
    assert!(live.capabilities[0].reviewed_cards);
    assert!(live.capabilities[0].merge_protected);
    assert!(live.blocks.is_empty());

    let removed = commit(
        &client,
        &host,
        &batch(vec![Operation::SetTask {
            id: BLOCK.into(),
            base_revision: 2,
            task: None,
        }]),
    )
    .await;
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let live: ChangeEvent = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(live.seq, removed.seq);
    assert_eq!(live.capabilities, removed.capabilities);
    assert!(live.capabilities[0].task.is_none());
    assert!(live.capabilities[0].reviewed_cards);
    assert!(live.capabilities[0].merge_protected);
    socket.close(None).await.unwrap();
    task.abort();
}
