use tessera_core::{Actor, Batch, Committed, Notebook, Operation};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn apply(notebook: &mut Notebook, operations: Vec<Operation>) -> Committed {
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: Some("discovery regression".into()),
            idempotency_key: None,
            operations,
        })
        .unwrap()
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn insert(value: u128, parent: u128, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: None,
        text: text.into(),
        heading: None,
    }
}

fn archive(notebook: &Notebook, value: u128, archived: bool) -> Operation {
    Operation::SetArchived {
        id: id(value),
        base_revision: notebook.block(&id(value)).unwrap().revision,
        archived,
    }
}

fn assert_source_discovery(notebook: &Notebook, expected: &[u128], limit: usize) {
    let expected: Vec<_> = expected.iter().copied().map(id).collect();
    assert_eq!(
        notebook
            .search("needle", limit)
            .unwrap()
            .into_iter()
            .map(|hit| hit.block.id)
            .collect::<Vec<_>>(),
        expected,
        "search must filter effective archive state before ranking and limiting"
    );
    assert_eq!(
        notebook
            .complete("needle", limit)
            .unwrap()
            .into_iter()
            .map(|completion| completion.block.id)
            .collect::<Vec<_>>(),
        expected,
        "FTS completion must filter effective archive state before limiting"
    );
    assert_eq!(
        notebook
            .members(&id(2), limit)
            .unwrap()
            .into_iter()
            .map(|hit| hit.block.id)
            .collect::<Vec<_>>(),
        expected,
        "members must filter effective archive state before limiting"
    );
    assert_eq!(
        notebook
            .backlinks(&id(3), limit)
            .unwrap()
            .into_iter()
            .map(|hit| hit.source.id)
            .collect::<Vec<_>>(),
        expected,
        "backlinks must filter effective archive state before limiting"
    );
}

#[test]
fn archived_leaves_and_ancestors_are_filtered_before_small_limits() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let text = format!("needle #Marker [[{}]]", id(3));
    apply(
        &mut notebook,
        vec![
            page(1, "Notes"),
            page(2, "Marker"),
            page(3, "Target"),
            insert(10, 1, &text),
            insert(11, 1, "branch"),
            insert(12, 11, &text),
            insert(20, 1, &text),
        ],
    );
    let operations = vec![archive(&notebook, 10, true), archive(&notebook, 11, true)];
    apply(&mut notebook, operations);
    assert!(!notebook.block(&id(12)).unwrap().archived);
    assert_source_discovery(&notebook, &[20], 1);
    assert_source_discovery(&notebook, &[20], 100);
}

#[test]
fn archived_roots_are_hidden_from_roots_titles_and_source_discovery() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let text = format!("needle #Marker [[{}]]", id(3));
    apply(
        &mut notebook,
        vec![
            page(1, "Prefix A hidden"),
            page(2, "Marker"),
            page(3, "Target"),
            page(4, "Prefix Z visible"),
            insert(10, 1, &text),
            insert(20, 4, &text),
        ],
    );
    let operation = archive(&notebook, 1, true);
    apply(&mut notebook, vec![operation]);
    assert_eq!(
        notebook
            .roots()
            .unwrap()
            .into_iter()
            .map(|block| block.id)
            .collect::<Vec<_>>(),
        vec![notebook.fields().unwrap().page_id, id(2), id(4), id(3)]
    );
    assert_eq!(notebook.complete("prefix", 1).unwrap()[0].block.id, id(4));
    assert_eq!(notebook.search("prefix", 1).unwrap()[0].block.id, id(4));
    assert_source_discovery(&notebook, &[20], 1);
    assert_source_discovery(&notebook, &[20], 100);
    let view = notebook.page(&id(1)).unwrap();
    assert!(view.root.archived);
    assert_eq!(view.rows[0].block.id, id(10));
    assert!(!view.rows[0].block.archived);
}

#[test]
fn restoration_preserves_archive_and_unarchive_reveals_current_subtree() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let text = format!("needle #Marker [[{}]]", id(3));
    apply(
        &mut notebook,
        vec![
            page(1, "Notes"),
            page(2, "Marker"),
            page(3, "Target"),
            insert(10, 1, "branch"),
            insert(11, 10, &text),
        ],
    );
    let operation = archive(&notebook, 10, true);
    apply(&mut notebook, vec![operation]);
    let deleted = apply(
        &mut notebook,
        vec![Operation::Delete {
            id: id(10),
            base_revision: 2,
        }],
    );
    assert_source_discovery(&notebook, &[], 1);
    apply(
        &mut notebook,
        vec![Operation::Restore {
            id: id(10),
            revision: 3,
            deletion_id: deleted.deletions[0].clone(),
        }],
    );
    assert!(notebook.block(&id(10)).unwrap().archived);
    assert_source_discovery(&notebook, &[], 1);
    let operation = archive(&notebook, 10, false);
    apply(&mut notebook, vec![operation]);
    assert_source_discovery(&notebook, &[11], 1);
    let operation = archive(&notebook, 1, true);
    apply(&mut notebook, vec![operation]);
    assert_source_discovery(&notebook, &[], 1);
    let operation = archive(&notebook, 1, false);
    apply(&mut notebook, vec![operation]);
    assert_source_discovery(&notebook, &[11], 1);
}

#[test]
fn archived_targets_are_not_discoverable_but_page_keeps_editing_rows_and_targets() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let text = format!("needle #Marker [[{}]]", id(3));
    apply(
        &mut notebook,
        vec![
            page(1, "Notes"),
            page(2, "Marker"),
            page(4, "Other"),
            insert(3, 4, "target"),
            insert(10, 1, &text),
            insert(11, 10, "unarchived child"),
        ],
    );
    let operations = vec![archive(&notebook, 2, true), archive(&notebook, 4, true)];
    apply(&mut notebook, operations);
    assert!(notebook.members(&id(2), 1).unwrap().is_empty());
    assert!(notebook.backlinks(&id(3), 1).unwrap().is_empty());
    let operations = vec![archive(&notebook, 1, true), archive(&notebook, 10, true)];
    apply(&mut notebook, operations);
    let view = notebook.page(&id(1)).unwrap();
    assert!(view.root.archived);
    assert_eq!(
        view.rows
            .iter()
            .map(|row| (row.block.id.clone(), row.depth, row.block.archived))
            .collect::<Vec<_>>(),
        vec![(id(10), 0, true), (id(11), 1, false)]
    );
    assert_eq!(
        view.targets
            .iter()
            .map(|block| (block.id.clone(), block.archived))
            .collect::<Vec<_>>(),
        vec![(id(2), true), (id(3), false)]
    );
}

#[test]
fn canonical_reference_search_tracks_live_labels_without_rewriting_authored_text() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    let canonical = format!("Canonical [[{}]]", id(2));
    apply(
        &mut notebook,
        vec![
            page(1, "Notes"),
            page(2, "Ibn Khaldun"),
            insert(10, 1, &canonical),
            insert(11, 1, &format!("Aliased [[{}|Historian]]", id(2))),
            insert(12, 1, &format!("Unresolved [[{}]]", id(3))),
        ],
    );
    let hits = |notebook: &Notebook, query: &str| {
        notebook
            .search(query, 100)
            .unwrap()
            .into_iter()
            .map(|row| row.block.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(hits(&notebook, "Canonical Ibn Khaldun"), [id(10)]);
    assert!(hits(&notebook, "Aliased Ibn Khaldun").is_empty());
    assert_eq!(hits(&notebook, "Aliased Historian"), [id(11)]);
    apply(
        &mut notebook,
        vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "Ibn Khaldūn renamed".into(),
        }],
    );
    assert_eq!(hits(&notebook, "Canonical Ibn Khaldun renamed"), [id(10)]);
    assert_eq!(notebook.block(&id(10)).unwrap().text, canonical);
    apply(&mut notebook, vec![page(3, "Plato")]);
    assert_eq!(hits(&notebook, "Unresolved Plato"), [id(12)]);
    let deleted = apply(
        &mut notebook,
        vec![Operation::Delete {
            id: id(2),
            base_revision: 2,
        }],
    );
    assert!(hits(&notebook, "Canonical Ibn").is_empty());
    apply(
        &mut notebook,
        vec![Operation::Restore {
            id: id(2),
            revision: 3,
            deletion_id: deleted.deletions[0].clone(),
        }],
    );
    assert_eq!(hits(&notebook, "Canonical renamed"), [id(10)]);
    apply(
        &mut notebook,
        vec![Operation::EditText {
            id: id(10),
            base_revision: 1,
            text: "Canonical without a link".into(),
        }],
    );
    assert!(hits(&notebook, "Canonical renamed").is_empty());
    drop(notebook);
    let notebook = Notebook::open(directory.path()).unwrap();
    assert_eq!(hits(&notebook, "Unresolved Plato"), [id(12)]);
    assert_eq!(hits(&notebook, "Aliased Historian"), [id(11)]);
}

#[test]
fn punctuation_and_emoji_search_match_literally_without_empty_alias_prefixes() {
    let directory = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(directory.path()).unwrap();
    apply(
        &mut notebook,
        vec![
            page(1, "Notes"),
            page(2, "Other"),
            insert(10, 1, "Unicode QA emoji 👩🏽‍💻"),
            insert(11, 1, "literal _ * \\"),
            insert(12, 1, "hidden 👩🏽‍💻"),
        ],
    );
    notebook.add_alias(&id(2), "Unrelated", Actor::Person).unwrap();
    let operation = archive(&notebook, 12, true);
    apply(&mut notebook, vec![operation]);
    for (query, expected) in [("👩🏽‍💻", 10), ("_", 11), ("*", 11), ("\\", 11)] {
        assert_eq!(
            notebook.search(query, 20).unwrap().iter().map(|hit| hit.block.id.clone()).collect::<Vec<_>>(),
            vec![id(expected)]
        );
        assert_eq!(
            notebook.complete(query, 20).unwrap().iter().map(|hit| hit.block.id.clone()).collect::<Vec<_>>(),
            vec![id(expected)]
        );
    }
    assert!(notebook.search("🦊", 20).unwrap().is_empty());
    assert!(notebook.complete("🦊", 20).unwrap().is_empty());
    assert!(notebook.search("", 20).unwrap().is_empty());
}
