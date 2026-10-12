use tessera_core::{Actor, Batch, Notebook, Operation, PageView, library::*};

fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}

fn source(notebook: &mut Notebook, title: &str, key: Option<&str>) -> String {
    let id = ulid::Ulid::generate().to_string();
    notebook
        .apply(&batch(vec![
            Operation::CreatePage {
                id: id.clone(),
                title: title.into(),
            },
            Operation::SetSource {
                id: id.clone(),
                base_revision: 1,
                source: Some(SourceState {
                    format: SourceFormat::Record,
                    state: ReadingState::Inbox,
                    origin: None,
                    match_key: None,
                    citation_key: key.map(str::to_owned),
                }),
            },
        ]))
        .unwrap();
    id
}

#[test]
fn citation_collision_names_occupying_source_and_rolls_back_every_operation() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let owner = source(&mut notebook, "Occupied source", Some("reader2026book"));
    let other = source(&mut notebook, "Edited source", Some("other2026book"));
    let before = notebook.source(&other).unwrap();
    let mut state = before.source.source_state();
    state.citation_key = Some("READER2026BOOK".into());
    state.state = ReadingState::Reading;
    let error = notebook
        .apply(&batch(vec![
            Operation::EditText {
                id: other.clone(),
                base_revision: before.page.revision,
                text: "Rejected title".into(),
            },
            Operation::SetSource {
                id: other.clone(),
                base_revision: before.page.revision + 1,
                source: Some(state),
            },
        ]))
        .unwrap_err()
        .to_string();
    assert!(error.contains("Occupied source"), "{error}");
    assert!(error.contains(&owner), "{error}");
    assert!(error.contains("READER2026BOOK"), "{error}");
    let after = notebook.source(&other).unwrap();
    assert_eq!(after.page, before.page);
    assert_eq!(after.source, before.source);

    let mut state = before.source.source_state();
    state.state = ReadingState::Finished;
    notebook
        .apply(&batch(vec![Operation::SetSource {
            id: other.clone(),
            base_revision: before.page.revision,
            source: Some(state),
        }]))
        .unwrap();
    assert_eq!(
        notebook.source(&other).unwrap().source.state,
        ReadingState::Finished
    );
}

#[test]
fn duplicate_key_within_one_batch_is_atomic_and_names_the_first_source() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let first = source(&mut notebook, "First selected source", None);
    let second = source(&mut notebook, "Second selected source", None);
    let operations = [&first, &second]
        .into_iter()
        .map(|id| {
            let view = notebook.source(id).unwrap();
            let mut state = view.source.source_state();
            state.citation_key = Some("shared2026key".into());
            Operation::SetSource {
                id: id.clone(),
                base_revision: view.page.revision,
                source: Some(state),
            }
        })
        .collect();
    let error = notebook.apply(&batch(operations)).unwrap_err().to_string();
    assert!(error.contains("First selected source"), "{error}");
    for id in [&first, &second] {
        assert_eq!(notebook.source(id).unwrap().source.citation_key, None);
    }
}

#[test]
fn page_root_tags_survive_reopen_and_old_page_snapshots_default_to_empty() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let id = source(&mut notebook, "Tagged source", None);
    let revision = notebook.block(&id).unwrap().revision;
    notebook
        .apply(&batch(vec![
            Operation::AddType {
                id: id.clone(),
                base_revision: revision,
                title: "History".into(),
            },
            Operation::AddType {
                id: id.clone(),
                base_revision: revision + 1,
                title: "To read".into(),
            },
        ]))
        .unwrap();
    drop(notebook);
    let notebook = Notebook::open(directory.path()).unwrap();
    let view = notebook.page(&id).unwrap();
    assert_eq!(view.root_manual_types, ["History", "To read"]);
    let mut old = serde_json::to_value(view).unwrap();
    old.as_object_mut().unwrap().remove("root_manual_types");
    let recovered: PageView = serde_json::from_value(old).unwrap();
    assert!(recovered.root_manual_types.is_empty());
}
