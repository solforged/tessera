//! A commit's topics must name every workshop-wide list it changed, so a
//! window that refetches a list only on its topics never shows a stale one,
//! and plain typing must name none.

use serde_json::{Value, to_value};
use tessera_core::{Actor, Batch, Operation, TaskState, TaskStatus, Topic, Topic::*, Workshop};

const DAY: &str = "2026-11-16";
/// Noon UTC on `DAY`.
const NOW: i64 = 1_794_830_400_000;

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn insert(value: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn revision(nb: &Workshop, value: u128) -> i64 {
    match nb.block(&id(value)) {
        Ok(block) => block.revision,
        Err(_) => nb.page(&id(value)).unwrap().root.revision,
    }
}
fn edit(nb: &Workshop, value: u128, text: &str) -> Operation {
    Operation::EditText {
        id: id(value),
        base_revision: revision(nb, value),
        text: text.into(),
    }
}

/// Every workshop-wide list a window keeps open while editing, with the
/// topics the window refetches it on (`web/src/notes/kinds.ts` and others).
fn lists(nb: &Workshop) -> Vec<(&'static [Topic], &'static str, Value)> {
    vec![
        (&[Fields], "fields", to_value(nb.fields().unwrap()).unwrap()),
        (&[Types], "types", to_value(nb.types().unwrap()).unwrap()),
        (
            &[Pages, Types, Tasks, Cards],
            "note index",
            to_value(nb.note_index().unwrap()).unwrap(),
        ),
        (
            &[Pages],
            "deleted pages",
            to_value(nb.deleted_pages().unwrap()).unwrap(),
        ),
        (
            &[Tasks],
            "projects",
            to_value(nb.projects().unwrap()).unwrap(),
        ),
        (
            &[Tasks],
            "agenda",
            to_value(nb.agenda(DAY).unwrap()).unwrap(),
        ),
        (
            &[Revisits],
            "revisits",
            to_value(nb.revisits(DAY, NOW).unwrap()).unwrap(),
        ),
        (&[Views], "views", to_value(nb.views().unwrap()).unwrap()),
    ]
}

/// Apply one batch and check that the topics of the change events it caused,
/// which a window receives, name every list it changed. A commit can cause a
/// follow-up commit, such as adding task fields to a type.
fn step(nb: &mut Workshop, label: &str, operations: Vec<Operation>) -> Vec<Topic> {
    let before = lists(nb);
    let cursor = nb.editor_cursor().unwrap();
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
    let mut topics: Vec<Topic> = nb
        .changes_since(cursor, 100)
        .unwrap()
        .into_iter()
        .flat_map(|event| event.topics.expect("a native commit records its topics"))
        .collect();
    topics.sort_unstable();
    topics.dedup();
    for ((subscribed, list, old), (_, _, new)) in before.iter().zip(lists(nb)) {
        assert!(
            old == &new || subscribed.iter().any(|topic| topics.contains(topic)),
            "{label}: {list} changed but the topics {topics:?} name none of {subscribed:?}\nOLD {old}\nNEW {new}"
        );
    }
    topics
}

#[test]
fn topics_name_every_list_a_commit_changes_and_typing_names_none() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Workshop::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    let page = id(1);
    step(
        &mut nb,
        "create a page",
        vec![
            Operation::CreatePage {
                id: page.clone(),
                title: "Plans".into(),
            },
            insert(10, &page, "first"),
        ],
    );
    for text in ["first line", "first line typed"] {
        let typed = edit(&nb, 10, text);
        assert_eq!(
            step(&mut nb, "type", vec![typed]),
            [],
            "typing names no topic"
        );
    }
    assert_eq!(
        step(&mut nb, "add an empty block", vec![insert(11, &page, "")]),
        [],
        "Enter names no topic"
    );
    let tag = edit(&nb, 11, "tagged #book");
    assert!(step(&mut nb, "tag a block", vec![tag]).contains(&Types));
    step(&mut nb, "define a field", vec![insert(20, &fields, "Year")]);
    step(
        &mut nb,
        "add an entry",
        vec![
            insert(21, &id(10), &format!("[[{}]]", id(20))),
            insert(22, &id(21), "1999"),
        ],
    );
    let value = edit(&nb, 22, "2001");
    let named = step(&mut nb, "edit an entry's value", vec![value]);
    assert!(
        named.contains(&Library) && named.contains(&Types),
        "a value's text is metadata and a required field's content: {named:?}"
    );
    let card = edit(&nb, 10, "first line >> a card");
    step(&mut nb, "write a card", vec![card]);
    let task = Operation::SetTask {
        id: id(11),
        base_revision: revision(&nb, 11),
        task: Some(TaskState {
            status: Some(TaskStatus::Todo),
            scheduled: Some(DAY.into()),
            ..Default::default()
        }),
    };
    step(&mut nb, "schedule a task", vec![task]);
    let renamed = edit(&nb, 11, "tagged #book and renamed");
    assert!(step(&mut nb, "edit a task's text", vec![renamed]).contains(&Tasks));
    for archived in [true, false] {
        let archive = Operation::SetArchived {
            id: id(10),
            base_revision: revision(&nb, 10),
            archived,
        };
        step(&mut nb, "archive a block", vec![archive]);
    }
    let moved = Operation::Move {
        id: id(11),
        base_revision: revision(&nb, 11),
        parent_id: id(10),
        after: None,
    };
    step(&mut nb, "move a task", vec![moved]);
    let title = edit(&nb, 1, "Plans for winter");
    step(&mut nb, "rename a page", vec![title]);
    let entry = Operation::Delete {
        id: id(21),
        base_revision: revision(&nb, 21),
    };
    step(&mut nb, "delete an entry", vec![entry]);
    let deleted = Operation::Delete {
        id: page.clone(),
        base_revision: revision(&nb, 1),
    };
    step(&mut nb, "delete a page", vec![deleted]);
    let deleted = nb.deleted_pages().unwrap().remove(0);
    let restore = Operation::Restore {
        id: page,
        deletion_id: deleted.deletion_id,
        revision: deleted.block.revision,
    };
    step(&mut nb, "restore a page", vec![restore]);
}
