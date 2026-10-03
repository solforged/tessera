use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater};
use tessera_core::{
    Actor, Agenda, AgendaReason, Batch, Committed, DateRange, Error, Filter, FilterOp, Notebook,
    Operation, ProjectState, ProjectStatus, Query, Revision, TaskFilter, TaskPriority, TaskQuery,
    TaskQueryResult, TaskSelection, TaskState, TaskStatus,
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
        vec![Operation::CreatePage {
            id: id(1),
            title: "Tasks".into(),
        }],
    );
    (dir, nb)
}

fn set_task(nb: &mut Notebook, value: u128, task: Option<TaskState>) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetTask {
            id: id(value),
            base_revision,
            task,
        }],
    );
}

fn task(nb: &mut Notebook, value: u128, state: TaskState) {
    apply(nb, vec![insert(value, 1, &format!("Task {value}"))]);
    set_task(nb, value, Some(state));
}

fn complete(nb: &mut Notebook, value: u128, occurrence: u128, date: &str) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::CompleteTask {
            id: id(value),
            base_revision,
            occurrence_id: id(occurrence),
            completed_on: date.into(),
        }],
    );
}

fn reverse(nb: &mut Notebook, value: u128, occurrence: u128) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::ReverseTaskCompletion {
            id: id(value),
            base_revision,
            occurrence_id: id(occurrence),
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

fn project(nb: &mut Notebook, value: u128, state: Option<ProjectState>) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetProject {
            id: id(value),
            base_revision,
            project: state,
        }],
    );
}

fn query() -> TaskQuery {
    TaskQuery {
        source: None,
        filter: TaskFilter::default(),
        context_date: "2026-10-03".into(),
        limit: None,
    }
}

fn ids(result: TaskQueryResult) -> Vec<String> {
    let mut ids: Vec<_> = result
        .rows
        .into_iter()
        .map(|row| row.source.block.id)
        .collect();
    ids.sort();
    ids
}

fn agenda_ids(result: Agenda) -> Vec<String> {
    let mut ids: Vec<_> = result
        .items
        .into_iter()
        .map(|row| row.source.block.id)
        .collect();
    ids.sort();
    ids
}

fn planned(scheduled: Option<&str>, deadline: Option<&str>) -> TaskState {
    TaskState {
        scheduled: scheduled.map(str::to_owned),
        deadline: deadline.map(str::to_owned),
        ..TaskState::default()
    }
}

#[test]
fn selection_uses_inclusive_unreversed_occurrences_and_explicit_status_intersection() {
    let (_dir, mut nb) = fixture();
    for (value, status) in [
        (10, TaskStatus::Todo),
        (11, TaskStatus::Doing),
        (12, TaskStatus::Waiting),
        (13, TaskStatus::Cancelled),
    ] {
        task(
            &mut nb,
            value,
            TaskState {
                status,
                ..TaskState::default()
            },
        );
    }
    for (value, date) in [
        (14, "2026-09-27"),
        (15, "2026-09-26"),
        (16, "2026-10-03"),
        (17, "2026-10-04"),
        (18, "2026-10-03"),
        (19, "2026-10-03"),
    ] {
        task(&mut nb, value, TaskState::default());
        complete(&mut nb, value, value + 100, date);
    }
    reverse(&mut nb, 18, 118);
    set_task(
        &mut nb,
        19,
        Some(TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        }),
    );
    task(&mut nb, 20, TaskState::default());
    complete(&mut nb, 20, 120, "2026-10-03");
    set_task(&mut nb, 20, None);
    task(&mut nb, 21, TaskState::default());
    complete(&mut nb, 21, 121, "2026-10-03");
    reverse(&mut nb, 21, 121);
    set_task(
        &mut nb,
        21,
        Some(TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        }),
    );

    let mut q = query();
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![id(10), id(11), id(12), id(14), id(16), id(18)]
    );
    q.filter.recent_days = 1;
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![id(10), id(11), id(12), id(16), id(18)]
    );
    q.filter.statuses = vec![TaskStatus::Done];
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(16)]);
    q.filter.statuses = vec![TaskStatus::Cancelled];
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(19)]);
    q.filter.selection = TaskSelection::Unfinished;
    assert_eq!(ids(nb.task_query(&q).unwrap()), Vec::<String>::new());
    q.filter.statuses = vec![TaskStatus::Doing, TaskStatus::Waiting];
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(11), id(12)]);
    q.filter.statuses.clear();
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![id(10), id(11), id(12), id(18)]
    );
    q.filter.selection = TaskSelection::All;
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![
            id(10),
            id(11),
            id(12),
            id(14),
            id(15),
            id(16),
            id(17),
            id(18)
        ]
    );
    q.filter.statuses = vec![TaskStatus::Cancelled];
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![id(13), id(19), id(21)]
    );
}

#[test]
fn date_filters_are_independent_inclusive_and_precede_outer_limit() {
    let (_dir, mut nb) = fixture();
    for (value, scheduled, deadline) in [
        (10, Some("2026-10-01"), Some("2026-10-05")),
        (11, Some("2026-10-02"), Some("2026-10-04")),
        (12, Some("2026-10-03"), Some("2026-10-03")),
        (13, Some("2026-10-04"), Some("2026-10-02")),
        (14, None, Some("2026-10-03")),
        (15, Some("2026-10-03"), None),
        (16, None, None),
    ] {
        task(&mut nb, value, planned(scheduled, deadline));
    }
    let mut q = query();
    q.filter.scheduled = Some(DateRange {
        from: Some("2026-10-02".into()),
        through: Some("2026-10-03".into()),
    });
    assert_eq!(
        ids(nb.task_query(&q).unwrap()),
        vec![id(11), id(12), id(15)]
    );
    q.filter.deadline = Some(DateRange {
        from: Some("2026-10-03".into()),
        through: Some("2026-10-03".into()),
    });
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(12)]);
    q.filter.scheduled = None;
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(12), id(14)]);
    q.filter.deadline = Some(DateRange {
        from: None,
        through: Some("2026-10-02".into()),
    });
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(13)]);
    q.filter.deadline = Some(DateRange {
        from: Some("2026-10-04".into()),
        through: None,
    });
    q.limit = Some(1);
    let result = nb.task_query(&q).unwrap();
    assert_eq!(result.total, 2);
    assert_eq!(ids(result), vec![id(10)]);
    q.limit = Some(0);
    let result = nb.task_query(&q).unwrap();
    assert_eq!(result.total, 2);
    assert!(result.rows.is_empty());
}

#[test]
fn planning_sort_uses_matching_clock_then_priority_and_stable_identity() {
    let (_dir, mut nb) = fixture();
    for (value, scheduled, deadline, time, priority) in [
        (
            10,
            Some("2026-10-04"),
            Some("2026-10-01"),
            Some("07:00"),
            Some(TaskPriority::High),
        ),
        (11, Some("2026-10-03"), None, None, Some(TaskPriority::High)),
        (12, Some("2026-10-03"), None, Some("10:00"), None),
        (
            13,
            None,
            Some("2026-10-03"),
            Some("09:00"),
            Some(TaskPriority::Low),
        ),
        (
            14,
            Some("2026-10-03"),
            None,
            Some("09:00"),
            Some(TaskPriority::Medium),
        ),
        (
            15,
            Some("2026-10-03"),
            None,
            Some("09:00"),
            Some(TaskPriority::High),
        ),
        (
            16,
            Some("2026-10-03"),
            None,
            Some("09:00"),
            Some(TaskPriority::High),
        ),
        (17, Some("2026-10-03"), None, Some("09:00"), None),
        (18, None, None, None, Some(TaskPriority::High)),
    ] {
        let mut state = planned(scheduled, deadline);
        if scheduled.is_some() {
            state.scheduled_time = time.map(str::to_owned);
        } else {
            state.deadline_time = time.map(str::to_owned);
        }
        state.priority = priority;
        task(&mut nb, value, state);
    }
    assert_eq!(
        nb.task_query(&query())
            .unwrap()
            .rows
            .into_iter()
            .map(|row| row.source.block.id)
            .collect::<Vec<_>>(),
        vec![
            id(15),
            id(16),
            id(14),
            id(13),
            id(17),
            id(12),
            id(11),
            id(10),
            id(18)
        ]
    );
}

#[test]
fn agenda_uses_displayed_day_all_reasons_and_only_applicable_clock_labels() {
    let (_dir, mut nb) = fixture();
    let mut overdue = planned(Some("2026-10-10"), Some("2026-10-02"));
    overdue.scheduled_time = Some("01:00".into());
    overdue.deadline_time = Some("09:00".into());
    task(&mut nb, 10, overdue);
    let mut both = planned(Some("2026-10-03"), Some("2026-10-03"));
    both.scheduled_time = Some("10:00".into());
    both.deadline_time = Some("08:00".into());
    both.warning_days = Some(0);
    task(&mut nb, 11, both);
    let mut warned = planned(None, Some("2026-10-05"));
    warned.warning_days = Some(2);
    task(&mut nb, 12, warned);
    task(&mut nb, 13, planned(Some("2026-10-04"), None));
    task(&mut nb, 14, TaskState::default());
    task(
        &mut nb,
        15,
        TaskState {
            status: TaskStatus::Waiting,
            ..planned(Some("2026-10-02"), None)
        },
    );
    task(
        &mut nb,
        16,
        TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        },
    );
    task(&mut nb, 17, planned(None, Some("2026-10-04")));
    let agenda = nb.agenda("2026-10-03").unwrap();
    assert_eq!(agenda.date, "2026-10-03");
    assert_eq!(
        agenda
            .items
            .iter()
            .map(|row| row.source.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(11), id(10), id(12), id(14), id(15)]
    );
    assert_eq!(
        agenda.items[0].reasons,
        vec![
            AgendaReason::Scheduled,
            AgendaReason::Deadline,
            AgendaReason::Warning
        ]
    );
    assert_eq!(agenda.items[0].time.as_deref(), Some("08:00"));
    assert_eq!(
        agenda.items[1].reasons,
        vec![AgendaReason::Deadline, AgendaReason::Overdue]
    );
    assert_eq!(agenda.items[1].time.as_deref(), Some("09:00"));
    assert_eq!(agenda.items[2].reasons, vec![AgendaReason::Warning]);
    assert_eq!(agenda.items[3].reasons, vec![AgendaReason::Unplanned]);
    assert_eq!(agenda.items[4].reasons, vec![AgendaReason::Scheduled]);
    assert_eq!(agenda_ids(nb.agenda("2026-10-01").unwrap()), vec![id(14)]);
    assert_eq!(
        agenda_ids(nb.agenda("2026-10-02").unwrap()),
        vec![id(10), id(14), id(15)]
    );
    assert_eq!(
        agenda_ids(nb.agenda("2026-10-04").unwrap()),
        vec![id(10), id(11), id(12), id(13), id(14), id(15), id(17)]
    );
}

#[test]
fn historical_journal_projects_latest_occurrence_without_advanced_recurrence_or_duplicates() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            Operation::CreateJournal {
                id: id(2),
                date: "2026-10-01".into(),
            },
            insert(10, 2, "Repeat"),
        ],
    );
    let mut state = planned(Some("2026-10-01"), Some("2026-09-30"));
    state.scheduled_time = Some("11:00".into());
    state.deadline_time = Some("12:00".into());
    state.repeater = Some(Repeater {
        every: 1,
        unit: RepeatUnit::Day,
        mode: RepeatMode::Fixed,
    });
    set_task(&mut nb, 10, Some(state));
    let base_revision = nb.block(&id(10)).unwrap().revision;
    apply(
        &mut nb,
        vec![
            Operation::CompleteTask {
                id: id(10),
                base_revision,
                occurrence_id: id(200),
                completed_on: "2026-10-03".into(),
            },
            Operation::CompleteTask {
                id: id(10),
                base_revision: base_revision + 1,
                occurrence_id: id(100),
                completed_on: "2026-10-03".into(),
            },
        ],
    );
    let recent = nb.task_query(&query()).unwrap();
    assert_eq!(recent.total, 1);
    assert_eq!(recent.rows[0].task.status, TaskStatus::Todo);
    assert_eq!(recent.rows[0].task.scheduled.as_deref(), Some("2026-10-03"));
    assert_eq!(recent.rows[0].task.deadline.as_deref(), Some("2026-10-02"));
    let agenda = nb.agenda("2026-10-03").unwrap();
    assert_eq!(agenda.items.len(), 1);
    let row = &agenda.items[0];
    assert_eq!(row.source.block.id, id(10));
    assert_eq!(row.source.page.id, id(2));
    assert_eq!(row.task.status, TaskStatus::Done);
    assert_eq!(row.task.completed_on.as_deref(), Some("2026-10-03"));
    assert_eq!(row.task.scheduled.as_deref(), Some("2026-10-02"));
    assert_eq!(row.task.deadline.as_deref(), Some("2026-10-01"));
    assert_eq!(
        row.reasons,
        vec![
            AgendaReason::Scheduled,
            AgendaReason::Deadline,
            AgendaReason::Overdue,
            AgendaReason::RecentlyCompleted
        ]
    );
    assert_eq!(row.time.as_deref(), Some("11:00"));
    reverse(&mut nb, 10, 100);
    let first = nb.agenda("2026-10-03").unwrap();
    assert_eq!(first.items[0].task.scheduled.as_deref(), Some("2026-10-01"));
    let mut changed = planned(Some("2026-10-20"), None);
    changed.scheduled_time = Some("01:00".into());
    set_task(&mut nb, 10, Some(changed));
    let historical = nb.agenda("2026-10-03").unwrap();
    assert_eq!(historical.items[0].source.block.id, id(10));
    assert_eq!(historical.items[0].task, first.items[0].task);
    assert_eq!(historical.items[0].reasons, first.items[0].reasons);
    assert_eq!(historical.items[0].time, first.items[0].time);
    set_task(
        &mut nb,
        10,
        Some(TaskState {
            status: TaskStatus::Cancelled,
            ..TaskState::default()
        }),
    );
    assert!(nb.agenda("2026-10-03").unwrap().items.is_empty());
}

#[test]
fn agenda_ignores_future_and_reversed_completions_and_keeps_reopened_history() {
    let (_dir, mut nb) = fixture();
    for value in [10, 11, 12, 13] {
        task(&mut nb, value, planned(Some("2026-10-01"), None));
    }
    complete(&mut nb, 10, 110, "2026-10-04");
    complete(&mut nb, 11, 111, "2026-10-03");
    complete(&mut nb, 12, 112, "2026-10-03");
    reverse(&mut nb, 12, 112);
    set_task(&mut nb, 12, Some(planned(Some("2026-10-10"), None)));
    complete(&mut nb, 13, 113, "2026-10-03");
    set_task(&mut nb, 13, Some(planned(Some("2026-10-10"), None)));
    let agenda = nb.agenda("2026-10-03").unwrap();
    assert_eq!(agenda_ids(agenda.clone()), vec![id(11), id(13)]);
    assert!(
        agenda
            .items
            .iter()
            .all(|row| row.task.status == TaskStatus::Done
                && row.task.completed_on.as_deref() == Some("2026-10-03"))
    );
    assert_eq!(agenda_ids(nb.agenda("2026-10-04").unwrap()), vec![id(10)]);
}

#[test]
fn project_membership_follows_canonical_nested_ancestry_visibility_and_moves() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(10, 1, "Outer"),
            insert(11, 10, "Inner"),
            insert(12, 11, "Middle"),
            insert(20, 10, "Direct"),
            insert(21, 12, "Nested"),
            insert(22, 1, "Outside"),
        ],
    );
    project(&mut nb, 10, Some(ProjectState::default()));
    project(
        &mut nb,
        11,
        Some(ProjectState {
            status: ProjectStatus::Done,
            ..ProjectState::default()
        }),
    );
    for value in [10, 20, 21, 22] {
        set_task(&mut nb, value, Some(TaskState::default()));
    }
    let mut q = query();
    q.filter.project_id = Some(id(10));
    let rows = nb.task_query(&q).unwrap();
    assert_eq!(ids(rows.clone()), vec![id(20), id(21)]);
    assert_eq!(rows.rows[0].project_id, Some(id(10)));
    assert_eq!(rows.rows[1].project_id, Some(id(11)));
    q.filter.project_id = Some(id(11));
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(21)]);
    archive(&mut nb, 12, true);
    assert!(nb.task_query(&q).unwrap().rows.is_empty());
    assert_eq!(
        agenda_ids(nb.agenda("2026-10-03").unwrap()),
        vec![id(10), id(20), id(22)]
    );
    archive(&mut nb, 12, false);
    project(&mut nb, 11, None);
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    q.filter.project_id = Some(id(10));
    assert_eq!(nb.task_query(&q).unwrap().rows[1].project_id, Some(id(10)));
    let base_revision = nb.block(&id(21)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Move {
            id: id(21),
            base_revision,
            parent_id: id(1),
            after: None,
        }],
    );
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(20)]);
    archive(&mut nb, 10, true);
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    q.filter.project_id = None;
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(21), id(22)]);
    archive(&mut nb, 10, false);
    let base_revision = nb.block(&id(10)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(10),
            base_revision,
        }],
    );
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(21), id(22)]);
    let base_revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(1),
            base_revision,
        }],
    );
    assert!(nb.task_query(&q).unwrap().rows.is_empty());
    assert!(nb.agenda("2026-10-03").unwrap().items.is_empty());
}

#[test]
fn more_than_five_hundred_source_candidates_are_filtered_before_task_limit() {
    let (_dir, mut nb) = fixture();
    let mut operations: Vec<_> = (10..620)
        .map(|value| insert(value, 1, &format!("Candidate {value}")))
        .collect();
    for (value, priority) in [
        (590, TaskPriority::Low),
        (600, TaskPriority::High),
        (601, TaskPriority::High),
    ] {
        operations.push(Operation::SetTask {
            id: id(value),
            base_revision: 1,
            task: Some(TaskState {
                priority: Some(priority),
                ..TaskState::default()
            }),
        });
    }
    apply(&mut nb, operations);
    let source = Query {
        r#type: None,
        text: Some("Candidate".into()),
        filters: vec![],
        sort: vec![],
        limit: None,
    };
    let public = nb.query(&source).unwrap();
    assert_eq!(public.total, 610);
    assert_eq!(public.rows.len(), 500);
    let mut q = query();
    q.source = Some(source);
    q.filter.priority = Some(TaskPriority::High);
    q.limit = Some(1);
    for source_limit in [None, Some(1), Some(0)] {
        q.source.as_mut().unwrap().limit = source_limit;
        let result = nb.task_query(&q).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(ids(result), vec![id(600)]);
    }
    q.limit = Some(2000);
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(600), id(601)]);
}

#[test]
fn source_type_text_and_field_filters_intersect_before_task_selection() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(2),
                title: "Actions".into(),
            },
            Operation::Insert {
                id: id(3),
                parent_id: fields,
                after: None,
                text: "Phase".into(),
                heading: None,
            },
            insert(10, 1, "Candidate #actions"),
            insert(11, 1, "Candidate #actions"),
            insert(12, 1, "Candidate"),
            insert(13, 1, "Other #actions"),
            insert(20, 10, &format!("[[{}]]", id(3))),
            insert(30, 20, "Ready"),
            insert(21, 11, &format!("[[{}]]", id(3))),
            insert(31, 21, "Waiting"),
            insert(22, 12, &format!("[[{}]]", id(3))),
            insert(32, 22, "Ready"),
            insert(23, 13, &format!("[[{}]]", id(3))),
            insert(33, 23, "Ready"),
        ],
    );
    for value in [10, 11, 12, 13] {
        set_task(&mut nb, value, Some(TaskState::default()));
    }
    let mut q = query();
    q.source = Some(Query {
        r#type: Some(id(2)),
        text: Some("Candidate".into()),
        filters: vec![Filter {
            field: id(3),
            op: FilterOp::Is,
            value: Some("Ready".into()),
        }],
        sort: vec![],
        limit: Some(0),
    });
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(10)]);
    q.source.as_mut().unwrap().r#type = None;
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(10), id(12)]);
    archive(&mut nb, 3, true);
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
}

#[test]
fn query_validation_covers_civil_boundaries_ranges_limits_and_live_inputs() {
    let (_dir, mut nb) = fixture();
    task(&mut nb, 10, TaskState::default());
    complete(&mut nb, 10, 110, "0001-01-01");
    task(&mut nb, 11, TaskState::default());
    complete(&mut nb, 11, 111, "9999-12-31");
    let mut q = query();
    q.context_date = "0001-01-01".into();
    q.filter.recent_days = 3660;
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(10)]);
    q.context_date = "9999-12-31".into();
    assert_eq!(ids(nb.task_query(&q).unwrap()), vec![id(11)]);
    for date in ["2026-02-29", "2026-1-01", "0000-01-01", "10000-01-01"] {
        let mut q = query();
        q.context_date = date.into();
        assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
        assert!(matches!(nb.agenda(date), Err(Error::Validation { .. })));
    }
    for recent_days in [0, 3661] {
        let mut q = query();
        q.filter.recent_days = recent_days;
        assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    }
    let mut q = query();
    q.limit = Some(2001);
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    for range in [
        DateRange {
            from: Some("2026-10-04".into()),
            through: Some("2026-10-03".into()),
        },
        DateRange {
            from: Some("2026-02-29".into()),
            through: None,
        },
        DateRange {
            from: None,
            through: Some("not a date".into()),
        },
    ] {
        for scheduled in [true, false] {
            let mut q = query();
            if scheduled {
                q.filter.scheduled = Some(range.clone());
            } else {
                q.filter.deadline = Some(range.clone());
            }
            assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
        }
    }
    for project_id in ["bad".to_owned(), id(999), id(10)] {
        let mut q = query();
        q.filter.project_id = Some(project_id);
        assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    }
    for type_id in [id(999), id(10)] {
        let mut q = query();
        q.source = Some(Query {
            r#type: Some(type_id),
            text: None,
            filters: vec![],
            sort: vec![],
            limit: None,
        });
        assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    }
    let mut q = query();
    q.source = Some(Query {
        r#type: None,
        text: None,
        filters: vec![Filter {
            field: id(999),
            op: FilterOp::Present,
            value: None,
        }],
        sort: vec![],
        limit: None,
    });
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    q.source = Some(Query {
        r#type: Some(id(1)),
        text: None,
        filters: vec![],
        sort: vec![],
        limit: None,
    });
    archive(&mut nb, 1, true);
    assert!(matches!(nb.task_query(&q), Err(Error::Validation { .. })));
    assert_eq!(nb.query(q.source.as_ref().unwrap()).unwrap().total, 0);
}

#[test]
fn saved_task_views_validate_revisions_replay_and_execute_after_reload() {
    let (dir, mut nb) = fixture();
    task(
        &mut nb,
        10,
        TaskState {
            priority: Some(TaskPriority::High),
            ..planned(Some("2026-10-03"), None)
        },
    );
    task(&mut nb, 11, TaskState::default());
    let mut q = query();
    q.filter.priority = Some(TaskPriority::High);
    q.filter.scheduled = Some(DateRange {
        from: Some("2026-10-01".into()),
        through: Some("2026-10-03".into()),
    });
    q.source = Some(Query {
        r#type: None,
        text: Some("Task".into()),
        filters: vec![],
        sort: vec![],
        limit: Some(0),
    });
    q.limit = Some(12);
    let mut create = batch(vec![Operation::SaveTaskView {
        id: id(100),
        base_revision: None,
        name: "  Focus  ".into(),
        query: q.clone(),
    }]);
    create.idempotency_key = Some("save-task-view".into());
    let committed = nb.apply(&create).unwrap();
    assert_eq!(
        committed.task_views,
        vec![Revision {
            id: id(100),
            revision: 1
        }]
    );
    assert!(committed.revisions.is_empty());
    assert!(nb.apply(&create).unwrap().replayed);
    let saved = nb.task_view(&id(100)).unwrap();
    assert_eq!(saved.name, "Focus");
    assert_eq!(saved.query, q);
    let events = nb.changes_since(committed.seq - 1, 1).unwrap();
    assert_eq!(events[0].task_views, vec![id(100)]);
    assert!(events[0].removed.is_empty());
    create.idempotency_key = None;
    assert!(matches!(
        nb.apply(&create),
        Err(Error::Conflict {
            expected: 0,
            found: Some(1),
            ..
        })
    ));
    for name in [" ".to_owned(), "x".repeat(121)] {
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SaveTaskView {
                id: id(101),
                base_revision: None,
                name,
                query: q.clone()
            }])),
            Err(Error::Validation { .. })
        ));
    }
    let mut invalid = q.clone();
    invalid.filter.recent_days = 0;
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SaveTaskView {
            id: id(101),
            base_revision: None,
            name: "Invalid".into(),
            query: invalid
        }])),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        nb.apply(&batch(vec![
            Operation::SaveTaskView {
                id: id(101),
                base_revision: None,
                name: "Atomic".into(),
                query: q.clone()
            },
            Operation::DeleteTaskView {
                id: id(100),
                base_revision: 0
            },
        ])),
        Err(Error::Conflict { op_index: 1, .. })
    ));
    assert!(matches!(
        nb.task_view(&id(101)),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SaveTaskView {
            id: id(100),
            base_revision: Some(0),
            name: "Stale".into(),
            query: q.clone()
        }])),
        Err(Error::Conflict { .. })
    ));
    apply(
        &mut nb,
        vec![Operation::SaveTaskView {
            id: id(100),
            base_revision: Some(1),
            name: "Renamed".into(),
            query: q.clone(),
        }],
    );
    let updated = nb.task_view(&id(100)).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.created_at, saved.created_at);
    drop(nb);
    let mut nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.task_views().unwrap(), vec![updated.clone()]);
    assert_eq!(nb.task_view(&id(100)).unwrap(), updated);
    assert_eq!(ids(nb.task_query(&updated.query).unwrap()), vec![id(10)]);
    assert!(matches!(
        nb.apply(&batch(vec![Operation::DeleteTaskView {
            id: id(100),
            base_revision: 1
        }])),
        Err(Error::Conflict { .. })
    ));
    let mut deletion = batch(vec![Operation::DeleteTaskView {
        id: id(100),
        base_revision: 2,
    }]);
    deletion.idempotency_key = Some("delete-task-view".into());
    let deleted = nb.apply(&deletion).unwrap();
    assert_eq!(
        deleted.task_views,
        vec![Revision {
            id: id(100),
            revision: 3
        }]
    );
    assert!(nb.apply(&deletion).unwrap().replayed);
    assert!(matches!(
        nb.task_view(&id(100)),
        Err(Error::NotFound { .. })
    ));
    assert!(nb.task_views().unwrap().is_empty());
}
