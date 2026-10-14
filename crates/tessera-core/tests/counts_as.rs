use serde_json::{Value, json};
use tessera_core::library::*;
use tessera_core::{Actor, Batch, CountsAs, Error, FieldKind, Notebook, Operation};

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
fn insert(n: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn creators(nb: &Notebook, field: &str, person: u128) -> Vec<String> {
    let query: Value =
        json!({"source":"sources","filters":[{"field":field,"op":"is","value":id(person)}]});
    nb.query(&serde_json::from_value(query).unwrap())
        .unwrap()
        .rows
        .into_iter()
        .map(|row| row.block.block.id)
        .collect()
}
fn counts_as(nb: &Notebook, field: u128, counts_as: Option<CountsAs>) -> Batch {
    batch(vec![Operation::SetFieldCountsAs {
        id: id(field),
        base_revision: nb.block(&id(field)).unwrap().revision,
        counts_as,
    }])
}

#[test]
fn creators_read_what_fields_count_as_with_author_first_and_editors_as_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    let mut operations = vec![];
    for (n, title) in [
        (1, "Thomas Kuhn"),
        (2, "Ian Hacking"),
        (3, "John Ford"),
        (4, "Warren Weaver"),
        (10, "Revolutions"),
        (11, "Representing"),
        (12, "Stagecoach"),
    ] {
        operations.push(Operation::CreatePage {
            id: id(n),
            title: title.into(),
        });
    }
    for (n, name) in [
        (100, "author"),
        (101, "editor"),
        (102, "translator"),
        (103, "director"),
        (104, "premiered"),
    ] {
        operations.push(insert(n, &fields, name));
    }
    nb.apply(&batch(operations)).unwrap();
    let mut operations = vec![];
    for (n, kind) in [
        (100, FieldKind::Instance),
        (101, FieldKind::Instance),
        (102, FieldKind::Instance),
        (103, FieldKind::Instance),
        (104, FieldKind::Date),
    ] {
        operations.push(Operation::SetFieldKind {
            id: id(n),
            base_revision: 1,
            kind,
        });
    }
    for (entry, owner, field, value, person) in [
        (200, 10, 100, 300, 1),
        (201, 10, 101, 301, 2),
        (202, 10, 102, 302, 4),
        (203, 11, 101, 303, 2),
        (204, 12, 103, 304, 3),
    ] {
        operations.push(insert(entry, &id(owner), &format!("[[{}]]", id(field))));
        operations.push(insert(value, &id(entry), &format!("[[{}]]", id(person))));
    }
    for (n, key) in [(10, "kuhn"), (11, "hacking"), (12, "ford")] {
        operations.push(Operation::SetSource {
            id: id(n),
            base_revision: 1,
            source: Some(SourceState {
                format: SourceFormat::Record,
                state: ReadingState::Inbox,
                origin: None,
                match_key: None,
                citation_key: Some(key.into()),
            }),
        });
    }
    nb.apply(&batch(operations)).unwrap();

    // Built-in fields count as the core says, and cannot be told otherwise.
    let definitions = nb.fields().unwrap().fields;
    let counted = |n: u128| {
        definitions
            .iter()
            .find(|field| field.definition.id == id(n))
            .unwrap()
            .definition
            .counts_as
    };
    assert_eq!(
        [counted(100), counted(101), counted(102), counted(103)],
        [
            Some(CountsAs::Creator),
            Some(CountsAs::Creator),
            Some(CountsAs::Contributor),
            None
        ]
    );
    let refused = nb
        .apply(&counts_as(&nb, 102, Some(CountsAs::Creator)))
        .unwrap_err();
    assert!(matches!(refused, Error::Validation { .. }), "{refused}");
    assert!(
        refused
            .to_string()
            .contains("translator is built in and counts as contributor.")
    );
    assert!(
        nb.apply(&counts_as(&nb, 104, Some(CountsAs::Creator)))
            .is_err()
    );

    // A director counts as nothing until asked.
    assert!(creators(&nb, "@creator", 3).is_empty());
    nb.apply(&counts_as(&nb, 103, Some(CountsAs::Creator)))
        .unwrap();
    assert_eq!(creators(&nb, "@creator", 3), [id(12)]);
    assert_eq!(creators(&nb, "@creator", 1), [id(10)]);
    // An editor is a creator only of a work with no other.
    assert_eq!(creators(&nb, "@creator", 2), [id(11)]);
    assert_eq!(creators(&nb, "@contributor", 4), [id(10)]);
    assert!(creators(&nb, "@creator", 4).is_empty());

    assert!(nb.source(&id(12)).unwrap().source.siglum.starts_with("FOR"));
    assert!(nb.source(&id(11)).unwrap().source.siglum.starts_with("HAC"));
    let csl: Value =
        serde_json::from_str(&nb.export(&[id(12)], ExportFormat::CslJson).unwrap()).unwrap();
    assert_eq!(csl[0]["director"][0]["family"], "Ford");
    assert!(csl[0].get("author").is_none());
    let bib = nb.export(&[id(10)], ExportFormat::Bibtex).unwrap();
    assert!(bib.contains("author = {Kuhn, Thomas}"), "{bib}");
    assert!(bib.contains("translator = {Weaver, Warren}"), "{bib}");

    nb.apply(&counts_as(&nb, 103, None)).unwrap();
    assert!(creators(&nb, "@creator", 3).is_empty());
}
