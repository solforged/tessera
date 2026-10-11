use tessera_core::{Actor, Batch, Error, Notebook, Operation, ProjectState, QuestionState};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn apply(nb: &mut Notebook, operations: Vec<Operation>) {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn revision(nb: &Notebook, value: u128) -> i64 {
    nb.block(&id(value)).unwrap().revision
}

fn tag(nb: &mut Notebook, value: u128, title: &str) {
    let base_revision = revision(nb, value);
    apply(
        nb,
        vec![Operation::AddType {
            id: id(value),
            base_revision,
            title: title.into(),
        }],
    );
}

fn keys(nb: &Notebook) -> Vec<(String, String, usize)> {
    nb.note_index()
        .unwrap()
        .kinds
        .into_iter()
        .map(|kind| (kind.kind.key, kind.kind.plural, kind.count))
        .collect()
}

fn titles(nb: &Notebook, key: &str) -> Vec<String> {
    nb.kind_notes(key)
        .unwrap()
        .into_iter()
        .map(|note| note.title)
        .collect()
}

#[test]
fn notes_file_under_built_in_kinds_capabilities_and_types_you_made() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Polybius"),
            page(2, "Plato"),
            page(3, "Anacyclosis"),
            page(4, "Which model fits my work?"),
            page(5, "Ship the notes index"),
            page(6, "Loose thoughts"),
            page(7, "Abandoned draft"),
            Operation::Insert {
                id: id(60),
                parent_id: id(6),
                after: None,
                text: "a block about #Concept is not a concept note".into(),
                heading: None,
            },
        ],
    );
    tag(&mut nb, 1, "Person");
    tag(&mut nb, 1, "Historian");
    tag(&mut nb, 2, "person");
    tag(&mut nb, 3, "Concept");
    let base_revision = revision(&nb, 4);
    apply(
        &mut nb,
        vec![Operation::SetQuestion {
            id: id(4),
            base_revision,
            question: Some(QuestionState::default()),
        }],
    );
    let base_revision = revision(&nb, 5);
    apply(
        &mut nb,
        vec![Operation::SetProject {
            id: id(5),
            base_revision,
            project: Some(ProjectState {
                outcome: "Index ships".into(),
                ..ProjectState::default()
            }),
        }],
    );
    let base_revision = revision(&nb, 7);
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(7),
            base_revision,
            archived: true,
        }],
    );

    let historian = nb.page_by_title("Historian").unwrap().unwrap().id;
    // Built-in kinds first in their fixed order, then capability kinds, then types you made, then Unfiled.
    // Type pages (Person, Concept, Historian), the Fields page and archived pages are not listed as notes;
    // a tag inside a page's outline does not file the page.
    assert_eq!(
        keys(&nb),
        vec![
            ("person".into(), "People".into(), 2),
            ("concept".into(), "Concepts".into(), 1),
            ("question".into(), "Questions".into(), 1),
            ("project".into(), "Projects".into(), 1),
            (format!("type:{historian}"), "Historian".into(), 1),
            ("unfiled".into(), "Unfiled".into(), 1),
        ]
    );
    assert_eq!(nb.note_index().unwrap().notes, 6);
    assert_eq!(titles(&nb, "person"), ["Plato", "Polybius"]);
    assert_eq!(titles(&nb, "unfiled"), ["Loose thoughts"]);
    assert_eq!(titles(&nb, &format!("type:{historian}")), ["Polybius"]);
    assert!(titles(&nb, "group").is_empty());

    let polybius: Vec<_> = nb
        .note_kinds(&id(1))
        .unwrap()
        .into_iter()
        .map(|kind| kind.name)
        .collect();
    assert_eq!(polybius, ["Person", "Historian"]);
    assert!(
        nb.note_kinds(&id(6)).unwrap().is_empty(),
        "an unfiled note has no kind to show"
    );

    assert!(matches!(
        nb.kind_notes("people"),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        nb.kind_notes(&format!("type:{}", id(99))),
        Err(Error::NotFound { .. })
    ));
}
