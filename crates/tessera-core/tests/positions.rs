use tessera_core::{
    Actor, Batch, Committed, Error, Notebook, Operation, PositionInfo, PositionQuery,
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&batch(operations)).unwrap()
}
fn insert(value: u128, parent: u128, after: Option<u128>, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: after.map(id),
        text: text.into(),
        heading: None,
    }
}
fn set(nb: &Notebook, value: u128, position: bool) -> Operation {
    Operation::SetPosition {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        position,
    }
}
fn edit(nb: &mut Notebook, value: u128, text: &str) -> Committed {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::EditText {
            id: id(value),
            base_revision,
            text: text.into(),
        }],
    )
}
fn archive(nb: &mut Notebook, value: u128) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetArchived {
            id: id(value),
            base_revision,
            archived: true,
        }],
    );
}
fn info(nb: &Notebook, value: u128) -> PositionInfo {
    nb.capabilities(&id(value)).unwrap().position.unwrap()
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Subject".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Holder".into(),
            },
            Operation::CreatePage {
                id: id(3),
                title: "Other subject".into(),
            },
            Operation::CreateJournal {
                id: id(4),
                date: "2026-10-06".into(),
            },
            insert(10, 1, None, &format!("[[{}]]", id(2))),
            insert(11, 1, Some(10), "Parent"),
            insert(12, 11, None, &format!("[[{}]]", id(2))),
            insert(13, 1, Some(11), &format!("[[{}]]", id(2))),
        ],
    );
    (dir, nb)
}

#[test]
fn position_set_unset_noops_revisions_and_merge_protection() {
    let (_dir, mut nb) = fixture();
    let original = nb.block(&id(10)).unwrap().revision;
    let op = set(&nb, 10, false);
    assert!(apply(&mut nb, vec![op]).revisions.is_empty());
    let op = set(&nb, 10, true);
    let receipt = apply(&mut nb, vec![op.clone()]);
    assert_eq!(nb.block(&id(10)).unwrap().revision, original + 1);
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|c| c.block_id == id(10) && c.position.is_some() && c.merge_protected)
    );
    assert!(nb.apply(&batch(vec![op])).is_err());
    let op = set(&nb, 10, true);
    assert!(apply(&mut nb, vec![op]).revisions.is_empty());
    assert!(
        nb.page(&id(1))
            .unwrap()
            .capabilities
            .iter()
            .any(|c| c.block_id == id(10) && c.position.is_some())
    );
    assert!(
        nb.apply(&batch(vec![Operation::Merge {
            source_id: id(10),
            source_revision: original + 1,
            destination_id: id(11),
            destination_revision: nb.block(&id(11)).unwrap().revision
        }]))
        .is_err()
    );
    let op = set(&nb, 10, false);
    apply(&mut nb, vec![op]);
    assert_eq!(nb.block(&id(10)).unwrap().revision, original + 2);
    let cap = nb.capabilities(&id(10)).unwrap();
    assert!(cap.position.is_none());
    assert!(!cap.merge_protected);
    let op = set(&nb, 10, false);
    assert!(apply(&mut nb, vec![op]).revisions.is_empty());
}

#[test]
fn positions_reject_page_journal_and_missing_blocks() {
    let (_dir, mut nb) = fixture();
    for value in [1, 4, 999] {
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SetPosition {
                id: id(value),
                base_revision: 0,
                position: true
            }])),
            Err(Error::Validation { .. })
        ));
    }
    assert!(matches!(
        nb.positions(&PositionQuery::default()),
        Err(Error::Validation { .. })
    ));
}

#[test]
fn position_links_derive_holder_subject_and_follow_text_edits() {
    let (_dir, mut nb) = fixture();
    let op = set(&nb, 10, true);
    apply(&mut nb, vec![op]);
    assert_eq!(
        info(&nb, 10),
        PositionInfo {
            holder_id: Some(id(2)),
            subject_id: id(1)
        }
    );
    let receipt = edit(&mut nb, 10, &format!("[[{}]] on [[{}]]", id(2), id(3)));
    assert_eq!(info(&nb, 10).subject_id, id(3));
    assert_eq!(
        receipt
            .capabilities
            .iter()
            .find(|c| c.block_id == id(10))
            .unwrap()
            .position,
        Some(info(&nb, 10))
    );
    edit(&mut nb, 10, &format!("[[{}]] [[{}]]", id(2), id(11)));
    assert_eq!(info(&nb, 10).subject_id, id(11));
    edit(&mut nb, 10, &format!("[[{}]] [[{}]]", id(11), id(2)));
    assert_eq!(
        info(&nb, 10),
        PositionInfo {
            holder_id: None,
            subject_id: id(1)
        }
    );
    edit(
        &mut nb,
        10,
        &format!("[[{}]] [[{}]] [[{}]]", id(2), id(2), id(3)),
    );
    assert_eq!(info(&nb, 10).subject_id, id(1));
    edit(&mut nb, 10, &format!("[[{}]] [[{}]]", id(2), id(3)));
    archive(&mut nb, 3);
    assert_eq!(info(&nb, 10).subject_id, id(1));
    archive(&mut nb, 2);
    assert_eq!(info(&nb, 10).holder_id, None);
    edit(&mut nb, 10, "No links");
    assert_eq!(
        info(&nb, 10),
        PositionInfo {
            holder_id: None,
            subject_id: id(1)
        }
    );
}

#[test]
fn position_queries_filter_visibility_and_preserve_outline_order() {
    let (_dir, mut nb) = fixture();
    for value in [10, 11, 12, 13] {
        let op = set(&nb, value, true);
        apply(&mut nb, vec![op]);
    }
    let subject = PositionQuery {
        subject: Some(id(1)),
        ..PositionQuery::default()
    };
    let holder = PositionQuery {
        holder: Some(id(2)),
        ..PositionQuery::default()
    };
    assert_eq!(
        nb.positions(&subject)
            .unwrap()
            .iter()
            .map(|r| r.block.block.id.clone())
            .collect::<Vec<_>>(),
        [id(10), id(11), id(12), id(13)]
    );
    assert_eq!(nb.positions(&holder).unwrap().len(), 3);
    assert_eq!(
        nb.positions(&PositionQuery {
            limit: Some(1),
            ..holder.clone()
        })
        .unwrap()
        .len(),
        1
    );
    assert!(
        nb.positions(&PositionQuery {
            limit: Some(0),
            ..holder.clone()
        })
        .unwrap()
        .is_empty()
    );
    assert!(
        nb.positions(&PositionQuery {
            subject: Some(id(3)),
            ..holder.clone()
        })
        .unwrap()
        .is_empty()
    );
    archive(&mut nb, 10);
    archive(&mut nb, 11);
    for query in [&holder, &subject] {
        let rows = nb.positions(query).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].block.block.id, id(13));
    }
    let base_revision = nb.block(&id(13)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(13),
            base_revision,
        }],
    );
    assert!(nb.positions(&subject).unwrap().is_empty());
}
