use tessera_core::{Actor, Batch, Error, Notebook, Operation, library::*};

fn id() -> String {
    ulid::Ulid::generate().to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn source(n: &mut Notebook, title: &str, state: ReadingState) -> String {
    let id = id();
    n.apply(&batch(vec![
        Operation::CreatePage {
            id: id.clone(),
            title: title.into(),
        },
        Operation::SetSource {
            id: id.clone(),
            base_revision: 1,
            source: Some(SourceState {
                format: SourceFormat::Epub,
                state,
                origin: None,
                match_key: None,
                citation_key: Some(format!("source{id}")),
            }),
        },
    ]))
    .unwrap();
    id
}

#[test]
fn saved_library_views_validate_revisions_replay_and_survive_reload() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let view_id = id();
    let query = LibraryQuery {
        text: Some("Reading".into()),
        states: vec![ReadingState::Reading],
        ..Default::default()
    };
    let mut save = batch(vec![Operation::SaveLibraryView {
        id: view_id.clone(),
        base_revision: None,
        name: " Reading list ".into(),
        query: query.clone(),
    }]);
    save.idempotency_key = Some(id());
    let committed = n.apply(&save).unwrap();
    assert_eq!(committed.library_views[0].revision, 1);
    assert_eq!(n.apply(&save).unwrap().seq, committed.seq);
    assert_eq!(
        n.changes_since(committed.seq - 1, 10).unwrap()[0].library_views,
        vec![view_id.clone()]
    );
    assert!(matches!(
        n.apply(&batch(save.operations.clone())),
        Err(Error::Conflict { .. })
    ));
    for name in [String::new(), " ".into(), "x".repeat(121)] {
        assert!(
            n.apply(&batch(vec![Operation::SaveLibraryView {
                id: id(),
                base_revision: None,
                name,
                query: query.clone()
            }]))
            .is_err()
        );
    }
    drop(n);
    let mut n = Notebook::open(dir.path()).unwrap();
    let views = n.library_views().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].name, "Reading list");
    assert_eq!(views[0].query, query);
    n.apply(&batch(vec![Operation::SaveLibraryView {
        id: view_id.clone(),
        base_revision: Some(1),
        name: "Renamed".into(),
        query,
    }]))
    .unwrap();
    assert_eq!(n.library_views().unwrap()[0].revision, 2);
    assert!(
        n.apply(&batch(vec![Operation::DeleteLibraryView {
            id: view_id.clone(),
            base_revision: 1
        }]))
        .is_err()
    );
    let deleted = n
        .apply(&batch(vec![Operation::DeleteLibraryView {
            id: view_id.clone(),
            base_revision: 2,
        }]))
        .unwrap();
    assert_eq!(deleted.library_views[0].revision, 3);
    assert_eq!(
        n.changes_since(deleted.seq - 1, 10).unwrap()[0].library_views,
        vec![view_id.clone()]
    );
    assert!(n.library_views().unwrap().is_empty());
    assert!(matches!(
        n.apply(&batch(vec![Operation::DeleteLibraryView {
            id: view_id,
            base_revision: 3
        }])),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn library_query_export_ignores_display_limits_and_preserves_empty_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let first = source(&mut n, "Reading one", ReadingState::Reading);
    source(&mut n, "Reading two", ReadingState::Reading);
    source(&mut n, "Reading inbox", ReadingState::Inbox);
    source(&mut n, "Unrelated", ReadingState::Reading);
    let query = LibraryQuery {
        text: Some("Reading".into()),
        states: vec![ReadingState::Reading],
        limit: Some(1),
        ..Default::default()
    };
    assert_eq!(n.library(&query).unwrap().rows.len(), 1);
    let csl: serde_json::Value =
        serde_json::from_str(&n.export_query(&query, ExportFormat::CslJson).unwrap()).unwrap();
    assert_eq!(csl.as_array().unwrap().len(), 2);
    assert_eq!(
        n.export_query(&query, ExportFormat::Bibtex)
            .unwrap()
            .matches("@book{")
            .count(),
        2
    );
    let selected: serde_json::Value =
        serde_json::from_str(&n.export(&[first], ExportFormat::CslJson).unwrap()).unwrap();
    assert_eq!(selected.as_array().unwrap().len(), 1);
    let empty = LibraryQuery {
        text: Some("No matching source".into()),
        ..query
    };
    assert_eq!(n.export_query(&empty, ExportFormat::Bibtex).unwrap(), "");
    assert_eq!(
        n.export_query(&empty, ExportFormat::CslJson).unwrap(),
        "[]\n"
    );
}

#[test]
fn failed_and_queued_jobs_are_not_hidden_by_the_completed_job_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let job = n
        .queue_ingest(
            IngestInput::Url,
            "https://example.org/fail",
            "failure",
            None,
        )
        .unwrap();
    let running = n.claim_ingest().unwrap().unwrap();
    assert_eq!(running.id, job.id);
    n.fail_ingest(&job.id, "bad URL", None).unwrap();
    for index in 0..3 {
        n.queue_ingest(
            IngestInput::Url,
            &format!("https://example.org/{index}"),
            "queued",
            None,
        )
        .unwrap();
    }
    drop(n);
    let n = Notebook::open(dir.path()).unwrap();
    let jobs = n.ingest_jobs(1).unwrap();
    assert_eq!(jobs.len(), 4);
    let failed = jobs.iter().find(|value| value.id == job.id).unwrap();
    assert_eq!(failed.state, IngestJobState::Failed);
    assert_eq!(failed.attempts, 1);
}
