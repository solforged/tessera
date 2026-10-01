use tessera_core::{Actor, Batch, BlockKind, Committed, Error, Notebook, Operation};

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
fn apply(notebook: &mut Notebook, operations: Vec<Operation>) -> Committed {
    notebook.apply(&batch(operations)).unwrap()
}
fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
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
fn edit(value: u128, revision: i64, text: &str) -> Operation {
    Operation::EditText {
        id: id(value),
        base_revision: revision,
        text: text.into(),
    }
}
fn moving(value: u128, revision: i64, parent: u128, after: Option<u128>) -> Operation {
    Operation::Move {
        id: id(value),
        base_revision: revision,
        parent_id: id(parent),
        after: after.map(id),
    }
}
fn deleted(value: u128, revision: i64) -> Operation {
    Operation::Delete {
        id: id(value),
        base_revision: revision,
    }
}
fn restore(value: u128, revision: i64, deletion: &str) -> Operation {
    Operation::Restore {
        id: id(value),
        deletion_id: deletion.into(),
        revision,
    }
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let notebook = Notebook::open(dir.path()).unwrap();
    (dir, notebook)
}
fn rows(notebook: &Notebook, root: u128) -> Vec<(String, u32, String)> {
    notebook
        .page(&id(root))
        .unwrap()
        .rows
        .into_iter()
        .map(|row| (row.block.id, row.depth, row.block.text))
        .collect()
}

#[test]
fn identity_survives_edit_split_merge_and_inverse_batches() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "leftright"),
            insert(11, 10, None, "child"),
        ],
    );
    apply(&mut nb, vec![edit(10, 1, "leftRIGHT")]);
    assert_eq!(nb.block(&id(10)).unwrap().id, id(10));
    apply(&mut nb, vec![edit(10, 2, "leftright")]);
    apply(
        &mut nb,
        vec![Operation::Split {
            id: id(10),
            base_revision: 3,
            new_id: id(12),
            left: "left".into(),
            right: "right".into(),
        }],
    );
    assert_eq!(
        rows(&nb, 1),
        vec![
            (id(10), 0, "left".into()),
            (id(11), 1, "child".into()),
            (id(12), 0, "right".into())
        ]
    );
    let merge = apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(12),
            source_revision: 1,
            destination_id: id(10),
            destination_revision: 4,
        }],
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "leftright");
    assert_eq!(nb.block(&id(10)).unwrap().id, id(10));
    apply(
        &mut nb,
        vec![restore(12, 2, &merge.deletions[0]), edit(10, 5, "left")],
    );
    assert_eq!(
        rows(&nb, 1),
        vec![
            (id(10), 0, "left".into()),
            (id(11), 1, "child".into()),
            (id(12), 0, "right".into())
        ]
    );
    apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(12),
            source_revision: 3,
            destination_id: id(10),
            destination_revision: 6,
        }],
    );
    assert_eq!(
        rows(&nb, 1),
        vec![(id(10), 0, "leftright".into()), (id(11), 1, "child".into())]
    );
}

#[test]
fn cross_page_move_updates_subtree_and_inverse_keeps_ids() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "One"),
            page(2, "Two"),
            insert(10, 1, None, "parent"),
            insert(11, 10, None, "child"),
            insert(12, 11, None, "grandchild"),
        ],
    );
    let moved = apply(&mut nb, vec![moving(10, 1, 2, None)]);
    assert_eq!(
        moved
            .revisions
            .iter()
            .map(|revision| (revision.id.clone(), revision.revision))
            .collect::<Vec<_>>(),
        vec![(id(10), 2), (id(11), 2), (id(12), 2)]
    );
    assert!(rows(&nb, 1).is_empty());
    for value in [10, 11, 12] {
        assert_eq!(nb.block(&id(value)).unwrap().page_id, id(2));
    }
    apply(&mut nb, vec![moving(10, 2, 1, None)]);
    assert_eq!(
        rows(&nb, 1)
            .iter()
            .map(|(id, depth, _)| (id.clone(), *depth))
            .collect::<Vec<_>>(),
        vec![(id(10), 0), (id(11), 1), (id(12), 2)]
    );
    apply(&mut nb, vec![moving(12, 3, 10, Some(11))]);
    assert_eq!(nb.block(&id(12)).unwrap().revision, 4);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 3);
}

#[test]
fn stale_operation_anywhere_rolls_back_data_indexes_and_history() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "original"),
            insert(11, 1, Some(10), "second"),
        ],
    );
    let before = nb.page(&id(1)).unwrap();
    for stale_index in 0..3 {
        let mut operations = vec![
            edit(10, 1, "changedtoken"),
            insert(20, 1, Some(11), "newtoken"),
            edit(11, 1, "changed second"),
        ];
        operations[stale_index] = edit(11, 99, "stale");
        let error = nb.apply(&batch(operations)).unwrap_err();
        assert!(
            matches!(error, Error::Conflict { op_index, expected: 99, found: Some(1), .. } if op_index == stale_index)
        );
        assert_eq!(nb.page(&id(1)).unwrap(), before);
        assert!(nb.search("changedtoken", 10).unwrap().is_empty());
        assert_eq!(nb.changes_since(0, 10).unwrap().len(), 1);
    }
}

#[test]
fn delete_restore_is_exact_and_preserves_archive_and_separate_deletions() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "parent"),
            insert(11, 10, None, "archived"),
            insert(12, 10, Some(11), "separate"),
        ],
    );
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(11),
            base_revision: 1,
            archived: true,
        }],
    );
    assert!(nb.page(&id(1)).unwrap().rows[1].block.archived);
    let separate = apply(&mut nb, vec![deleted(12, 1)]);
    let deletion = apply(&mut nb, vec![deleted(10, 1)]);
    assert!(rows(&nb, 1).is_empty());
    assert!(matches!(
        nb.apply(&batch(vec![restore(10, 1, &deletion.deletions[0])]))
            .unwrap_err(),
        Error::Conflict { found: Some(2), .. }
    ));
    assert!(matches!(
        nb.apply(&batch(vec![restore(10, 2, &separate.deletions[0])]))
            .unwrap_err(),
        Error::Validation {
            op_index: Some(0),
            ..
        }
    ));
    assert!(matches!(
        nb.apply(&batch(vec![restore(11, 3, &deletion.deletions[0])]))
            .unwrap_err(),
        Error::NotFound {
            op_index: Some(0),
            ..
        }
    ));
    assert!(matches!(
        nb.apply(&batch(vec![insert(20, 10, None, "forbidden")]))
            .unwrap_err(),
        Error::NotFound {
            op_index: Some(0),
            ..
        }
    ));
    apply(&mut nb, vec![restore(10, 2, &deletion.deletions[0])]);
    assert_eq!(
        rows(&nb, 1),
        vec![(id(10), 0, "parent".into()), (id(11), 1, "archived".into())]
    );
    assert!(nb.block(&id(11)).unwrap().archived);
    assert_eq!(nb.block(&id(11)).unwrap().revision, 4);
    assert!(nb.block(&id(12)).is_err());
    apply(&mut nb, vec![restore(12, 2, &separate.deletions[0])]);
    assert_eq!(nb.block(&id(12)).unwrap().id, id(12));
}

#[test]
fn restored_parent_can_enable_later_restore_in_same_batch() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "parent"),
            insert(11, 10, None, "child"),
        ],
    );
    let child = apply(&mut nb, vec![deleted(11, 1)]);
    let parent = apply(&mut nb, vec![deleted(10, 1)]);
    apply(
        &mut nb,
        vec![
            restore(10, 2, &parent.deletions[0]),
            restore(11, 2, &child.deletions[0]),
        ],
    );
    assert_eq!(
        rows(&nb, 1),
        vec![(id(10), 0, "parent".into()), (id(11), 1, "child".into())]
    );
}

#[test]
fn references_follow_current_targets_and_backlinks_not_copies() {
    let (dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Source"),
            page(2, "Target"),
            insert(20, 2, None, "original"),
            insert(10, 1, None, &format!("[[{}]] [[{}|alias]]", id(20), id(20))),
        ],
    );
    assert_eq!(nb.page(&id(1)).unwrap().targets[0].text, "original");
    assert_eq!(nb.backlinks(&id(20), 10).unwrap().len(), 1);
    let conn = rusqlite::Connection::open(dir.path().join("notebook.db")).unwrap();
    let links = conn
        .prepare("SELECT occurrence, alias FROM links WHERE source_id = ?1 ORDER BY occurrence")
        .unwrap()
        .query_map([id(10)], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(links, vec![(0, None), (1, Some("alias".into()))]);
    apply(&mut nb, vec![edit(20, 1, "current")]);
    assert_eq!(nb.page(&id(1)).unwrap().targets[0].text, "current");
    let deletion = apply(&mut nb, vec![deleted(20, 2)]);
    assert!(nb.page(&id(1)).unwrap().targets.is_empty());
    assert!(nb.backlinks(&id(20), 10).unwrap().is_empty());
    assert!(nb.block(&id(10)).unwrap().text.contains(&id(20)));
    apply(&mut nb, vec![restore(20, 3, &deletion.deletions[0])]);
    assert_eq!(nb.page(&id(1)).unwrap().targets[0].text, "current");
    assert_eq!(nb.backlinks(&id(20), 10).unwrap()[0].source.id, id(10));
    apply(&mut nb, vec![edit(10, 1, "no references")]);
    assert!(nb.backlinks(&id(20), 10).unwrap().is_empty());
}

#[test]
fn agents_receive_identical_conflicts_validation_and_attribution() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![page(1, "Work"), insert(10, 1, None, "original")],
    );
    let mut request = batch(vec![edit(10, 1, "agent text")]);
    request.actor = Actor::Agent {
        name: "researcher".into(),
    };
    request.reason = Some("source extraction".into());
    let result = nb.apply(&request).unwrap();
    let changes = nb.changes_since(result.seq - 1, 1).unwrap();
    assert_eq!(changes[0].actor, request.actor);
    assert_eq!(changes[0].reason, request.reason);
    assert_eq!(changes[0].revisions, result.revisions);
    assert!(matches!(
        nb.apply(&request).unwrap_err(),
        Error::Conflict {
            op_index: 0,
            found: Some(2),
            ..
        }
    ));
    request.operations = vec![moving(10, 2, 10, None)];
    assert!(matches!(
        nb.apply(&request).unwrap_err(),
        Error::Validation {
            op_index: Some(0),
            ..
        }
    ));
}

#[test]
fn idempotent_replay_survives_reopen_and_mismatch_is_rejected() {
    let (dir, mut nb) = fixture();
    let mut request = batch(vec![page(1, "Work"), insert(10, 1, None, "text")]);
    request.idempotency_key = Some("request-1".into());
    let first = nb.apply(&request).unwrap();
    drop(nb);
    let mut nb = Notebook::open(dir.path()).unwrap();
    request.actor = Actor::Agent {
        name: "retry".into(),
    };
    let replay = nb.apply(&request).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.seq, first.seq);
    assert_eq!(replay.revisions, first.revisions);
    assert_eq!(nb.changes_since(0, 10).unwrap().len(), 1);
    request.operations.push(edit(10, 1, "different"));
    assert!(matches!(
        nb.apply(&request).unwrap_err(),
        Error::Validation { .. }
    ));
    assert_eq!(nb.block(&id(10)).unwrap().text, "text");
}

#[test]
fn unicode_titles_and_calendar_dates_are_unique_among_live_roots() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![page(1, "ÄRGER"), page(2, "Other")]);
    assert!(matches!(
        nb.apply(&batch(vec![page(3, "ärger")])).unwrap_err(),
        Error::Validation {
            op_index: Some(0),
            ..
        }
    ));
    assert!(nb.apply(&batch(vec![edit(2, 1, "ärger")])).is_err());
    assert!(nb.apply(&batch(vec![page(3, " \n ")])).is_err());
    let deletion = apply(&mut nb, vec![deleted(1, 1)]);
    apply(&mut nb, vec![page(3, "ärger")]);
    assert!(
        nb.apply(&batch(vec![restore(1, 2, &deletion.deletions[0])]))
            .is_err()
    );
    assert!(nb.block(&id(1)).is_err());
    apply(
        &mut nb,
        vec![Operation::CreateJournal {
            id: id(4),
            date: "2024-02-29".into(),
        }],
    );
    assert_eq!(
        nb.journal("2024-02-29").unwrap().unwrap().kind,
        BlockKind::Journal
    );
    for invalid in [
        "2023-02-29",
        "2024-13-01",
        "2024-04-31",
        "0000-01-01",
        "2024-2-01",
        "abcd-ef-gh",
    ] {
        assert!(
            nb.apply(&batch(vec![Operation::CreateJournal {
                id: id(5),
                date: invalid.into()
            }]))
            .is_err()
        );
        assert!(nb.journal(invalid).is_err());
    }
    assert!(
        nb.apply(&batch(vec![Operation::CreateJournal {
            id: id(5),
            date: "2024-02-29".into()
        }]))
        .is_err()
    );
    apply(
        &mut nb,
        vec![Operation::CreateJournal {
            id: id(5),
            date: "2025-01-01".into(),
        }],
    );
    assert_eq!(
        nb.roots()
            .unwrap()
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(2), id(3), id(5), id(4)]
    );
}

#[test]
fn validation_rejects_cycles_bad_ids_headings_splits_and_root_merges_atomically() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "text"),
            insert(11, 10, None, "child"),
        ],
    );
    let before = nb.page(&id(1)).unwrap();
    let invalid = vec![
        moving(10, 1, 11, None),
        Operation::SetHeading {
            id: id(10),
            base_revision: 1,
            heading: Some(4),
        },
        Operation::Split {
            id: id(10),
            base_revision: 1,
            new_id: id(20),
            left: "te".into(),
            right: "wrong".into(),
        },
        Operation::Merge {
            source_id: id(1),
            source_revision: 1,
            destination_id: id(10),
            destination_revision: 1,
        },
        Operation::Merge {
            source_id: id(10),
            source_revision: 1,
            destination_id: id(11),
            destination_revision: 1,
        },
        insert(10, 1, None, "reuse"),
        Operation::Insert {
            id: "not-ulid".into(),
            parent_id: id(1),
            after: None,
            text: String::new(),
            heading: None,
        },
        moving(10, 1, 1, Some(10)),
        insert(20, 1, Some(11), "wrong sibling"),
    ];
    for operation in invalid {
        assert!(matches!(
            nb.apply(&batch(vec![operation])).unwrap_err(),
            Error::Validation {
                op_index: Some(0),
                ..
            }
        ));
        assert_eq!(nb.page(&id(1)).unwrap(), before);
    }
}

#[test]
fn fts_and_completion_follow_edits_deletion_and_restore() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Äpfel"),
            page(2, "Other"),
            insert(10, 2, None, "äp extra searchable"),
            insert(11, 2, Some(10), "needle token"),
        ],
    );
    assert_eq!(
        nb.complete("ÄP", 2)
            .unwrap()
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(1), id(10)]
    );
    assert_eq!(nb.search("need", 10).unwrap()[0].block.id, id(11));
    assert_eq!(nb.search("needle tok", 10).unwrap()[0].page.id, id(2));
    assert!(nb.search("\" OR *", 10).unwrap().is_empty());
    apply(&mut nb, vec![edit(11, 1, "replacement")]);
    assert!(nb.search("needle", 10).unwrap().is_empty());
    assert_eq!(nb.search("replace", 10).unwrap()[0].block.id, id(11));
    let deletion = apply(&mut nb, vec![deleted(11, 2)]);
    assert!(nb.search("replace", 10).unwrap().is_empty());
    apply(&mut nb, vec![restore(11, 3, &deletion.deletions[0])]);
    assert_eq!(nb.search("replace", 10).unwrap()[0].block.id, id(11));
    assert!(nb.complete("anything", 0).unwrap().is_empty());
}

#[test]
fn sparse_order_rebalances_only_one_list_without_invalidating_siblings() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            page(2, "Other"),
            insert(10, 1, None, "first"),
            insert(11, 1, Some(10), "last"),
            insert(12, 2, None, "unrelated"),
        ],
    );
    for value in 20..60 {
        apply(&mut nb, vec![insert(value, 1, Some(10), "between")]);
    }
    let actual: Vec<_> = rows(&nb, 1).into_iter().map(|row| row.0).collect();
    let expected: Vec<_> = std::iter::once(id(10))
        .chain((20..60).rev().map(id))
        .chain(std::iter::once(id(11)))
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    assert_eq!(nb.block(&id(11)).unwrap().revision, 1);
    assert_eq!(nb.block(&id(12)).unwrap().revision, 1);
}

#[test]
fn merge_appends_children_and_cross_page_context_and_can_be_inverted() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "One"),
            page(2, "Two"),
            insert(10, 1, None, "left"),
            insert(11, 10, None, "existing"),
            insert(20, 2, None, "right"),
            insert(21, 20, None, "appended"),
            insert(22, 21, None, "descendant"),
        ],
    );
    let result = apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(20),
            source_revision: 1,
            destination_id: id(10),
            destination_revision: 1,
        }],
    );
    assert_eq!(
        rows(&nb, 1),
        vec![
            (id(10), 0, "leftright".into()),
            (id(11), 1, "existing".into()),
            (id(21), 1, "appended".into()),
            (id(22), 2, "descendant".into())
        ]
    );
    assert!(rows(&nb, 2).is_empty());
    assert_eq!(nb.block(&id(22)).unwrap().page_id, id(1));
    apply(
        &mut nb,
        vec![
            restore(20, 2, &result.deletions[0]),
            moving(21, 2, 20, None),
            edit(10, 2, "left"),
        ],
    );
    assert_eq!(
        rows(&nb, 2),
        vec![
            (id(20), 0, "right".into()),
            (id(21), 1, "appended".into()),
            (id(22), 2, "descendant".into())
        ]
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "left");
}

#[test]
fn no_op_changes_do_not_bump_block_revisions_and_history_pages_by_change() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![page(1, "Work"), insert(10, 1, None, "text")]);
    let no_op = apply(
        &mut nb,
        vec![
            edit(10, 1, "text"),
            Operation::SetHeading {
                id: id(10),
                base_revision: 1,
                heading: None,
            },
            Operation::SetArchived {
                id: id(10),
                base_revision: 1,
                archived: false,
            },
            moving(10, 1, 1, None),
        ],
    );
    assert!(no_op.revisions.is_empty());
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    let changes = nb.changes_since(0, 1).unwrap();
    assert_eq!(changes[0].revisions.len(), 2);
    assert_eq!(
        nb.changes_since(changes[0].seq, 1).unwrap()[0].seq,
        no_op.seq
    );
    assert!(nb.changes_since(no_op.seq, 10).unwrap().is_empty());
}

#[test]
fn restored_siblings_keep_order_without_colliding_with_intervening_insertions() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "Work"),
            insert(10, 1, None, "first"),
            insert(11, 1, Some(10), "last"),
        ],
    );
    let deletion = apply(&mut nb, vec![deleted(10, 1)]);
    apply(
        &mut nb,
        vec![
            insert(20, 1, None, "new first"),
            restore(10, 2, &deletion.deletions[0]),
            insert(21, 1, Some(20), "after new first"),
        ],
    );
    assert_eq!(
        rows(&nb, 1)
            .into_iter()
            .map(|row| row.0)
            .collect::<Vec<_>>(),
        vec![id(20), id(21), id(10), id(11)]
    );
    for value in 30..70 {
        apply(
            &mut nb,
            vec![insert(value, 1, Some(10), "between restored and last")],
        );
    }
    let order = rows(&nb, 1)
        .into_iter()
        .map(|row| row.0)
        .collect::<Vec<_>>();
    assert_eq!(&order[..3], &[id(20), id(21), id(10)]);
    assert_eq!(order.last(), Some(&id(11)));
}

#[test]
fn moving_a_live_subtree_keeps_separately_deleted_descendants_in_its_page() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            page(1, "One"),
            page(2, "Two"),
            insert(10, 1, None, "parent"),
            insert(11, 10, None, "child"),
        ],
    );
    let deletion = apply(&mut nb, vec![deleted(11, 1)]);
    let moved = apply(&mut nb, vec![moving(10, 1, 2, None)]);
    assert_eq!(
        moved
            .revisions
            .iter()
            .find(|revision| revision.id == id(11))
            .unwrap()
            .revision,
        3
    );
    assert!(
        nb.apply(&batch(vec![restore(11, 2, &deletion.deletions[0])]))
            .is_err()
    );
    apply(&mut nb, vec![restore(11, 3, &deletion.deletions[0])]);
    assert_eq!(nb.block(&id(11)).unwrap().page_id, id(2));
    assert_eq!(
        rows(&nb, 2),
        vec![(id(10), 0, "parent".into()), (id(11), 1, "child".into())]
    );
}

#[test]
fn ranked_query_limits_break_score_ties_by_id_not_insertion_order() {
    let (_dir, mut nb) = fixture();
    let mut operations = vec![page(1, "Work")];
    operations.extend(
        (10..40)
            .rev()
            .map(|value| insert(value, 1, None, "cobalt equal ranking")),
    );
    apply(&mut nb, operations);
    let expected: Vec<_> = (10..15).map(id).collect();
    assert_eq!(
        nb.complete("cobalt", 5)
            .unwrap()
            .into_iter()
            .map(|block| block.id)
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        nb.search("cobalt", 5)
            .unwrap()
            .into_iter()
            .map(|hit| hit.block.id)
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        nb.complete("", 5)
            .unwrap()
            .into_iter()
            .map(|block| block.id)
            .collect::<Vec<_>>(),
        vec![id(1)]
    );
}
