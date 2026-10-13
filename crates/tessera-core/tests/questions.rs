use tessera_core::question_store::{nearest_question_ancestor, question_status};
use tessera_core::{
    Actor, AssessmentState, Batch, Committed, Error, Notebook, Operation, QuestionQuery,
    QuestionState, QuestionStatus,
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
fn insert(value: u128, parent: u128) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: None,
        text: format!("Block {value}"),
        heading: None,
    }
}
fn question(nb: &Notebook, value: u128, state: Option<QuestionState>) -> Operation {
    Operation::SetQuestion {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        question: state,
    }
}
fn assessment(nb: &Notebook, value: u128) -> Operation {
    Operation::SetAssessment {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        assessment: Some(AssessmentState {
            assessed_on: "2026-10-06".into(),
            aporia: false,
        }),
    }
}
fn set_question(nb: &mut Notebook, value: u128, state: QuestionState) -> Committed {
    let op = question(nb, value, Some(state));
    apply(nb, vec![op])
}
fn status(nb: &Notebook, value: u128) -> QuestionStatus {
    nb.capabilities(&id(value))
        .unwrap()
        .question
        .unwrap()
        .status
}
fn state(nb: &Notebook, value: u128) -> QuestionState {
    nb.capabilities(&id(value)).unwrap().question.unwrap().state
}
fn accept(nb: &mut Notebook, value: u128) -> Committed {
    let next = QuestionState {
        accepted: Some(id(value)),
        ..state(nb, 10)
    };
    set_question(nb, 10, next)
}
fn park(nb: &mut Notebook, parked: bool) {
    let next = QuestionState {
        parked,
        ..state(nb, 10)
    };
    set_question(nb, 10, next);
}
fn reject(nb: &mut Notebook, op: Operation, expected: &str) {
    match nb.apply(&batch(vec![op])) {
        Err(Error::Validation { message, .. }) => assert!(message.contains(expected), "{message}"),
        other => panic!("Expected validation, got {other:?}"),
    }
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Questions".into(),
            },
            insert(10, 1),
            insert(11, 10),
            insert(12, 10),
            insert(20, 1),
        ],
    );
    set_question(&mut nb, 10, QuestionState::default());
    (dir, nb)
}

#[test]
fn question_status_precedence_covers_every_combination() {
    for parked in [false, true] {
        for unsettled in [false, true] {
            for accepted_live in [false, true] {
                let state = QuestionState {
                    parked,
                    unsettled,
                    accepted: Some(id(11)),
                    review_on: None,
                    parent: None,
                };
                let expected = if parked {
                    "parked"
                } else if unsettled {
                    "unsettled"
                } else if accepted_live {
                    "answered"
                } else {
                    "open"
                };
                assert_eq!(
                    serde_json::to_value(question_status(&state, accepted_live)).unwrap(),
                    expected
                );
            }
        }
    }
}

#[test]
fn accepting_supersedes_and_receipts_refresh_both_assessments() {
    let (_dir, mut nb) = fixture();
    let ops = vec![assessment(&nb, 11), assessment(&nb, 12)];
    apply(&mut nb, ops);
    accept(&mut nb, 11);
    let commit = accept(&mut nb, 12);
    assert_eq!(status(&nb, 10), QuestionStatus::Answered);
    for (value, accepted) in [(11, false), (12, true)] {
        assert_eq!(
            commit
                .capabilities
                .iter()
                .find(|c| c.block_id == id(value))
                .unwrap()
                .assessment
                .as_ref()
                .unwrap()
                .accepted,
            accepted
        );
        assert_eq!(
            nb.capabilities(&id(value))
                .unwrap()
                .assessment
                .unwrap()
                .accepted,
            accepted
        );
    }
    assert!(nb.block(&id(11)).is_ok());
    assert_eq!(commit.revisions.len(), 1);
    let page = nb.page(&id(1)).unwrap();
    assert_eq!(
        page.capabilities
            .iter()
            .find(|c| c.block_id == id(10))
            .unwrap()
            .question
            .as_ref()
            .unwrap()
            .status,
        QuestionStatus::Answered
    );
    let noop = accept(&mut nb, 12);
    assert!(noop.revisions.is_empty());
}

#[test]
fn accepted_answer_hidden_moved_deleted_or_removed_reopens_question() {
    for mode in ["archive", "move", "delete", "remove", "archive_parent"] {
        let (_dir, mut nb) = fixture();
        let op = assessment(&nb, 11);
        apply(&mut nb, vec![op]);
        accept(&mut nb, 11);
        let revision = nb.block(&id(11)).unwrap().revision;
        let op = match mode {
            "archive" => Operation::SetArchived {
                id: id(11),
                base_revision: revision,
                archived: true,
            },
            "move" => Operation::Move {
                id: id(11),
                base_revision: revision,
                parent_id: id(20),
                after: None,
            },
            "delete" => Operation::Delete {
                id: id(11),
                base_revision: revision,
            },
            "remove" => Operation::SetAssessment {
                id: id(11),
                base_revision: revision,
                assessment: None,
            },
            _ => Operation::SetArchived {
                id: id(10),
                base_revision: nb.block(&id(10)).unwrap().revision,
                archived: true,
            },
        };
        let receipt = apply(&mut nb, vec![op]);
        assert_eq!(status(&nb, 10), QuestionStatus::Open, "{mode}");
        assert_eq!(
            receipt
                .capabilities
                .iter()
                .find(|c| c.block_id == id(10))
                .unwrap()
                .question
                .as_ref()
                .unwrap()
                .status,
            QuestionStatus::Open,
            "{mode}"
        );
        assert_eq!(state(&nb, 10).accepted, (mode != "remove").then(|| id(11)));
        assert!(
            !nb.capabilities(&id(11))
                .unwrap()
                .assessment
                .is_some_and(|a| a.accepted)
        );
    }
}

#[test]
fn parked_rejects_acceptance_and_new_answers_then_resume_restores_status() {
    let (_dir, mut nb) = fixture();
    let op = assessment(&nb, 11);
    apply(&mut nb, vec![op]);
    accept(&mut nb, 11);
    park(&mut nb, true);
    assert_eq!(status(&nb, 10), QuestionStatus::Parked);
    let op = assessment(&nb, 12);
    reject(&mut nb, op, "Resume the question before answering it.");
    for parked in [false, true] {
        let op = question(
            &nb,
            10,
            Some(QuestionState {
                parked,
                accepted: Some(id(12)),
                ..state(&nb, 10)
            }),
        );
        reject(
            &mut nb,
            op,
            "Resume the question before accepting an answer.",
        );
    }
    park(&mut nb, false);
    assert_eq!(status(&nb, 10), QuestionStatus::Answered);
    let op = assessment(&nb, 12);
    apply(&mut nb, vec![op]);
    let op = question(
        &nb,
        10,
        Some(QuestionState {
            parked: true,
            accepted: Some(id(12)),
            ..state(&nb, 10)
        }),
    );
    reject(
        &mut nb,
        op,
        "Resume the question before accepting an answer.",
    );
}

#[test]
fn unsettled_accepts_current_reading_without_settling_and_records_aporia() {
    let (_dir, mut nb) = fixture();
    set_question(
        &mut nb,
        10,
        QuestionState {
            unsettled: true,
            ..QuestionState::default()
        },
    );
    let op = Operation::SetAssessment {
        id: id(11),
        base_revision: 1,
        assessment: Some(AssessmentState {
            assessed_on: "2026-10-06".into(),
            aporia: true,
        }),
    };
    apply(&mut nb, vec![op]);
    accept(&mut nb, 11);
    assert_eq!(status(&nb, 10), QuestionStatus::Unsettled);
    assert!(
        nb.capabilities(&id(11))
            .unwrap()
            .assessment
            .unwrap()
            .state
            .aporia
    );
    park(&mut nb, true);
    park(&mut nb, false);
    assert_eq!(status(&nb, 10), QuestionStatus::Unsettled);
}

#[test]
fn ancestry_exclusivity_dates_and_acceptance_are_validated() {
    let (dir, mut nb) = fixture();
    let op = assessment(&nb, 20);
    reject(&mut nb, op, "Put the answer under a question first.");
    let op = assessment(&nb, 10);
    reject(&mut nb, op, "both a question and an answer");
    let op = assessment(&nb, 11);
    apply(&mut nb, vec![op]);
    let op = question(&nb, 11, Some(QuestionState::default()));
    reject(&mut nb, op, "both a question and an answer");
    let op = question(
        &nb,
        10,
        Some(QuestionState {
            accepted: Some(id(20)),
            ..state(&nb, 10)
        }),
    );
    reject(&mut nb, op, "active answer");
    let op = question(
        &nb,
        10,
        Some(QuestionState {
            review_on: Some("2026-02-29".into()),
            ..state(&nb, 10)
        }),
    );
    reject(&mut nb, op, "date");
    let op = Operation::SetAssessment {
        id: id(12),
        base_revision: 1,
        assessment: Some(AssessmentState {
            assessed_on: "2026-2-01".into(),
            aporia: false,
        }),
    };
    reject(&mut nb, op, "date");
    set_question(&mut nb, 1, QuestionState::default());
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    assert_eq!(
        nearest_question_ancestor(&conn, &id(11)).unwrap(),
        Some(id(10))
    );
    assert_eq!(
        nearest_question_ancestor(&conn, &id(10)).unwrap(),
        Some(id(1))
    );
    assert_eq!(nearest_question_ancestor(&conn, &id(1)).unwrap(), None);
    let op = Operation::SetQuestion {
        id: id(10),
        base_revision: 1,
        question: None,
    };
    assert!(matches!(
        nb.apply(&batch(vec![op])),
        Err(Error::Conflict { .. })
    ));
}

#[test]
fn nested_questions_reparent_assessments_and_refresh_previous_owner() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![insert(13, 12)]);
    let op = assessment(&nb, 13);
    apply(&mut nb, vec![op]);
    accept(&mut nb, 13);
    let receipt = set_question(&mut nb, 12, QuestionState::default());
    assert_eq!(status(&nb, 10), QuestionStatus::Open);
    assert_eq!(
        nb.capabilities(&id(13))
            .unwrap()
            .assessment
            .unwrap()
            .question_id,
        Some(id(12))
    );
    assert!(receipt.capabilities.iter().any(|c| c.block_id == id(10)));
    let op = question(&nb, 12, None);
    apply(&mut nb, vec![op]);
    assert_eq!(status(&nb, 10), QuestionStatus::Answered);
}

#[test]
fn review_by_filters_nonparked_visible_questions_before_limit() {
    let (_dir, mut nb) = fixture();
    set_question(
        &mut nb,
        10,
        QuestionState {
            review_on: Some("2026-10-06".into()),
            ..QuestionState::default()
        },
    );
    set_question(
        &mut nb,
        20,
        QuestionState {
            parked: true,
            review_on: Some("2026-10-01".into()),
            ..QuestionState::default()
        },
    );
    set_question(
        &mut nb,
        12,
        QuestionState {
            unsettled: true,
            review_on: Some("2026-10-07".into()),
            ..QuestionState::default()
        },
    );
    let rows = nb
        .questions(&QuestionQuery {
            review_by: Some("2026-10-06".into()),
            ..QuestionQuery::default()
        })
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.block.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10)]
    );
    let rows = nb
        .questions(&QuestionQuery {
            status: Some(QuestionStatus::Unsettled),
            limit: Some(1),
            ..QuestionQuery::default()
        })
        .unwrap();
    assert_eq!(rows[0].block.block.id, id(12));
    assert!(
        nb.questions(&QuestionQuery {
            limit: Some(0),
            ..QuestionQuery::default()
        })
        .unwrap()
        .is_empty()
    );
    let op = Operation::SetArchived {
        id: id(10),
        base_revision: nb.block(&id(10)).unwrap().revision,
        archived: true,
    };
    apply(&mut nb, vec![op]);
    assert!(
        nb.questions(&QuestionQuery {
            review_by: Some("2026-10-09".into()),
            ..QuestionQuery::default()
        })
        .unwrap()
        .is_empty()
    );
    assert!(
        nb.questions(&QuestionQuery {
            review_by: Some("bad".into()),
            ..QuestionQuery::default()
        })
        .is_err()
    );
}

#[test]
fn stale_acceptance_allows_resume_and_question_removal_is_reversible() {
    let (_dir, mut nb) = fixture();
    let op = assessment(&nb, 11);
    apply(&mut nb, vec![op]);
    accept(&mut nb, 11);
    let previous = state(&nb, 10);
    let op = question(&nb, 10, None);
    let removed = apply(&mut nb, vec![op]);
    assert!(
        !removed
            .capabilities
            .iter()
            .find(|c| c.block_id == id(11))
            .unwrap()
            .assessment
            .as_ref()
            .unwrap()
            .accepted
    );
    set_question(&mut nb, 10, previous);
    assert_eq!(status(&nb, 10), QuestionStatus::Answered);
    park(&mut nb, true);
    let op = Operation::SetArchived {
        id: id(11),
        base_revision: nb.block(&id(11)).unwrap().revision,
        archived: true,
    };
    apply(&mut nb, vec![op]);
    park(&mut nb, false);
    assert_eq!(status(&nb, 10), QuestionStatus::Open);
    let next = QuestionState {
        review_on: Some("2026-10-07".into()),
        ..state(&nb, 10)
    };
    set_question(&mut nb, 10, next);
    assert_eq!(state(&nb, 10).accepted, Some(id(11)));
}

#[test]
fn merging_answer_container_refreshes_old_and_new_questions() {
    let (_dir, mut nb) = fixture();
    set_question(&mut nb, 20, QuestionState::default());
    apply(&mut nb, vec![insert(13, 12), insert(21, 20)]);
    let op = assessment(&nb, 13);
    apply(&mut nb, vec![op]);
    accept(&mut nb, 13);
    let receipt = apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(12),
            source_revision: 1,
            destination_id: id(21),
            destination_revision: 1,
        }],
    );
    for owner in [10, 20] {
        assert!(receipt.capabilities.iter().any(|c| c.block_id == id(owner)));
    }
    assert_eq!(
        nb.capabilities(&id(13))
            .unwrap()
            .assessment
            .unwrap()
            .question_id,
        Some(id(20))
    );
    assert_eq!(status(&nb, 10), QuestionStatus::Open);
}

#[test]
fn removing_an_accepted_assessment_clears_acceptance_and_both_states_restore() {
    let (_dir, mut nb) = fixture();
    let op = assessment(&nb, 11);
    apply(&mut nb, vec![op]);
    accept(&mut nb, 11);
    let accepted = state(&nb, 10);
    let revision = nb.block(&id(10)).unwrap().revision;
    let remove = Operation::SetAssessment {
        id: id(11),
        base_revision: nb.block(&id(11)).unwrap().revision,
        assessment: None,
    };
    let removed = apply(&mut nb, vec![remove]);
    assert_eq!(state(&nb, 10).accepted, None);
    assert_eq!(status(&nb, 10), QuestionStatus::Open);
    assert_eq!(nb.block(&id(10)).unwrap().revision, revision + 1);
    assert!(
        removed
            .capabilities
            .iter()
            .any(|row| row.block_id == id(10))
    );
    let preceding = state(&nb, 10);
    let op = question(&nb, 10, None);
    apply(&mut nb, vec![op]);
    let op = question(&nb, 10, Some(preceding));
    apply(&mut nb, vec![op]);
    assert_eq!(status(&nb, 10), QuestionStatus::Open);
    let ops = vec![assessment(&nb, 11), question(&nb, 10, Some(accepted))];
    apply(&mut nb, ops);
    assert_eq!(status(&nb, 10), QuestionStatus::Answered);
    assert!(
        nb.capabilities(&id(11))
            .unwrap()
            .assessment
            .unwrap()
            .accepted
    );
}

#[test]
fn parent_questions_validate_cycles_and_restore_dangling_relations() {
    let (_dir, mut nb) = fixture();
    set_question(&mut nb, 1, QuestionState::default());
    set_question(&mut nb, 11, QuestionState::default());
    set_question(&mut nb, 20, QuestionState::default());
    let structural = nb.capabilities(&id(11)).unwrap().question.unwrap();
    assert_eq!(structural.parent_id, Some(id(10)));
    assert!(!structural.parent_explicit);
    for (parent, expected) in [
        (10, "own parent"),
        (11, "own branch"),
        (12, "live question"),
    ] {
        let op = question(
            &nb,
            10,
            Some(QuestionState {
                parent: Some(id(parent)),
                ..state(&nb, 10)
            }),
        );
        reject(&mut nb, op, expected);
    }
    let next = QuestionState {
        parent: Some(id(20)),
        ..state(&nb, 10)
    };
    set_question(&mut nb, 10, next.clone());
    let op = question(
        &nb,
        20,
        Some(QuestionState {
            parent: Some(id(11)),
            ..state(&nb, 20)
        }),
    );
    reject(&mut nb, op, "own branch");
    let op = Operation::Move {
        id: id(20),
        base_revision: nb.block(&id(20)).unwrap().revision,
        parent_id: id(11),
        after: None,
    };
    reject(&mut nb, op, "own branch");
    let parent_state = state(&nb, 20);
    let child_revision = nb.block(&id(10)).unwrap().revision;
    let op = question(&nb, 20, None);
    let receipt = apply(&mut nb, vec![op]);
    let child = nb.capabilities(&id(10)).unwrap().question.unwrap();
    assert_eq!(child.state, next);
    assert_eq!(child.parent_id, Some(id(1)));
    assert!(!child.parent_explicit);
    assert_eq!(nb.block(&id(10)).unwrap().revision, child_revision);
    assert!(receipt.capabilities.iter().any(|c| c.block_id == id(10)));
    let remove_child = question(&nb, 10, None);
    apply(&mut nb, vec![remove_child]);
    set_question(&mut nb, 10, next.clone());
    assert_eq!(state(&nb, 10), next);
    assert_eq!(
        nb.capabilities(&id(10))
            .unwrap()
            .question
            .unwrap()
            .parent_id,
        Some(id(1))
    );
    set_question(&mut nb, 20, parent_state);
    assert!(
        nb.capabilities(&id(10))
            .unwrap()
            .question
            .unwrap()
            .parent_explicit
    );
    let base_revision = nb.block(&id(20)).unwrap().revision;
    let deleted = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(20),
            base_revision,
        }],
    );
    assert_eq!(
        nb.capabilities(&id(10))
            .unwrap()
            .question
            .unwrap()
            .parent_id,
        Some(id(1))
    );
    let revision = base_revision + 1;
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(20),
            deletion_id: deleted.deletions[0].clone(),
            revision,
        }],
    );
    assert_eq!(
        nb.capabilities(&id(10))
            .unwrap()
            .question
            .unwrap()
            .parent_id,
        Some(id(20))
    );
}

#[test]
fn branches_include_inline_questions_and_count_their_positions() {
    let (_dir, mut nb) = fixture();
    set_question(&mut nb, 11, QuestionState::default());
    set_question(
        &mut nb,
        20,
        QuestionState {
            parent: Some(id(10)),
            ..QuestionState::default()
        },
    );
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(30),
                title: "Holder".into(),
            },
            Operation::Insert {
                id: id(31),
                parent_id: id(11),
                after: None,
                text: format!("[[{}]]", id(30)),
                heading: None,
            },
            Operation::SetPosition {
                id: id(31),
                base_revision: 1,
                position: true,
            },
        ],
    );
    let branches = nb
        .questions(&QuestionQuery {
            parent: Some(id(10)),
            ..QuestionQuery::default()
        })
        .unwrap();
    assert_eq!(
        branches
            .iter()
            .map(|row| (row.block.block.id.clone(), row.position_count))
            .collect::<Vec<_>>(),
        vec![(id(11), 1), (id(20), 0)]
    );
    assert_eq!(
        nb.capabilities(&id(31))
            .unwrap()
            .position
            .unwrap()
            .subject_id,
        id(11)
    );
    let op = question(&nb, 11, None);
    let receipt = apply(&mut nb, vec![op]);
    assert_eq!(
        nb.capabilities(&id(31))
            .unwrap()
            .position
            .unwrap()
            .subject_id,
        id(10)
    );
    assert!(receipt.capabilities.iter().any(|c| c.block_id == id(31)));
}

#[test]
fn older_question_states_read_without_parent() {
    let state: QuestionState = serde_json::from_str(
        r#"{"unsettled":false,"parked":false,"review_on":null,"accepted":null}"#,
    )
    .unwrap();
    assert_eq!(state.parent, None);
    assert!(serde_json::to_value(state).unwrap().get("parent").is_none());
}
