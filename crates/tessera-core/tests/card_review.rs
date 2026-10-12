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

fn hold(card: &CardUnit, held: bool) -> Operation {
    Operation::SetCardHeld {
        id: card.id.clone(),
        base_revision: card.revision,
        held,
    }
}

#[test]
fn held_cards_leave_all_queues_counts_and_forecasts_without_changing_schedule() {
    let (_dir, mut nb, original) = fixture();
    let now = tessera_core::now_ms();
    let date = nb.today(now).unwrap();
    let query = CardQuery {
        source: None,
        selection: CardSelection::All,
        limit: None,
    };
    apply(
        &mut nb,
        vec![save_deck(200, None, "Held scope", query.clone())],
    );
    assert!(!original.held);
    assert_eq!(nb.review_stats(None, &date).unwrap().due_new, 1);
    apply(&mut nb, vec![hold(&original, true)]);
    let held = nb.card(&original.id).unwrap();
    assert_eq!(held.schedule, original.schedule);
    assert_eq!(held.definition_revision, original.definition_revision);
    assert_eq!(held.revision, original.revision + 1);
    for selection in [CardSelection::All, CardSelection::New, CardSelection::Due] {
        let result = nb
            .card_query(
                &CardQuery {
                    selection,
                    ..query.clone()
                },
                now,
            )
            .unwrap();
        assert_eq!(result.total, 0);
        assert!(result.rows.is_empty());
    }
    for deck in [None, Some(id(200))] {
        let stats = nb.review_stats(deck.as_deref(), &date).unwrap();
        assert_eq!(
            (stats.due_new, stats.due_review, stats.total_cards),
            (0, 0, 0)
        );
        assert_eq!(stats.held_cards, 1);
        assert!(stats.forecast.iter().all(|day| day.count == 0));
    }
    invalid(&mut nb, grade(&held, 101, None, false, now));
    invalid(&mut nb, grade(&held, 102, None, true, now));
    assert!(nb.review_events(&held.id).unwrap().is_empty());
    apply(&mut nb, vec![hold(&held, false)]);
    let released = nb.card(&held.id).unwrap();
    assert_eq!(released.schedule, original.schedule);
    assert_eq!(
        nb.card_query(
            &CardQuery {
                selection: CardSelection::New,
                ..query.clone()
            },
            now
        )
        .unwrap()
        .total,
        1
    );

    apply(&mut nb, vec![grade(&released, 103, None, false, now)]);
    let reviewed = nb.card(&held.id).unwrap();
    let due = reviewed.schedule.due_at;
    apply(&mut nb, vec![hold(&reviewed, true)]);
    assert_eq!(
        nb.card_query(
            &CardQuery {
                selection: CardSelection::Due,
                ..query.clone()
            },
            due
        )
        .unwrap()
        .total,
        0
    );
    let paused = nb.card(&held.id).unwrap();
    apply(&mut nb, vec![hold(&paused, false)]);
    assert_eq!(nb.card(&held.id).unwrap().schedule, reviewed.schedule);
    assert_eq!(
        nb.card_query(
            &CardQuery {
                selection: CardSelection::Due,
                ..query.clone()
            },
            due - 1
        )
        .unwrap()
        .total,
        0
    );
    assert_eq!(
        nb.card_query(
            &CardQuery {
                selection: CardSelection::Due,
                ..query
            },
            due
        )
        .unwrap()
        .total,
        1
    );
}

#[test]
fn hold_survives_definition_changes_reactivation_and_reset_and_rejects_stale_writes() {
    let (dir, mut nb, original) = fixture();
    let stamp = tessera_core::ChangeStamp {
        id: id(900),
        origin: nb.info().unwrap().id,
        at: 123456,
    };
    nb.apply_stamped(&batch(vec![hold(&original, true)]), &stamp)
        .unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    let updated_at: i64 = conn
        .query_row(
            "SELECT updated_at FROM card_units WHERE id = ?1",
            [&original.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(updated_at, stamp.at);
    assert!(matches!(
        nb.apply(&batch(vec![hold(&original, false)])),
        Err(Error::Conflict { .. })
    ));
    for text in [
        "Capital of Japan? >> Tokyo",
        "No card here",
        "Capital of Japan? >> Edo",
    ] {
        let operation = edit(&nb, text);
        apply(&mut nb, vec![operation]);
        let current = nb.card(&original.id).unwrap();
        assert!(current.held);
        assert_eq!(current.schedule, original.schedule);
        if !current.active {
            invalid(&mut nb, hold(&current, false));
        }
    }
    let current = nb.card(&original.id).unwrap();
    apply(&mut nb, vec![reset(&current, 104, None, 234567)]);
    let reset_card = nb.card(&original.id).unwrap();
    assert!(reset_card.held);
    assert_eq!(reset_card.schedule.last_reviewed_at, None);
    // The inverse and its inverse change only the flag, not the restored definition or schedule.
    apply(&mut nb, vec![hold(&reset_card, false)]);
    let undone = nb.card(&original.id).unwrap();
    assert!(!undone.held);
    apply(&mut nb, vec![hold(&undone, true)]);
    let redone = nb.card(&original.id).unwrap();
    assert!(redone.held);
    assert_eq!(redone.schedule, reset_card.schedule);
    assert_eq!(redone.definition_revision, reset_card.definition_revision);
    let noop = apply(&mut nb, vec![hold(&redone, true)]);
    assert!(noop.cards.is_empty());
    assert_eq!(nb.card(&redone.id).unwrap().revision, redone.revision);
}

#[test]
fn releasing_a_new_card_preserves_its_original_queue_order() {
    let (_dir, mut nb, first) = fixture();
    apply(
        &mut nb,
        vec![Operation::Insert {
            id: id(3),
            parent_id: id(1),
            after: Some(id(2)),
            text: "Second >> Answer".into(),
            heading: None,
        }],
    );
    let query = CardQuery {
        source: None,
        selection: CardSelection::New,
        limit: None,
    };
    let now = tessera_core::now_ms();
    let order = |nb: &Notebook| {
        nb.card_query(&query, now)
            .unwrap()
            .rows
            .into_iter()
            .map(|row| row.card.id)
            .collect::<Vec<_>>()
    };
    let before = order(&nb);
    apply(&mut nb, vec![hold(&first, true)]);
    assert_eq!(order(&nb).len(), 1);
    let current = nb.card(&first.id).unwrap();
    apply(&mut nb, vec![hold(&current, false)]);
    assert_eq!(order(&nb), before);
}

fn undo(
    card: &CardUnit,
    review: u128,
    event: u128,
    session_revision: Option<i64>,
    at: i64,
) -> Operation {
    Operation::UndoGrade {
        id: card.id.clone(),
        base_revision: card.revision,
        review_id: id(review),
        event_id: id(event),
        session_revision,
        undone_at: at,
    }
}

#[test]
fn undo_restores_exact_schedule_reopens_session_and_replays_after_backup_restore() {
    let (dir, mut nb, original) = fixture();
    let at = tessera_core::now_ms();
    apply(
        &mut nb,
        vec![
            Operation::StartReviewSession {
                id: id(50),
                deck_id: None,
                started_at: at,
            },
            grade(&original, 100, Some(50), false, at),
            finish(50, 1, ReviewSessionState::Finished, at),
        ],
    );
    let evidence = nb.review_events(&original.id).unwrap().remove(0);
    let graded = nb.card(&original.id).unwrap();
    let request = Batch {
        idempotency_key: Some("undo-response-lost".into()),
        ..batch(vec![undo(&graded, 100, 101, Some(2), at)])
    };
    let committed = nb.apply(&request).unwrap();
    let restored = nb.card(&original.id).unwrap();
    assert_eq!(restored.schedule, original.schedule);
    assert_eq!(restored.revision, graded.revision + 1);
    assert_eq!(
        committed.cards,
        vec![Revision {
            id: original.id.clone(),
            revision: restored.revision
        }]
    );
    let session = nb.review_session(&id(50)).unwrap();
    assert_eq!(
        (session.state, session.ended_at, session.revision),
        (ReviewSessionState::Open, None, 3)
    );
    assert_eq!(committed.review_sessions, vec![session.clone()]);
    assert!(nb.review_session_events(&id(50)).unwrap().is_empty());
    let mut history = nb.review_events(&original.id).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].undone_by.take(), Some(id(101)));
    assert_eq!(history[0], evidence);
    let query = CardQuery {
        source: None,
        selection: CardSelection::Due,
        limit: None,
    };
    let queue = nb.card_query(&query, at).unwrap();
    assert_eq!(queue.total, 1);
    assert_eq!(queue.rows[0].card.id, original.id);
    assert!(queue.rows[0].last_review.is_none());
    let stats = nb.review_stats(None, &nb.today(at).unwrap()).unwrap();
    assert_eq!(
        (
            stats.due_new,
            stats.reviews_this_week,
            stats.streak,
            stats.retention
        ),
        (1, 0, 0, None)
    );

    drop(nb);
    let mut nb = Notebook::open(dir.path()).unwrap();
    let mut expected = committed;
    expected.replayed = true;
    assert_eq!(nb.apply(&request).unwrap(), expected);
    assert_eq!(nb.card(&original.id).unwrap().schedule, original.schedule);
    assert_eq!(nb.review_session(&id(50)).unwrap(), session);
    let copies = tempfile::tempdir().unwrap();
    tessera_core::backup(dir.path(), copies.path().join("backup")).unwrap();
    tessera_core::restore(
        copies.path().join("backup"),
        copies.path().join("restored"),
        false,
    )
    .unwrap();
    let mut copy = Notebook::open(copies.path().join("restored")).unwrap();
    assert_eq!(copy.apply(&request).unwrap(), expected);
    assert_eq!(
        copy.review_events(&original.id).unwrap()[0].undone_by,
        Some(id(101))
    );
    assert!(copy.review_session_events(&id(50)).unwrap().is_empty());

    // A repeated grade uses the restored state, not a reset or the discarded interval.
    apply(&mut copy, vec![grade(&restored, 102, Some(50), false, at)]);
    assert_eq!(copy.card(&original.id).unwrap().schedule, graded.schedule);
}

#[test]
fn undo_refuses_stale_double_out_of_order_and_abandoned_session_changes() {
    let (_dir, mut nb, first) = fixture();
    apply(
        &mut nb,
        vec![
            Operation::Insert {
                id: id(3),
                parent_id: id(1),
                after: Some(id(2)),
                text: "Second >> Answer".into(),
                heading: None,
            },
            Operation::StartReviewSession {
                id: id(50),
                deck_id: None,
                started_at: 1000,
            },
            grade(&first, 100, Some(50), false, 1000),
        ],
    );
    let second = nb.source_cards(&id(3)).unwrap().remove(0);
    apply(&mut nb, vec![grade(&second, 101, Some(50), false, 1000)]);
    let graded_first = nb.card(&first.id).unwrap();
    let graded_second = nb.card(&second.id).unwrap();
    invalid(&mut nb, undo(&graded_first, 100, 102, Some(1), 1000));
    assert!(matches!(
        nb.apply(&batch(vec![undo(&second, 101, 102, Some(1), 1000)])),
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        nb.apply(&batch(vec![undo(&graded_second, 101, 102, Some(0), 1000)])),
        Err(Error::Conflict { .. })
    ));
    invalid(&mut nb, undo(&graded_second, 101, 102, None, 1000));
    invalid(&mut nb, undo(&graded_second, 101, 102, Some(1), -1));
    invalid(&mut nb, undo(&graded_second, 101, 100, Some(1), 1000));
    assert_eq!(nb.card(&second.id).unwrap(), graded_second);
    assert_eq!(nb.review_session(&id(50)).unwrap().revision, 1);
    apply(&mut nb, vec![undo(&graded_second, 101, 102, Some(1), 1000)]);
    let restored_second = nb.card(&second.id).unwrap();
    invalid(&mut nb, undo(&restored_second, 101, 103, Some(2), 1000));
    assert!(matches!(
        nb.apply(&batch(vec![undo(&graded_second, 101, 103, Some(2), 1000)])),
        Err(Error::Conflict { .. })
    ));
    apply(
        &mut nb,
        vec![finish(50, 2, ReviewSessionState::Abandoned, 1000)],
    );
    invalid(&mut nb, undo(&graded_first, 100, 103, Some(3), 1000));
    assert_eq!(
        nb.review_session(&id(50)).unwrap().state,
        ReviewSessionState::Abandoned
    );
    assert_eq!(nb.card(&first.id).unwrap(), graded_first);
    assert_eq!(nb.review_session_events(&id(50)).unwrap().len(), 1);
}

#[test]
fn undo_restores_trained_state_and_never_erases_or_crosses_a_reset() {
    let (_dir, mut nb, original) = fixture();
    apply(&mut nb, vec![grade(&original, 100, None, false, 1000)]);
    let trained = nb.card(&original.id).unwrap();
    apply(&mut nb, vec![grade(&trained, 101, None, false, 2000)]);
    let twice = nb.card(&original.id).unwrap();
    invalid(&mut nb, undo(&twice, 100, 102, None, 2000));
    invalid(&mut nb, undo(&twice, 101, 102, Some(1), 2000));
    apply(&mut nb, vec![undo(&twice, 101, 102, None, 2000)]);
    assert_eq!(nb.card(&original.id).unwrap().schedule, trained.schedule);
    let current = nb.card(&original.id).unwrap();
    apply(&mut nb, vec![grade(&current, 103, None, true, 3000)]);
    let reset_grade = nb.card(&original.id).unwrap();
    apply(&mut nb, vec![undo(&reset_grade, 103, 104, None, 3000)]);
    let reset_state = nb.card(&original.id).unwrap();
    assert_eq!(
        reset_state.schedule,
        tessera_core::scheduler::new_card(3000)
    );
    let history = nb.review_events(&original.id).unwrap();
    assert_eq!(history.len(), 4);
    assert_eq!(history[2].kind, ReviewEventKind::Reset);
    assert!(history[2].undone_by.is_none());
    assert_eq!(history[3].undone_by, Some(id(104)));
    invalid(&mut nb, undo(&reset_state, 100, 105, None, 3000));
    assert_eq!(nb.card(&original.id).unwrap(), reset_state);
}
