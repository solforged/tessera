use tessera_core::library::{
    ExtractedDocument, ExtractedMetadata, ExtractedPassage, PassageKind, PassagePoint, SourceFormat,
};
use tessera_core::{Actor, Batch, Committed, Error, Notebook, Operation};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: Some("Spread test".into()),
        idempotency_key: None,
        operations,
    }
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&batch(operations)).unwrap()
}
fn page(n: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(n),
        title: title.into(),
    }
}
fn child(n: u128, parent: &str, after: Option<u128>, text: &str) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: parent.into(),
        after: after.map(id),
        text: text.into(),
        heading: None,
    }
}
fn revision(nb: &Notebook, n: u128) -> i64 {
    nb.block(&id(n)).unwrap().revision
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Solidarity"),
            page(2, "Authority"),
            page(3, "Dynasty"),
            page(4, "Common link"),
        ],
    );
    (dir, nb)
}

#[test]
fn fields_union_in_column_outline_order_with_blank_cells_and_exact_shared_values() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            child(10, &fields, None, "Stage"),
            child(11, &fields, Some(10), "Gloss"),
            child(12, &fields, Some(11), "Related"),
            child(13, &fields, Some(12), "Empty"),
            child(14, &fields, Some(13), "Repeated"),
            Operation::AddType {
                id: id(1),
                base_revision: 1,
                title: "Concept".into(),
            },
            child(20, &id(1), None, &format!("[[{}]]", id(10))),
            child(21, &id(20), None, "  Working  "),
            child(22, &id(1), Some(20), &format!("[[{}]]", id(11))),
            child(23, &id(22), None, "A gloss"),
            child(24, &id(1), Some(22), &format!("[[{}]]", id(12))),
            child(25, &id(24), None, &format!("[[{}|Alias A]]", id(4))),
            child(26, &id(1), Some(24), "Opening one"),
            child(27, &id(1), Some(26), &format!("[[{}]]", id(14))),
            child(28, &id(27), None, "Only here"),
            child(29, &id(27), Some(28), "Only here"),
            child(30, &id(2), None, &format!("[[{}]]", id(13))),
            child(31, &id(2), Some(30), &format!("[[{}]]", id(10))),
            child(32, &id(31), None, "Working"),
            child(33, &id(2), Some(31), &format!("[[{}]]", id(12))),
            child(34, &id(33), None, &format!("[[{}|Alias B]]", id(4))),
            child(
                35,
                &id(2),
                Some(33),
                &format!("Opening linked to [[{}]]", id(1)),
            ),
            child(40, &id(3), None, &format!("[[{}]]", id(10))),
            child(41, &id(40), None, "working"),
        ],
    );
    let spread = nb.spread(&[id(1), id(2), id(3)]).unwrap();
    assert_eq!(
        spread
            .fields
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["Stage", "Gloss", "Related", "Repeated", "Empty"]
    );
    assert_eq!(spread.fields[0].cells.len(), 3);
    assert!(spread.fields[0].cells[0][0].shared);
    assert!(spread.fields[0].cells[1][0].shared);
    assert!(
        !spread.fields[0].cells[2][0].shared,
        "case differences imply nothing"
    );
    assert!(spread.fields[1].cells[1].is_empty());
    assert!(
        spread.fields[4].cells.iter().all(Vec::is_empty),
        "empty fields still have an aligned row"
    );
    assert!(
        spread.fields[2].cells[0][0].shared && spread.fields[2].cells[1][0].shared,
        "link aliases compare by target"
    );
    assert!(
        spread.fields[3].cells[0].iter().all(|value| !value.shared),
        "repeating inside one column is not sharing"
    );
    assert_eq!(spread.columns[0].kinds[0].key, "concept");
    assert_eq!(spread.columns[0].title, "Solidarity");
    assert_eq!(spread.columns[0].gloss[0].text, "A gloss");
    assert_eq!(spread.columns[0].opening[0].text, "Opening one");
    assert!(
        spread.columns[1]
            .links
            .iter()
            .any(|value| value.target_id == Some(id(1)) && value.between_columns)
    );
    assert!(
        spread.columns[0]
            .links
            .iter()
            .any(|value| value.target_id == Some(id(4)) && value.shared && !value.between_columns)
    );
    let reversed = nb.spread(&[id(2), id(1)]).unwrap();
    assert_eq!(reversed.fields[0].name, "Empty");
}

#[test]
fn source_references_and_passage_citations_share_one_source_identity() {
    let (_dir, mut nb) = fixture();
    let document = ExtractedDocument {
        format: SourceFormat::Article,
        media_type: "text/html".into(),
        metadata: ExtractedMetadata {
            title: Some("Muqaddimah".into()),
            ..Default::default()
        },
        toc: vec![],
        resources: vec![],
        passages: vec![ExtractedPassage {
            kind: PassageKind::Paragraph,
            level: None,
            text: "Shared evidence".into(),
            locator: "chapter-1".into(),
            anchor: None,
            resource: None,
            marks: vec![],
        }],
    };
    let hash = nb.put_object(b"spread source").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap();
    let plan = nb.plan_ingest(&snapshot.id, None, None).unwrap();
    let source = plan.source_id.clone();
    apply(&mut nb, plan.operations);
    let passage = nb.passages(&snapshot.id, 0, 10).unwrap().passages[0]
        .id
        .clone();
    apply(
        &mut nb,
        vec![
            child(20, &id(1), None, &format!("Read [[{source}]]")),
            child(21, &id(2), None, "A cited claim"),
            Operation::Cite {
                id: id(21),
                base_revision: 1,
                citation_id: id(50),
                snapshot_id: snapshot.id,
                start: PassagePoint {
                    passage_id: passage.clone(),
                    offset: 0,
                },
                end: PassagePoint {
                    passage_id: passage,
                    offset: 6,
                },
                color: None,
            },
        ],
    );
    let spread = nb.spread(&[id(1), id(2), id(3)]).unwrap();
    for column in &spread.columns[..2] {
        assert_eq!(column.sources.len(), 1);
        assert_eq!(
            column.sources[0].target_id.as_deref(),
            Some(source.as_str())
        );
        assert!(column.sources[0].shared);
        assert!(
            !column
                .links
                .iter()
                .any(|value| value.target_id.as_deref() == Some(source.as_str()))
        );
    }
    assert!(spread.columns[2].sources.is_empty());
}

#[test]
fn columns_are_attributed_outline_subtrees_and_move_delete_restore_preserve_commentary() {
    let (_dir, mut nb) = fixture();
    let created = apply(
        &mut nb,
        vec![
            page(5, "Comparison"),
            Operation::SetSpread {
                id: id(5),
                base_revision: 1,
                spread: true,
            },
            child(20, &id(5), None, &format!("[[{}]]", id(1))),
            child(21, &id(5), Some(20), &format!("[[{}]]", id(2))),
            child(22, &id(5), Some(21), &format!("[[{}]]", id(3))),
            child(23, &id(20), None, "Commentary on Solidarity"),
            child(24, &id(5), Some(22), "Notes on the whole spread"),
        ],
    );
    assert!(
        created
            .capabilities
            .iter()
            .any(|cap| cap.block_id == id(5) && cap.spread)
    );
    assert!(
        nb.page(&id(5))
            .unwrap()
            .capabilities
            .iter()
            .any(|cap| cap.spread)
    );
    assert_eq!(
        nb.saved_spread(&id(5)).unwrap().note_ids,
        [id(1), id(2), id(3)]
    );
    assert_eq!(nb.note_index().unwrap().spreads[0].id, id(5));
    let base_revision = revision(&nb, 21);
    apply(
        &mut nb,
        vec![Operation::Move {
            id: id(21),
            base_revision,
            parent_id: id(5),
            after: None,
        }],
    );
    assert_eq!(
        nb.saved_spread(&id(5)).unwrap().note_ids,
        [id(2), id(1), id(3)]
    );
    assert_eq!(nb.block(&id(23)).unwrap().parent_id, Some(id(20)));
    let base_revision = revision(&nb, 20);
    let deleted = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(20),
            base_revision,
        }],
    );
    assert_eq!(nb.saved_spread(&id(5)).unwrap().note_ids, [id(2), id(3)]);
    assert!(matches!(nb.block(&id(23)), Err(Error::NotFound { .. })));
    let revision = deleted
        .revisions
        .iter()
        .find(|revision| revision.id == id(20))
        .unwrap()
        .revision;
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(20),
            revision,
            deletion_id: deleted.deletions[0].clone(),
        }],
    );
    assert_eq!(
        nb.saved_spread(&id(5)).unwrap().note_ids,
        [id(2), id(1), id(3)]
    );
    assert_eq!(nb.block(&id(23)).unwrap().text, "Commentary on Solidarity");
    assert_eq!(nb.block(&id(24)).unwrap().text, "Notes on the whole spread");
    let change = nb.changes_since(created.seq - 1, 1).unwrap();
    assert_eq!(change[0].actor, Actor::Person);
}

#[test]
fn spread_limits_and_capability_are_checked_and_reversible() {
    let (_dir, mut nb) = fixture();
    assert!(nb.spread(&[]).unwrap().columns.is_empty());
    assert!(nb.spread(&[id(1), id(1)]).is_err());
    assert!(
        nb.spread(&[id(1), id(2), id(3), id(4), id(5), id(6)])
            .is_err()
    );
    apply(
        &mut nb,
        vec![
            page(5, "Fifth"),
            page(6, "Sixth"),
            page(7, "Spread"),
            Operation::SetSpread {
                id: id(7),
                base_revision: 1,
                spread: true,
            },
        ],
    );
    let operations = (1..=6)
        .map(|n| {
            child(
                20 + n,
                &id(7),
                (n > 1).then_some(19 + n),
                &format!("[[{}]]", id(n)),
            )
        })
        .collect();
    assert!(nb.apply(&batch(operations)).is_err());
    assert!(
        nb.page(&id(7)).unwrap().rows.is_empty(),
        "invalid sixth column rolls back the batch"
    );
    let base_revision = revision(&nb, 7);
    apply(
        &mut nb,
        vec![Operation::SetSpread {
            id: id(7),
            base_revision,
            spread: false,
        }],
    );
    assert!(!nb.capabilities(&id(7)).unwrap().spread);
    assert!(nb.saved_spread(&id(7)).is_err());
    assert!(nb.note_index().unwrap().spreads.is_empty());
}
