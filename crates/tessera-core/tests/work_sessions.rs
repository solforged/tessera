use tessera_core::{
    Actor, Batch, Committed, DATABASE_FILE, Error, Notebook, Operation, TaskState, TaskStatus,
    WorkSession,
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
            Operation::CreatePage {
                id: id(2),
                title: "Other".into(),
            },
            insert(10, 1, "Parent"),
            insert(11, 10, "First task"),
            insert(12, 1, "Second task"),
            insert(13, 1, "Ordinary block"),
            insert(20, 2, "Archived parent"),
            insert(21, 20, "Hidden descendant"),
            Operation::SetArchived {
                id: id(20),
                base_revision: 1,
                archived: true,
            },
            Operation::SetTask {
                id: id(11),
                base_revision: 1,
                task: Some(TaskState::default()),
            },
            Operation::SetTask {
                id: id(12),
                base_revision: 1,
                task: Some(TaskState::default()),
            },
        ],
    );
    (dir, nb)
}

fn revision(nb: &Notebook, block: u128) -> i64 {
    nb.block(&id(block)).unwrap().revision
}

fn start(nb: &Notebook, block: u128, session: u128, at: i64) -> Operation {
    Operation::StartWork {
        id: id(block),
        base_revision: revision(nb, block),
        session_id: id(session),
        started_at: at,
        note: "Started offline".into(),
    }
}

fn stop(nb: &Notebook, session: &WorkSession, at: i64, note: &str) -> Operation {
    Operation::StopWork {
        id: session.block_id.clone(),
        base_revision: nb.block(&session.block_id).unwrap().revision,
        session_id: session.id.clone(),
        session_revision: session.revision,
        ended_at: at,
        note: note.into(),
    }
}

fn state(nb: &Notebook, session: &WorkSession, ended_at: Option<i64>, reversed: bool) -> Operation {
    Operation::SetWorkSessionState {
        id: session.block_id.clone(),
        base_revision: nb.block(&session.block_id).unwrap().revision,
        session_id: session.id.clone(),
        session_revision: session.revision,
        ended_at,
        reversed,
    }
}

fn note(nb: &Notebook, session: &WorkSession, text: &str) -> Operation {
    Operation::EditWorkNote {
        id: session.block_id.clone(),
        base_revision: nb.block(&session.block_id).unwrap().revision,
        session_id: session.id.clone(),
        session_revision: session.revision,
        note: text.into(),
    }
}

fn session(nb: &Notebook, block: u128, value: u128) -> WorkSession {
    nb.work_sessions(&id(block))
        .unwrap()
        .into_iter()
        .find(|session| session.id == id(value))
        .unwrap()
}

fn complete(block: u128, base_revision: i64, occurrence: u128, date: &str) -> Operation {
    Operation::CompleteTask {
        id: id(block),
        base_revision,
        occurrence_id: id(occurrence),
        completed_on: date.into(),
    }
}

fn assert_validation(error: Error, expected_index: usize) {
    assert!(
        matches!(error, Error::Validation { op_index: Some(index), .. } if index == expected_index)
    );
}

#[test]
fn one_clock_per_notebook_across_connections_without_task_status_changes() {
    let (dir, mut nb) = fixture();
    let waiting = TaskState {
        status: TaskStatus::Waiting,
        ..TaskState::default()
    };
    let set_waiting = Operation::SetTask {
        id: id(12),
        base_revision: revision(&nb, 12),
        task: Some(waiting.clone()),
    };
    apply(&mut nb, vec![set_waiting]);
    let first = start(&nb, 11, 100, 1_000);
    let committed = apply(&mut nb, vec![first]);
    let running = nb.active_work_session().unwrap().unwrap();
    assert_eq!(running.started_at, 1_000);
    assert_eq!(running.ended_at, None);
    assert_eq!(running.revision, 1);
    assert_eq!(committed.work_sessions, vec![running.clone()]);
    assert_eq!(
        nb.capabilities(&id(11)).unwrap().task,
        Some(TaskState::default())
    );

    let mut other = Notebook::open(dir.path()).unwrap();
    let competing = start(&other, 12, 101, 1_100);
    assert_validation(other.apply(&batch(vec![competing])).unwrap_err(), 0);
    assert_eq!(other.active_work_session().unwrap(), Some(running.clone()));
    assert!(other.work_sessions(&id(12)).unwrap().is_empty());

    // Application preflight does not replace the schema's one-running invariant.
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let error = conn
        .execute(
            "INSERT INTO work_sessions
         (id, block_id, started_at, ended_at, note, reversed, revision, created_seq, updated_seq)
         VALUES (?1, ?2, 1100, NULL, '', 0, 1, ?3, ?3)",
            rusqlite::params![id(102), id(12), committed.seq],
        )
        .unwrap_err();
    assert!(
        matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::ConstraintViolation)
    );

    let ending = stop(&nb, &running, 1_500, "Finished α\nnotes");
    apply(&mut nb, vec![ending]);
    let second = start(&other, 12, 101, 1_600);
    apply(&mut other, vec![second]);
    assert_eq!(nb.active_work_session().unwrap().unwrap().block_id, id(12));
    assert_eq!(nb.capabilities(&id(12)).unwrap().task, Some(waiting));
    assert_eq!(
        nb.capabilities(&id(11)).unwrap().task,
        Some(TaskState::default())
    );
    let stopped = session(&nb, 11, 100);
    assert_eq!(stopped.ended_at, Some(1_500));
    assert_eq!(stopped.note, "Finished α\nnotes");
}

#[test]
fn stale_session_revision_or_owner_rolls_back_the_entire_batch() {
    let (_dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let original = session(&nb, 11, 100);
    let old_block_revision = revision(&nb, 11);
    let editing = note(&nb, &original, "Changed on another client");
    apply(&mut nb, vec![editing]);
    let current = session(&nb, 11, 100);
    let unchanged_block = nb.block(&id(13)).unwrap();
    let stale_stop = stop(&nb, &original, 200, "Lost update");
    let error = nb
        .apply(&batch(vec![
            Operation::EditText {
                id: id(13),
                base_revision: unchanged_block.revision,
                text: "Must roll back".into(),
            },
            stale_stop,
        ]))
        .unwrap_err();
    assert!(
        matches!(error, Error::Conflict { op_index: 1, id: target, expected: 1, found: Some(2) } if target == id(100))
    );
    assert_eq!(nb.block(&id(13)).unwrap(), unchanged_block);
    assert_eq!(nb.active_work_session().unwrap(), Some(current.clone()));

    let error = nb
        .apply(&batch(vec![Operation::StopWork {
            id: id(12),
            base_revision: revision(&nb, 12),
            session_id: id(100),
            session_revision: current.revision,
            ended_at: 200,
            note: "Wrong owner".into(),
        }]))
        .unwrap_err();
    assert!(
        matches!(error, Error::Conflict { op_index: 0, id: target, expected: 2, found: None } if target == id(100))
    );

    let error = nb
        .apply(&batch(vec![Operation::EditWorkNote {
            id: id(11),
            base_revision: revision(&nb, 11),
            session_id: id(999),
            session_revision: 1,
            note: "Missing".into(),
        }]))
        .unwrap_err();
    assert!(
        matches!(error, Error::Conflict { op_index: 0, id: target, expected: 1, found: None } if target == id(999))
    );

    let error = nb
        .apply(&batch(vec![Operation::EditWorkNote {
            id: id(11),
            base_revision: old_block_revision,
            session_id: id(100),
            session_revision: current.revision,
            note: current.note.clone(),
        }]))
        .unwrap_err();
    assert!(
        matches!(error, Error::Conflict { op_index: 0, id: target, expected, found: Some(actual) }
        if target == id(11) && expected == old_block_revision && actual == old_block_revision + 1)
    );
    assert_eq!(session(&nb, 11, 100), current);
}

#[test]
fn delayed_batch_retries_preserve_event_times_and_attribution_without_duplicates() {
    let (dir, mut nb) = fixture();
    let mut starting = batch(vec![start(&nb, 11, 100, 42)]);
    starting.actor = Actor::Client {
        name: "offline-client".into(),
    };
    starting.idempotency_key = Some("offline-start".into());
    let started = nb.apply(&starting).unwrap();
    let mut expected_start = started.clone();
    expected_start.replayed = true;
    assert_eq!(nb.apply(&starting).unwrap(), expected_start);
    let running = session(&nb, 11, 100);
    assert_eq!(running.started_at, 42);
    assert_eq!(running.note, "Started offline");

    let mut stopping = batch(vec![stop(&nb, &running, 84, "Delivered later")]);
    stopping.idempotency_key = Some("offline-stop".into());
    let stopped = nb.apply(&stopping).unwrap();
    let mut expected_stop = stopped.clone();
    expected_stop.replayed = true;
    assert_eq!(nb.apply(&stopping).unwrap(), expected_stop);
    assert_eq!(nb.apply(&starting).unwrap(), expected_start);
    assert_eq!(nb.active_work_session().unwrap(), None);
    let ended = session(&nb, 11, 100);
    assert_eq!(ended.started_at, 42);
    assert_eq!(ended.ended_at, Some(84));
    assert_eq!(ended.revision, 2);
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), vec![ended.clone()]);
    assert_eq!(revision(&nb, 11), 4);

    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let attribution: (i64, i64) = conn
        .query_row(
            "SELECT created_seq, updated_seq FROM work_sessions WHERE id = ?1",
            [id(100)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(attribution, (started.seq, stopped.seq));
    let changes = nb.changes_since(started.seq - 1, 10).unwrap();
    assert_eq!(
        changes.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![started.seq, stopped.seq]
    );
    assert_eq!(changes[0].actor, starting.actor);

    drop(nb);
    let reopened = Notebook::open(dir.path()).unwrap();
    assert_eq!(reopened.work_sessions(&id(11)).unwrap(), vec![ended]);
    assert_eq!(reopened.active_work_session().unwrap(), None);
}

#[test]
fn stop_and_complete_are_explicit_and_atomic_on_failure_success_and_retry() {
    let (_dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    let before_revision = revision(&nb, 11);
    let cancelled = TaskState {
        status: TaskStatus::Cancelled,
        ..TaskState::default()
    };
    for operation in [
        complete(11, before_revision, 500, "2026-10-03"),
        Operation::SetTask {
            id: id(11),
            base_revision: before_revision,
            task: Some(cancelled),
        },
        Operation::SetTask {
            id: id(11),
            base_revision: before_revision,
            task: None,
        },
    ] {
        assert_validation(nb.apply(&batch(vec![operation])).unwrap_err(), 0);
        assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));
        assert_eq!(
            nb.capabilities(&id(11)).unwrap().task,
            Some(TaskState::default())
        );
    }
    let changes_before = nb.changes_since(0, 100).unwrap();
    let bad = batch(vec![
        stop(&nb, &running, 200, "Would stop"),
        complete(11, before_revision + 1, 500, "2026-02-30"),
    ]);
    assert_validation(nb.apply(&bad).unwrap_err(), 1);
    assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));
    assert_eq!(revision(&nb, 11), before_revision);
    assert!(nb.task_occurrences(&id(11)).unwrap().is_empty());
    assert_eq!(nb.changes_since(0, 100).unwrap(), changes_before);

    let mut good = batch(vec![
        stop(&nb, &running, 200, "Finished"),
        complete(11, before_revision + 1, 500, "2026-10-03"),
    ]);
    good.idempotency_key = Some("stop-and-complete".into());
    let committed = nb.apply(&good).unwrap();
    assert_eq!(nb.active_work_session().unwrap(), None);
    let task = nb.capabilities(&id(11)).unwrap().task.unwrap();
    assert_eq!(task.status, TaskStatus::Done);
    assert_eq!(task.completed_on.as_deref(), Some("2026-10-03"));
    assert_eq!(revision(&nb, 11), before_revision + 2);
    assert_eq!(
        committed.revisions,
        vec![tessera_core::Revision {
            id: id(11),
            revision: before_revision + 2
        }]
    );
    let ended = session(&nb, 11, 100);
    assert_eq!(ended.ended_at, Some(200));
    assert_eq!(committed.work_sessions, vec![ended.clone()]);
    let occurrences = nb.task_occurrences(&id(11)).unwrap();
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0].id, id(500));
    let mut replay = committed;
    replay.replayed = true;
    assert_eq!(nb.apply(&good).unwrap(), replay);
    assert_eq!(nb.task_occurrences(&id(11)).unwrap(), occurrences);
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), vec![ended]);
}

#[test]
fn reverse_retains_session_and_undo_cannot_replace_another_running_clock() {
    let (_dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let original = session(&nb, 11, 100);
    let reversing = state(&nb, &original, None, true);
    apply(&mut nb, vec![reversing]);
    let reversed = session(&nb, 11, 100);
    assert!(reversed.reversed);
    assert_eq!(reversed.ended_at, None);
    assert_eq!(reversed.revision, 2);
    assert_eq!(nb.active_work_session().unwrap(), None);
    let invalid_stop = stop(&nb, &reversed, 200, "Cannot stop a reversed clock");
    assert_validation(nb.apply(&batch(vec![invalid_stop])).unwrap_err(), 0);

    let beginning = start(&nb, 12, 101, 120);
    apply(&mut nb, vec![beginning]);
    let competing = session(&nb, 12, 101);
    let undo = state(&nb, &reversed, None, false);
    assert_validation(nb.apply(&batch(vec![undo])).unwrap_err(), 0);
    assert_eq!(session(&nb, 11, 100), reversed);
    assert_eq!(nb.active_work_session().unwrap(), Some(competing.clone()));

    let stopping = stop(&nb, &competing, 220, "Done");
    let undo = state(&nb, &reversed, None, false);
    apply(&mut nb, vec![stopping, undo]);
    let restored = session(&nb, 11, 100);
    assert!(!restored.reversed);
    assert_eq!(restored.started_at, 100);
    assert_eq!(restored.revision, 3);
    assert_eq!(nb.active_work_session().unwrap(), Some(restored.clone()));
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), vec![restored]);
    assert_eq!(session(&nb, 12, 101).ended_at, Some(220));
}

#[test]
fn equal_note_and_state_are_noops_but_stopped_sessions_remain_editable() {
    let (dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    let stopping = stop(&nb, &running, 100, "Zero duration");
    let stopped = apply(&mut nb, vec![stopping]);
    let ended = session(&nb, 11, 100);
    let before_revision = revision(&nb, 11);
    let same = batch(vec![
        note(&nb, &ended, &ended.note),
        state(&nb, &ended, ended.ended_at, false),
    ]);
    let noop = nb.apply(&same).unwrap();
    assert!(noop.revisions.is_empty());
    assert!(noop.work_sessions.is_empty());
    assert_eq!(revision(&nb, 11), before_revision);
    assert_eq!(session(&nb, 11, 100), ended);
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    let updated_seq: i64 = conn
        .query_row(
            "SELECT updated_seq FROM work_sessions WHERE id = ?1",
            [id(100)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(updated_seq, stopped.seq);

    let invalid_stop = stop(&nb, &ended, 100, &ended.note);
    assert_validation(nb.apply(&batch(vec![invalid_stop])).unwrap_err(), 0);
    let editing = note(&nb, &ended, "Edited after stopping");
    apply(&mut nb, vec![editing]);
    let edited = session(&nb, 11, 100);
    assert_eq!(edited.note, "Edited after stopping");
    assert_eq!(edited.ended_at, Some(100));
    assert_eq!(edited.revision, ended.revision + 1);
    assert_eq!(revision(&nb, 11), before_revision + 1);
    assert_eq!(nb.active_work_session().unwrap(), None);

    let stale_noop = state(&nb, &ended, Some(100), false);
    assert!(matches!(nb.apply(&batch(vec![stale_noop])).unwrap_err(),
        Error::Conflict { id: target, expected: 2, found: Some(3), .. } if target == id(100)));
}

#[test]
fn timestamps_and_session_ids_are_validated_without_commit_time_substitution() {
    let (_dir, mut nb) = fixture();
    let negative = start(&nb, 11, 100, -1);
    assert_validation(nb.apply(&batch(vec![negative])).unwrap_err(), 0);
    let malformed = Operation::StartWork {
        id: id(11),
        base_revision: revision(&nb, 11),
        session_id: "not-a-ulid".into(),
        started_at: 0,
        note: String::new(),
    };
    assert_validation(nb.apply(&batch(vec![malformed])).unwrap_err(), 0);
    let beginning = start(&nb, 11, 100, 10);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    for invalid in [
        stop(&nb, &running, 9, "Before start"),
        state(&nb, &running, Some(-1), true),
    ] {
        assert_validation(nb.apply(&batch(vec![invalid])).unwrap_err(), 0);
        assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));
    }
    let stopping = stop(&nb, &running, i64::MAX, "No arithmetic overflow");
    apply(&mut nb, vec![stopping]);
    assert_eq!(session(&nb, 11, 100).ended_at, Some(i64::MAX));
    let duplicate = start(&nb, 11, 100, 11);
    assert_validation(nb.apply(&batch(vec![duplicate])).unwrap_err(), 0);
    let zero = start(&nb, 11, 101, 0);
    apply(&mut nb, vec![zero]);
    assert_eq!(nb.active_work_session().unwrap().unwrap().started_at, 0);
}

#[test]
fn only_active_visible_unfinished_tasks_can_start_or_reopen_work() {
    let (_dir, mut nb) = fixture();
    let ordinary = start(&nb, 13, 100, 0);
    assert_validation(nb.apply(&batch(vec![ordinary])).unwrap_err(), 0);
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    let stopping = stop(&nb, &running, 200, "Stopped");
    apply(&mut nb, vec![stopping]);
    let ended = session(&nb, 11, 100);
    let completion = complete(11, revision(&nb, 11), 500, "2026-10-03");
    apply(&mut nb, vec![completion]);
    for operation in [start(&nb, 11, 101, 300), state(&nb, &ended, None, false)] {
        assert_validation(nb.apply(&batch(vec![operation])).unwrap_err(), 0);
    }
    for task in [
        Some(TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        }),
        None,
    ] {
        let changing = Operation::SetTask {
            id: id(11),
            base_revision: revision(&nb, 11),
            task,
        };
        apply(&mut nb, vec![changing]);
        for operation in [start(&nb, 11, 101, 300), state(&nb, &ended, None, false)] {
            assert_validation(nb.apply(&batch(vec![operation])).unwrap_err(), 0);
        }
    }
    let restoring_task = Operation::SetTask {
        id: id(11),
        base_revision: revision(&nb, 11),
        task: Some(TaskState::default()),
    };
    apply(&mut nb, vec![restoring_task]);
    let hiding = Operation::SetArchived {
        id: id(10),
        base_revision: revision(&nb, 10),
        archived: true,
    };
    apply(&mut nb, vec![hiding]);
    for operation in [start(&nb, 11, 101, 300), state(&nb, &ended, None, false)] {
        assert_validation(nb.apply(&batch(vec![operation])).unwrap_err(), 0);
    }
    assert_eq!(session(&nb, 11, 100), ended);
    let revealing = Operation::SetArchived {
        id: id(10),
        base_revision: revision(&nb, 10),
        archived: false,
    };
    apply(&mut nb, vec![revealing]);
    let reopening = state(&nb, &ended, None, false);
    apply(&mut nb, vec![reopening]);
    assert_eq!(nb.active_work_session().unwrap().unwrap().id, id(100));
}

#[test]
fn archive_delete_and_hidden_moves_guard_the_whole_running_subtree() {
    let (_dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    for block in [11, 10, 1] {
        for operation in [
            Operation::SetArchived {
                id: id(block),
                base_revision: revision(&nb, block),
                archived: true,
            },
            Operation::Delete {
                id: id(block),
                base_revision: revision(&nb, block),
            },
        ] {
            assert_validation(nb.apply(&batch(vec![operation])).unwrap_err(), 0);
            assert!(!nb.block(&id(block)).unwrap().archived);
            assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));
        }
    }
    for moving_block in [11, 10] {
        for parent in [20, 21] {
            let moving = Operation::Move {
                id: id(moving_block),
                base_revision: revision(&nb, moving_block),
                parent_id: id(parent),
                after: None,
            };
            assert_validation(nb.apply(&batch(vec![moving])).unwrap_err(), 0);
            assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(10)));
            assert_eq!(nb.block(&id(10)).unwrap().parent_id, Some(id(1)));
        }
    }
    let visible_move = Operation::Move {
        id: id(10),
        base_revision: revision(&nb, 10),
        parent_id: id(2),
        after: None,
    };
    apply(&mut nb, vec![visible_move]);
    assert_eq!(nb.block(&id(11)).unwrap().page_id, id(2));
    assert_eq!(nb.active_work_session().unwrap(), Some(running.clone()));

    let hiding = Operation::SetArchived {
        id: id(2),
        base_revision: revision(&nb, 2),
        archived: true,
    };
    assert_validation(nb.apply(&batch(vec![hiding])).unwrap_err(), 0);
    let stopping = stop(&nb, &running, 200, "Now safe to hide");
    let hiding = Operation::SetArchived {
        id: id(2),
        base_revision: revision(&nb, 2),
        archived: true,
    };
    apply(&mut nb, vec![stopping, hiding]);
    assert!(nb.block(&id(2)).unwrap().archived);
    assert_eq!(nb.active_work_session().unwrap(), None);
    assert_eq!(session(&nb, 11, 100).ended_at, Some(200));
}

#[test]
fn retained_history_is_chronological_through_reversal_archive_move_delete_and_restore() {
    let (dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 102, 100);
    apply(&mut nb, vec![beginning]);
    let latest = session(&nb, 11, 102);
    let stopping = stop(&nb, &latest, 150, "Latest event time");
    apply(&mut nb, vec![stopping]);
    let beginning = start(&nb, 11, 101, 10);
    apply(&mut nb, vec![beginning]);
    let earlier = session(&nb, 11, 101);
    let reversing = state(&nb, &earlier, None, true);
    apply(&mut nb, vec![reversing]);
    let beginning = start(&nb, 11, 100, 10);
    apply(&mut nb, vec![beginning]);
    let tied = session(&nb, 11, 100);
    let stopping = stop(&nb, &tied, 10, "Tied event time");
    apply(&mut nb, vec![stopping]);
    let history = nb.work_sessions(&id(11)).unwrap();
    assert_eq!(
        history.iter().map(|row| row.id.clone()).collect::<Vec<_>>(),
        vec![id(100), id(101), id(102)]
    );
    assert!(history[1].reversed);
    assert_eq!(history[1].ended_at, None);
    assert_eq!(nb.active_work_session().unwrap(), None);

    let archive = Operation::SetArchived {
        id: id(10),
        base_revision: revision(&nb, 10),
        archived: true,
    };
    apply(&mut nb, vec![archive]);
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), history);
    let reveal = Operation::SetArchived {
        id: id(10),
        base_revision: revision(&nb, 10),
        archived: false,
    };
    apply(&mut nb, vec![reveal]);
    let move_hidden = Operation::Move {
        id: id(10),
        base_revision: revision(&nb, 10),
        parent_id: id(21),
        after: None,
    };
    apply(&mut nb, vec![move_hidden]);
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), history);
    let undo_hidden = state(&nb, &history[1], None, false);
    assert_validation(nb.apply(&batch(vec![undo_hidden])).unwrap_err(), 0);

    let parent_revision = revision(&nb, 10);
    let deletion = apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(10),
            base_revision: parent_revision,
        }],
    );
    assert!(nb.block(&id(11)).is_err());
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), history);
    apply(
        &mut nb,
        vec![Operation::Restore {
            id: id(10),
            revision: parent_revision + 1,
            deletion_id: deletion.deletions[0].clone(),
        }],
    );
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), history);
    assert_eq!(nb.active_work_session().unwrap(), None);
    let move_visible = Operation::Move {
        id: id(10),
        base_revision: revision(&nb, 10),
        parent_id: id(1),
        after: None,
    };
    apply(&mut nb, vec![move_visible]);
    assert_eq!(nb.work_sessions(&id(11)).unwrap(), history);
    drop(nb);
    let reopened = Notebook::open(dir.path()).unwrap();
    assert_eq!(reopened.work_sessions(&id(11)).unwrap(), history);
}

#[test]
fn merging_a_parent_cannot_hide_its_running_descendant() {
    let (_dir, mut nb) = fixture();
    let beginning = start(&nb, 11, 100, 100);
    apply(&mut nb, vec![beginning]);
    let running = session(&nb, 11, 100);
    let parent = nb.block(&id(10)).unwrap();
    let destination = nb.block(&id(20)).unwrap();
    let merging = Operation::Merge {
        source_id: parent.id.clone(),
        source_revision: parent.revision,
        destination_id: destination.id.clone(),
        destination_revision: destination.revision,
    };
    assert_validation(nb.apply(&batch(vec![merging])).unwrap_err(), 0);
    assert_eq!(nb.block(&id(10)).unwrap(), parent);
    assert_eq!(nb.block(&id(20)).unwrap(), destination);
    assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(10)));
    assert_eq!(nb.active_work_session().unwrap(), Some(running));
}
