use tessera_core::card_text::CardKind;
use tessera_core::scheduler::{Grade, schedule};
use tessera_core::{
    Actor, Batch, CardQuery, CardSelection, CardUnit, Committed, Error, Notebook, Operation,
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

fn insert(value: u128, parent: u128, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: None,
        text: text.into(),
        heading: None,
    }
}

fn fixture(text: &str) -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Cards".into(),
            },
            insert(10, 1, text),
        ],
    );
    (dir, nb)
}

fn edit(nb: &mut Notebook, source: u128, text: &str) -> Committed {
    let revision = nb.block(&id(source)).unwrap().revision;
    apply(
        nb,
        vec![Operation::EditText {
            id: id(source),
            base_revision: revision,
            text: text.into(),
        }],
    )
}

fn unit(nb: &Notebook, source: u128, key: &str) -> CardUnit {
    nb.source_cards(&id(source))
        .unwrap()
        .into_iter()
        .find(|card| card.key == key)
        .unwrap()
}

fn grade(nb: &mut Notebook, source: u128, key: &str, event: u128) -> CardUnit {
    let card = unit(nb, source, key);
    let reviewed_at = card.schedule.due_at + 1_000;
    apply(
        nb,
        vec![Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(event),
            session_id: None,
            grade: Grade::Good,
            reset: false,
            shown_front: card.front.clone(),
            shown_back: card.back.clone(),
            reviewed_at,
        }],
    );
    let reviewed = nb.card(&card.id).unwrap();
    assert_eq!(
        reviewed.schedule,
        schedule(&card.schedule, Grade::Good, reviewed_at)
    );
    reviewed
}

fn visible_ids(nb: &Notebook) -> Vec<String> {
    nb.card_query(
        &CardQuery {
            source: None,
            selection: CardSelection::All,
            limit: None,
        },
        i64::MAX,
    )
    .unwrap()
    .rows
    .into_iter()
    .map(|row| row.card.id)
    .collect()
}

fn split(nb: &Notebook, source: u128, new: u128, left: &str, right: &str) -> Operation {
    Operation::Split {
        id: id(source),
        base_revision: nb.block(&id(source)).unwrap().revision,
        new_id: id(new),
        left: left.into(),
        right: right.into(),
    }
}

fn merge(nb: &Notebook, source: u128, destination: u128) -> Operation {
    Operation::Merge {
        source_id: id(source),
        source_revision: nb.block(&id(source)).unwrap().revision,
        destination_id: id(destination),
        destination_revision: nb.block(&id(destination)).unwrap().revision,
    }
}

#[test]
fn unicode_wording_and_direction_changes_keep_role_identity_and_progress() {
    let (_dir, mut nb) = fixture("東京>>日本");
    let original = unit(&nb, 10, "forward");
    assert_eq!((&*original.front, &*original.back), ("東京", "日本"));
    assert_eq!(original.kind, CardKind::Forward);
    let reviewed = grade(&mut nb, 10, "forward", 100);

    edit(&mut nb, 10, "京都 >> 日本の古都");
    let edited = unit(&nb, 10, "forward");
    assert_eq!(edited.id, original.id);
    assert_eq!(edited.schedule, reviewed.schedule);
    assert_eq!(edited.revision, reviewed.revision + 1);
    assert_eq!(edited.definition_revision, reviewed.definition_revision + 1);
    assert_eq!((&*edited.front, &*edited.back), ("京都", "日本の古都"));

    edit(&mut nb, 10, "京都<>日本の古都");
    assert_eq!(unit(&nb, 10, "forward"), edited);
    let reverse = grade(&mut nb, 10, "reverse", 101);
    assert_eq!(reverse.kind, CardKind::Reverse);
    assert_eq!((&*reverse.front, &*reverse.back), ("日本の古都", "京都"));
    assert_ne!(reverse.id, edited.id);

    edit(&mut nb, 10, "京都<<日本の古都");
    assert_eq!(unit(&nb, 10, "reverse"), reverse);
    let dormant = unit(&nb, 10, "forward");
    assert!(!dormant.active);
    assert_eq!(dormant.schedule, edited.schedule);
    assert_eq!(dormant.definition_revision, edited.definition_revision + 1);

    edit(&mut nb, 10, "京都>>日本の古都");
    let restored = unit(&nb, 10, "forward");
    assert!(restored.active);
    assert_eq!(restored.id, original.id);
    assert_eq!(restored.schedule, reviewed.schedule);
    assert_eq!(
        restored.definition_revision,
        dormant.definition_revision + 1
    );
    let inactive_reverse = unit(&nb, 10, "reverse");
    assert!(!inactive_reverse.active);
    assert_eq!(inactive_reverse.schedule, reverse.schedule);
    assert_eq!(nb.source_cards(&id(10)).unwrap().len(), 2);
    let evidence = nb.review_events(&original.id).unwrap();
    assert_eq!(evidence[0].shown_front, "東京");
    assert_eq!(evidence[0].shown_back, "日本");
    assert_eq!(
        evidence[0].definition_revision,
        original.definition_revision
    );
}

#[test]
fn cloze_numbers_not_position_or_repetition_identify_units() {
    let (_dir, mut nb) = fixture("{{c1::東京::都市}}と{{c1::京都}}は{{c42::日本}}。");
    let c1 = grade(&mut nb, 10, "cloze:c1", 100);
    let c42 = grade(&mut nb, 10, "cloze:c42", 101);
    assert_eq!(c1.kind, CardKind::Cloze);
    assert_eq!(c1.front, "都市と[…]は日本。");
    assert_eq!(c1.back, "東京と京都は日本。");
    assert_eq!(c42.front, "東京と京都は[…]。");

    edit(
        &mut nb,
        10,
        "{{c42::日本::国}}には{{c1::京都}}と{{c1::大阪::都市}}。",
    );
    let edited_c1 = unit(&nb, 10, "cloze:c1");
    let edited_c42 = unit(&nb, 10, "cloze:c42");
    assert_eq!(edited_c1.id, c1.id);
    assert_eq!(edited_c42.id, c42.id);
    assert_eq!(edited_c1.schedule, c1.schedule);
    assert_eq!(edited_c42.schedule, c42.schedule);
    assert_eq!(edited_c1.front, "日本には[…]と都市。");
    assert_eq!(edited_c42.front, "国には京都と大阪。");
    assert_eq!(edited_c42.back, "日本には京都と大阪。");
    assert_eq!(nb.source_cards(&id(10)).unwrap().len(), 2);

    edit(&mut nb, 10, "{{c7::日本}}には{{c1::京都}}。");
    let c7 = unit(&nb, 10, "cloze:c7");
    assert_ne!(c7.id, c42.id);
    assert_eq!(c7.schedule.last_reviewed_at, None);
    assert_eq!(c7.schedule.repetitions, 0);
    assert!(!unit(&nb, 10, "cloze:c42").active);
    assert_eq!(unit(&nb, 10, "cloze:c42").schedule, c42.schedule);

    edit(&mut nb, 10, "{{c42::日本}}には{{c1::京都}}。");
    let restored = unit(&nb, 10, "cloze:c42");
    assert!(restored.active);
    assert_eq!(restored.id, c42.id);
    assert_eq!(restored.schedule, c42.schedule);
    assert!(!unit(&nb, 10, "cloze:c7").active);
}

#[test]
fn removed_and_malformed_markup_deactivates_without_erasing_or_resetting() {
    let (_dir, mut nb) = fixture("問>>答");
    let reviewed = grade(&mut nb, 10, "forward", 100);
    let events = nb.review_events(&reviewed.id).unwrap();
    edit(&mut nb, 10, "問::答");
    let dormant = unit(&nb, 10, "forward");
    assert!(!dormant.active);
    assert_eq!(dormant.id, reviewed.id);
    assert_eq!(dormant.schedule, reviewed.schedule);
    assert_eq!((&*dormant.front, &*dormant.back), ("問", "答"));
    assert_eq!(dormant.revision, reviewed.revision + 1);
    assert_eq!(
        dormant.definition_revision,
        reviewed.definition_revision + 1
    );

    for malformed in [
        "問>>",
        "問>>答<<別",
        "問>>{{c1::答}}",
        "{{c1::}}",
        "{{c1::答",
    ] {
        edit(&mut nb, 10, malformed);
        assert_eq!(nb.source_cards(&id(10)).unwrap(), vec![dormant.clone()]);
        assert!(visible_ids(&nb).is_empty());
    }
    edit(&mut nb, 10, "問>>答");
    let restored = unit(&nb, 10, "forward");
    assert!(restored.active);
    assert_eq!(restored.id, reviewed.id);
    assert_eq!(restored.schedule, reviewed.schedule);
    assert_eq!(restored.revision, dormant.revision + 1);
    assert_eq!(
        restored.definition_revision,
        dormant.definition_revision + 1
    );
    assert_eq!(nb.review_events(&reviewed.id).unwrap(), events);

    edit(&mut nb, 10, "問>>答<<別");
    let malformed = unit(&nb, 10, "forward");
    assert!(!malformed.active);
    assert_eq!(
        malformed.definition_revision,
        restored.definition_revision + 1
    );
    assert_eq!(malformed.schedule, reviewed.schedule);
    assert_eq!(nb.review_events(&reviewed.id).unwrap(), events);
}

#[test]
fn archive_delete_and_exact_restore_change_visibility_not_syntax_or_schedule() {
    let (_dir, mut nb) = fixture("Container");
    apply(&mut nb, vec![insert(11, 10, "front>>back")]);
    let reviewed = grade(&mut nb, 11, "forward", 100);
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(10),
            base_revision: 1,
            archived: true,
        }],
    );
    assert!(visible_ids(&nb).is_empty());
    assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);

    edit(&mut nb, 11, "new front>>new back");
    let edited = unit(&nb, 11, "forward");
    assert!(edited.active);
    assert_eq!(edited.id, reviewed.id);
    assert_eq!(edited.schedule, reviewed.schedule);
    assert_eq!(edited.front, "new front");
    assert!(visible_ids(&nb).is_empty());

    let deletion = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(10),
            base_revision: 2,
        }],
    );
    assert_eq!(nb.source_cards(&id(11)).unwrap(), vec![edited.clone()]);
    assert_eq!(nb.card(&reviewed.id).unwrap(), edited);
    assert!(visible_ids(&nb).is_empty());
    assert!(matches!(
        nb.apply(&batch(vec![Operation::Restore {
            id: id(10),
            deletion_id: deletion.deletions[0].clone(),
            revision: 2,
        }])),
        Err(Error::Conflict { .. })
    ));
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(10),
            deletion_id: deletion.deletions[0].clone(),
            revision: 3,
        }],
    );
    assert!(nb.block(&id(10)).unwrap().archived);
    assert_eq!(nb.card(&reviewed.id).unwrap(), edited);
    assert!(visible_ids(&nb).is_empty());
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(10),
            base_revision: 4,
            archived: false,
        }],
    );
    assert_eq!(visible_ids(&nb), vec![edited.id.clone()]);

    let page_revision = nb.block(&id(1)).unwrap().revision;
    let deletion = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(1),
            base_revision: page_revision,
        }],
    );
    assert!(visible_ids(&nb).is_empty());
    assert_eq!(nb.card(&reviewed.id).unwrap(), edited);
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(1),
            deletion_id: deletion.deletions[0].clone(),
            revision: page_revision + 1,
        }],
    );
    assert_eq!(visible_ids(&nb), vec![edited.id.clone()]);
    assert_eq!(nb.card(&reviewed.id).unwrap(), edited);
    assert_eq!(
        nb.review_events(&reviewed.id).unwrap()[0].shown_front,
        "front"
    );
}

#[test]
fn reviewed_card_allows_end_split_but_not_start_interior_or_merge_away() {
    let (_dir, mut nb) = fixture("前>>後");
    apply(
        &mut nb,
        vec![insert(11, 10, "child"), insert(12, 1, "destination")],
    );
    let reviewed = grade(&mut nb, 10, "forward", 100);
    let safe = split(&nb, 10, 20, "前>>後", "");
    apply(&mut nb, vec![safe]);
    assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);
    assert!(nb.source_cards(&id(20)).unwrap().is_empty());
    assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(10)));

    for (left, right) in [("", "前>>後"), ("前", ">>後"), ("前>>", "後")] {
        let operation = split(&nb, 10, 21, left, right);
        assert!(matches!(
            nb.apply(&batch(vec![operation])),
            Err(Error::Validation { .. })
        ));
        assert_eq!(nb.block(&id(10)).unwrap().text, "前>>後");
        assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);
        assert!(matches!(nb.block(&id(21)), Err(Error::NotFound { .. })));
    }
    let operation = merge(&nb, 10, 12);
    assert!(matches!(
        nb.apply(&batch(vec![operation])),
        Err(Error::Validation { .. })
    ));
    assert_eq!(nb.block(&id(12)).unwrap().text, "destination");
    assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);
}

#[test]
fn unreviewed_whole_card_can_move_right_but_interior_basic_and_cloze_splits_fail() {
    for (text, left, right) in [
        ("front>>back", "front", ">>back"),
        ("{{c1::one}} {{c2::two}}", "{{c1::one}}", " {{c2::two}}"),
    ] {
        let (_dir, mut nb) = fixture(text);
        let before = nb.source_cards(&id(10)).unwrap();
        let operation = split(&nb, 10, 20, left, right);
        assert!(matches!(
            nb.apply(&batch(vec![operation])),
            Err(Error::Validation { .. })
        ));
        assert_eq!(nb.source_cards(&id(10)).unwrap(), before);
        assert_eq!(nb.block(&id(10)).unwrap().text, text);
        assert!(matches!(nb.block(&id(20)), Err(Error::NotFound { .. })));

        let operation = split(&nb, 10, 20, "", text);
        apply(&mut nb, vec![operation]);
        assert_eq!(nb.block(&id(10)).unwrap().text, "");
        assert_eq!(nb.block(&id(20)).unwrap().text, text);
        let old = nb.source_cards(&id(10)).unwrap();
        let new = nb.source_cards(&id(20)).unwrap();
        assert_eq!(old.len(), before.len());
        assert_eq!(new.len(), before.len());
        for previous in before {
            let retained = old.iter().find(|card| card.key == previous.key).unwrap();
            let moved = new.iter().find(|card| card.key == previous.key).unwrap();
            assert_eq!(retained.id, previous.id);
            assert!(!retained.active);
            assert_eq!(retained.schedule, previous.schedule);
            assert!(moved.active);
            assert_ne!(moved.id, previous.id);
            assert_eq!(moved.source_block_id, id(20));
            assert_eq!(moved.front, previous.front);
            assert_eq!(moved.back, previous.back);
        }
    }
}

#[test]
fn inactive_review_history_stays_on_original_through_plain_split_and_blocks_merge() {
    let (_dir, mut nb) = fixture("front>>back");
    apply(&mut nb, vec![insert(11, 1, "destination")]);
    let reviewed = grade(&mut nb, 10, "forward", 100);
    edit(&mut nb, 10, "plain text");
    let dormant = nb.card(&reviewed.id).unwrap();
    assert!(!dormant.active);
    let operation = split(&nb, 10, 20, "plain", " text");
    apply(&mut nb, vec![operation]);
    assert_eq!(nb.card(&reviewed.id).unwrap(), dormant);
    assert!(nb.source_cards(&id(20)).unwrap().is_empty());
    assert_eq!(nb.review_events(&reviewed.id).unwrap()[0].id, id(100));

    let operation = merge(&nb, 10, 11);
    assert!(matches!(
        nb.apply(&batch(vec![operation])),
        Err(Error::Validation { .. })
    ));
    assert_eq!(nb.block(&id(10)).unwrap().text, "plain");
    assert_eq!(nb.block(&id(11)).unwrap().text, "destination");
    assert_eq!(nb.card(&reviewed.id).unwrap(), dormant);
}

#[test]
fn merging_into_reviewed_destination_preserves_its_identity_and_schedule() {
    let (_dir, mut nb) = fixture("front>>back");
    apply(&mut nb, vec![insert(11, 1, " suffix")]);
    let reviewed = grade(&mut nb, 10, "forward", 100);
    let operation = merge(&nb, 11, 10);
    apply(&mut nb, vec![operation]);
    let current = unit(&nb, 10, "forward");
    assert_eq!(current.id, reviewed.id);
    assert_eq!(current.schedule, reviewed.schedule);
    assert_eq!(current.back, "back suffix");
    assert_eq!(
        current.definition_revision,
        reviewed.definition_revision + 1
    );
    assert_eq!(
        nb.review_events(&reviewed.id).unwrap()[0].shown_back,
        "back"
    );
}

#[test]
fn final_batch_text_is_derived_once_and_split_guards_use_current_text() {
    let (_dir, mut nb) = fixture("front>>back");
    let reviewed = grade(&mut nb, 10, "forward", 100);
    let revision = nb.block(&id(10)).unwrap().revision;
    let committed = apply(
        &mut nb,
        vec![
            Operation::EditText {
                id: id(10),
                base_revision: revision,
                text: "plain".into(),
            },
            Operation::EditText {
                id: id(10),
                base_revision: revision + 1,
                text: "front>>back".into(),
            },
        ],
    );
    assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);
    assert!(committed.cards.is_empty());

    edit(&mut nb, 10, "plain");
    let dormant = nb.card(&reviewed.id).unwrap();
    let revision = nb.block(&id(10)).unwrap().revision;
    assert!(matches!(
        nb.apply(&batch(vec![
            Operation::EditText {
                id: id(10),
                base_revision: revision,
                text: "front>>back".into()
            },
            Operation::Split {
                id: id(10),
                base_revision: revision + 1,
                new_id: id(20),
                left: "".into(),
                right: "front>>back".into(),
            },
        ])),
        Err(Error::Validation { .. })
    ));
    assert_eq!(nb.block(&id(10)).unwrap().text, "plain");
    assert_eq!(nb.card(&reviewed.id).unwrap(), dormant);
    assert!(matches!(nb.block(&id(20)), Err(Error::NotFound { .. })));
}

#[test]
fn root_titles_never_become_cards_and_reopening_preserves_definitions_and_progress() {
    let (dir, mut nb) = fixture("front>>back");
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(2),
                title: "title>>not a card".into(),
            },
            Operation::CreatePage {
                id: id(3),
                title: "{{c1::title}}".into(),
            },
            Operation::CreateJournal {
                id: id(4),
                date: "2026-10-03".into(),
            },
            insert(11, 4, "child<<answer"),
        ],
    );
    for root in [2, 3, 4] {
        assert!(nb.source_cards(&id(root)).unwrap().is_empty());
    }
    let reviewed = grade(&mut nb, 10, "forward", 100);
    let reverse = unit(&nb, 11, "reverse");
    let evidence = nb.review_events(&reviewed.id).unwrap();
    drop(nb);
    let reopened = Notebook::open(dir.path()).unwrap();
    assert_eq!(reopened.card(&reviewed.id).unwrap(), reviewed);
    assert_eq!(reopened.card(&reverse.id).unwrap(), reverse);
    assert_eq!(reopened.review_events(&reviewed.id).unwrap(), evidence);
    for root in [2, 3, 4] {
        assert!(reopened.source_cards(&id(root)).unwrap().is_empty());
    }
}
