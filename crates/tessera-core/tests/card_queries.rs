use tessera_core::scheduler::Grade;
use tessera_core::{
    Actor, Batch, CardQuery, CardQueryResult, CardSelection, Committed, Direction, Error,
    FieldKind, Filter, FilterOp, Notebook, Operation, Query, ReviewEventKind, SortBy, SortKey,
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: Some("card query regression".into()),
        idempotency_key: None,
        operations,
    }
}

fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&batch(operations)).unwrap()
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn child(value: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}

fn insert(value: u128, parent: u128, text: &str) -> Operation {
    child(value, &id(parent), text)
}

fn edit(nb: &mut Notebook, value: u128, text: &str) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::EditText {
            id: id(value),
            base_revision,
            text: text.into(),
        }],
    );
}

fn archive(nb: &mut Notebook, value: u128, archived: bool) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetArchived {
            id: id(value),
            base_revision,
            archived,
        }],
    );
}

fn delete(nb: &mut Notebook, value: u128) -> Operation {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    let receipt = apply(
        nb,
        vec![Operation::Delete {
            id: id(value),
            base_revision,
        }],
    );
    Operation::Restore {
        id: id(value),
        revision: receipt
            .revisions
            .iter()
            .find(|revision| revision.id == id(value))
            .unwrap()
            .revision,
        deletion_id: receipt.deletions[0].clone(),
    }
}

fn grade(nb: &mut Notebook, card_id: &str, event: u128, grade: Grade, reviewed_at: i64) {
    let card = nb.card(card_id).unwrap();
    apply(
        nb,
        vec![Operation::GradeCard {
            id: card.id,
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(event),
            session_id: None,
            grade,
            reset: false,
            shown_front: card.front,
            shown_back: card.back,
            reviewed_at,
        }],
    );
}

fn reset(nb: &mut Notebook, card_id: &str, event: u128, reviewed_at: i64) {
    let card = nb.card(card_id).unwrap();
    apply(
        nb,
        vec![Operation::ResetCard {
            id: card.id,
            base_revision: card.revision,
            event_id: id(event),
            session_id: None,
            reviewed_at,
        }],
    );
}

fn query(selection: CardSelection) -> CardQuery {
    CardQuery {
        selection,
        source: None,
        limit: None,
    }
}

fn source_query(text: &str) -> Query {
    Query {
        r#type: None,
        text: Some(text.into()),
        filters: vec![],
        sort: vec![],
        limit: None,
    }
}

fn card_ids(result: CardQueryResult) -> Vec<String> {
    result.rows.into_iter().map(|row| row.card.id).collect()
}

#[test]
fn each_unit_has_the_current_canonical_source_after_a_subtree_move() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Origin"),
            page(2, "Destination"),
            insert(10, 1, "branch"),
            insert(11, 10, "{{c1::one}} and {{c1::again}} with {{c2::two}}"),
            insert(12, 10, "front <> back"),
        ],
    );
    let original = nb.card_query(&query(CardSelection::All), 0).unwrap();
    let mut keys: Vec<_> = original
        .rows
        .iter()
        .map(|row| (row.card.source_block_id.clone(), row.card.key.clone()))
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            (id(11), "cloze:c1".into()),
            (id(11), "cloze:c2".into()),
            (id(12), "forward".into()),
            (id(12), "reverse".into()),
        ]
    );
    assert_eq!(original.total, 4);
    assert!(original.rows.iter().all(|row| row.last_review.is_none()));
    let revision = nb.block(&id(10)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Move {
            id: id(10),
            base_revision: revision,
            parent_id: id(2),
            after: None,
        }],
    );
    let moved = nb.card_query(&query(CardSelection::All), 0).unwrap();
    assert_eq!(card_ids(original), card_ids(moved.clone()));
    for row in moved.rows {
        assert_eq!(
            row.source.block,
            nb.block(&row.card.source_block_id).unwrap()
        );
        assert_eq!(row.source.page, nb.block(&id(2)).unwrap());
    }
    edit(&mut nb, 12, "plain text");
    let active = nb.card_query(&query(CardSelection::All), i64::MAX).unwrap();
    assert_eq!(active.total, 2);
    assert!(
        active
            .rows
            .iter()
            .all(|row| row.card.source_block_id == id(11))
    );
}

#[test]
fn due_boundary_and_new_selection_sort_reviewed_units_before_older_new_units() {
    const DAY: i64 = 86_400_000;
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cards"),
            insert(10, 1, "new >> answer"),
            insert(11, 1, "earlier >> answer"),
            insert(12, 1, "boundary >> answer"),
            insert(13, 1, "future >> answer"),
        ],
    );
    let new = nb.source_cards(&id(10)).unwrap().remove(0);
    let early = nb.source_cards(&id(11)).unwrap().remove(0);
    let boundary = nb.source_cards(&id(12)).unwrap().remove(0);
    let future = nb.source_cards(&id(13)).unwrap().remove(0);
    let interval = 2 * DAY;
    let now = new.schedule.due_at + interval + 2;
    grade(&mut nb, &early.id, 100, Grade::Good, now - interval - 1);
    grade(&mut nb, &boundary.id, 101, Grade::Good, now - interval);
    grade(&mut nb, &future.id, 102, Grade::Good, now - interval + 1);
    assert_eq!(nb.card(&boundary.id).unwrap().schedule.due_at, now);
    assert_eq!(nb.card(&future.id).unwrap().schedule.due_at, now + 1);

    let before = nb
        .card_query(&query(CardSelection::Due), new.schedule.due_at - 1)
        .unwrap();
    assert_eq!(before.total, 0);
    assert!(before.rows.is_empty());
    assert_eq!(
        card_ids(
            nb.card_query(&query(CardSelection::Due), new.schedule.due_at)
                .unwrap()
        ),
        vec![new.id.clone()]
    );
    assert_eq!(
        card_ids(
            nb.card_query(&query(CardSelection::New), new.schedule.due_at - 1)
                .unwrap()
        ),
        vec![new.id.clone()]
    );
    assert_eq!(
        card_ids(nb.card_query(&query(CardSelection::Due), now - 1).unwrap()),
        vec![early.id.clone(), new.id.clone()]
    );
    assert_eq!(
        card_ids(nb.card_query(&query(CardSelection::Due), now).unwrap()),
        vec![early.id.clone(), boundary.id.clone(), new.id.clone()]
    );
    assert_eq!(
        card_ids(nb.card_query(&query(CardSelection::All), now).unwrap()),
        vec![early.id.clone(), boundary.id, future.id, new.id]
    );

    let limited = CardQuery {
        limit: Some(1),
        ..query(CardSelection::Due)
    };
    let first = nb.card_query(&limited, now).unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(card_ids(first), vec![early.id]);
    let count_only = nb
        .card_query(
            &CardQuery {
                limit: Some(0),
                ..limited
            },
            now,
        )
        .unwrap();
    assert_eq!(count_only.total, 3);
    assert!(count_only.rows.is_empty());
}

#[test]
fn equal_due_times_use_card_id_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Cards"), insert(10, 1, "front <> back")],
    );
    let mut cards = nb.source_cards(&id(10)).unwrap();
    cards.sort_by(|a, b| a.id.cmp(&b.id));
    // Grade in reverse ID order: neither insertion nor review order breaks ties.
    grade(&mut nb, &cards[1].id, 100, Grade::Good, 1_000);
    grade(&mut nb, &cards[0].id, 101, Grade::Good, 1_000);
    let due_at = nb.card(&cards[0].id).unwrap().schedule.due_at;
    let result = nb.card_query(&query(CardSelection::Due), due_at).unwrap();
    assert_eq!(
        card_ids(result),
        cards.into_iter().map(|card| card.id).collect::<Vec<_>>()
    );
}

#[test]
fn hidden_ancestry_and_deleted_pages_restore_the_same_scheduled_units() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cards"),
            page(2, "Visible"),
            insert(10, 1, "branch"),
            insert(11, 10, "nested >> answer"),
            insert(20, 2, "visible >> answer"),
        ],
    );
    let nested = nb.source_cards(&id(11)).unwrap().remove(0);
    let visible = nb.source_cards(&id(20)).unwrap().remove(0);
    grade(&mut nb, &nested.id, 100, Grade::Good, 1_000);
    let scheduled = nb.card(&nested.id).unwrap();
    let all = query(CardSelection::All);
    archive(&mut nb, 10, true);
    assert!(!nb.block(&id(11)).unwrap().archived);
    assert_eq!(
        card_ids(nb.card_query(&all, i64::MAX).unwrap()),
        vec![visible.id.clone()]
    );
    let restore = delete(&mut nb, 10);
    assert_eq!(
        card_ids(nb.card_query(&all, i64::MAX).unwrap()),
        vec![visible.id.clone()]
    );
    apply(&mut nb, vec![restore]);
    assert_eq!(
        card_ids(nb.card_query(&all, i64::MAX).unwrap()),
        vec![visible.id.clone()]
    );
    archive(&mut nb, 10, false);
    let restored = nb.card_query(&all, i64::MAX).unwrap();
    assert_eq!(restored.total, 2);
    assert_eq!(restored.rows[0].card, scheduled);
    assert_eq!(restored.rows[0].last_review.as_ref().unwrap().id, id(100));

    archive(&mut nb, 1, true);
    assert_eq!(
        card_ids(nb.card_query(&all, i64::MAX).unwrap()),
        vec![visible.id.clone()]
    );
    archive(&mut nb, 1, false);
    let restore_page = delete(&mut nb, 1);
    assert_eq!(
        card_ids(nb.card_query(&all, i64::MAX).unwrap()),
        vec![visible.id.clone()]
    );
    apply(&mut nb, vec![restore_page]);
    let restored = nb.card_query(&query(CardSelection::Due), i64::MAX).unwrap();
    assert_eq!(restored.rows[0].card, scheduled);
    assert_eq!(restored.rows[0].source.page, nb.block(&id(1)).unwrap());
    assert_eq!(card_ids(restored), vec![nested.id, visible.id]);
}

#[test]
fn latest_shown_grade_ignores_resets_and_breaks_timestamp_ties_by_insertion() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cards"),
            insert(10, 1, "first >> answer"),
            insert(11, 1, "never >> graded"),
        ],
    );
    let card = nb.source_cards(&id(10)).unwrap().remove(0);
    let ungraded = nb.source_cards(&id(11)).unwrap().remove(0);
    // A single batch ties both event and commit timestamps, independent of clock speed.
    let grades = [(900, Grade::Good), (800, Grade::Hard)]
        .into_iter()
        .enumerate()
        .map(|(offset, (event, grade))| Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision + offset as i64,
            definition_revision: card.definition_revision,
            event_id: id(event),
            session_id: None,
            grade,
            reset: false,
            shown_front: card.front.clone(),
            shown_back: card.back.clone(),
            reviewed_at: 1_000,
        })
        .collect();
    apply(&mut nb, grades);
    reset(&mut nb, &card.id, 700, 1_001);
    reset(&mut nb, &ungraded.id, 600, 1_001);
    edit(&mut nb, 10, "current >> definition");
    let rows = nb
        .card_query(&query(CardSelection::New), 1_001)
        .unwrap()
        .rows;
    let reviewed = rows.iter().find(|row| row.card.id == card.id).unwrap();
    let last = reviewed.last_review.as_ref().unwrap();
    assert_eq!(last.id, id(800));
    assert_eq!(last.kind, ReviewEventKind::Grade);
    assert_eq!(last.grade, Some(Grade::Hard));
    assert_eq!(last.shown_front, "first");
    assert_eq!(last.shown_back, "answer");
    assert!(last.definition_revision < reviewed.card.definition_revision);
    assert_eq!(reviewed.card.front, "current");
    assert_eq!(reviewed.card.back, "definition");
    let tessera_core::ReviewSchedulingState::Fsrs(after) = &last.after else {
        panic!("new evidence must use FSRS");
    };
    assert_eq!(after.last_reviewed_at, Some(1_000));
    assert_eq!(reviewed.card.schedule.last_reviewed_at, None);
    assert!(
        rows.iter()
            .find(|row| row.card.id == ungraded.id)
            .unwrap()
            .last_review
            .is_none()
    );
}

#[test]
fn source_limits_do_not_preempt_card_selection_or_outer_totals() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cards"),
            insert(10, 1, "A selector without a card"),
            insert(11, 1, "B selector >> future"),
            insert(12, 1, "C selector >> chosen"),
            insert(13, 1, "D selector <> chosen"),
            insert(14, 1, "unrelated >> answer"),
        ],
    );
    let future = nb.source_cards(&id(11)).unwrap().remove(0);
    let now = future.schedule.due_at;
    grade(&mut nb, &future.id, 100, Grade::Good, now);
    let mut source = source_query("selector");
    source.limit = Some(1);
    source.sort = vec![SortKey {
        by: SortBy::Title,
        field: None,
        direction: Direction::Asc,
    }];
    assert_eq!(nb.query(&source).unwrap().rows[0].block.block.id, id(10));
    let mut filtered = CardQuery {
        source: Some(source),
        selection: CardSelection::Due,
        limit: Some(2),
    };
    let result = nb.card_query(&filtered, now).unwrap();
    assert_eq!(result.total, 3);
    assert_eq!(result.rows.len(), 2);
    assert!(
        result
            .rows
            .iter()
            .all(|row| [id(12), id(13)].contains(&row.source.block.id))
    );
    filtered.source.as_mut().unwrap().limit = Some(0);
    filtered.limit = Some(2000);
    let mut expected = nb.source_cards(&id(12)).unwrap();
    expected.extend(nb.source_cards(&id(13)).unwrap());
    expected.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(
        card_ids(nb.card_query(&filtered, now).unwrap()),
        expected.into_iter().map(|card| card.id).collect::<Vec<_>>()
    );
    filtered.source.as_mut().unwrap().text = Some("absent".into());
    let absent = nb.card_query(&filtered, now).unwrap();
    assert_eq!(absent.total, 0);
    assert!(absent.rows.is_empty());
}

#[test]
fn saved_decks_round_trip_full_source_filters_revisions_and_executable_selection() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Study"),
            child(3, &fields, "Score"),
            insert(10, 1, "selected first >> answer"),
            insert(11, 10, &format!("[[{}]]", id(3))),
            insert(12, 11, "9"),
            insert(20, 1, "selected second >> answer"),
            insert(21, 20, &format!("[[{}]]", id(3))),
            insert(22, 21, "10"),
            insert(30, 1, "selected excluded >> answer"),
            insert(31, 30, &format!("[[{}]]", id(3))),
            insert(32, 31, "2"),
        ],
    );
    let mut operations = vec![Operation::SetFieldKind {
        id: id(3),
        base_revision: 1,
        kind: FieldKind::Number,
    }];
    operations.extend([10, 20, 30].into_iter().map(|value| Operation::AddType {
        id: id(value),
        base_revision: 1,
        title: "Study".into(),
    }));
    apply(&mut nb, operations);
    let selected = CardQuery {
        source: Some(Query {
            r#type: Some(id(2)),
            text: Some("selected".into()),
            filters: vec![Filter {
                field: id(3),
                op: FilterOp::Gt,
                value: Some("2".into()),
            }],
            sort: vec![SortKey {
                by: SortBy::Field,
                field: Some(id(3)),
                direction: Direction::Desc,
            }],
            limit: Some(1),
        }),
        selection: CardSelection::All,
        limit: Some(1),
    };
    apply(
        &mut nb,
        vec![Operation::SaveDeck {
            id: id(100),
            base_revision: None,
            name: "Study cards".into(),
            query: selected.clone(),
        }],
    );
    let original = nb.deck(&id(100)).unwrap();
    assert_eq!(original.revision, 1);
    let before = nb.card_query(&original.query, 0).unwrap();
    assert_eq!(before.total, 2);
    let first = nb.source_cards(&id(10)).unwrap().remove(0);
    grade(&mut nb, &first.id, 500, Grade::Good, 1_000);
    let updated = CardQuery {
        selection: CardSelection::New,
        ..selected
    };
    apply(
        &mut nb,
        vec![
            Operation::SaveDeck {
                id: id(100),
                base_revision: Some(1),
                name: "New study cards".into(),
                query: updated.clone(),
            },
            Operation::SaveDeck {
                id: id(101),
                base_revision: None,
                name: "alpha".into(),
                query: query(CardSelection::All),
            },
        ],
    );
    let saved = nb.deck(&id(100)).unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.created_at, original.created_at);
    drop(nb);

    let nb = Notebook::open(dir.path()).unwrap();
    let loaded = nb.deck(&id(100)).unwrap();
    assert_eq!(loaded, saved);
    assert_eq!(loaded.query, updated);
    assert_eq!(
        nb.decks()
            .unwrap()
            .into_iter()
            .map(|deck| deck.id)
            .collect::<Vec<_>>(),
        vec![id(101), id(100)]
    );
    let result = nb.card_query(&loaded.query, 0).unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.rows[0].source.block.id, id(20));
    assert_eq!(result.rows[0].source.page.id, id(1));
    assert!(matches!(nb.deck(&id(999)), Err(Error::NotFound { .. })));
    assert!(matches!(nb.deck("invalid"), Err(Error::Validation { .. })));
}

#[test]
fn invalid_limits_and_source_inputs_are_rejected_on_reads_and_saves() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Archived type"), insert(10, 1, "not a type")],
    );
    archive(&mut nb, 1, true);
    let mut invalid = vec![CardQuery {
        limit: Some(2001),
        ..query(CardSelection::All)
    }];
    let mut empty = source_query("text");
    empty.text = None;
    let mut oversized = source_query("text");
    oversized.limit = Some(2001);
    let mut missing_field = source_query("text");
    missing_field.filters = vec![Filter {
        field: id(999),
        op: FilterOp::Present,
        value: None,
    }];
    let mut missing_sort_field = source_query("text");
    missing_sort_field.sort = vec![SortKey {
        by: SortBy::Field,
        field: None,
        direction: Direction::Asc,
    }];
    for source in [empty, oversized, missing_field, missing_sort_field] {
        invalid.push(CardQuery {
            source: Some(source),
            ..query(CardSelection::All)
        });
    }
    for type_id in [id(1), id(10), id(999), "invalid".into()] {
        let mut source = source_query("text");
        source.r#type = Some(type_id);
        invalid.push(CardQuery {
            source: Some(source),
            ..query(CardSelection::All)
        });
    }
    for query in invalid {
        assert!(matches!(
            nb.card_query(&query, 0),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SaveDeck {
                id: id(100),
                base_revision: None,
                name: "Invalid".into(),
                query,
            }])),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(nb.deck(&id(100)), Err(Error::NotFound { .. })));
    }
    let maximum = nb
        .card_query(
            &CardQuery {
                limit: Some(2000),
                ..query(CardSelection::All)
            },
            0,
        )
        .unwrap();
    assert_eq!(maximum.total, 0);
    assert!(maximum.rows.is_empty());
}
