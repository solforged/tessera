use tessera_core::{Actor, Batch, Error, FieldKind, Notebook, Operation, Reading, library::*};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn page(n: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(n),
        title: title.into(),
    }
}
fn child(n: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn target(nb: &Notebook, targets: Vec<String>) -> Operation {
    Operation::SetFieldTargets {
        id: id(10),
        base_revision: nb.block(&id(10)).unwrap().revision,
        targets,
    }
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    nb.apply(&batch(vec![
        page(1, "Book"),
        page(2, "Person"),
        page(3, "Group"),
        page(4, "A creator"),
        child(10, &fields, "Author"),
        Operation::SetFieldKind {
            id: id(10),
            base_revision: 1,
            kind: FieldKind::Instance,
        },
        Operation::SetTypeFields {
            type_id: id(1),
            base_revision: 1,
            fields: vec![id(10)],
        },
        child(20, &id(1), &format!("[[{}]]", id(10))),
        child(21, &id(20), &format!("[[{}]]", id(4))),
    ]))
    .unwrap();
    (dir, nb)
}

#[test]
fn targets_validate_and_read_membership_without_rejecting_authored_values() {
    let (_dir, mut nb) = fixture();
    let op = target(&nb, vec![id(2), id(3)]);
    nb.apply(&batch(vec![op])).unwrap();
    let detail = nb.field_detail(&id(10), None, None).unwrap();
    assert_eq!(detail.field.definition.targets, [id(2), id(3)]);
    assert_eq!(
        detail.problems[0].value.reading,
        Reading::Problem {
            ok: false,
            problem: "Not a person or group".into()
        }
    );
    nb.apply(&batch(vec![Operation::AddType {
        id: id(4),
        base_revision: 1,
        title: "Concept".into(),
    }]))
    .unwrap();
    assert_eq!(
        nb.field_detail(&id(10), None, None).unwrap().problems_total,
        1
    );
    nb.apply(&batch(vec![Operation::AddType {
        id: id(4),
        base_revision: 2,
        title: "Group".into(),
    }]))
    .unwrap();
    assert_eq!(
        nb.field_detail(&id(10), None, None).unwrap().problems_total,
        0
    );
    for targets in [vec![id(2), id(2)], vec![id(20)], vec![id(99)]] {
        let op = target(&nb, targets);
        assert!(nb.apply(&batch(vec![op])).is_err());
    }
    let revision = nb.block(&id(10)).unwrap().revision;
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetFieldTargets {
            id: id(10),
            base_revision: revision - 1,
            targets: vec![]
        }])),
        Err(Error::Conflict { .. })
    ));
    nb.apply(&batch(vec![Operation::SetFieldKind {
        id: id(10),
        base_revision: revision,
        kind: FieldKind::Text,
    }]))
    .unwrap();
    let op = target(&nb, vec![id(2)]);
    assert!(matches!(
        nb.apply(&batch(vec![op])),
        Err(Error::Validation { .. })
    ));
}

#[test]
fn opening_backfills_once_through_logged_operations_and_preserves_existing_types() {
    let (dir, mut nb) = fixture();
    nb.apply(&batch(vec![
        page(5, "A group"),
        Operation::AddType {
            id: id(5),
            base_revision: 1,
            title: "Group".into(),
        },
        child(22, &id(20), &format!("[[{}]]", id(5))),
    ]))
    .unwrap();
    let before = nb.changes_since(0, 1000).unwrap().len();
    drop(nb);
    let nb = Notebook::open(dir.path()).unwrap();
    assert!(
        nb.kind_notes("person")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.id == id(4))
    );
    assert!(
        !nb.kind_notes("unfiled")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.id == id(4))
    );
    assert!(
        nb.kind_notes("group")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.id == id(5))
    );
    assert!(
        !nb.kind_notes("person")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.id == id(5))
    );
    assert_eq!(
        nb.field_detail(&id(10), None, None)
            .unwrap()
            .field
            .definition
            .targets,
        [id(2), id(3)]
    );
    assert!(
        !nb.kind_notes("unfiled")
            .unwrap()
            .notes
            .iter()
            .any(|note| [id(2), id(3)].contains(&note.id))
    );
    let after = nb.changes_since(0, 1000).unwrap().len();
    assert_eq!(after, before + 1);
    drop(nb);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.changes_since(0, 1000).unwrap().len(), after);
}

#[test]
fn import_files_new_and_matched_untyped_creators_but_keeps_groups() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        page(1, "Existing person"),
        page(2, "Existing group"),
        Operation::AddType {
            id: id(2),
            base_revision: 1,
            title: "Group".into(),
        },
    ]))
    .unwrap();
    let metadata = ExtractedMetadata {
        title: Some("A book".into()),
        creators: vec![
            ExtractedCreator {
                name: "New person".into(),
                role: CreatorRole::Author,
            },
            ExtractedCreator {
                name: "Existing person".into(),
                role: CreatorRole::Editor,
            },
            ExtractedCreator {
                name: "Existing group".into(),
                role: CreatorRole::Translator,
            },
        ],
        ..Default::default()
    };
    let plan = nb.plan_source_record(&metadata).unwrap();
    nb.apply(&batch(plan.operations)).unwrap();
    let people = nb.kind_notes("person").unwrap();
    assert_eq!(people.notes.len(), 2);
    assert!(people.notes.iter().any(|note| note.title == "New person"));
    assert!(people.notes.iter().any(|note| note.id == id(1)));
    assert_eq!(nb.kind_notes("group").unwrap().notes.len(), 1);
    let targets = vec![
        nb.page_by_title("Person").unwrap().unwrap().id,
        nb.page_by_title("Group").unwrap().unwrap().id,
    ];
    for name in ["Author", "Editor", "Translator"] {
        let field = nb
            .fields()
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.definition.name == name)
            .unwrap();
        assert_eq!(field.definition.targets, targets);
        assert_eq!(
            nb.field_detail(&field.definition.id, None, None)
                .unwrap()
                .problems_total,
            0
        );
    }
}
