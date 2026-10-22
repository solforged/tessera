use serde_json::{Value, json};
use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater};
use tessera_core::{
    Actor, Batch, DATABASE_FILE, FieldKind, Notebook, Operation, QueryResult, TaskPriority,
    TaskState, TaskStatus,
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
fn field(nb: &Notebook, name: &str) -> String {
    nb.fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|field| field.definition.name == name)
        .unwrap()
        .definition
        .id
}
fn query(nb: &Notebook, value: Value) -> QueryResult {
    nb.query(&serde_json::from_value(value).unwrap()).unwrap()
}
fn set_task(nb: &mut Notebook, state: TaskState) {
    let revision = nb.block(&id(2)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetTask {
            id: id(2),
            base_revision: revision,
            task: Some(state),
        }],
    );
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let directory = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(directory.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Kitchen renovation".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "Get cabinet quotes".into(),
                heading: None,
            },
        ],
    );
    set_task(
        &mut nb,
        TaskState {
            status: Some(TaskStatus::Todo),
            ..Default::default()
        },
    );
    (directory, nb)
}

#[test]
fn task_template_seeds_once_and_keeps_optional_removals() {
    let (directory, mut nb) = fixture();
    let task = nb.page_by_title("Task").unwrap().unwrap();
    let names = [
        "status",
        "scheduled",
        "deadline",
        "priority",
        "repeat",
        "project",
    ];
    let fields: Vec<_> = names.iter().map(|name| field(&nb, name)).collect();
    assert_eq!(nb.type_info(&task.id).unwrap().fields, fields);
    let (_other_directory, other) = fixture();
    for name in names {
        assert_ne!(field(&nb, name), field(&other, name));
    }
    set_task(
        &mut nb,
        TaskState {
            status: Some(TaskStatus::Todo),
            scheduled: Some("2026-10-19".into()),
            ..Default::default()
        },
    );
    let kept = vec![fields[0].clone(), fields[3].clone()];
    apply(
        &mut nb,
        vec![Operation::SetTypeFields {
            type_id: task.id.clone(),
            base_revision: task.revision,
            fields: kept.clone(),
        }],
    );
    drop(nb);
    let nb = Notebook::open(directory.path()).unwrap();
    assert_eq!(nb.type_info(&task.id).unwrap().fields, kept);
    assert_eq!(
        nb.capabilities(&id(2))
            .unwrap()
            .task
            .unwrap()
            .scheduled
            .as_deref(),
        Some("2026-10-19")
    );
    assert_eq!(
        query(&nb, json!({"source":"tasks"})).rows[0].attributes["@scheduled"][0].text,
        "2026-10-19"
    );
    drop(nb);
    let conn = rusqlite::Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
    conn.execute(
        "DELETE FROM type_fields WHERE type_id = ?1 AND field_id = ?2",
        [&task.id, &fields[0]],
    )
    .unwrap();
    drop(conn);
    let nb = Notebook::open(directory.path()).unwrap();
    let restored = nb.type_info(&task.id).unwrap();
    assert_eq!(restored.fields, vec![fields[3].clone(), fields[0].clone()]);
    assert_eq!(restored.required[0].missing, 0);
}

#[test]
fn older_workshop_receives_template_without_changing_task_or_project_entries() {
    let (directory, mut nb) = fixture();
    set_task(
        &mut nb,
        TaskState {
            status: Some(TaskStatus::Todo),
            deadline: Some("2026-10-20".into()),
            ..Default::default()
        },
    );
    let task = nb.page_by_title("Task").unwrap().unwrap();
    let project = field(&nb, "project");
    drop(nb);
    let conn = rusqlite::Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
    conn.execute("DELETE FROM settings WHERE key = 'task_field_template'", [])
        .unwrap();
    conn.execute("DELETE FROM type_fields WHERE type_id = ?1", [&task.id])
        .unwrap();
    drop(conn);
    let nb = Notebook::open(directory.path()).unwrap();
    assert_eq!(nb.type_info(&task.id).unwrap().fields.len(), 6);
    assert_eq!(field(&nb, "project"), project);
    assert_eq!(
        nb.capabilities(&id(2))
            .unwrap()
            .task
            .unwrap()
            .deadline
            .as_deref(),
        Some("2026-10-20")
    );
    assert!(
        nb.page(&id(1))
            .unwrap()
            .rows
            .iter()
            .all(|row| row.block.parent_id.as_deref() != Some(id(2).as_str()))
    );
}

#[test]
fn projected_fields_share_task_edits_completion_undo_and_user_values() {
    let (_directory, mut nb) = fixture();
    let state = TaskState {
        status: Some(TaskStatus::Todo),
        scheduled: Some("2026-10-19".into()),
        scheduled_time: Some("14:00".into()),
        deadline: Some("2026-10-20".into()),
        deadline_time: Some("17:00".into()),
        warning_days: Some(2),
        priority: Some(TaskPriority::High),
        repeater: Some(Repeater {
            every: 1,
            unit: RepeatUnit::Week,
            mode: RepeatMode::Fixed,
        }),
        ..Default::default()
    };
    set_task(&mut nb, state.clone());
    let status = field(&nb, "status");
    let deadline = field(&nb, "deadline");
    let page = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            Operation::Insert {
                id: id(10),
                parent_id: page,
                after: None,
                text: "Supplier".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(11),
                parent_id: id(2),
                after: None,
                text: format!("[[{}]]", id(10)),
                heading: None,
            },
            Operation::Insert {
                id: id(12),
                parent_id: id(11),
                after: None,
                text: "Alder & Ash".into(),
                heading: None,
            },
        ],
    );
    let result = query(
        &nb,
        json!({"source":"tasks", "filters":[{"field":status,"op":"is","value":"todo"}]}),
    );
    assert_eq!(result.total, 1);
    let row = &result.rows[0];
    assert_eq!(row.attributes[&status][0].text, "todo");
    assert_eq!(row.attributes["@deadline"], row.attributes["@due"]);
    assert_eq!(row.attributes[&deadline], row.attributes["@deadline"]);
    assert_eq!(row.attributes["@priority"][0].text, "high");
    assert_eq!(row.attributes["@repeat"][0].text, "Fixed · 1 week");
    assert_eq!(row.values[&id(10)][0].id, id(12));
    assert!(!row.values.contains_key(&status));
    assert_eq!(
        query(&nb, json!({"filters":[{"field":status,"op":"present"}]})).total,
        1
    );
    let revision = nb.block(&id(2)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::CompleteTask {
            id: id(2),
            base_revision: revision,
            occurrence_id: id(20),
            completed_on: "2026-10-19".into(),
        }],
    );
    let next = nb.capabilities(&id(2)).unwrap().task.unwrap();
    assert_eq!(next.status, Some(TaskStatus::Todo));
    assert_eq!(next.scheduled.as_deref(), Some("2026-10-26"));
    assert_eq!(
        query(&nb, json!({"source":"tasks"})).rows[0].attributes["@scheduled"][0].text,
        "2026-10-26"
    );
    let revision = nb.block(&id(2)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::ReverseTaskCompletion {
            id: id(2),
            base_revision: revision,
            occurrence_id: id(20),
        }],
    );
    assert_eq!(nb.capabilities(&id(2)).unwrap().task.unwrap(), state);
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: id(12),
            base_revision: 1,
            text: "Beech & Co".into(),
        }],
    );
    assert_eq!(
        query(&nb, json!({"source":"tasks"})).rows[0].values[&id(10)][0].text,
        "Beech & Co"
    );
    let count = nb
        .fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|field| field.definition.id == status)
        .unwrap()
        .owners;
    assert_eq!(count, 1);
    let detail = nb.field_detail(&status, None, None).unwrap();
    assert_eq!(detail.owners_total, 1);
    assert_eq!(detail.field.owners, 1);
    assert_eq!(detail.values_total, 1);
    assert!(detail.owners.is_empty());
    assert!(detail.entries.is_empty());
}

#[test]
fn project_field_projects_task_membership_without_replacing_authored_relations() {
    let (_directory, mut nb) = fixture();
    let project = field(&nb, "project");
    let task_type = nb.page_by_title("Task").unwrap().unwrap().id;
    let revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![
            Operation::SetProject {
                id: id(1),
                base_revision: revision,
                project: Some(Default::default()),
            },
            Operation::CreatePage {
                id: id(30),
                title: "Essay".into(),
            },
            Operation::SetProject {
                id: id(30),
                base_revision: 1,
                project: Some(Default::default()),
            },
            Operation::CreatePage {
                id: id(31),
                title: "Project reference".into(),
            },
            Operation::Insert {
                id: id(32),
                parent_id: id(31),
                after: None,
                text: format!("[[{project}]]"),
                heading: None,
            },
            Operation::Insert {
                id: id(33),
                parent_id: id(32),
                after: None,
                text: format!("[[{}]]", id(30)),
                heading: None,
            },
        ],
    );
    let task_table = query(&nb, json!({"type":task_type}));
    assert_eq!(task_table.total, 1);
    assert_eq!(
        task_table.rows[0].attributes[&project][0].reading,
        query(&nb, json!({"source":"tasks"})).rows[0].attributes["@project"][0].reading
    );
    assert_eq!(
        query(&nb, json!({"filters":[{"field":project,"op":"present"}]})).total,
        2
    );
    assert_eq!(
        query(
            &nb,
            json!({"filters":[{"field":project,"op":"is","value":id(1)}]})
        )
        .total,
        1
    );
    assert_eq!(
        query(
            &nb,
            json!({"filters":[{"field":project,"op":"is","value":id(30)}]})
        )
        .total,
        1
    );
    assert_eq!(
        nb.fields()
            .unwrap()
            .fields
            .iter()
            .find(|field| field.definition.id == project)
            .unwrap()
            .owners,
        2
    );
    let detail = nb.field_detail(&project, None, None).unwrap();
    assert_eq!(detail.owners_total, 2);
    assert_eq!(detail.values_total, 2);
    assert_eq!(detail.owners[0].owner.id, id(31));

    // An explicit assignment replaces the inherited project without counting the task twice.
    apply(
        &mut nb,
        vec![
            Operation::Insert {
                id: id(10),
                parent_id: id(2),
                after: None,
                text: format!("[[{project}]]"),
                heading: None,
            },
            Operation::Insert {
                id: id(11),
                parent_id: id(10),
                after: None,
                text: format!("[[{}]]", id(30)),
                heading: None,
            },
        ],
    );
    assert_eq!(
        query(
            &nb,
            json!({"filters":[{"field":project,"op":"is","value":id(1)}]})
        )
        .total,
        0
    );
    assert_eq!(
        query(
            &nb,
            json!({"filters":[{"field":project,"op":"is","value":id(30)}]})
        )
        .total,
        2
    );
    assert_eq!(
        nb.fields()
            .unwrap()
            .fields
            .iter()
            .find(|field| field.definition.id == project)
            .unwrap()
            .owners,
        2
    );
    assert_eq!(
        nb.field_detail(&project, None, None).unwrap().owners_total,
        2
    );
}

#[test]
fn appointment_becomes_task_without_moving_or_changing_its_date() {
    let (_directory, mut nb) = fixture();
    let appointment = TaskState {
        scheduled: Some("2026-10-19".into()),
        scheduled_time: Some("14:00".into()),
        ..Default::default()
    };
    set_task(&mut nb, appointment.clone());
    assert_eq!(query(&nb, json!({"source":"tasks"})).total, 0);
    set_task(
        &mut nb,
        TaskState {
            status: Some(TaskStatus::Todo),
            ..appointment.clone()
        },
    );
    let state = nb.capabilities(&id(2)).unwrap().task.unwrap();
    assert_eq!(state.scheduled, appointment.scheduled);
    assert_eq!(state.scheduled_time, appointment.scheduled_time);
    assert_eq!(nb.block(&id(2)).unwrap().parent_id, Some(id(1)));
    assert_eq!(query(&nb, json!({"source":"tasks"})).total, 1);
}

#[test]
fn task_field_names_formats_and_global_deletion_are_protected() {
    let (_directory, mut nb) = fixture();
    for name in [
        "status",
        "scheduled",
        "deadline",
        "priority",
        "repeat",
        "project",
    ] {
        let id = field(&nb, name);
        let revision = nb.block(&id).unwrap().revision;
        for operation in [
            Operation::EditText {
                id: id.clone(),
                base_revision: revision,
                text: "Renamed".into(),
            },
            Operation::SetFieldKind {
                id: id.clone(),
                base_revision: revision,
                kind: FieldKind::Number,
            },
            Operation::Delete {
                id: id.clone(),
                base_revision: revision,
            },
        ] {
            assert!(
                nb.apply(&Batch {
                    actor: Actor::Person,
                    reason: None,
                    idempotency_key: None,
                    operations: vec![operation]
                })
                .is_err()
            );
        }
    }
}

#[test]
fn empty_workshop_defers_task_seed_and_recreated_fields_have_fresh_ids() {
    let empty = tempfile::tempdir().unwrap();
    let nb = Notebook::open(empty.path()).unwrap();
    assert!(nb.fields().unwrap().fields.is_empty());
    assert!(nb.page_by_title("Task").unwrap().is_none());
    let (directory, mut nb) = fixture();
    let old_status = field(&nb, "status");
    let fields = nb.fields().unwrap().page_id;
    let revision = nb.block(&fields).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: fields,
            base_revision: revision,
        }],
    );
    drop(nb);
    let nb = Notebook::open(directory.path()).unwrap();
    assert_ne!(field(&nb, "status"), old_status);
    assert!(nb.capabilities(&id(2)).unwrap().task.is_some());
}
