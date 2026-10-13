mod common;

use tessera_core::{
    Actor, AgentEdit, AgentRequest, AssessmentState, Batch, Committed, Error, Notebook, Operation,
    QuestionState, RelationInfo, RelationKind, RelationQuery,
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

fn revision(nb: &Notebook, value: u128) -> i64 {
    nb.block(&id(value)).unwrap().revision
}

fn relation(nb: &Notebook, value: u128, kind: Option<RelationKind>) -> Operation {
    Operation::SetRelation {
        id: id(value),
        base_revision: revision(nb, value),
        relation: kind,
    }
}

fn set(nb: &mut Notebook, value: u128, kind: Option<RelationKind>) -> Committed {
    let op = relation(nb, value, kind);
    apply(nb, vec![op])
}

fn info(nb: &Notebook, value: u128) -> RelationInfo {
    nb.capabilities(&id(value)).unwrap().relation.unwrap()
}

fn edit(nb: &mut Notebook, value: u128, text: &str) -> Committed {
    let base_revision = revision(nb, value);
    apply(
        nb,
        vec![Operation::EditText {
            id: id(value),
            base_revision,
            text: text.into(),
        }],
    )
}

fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Question".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Source holder".into(),
            },
            Operation::CreatePage {
                id: id(3),
                title: "Target holder".into(),
            },
            Operation::CreatePage {
                id: id(4),
                title: "Other page".into(),
            },
            Operation::SetQuestion {
                id: id(1),
                base_revision: 1,
                question: Some(QuestionState::default()),
            },
            insert(10, 1, &format!("[[{}]]", id(2))),
            Operation::SetPosition {
                id: id(10),
                base_revision: 1,
                position: true,
            },
            insert(11, 10, "A closer question"),
            Operation::SetQuestion {
                id: id(11),
                base_revision: 1,
                question: Some(QuestionState::default()),
            },
            insert(12, 11, "Reasoning"),
            insert(13, 12, &format!("Disputes [[{}]]", id(20))),
            insert(20, 1, &format!("[[{}]]", id(3))),
            Operation::SetPosition {
                id: id(20),
                base_revision: 1,
                position: true,
            },
            insert(30, 1, "Another question"),
            Operation::SetQuestion {
                id: id(30),
                base_revision: 1,
                question: Some(QuestionState::default()),
            },
            insert(31, 30, "An assessment"),
            Operation::SetAssessment {
                id: id(31),
                base_revision: 1,
                assessment: Some(AssessmentState {
                    assessed_on: "2026-10-12".into(),
                    aporia: false,
                }),
            },
            insert(40, 1, "Ordinary block"),
        ],
    );
    (dir, nb)
}

#[test]
fn marking_is_explicit_revision_checked_retained_and_merge_protected() {
    let (dir, mut nb) = fixture();
    assert!(nb.capabilities(&id(13)).unwrap().relation.is_none());
    let original = revision(&nb, 13);
    let stale = relation(&nb, 13, Some(RelationKind::Supports));
    let receipt = set(&mut nb, 13, Some(RelationKind::Disputes));
    assert_eq!(revision(&nb, 13), original + 1);
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|cap| cap.block_id == id(13) && cap.merge_protected)
    );
    assert!(matches!(
        nb.apply(&batch(vec![stale])),
        Err(Error::Conflict { .. })
    ));
    assert!(
        set(&mut nb, 13, Some(RelationKind::Disputes))
            .revisions
            .is_empty()
    );
    assert!(
        nb.page(&id(1))
            .unwrap()
            .capabilities
            .iter()
            .any(|cap| cap.block_id == id(13) && cap.relation.is_some())
    );
    let merge = Operation::Merge {
        source_id: id(13),
        source_revision: revision(&nb, 13),
        destination_id: id(40),
        destination_revision: revision(&nb, 40),
    };
    assert!(matches!(
        nb.apply(&batch(vec![merge])),
        Err(Error::Validation { .. })
    ));
    drop(nb);
    let mut nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(info(&nb, 13).kind, RelationKind::Disputes);
    set(&mut nb, 13, None);
    assert!(!nb.capabilities(&id(13)).unwrap().merge_protected);
    assert!(set(&mut nb, 13, None).revisions.is_empty());
}

#[test]
fn incompatible_capabilities_are_refused_in_both_directions_atomically() {
    for capability in ["position", "question", "assessment"] {
        for relation_first in [false, true] {
            let (_dir, mut nb) = fixture();
            let other = |revision| match capability {
                "position" => Operation::SetPosition {
                    id: id(40),
                    base_revision: revision,
                    position: true,
                },
                "question" => Operation::SetQuestion {
                    id: id(40),
                    base_revision: revision,
                    question: Some(QuestionState::default()),
                },
                _ => Operation::SetAssessment {
                    id: id(40),
                    base_revision: revision,
                    assessment: Some(AssessmentState {
                        assessed_on: "2026-10-12".into(),
                        aporia: false,
                    }),
                },
            };
            let edge = |revision| Operation::SetRelation {
                id: id(40),
                base_revision: revision,
                relation: Some(RelationKind::Supports),
            };
            let operations = if relation_first {
                vec![edge(1), other(2)]
            } else {
                vec![other(1), edge(2)]
            };
            match nb.apply(&batch(operations)) {
                Err(Error::Validation { message, .. }) => {
                    assert!(message.contains("relation"), "{message}")
                }
                other => panic!("expected exclusivity refusal, got {other:?}"),
            }
            assert_eq!(revision(&nb, 40), 1);
            let caps = nb.capabilities(&id(40)).unwrap();
            assert!(
                caps.relation.is_none()
                    && caps.position.is_none()
                    && caps.question.is_none()
                    && caps.assessment.is_none()
            );
        }
    }
}

#[test]
fn ancestry_prioritizes_positions_and_assessments_then_questions_then_page() {
    let (_dir, mut nb) = fixture();
    set(&mut nb, 13, Some(RelationKind::Disputes));
    assert_eq!(info(&nb, 13).source_id, id(10));
    let op = Operation::SetPosition {
        id: id(10),
        base_revision: revision(&nb, 10),
        position: false,
    };
    let receipt = apply(&mut nb, vec![op]);
    assert_eq!(info(&nb, 13).source_id, id(11));
    for value in [10, 11, 13, 20] {
        assert!(
            receipt
                .capabilities
                .iter()
                .any(|cap| cap.block_id == id(value))
        );
    }
    let op = Operation::SetQuestion {
        id: id(11),
        base_revision: revision(&nb, 11),
        question: None,
    };
    apply(&mut nb, vec![op]);
    assert_eq!(info(&nb, 13).source_id, id(1));
    let op = Operation::Move {
        id: id(12),
        base_revision: revision(&nb, 12),
        parent_id: id(31),
        after: None,
    };
    let receipt = apply(&mut nb, vec![op]);
    assert_eq!(info(&nb, 13).source_id, id(31));
    assert!(receipt.capabilities.iter().any(|cap| cap.block_id == id(13) && cap.relation.as_ref().unwrap().source_id == id(31)));
    let op = Operation::Move {
        id: id(12),
        base_revision: revision(&nb, 12),
        parent_id: id(4),
        after: None,
    };
    apply(&mut nb, vec![op]);
    assert_eq!(info(&nb, 13).source_id, id(4));
    assert_eq!(
        nb.relations(&RelationQuery {
            source: Some(id(4)),
            ..Default::default()
        })
        .unwrap()[0]
            .block
            .page
            .id,
        id(4)
    );
}

#[test]
fn target_tracks_first_link_deletion_visibility_and_question_state() {
    let (_dir, mut nb) = fixture();
    set(&mut nb, 13, Some(RelationKind::Answers));
    assert!(info(&nb, 13).problem.unwrap().contains("question"));
    let receipt = edit(&mut nb, 13, &format!("[[{}]] then [[{}]]", id(30), id(20)));
    assert_eq!(info(&nb, 13).target_id, Some(id(30)));
    assert!(info(&nb, 13).problem.is_none());
    for value in [13, 20, 30] {
        assert!(
            receipt
                .capabilities
                .iter()
                .any(|cap| cap.block_id == id(value))
        );
    }
    let op = Operation::SetQuestion {
        id: id(30),
        base_revision: revision(&nb, 30),
        question: None,
    };
    let receipt = apply(&mut nb, vec![op]);
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|cap| cap.block_id == id(13) && cap.relation.as_ref().unwrap().problem.is_some())
    );
    let op = Operation::Delete {
        id: id(30),
        base_revision: revision(&nb, 30),
    };
    let deleted = apply(&mut nb, vec![op]);
    assert!(info(&nb, 13).target_id.is_none());
    assert!(info(&nb, 13).problem.unwrap().contains("deleted"));
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(30),
            deletion_id: deleted.deletions[0].clone(),
            revision: nb_revision_after_delete(&deleted, 30),
        }],
    );
    assert_eq!(info(&nb, 13).target_id, Some(id(30)));
    let op = Operation::SetArchived {
        id: id(30),
        base_revision: revision(&nb, 30),
        archived: true,
    };
    apply(&mut nb, vec![op]);
    assert!(info(&nb, 13).target_id.is_none());
    edit(&mut nb, 13, &format!("[[{}]] [[{}]]", id(999), id(20)));
    assert!(
        info(&nb, 13).target_id.is_none(),
        "never skip an invalid first link"
    );
    edit(&mut nb, 13, "No link");
    assert!(info(&nb, 13).target_id.is_none());
    assert!(info(&nb, 13).problem.unwrap().contains("Choose"));
    let rows = nb
        .relations(&RelationQuery {
            kind: Some(RelationKind::Answers),
            ..Default::default()
        })
        .unwrap();
    assert!(rows[0].target.is_none() && rows[0].problem.is_some());
}

fn nb_revision_after_delete(committed: &Committed, value: u128) -> i64 {
    committed
        .revisions
        .iter()
        .find(|revision| revision.id == id(value))
        .unwrap()
        .revision
}

#[test]
fn queries_intersect_all_filters_and_resolve_endpoint_holders() {
    let (_dir, mut nb) = fixture();
    set(&mut nb, 13, Some(RelationKind::Disputes));
    assert!(
        nb.relations(&RelationQuery {
            limit: Some(10),
            ..Default::default()
        })
        .is_err()
    );
    let query = RelationQuery {
        kind: Some(RelationKind::Disputes),
        source: Some(id(10)),
        target: Some(id(20)),
        source_holder: Some(id(2)),
        target_holder: Some(id(3)),
        limit: Some(1),
    };
    let rows = nb.relations(&query).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].block.block.id, id(13));
    assert_eq!(rows[0].source.block.block.id, id(10));
    assert_eq!(rows[0].source.holder_id, Some(id(2)));
    assert_eq!(rows[0].target.as_ref().unwrap().holder_id, Some(id(3)));
    assert!(
        nb.relations(&RelationQuery {
            source_holder: Some(id(3)),
            ..query.clone()
        })
        .unwrap()
        .is_empty()
    );
    assert!(
        nb.relations(&RelationQuery {
            kind: Some(RelationKind::Supports),
            ..query.clone()
        })
        .unwrap()
        .is_empty()
    );
    assert!(
        nb.relations(&RelationQuery {
            limit: Some(0),
            ..query
        })
        .unwrap()
        .is_empty()
    );
    edit(&mut nb, 20, &format!("[[{}]]", id(2)));
    assert!(
        nb.relations(&RelationQuery {
            target_holder: Some(id(3)),
            ..Default::default()
        })
        .unwrap()
        .is_empty()
    );
    edit(&mut nb, 13, &format!("[[{}]]", id(3)));
    assert_eq!(
        nb.relations(&RelationQuery {
            target_holder: Some(id(3)),
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
    let op = Operation::Move {
        id: id(13),
        base_revision: revision(&nb, 13),
        parent_id: id(2),
        after: None,
    };
    apply(&mut nb, vec![op]);
    assert_eq!(
        nb.relations(&RelationQuery {
            source_holder: Some(id(2)),
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
    let op = Operation::SetArchived {
        id: id(2),
        base_revision: revision(&nb, 2),
        archived: true,
    };
    apply(&mut nb, vec![op]);
    assert!(
        nb.relations(&RelationQuery {
            kind: Some(RelationKind::Disputes),
            ..Default::default()
        })
        .unwrap()
        .is_empty()
    );
}

#[test]
fn agent_kind_changes_and_removal_undo_without_overwriting_later_edits() {
    let (_dir, mut nb) = fixture();
    let request = |relation| AgentRequest {
        actor: Actor::Agent {
            name: "relations test".into(),
        },
        reason: None,
        edit: AgentEdit::SetRelation {
            id: id(13),
            revision: None,
            relation,
        },
    };
    let added = nb
        .agent_edit(&request(Some(RelationKind::Supports)))
        .unwrap();
    nb.undo_agent_change(added.seq, &Actor::Person).unwrap();
    assert!(nb.capabilities(&id(13)).unwrap().relation.is_none());
    nb.agent_edit(&request(Some(RelationKind::Disputes)))
        .unwrap();
    let changed = nb
        .agent_edit(&request(Some(RelationKind::Qualifies)))
        .unwrap();
    nb.undo_agent_change(changed.seq, &Actor::Person).unwrap();
    assert_eq!(info(&nb, 13).kind, RelationKind::Disputes);
    let removed = nb.agent_edit(&request(None)).unwrap();
    nb.undo_agent_change(removed.seq, &Actor::Person).unwrap();
    assert_eq!(info(&nb, 13).kind, RelationKind::Disputes);
    let unchanged = nb
        .agent_edit(&request(Some(RelationKind::Disputes)))
        .unwrap();
    assert!(unchanged.committed.revisions.is_empty());
    let changed = nb
        .agent_edit(&request(Some(RelationKind::Answers)))
        .unwrap();
    edit(&mut nb, 13, "Later authored text");
    assert!(nb.undo_agent_change(changed.seq, &Actor::Person).is_err());
    assert_eq!(info(&nb, 13).kind, RelationKind::Answers);
    assert_eq!(nb.block(&id(13)).unwrap().text, "Later authored text");
}

#[test]
fn upgrading_old_notebooks_does_not_infer_relations_from_text() {
    for version in [37, 39] {
        let (dir, nb) = fixture();
        drop(nb);
        let conn =
            rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
        common::restore_pre_relations(&conn);
        if version < 38 {
            common::restore_authored_search(&conn);
        }
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let mut nb = Notebook::open(dir.path()).unwrap();
        assert!(nb.capabilities(&id(13)).unwrap().relation.is_none());
        set(&mut nb, 13, Some(RelationKind::Disputes));
        assert_eq!(info(&nb, 13).target_id, Some(id(20)));
    }
}
