use tessera_core::{
    Actor, AgentEdit, AgentReceipt, AgentRequest, Batch, BlockKind, Error, NoteBlock, NoteTarget,
    Notebook, Operation, TaskPriority, TaskState, TaskStatus,
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let notebook = Notebook::open(dir.path()).unwrap();
    (dir, notebook)
}
fn seed(notebook: &mut Notebook, operations: Vec<Operation>) {
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        })
        .unwrap();
}
/// Page 1 "Dune" with "first" (2) holding "nested" (3), then "second" (4).
fn dune(notebook: &mut Notebook) {
    let insert = |value: u128, parent: u128, after: Option<u128>, text: &str| Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: after.map(id),
        text: text.into(),
        heading: None,
    };
    seed(
        notebook,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Dune".into(),
            },
            insert(2, 1, None, "first"),
            insert(3, 2, None, "nested"),
            insert(4, 1, Some(2), "second"),
        ],
    );
}
fn block(text: &str, children: Vec<NoteBlock>) -> NoteBlock {
    NoteBlock {
        text: text.into(),
        heading: None,
        task: None,
        children,
    }
}
fn agent() -> Actor {
    Actor::Agent {
        name: "claude".into(),
    }
}
fn request(edit: AgentEdit) -> AgentRequest {
    AgentRequest {
        actor: agent(),
        reason: Some("summary".into()),
        edit,
    }
}
fn note(target: NoteTarget, blocks: Vec<NoteBlock>) -> AgentRequest {
    request(AgentEdit::AddNote { target, blocks })
}
fn page(title: &str) -> NoteTarget {
    NoteTarget::Page {
        title: title.into(),
    }
}
fn edit(value: &str, text: &str) -> AgentRequest {
    request(AgentEdit::EditBlock {
        id: value.into(),
        revision: None,
        text: Some(text.into()),
        heading: None,
    })
}
fn task(status: TaskStatus) -> TaskState {
    TaskState {
        status,
        ..TaskState::default()
    }
}
/// Each row of the page as indented text, in reading order.
fn outline(notebook: &Notebook, page_id: &str) -> Vec<String> {
    notebook
        .page(page_id)
        .unwrap()
        .rows
        .iter()
        .map(|row| format!("{}{}", "  ".repeat(row.depth as usize), row.block.text))
        .collect()
}
fn run(notebook: &mut Notebook, request: &AgentRequest) -> AgentReceipt {
    notebook.agent_edit(request).unwrap()
}
fn undo(notebook: &mut Notebook, seq: i64) -> Result<tessera_core::UndoReceipt, Error> {
    notebook.undo_agent_change(seq, &Actor::Person)
}
fn refused(result: Result<impl std::fmt::Debug, Error>, needle: &str) {
    match result {
        Err(Error::Validation { message, .. }) => {
            assert!(message.contains(needle), "{message:?} lacks {needle:?}")
        }
        other => panic!("expected a refusal containing {needle:?}, got {other:?}"),
    }
}

#[test]
fn a_missing_page_is_created_with_the_nested_outline_and_attributed() {
    let (_dir, mut nb) = fixture();
    let mut heading = block("Summary", vec![block("a", vec![block("a1", vec![])])]);
    heading.heading = Some(2);
    let receipt = run(
        &mut nb,
        &note(page("Reading log"), vec![heading, block("b", vec![])]),
    );

    let root = receipt.page.clone().unwrap();
    assert_eq!(root.kind, BlockKind::Page);
    assert_eq!(root.text, "Reading log");
    assert_eq!(receipt.created_pages, vec![root.clone()]);
    assert_eq!(receipt.summary, "Added 4 blocks to Reading log");
    assert_eq!(outline(&nb, &root.id), ["Summary", "  a", "    a1", "b"]);
    let rows = nb.page(&root.id).unwrap().rows;
    assert_eq!(
        receipt.blocks.iter().map(|b| &b.id).collect::<Vec<_>>(),
        rows.iter().map(|row| &row.block.id).collect::<Vec<_>>()
    );
    assert_eq!(rows[0].block.heading, Some(2));
    let change = nb.changes_since(receipt.seq - 1, 1).unwrap().remove(0);
    assert_eq!(change.actor, agent());
    assert_eq!(change.reason.as_deref(), Some("summary"));

    let listed = nb.agent_changes(10).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].seq, receipt.seq);
    assert_eq!(listed[0].actor, agent());
    assert_eq!(listed[0].page.as_ref(), Some(&root));
    assert_eq!(listed[0].undone_by, None);
}

#[test]
fn a_note_lands_after_the_last_top_level_block_or_under_a_block() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(&mut nb, &note(page("  dUNE "), vec![block("x", vec![])]));
    assert!(receipt.created_pages.is_empty());
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second", "x"]);

    run(
        &mut nb,
        &note(NoteTarget::Block { id: id(2) }, vec![block("z", vec![])]),
    );
    assert_eq!(
        outline(&nb, &id(1)),
        ["first", "  nested", "  z", "second", "x"]
    );
}

#[test]
fn title_references_link_existing_and_new_pages_like_the_editor() {
    let (_dir, mut nb) = fixture();
    seed(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Stoicism".into(),
            },
            Operation::CreateJournal {
                id: id(2),
                date: "2026-10-01".into(),
            },
        ],
    );
    let text = format!(
        "[[stoicism]] and [[Seneca|him]], again [[seneca]], on [[2026-10-01]] not [[2026-10-02]], \
         tag #[[Big idea]], ref [[{}]], [[]] and [[open",
        id(1)
    );
    let receipt = run(&mut nb, &note(page("Letters"), vec![block(&text, vec![])]));

    let titles: Vec<_> = receipt
        .created_pages
        .iter()
        .map(|p| p.text.as_str())
        .collect();
    assert_eq!(titles, ["Letters", "Seneca"]);
    let seneca = nb.page_by_title("Seneca").unwrap().unwrap().id;
    let written = nb.block(&receipt.blocks[0].id).unwrap().text;
    assert_eq!(
        written,
        format!(
            "[[{stoic}]] and [[{seneca}|him]], again [[{seneca}]], on [[{day}]] not [[2026-10-02]], \
             tag #[[Big idea]], ref [[{stoic}]], [[]] and [[open",
            stoic = id(1),
            day = id(2),
        )
    );
    for target in [id(1), seneca, id(2)] {
        let backlinks = nb.backlinks(&target, 10).unwrap();
        assert_eq!(backlinks.len(), 1, "{target}");
        assert_eq!(backlinks[0].source.id, receipt.blocks[0].id);
    }
}

#[test]
fn a_journal_note_creates_the_day_once_and_undo_removes_an_emptied_day() {
    let (_dir, mut nb) = fixture();
    let today = NoteTarget::Journal { date: None };
    let first = run(&mut nb, &note(today.clone(), vec![block("one", vec![])]));
    let second = run(&mut nb, &note(today, vec![block("two", vec![])]));
    let day = first.page.clone().unwrap();
    assert_eq!(day.kind, BlockKind::Journal);
    assert_eq!(day.text, nb.today(tessera_core::now_ms()).unwrap());
    assert_eq!(first.created_pages, vec![day.clone()]);
    assert!(second.created_pages.is_empty());
    assert_eq!(outline(&nb, &day.id), ["one", "two"]);

    // The day holds a later block, so undoing the first note keeps it.
    let receipt = undo(&mut nb, first.seq).unwrap();
    assert_eq!(receipt.kept_pages, vec![nb.block(&day.id).unwrap()]);
    assert_eq!(outline(&nb, &day.id), ["two"]);
    undo(&mut nb, second.seq).unwrap();
    assert_eq!(outline(&nb, &day.id), Vec::<String>::new());
}

#[test]
fn undoing_a_note_removes_its_blocks_and_the_pages_it_created_unless_in_use() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let added = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![block(
                "see [[Arrakis]] and [[Caladan]]",
                vec![block("child", vec![])],
            )],
        ),
    );
    let arrakis = nb.page_by_title("Arrakis").unwrap().unwrap().id;
    // A person links Caladan from their own block, so it must survive.
    let caladan = nb.page_by_title("Caladan").unwrap().unwrap().id;
    seed(
        &mut nb,
        vec![Operation::EditText {
            id: id(4),
            base_revision: 1,
            text: format!("second [[{caladan}]]"),
        }],
    );

    let receipt = undo(&mut nb, added.seq).unwrap();
    assert_eq!(receipt.undone, added.seq);
    assert_eq!(
        receipt
            .kept_pages
            .iter()
            .map(|p| &p.text)
            .collect::<Vec<_>>(),
        ["Caladan"]
    );
    assert_eq!(
        outline(&nb, &id(1)),
        [
            "first",
            "  nested",
            format!("second [[{caladan}]]").as_str()
        ]
    );
    assert!(nb.page_by_title("Arrakis").unwrap().is_none());
    assert!(matches!(nb.block(&arrakis), Err(Error::NotFound { .. })));
    assert_eq!(
        nb.agent_changes(10).unwrap()[0].undone_by,
        Some(receipt.committed.seq)
    );
    refused(undo(&mut nb, added.seq), "already undone");
    assert!(matches!(
        undo(&mut nb, receipt.committed.seq),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn undo_refuses_after_someone_changes_or_extends_what_the_agent_wrote() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let edited = run(&mut nb, &note(page("Dune"), vec![block("draft", vec![])]));
    let draft = edited.blocks[0].id.clone();
    seed(
        &mut nb,
        vec![Operation::EditText {
            id: draft.clone(),
            base_revision: 1,
            text: "draft, revised by hand".into(),
        }],
    );
    refused(undo(&mut nb, edited.seq), "changed after change");

    let extended = run(&mut nb, &note(page("Dune"), vec![block("outline", vec![])]));
    let parent = extended.blocks[0].id.clone();
    seed(
        &mut nb,
        vec![Operation::Insert {
            id: id(50),
            parent_id: parent.clone(),
            after: None,
            text: "my own child".into(),
            heading: None,
        }],
    );
    refused(undo(&mut nb, extended.seq), "children added after");
    assert!(nb.block(&parent).is_ok());
    assert!(
        nb.agent_changes(10)
            .unwrap()
            .iter()
            .all(|c| c.undone_by.is_none())
    );
}

#[test]
fn edits_link_titles_set_headings_and_undo_restores_both() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(
        &mut nb,
        &request(AgentEdit::EditBlock {
            id: id(2),
            revision: Some(1),
            text: Some("first, about [[Paul]]".into()),
            heading: Some(2),
        }),
    );
    let paul = nb.page_by_title("Paul").unwrap().unwrap().id;
    let block = nb.block(&id(2)).unwrap();
    assert_eq!(block.text, format!("first, about [[{paul}]]"));
    assert_eq!(block.heading, Some(2));
    assert_eq!(
        receipt.blocks,
        [tessera_core::Revision {
            id: id(2),
            revision: 3
        }]
    );
    assert_eq!(receipt.summary, "Edited “first, about [[Paul]]” on Dune");

    refused(
        nb.agent_edit(&edit(&id(2), &format!("first, about [[{paul}]]"))),
        "nothing to change",
    );
    assert!(matches!(
        nb.agent_edit(&request(AgentEdit::EditBlock {
            id: id(4),
            revision: Some(7),
            text: Some("stale".into()),
            heading: None,
        })),
        Err(Error::Conflict { .. })
    ));

    undo(&mut nb, receipt.seq).unwrap();
    let block = nb.block(&id(2)).unwrap();
    assert_eq!((block.text.as_str(), block.heading), ("first", None));
    assert!(nb.page_by_title("Paul").unwrap().is_none());
}

#[test]
fn renaming_a_page_through_its_root_is_undone_by_renaming_it_back() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(&mut nb, &edit(&id(1), "Dune Messiah"));
    assert_eq!(receipt.summary, "Renamed Dune to Dune Messiah");
    assert_eq!(nb.page_by_title("dune messiah").unwrap().unwrap().id, id(1));
    undo(&mut nb, receipt.seq).unwrap();
    assert_eq!(nb.block(&id(1)).unwrap().text, "Dune");
}

#[test]
fn moves_place_blocks_and_undo_puts_them_back() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let move_to = |parent: Option<u128>, after: Option<u128>, first: bool| {
        request(AgentEdit::MoveBlock {
            id: id(3),
            revision: None,
            parent_id: parent.map(id),
            after: after.map(id),
            first,
        })
    };
    let to_end = run(&mut nb, &move_to(Some(1), None, false));
    assert_eq!(outline(&nb, &id(1)), ["first", "second", "nested"]);
    let to_front = run(&mut nb, &move_to(Some(1), None, true));
    assert_eq!(outline(&nb, &id(1)), ["nested", "first", "second"]);
    let after = run(&mut nb, &move_to(None, Some(4), false));
    assert_eq!(outline(&nb, &id(1)), ["first", "second", "nested"]);
    refused(
        nb.agent_edit(&move_to(None, Some(4), false)),
        "nothing to change",
    );
    refused(nb.agent_edit(&move_to(None, None, false)), "give parent_id");
    refused(
        nb.agent_edit(&request(AgentEdit::MoveBlock {
            id: id(1),
            revision: None,
            parent_id: Some(id(2)),
            after: None,
            first: false,
        })),
        "page cannot be moved",
    );

    undo(&mut nb, after.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["nested", "first", "second"]);
    undo(&mut nb, to_front.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["first", "second", "nested"]);
    undo(&mut nb, to_end.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);
}

#[test]
fn a_deleted_block_or_page_is_restored_by_undo() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let removed = run(
        &mut nb,
        &request(AgentEdit::DeleteBlock {
            id: id(2),
            revision: None,
        }),
    );
    assert_eq!(removed.summary, "Deleted “first” from Dune");
    assert_eq!(outline(&nb, &id(1)), ["second"]);
    undo(&mut nb, removed.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);

    let gone = run(
        &mut nb,
        &request(AgentEdit::DeleteBlock {
            id: id(1),
            revision: None,
        }),
    );
    assert_eq!(gone.page, None);
    assert!(nb.page_by_title("Dune").unwrap().is_none());
    undo(&mut nb, gone.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);
}

#[test]
fn tasks_are_set_completed_and_restored_by_undo() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let set = |task: Option<TaskState>| {
        request(AgentEdit::SetTask {
            id: id(4),
            revision: None,
            task,
        })
    };
    let state = |nb: &Notebook| nb.capabilities(&id(4)).unwrap().task;
    let planned = TaskState {
        scheduled: Some("2026-10-09".into()),
        priority: Some(TaskPriority::High),
        ..task(TaskStatus::Todo)
    };
    let made = run(&mut nb, &set(Some(planned.clone())));
    assert_eq!(state(&nb), Some(planned.clone()));
    assert_eq!(made.summary, "Set to todo “second” on Dune");

    let done = TaskState {
        status: TaskStatus::Done,
        priority: Some(TaskPriority::Low),
        completed_on: Some("2026-10-07".into()),
        ..planned.clone()
    };
    let finished = run(&mut nb, &set(Some(done.clone())));
    assert_eq!(state(&nb), Some(done));
    assert_eq!(nb.task_occurrences(&id(4)).unwrap().len(), 1);
    refused(
        nb.agent_edit(&set(Some(state(&nb).unwrap()))),
        "nothing to change",
    );

    undo(&mut nb, finished.seq).unwrap();
    assert_eq!(state(&nb), Some(planned));
    assert!(nb.task_occurrences(&id(4)).unwrap()[0].reversed);
    undo(&mut nb, made.seq).unwrap();
    assert_eq!(state(&nb), None);

    let removed = {
        run(&mut nb, &set(Some(task(TaskStatus::Waiting))));
        run(&mut nb, &set(None))
    };
    assert_eq!(state(&nb), None);
    undo(&mut nb, removed.seq).unwrap();
    assert_eq!(state(&nb), Some(task(TaskStatus::Waiting)));
}

#[test]
fn note_blocks_can_be_tasks_including_done_ones() {
    let (_dir, mut nb) = fixture();
    let mut open = block("buy spice", vec![]);
    open.task = Some(task(TaskStatus::Todo));
    let mut closed = block("read appendix", vec![]);
    closed.task = Some(TaskState {
        completed_on: Some("2026-10-06".into()),
        ..task(TaskStatus::Done)
    });
    let receipt = run(&mut nb, &note(page("Errands"), vec![open, closed]));
    let states: Vec<_> = receipt
        .blocks
        .iter()
        .map(|b| nb.capabilities(&b.id).unwrap().task.map(|t| t.status))
        .collect();
    assert_eq!(states, [Some(TaskStatus::Todo), Some(TaskStatus::Done)]);
    assert_eq!(receipt.blocks[1].revision, 3);
    undo(&mut nb, receipt.seq).unwrap();
    assert!(nb.page_by_title("Errands").unwrap().is_none());
}

#[test]
fn a_rejected_request_writes_nothing() {
    let (_dir, mut nb) = fixture();
    let mut bad = block("too deep", vec![]);
    bad.heading = Some(4);
    let error = nb
        .agent_edit(&note(page("Draft"), vec![block("[[Linked]]", vec![]), bad]))
        .unwrap_err();
    assert!(matches!(error, Error::Validation { .. }), "{error}");
    assert!(nb.page_by_title("Draft").unwrap().is_none());
    assert!(nb.page_by_title("Linked").unwrap().is_none());

    refused(
        nb.agent_edit(&note(
            NoteTarget::Journal {
                date: Some("2026-02-30".into()),
            },
            vec![block("x", vec![])],
        )),
        "not a calendar date",
    );
    refused(nb.agent_edit(&note(page("Empty"), vec![])), "must contain");
    assert!(nb.page_by_title("Empty").unwrap().is_none());
    assert!(nb.agent_changes(10).unwrap().is_empty());
}

#[test]
fn undo_handles_provisional_pages_cleaned_in_this_and_later_changes() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let added = run(&mut nb, &note(page("Dune"), vec![block("#p", vec![])]));
    let source = added.blocks[0].id.clone();
    let prefix = nb.page_by_title("p").unwrap().unwrap();
    let edited = run(&mut nb, &edit(&source, "#phil"));
    let final_page = nb.page_by_title("phil").unwrap().unwrap();
    assert!(nb.block(&prefix.id).is_err());
    undo(&mut nb, edited.seq).unwrap();
    assert!(nb.block(&final_page.id).is_err());
    assert!(nb.page_by_title("p").unwrap().is_some());
    undo(&mut nb, added.seq).unwrap();
    assert!(nb.page_by_title("p").unwrap().is_none());
    assert!(nb.block(&source).is_err());
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);
}

#[test]
fn undo_skips_a_created_page_already_removed_by_another_change() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let added = run(&mut nb, &note(page("Dune"), vec![block("[[Agent page]] #agenttag", vec![])]));
    let created = nb.page_by_title("Agent page").unwrap().unwrap();
    seed(&mut nb, vec![Operation::Delete { id: created.id.clone(), base_revision: created.revision }]);
    undo(&mut nb, added.seq).unwrap();
    assert!(nb.page_by_title("agenttag").unwrap().is_none());
    assert!(nb.block(&created.id).is_err());
}
