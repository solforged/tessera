use tessera_core::{
    Actor, AgentEdit, AgentRequest, Batch, ChangeStamp, Notebook, Operation, QuestionState,
    RevisitAction, RevisitSnapshot,
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "A concept".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "A branch".into(),
                heading: None,
            },
            Operation::SetQuestion {
                id: id(2),
                base_revision: 1,
                question: Some(QuestionState::default()),
            },
        ],
    );
    (dir, nb)
}
fn revisit(
    nb: &mut Notebook,
    value: u128,
    action: RevisitAction,
    next: Option<&str>,
) -> tessera_core::AgentReceipt {
    nb.agent_edit(&AgentRequest {
        actor: Actor::Agent {
            name: "Researcher".into(),
        },
        reason: None,
        edit: AgentEdit::Revisit {
            id: id(value),
            revision: Some(nb.block(&id(value)).unwrap().revision),
            action,
            next_on: next.map(str::to_owned),
        },
    })
    .unwrap()
}

#[test]
fn due_queue_orders_inline_questions_and_notes_and_survives_reopening() {
    let (dir, mut nb) = fixture();
    revisit(&mut nb, 2, RevisitAction::Later, Some("2026-10-12"));
    revisit(&mut nb, 1, RevisitAction::Later, Some("2026-10-11"));
    let rows = nb.revisits("2026-10-12", tessera_core::now_ms()).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.block.block.id.clone())
            .collect::<Vec<_>>(),
        [id(1), id(2)]
    );
    assert!(rows[1].question_status.is_some());
    assert!(
        nb.capabilities(&id(2))
            .unwrap()
            .note
            .unwrap()
            .revisit_on
            .is_none()
    );
    drop(nb);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(
        nb.revisits("2026-10-12", tessera_core::now_ms()).unwrap(),
        rows
    );
}

#[test]
fn parked_page_and_inline_questions_resume_on_their_original_date() {
    let (_dir, mut nb) = fixture();
    for value in [1, 2] {
        let revision = nb.block(&id(value)).unwrap().revision;
        apply(
            &mut nb,
            vec![Operation::SetQuestion {
                id: id(value),
                base_revision: revision,
                question: Some(QuestionState {
                    parked: true,
                    review_on: Some("2026-10-12".into()),
                    ..Default::default()
                }),
            }],
        );
    }
    assert!(
        nb.revisits("2026-10-12", tessera_core::now_ms())
            .unwrap()
            .is_empty()
    );
    for value in [1, 2] {
        let mut question = nb.capabilities(&id(value)).unwrap().question.unwrap().state;
        assert_eq!(question.review_on.as_deref(), Some("2026-10-12"));
        question.parked = false;
        let revision = nb.block(&id(value)).unwrap().revision;
        apply(
            &mut nb,
            vec![Operation::SetQuestion {
                id: id(value),
                base_revision: revision,
                question: Some(question),
            }],
        );
    }
    assert!(
        nb.revisits("2026-10-11", tessera_core::now_ms())
            .unwrap()
            .is_empty()
    );
    let rows = nb.revisits("2026-10-12", tessera_core::now_ms()).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.block.block.id.clone())
            .collect::<Vec<_>>(),
        [id(1), id(2)]
    );
}

#[test]
fn revisit_records_attribution_and_undo_restores_date_and_removes_event() {
    let (_dir, mut nb) = fixture();
    revisit(&mut nb, 2, RevisitAction::Later, Some("2026-10-12"));
    let before = nb.capabilities(&id(2)).unwrap();
    let receipt = revisit(&mut nb, 2, RevisitAction::Revisited, Some("2099-10-12"));
    let events = nb.revisit_events(&id(2)).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].actor,
        Actor::Agent {
            name: "Researcher".into()
        }
    );
    assert!(
        nb.revisits("2026-10-12", tessera_core::now_ms())
            .unwrap()
            .is_empty()
    );
    nb.undo_change(receipt.seq, &Actor::Person).unwrap();
    assert!(nb.revisit_events(&id(2)).unwrap().is_empty());
    let after = nb.capabilities(&id(2)).unwrap();
    assert_eq!(after.note, before.note);
    assert_eq!(after.question, before.question);
}

#[test]
fn later_resolution_reopening_and_recurrent_keep_acceptance_separate() {
    let (_dir, mut nb) = fixture();
    revisit(&mut nb, 1, RevisitAction::Later, Some("2026-10-12"));
    revisit(&mut nb, 1, RevisitAction::Later, Some("2026-11-12"));
    assert!(nb.revisit_events(&id(1)).unwrap().is_empty());
    revisit(&mut nb, 1, RevisitAction::Resolve, None);
    let note = nb.capabilities(&id(1)).unwrap().note.unwrap();
    assert!(note.resolved_at.is_some());
    assert!(note.revisit_on.is_none());
    let revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: id(1),
            base_revision: revision,
            text: "Edited resolved concept".into(),
        }],
    );
    assert_eq!(nb.capabilities(&id(1)).unwrap().note.unwrap(), note);
    revisit(&mut nb, 1, RevisitAction::Reopen, None);
    assert!(nb.capabilities(&id(1)).unwrap().note.is_none());
    revisit(&mut nb, 2, RevisitAction::KeepRecurrent, Some("2026-11-12"));
    assert!(
        nb.capabilities(&id(2))
            .unwrap()
            .question
            .unwrap()
            .state
            .unsettled
    );
    assert_eq!(nb.revisit_events(&id(2)).unwrap().len(), 1);
    revisit(&mut nb, 2, RevisitAction::Resolve, None);
    let question = nb.capabilities(&id(2)).unwrap().question.unwrap().state;
    assert!(!question.unsettled);
    assert!(question.review_on.is_none());
    assert!(question.accepted.is_none());
    assert_eq!(nb.revisit_events(&id(2)).unwrap().len(), 1);
}

#[test]
fn first_proposal_uses_date_set_time_and_stale_undo_cannot_overwrite() {
    let (_dir, mut nb) = fixture();
    let set_at = jiff::Timestamp::from_second(1_759_276_800)
        .unwrap()
        .as_millisecond();
    let now = set_at + 7 * 86_400_000;
    let today = nb.today(now).unwrap();
    nb.apply_stamped(
        &Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![Operation::Revisit {
                id: id(1),
                base_revision: 1,
                action: RevisitAction::Later,
                next_on: Some(today.clone()),
                event_id: None,
            }],
        },
        &ChangeStamp {
            id: id(100),
            origin: id(101),
            at: set_at,
        },
    )
    .unwrap();
    let row = nb.revisits(&today, now).unwrap().remove(0);
    assert_eq!(
        row.proposed_on,
        tessera_core::calendar::add_days(&today, 7).unwrap()
    );
    let receipt = revisit(&mut nb, 1, RevisitAction::Revisited, None);
    revisit(&mut nb, 1, RevisitAction::Later, Some("2099-01-01"));
    assert!(nb.undo_change(receipt.seq, &Actor::Person).is_err());
    assert_eq!(
        nb.capabilities(&id(1))
            .unwrap()
            .note
            .unwrap()
            .revisit_on
            .as_deref(),
        Some("2099-01-01")
    );
}

#[test]
fn ordinary_blocks_cannot_revisit_and_restore_is_revision_checked() {
    let (_dir, mut nb) = fixture();
    let before = nb.capabilities(&id(2)).unwrap();
    let revision = nb.block(&id(2)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::SetQuestion {
            id: id(2),
            base_revision: revision,
            question: None,
        }],
    );
    let request = Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: vec![Operation::Revisit {
            id: id(2),
            base_revision: nb.block(&id(2)).unwrap().revision,
            action: RevisitAction::Later,
            next_on: Some("2026-10-12".into()),
            event_id: None,
        }],
    };
    assert!(nb.apply(&request).is_err());
    let invalid_restore = Batch {
        operations: vec![Operation::RestoreRevisit {
            id: id(2),
            base_revision: nb.block(&id(2)).unwrap().revision,
            state: RevisitSnapshot {
                note: tessera_core::NoteState {
                    revisit_on: Some("2026-10-12".into()),
                    ..Default::default()
                },
                question: None,
            },
            event_id: None,
        }],
        ..request.clone()
    };
    assert!(nb.apply(&invalid_restore).is_err());
    let mut duplicate_date = invalid_restore.clone();
    if let Operation::RestoreRevisit { state, .. } = &mut duplicate_date.operations[0] {
        state.question = Some(QuestionState {
            review_on: Some("2026-10-13".into()),
            ..Default::default()
        });
    }
    assert!(nb.apply(&duplicate_date).is_err());
    let stale = Batch {
        operations: vec![Operation::RestoreRevisit {
            id: id(2),
            base_revision: revision,
            state: RevisitSnapshot {
                note: before.note.unwrap_or_default(),
                question: before.question.map(|q| q.state),
            },
            event_id: None,
        }],
        ..request
    };
    assert!(nb.apply(&stale).is_err());
}
