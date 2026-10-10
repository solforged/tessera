use tessera_core::scheduler::{Grade, SCHEDULER_VERSION};
use tessera_core::{
    Actor, Batch, CardQuery, CardSelection, CardUnit, Committed, Error, Notebook, Operation,
    ReviewEventKind, ReviewSessionState, Revision,
};

fn fsrs(state: &tessera_core::ReviewSchedulingState) -> tessera_core::scheduler::SchedulingState {
    match state {
        tessera_core::ReviewSchedulingState::Fsrs(state) => state.clone(),
        _ => panic!("new evidence must use FSRS"),
    }
}

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

fn fixture() -> (tempfile::TempDir, Notebook, CardUnit) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Review sources".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "Capital of 日本? >> 東京".into(),
                heading: None,
            },
        ],
    );
    let cards = nb.source_cards(&id(2)).unwrap();
    assert_eq!(cards.len(), 1);
    (dir, nb, cards.into_iter().next().unwrap())
}

fn grade(card: &CardUnit, event: u128, session: Option<u128>, reset: bool, at: i64) -> Operation {
    Operation::GradeCard {
        id: card.id.clone(),
        base_revision: card.revision,
        definition_revision: card.definition_revision,
        event_id: id(event),
        session_id: session.map(id),
        grade: Grade::Good,
        reset,
        shown_front: card.front.clone(),
        shown_back: card.back.clone(),
        reviewed_at: at,
    }
}

fn reset(card: &CardUnit, event: u128, session: Option<u128>, at: i64) -> Operation {
    Operation::ResetCard {
        id: card.id.clone(),
        base_revision: card.revision,
        event_id: id(event),
        session_id: session.map(id),
        reviewed_at: at,
    }
}

fn edit(nb: &Notebook, text: &str) -> Operation {
    Operation::EditText {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        text: text.into(),
    }
}

fn finish(session: u128, revision: i64, state: ReviewSessionState, at: i64) -> Operation {
    Operation::FinishReviewSession {
        id: id(session),
        base_revision: revision,
        state,
        ended_at: at,
    }
}

fn save_deck(deck: u128, revision: Option<i64>, name: &str, query: CardQuery) -> Operation {
    Operation::SaveDeck {
        id: id(deck),
        base_revision: revision,
        name: name.into(),
        query,
    }
}

fn invalid(nb: &mut Notebook, operation: Operation) {
    assert!(matches!(
        nb.apply(&batch(vec![operation])),
        Err(Error::Validation { .. })
    ));
}

#[test]
fn stale_card_revisions_definitions_and_shown_text_cannot_grade() {
    let (_dir, mut nb, original) = fixture();
    let change = edit(&nb, "Capital of Japan? >> Tokyo");
    apply(&mut nb, vec![change]);
    let current = nb.card(&original.id).unwrap();
    assert!(current.revision > original.revision);
    assert!(current.definition_revision > original.definition_revision);
    assert_eq!(current.schedule, original.schedule);

    assert!(matches!(
        nb.apply(&batch(vec![grade(&original, 100, None, false, 1000)])),
        Err(Error::Conflict { op_index: 0, expected, found: Some(found), .. })
            if expected == original.revision && found == current.revision
    ));
    let mut stale_definition = grade(&current, 100, None, false, 1000);
    if let Operation::GradeCard {
        definition_revision,
        ..
    } = &mut stale_definition
    {
        *definition_revision = original.definition_revision;
    }
    invalid(&mut nb, stale_definition);
    for front in [true, false] {
        let mut wrong_evidence = grade(&current, 100, None, false, 1000);
        if let Operation::GradeCard {
            shown_front,
            shown_back,
            ..
        } = &mut wrong_evidence
        {
            if front {
                shown_front.push(' ');
            } else {
                shown_back.push(' ');
            }
        }
        invalid(&mut nb, wrong_evidence);
    }
    assert_eq!(nb.card(&current.id).unwrap(), current);
    assert_eq!(nb.review_events(&current.id).unwrap(), vec![]);

    let committed = apply(&mut nb, vec![grade(&current, 100, None, false, 1000)]);
    let reviewed = nb.card(&current.id).unwrap();
    assert_eq!(reviewed.revision, current.revision + 1);
    assert_eq!(reviewed.definition_revision, current.definition_revision);
    assert_eq!(
        committed.cards,
        vec![Revision {
            id: current.id.clone(),
            revision: reviewed.revision
        }]
    );
    assert!(committed.revisions.is_empty());
    assert!(matches!(
        nb.apply(&batch(vec![grade(&current, 101, None, false, 1001)])),
        Err(Error::Conflict { found: Some(found), .. }) if found == reviewed.revision
    ));
    assert!(matches!(
        nb.apply(&batch(vec![reset(&current, 102, None, 1001)])),
        Err(Error::Conflict { found: Some(found), .. }) if found == reviewed.revision
    ));
    assert_eq!(nb.review_events(&current.id).unwrap().len(), 1);
}

#[test]
fn source_edits_before_review_writes_are_flushed_and_roll_back_with_stale_evidence() {
    let (_dir, mut nb, original) = fixture();
    let source = nb.block(&id(2)).unwrap();
    for review in [
        grade(&original, 100, None, false, 1000),
        reset(&original, 100, None, 1000),
    ] {
        let change = edit(&nb, "Different front >> Different back");
        assert!(matches!(
            nb.apply(&batch(vec![change, review])),
            Err(Error::Conflict { op_index: 1, .. })
        ));
        assert_eq!(nb.block(&id(2)).unwrap(), source);
        assert_eq!(nb.card(&original.id).unwrap(), original);
        assert_eq!(nb.review_events(&original.id).unwrap(), vec![]);
    }

    let change = edit(&nb, "Different front >> Different back");
    apply(
        &mut nb,
        vec![grade(&original, 100, None, false, 1000), change],
    );
    let events = nb.review_events(&original.id).unwrap();
    assert_eq!(events[0].shown_front, original.front);
    assert_eq!(events[0].shown_back, original.back);
    assert_eq!(events[0].definition_revision, original.definition_revision);
    let current = nb.card(&original.id).unwrap();
    assert_eq!(current.front, "Different front");
    assert_eq!(current.schedule, fsrs(&events[0].after));
    assert!(current.definition_revision > events[0].definition_revision);
}

#[test]
fn immutable_evidence_preserves_exact_definition_version_times_and_schedules() {
    let (_dir, mut nb, original) = fixture();
    let committed = apply(&mut nb, vec![grade(&original, 100, None, false, 1234)]);
    let first = nb.review_events(&original.id).unwrap();
    assert_eq!(first.len(), 1);
    let event = &first[0];
    assert_eq!(event.id, id(100));
    assert_eq!(event.kind, ReviewEventKind::Grade);
    assert_eq!(event.grade, Some(Grade::Good));
    assert_eq!(event.shown_front, "Capital of 日本?");
    assert_eq!(event.shown_back, "東京");
    assert_eq!(event.definition_revision, original.definition_revision);
    assert_eq!(event.scheduler_version, SCHEDULER_VERSION);
    assert_eq!(event.created_at, 1234);
    assert_eq!(event.change_seq, committed.seq);
    assert_eq!(fsrs(&event.before), original.schedule);
    assert_eq!(fsrs(&event.after), nb.card(&original.id).unwrap().schedule);
    assert_eq!(fsrs(&event.after).repetitions, 1);
    assert_eq!(fsrs(&event.after).interval_days, 2);
    assert_eq!(fsrs(&event.after).due_at, 1234 + 2 * 86_400_000);
    assert_eq!(fsrs(&event.after).last_reviewed_at, Some(1234));

    let change = edit(&nb, "New question >> New answer");
    apply(&mut nb, vec![change]);
    let current = nb.card(&original.id).unwrap();
    apply(&mut nb, vec![grade(&current, 101, None, false, 2345)]);
    let events = nb.review_events(&original.id).unwrap();
    assert_eq!(events[0], first[0]);
    assert_eq!(events[1].shown_front, "New question");
    assert_eq!(events[1].shown_back, "New answer");
    assert_eq!(events[1].before, first[0].after);
    assert_eq!(fsrs(&events[1].after).repetitions, 2);
    assert_eq!(fsrs(&events[1].after).interval_days, 3);
    assert_eq!(events[1].created_at, 2345);
}

#[test]
fn uncertain_delivery_replays_the_same_session_reset_grade_and_receipt_after_reopen() {
    let (dir, mut nb, original) = fixture();
    let request = Batch {
        idempotency_key: Some("review-response-lost".into()),
        ..batch(vec![
            Operation::StartReviewSession {
                id: id(50),
                deck_id: None,
                started_at: 1000,
            },
            grade(&original, 100, Some(50), true, 1100),
            finish(50, 1, ReviewSessionState::Finished, 1200),
        ])
    };
    let committed = nb.apply(&request).unwrap();
    let events = nb.review_events(&original.id).unwrap();
    let card = nb.card(&original.id).unwrap();
    let session = nb.review_session(&id(50)).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, ReviewEventKind::Reset);
    assert_eq!(events[1].id, id(100));
    assert_eq!(committed.review_sessions, vec![session.clone()]);
    assert_eq!(
        committed.cards,
        vec![Revision {
            id: card.id.clone(),
            revision: card.revision
        }]
    );
    drop(nb);

    let mut nb = Notebook::open(dir.path()).unwrap();
    let replay = nb.apply(&request).unwrap();
    let mut expected = committed;
    expected.replayed = true;
    assert_eq!(replay, expected);
    assert_eq!(nb.review_events(&original.id).unwrap(), events);
    assert_eq!(nb.card(&original.id).unwrap(), card);
    assert_eq!(nb.review_sessions().unwrap(), vec![session]);
    let mut different = request.clone();
    different.operations.pop();
    assert!(matches!(
        nb.apply(&different),
        Err(Error::Validation { .. })
    ));

    // A new envelope is not permission to reuse an existing immutable event ID.
    invalid(&mut nb, grade(&card, 100, None, true, 1300));
    assert_eq!(nb.review_events(&original.id).unwrap(), events);
    assert_eq!(nb.card(&original.id).unwrap(), card);
}

#[test]
fn reset_then_grade_is_atomic_with_one_revision_and_rowid_event_chronology() {
    let (_dir, mut nb, original) = fixture();
    apply(&mut nb, vec![grade(&original, 900, None, false, 1000)]);
    let reviewed = nb.card(&original.id).unwrap();
    let committed = apply(&mut nb, vec![grade(&reviewed, 100, None, true, 1000)]);
    let current = nb.card(&original.id).unwrap();
    let events = nb.review_events(&original.id).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].id, id(900));
    assert_eq!(events[1].kind, ReviewEventKind::Reset);
    assert_eq!(events[1].grade, None);
    assert_ne!(events[1].id, id(100));
    assert!(events[1].id.parse::<ulid::Ulid>().is_ok());
    assert_eq!(fsrs(&events[1].before), reviewed.schedule);
    assert_eq!(fsrs(&events[1].after).repetitions, 0);
    assert_eq!(fsrs(&events[1].after).last_reviewed_at, None);
    assert_eq!(fsrs(&events[1].after).due_at, 1000);
    assert_eq!(events[2].id, id(100));
    assert_eq!(events[2].kind, ReviewEventKind::Grade);
    assert_eq!(events[2].before, events[1].after);
    assert_eq!(fsrs(&events[2].after), current.schedule);
    assert_eq!(fsrs(&events[2].after).repetitions, 1);
    assert_eq!(events[1].change_seq, committed.seq);
    assert_eq!(events[2].change_seq, committed.seq);
    assert_eq!(events[1].created_at, events[2].created_at);
    assert_eq!(events[1].shown_front, reviewed.front);
    assert_eq!(events[1].shown_back, reviewed.back);
    assert_eq!(events[1].definition_revision, reviewed.definition_revision);
    assert_eq!(events[1].scheduler_version, SCHEDULER_VERSION);
    assert_eq!(
        committed.cards,
        vec![Revision {
            id: current.id.clone(),
            revision: reviewed.revision + 1
        }]
    );

    // A failure later in the same batch rolls both reset and grade back.
    assert!(matches!(
        nb.apply(&batch(vec![
            grade(&current, 101, None, true, 1000),
            Operation::DeleteDeck {
                id: id(700),
                base_revision: 1
            },
        ])),
        Err(Error::Conflict { op_index: 1, .. })
    ));
    assert_eq!(nb.review_events(&current.id).unwrap(), events);
    assert_eq!(nb.card(&current.id).unwrap(), current);

    let committed = apply(&mut nb, vec![reset(&current, 50, None, 1000)]);
    let reset_card = nb.card(&current.id).unwrap();
    let after_reset = nb.review_events(&current.id).unwrap();
    assert_eq!(&after_reset[..3], events.as_slice());
    assert_eq!(after_reset[3].id, id(50));
    assert_eq!(after_reset[3].kind, ReviewEventKind::Reset);
    assert_eq!(fsrs(&after_reset[3].before), current.schedule);
    assert_eq!(fsrs(&after_reset[3].after), reset_card.schedule);
    assert_eq!(reset_card.schedule.repetitions, 0);
    assert_eq!(reset_card.schedule.last_reviewed_at, None);
    assert_eq!(reset_card.definition_revision, current.definition_revision);
    assert_eq!(
        committed.cards,
        vec![Revision {
            id: current.id.clone(),
            revision: current.revision + 1
        }]
    );
}

#[test]
fn session_lifecycle_checks_revision_state_and_event_chronology() {
    let (_dir, mut nb, original) = fixture();
    invalid(
        &mut nb,
        Operation::StartReviewSession {
            id: id(50),
            deck_id: None,
            started_at: -1,
        },
    );
    assert!(matches!(
        nb.apply(&batch(vec![Operation::StartReviewSession {
            id: id(50),
            deck_id: Some(id(70)),
            started_at: 1000,
        }])),
        Err(Error::NotFound { .. })
    ));
    apply(
        &mut nb,
        vec![Operation::StartReviewSession {
            id: id(50),
            deck_id: None,
            started_at: 1000,
        }],
    );
    let open = nb.review_session(&id(50)).unwrap();
    assert_eq!(open.revision, 1);
    assert_eq!(open.state, ReviewSessionState::Open);
    assert_eq!(open.ended_at, None);
    invalid(
        &mut nb,
        Operation::StartReviewSession {
            id: id(50),
            deck_id: None,
            started_at: 1000,
        },
    );
    invalid(&mut nb, finish(50, 1, ReviewSessionState::Open, 1000));
    invalid(&mut nb, finish(50, 1, ReviewSessionState::Finished, 999));
    invalid(&mut nb, grade(&original, 100, Some(50), false, 999));
    invalid(&mut nb, reset(&original, 100, Some(50), 999));
    assert_eq!(nb.review_session(&id(50)).unwrap(), open);
    apply(&mut nb, vec![grade(&original, 100, Some(50), false, 1100)]);
    let card = nb.card(&original.id).unwrap();
    let events = nb.review_events(&original.id).unwrap();
    assert_eq!(events[0].session_id, Some(id(50)));
    invalid(&mut nb, finish(50, 1, ReviewSessionState::Finished, 1099));
    assert!(matches!(
        nb.apply(&batch(vec![finish(
            50,
            2,
            ReviewSessionState::Finished,
            1200
        )])),
        Err(Error::Conflict {
            expected: 2,
            found: Some(1),
            ..
        })
    ));

    apply(
        &mut nb,
        vec![finish(50, 1, ReviewSessionState::Abandoned, 1200)],
    );
    let abandoned = nb.review_session(&id(50)).unwrap();
    assert_eq!(abandoned.revision, 2);
    assert_eq!(abandoned.state, ReviewSessionState::Abandoned);
    assert_eq!(abandoned.ended_at, Some(1200));
    let no_op = apply(
        &mut nb,
        vec![finish(50, 2, ReviewSessionState::Abandoned, 1200)],
    );
    assert!(no_op.review_sessions.is_empty());
    assert_eq!(nb.review_session(&id(50)).unwrap(), abandoned);
    assert!(matches!(
        nb.apply(&batch(vec![finish(
            50,
            1,
            ReviewSessionState::Abandoned,
            1200
        )])),
        Err(Error::Conflict {
            expected: 1,
            found: Some(2),
            ..
        })
    ));
    invalid(&mut nb, finish(50, 2, ReviewSessionState::Finished, 1200));
    invalid(&mut nb, finish(50, 2, ReviewSessionState::Abandoned, 1300));
    invalid(&mut nb, grade(&card, 101, Some(50), false, 1300));
    invalid(&mut nb, reset(&card, 101, Some(50), 1300));
    assert_eq!(nb.card(&card.id).unwrap(), card);
    assert_eq!(nb.review_events(&card.id).unwrap(), events);

    apply(
        &mut nb,
        vec![
            Operation::StartReviewSession {
                id: id(51),
                deck_id: None,
                started_at: 2000,
            },
            finish(51, 1, ReviewSessionState::Finished, 2000),
        ],
    );
    assert_eq!(
        nb.review_session(&id(51)).unwrap().state,
        ReviewSessionState::Finished
    );
    assert_eq!(
        nb.review_sessions()
            .unwrap()
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        vec![id(50), id(51)]
    );
}

#[test]
fn event_identifiers_timestamps_and_missing_sessions_reject_without_mutation() {
    let (_dir, mut nb, original) = fixture();
    invalid(&mut nb, grade(&original, 100, None, false, -1));
    invalid(&mut nb, reset(&original, 100, None, -1));
    let mut invalid_id = grade(&original, 100, None, true, 0);
    if let Operation::GradeCard { event_id, .. } = &mut invalid_id {
        *event_id = "not-an-id".into();
    }
    invalid(&mut nb, invalid_id);
    let mut invalid_session = reset(&original, 100, None, 0);
    if let Operation::ResetCard { session_id, .. } = &mut invalid_session {
        *session_id = Some("not-an-id".into());
    }
    invalid(&mut nb, invalid_session);
    assert!(matches!(
        nb.apply(&batch(vec![grade(&original, 100, Some(50), true, 0)])),
        Err(Error::NotFound { .. })
    ));
    assert_eq!(nb.card(&original.id).unwrap(), original);
    assert_eq!(nb.review_events(&original.id).unwrap(), vec![]);
    apply(&mut nb, vec![grade(&original, 100, None, false, 0)]);
    assert_eq!(nb.review_events(&original.id).unwrap()[0].created_at, 0);
}

#[test]
fn source_and_deck_removal_hide_reviews_but_retain_session_and_card_history() {
    let (dir, mut nb, original) = fixture();
    apply(
        &mut nb,
        vec![
            save_deck(70, None, "Japanese", CardQuery::default()),
            Operation::StartReviewSession {
                id: id(50),
                deck_id: Some(id(70)),
                started_at: 1000,
            },
            grade(&original, 100, Some(50), false, 1100),
        ],
    );
    let reviewed = nb.card(&original.id).unwrap();
    let evidence = nb.review_events(&original.id).unwrap();
    let removal = edit(&nb, "A plain source with no card markup");
    apply(&mut nb, vec![removal]);
    let inactive = nb.card(&original.id).unwrap();
    assert!(!inactive.active);
    assert_eq!(inactive.schedule, reviewed.schedule);
    invalid(&mut nb, grade(&inactive, 101, Some(50), false, 1200));
    invalid(&mut nb, reset(&inactive, 101, Some(50), 1200));
    assert_eq!(nb.review_events(&original.id).unwrap(), evidence);

    let restoration = edit(&nb, "Capital of 日本? >> 東京");
    apply(&mut nb, vec![restoration]);
    let restored = nb.card(&original.id).unwrap();
    assert!(restored.active);
    assert_eq!(restored.schedule, reviewed.schedule);
    let page_revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(1),
            base_revision: page_revision,
            archived: true,
        }],
    );
    invalid(&mut nb, grade(&restored, 101, None, false, 1200));
    invalid(&mut nb, reset(&restored, 101, None, 1200));
    assert!(nb.card_previews(&restored.id, 1200).is_err());
    let page_revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(1),
            base_revision: page_revision,
            archived: false,
        }],
    );

    let source_revision = nb.block(&id(2)).unwrap().revision;
    let deletion = apply(
        &mut nb,
        vec![
            Operation::Delete {
                id: id(2),
                base_revision: source_revision,
            },
            Operation::DeleteDeck {
                id: id(70),
                base_revision: 1,
            },
        ],
    );
    invalid(&mut nb, grade(&restored, 101, None, false, 1200));
    invalid(&mut nb, reset(&restored, 101, None, 1200));
    assert!(matches!(nb.deck(&id(70)), Err(Error::NotFound { .. })));
    assert_eq!(nb.review_session(&id(50)).unwrap().deck_id, Some(id(70)));
    // Closing the session does not need the deck or source to still exist.
    apply(
        &mut nb,
        vec![finish(50, 1, ReviewSessionState::Abandoned, 1300)],
    );
    assert_eq!(nb.review_events(&original.id).unwrap(), evidence);
    drop(nb);

    let mut nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.review_events(&original.id).unwrap(), evidence);
    assert_eq!(nb.card(&original.id).unwrap().schedule, reviewed.schedule);
    let retained = nb.review_session(&id(50)).unwrap();
    assert_eq!(retained.deck_id, Some(id(70)));
    assert_eq!(retained.state, ReviewSessionState::Abandoned);
    let source_revision = deletion
        .revisions
        .iter()
        .find(|r| r.id == id(2))
        .unwrap()
        .revision;
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(2),
            deletion_id: deletion.deletions[0].clone(),
            revision: source_revision,
        }],
    );
    let restored = nb.card(&original.id).unwrap();
    assert_eq!(restored.schedule, reviewed.schedule);
    apply(&mut nb, vec![grade(&restored, 101, None, false, 1400)]);
    let events = nb.review_events(&original.id).unwrap();
    assert_eq!(events[0], evidence[0]);
    assert_eq!(fsrs(&events[1].before), reviewed.schedule);
    assert_eq!(fsrs(&events[1].after).repetitions, 2);
}

#[test]
fn deck_writes_validate_names_queries_and_nullable_revision_semantics() {
    let (_dir, mut nb, _card) = fixture();
    for name in ["".to_owned(), "   ".to_owned(), "界".repeat(121)] {
        invalid(&mut nb, save_deck(70, None, &name, CardQuery::default()));
    }
    invalid(
        &mut nb,
        save_deck(
            70,
            None,
            "Deck",
            CardQuery {
                limit: Some(2001),
                ..CardQuery::default()
            },
        ),
    );
    assert!(nb.decks().unwrap().is_empty());
    assert!(matches!(
        nb.apply(&batch(vec![save_deck(
            70,
            Some(1),
            "Deck",
            CardQuery::default()
        )])),
        Err(Error::Conflict {
            expected: 1,
            found: None,
            ..
        })
    ));
    let query = CardQuery {
        selection: CardSelection::New,
        limit: Some(100),
        ..CardQuery::default()
    };
    let created = apply(
        &mut nb,
        vec![save_deck(70, None, "  Japanese  ", query.clone())],
    );
    assert_eq!(
        created.decks,
        vec![Revision {
            id: id(70),
            revision: 1
        }]
    );
    assert!(created.revisions.is_empty());
    let deck = nb.deck(&id(70)).unwrap();
    assert_eq!(deck.name, "Japanese");
    assert_eq!(deck.query, query);
    assert!(matches!(
        nb.apply(&batch(vec![save_deck(
            70,
            None,
            "Other",
            CardQuery::default()
        )])),
        Err(Error::Conflict {
            expected: 0,
            found: Some(1),
            ..
        })
    ));
    apply(
        &mut nb,
        vec![save_deck(
            70,
            Some(1),
            &"界".repeat(120),
            CardQuery::default(),
        )],
    );
    let updated = nb.deck(&id(70)).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.name, "界".repeat(120));
    assert_eq!(updated.created_at, deck.created_at);
    assert!(matches!(
        nb.apply(&batch(vec![Operation::DeleteDeck {
            id: id(70),
            base_revision: 1
        }])),
        Err(Error::Conflict {
            expected: 1,
            found: Some(2),
            ..
        })
    ));
    let removed = apply(
        &mut nb,
        vec![Operation::DeleteDeck {
            id: id(70),
            base_revision: 2,
        }],
    );
    assert_eq!(
        removed.decks,
        vec![Revision {
            id: id(70),
            revision: 3
        }]
    );
    assert!(nb.decks().unwrap().is_empty());
}

#[test]
fn previews_keep_current_and_reset_progress_distinct_without_writing() {
    let (_dir, mut nb, original) = fixture();
    apply(&mut nb, vec![grade(&original, 100, None, false, 1000)]);
    let current = nb.card(&original.id).unwrap();
    let history = nb.review_events(&original.id).unwrap();
    let previews = nb.card_previews(&original.id, 2000).unwrap();
    assert_eq!(
        previews
            .current
            .iter()
            .map(|p| (p.grade, p.interval_days))
            .collect::<Vec<_>>(),
        vec![
            (Grade::Again, 1),
            (Grade::Hard, 2),
            (Grade::Good, 3),
            (Grade::Easy, 4)
        ]
    );
    assert_eq!(
        previews
            .reset
            .iter()
            .map(|p| (p.grade, p.interval_days))
            .collect::<Vec<_>>(),
        vec![
            (Grade::Again, 1),
            (Grade::Hard, 1),
            (Grade::Good, 2),
            (Grade::Easy, 8)
        ]
    );
    assert!(nb.card_previews(&original.id, -1).is_err());
    assert_eq!(nb.card(&original.id).unwrap(), current);
    assert_eq!(nb.review_events(&original.id).unwrap(), history);
}
