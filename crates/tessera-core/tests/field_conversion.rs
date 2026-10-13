use tessera_core::{Actor, Batch, FieldKind, Notebook, Operation};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn insert(value: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> tessera_core::Committed {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap()
}

#[test]
fn choice_conversion_deduplicates_links_and_reverts_in_one_batch() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    let mut operations = vec![insert(10, &fields, "Strand")];
    for (index, (title, text)) in [
        ("Zulu", "  Dynastic cycle  "),
        ("Alpha", "DYNASTIC CYCLE"),
        ("Middle", "Method"),
    ]
    .iter()
    .enumerate()
    {
        let n = index as u128;
        operations.push(Operation::CreatePage {
            id: id(100 + n),
            title: (*title).into(),
        });
        operations.push(insert(200 + n, &id(100 + n), &format!("[[{}]]", id(10))));
        operations.push(insert(300 + n, &id(200 + n), text));
    }
    operations.push(insert(400, &id(300), "Keep this child note"));
    let seed = apply(&mut nb, operations);
    let preview = nb
        .field_detail(&id(10), Some(FieldKind::Choice), Some(1))
        .unwrap();
    assert_eq!(preview.problems_total, 3);
    assert_eq!(
        preview
            .choice_candidates
            .iter()
            .map(|candidate| candidate.text.as_str())
            .collect::<Vec<_>>(),
        ["Dynastic cycle", "Method"]
    );
    assert_eq!(preview.choice_candidates[0].values.len(), 2);
    assert_eq!(
        preview.choice_candidates[0].values[0].text,
        "  Dynastic cycle  "
    );
    let mut convert = vec![Operation::SetFieldKind {
        id: id(10),
        base_revision: 1,
        kind: FieldKind::Choice,
    }];
    let mut undo = vec![Operation::SetFieldKind {
        id: id(10),
        base_revision: 2,
        kind: FieldKind::Text,
    }];
    for (index, candidate) in preview.choice_candidates.iter().enumerate() {
        let option = 500 + index as u128;
        convert.push(insert(option, &id(10), &candidate.text));
        for value in &candidate.values {
            convert.push(Operation::EditText {
                id: value.id.clone(),
                base_revision: value.revision,
                text: format!("[[{}]]", id(option)),
            });
            undo.push(Operation::EditText {
                id: value.id.clone(),
                base_revision: value.revision + 1,
                text: value.text.clone(),
            });
        }
        undo.push(Operation::Delete {
            id: id(option),
            base_revision: 1,
        });
    }
    let changed = apply(&mut nb, convert);
    assert_eq!(changed.seq, seed.seq + 1);
    let detail = nb.field_detail(&id(10), None, None).unwrap();
    assert_eq!(detail.problems_total, 0);
    assert_eq!(detail.field.definition.options.len(), 2);
    assert_eq!(
        nb.block(&id(300)).unwrap().text,
        nb.block(&id(301)).unwrap().text
    );
    assert_eq!(nb.block(&id(400)).unwrap().parent_id, Some(id(300)));
    let reverted = apply(&mut nb, undo);
    assert_eq!(reverted.seq, changed.seq + 1);
    assert_eq!(nb.block(&id(300)).unwrap().text, "  Dynastic cycle  ");
    assert_eq!(nb.block(&id(301)).unwrap().text, "DYNASTIC CYCLE");
    assert_eq!(nb.block(&id(302)).unwrap().text, "Method");
    let detail = nb.field_detail(&id(10), None, None).unwrap();
    assert_eq!(detail.field.definition.kind, FieldKind::Text);
    assert!(detail.field.definition.options.is_empty());
}

#[test]
fn conversion_candidates_include_all_values_and_reuse_existing_options() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    let mut operations = vec![
        insert(10, &fields, "Strand"),
        insert(11, &id(10), "  METHOD  "),
        Operation::CreatePage {
            id: id(100),
            title: "Owner".into(),
        },
        insert(200, &id(100), &format!("[[{}]]", id(10))),
    ];
    for n in 0..120 {
        operations.push(insert(
            300 + n,
            &id(200),
            if n % 2 == 0 { "method" } else { "Method" },
        ));
    }
    apply(&mut nb, operations);
    let preview = nb
        .field_detail(&id(10), Some(FieldKind::Choice), Some(0))
        .unwrap();
    assert_eq!(preview.problems.len(), 100);
    assert_eq!(preview.problems_total, 120);
    assert_eq!(preview.choice_candidates.len(), 1);
    assert_eq!(preview.choice_candidates[0].option_id, Some(id(11)));
    assert_eq!(preview.choice_candidates[0].values.len(), 120);
    assert_eq!(preview.choice_candidates[0].text, "method");
}

#[test]
fn new_definition_never_adopts_a_blank_row_or_its_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(10, &fields, " \t\u{2003}"),
            insert(11, &id(10), "Existing child"),
            Operation::CreatePage {
                id: id(100),
                title: "Owner".into(),
            },
            insert(200, &id(100), &format!("[[{}]]", id(10))),
            insert(300, &id(200), "Unrelated value"),
        ],
    );
    assert!(nb.fields().unwrap().fields.is_empty());
    assert!(nb.field_detail(&id(10), None, None).is_err());
    apply(
        &mut nb,
        vec![
            insert(12, &fields, "Strand"),
            Operation::SetFieldKind {
                id: id(12),
                base_revision: 1,
                kind: FieldKind::Choice,
            },
            insert(201, &id(100), &format!("[[{}]]", id(12))),
        ],
    );
    let registered = nb.fields().unwrap();
    assert_eq!(registered.fields.len(), 1);
    assert_eq!(registered.fields[0].definition.id, id(12));
    assert_eq!(registered.fields[0].owners, 1);
    assert_eq!(nb.block(&id(10)).unwrap().text, " \t\u{2003}");
    assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(10)));
    assert_eq!(nb.block(&id(200)).unwrap().text, format!("[[{}]]", id(10)));
    assert!(
        nb.field_detail(&id(12), None, None)
            .unwrap()
            .field
            .definition
            .options
            .is_empty()
    );
}
