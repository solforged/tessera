use tessera_core::{
    Actor, Batch, ChangeStamp, Committed, DATABASE_FILE, Error, Notebook, Operation, TaskFilter,
    TaskQuery, TaskSelection, TaskState, TaskStatus,
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

fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![Operation::CreatePage {
            id: id(1),
            title: "Daily notes".into(),
        }],
    );
    (dir, nb)
}

fn insert(value: u128, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(1),
        after: None,
        text: text.into(),
        heading: None,
    }
}

fn edit(nb: &Notebook, value: u128, text: &str) -> Operation {
    Operation::EditText {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        text: text.into(),
    }
}

fn set_task(nb: &Notebook, value: u128, task: Option<TaskState>) -> Operation {
    Operation::SetTask {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        task,
    }
}

fn validation(error: Error, expected: &str) {
    assert!(matches!(error, Error::Validation { message, .. } if message == expected));
}

#[test]
fn typing_and_removing_task_preserves_completion_history_and_command_tasks() {
    let (_dir, mut nb) = fixture();
    let receipt = apply(
        &mut nb,
        vec![insert(10, "Write #task"), insert(11, "Command task")],
    );
    assert_eq!(
        nb.capabilities(&id(10)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|caps| caps.block_id == id(10) && caps.task.is_some())
    );
    let task_page = nb.page_by_title("task").unwrap().unwrap();
    assert_eq!(task_page.text, "Task");
    assert!(nb.capabilities(&task_page.id).unwrap().built_in_tag);
    assert!(
        nb.page(&task_page.id)
            .unwrap()
            .capabilities
            .iter()
            .any(|caps| caps.built_in_tag)
    );
    let task = nb
        .note_index()
        .unwrap()
        .kinds
        .into_iter()
        .find(|entry| entry.kind.key == "task")
        .unwrap();
    assert!(task.tag);
    assert_eq!(task.kind.type_id.as_deref(), Some(task_page.id.as_str()));
    assert_eq!(task.tagged_block_count, 1);
    let command = set_task(
        &nb,
        11,
        Some(TaskState {
            status: Some(TaskStatus::Todo),
            ..Default::default()
        }),
    );
    apply(&mut nb, vec![command]);
    let complete = Operation::CompleteTask {
        id: id(10),
        base_revision: nb.block(&id(10)).unwrap().revision,
        occurrence_id: id(100),
        completed_on: "2026-10-17".into(),
    };
    apply(&mut nb, vec![complete]);
    let history = nb.task_occurrences(&id(10)).unwrap();
    let changes = vec![edit(&nb, 10, "Write"), edit(&nb, 11, "Command task edited")];
    let removed = apply(&mut nb, changes);
    assert!(nb.capabilities(&id(10)).unwrap().task.is_none());
    assert!(
        removed
            .capabilities
            .iter()
            .any(|caps| caps.block_id == id(10) && caps.task.is_none())
    );
    assert_eq!(nb.task_occurrences(&id(10)).unwrap(), history);
    assert_eq!(
        nb.capabilities(&id(11)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
    assert_eq!(nb.page_by_title("Task").unwrap().unwrap().id, task_page.id);
}

#[test]
fn manual_and_text_membership_are_compared_per_block_at_batch_boundaries() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(10, "#task"),
            insert(11, "No tag"),
            insert(12, "Another"),
        ],
    );
    let revision = nb.block(&id(10)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::AddType {
            id: id(10),
            base_revision: revision,
            title: "TASK".into(),
        }],
    );
    let changes = vec![edit(&nb, 10, "Only manual"), edit(&nb, 11, "#task")];
    apply(&mut nb, changes);
    assert!(nb.capabilities(&id(10)).unwrap().task.is_some());
    assert!(nb.capabilities(&id(11)).unwrap().task.is_some());
    let revision = nb.block(&id(10)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::RemoveType {
            id: id(10),
            base_revision: revision,
            title: "Task".into(),
        }],
    );
    assert!(nb.capabilities(&id(10)).unwrap().task.is_none());
    apply(
        &mut nb,
        vec![
            Operation::AddType {
                id: id(12),
                base_revision: 1,
                title: "task".into(),
            },
            Operation::RemoveType {
                id: id(12),
                base_revision: 2,
                title: "task".into(),
            },
        ],
    );
    assert!(nb.capabilities(&id(12)).unwrap().task.is_none());
    let revision = nb.block(&id(12)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::AddType {
            id: id(12),
            base_revision: revision,
            title: "task".into(),
        }],
    );
    assert_eq!(
        nb.capabilities(&id(12)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
    let changes = vec![
        edit(&nb, 11, "No longer a task"),
        edit(&nb, 12, "Still manually tagged"),
    ];
    apply(&mut nb, changes);
    assert!(nb.capabilities(&id(11)).unwrap().task.is_none());
    assert!(nb.capabilities(&id(12)).unwrap().task.is_some());
}

#[test]
fn removing_capabilities_strips_bare_bracketed_and_manual_tags_with_receipts() {
    let (_dir, mut nb) = fixture();
    for (offset, key) in ["task", "question", "project", "source"]
        .into_iter()
        .enumerate()
    {
        let value = 10 + offset as u128;
        let text = format!("Read #{key} #[[{key}]] next `#{key}`");
        apply(&mut nb, vec![insert(value, &text)]);
        let revision = nb.block(&id(value)).unwrap().revision;
        apply(
            &mut nb,
            vec![Operation::AddType {
                id: id(value),
                base_revision: revision,
                title: key.into(),
            }],
        );
        let base_revision = nb.block(&id(value)).unwrap().revision;
        let operation = match key {
            "task" => Operation::SetTask {
                id: id(value),
                base_revision,
                task: None,
            },
            "question" => Operation::SetQuestion {
                id: id(value),
                base_revision,
                question: None,
            },
            "project" => Operation::SetProject {
                id: id(value),
                base_revision,
                project: None,
            },
            "source" => Operation::SetSource {
                id: id(value),
                base_revision,
                source: None,
            },
            _ => unreachable!(),
        };
        let receipt = apply(&mut nb, vec![operation]);
        let after = format!("Read next `#{key}`");
        assert_eq!(nb.block(&id(value)).unwrap().text, after);
        assert_eq!(receipt.text_rewrites.len(), 1);
        assert_eq!(receipt.text_rewrites[0].before, text);
        assert_eq!(receipt.text_rewrites[0].after, after);
        assert_eq!(
            receipt.text_rewrites[0].revision,
            nb.block(&id(value)).unwrap().revision
        );
        let caps = nb.capabilities(&id(value)).unwrap();
        assert!(
            caps.task.is_none()
                && caps.question.is_none()
                && caps.project.is_none()
                && caps.source.is_none()
        );
    }
    assert!(nb.check(false).unwrap().ok);
}

#[test]
fn built_in_capabilities_activate_on_plain_atoms_with_canonical_pages() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![insert(10, "Read #question #source #project #person")],
    );
    let caps = nb.capabilities(&id(10)).unwrap();
    assert!(caps.question.is_some());
    assert_eq!(caps.project.unwrap(), tessera_core::ProjectState::default());
    let source = caps.source.unwrap();
    assert_eq!(source.format, tessera_core::library::SourceFormat::Record);
    assert_eq!(source.state, tessera_core::library::ReadingState::Inbox);
    assert!(source.current_snapshot_id.is_none());
    for title in ["Question", "Source", "Project", "Person"] {
        assert_eq!(nb.page_by_title(title).unwrap().unwrap().text, title);
    }
    for key in ["task", "question", "project", "source"] {
        assert!(
            nb.note_index()
                .unwrap()
                .kinds
                .iter()
                .any(|entry| entry.kind.key == key && entry.tag)
        );
    }
    let change = edit(&nb, 10, "Read");
    apply(&mut nb, vec![change]);
    let caps = nb.capabilities(&id(10)).unwrap();
    assert!(caps.question.is_none() && caps.project.is_none() && caps.source.is_none());
    // The pages outlive their last member as system pages, never listed as Unfiled notes.
    let index = nb.note_index().unwrap();
    let unfiled = index
        .kinds
        .iter()
        .find(|entry| entry.kind.key == "unfiled")
        .unwrap();
    assert_eq!(
        unfiled.count, 1,
        "only the fixture's Daily notes page is unfiled"
    );
    assert_eq!(index.notes, 1);
}

#[test]
fn built_in_pages_refuse_delete_merge_and_rename_but_allow_case_changes() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![insert(10, "#task")]);
    let task = nb.page_by_title("Task").unwrap().unwrap();
    validation(
        nb.apply(&batch(vec![Operation::Delete {
            id: task.id.clone(),
            base_revision: task.revision,
        }]))
        .unwrap_err(),
        "Task is a built-in tag; its page cannot be deleted.",
    );
    validation(
        nb.apply(&batch(vec![Operation::EditText {
            id: task.id.clone(),
            base_revision: task.revision,
            text: "Errands".into(),
        }]))
        .unwrap_err(),
        "Task is a built-in tag; its name cannot change.",
    );
    validation(
        nb.apply(&batch(vec![Operation::MergePage {
            source_id: task.id.clone(),
            source_revision: task.revision,
            destination_id: id(1),
            destination_revision: nb.block(&id(1)).unwrap().revision,
        }]))
        .unwrap_err(),
        "Task is a built-in tag; its page cannot merge.",
    );
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: task.id.clone(),
            base_revision: task.revision,
            text: "TASK".into(),
        }],
    );
    assert!(nb.capabilities(&task.id).unwrap().built_in_tag);
    assert_eq!(
        nb.capabilities(&id(10)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
}

#[test]
fn appointments_have_no_todo_filter_or_completion_and_gain_status_from_task_tag() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![insert(10, "Meeting")]);
    let appointment = TaskState {
        scheduled: Some("2026-10-17".into()),
        scheduled_time: Some("09:00".into()),
        ..Default::default()
    };
    let change = set_task(&nb, 10, Some(appointment.clone()));
    apply(&mut nb, vec![change]);
    let agenda = nb.agenda("2026-10-17").unwrap();
    assert_eq!(agenda.items.len(), 1);
    assert_eq!(agenda.items[0].task, appointment);
    assert_eq!(agenda.items[0].time.as_deref(), Some("09:00"));
    assert!(nb.agenda("2026-10-18").unwrap().items.is_empty());
    for selection in [
        TaskSelection::All,
        TaskSelection::Unfinished,
        TaskSelection::UnfinishedOrRecent,
    ] {
        let query = TaskQuery {
            source: None,
            filter: TaskFilter {
                selection,
                ..Default::default()
            },
            context_date: "2026-10-17".into(),
            limit: None,
        };
        assert_eq!(nb.task_query(&query).unwrap().total, 0);
    }
    let revision = nb.block(&id(10)).unwrap().revision;
    validation(
        nb.apply(&batch(vec![Operation::CompleteTask {
            id: id(10),
            base_revision: revision,
            occurrence_id: id(100),
            completed_on: "2026-10-17".into(),
        }]))
        .unwrap_err(),
        "Add #task before completing.",
    );
    assert!(nb.task_occurrences(&id(10)).unwrap().is_empty());
    let change = edit(&nb, 10, "Meeting #task");
    apply(&mut nb, vec![change]);
    assert_eq!(
        nb.capabilities(&id(10)).unwrap().task.unwrap(),
        TaskState {
            status: Some(TaskStatus::Todo),
            ..appointment
        }
    );
    assert_eq!(
        serde_json::from_str::<TaskState>("{}").unwrap().status,
        None
    );
    assert_eq!(
        serde_json::from_str::<TaskState>(r#"{"status":"todo"}"#)
            .unwrap()
            .status,
        Some(TaskStatus::Todo)
    );
}

#[test]
fn check_reports_and_repairs_inactive_and_missing_tagged_capabilities() {
    let (dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(10, "#task"),
            insert(11, "#question"),
            insert(12, "#project"),
            insert(13, "#source"),
        ],
    );
    let db = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    db.execute_batch("UPDATE tasks SET active = 0; DELETE FROM questions; UPDATE projects SET active = 0; DELETE FROM sources;").unwrap();
    let report = nb.check(false).unwrap();
    assert!(!report.ok);
    let rule = report
        .invariants
        .iter()
        .find(|rule| rule.name == "built_in_tag_keeps_capability")
        .unwrap();
    assert_eq!(rule.samples, [id(10), id(11), id(12), id(13)]);
    assert_eq!(rule.violations, 4);
    assert!(nb.capabilities(&id(10)).unwrap().task.is_none());
    let report = nb.check(true).unwrap();
    assert!(report.repaired.is_some());
    assert!(!report.unresolved());
    assert_eq!(
        nb.capabilities(&id(10)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
    assert!(nb.capabilities(&id(11)).unwrap().question.is_some());
    assert!(nb.capabilities(&id(12)).unwrap().project.is_some());
    assert!(nb.capabilities(&id(13)).unwrap().source.is_some());
    assert!(nb.check(false).unwrap().ok);
}

#[test]
fn stamped_membership_changes_and_none_removal_replay_identically() {
    let (_left_dir, mut left) = fixture();
    let (_right_dir, mut right) = fixture();
    let request = batch(vec![insert(10, "Read #task #question #project #source")]);
    let stamp = ChangeStamp {
        id: id(100),
        origin: id(101),
        at: 1_800_000_000_000,
    };
    left.apply_stamped(&request, &stamp).unwrap();
    right.apply_stamped(&request, &stamp).unwrap();
    assert_eq!(
        left.capabilities(&id(10)).unwrap(),
        right.capabilities(&id(10)).unwrap()
    );
    assert_eq!(
        left.page_by_title("Task").unwrap(),
        right.page_by_title("Task").unwrap()
    );
    let request = batch(vec![set_task(&left, 10, None)]);
    let stamp = ChangeStamp {
        id: id(102),
        ..stamp
    };
    let l = left.apply_stamped(&request, &stamp).unwrap();
    let r = right.apply_stamped(&request, &stamp).unwrap();
    assert_eq!(l.text_rewrites, r.text_rewrites);
    assert_eq!(left.block(&id(10)).unwrap(), right.block(&id(10)).unwrap());
    assert_eq!(
        left.capabilities(&id(10)).unwrap(),
        right.capabilities(&id(10)).unwrap()
    );
}

#[test]
fn explicit_removal_bumps_once_and_later_batch_text_can_restore_the_tag() {
    let (_dir, mut nb) = fixture();
    apply(&mut nb, vec![insert(10, "Read #task")]);
    let revision = nb.block(&id(10)).unwrap().revision;
    let remove = set_task(&nb, 10, None);
    let receipt = apply(
        &mut nb,
        vec![
            remove,
            Operation::EditText {
                id: id(10),
                base_revision: revision + 1,
                text: "Read #task".into(),
            },
        ],
    );
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|caps| caps.block_id == id(10) && caps.task.is_some())
    );
    assert_eq!(
        nb.capabilities(&id(10)).unwrap().task.unwrap().status,
        Some(TaskStatus::Todo)
    );
    assert!(nb.check(false).unwrap().ok);
}

#[test]
fn journal_roots_still_refuse_source_records() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![Operation::CreateJournal {
            id: id(10),
            date: "2026-10-17".into(),
        }],
    );
    validation(
        nb.apply(&batch(vec![Operation::SetSource {
            id: id(10),
            base_revision: 1,
            source: Some(tessera_core::library::SourceState {
                format: tessera_core::library::SourceFormat::Record,
                state: tessera_core::library::ReadingState::Inbox,
                origin: None,
                match_key: None,
                citation_key: None,
            }),
        }]))
        .unwrap_err(),
        "A journal cannot be a source.",
    );
}
