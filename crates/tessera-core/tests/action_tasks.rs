use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater};
use tessera_core::{
    Actor, Batch, Committed, Error, Notebook, Operation, ProjectState, ProjectStatus, TaskPriority,
    TaskState, TaskStatus,
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

fn set_task(value: u128, revision: i64, state: Option<TaskState>) -> Operation {
    Operation::SetTask {
        id: id(value),
        base_revision: revision,
        task: state,
    }
}

fn set_project(value: u128, revision: i64, state: Option<ProjectState>) -> Operation {
    Operation::SetProject {
        id: id(value),
        base_revision: revision,
        project: state,
    }
}

fn complete(value: u128, revision: i64, occurrence: u128, date: &str) -> Operation {
    Operation::CompleteTask {
        id: id(value),
        base_revision: revision,
        occurrence_id: id(occurrence),
        completed_on: date.into(),
    }
}

fn reverse(value: u128, revision: i64, occurrence: u128) -> Operation {
    Operation::ReverseTaskCompletion {
        id: id(value),
        base_revision: revision,
        occurrence_id: id(occurrence),
    }
}

fn archive(value: u128, revision: i64, archived: bool) -> Operation {
    Operation::SetArchived {
        id: id(value),
        base_revision: revision,
        archived,
    }
}

fn state(nb: &Notebook, value: u128) -> TaskState {
    nb.capabilities(&id(value)).unwrap().task.unwrap()
}

fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Work".into(),
            },
            insert(10, 1, None, "action"),
            insert(11, 1, Some(10), "other"),
        ],
    );
    (dir, nb)
}

fn reject(nb: &mut Notebook, operations: Vec<Operation>) {
    assert!(matches!(
        nb.apply(&batch(operations)),
        Err(Error::Validation { .. })
    ));
}

fn recurring(scheduled: &str, mode: RepeatMode) -> TaskState {
    TaskState {
        scheduled: Some(scheduled.into()),
        repeater: Some(Repeater {
            every: 1,
            unit: RepeatUnit::Month,
            mode,
        }),
        ..TaskState::default()
    }
}

#[test]
fn planning_validation_keeps_dates_independent_and_noops_do_not_bump() {
    let (_dir, mut nb) = fixture();
    let invalid = [
        TaskState {
            scheduled: Some("2025-02-29".into()),
            ..TaskState::default()
        },
        TaskState {
            deadline: Some("2024-2-29".into()),
            ..TaskState::default()
        },
        TaskState {
            scheduled_time: Some("09:00".into()),
            ..TaskState::default()
        },
        TaskState {
            deadline_time: Some("09:00".into()),
            ..TaskState::default()
        },
        TaskState {
            scheduled: Some("2024-02-29".into()),
            scheduled_time: Some("9:00".into()),
            ..TaskState::default()
        },
        TaskState {
            deadline: Some("2024-02-29".into()),
            deadline_time: Some("24:00".into()),
            ..TaskState::default()
        },
        TaskState {
            warning_days: Some(0),
            ..TaskState::default()
        },
        TaskState {
            repeater: Some(Repeater {
                every: 1,
                unit: RepeatUnit::Day,
                mode: RepeatMode::Fixed,
            }),
            ..TaskState::default()
        },
        TaskState {
            scheduled: Some("2024-02-29".into()),
            repeater: Some(Repeater {
                every: 0,
                unit: RepeatUnit::Day,
                mode: RepeatMode::Fixed,
            }),
            ..TaskState::default()
        },
        TaskState {
            scheduled: Some("2024-02-29".into()),
            repeater: Some(Repeater {
                every: u32::MAX,
                unit: RepeatUnit::Year,
                mode: RepeatMode::Fixed,
            }),
            ..TaskState::default()
        },
        TaskState {
            completed_on: Some("2024-02-29".into()),
            ..TaskState::default()
        },
        TaskState {
            status: TaskStatus::Done,
            ..TaskState::default()
        },
        TaskState {
            status: TaskStatus::Done,
            completed_on: Some("2024-02-29".into()),
            ..TaskState::default()
        },
    ];
    let original = nb.page(&id(1)).unwrap();
    for invalid in invalid {
        reject(&mut nb, vec![set_task(10, 1, Some(invalid))]);
        assert_eq!(nb.page(&id(1)).unwrap(), original);
        assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    }
    let task = TaskState {
        scheduled: Some("2024-03-02".into()),
        scheduled_time: Some("00:00".into()),
        deadline: Some("2024-02-29".into()),
        deadline_time: Some("23:59".into()),
        warning_days: Some(0),
        priority: Some(TaskPriority::High),
        ..TaskState::default()
    };
    apply(&mut nb, vec![set_task(10, 1, Some(task.clone()))]);
    assert_eq!(state(&nb, 10), task);
    let noop = apply(&mut nb, vec![set_task(10, 2, Some(task.clone()))]);
    assert!(noop.revisions.is_empty());
    assert_eq!(nb.block(&id(10)).unwrap().revision, 2);
    assert_eq!(state(&nb, 10), task);
    assert!(
        apply(&mut nb, vec![set_task(11, 1, None)])
            .revisions
            .is_empty()
    );
    assert!(!nb.capabilities(&id(11)).unwrap().merge_protected);
}

#[test]
fn status_transitions_require_completion_and_reopening_retains_evidence() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![set_task(10, 1, Some(TaskState::default()))]);
    for (revision, status) in [
        (2, TaskStatus::Doing),
        (3, TaskStatus::Waiting),
        (4, TaskStatus::Cancelled),
    ] {
        apply(
            &mut nb,
            vec![set_task(
                10,
                revision,
                Some(TaskState {
                    status,
                    ..TaskState::default()
                }),
            )],
        );
        assert_eq!(state(&nb, 10).status, status);
    }
    reject(&mut nb, vec![complete(10, 5, 100, "2024-02-29")]);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 5);
    apply(&mut nb, vec![set_task(10, 5, Some(TaskState::default()))]);
    reject(
        &mut nb,
        vec![set_task(
            10,
            6,
            Some(TaskState {
                status: TaskStatus::Done,
                completed_on: Some("2024-02-29".into()),
                ..TaskState::default()
            }),
        )],
    );
    let mut delivery = batch(vec![complete(10, 6, 100, "2024-02-29")]);
    delivery.idempotency_key = Some("completion-delivery".into());
    let completed = nb.apply(&delivery).unwrap();
    assert_eq!(nb.apply(&delivery).unwrap().seq, completed.seq);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap().len(), 1);
    let done = TaskState {
        status: TaskStatus::Done,
        completed_on: Some("2024-02-29".into()),
        ..TaskState::default()
    };
    assert_eq!(state(&nb, 10), done);
    let history = nb.task_occurrences(&id(10)).unwrap();
    assert_eq!(history[0].snapshot, TaskState::default());
    assert_eq!(history[0].change_seq, completed.seq);
    assert!(!nb.block(&id(10)).unwrap().archived);
    let noop = apply(&mut nb, vec![complete(10, 7, 101, "2024-03-01")]);
    assert!(noop.revisions.is_empty());
    assert_eq!(nb.block(&id(10)).unwrap().revision, 7);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    reject(
        &mut nb,
        vec![set_task(
            10,
            7,
            Some(TaskState {
                completed_on: Some("2024-03-01".into()),
                ..done.clone()
            }),
        )],
    );
    let edited = TaskState {
        priority: Some(TaskPriority::Low),
        ..done.clone()
    };
    apply(&mut nb, vec![set_task(10, 7, Some(edited.clone()))]);
    assert_eq!(state(&nb, 10), edited);
    reject(&mut nb, vec![reverse(10, 8, 100)]);
    apply(&mut nb, vec![set_task(10, 8, Some(TaskState::default()))]);
    assert_eq!(state(&nb, 10), TaskState::default());
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    reject(&mut nb, vec![complete(10, 9, 100, "2024-03-01")]);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 9);
}

#[test]
fn recurrence_preserves_signed_offsets_labels_and_exact_snapshot() {
    for (mode, expected_schedule, expected_deadline) in [
        (RepeatMode::Fixed, "2024-02-29", "2024-02-26"),
        (RepeatMode::CatchUp, "2024-03-31", "2024-03-28"),
        (RepeatMode::AfterCompletion, "2024-04-15", "2024-04-12"),
    ] {
        let (_dir, mut nb) = fixture();
        let before = TaskState {
            status: TaskStatus::Waiting,
            scheduled_time: Some("09:30".into()),
            deadline: Some("2024-01-28".into()),
            deadline_time: Some("17:45".into()),
            warning_days: Some(2),
            priority: Some(TaskPriority::Medium),
            ..recurring("2024-01-31", mode)
        };
        apply(&mut nb, vec![set_task(10, 1, Some(before.clone()))]);
        let completed = apply(&mut nb, vec![complete(10, 2, 100, "2024-03-15")]);
        let after = TaskState {
            status: TaskStatus::Todo,
            scheduled: Some(expected_schedule.into()),
            deadline: Some(expected_deadline.into()),
            ..before.clone()
        };
        assert_eq!(state(&nb, 10), after);
        let history = nb.task_occurrences(&id(10)).unwrap();
        assert_eq!(history[0].snapshot, before);
        assert_eq!(history[0].completed_on, "2024-03-15");
        assert_eq!(history[0].change_seq, completed.seq);
        apply(&mut nb, vec![reverse(10, 3, 100)]);
        assert_eq!(state(&nb, 10), before);
        assert!(nb.task_occurrences(&id(10)).unwrap()[0].reversed);
    }
    let (_dir, mut nb) = fixture();
    let deadline_only = TaskState {
        deadline: Some("2024-02-29".into()),
        deadline_time: Some("12:00".into()),
        repeater: Some(Repeater {
            every: 1,
            unit: RepeatUnit::Year,
            mode: RepeatMode::Fixed,
        }),
        ..TaskState::default()
    };
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(deadline_only.clone())),
            complete(10, 2, 100, "2024-02-29"),
        ],
    );
    assert_eq!(
        state(&nb, 10),
        TaskState {
            deadline: Some("2025-02-28".into()),
            ..deadline_only
        }
    );
    let scheduled_only = TaskState {
        scheduled: Some("2024-12-25".into()),
        scheduled_time: Some("08:00".into()),
        repeater: Some(Repeater {
            every: 2,
            unit: RepeatUnit::Week,
            mode: RepeatMode::AfterCompletion,
        }),
        ..TaskState::default()
    };
    apply(
        &mut nb,
        vec![
            set_task(11, 1, Some(scheduled_only.clone())),
            complete(11, 2, 101, "2024-12-30"),
        ],
    );
    assert_eq!(
        state(&nb, 11),
        TaskState {
            scheduled: Some("2025-01-13".into()),
            ..scheduled_only
        }
    );
}

#[test]
fn reverse_uses_insertion_order_with_tied_timestamps_and_retains_audit() {
    let (dir, mut nb) = fixture();
    let original = recurring("2024-01-31", RepeatMode::Fixed);
    apply(&mut nb, vec![set_task(10, 1, Some(original.clone()))]);
    let completed = apply(
        &mut nb,
        vec![
            complete(10, 2, 200, "2024-02-01"),
            complete(10, 3, 100, "2024-02-01"),
        ],
    );
    let history = nb.task_occurrences(&id(10)).unwrap();
    assert_eq!(
        history
            .iter()
            .map(|occurrence| occurrence.id.clone())
            .collect::<Vec<_>>(),
        vec![id(200), id(100)]
    );
    assert_eq!(history[0].created_at, history[1].created_at);
    assert_eq!(history[0].change_seq, completed.seq);
    assert_eq!(history[1].change_seq, completed.seq);
    assert_eq!(state(&nb, 10).scheduled.as_deref(), Some("2024-03-29"));
    reject(&mut nb, vec![reverse(10, 4, 200)]);
    let latest_undo = apply(&mut nb, vec![reverse(10, 4, 100)]);
    assert_eq!(state(&nb, 10), history[1].snapshot);
    assert!(
        apply(&mut nb, vec![reverse(10, 5, 100)])
            .revisions
            .is_empty()
    );
    assert_eq!(nb.block(&id(10)).unwrap().revision, 5);
    let first_undo = apply(&mut nb, vec![reverse(10, 5, 200)]);
    assert_eq!(state(&nb, 10), original);
    assert!(
        apply(&mut nb, vec![reverse(10, 6, 200)])
            .revisions
            .is_empty()
    );
    let mut expected = history;
    for occurrence in &mut expected {
        occurrence.reversed = true;
    }
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), expected);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    let audit: Vec<(String, i64)> = conn
        .prepare("SELECT id, reversed_seq FROM task_occurrences WHERE block_id = ?1 ORDER BY rowid")
        .unwrap()
        .query_map([id(10)], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        audit,
        vec![(id(200), first_undo.seq), (id(100), latest_undo.seq)]
    );
    apply(
        &mut nb,
        vec![set_task(
            10,
            6,
            Some(TaskState {
                priority: Some(TaskPriority::High),
                ..original
            }),
        )],
    );
    reject(&mut nb, vec![reverse(10, 7, 200)]);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), expected);
    // An occurrence from another canonical source cannot be reversed here.
    apply(&mut nb, vec![set_task(11, 1, Some(TaskState::default()))]);
    assert!(matches!(
        nb.apply(&batch(vec![reverse(11, 2, 200)])),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn done_deactivation_undo_and_exact_delete_restore_keep_same_identity() {
    let (_dir, mut nb) = fixture();
    let project = ProjectState {
        outcome: "Deliver".into(),
        ..ProjectState::default()
    };
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(TaskState::default())),
            set_project(10, 2, Some(project.clone())),
            complete(10, 3, 100, "2024-02-29"),
        ],
    );
    let done = state(&nb, 10);
    let history = nb.task_occurrences(&id(10)).unwrap();
    let removed = apply(&mut nb, vec![set_task(10, 4, None)]);
    let capability = nb.capabilities(&id(10)).unwrap();
    assert!(capability.task.is_none());
    assert_eq!(capability.project, Some(project.clone()));
    assert!(capability.merge_protected);
    assert!(!capability.reviewed_cards);
    assert_eq!(removed.capabilities, vec![capability.clone()]);
    assert_eq!(nb.page(&id(1)).unwrap().capabilities, vec![capability]);
    assert!(
        apply(&mut nb, vec![set_task(10, 5, None)])
            .revisions
            .is_empty()
    );
    reject(&mut nb, vec![complete(10, 5, 101, "2024-03-01")]);
    reject(&mut nb, vec![reverse(10, 5, 100)]);
    reject(
        &mut nb,
        vec![set_task(
            10,
            5,
            Some(TaskState {
                completed_on: Some("2024-03-01".into()),
                ..done.clone()
            }),
        )],
    );
    apply(&mut nb, vec![set_task(10, 5, Some(done.clone()))]);
    assert_eq!(state(&nb, 10), done);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    let deleted = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(10),
            base_revision: 6,
        }],
    );
    assert!(nb.page(&id(1)).unwrap().capabilities.is_empty());
    assert_eq!(state(&nb, 10), done);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    assert!(nb.projects().unwrap().is_empty());
    assert!(matches!(
        nb.apply(&batch(vec![set_task(10, 7, None)])),
        Err(Error::Conflict { found: None, .. })
    ));
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(10),
            revision: 7,
            deletion_id: deleted.deletions[0].clone(),
        }],
    );
    assert_eq!(nb.block(&id(10)).unwrap().id, id(10));
    assert_eq!(state(&nb, 10), done);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    assert_eq!(nb.projects().unwrap()[0].state, project);
    apply(&mut nb, vec![reverse(10, 8, 100)]);
    assert_eq!(state(&nb, 10), TaskState::default());
    assert!(nb.task_occurrences(&id(10)).unwrap()[0].reversed);
}

#[test]
fn moves_and_splits_preserve_capability_identity_and_merges_protect_retained_rows() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(TaskState::default())),
            set_project(10, 2, Some(ProjectState::default())),
            complete(10, 3, 100, "2024-02-29"),
            Operation::CreatePage {
                id: id(2),
                title: "Elsewhere".into(),
            },
        ],
    );
    let original = nb.capabilities(&id(10)).unwrap();
    let history = nb.task_occurrences(&id(10)).unwrap();
    apply(
        &mut nb,
        vec![Operation::Move {
            id: id(10),
            base_revision: 4,
            parent_id: id(2),
            after: None,
        }],
    );
    assert!(nb.page(&id(1)).unwrap().capabilities.is_empty());
    assert_eq!(
        nb.page(&id(2)).unwrap().capabilities,
        vec![original.clone()]
    );
    apply(
        &mut nb,
        vec![Operation::Split {
            id: id(10),
            base_revision: 5,
            new_id: id(12),
            left: "act".into(),
            right: "ion".into(),
        }],
    );
    assert_eq!(nb.capabilities(&id(10)).unwrap(), original);
    assert!(!nb.capabilities(&id(12)).unwrap().merge_protected);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    // Keeping the task destination is safe; discarding a retained source is not.
    apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(12),
            source_revision: 1,
            destination_id: id(10),
            destination_revision: 6,
        }],
    );
    assert_eq!(nb.capabilities(&id(10)).unwrap(), original);
    apply(&mut nb, vec![insert(13, 2, Some(10), "destination")]);
    let merge = |revision| Operation::Merge {
        source_id: id(10),
        source_revision: revision,
        destination_id: id(13),
        destination_revision: 1,
    };
    reject(&mut nb, vec![merge(7)]);
    apply(
        &mut nb,
        vec![set_task(10, 7, None), set_project(10, 8, None)],
    );
    let before = nb.page(&id(2)).unwrap();
    reject(&mut nb, vec![merge(9)]);
    assert_eq!(nb.page(&id(2)).unwrap(), before);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    assert!(nb.capabilities(&id(10)).unwrap().merge_protected);
    // Project rows without any task history are equally identity-bearing.
    apply(
        &mut nb,
        vec![
            set_project(13, 1, Some(ProjectState::default())),
            set_project(13, 2, None),
        ],
    );
    reject(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(13),
            source_revision: 3,
            destination_id: id(10),
            destination_revision: 9,
        }],
    );
}

#[test]
fn running_clock_refuses_completion_removal_and_cancellation_until_atomic_stop() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(TaskState::default())),
            Operation::StartWork {
                id: id(10),
                base_revision: 2,
                session_id: id(300),
                started_at: 1000,
                note: "Work".into(),
            },
        ],
    );
    let running = nb.active_work_session().unwrap().unwrap();
    for operation in [
        complete(10, 3, 100, "2024-02-29"),
        set_task(10, 3, None),
        set_task(
            10,
            3,
            Some(TaskState {
                status: TaskStatus::Cancelled,
                ..TaskState::default()
            }),
        ),
    ] {
        reject(&mut nb, vec![operation]);
        assert_eq!(state(&nb, 10), TaskState::default());
        assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));
        assert_eq!(nb.block(&id(10)).unwrap().revision, 3);
        assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    }
    let stop = Operation::StopWork {
        id: id(10),
        base_revision: 3,
        session_id: id(300),
        session_revision: 1,
        ended_at: 2000,
        note: "Finished".into(),
    };
    reject(
        &mut nb,
        vec![stop.clone(), complete(10, 4, 100, "2024-02-30")],
    );
    assert_eq!(nb.active_work_session().unwrap(), Some(running));
    assert_eq!(nb.block(&id(10)).unwrap().revision, 3);
    let committed = apply(&mut nb, vec![stop, complete(10, 4, 100, "2024-02-29")]);
    assert!(nb.active_work_session().unwrap().is_none());
    assert_eq!(state(&nb, 10).status, TaskStatus::Done);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 5);
    assert_eq!(
        nb.task_occurrences(&id(10)).unwrap()[0].change_seq,
        committed.seq
    );
    let stopped = nb.work_sessions(&id(10)).unwrap();
    assert_eq!(stopped[0].started_at, 1000);
    assert_eq!(stopped[0].ended_at, Some(2000));
    assert_eq!(stopped[0].note, "Finished");
}

#[test]
fn owning_revisions_conflict_even_for_noops_and_roll_back_earlier_mutations() {
    let (dir, mut nb) = fixture();
    apply(&mut nb, vec![set_task(10, 1, Some(TaskState::default()))]);
    let mut other = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![complete(10, 2, 100, "2024-02-29")]);
    let committed_history = nb.task_occurrences(&id(10)).unwrap();
    for operation in [
        complete(10, 2, 101, "2024-03-01"),
        reverse(10, 2, 100),
        set_task(10, 2, None),
        set_project(10, 2, Some(ProjectState::default())),
    ] {
        let result = other.apply(&batch(vec![
            set_task(11, 1, Some(TaskState::default())),
            operation,
        ]));
        assert!(matches!(
            result,
            Err(Error::Conflict {
                op_index: 1,
                expected: 2,
                found: Some(3),
                ..
            })
        ));
        assert!(nb.capabilities(&id(11)).unwrap().task.is_none());
        assert_eq!(nb.block(&id(11)).unwrap().revision, 1);
        assert_eq!(nb.task_occurrences(&id(10)).unwrap(), committed_history);
        assert_eq!(state(&nb, 10).status, TaskStatus::Done);
    }
    let done = state(&nb, 10);
    assert!(matches!(
        other.apply(&batch(vec![set_task(10, 2, Some(done))])),
        Err(Error::Conflict { found: Some(3), .. })
    ));
}

#[test]
fn projects_list_all_statuses_but_exclude_hidden_deleted_and_inactive_without_cascading() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(12, 10, None, "nested project"),
            insert(13, 12, None, "child task"),
            set_project(10, 1, Some(ProjectState::default())),
            set_project(
                11,
                1,
                Some(ProjectState {
                    status: ProjectStatus::Cancelled,
                    ..ProjectState::default()
                }),
            ),
            set_project(
                12,
                1,
                Some(ProjectState {
                    status: ProjectStatus::Done,
                    ..ProjectState::default()
                }),
            ),
            set_task(
                13,
                1,
                Some(TaskState {
                    status: TaskStatus::Waiting,
                    ..TaskState::default()
                }),
            ),
        ],
    );
    assert_eq!(
        nb.projects()
            .unwrap()
            .iter()
            .map(|project| project.block_id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(11), id(12)]
    );
    let before = nb.page(&id(1)).unwrap();
    reject(
        &mut nb,
        vec![set_project(
            10,
            2,
            Some(ProjectState {
                deadline: Some("2024-04-31".into()),
                ..ProjectState::default()
            }),
        )],
    );
    assert_eq!(nb.page(&id(1)).unwrap(), before);
    let done = ProjectState {
        status: ProjectStatus::Done,
        deadline: Some("2024-02-29".into()),
        outcome: "Shipped".into(),
    };
    apply(&mut nb, vec![set_project(10, 2, Some(done.clone()))]);
    assert_eq!(state(&nb, 13).status, TaskStatus::Waiting);
    assert_eq!(nb.block(&id(13)).unwrap().revision, 2);
    assert!(
        apply(&mut nb, vec![set_project(10, 3, Some(done))])
            .revisions
            .is_empty()
    );
    apply(&mut nb, vec![archive(10, 3, true)]);
    assert_eq!(
        nb.projects()
            .unwrap()
            .iter()
            .map(|project| project.block_id.clone())
            .collect::<Vec<_>>(),
        vec![id(11)]
    );
    assert!(nb.capabilities(&id(12)).unwrap().project.is_some());
    apply(
        &mut nb,
        vec![archive(10, 4, false), set_project(11, 2, None)],
    );
    assert!(
        apply(&mut nb, vec![set_project(11, 3, None)])
            .revisions
            .is_empty()
    );
    let deletion = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(10),
            base_revision: 5,
        }],
    );
    assert!(nb.projects().unwrap().is_empty());
    assert_eq!(state(&nb, 13).status, TaskStatus::Waiting);
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(10),
            revision: 6,
            deletion_id: deletion.deletions[0].clone(),
        }],
    );
    assert_eq!(
        nb.projects()
            .unwrap()
            .iter()
            .map(|project| project.block_id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(12)]
    );
    assert_eq!(state(&nb, 13).status, TaskStatus::Waiting);
    assert!(nb.capabilities(&id(11)).unwrap().merge_protected);
}

#[test]
fn page_capabilities_include_review_protection_after_syntax_deactivation() {
    let (_dir, mut nb) = fixture();
    assert!(nb.page(&id(1)).unwrap().capabilities.is_empty());
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: id(10),
            base_revision: 1,
            text: "front >> back".into(),
        }],
    );
    let card = nb.source_cards(&id(10)).unwrap().remove(0);
    assert!(!nb.capabilities(&id(10)).unwrap().merge_protected);
    apply(
        &mut nb,
        vec![Operation::GradeCard {
            id: card.id,
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(400),
            session_id: None,
            grade: tessera_core::scheduler::Grade::Good,
            reset: false,
            shown_front: card.front,
            shown_back: card.back,
            reviewed_at: 1000,
        }],
    );
    let capability = nb.capabilities(&id(10)).unwrap();
    assert!(capability.reviewed_cards);
    assert!(capability.merge_protected);
    assert!(capability.task.is_none());
    assert!(capability.project.is_none());
    assert_eq!(
        nb.page(&id(1)).unwrap().capabilities,
        vec![capability.clone()]
    );
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: id(10),
            base_revision: 2,
            text: "plain text".into(),
        }],
    );
    assert_eq!(nb.page(&id(1)).unwrap().capabilities, vec![capability]);
}

#[test]
fn failed_repeat_advancement_is_atomic_and_occurrence_ids_are_canonical() {
    let (_dir, mut nb) = fixture();
    let task = TaskState {
        scheduled: Some("9999-12-29".into()),
        deadline: Some("9999-12-30".into()),
        repeater: Some(Repeater {
            every: 1,
            unit: RepeatUnit::Day,
            mode: RepeatMode::AfterCompletion,
        }),
        ..TaskState::default()
    };
    apply(&mut nb, vec![set_task(10, 1, Some(task.clone()))]);
    let before = nb.page(&id(1)).unwrap();
    reject(&mut nb, vec![complete(10, 2, 100, "9999-12-30")]);
    assert_eq!(nb.page(&id(1)).unwrap(), before);
    assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    reject(
        &mut nb,
        vec![Operation::CompleteTask {
            id: id(10),
            base_revision: 2,
            occurrence_id: "not-an-id".into(),
            completed_on: "9999-12-29".into(),
        }],
    );
    assert_eq!(state(&nb, 10), task);
    assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    apply(&mut nb, vec![complete(10, 2, 100, "9999-12-29")]);
    assert_eq!(state(&nb, 10).deadline.as_deref(), Some("9999-12-31"));
    assert_eq!(nb.task_occurrences(&id(10)).unwrap()[0].id, id(100));
    let edited = TaskState {
        status: TaskStatus::Waiting,
        ..state(&nb, 10)
    };
    apply(&mut nb, vec![set_task(10, 3, Some(edited.clone()))]);
    assert_eq!(state(&nb, 10), edited);
    let history = nb.task_occurrences(&id(10)).unwrap();
    reject(&mut nb, vec![complete(10, 4, 101, "9999-12-30")]);
    assert_eq!(nb.block(&id(10)).unwrap().revision, 4);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
}

#[test]
fn reversing_a_recurrence_to_done_also_requires_an_explicit_clock_stop() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(TaskState::default())),
            complete(10, 2, 100, "2024-01-01"),
        ],
    );
    let recurring_done = TaskState {
        status: TaskStatus::Done,
        completed_on: Some("2024-01-01".into()),
        ..recurring("2024-01-01", RepeatMode::Fixed)
    };
    apply(
        &mut nb,
        vec![
            set_task(10, 3, Some(recurring_done.clone())),
            complete(10, 4, 101, "2024-01-02"),
            Operation::StartWork {
                id: id(10),
                base_revision: 5,
                session_id: id(300),
                started_at: 1000,
                note: String::new(),
            },
        ],
    );
    let before = state(&nb, 10);
    reject(&mut nb, vec![reverse(10, 6, 101)]);
    assert_eq!(state(&nb, 10), before);
    assert!(!nb.task_occurrences(&id(10)).unwrap()[1].reversed);
    apply(
        &mut nb,
        vec![
            Operation::StopWork {
                id: id(10),
                base_revision: 6,
                session_id: id(300),
                session_revision: 1,
                ended_at: 2000,
                note: String::new(),
            },
            reverse(10, 7, 101),
        ],
    );
    assert_eq!(state(&nb, 10), recurring_done);
    assert!(nb.active_work_session().unwrap().is_none());
    assert!(nb.task_occurrences(&id(10)).unwrap()[1].reversed);
}

#[test]
fn explicit_stop_can_atomically_remove_or_cancel_a_task() {
    for next in [
        None,
        Some(TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        }),
    ] {
        let (_dir, mut nb) = fixture();
        apply(
            &mut nb,
            vec![
                set_task(10, 1, Some(TaskState::default())),
                Operation::StartWork {
                    id: id(10),
                    base_revision: 2,
                    session_id: id(300),
                    started_at: 1000,
                    note: String::new(),
                },
                Operation::StopWork {
                    id: id(10),
                    base_revision: 3,
                    session_id: id(300),
                    session_revision: 1,
                    ended_at: 2000,
                    note: String::new(),
                },
                set_task(10, 4, next.clone()),
            ],
        );
        assert_eq!(nb.capabilities(&id(10)).unwrap().task, next);
        assert_eq!(nb.block(&id(10)).unwrap().revision, 5);
        assert!(nb.active_work_session().unwrap().is_none());
        assert_eq!(nb.work_sessions(&id(10)).unwrap()[0].ended_at, Some(2000));
        assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    }
}

fn restore_task_state(
    value: u128,
    revision: i64,
    expected: TaskState,
    task: TaskState,
) -> Operation {
    Operation::RestoreTaskState {
        id: id(value),
        base_revision: revision,
        expected,
        task,
    }
}

#[test]
fn reopening_undo_restores_exact_done_metadata_without_another_occurrence() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            set_task(10, 1, Some(TaskState::default())),
            complete(10, 2, 100, "2024-01-01"),
        ],
    );
    let done = TaskState {
        scheduled: Some("2024-01-05".into()),
        priority: Some(TaskPriority::High),
        ..state(&nb, 10)
    };
    let reopened = TaskState {
        status: TaskStatus::Todo,
        completed_on: None,
        ..done.clone()
    };
    apply(
        &mut nb,
        vec![
            set_task(10, 3, Some(done.clone())),
            set_task(10, 4, Some(reopened.clone())),
        ],
    );
    let history = nb.task_occurrences(&id(10)).unwrap();
    let restoring = Batch {
        idempotency_key: Some(id(500)),
        ..batch(vec![restore_task_state(
            10,
            5,
            reopened.clone(),
            done.clone(),
        )])
    };
    let committed = nb.apply(&restoring).unwrap();
    let replayed = nb.apply(&restoring).unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.seq, committed.seq);
    assert_eq!(state(&nb, 10), done);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    apply(&mut nb, vec![set_task(10, 6, Some(reopened.clone()))]);
    assert_eq!(state(&nb, 10), reopened);
    assert!(matches!(
        nb.apply(&batch(vec![restore_task_state(
            10,
            6,
            reopened.clone(),
            done.clone()
        )])),
        Err(Error::Conflict {
            expected: 6,
            found: Some(7),
            ..
        })
    ));
    let wrong_expected = TaskState {
        priority: None,
        ..reopened.clone()
    };
    reject(
        &mut nb,
        vec![restore_task_state(10, 7, wrong_expected, done.clone())],
    );
    assert_eq!(state(&nb, 10), reopened);
    apply(
        &mut nb,
        vec![Operation::StartWork {
            id: id(10),
            base_revision: 7,
            session_id: id(300),
            started_at: 1000,
            note: String::new(),
        }],
    );
    reject(
        &mut nb,
        vec![restore_task_state(10, 8, reopened.clone(), done.clone())],
    );
    assert_eq!(nb.active_work_session().unwrap().unwrap().id, id(300));
    apply(
        &mut nb,
        vec![
            Operation::StopWork {
                id: id(10),
                base_revision: 8,
                session_id: id(300),
                session_revision: 1,
                ended_at: 2000,
                note: String::new(),
            },
            restore_task_state(10, 9, reopened, done.clone()),
        ],
    );
    assert_eq!(state(&nb, 10), done);
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    assert!(nb.active_work_session().unwrap().is_none());
}

#[test]
fn restoring_done_cannot_invent_or_reuse_a_superseded_completion() {
    let (_dir, mut nb) = fixture();
    let todo = TaskState::default();
    let done = TaskState {
        status: TaskStatus::Done,
        completed_on: Some("2024-01-01".into()),
        ..todo.clone()
    };
    apply(&mut nb, vec![set_task(10, 1, Some(todo.clone()))]);
    reject(
        &mut nb,
        vec![restore_task_state(10, 2, todo.clone(), done.clone())],
    );
    assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    apply(
        &mut nb,
        vec![complete(10, 2, 100, "2024-01-01"), reverse(10, 3, 100)],
    );
    reject(
        &mut nb,
        vec![restore_task_state(10, 4, todo.clone(), done.clone())],
    );
    assert!(nb.task_occurrences(&id(10)).unwrap()[0].reversed);
    apply(
        &mut nb,
        vec![
            complete(10, 4, 101, "2024-01-02"),
            set_task(10, 5, Some(todo.clone())),
        ],
    );
    reject(&mut nb, vec![restore_task_state(10, 6, todo.clone(), done)]);
    assert_eq!(state(&nb, 10), todo);
    let recurring_task = recurring("2024-01-01", RepeatMode::Fixed);
    apply(
        &mut nb,
        vec![
            set_task(11, 1, Some(recurring_task)),
            complete(11, 2, 102, "2024-01-01"),
        ],
    );
    let advanced = state(&nb, 11);
    let invented_done = TaskState {
        status: TaskStatus::Done,
        completed_on: Some("2024-01-01".into()),
        ..advanced.clone()
    };
    reject(
        &mut nb,
        vec![restore_task_state(11, 3, advanced.clone(), invented_done)],
    );
    assert_eq!(state(&nb, 11), advanced);
    assert_eq!(nb.task_occurrences(&id(11)).unwrap()[0].id, id(102));
}
