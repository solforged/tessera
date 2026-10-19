use tessera_core::library::{
    ExtractedDocument, ExtractedMetadata, ExtractedPassage, Passage, PassageKind, SourceFormat,
};
use tessera_core::{
    Actor, AgentCitation, AgentEdit, AgentReceipt, AgentRequest, Batch, BlockKind, CardQuery,
    CardSelection, Error, NoteBlock, NoteTarget, Notebook, Operation, TaskPriority, TaskState,
    TaskStatus,
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
        status: Some(status),
        ..Default::default()
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
    assert_eq!(receipt.summary, "Added 4 atoms to Reading log");
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
    let tag = nb.page_by_title("Big idea").unwrap().unwrap().id;
    let written = nb.block(&receipt.blocks[0].id).unwrap().text;
    assert_eq!(
        written,
        format!(
            "[[{stoic}]] and [[{seneca}|him]], again [[{seneca}]], on [[{day}]] not [[2026-10-02]], \
             tag #[[{tag}|Big idea]], ref [[{stoic}]], [[]] and [[open",
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
fn external_captions_stay_authored_without_creating_pages_or_block_links() {
    let (_dir, mut nb) = fixture();
    let text = "[[HTTPS://example.org/a|caption]] and [label](https://example.org/b)";
    let receipt = run(
        &mut nb,
        &note(page("External links"), vec![block(text, vec![])]),
    );
    assert_eq!(receipt.created_pages.len(), 1);
    let saved = nb.page(&receipt.created_pages[0].id).unwrap();
    assert_eq!(saved.rows[0].block.text, text);
    assert!(saved.targets.is_empty());
}

#[test]
fn inline_code_keeps_title_references_and_tags_literal_in_agent_notes() {
    let (_dir, mut nb) = fixture();
    let text = "`#CodeType [[CodePage]]` and ``[[OtherPage]] ` #OtherType``";
    let receipt = run(
        &mut nb,
        &note(page("Code examples"), vec![block(text, vec![])]),
    );
    assert_eq!(receipt.created_pages.len(), 1);
    let saved = nb.page(&receipt.created_pages[0].id).unwrap();
    assert_eq!(saved.rows[0].block.text, text);
    assert!(saved.targets.is_empty());
    for title in ["CodeType", "CodePage", "OtherPage", "OtherType"] {
        assert!(nb.page_by_title(title).unwrap().is_none());
    }
}

#[test]
fn unmatched_backticks_keep_later_agent_titles_and_tags_active() {
    let (_dir, mut nb) = fixture();
    let receipt = run(
        &mut nb,
        &note(
            page("Literal backticks"),
            vec![block("it`s about #history [[Polybius]]", vec![])],
        ),
    );
    let polybius = nb.page_by_title("Polybius").unwrap().unwrap();
    let history = nb.page_by_title("history").unwrap().unwrap();
    let written = nb.block(&receipt.blocks[0].id).unwrap();
    assert_eq!(
        written.text,
        format!("it`s about #[[{}|history]] [[{}]]", history.id, polybius.id)
    );
    assert_eq!(nb.members(&history.id, 10).unwrap().len(), 1);
    assert_eq!(nb.backlinks(&polybius.id, 10).unwrap().len(), 1);
}

#[test]
fn add_note_resolves_titles_without_losing_labels_or_locators() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let text = format!(
        "[[Dune|span|3.12]] [[Dune||4]] [[Dune|a|b|5]] [[Dune|label]] [[{}||6]] [[New work|new|7]]",
        id(1)
    );
    let receipt = run(
        &mut nb,
        &note(page("Citations"), vec![block(&text, vec![])]),
    );
    let new = nb.page_by_title("New work").unwrap().unwrap().id;
    assert_eq!(
        nb.block(&receipt.blocks[0].id).unwrap().text,
        format!(
            "[[{src}|span|3.12]] [[{src}||4]] [[{src}|a|b|5]] [[{src}|label]] [[{src}||6]] [[{new}|new|7]]",
            src = id(1)
        )
    );
    assert_eq!(nb.backlinks(&id(1), 10).unwrap().len(), 1);
    assert_eq!(nb.backlinks(&new, 10).unwrap().len(), 1);
}

#[test]
fn saved_view_references_survive_authoring_without_creating_pages_or_links() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let text = format!("[[view:{}|Open questions]]", id(1));
    let receipt = run(
        &mut nb,
        &note(page("Research project"), vec![block(&text, vec![])]),
    );
    assert_eq!(nb.block(&receipt.blocks[0].id).unwrap().text, text);
    assert_eq!(receipt.created_pages.len(), 1);
    assert!(nb.backlinks(&id(1), 10).unwrap().is_empty());
    assert_eq!(nb.search("Open questions", 10).unwrap().len(), 1);
    undo(&mut nb, receipt.seq).unwrap();
    assert!(nb.block(&receipt.blocks[0].id).is_err());
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
        "titled atom cannot be moved",
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
        status: Some(TaskStatus::Done),
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
        .map(|b| nb.capabilities(&b.id).unwrap().task.and_then(|t| t.status))
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
    assert_eq!(nb.page_by_title("p").unwrap().unwrap().id, prefix.id);
    undo(&mut nb, added.seq).unwrap();
    assert!(nb.page_by_title("p").unwrap().is_none());
    assert!(nb.block(&source).is_err());
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);
}

#[test]
fn undo_skips_a_created_page_already_removed_by_another_change() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let added = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![block("[[Agent page]] #agenttag", vec![])],
        ),
    );
    let created = nb.page_by_title("Agent page").unwrap().unwrap();
    seed(
        &mut nb,
        vec![Operation::Delete {
            id: created.id.clone(),
            base_revision: created.revision,
        }],
    );
    undo(&mut nb, added.seq).unwrap();
    assert!(nb.page_by_title("agenttag").unwrap().is_none());
    assert!(nb.block(&created.id).is_err());
}

#[test]
fn shorthand_creates_and_reuses_a_definition_with_values_before_authored_children() {
    let (_dir, mut nb) = fixture();
    let receipt = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![block(
                "  Author :: [[Frank Herbert]]",
                vec![block("authored", vec![]), block("aUTHOR:: another", vec![])],
            )],
        ),
    );
    assert_eq!(receipt.created_fields.len(), 1);
    let definition = &receipt.created_fields[0];
    assert_eq!(definition.text, "Author");
    assert_eq!(
        definition.parent_id.as_deref(),
        Some(nb.fields().unwrap().page_id.as_str())
    );
    let author = nb.page_by_title("Frank Herbert").unwrap().unwrap();
    let root = receipt.page.unwrap();
    assert_eq!(
        outline(&nb, &root.id),
        [
            format!("[[{}]]", definition.id),
            format!("  [[{}]]", author.id),
            "  authored".into(),
            format!("  [[{}]]", definition.id),
            "    another".into(),
        ]
    );
    let rows = nb.page(&root.id).unwrap().rows;
    assert_eq!(
        receipt
            .blocks
            .iter()
            .map(|revision| &revision.id)
            .collect::<Vec<_>>(),
        rows.iter().map(|row| &row.block.id).collect::<Vec<_>>()
    );
    let change = nb.changes_since(receipt.seq - 1, 1).unwrap().remove(0);
    assert_eq!(change.actor, agent());
    assert!(change.blocks.iter().any(|block| block == definition));
    let second = run(
        &mut nb,
        &note(page("Dune"), vec![block("AUTHOR:: reused", vec![])]),
    );
    assert!(second.created_fields.is_empty());
    assert_eq!(
        nb.block(&second.blocks[0].id).unwrap().text,
        format!("[[{}]]", definition.id)
    );
}

#[test]
fn empty_shorthand_keeps_only_authored_children() {
    let (_dir, mut nb) = fixture();
    let receipt = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![block("Name::", vec![block("authored", vec![])])],
        ),
    );
    assert_eq!(receipt.blocks.len(), 2);
    assert_eq!(
        outline(&nb, &receipt.page.unwrap().id),
        [
            format!("[[{}]]", receipt.created_fields[0].id),
            "  authored".into()
        ]
    );
}

#[test]
fn undo_removes_unused_created_fields_but_keeps_a_definition_another_block_uses() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![block("Unused:: one", vec![]), block("Shared:: two", vec![])],
        ),
    );
    let unused = receipt.created_fields[0].id.clone();
    let shared = receipt.created_fields[1].id.clone();
    seed(
        &mut nb,
        vec![Operation::EditText {
            id: id(4),
            base_revision: 1,
            text: format!("[[{shared}]]"),
        }],
    );
    undo(&mut nb, receipt.seq).unwrap();
    assert!(matches!(nb.block(&unused), Err(Error::NotFound { .. })));
    assert!(nb.block(&shared).is_ok());
    assert_eq!(
        outline(&nb, &id(1)),
        ["first", "  nested", &format!("[[{shared}]]")]
    );
}

#[test]
fn undo_keeps_a_created_field_that_was_edited_or_given_new_children() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(
        &mut nb,
        &note(
            page("Dune"),
            vec![
                block("Renamed:: one", vec![]),
                block("Options:: two", vec![]),
            ],
        ),
    );
    let renamed = &receipt.created_fields[0];
    let extended = &receipt.created_fields[1];
    seed(
        &mut nb,
        vec![
            Operation::EditText {
                id: renamed.id.clone(),
                base_revision: renamed.revision,
                text: "Changed name".into(),
            },
            Operation::Insert {
                id: id(50),
                parent_id: extended.id.clone(),
                after: None,
                text: "choice".into(),
                heading: None,
            },
        ],
    );
    undo(&mut nb, receipt.seq).unwrap();
    assert_eq!(nb.block(&renamed.id).unwrap().text, "Changed name");
    assert!(nb.block(&extended.id).is_ok());
    assert!(nb.block(&id(50)).is_ok());
}

#[test]
fn edit_shorthand_inserts_a_first_value_and_undo_restores_text_and_children() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let receipt = run(&mut nb, &edit(&id(2), "Author:: [[Frank Herbert]]"));
    let definition = &receipt.created_fields[0];
    let author = nb.page_by_title("Frank Herbert").unwrap().unwrap();
    assert_eq!(
        outline(&nb, &id(1)),
        [
            format!("[[{}]]", definition.id),
            format!("  [[{}]]", author.id),
            "  nested".into(),
            "second".into()
        ]
    );
    assert_eq!(receipt.blocks.len(), 2);
    let value = receipt
        .blocks
        .iter()
        .find(|revision| revision.id != id(2))
        .unwrap()
        .id
        .clone();
    undo(&mut nb, receipt.seq).unwrap();
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "second"]);
    assert!(matches!(nb.block(&value), Err(Error::NotFound { .. })));
    assert!(matches!(
        nb.block(&definition.id),
        Err(Error::NotFound { .. })
    ));
    assert!(nb.page_by_title("Frank Herbert").unwrap().is_none());
}

#[test]
fn shorthand_never_rewrites_page_roots_or_card_syntax_or_multiline_names() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let renamed = run(&mut nb, &edit(&id(1), "Title:: value"));
    assert!(renamed.created_fields.is_empty());
    assert_eq!(nb.block(&id(1)).unwrap().text, "Title:: value");
    let texts = [
        "front>>back:: value",
        "{{c1::answer}}:: value",
        "line\nname:: value",
        "Name:: value\nmore",
        "\\Name:: value",
        "Name#tag:: value",
    ];
    let receipt = run(
        &mut nb,
        &note(
            NoteTarget::Block { id: id(4) },
            texts.iter().map(|text| block(text, vec![])).collect(),
        ),
    );
    assert!(receipt.created_fields.is_empty());
    for (revision, text) in receipt.blocks.iter().zip(texts) {
        assert_eq!(nb.block(&revision.id).unwrap().text, text);
    }
}

fn hold(card_id: &str, revision: Option<i64>, held: bool) -> AgentRequest {
    request(AgentEdit::SetCardHeld {
        card_id: card_id.into(),
        revision,
        held,
    })
}

fn dune_card(nb: &mut Notebook) -> tessera_core::CardUnit {
    dune(nb);
    run(nb, &edit(&id(4), "front>>back"));
    nb.source_cards(&id(4)).unwrap().remove(0)
}

#[test]
fn cards_are_held_released_and_undone_using_their_own_revisions() {
    let (_dir, mut nb) = fixture();
    let card = dune_card(&mut nb);
    let block_revision = nb.block(&id(4)).unwrap().revision;
    let held = run(&mut nb, &hold(&card.id, Some(card.revision), true));
    assert_eq!(held.summary, "Held card “front” on Dune");
    assert_eq!(held.page.unwrap().id, id(1));
    assert!(held.blocks.is_empty());
    assert_eq!(held.committed.cards[0].revision, card.revision + 1);
    assert!(nb.card(&card.id).unwrap().held);
    assert_eq!(nb.block(&id(4)).unwrap().revision, block_revision);
    let change = nb.changes_since(held.seq - 1, 1).unwrap().remove(0);
    assert_eq!(change.actor, agent());
    assert_eq!(change.cards.as_slice(), std::slice::from_ref(&card.id));
    let released = run(&mut nb, &hold(&card.id, None, false));
    assert_eq!(released.summary, "Released card “front” on Dune");
    assert!(!nb.card(&card.id).unwrap().held);
    undo(&mut nb, released.seq).unwrap();
    assert!(nb.card(&card.id).unwrap().held);
    // The intervening release and its undo are a card-only revision shift.
    undo(&mut nb, held.seq).unwrap();
    assert!(!nb.card(&card.id).unwrap().held);
}

#[test]
fn card_holds_refuse_stale_revisions_inactive_cards_and_unchanged_states() {
    let (_dir, mut nb) = fixture();
    let card = dune_card(&mut nb);
    refused(
        nb.agent_edit(&hold(&card.id, None, false)),
        "already released",
    );
    let held = run(&mut nb, &hold(&card.id, None, true));
    refused(nb.agent_edit(&hold(&card.id, None, true)), "already held");
    assert!(matches!(
        nb.agent_edit(&hold(&card.id, Some(card.revision), false)),
        Err(Error::Conflict { id, expected, found, .. })
            if id == card.id && expected == card.revision && found == Some(card.revision + 1)
    ));
    let current = nb.card(&card.id).unwrap();
    seed(
        &mut nb,
        vec![Operation::SetCardHeld {
            id: card.id.clone(),
            base_revision: current.revision,
            held: false,
        }],
    );
    refused(undo(&mut nb, held.seq), "changed after change");
    run(&mut nb, &edit(&id(4), "not a card"));
    assert!(!nb.card(&card.id).unwrap().active);
    refused(nb.agent_edit(&hold(&card.id, None, true)), "inactive");
    refused(nb.agent_edit(&hold(&card.id, None, false)), "inactive");
}

fn save_deck(
    id: Option<&str>,
    revision: Option<i64>,
    name: &str,
    query: CardQuery,
) -> AgentRequest {
    request(AgentEdit::SaveDeck {
        id: id.map(str::to_owned),
        revision,
        name: name.into(),
        query: Box::new(query),
    })
}

fn delete_deck(id: &str, revision: Option<i64>) -> AgentRequest {
    request(AgentEdit::DeleteDeck {
        id: id.into(),
        revision,
    })
}

#[test]
fn created_decks_are_returned_stored_attributed_and_removed_on_undo() {
    let (_dir, mut nb) = fixture();
    let query = CardQuery {
        selection: CardSelection::All,
        limit: Some(25),
        ..Default::default()
    };
    let receipt = run(
        &mut nb,
        &save_deck(None, None, "  Reading  ", query.clone()),
    );
    assert_eq!(receipt.summary, "Created deck Reading");
    assert!(receipt.page.is_none());
    assert!(receipt.blocks.is_empty());
    assert!(receipt.created_pages.is_empty());
    assert!(receipt.created_fields.is_empty());
    assert_eq!(receipt.decks.len(), 1);
    let deck = &receipt.decks[0];
    assert_eq!(deck.name, "Reading");
    assert_eq!(deck.query, query);
    assert_eq!(deck.revision, 1);
    assert_eq!(nb.deck(&deck.id).unwrap(), *deck);
    assert_eq!(nb.decks().unwrap(), receipt.decks);
    assert_eq!(receipt.committed.decks[0].id, deck.id);
    assert_eq!(receipt.committed.decks[0].revision, deck.revision);
    let change = nb.changes_since(receipt.seq - 1, 1).unwrap().remove(0);
    assert_eq!(change.actor, agent());
    assert_eq!(change.reason.as_deref(), Some("summary"));
    assert_eq!(change.decks, vec![deck.id.clone()]);
    let listed = nb.agent_changes(10).unwrap();
    assert_eq!(listed[0].summary, receipt.summary);
    assert!(listed[0].page.is_none());
    let undone = undo(&mut nb, receipt.seq).unwrap();
    assert_eq!(undone.committed.decks[0].id, deck.id);
    assert!(matches!(nb.deck(&deck.id), Err(Error::NotFound { .. })));
    assert!(nb.decks().unwrap().is_empty());
}

#[test]
fn saving_existing_decks_refuses_stale_revisions() {
    let (_dir, mut nb) = fixture();
    let created = run(
        &mut nb,
        &save_deck(None, None, "Reading", CardQuery::default()),
    );
    let deck = &created.decks[0];
    assert!(matches!(
        nb.agent_edit(&save_deck(
            Some(&deck.id),
            Some(deck.revision - 1),
            "Renamed",
            CardQuery::default(),
        )),
        Err(Error::Conflict { id, expected, found, .. })
            if id == deck.id && expected == deck.revision - 1 && found == Some(deck.revision)
    ));
    assert_eq!(nb.deck(&deck.id).unwrap(), *deck);
    assert_eq!(nb.agent_changes(10).unwrap().len(), 1);
}

#[test]
fn deck_renames_and_queries_are_restored_on_undo() {
    let (_dir, mut nb) = fixture();
    let created = run(
        &mut nb,
        &save_deck(None, None, "Reading", CardQuery::default()),
    );
    let before = &created.decks[0];
    let query = CardQuery {
        selection: CardSelection::New,
        limit: Some(12),
        ..Default::default()
    };
    let saved = run(
        &mut nb,
        &save_deck(
            Some(&before.id),
            Some(before.revision),
            "New cards",
            query.clone(),
        ),
    );
    assert_eq!(saved.summary, "Saved deck New cards");
    assert!(saved.page.is_none());
    assert_eq!(saved.decks.len(), 1);
    let after = &saved.decks[0];
    assert_eq!(after.id, before.id);
    assert_eq!(after.name, "New cards");
    assert_eq!(after.query, query);
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(nb.deck(&before.id).unwrap(), *after);
    undo(&mut nb, saved.seq).unwrap();
    let restored = nb.deck(&before.id).unwrap();
    assert_eq!(restored.name, before.name);
    assert_eq!(restored.query, before.query);
    assert_eq!(restored.revision, after.revision + 1);
    // The later save and its undo moved only the deck's revision.
    undo(&mut nb, created.seq).unwrap();
    assert!(nb.decks().unwrap().is_empty());
}

#[test]
fn deleted_decks_are_recreated_with_their_identity_and_query_on_undo() {
    let (_dir, mut nb) = fixture();
    let card = dune_card(&mut nb);
    let query = CardQuery {
        selection: CardSelection::All,
        limit: Some(8),
        ..Default::default()
    };
    let created = run(&mut nb, &save_deck(None, None, "Reading", query));
    let before = &created.decks[0];
    let deleted = run(&mut nb, &delete_deck(&before.id, Some(before.revision)));
    assert_eq!(deleted.summary, "Deleted deck Reading");
    assert!(deleted.page.is_none());
    assert!(deleted.decks.is_empty());
    assert!(matches!(nb.deck(&before.id), Err(Error::NotFound { .. })));
    assert_eq!(nb.card(&card.id).unwrap(), card);
    undo(&mut nb, deleted.seq).unwrap();
    let restored = nb.deck(&before.id).unwrap();
    assert_eq!(restored.id, before.id);
    assert_eq!(restored.name, before.name);
    assert_eq!(restored.query, before.query);
    assert_eq!(nb.card(&card.id).unwrap(), card);
    undo(&mut nb, created.seq).unwrap();
    assert!(nb.decks().unwrap().is_empty());
}

#[test]
fn undoing_a_created_deck_refuses_a_later_non_agent_save() {
    let (_dir, mut nb) = fixture();
    let created = run(
        &mut nb,
        &save_deck(None, None, "Reading", CardQuery::default()),
    );
    let deck = &created.decks[0];
    seed(
        &mut nb,
        vec![Operation::SaveDeck {
            id: deck.id.clone(),
            base_revision: Some(deck.revision),
            name: "Person's deck".into(),
            query: CardQuery::default(),
        }],
    );
    refused(undo(&mut nb, created.seq), "changed after change");
    assert_eq!(nb.deck(&deck.id).unwrap().name, "Person's deck");
}

#[test]
fn deck_edits_reject_invalid_names_queries_and_missing_decks() {
    let (_dir, mut nb) = fixture();
    for name in ["", "   ", &"x".repeat(121)] {
        refused(
            nb.agent_edit(&save_deck(None, None, name, CardQuery::default())),
            "deck name must contain 1 to 120 characters",
        );
    }
    refused(
        nb.agent_edit(&save_deck(
            None,
            None,
            "Invalid query",
            CardQuery {
                limit: Some(2001),
                ..Default::default()
            },
        )),
        "card query limit must not exceed 2000",
    );
    let missing = id(99);
    assert!(matches!(
        nb.agent_edit(&save_deck(Some(&missing), None, "Missing", CardQuery::default())),
        Err(Error::NotFound { id, .. }) if id == missing
    ));
    assert!(matches!(
        nb.agent_edit(&delete_deck(&missing, None)),
        Err(Error::NotFound { id, .. }) if id == missing
    ));
    assert!(nb.decks().unwrap().is_empty());
    assert!(nb.agent_changes(10).unwrap().is_empty());
}

#[test]
fn deleting_decks_refuses_stale_revisions_and_recreated_ids() {
    let (_dir, mut nb) = fixture();
    let created = run(
        &mut nb,
        &save_deck(None, None, "Reading", CardQuery::default()),
    );
    let before = &created.decks[0];
    assert!(matches!(
        nb.agent_edit(&delete_deck(&before.id, Some(before.revision - 1))),
        Err(Error::Conflict { id, expected, found, .. })
            if id == before.id && expected == before.revision - 1 && found == Some(before.revision)
    ));
    let deleted = run(&mut nb, &delete_deck(&before.id, None));
    seed(
        &mut nb,
        vec![Operation::SaveDeck {
            id: before.id.clone(),
            base_revision: None,
            name: "Replacement".into(),
            query: CardQuery::default(),
        }],
    );
    refused(undo(&mut nb, deleted.seq), "changed after change");
    assert_eq!(nb.deck(&before.id).unwrap().name, "Replacement");
}

#[test]
fn deck_revision_shifts_include_undone_deletions_after_multiple_saves() {
    let (_dir, mut nb) = fixture();
    let created = run(
        &mut nb,
        &save_deck(None, None, "Original", CardQuery::default()),
    );
    let deck = &created.decks[0];
    let saved = run(
        &mut nb,
        &save_deck(Some(&deck.id), None, "Renamed", CardQuery::default()),
    );
    let deleted = run(&mut nb, &delete_deck(&deck.id, None));
    undo(&mut nb, deleted.seq).unwrap();
    undo(&mut nb, saved.seq).unwrap();
    assert_eq!(nb.deck(&deck.id).unwrap().name, "Original");
    undo(&mut nb, created.seq).unwrap();
    assert!(nb.decks().unwrap().is_empty());
}

#[test]
fn deck_edit_serde_defaults_and_receipt_compatibility() {
    let save: AgentEdit = serde_json::from_value(serde_json::json!({
        "kind": "save_deck", "name": "Reading", "query": {}
    }))
    .unwrap();
    assert_eq!(
        save,
        save_deck(None, None, "Reading", CardQuery::default()).edit
    );
    let delete: AgentEdit = serde_json::from_value(serde_json::json!({
        "kind": "delete_deck", "id": id(99)
    }))
    .unwrap();
    assert_eq!(delete, delete_deck(&id(99), None).edit);
    let (_dir, mut nb) = fixture();
    let receipt = run(
        &mut nb,
        &save_deck(None, None, "Reading", CardQuery::default()),
    );
    let mut json = serde_json::to_value(&receipt).unwrap();
    json.as_object_mut().unwrap().remove("decks");
    let older: AgentReceipt = serde_json::from_value(json).unwrap();
    assert!(older.decks.is_empty());
}

fn evidence(nb: &mut Notebook, attached: bool) -> (String, Vec<Passage>) {
    let document = ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".into(),
        metadata: ExtractedMetadata {
            title: Some("Evidence".into()),
            ..Default::default()
        },
        toc: vec![],
        passages: ["Préface 🦉 evidence, evidence", "Second passage"]
            .iter()
            .enumerate()
            .map(|(index, text)| ExtractedPassage {
                kind: PassageKind::Paragraph,
                level: None,
                text: (*text).into(),
                locator: format!("chapter#{index}"),
                anchor: None,
                resource: None,
                marks: vec![],
            })
            .collect(),
        resources: vec![],
    };
    let hash = nb.put_object(b"agent evidence").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap().id;
    if attached {
        let plan = nb
            .plan_ingest(&snapshot, None, Some("evidence.epub"))
            .unwrap();
        seed(nb, plan.operations);
    }
    let passages = nb.passages(&snapshot, 0, 500).unwrap().passages;
    (snapshot, passages)
}

fn citation(block_id: &str, passage_id: &str) -> AgentCitation {
    AgentCitation {
        block_id: block_id.into(),
        revision: None,
        passage_id: passage_id.into(),
        end_passage_id: None,
        quote: None,
    }
}

#[test]
fn whole_passages_are_cited_with_attribution_and_removed_by_undo() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (snapshot, passages) = evidence(&mut nb, true);
    let receipt = run(
        &mut nb,
        &request(AgentEdit::Cite {
            citations: vec![citation(&id(2), &passages[0].id)],
        }),
    );
    assert_eq!(receipt.summary, "Cited 1 passage on Dune");
    assert_eq!(receipt.page.unwrap().id, id(1));
    assert_eq!(
        receipt.blocks,
        [tessera_core::Revision {
            id: id(2),
            revision: 2
        }]
    );
    let cited = nb.capabilities(&id(2)).unwrap().citations.remove(0);
    assert_eq!(cited.snapshot_id, snapshot);
    assert_eq!(cited.start.passage_id, passages[0].id);
    assert_eq!(cited.end.passage_id, passages[0].id);
    assert_eq!(cited.start.offset, 0);
    assert_eq!(
        cited.end.offset,
        passages[0].text.encode_utf16().count() as u32
    );
    assert_eq!(cited.quote, passages[0].text);
    assert!(ulid::Ulid::from_string(&cited.id).is_ok());
    assert_eq!(
        nb.changes_since(receipt.seq - 1, 1).unwrap()[0].actor,
        agent()
    );
    undo(&mut nb, receipt.seq).unwrap();
    assert!(nb.capabilities(&id(2)).unwrap().citations.is_empty());
}

#[test]
fn quoted_citations_use_the_first_match_and_utf16_offsets_after_non_ascii_text() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (_, passages) = evidence(&mut nb, true);
    let mut selected = citation(&id(2), &passages[0].id);
    selected.quote = Some("evidence".into());
    let receipt = run(
        &mut nb,
        &request(AgentEdit::Cite {
            citations: vec![selected],
        }),
    );
    let cited = nb.capabilities(&id(2)).unwrap().citations.remove(0);
    assert_eq!(cited.start.offset, 11);
    assert_eq!(cited.end.offset, 19);
    assert_eq!(cited.quote, "evidence");
    undo(&mut nb, receipt.seq).unwrap();
    assert!(nb.capabilities(&id(2)).unwrap().citations.is_empty());
}

#[test]
fn citations_can_span_passages_and_several_blocks_in_one_undoable_change() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (_, passages) = evidence(&mut nb, true);
    seed(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(10),
                title: "Other".into(),
            },
            Operation::Insert {
                id: id(11),
                parent_id: id(10),
                after: None,
                text: "other note".into(),
                heading: None,
            },
        ],
    );
    let mut range = citation(&id(2), &passages[0].id);
    range.end_passage_id = Some(passages[1].id.clone());
    range.revision = Some(1);
    let mut same_block = citation(&id(2), &passages[1].id);
    same_block.revision = Some(1);
    let receipt = run(
        &mut nb,
        &request(AgentEdit::Cite {
            citations: vec![range, same_block, citation(&id(11), &passages[1].id)],
        }),
    );
    assert_eq!(receipt.summary, "Cited 3 passages on Dune");
    assert_eq!(receipt.page.unwrap().id, id(1));
    assert_eq!(
        receipt.blocks,
        [
            tessera_core::Revision {
                id: id(2),
                revision: 3
            },
            tessera_core::Revision {
                id: id(11),
                revision: 2
            }
        ]
    );
    let citations = nb.capabilities(&id(2)).unwrap().citations;
    assert_eq!(citations.len(), 2);
    let range = citations
        .iter()
        .find(|cited| cited.start.passage_id == passages[0].id)
        .unwrap();
    assert_eq!(range.end.passage_id, passages[1].id);
    assert_eq!(
        range.end.offset,
        passages[1].text.encode_utf16().count() as u32
    );
    assert_eq!(nb.capabilities(&id(11)).unwrap().citations.len(), 1);
    undo(&mut nb, receipt.seq).unwrap();
    assert!(nb.capabilities(&id(2)).unwrap().citations.is_empty());
    assert!(nb.capabilities(&id(11)).unwrap().citations.is_empty());
}

#[test]
fn invalid_citations_write_nothing() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (_, passages) = evidence(&mut nb, true);
    let mut absent = citation(&id(2), &passages[0].id);
    absent.quote = Some("absent quote".into());
    refused(
        nb.agent_edit(&request(AgentEdit::Cite {
            citations: vec![citation(&id(2), &passages[1].id), absent.clone()],
        })),
        &passages[0].id,
    );
    assert_eq!(nb.block(&id(2)).unwrap().revision, 1);
    assert!(nb.capabilities(&id(2)).unwrap().citations.is_empty());
    absent.end_passage_id = Some(passages[1].id.clone());
    refused(
        nb.agent_edit(&request(AgentEdit::Cite {
            citations: vec![absent],
        })),
        "not both",
    );
    let mut stale = citation(&id(2), &passages[0].id);
    stale.revision = Some(7);
    assert!(matches!(
        nb.agent_edit(&request(AgentEdit::Cite {
            citations: vec![stale]
        })),
        Err(Error::Conflict { .. })
    ));
    refused(
        nb.agent_edit(&request(AgentEdit::Cite { citations: vec![] })),
        "must contain",
    );
}

#[test]
fn citations_require_an_attached_snapshot_and_undo_refuses_later_block_edits() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (snapshot, passages) = evidence(&mut nb, false);
    let ask = request(AgentEdit::Cite {
        citations: vec![citation(&id(2), &passages[0].id)],
    });
    refused(nb.agent_edit(&ask), "attached snapshot");
    let ingest = nb
        .plan_ingest(&snapshot, None, Some("evidence.epub"))
        .unwrap();
    seed(&mut nb, ingest.operations);
    let cited = run(&mut nb, &ask);
    seed(
        &mut nb,
        vec![Operation::EditText {
            id: id(2),
            base_revision: 2,
            text: "someone else's edit".into(),
        }],
    );
    refused(undo(&mut nb, cited.seq), "changed after change");
    assert_eq!(nb.capabilities(&id(2)).unwrap().citations.len(), 1);
}

#[test]
fn page_cards_include_held_units_but_exclude_other_pages_deleted_sources_and_inactive_units() {
    let (_dir, mut nb) = fixture();
    let card = dune_card(&mut nb);
    run(&mut nb, &hold(&card.id, None, true));
    run(&mut nb, &edit(&id(2), "deleted front>>back"));
    run(&mut nb, &edit(&id(3), "inactive front>>back"));
    run(&mut nb, &edit(&id(3), "not a card"));
    let other = run(
        &mut nb,
        &note(page("Other"), vec![block("other front>>back", vec![])]),
    );
    run(
        &mut nb,
        &request(AgentEdit::DeleteBlock {
            id: id(2),
            revision: None,
        }),
    );
    let cards = nb.page_cards(&id(1)).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].id, card.id);
    assert!(cards[0].held);
    assert_eq!(nb.page_cards(&other.page.unwrap().id).unwrap().len(), 1);
    assert!(matches!(
        nb.page_cards(&id(99)),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(nb.page_cards(&id(4)), Err(Error::NotFound { .. })));
    run(
        &mut nb,
        &request(AgentEdit::DeleteBlock {
            id: id(1),
            revision: None,
        }),
    );
    assert!(matches!(nb.page_cards(&id(1)), Err(Error::NotFound { .. })));
}

#[test]
fn citation_range_endpoints_must_share_a_snapshot() {
    let (_dir, mut nb) = fixture();
    dune(&mut nb);
    let (_, passages) = evidence(&mut nb, true);
    let document = ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".into(),
        metadata: ExtractedMetadata::default(),
        toc: vec![],
        passages: vec![ExtractedPassage {
            kind: PassageKind::Paragraph,
            level: None,
            text: "Different snapshot".into(),
            locator: "chapter".into(),
            anchor: None,
            resource: None,
            marks: vec![],
        }],
        resources: vec![],
    };
    let hash = nb.put_object(b"different agent evidence").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap().id;
    let last = nb.passages(&snapshot, 0, 500).unwrap().passages.remove(0);
    let mut range = citation(&id(2), &passages[0].id);
    range.end_passage_id = Some(last.id);
    refused(
        nb.agent_edit(&request(AgentEdit::Cite {
            citations: vec![range],
        })),
        "share one snapshot",
    );
    assert!(nb.capabilities(&id(2)).unwrap().citations.is_empty());
}

#[test]
fn new_agent_kinds_deserialize_with_optional_revision_and_citation_range_fields() {
    let held: AgentRequest = serde_json::from_value(serde_json::json!({
        "actor": { "kind": "agent", "name": "claude" },
        "kind": "set_card_held",
        "card_id": id(1),
        "held": true
    }))
    .unwrap();
    assert_eq!(
        held.edit,
        AgentEdit::SetCardHeld {
            card_id: id(1),
            revision: None,
            held: true
        }
    );
    let cited: AgentRequest = serde_json::from_value(serde_json::json!({
        "actor": { "kind": "agent", "name": "claude" },
        "kind": "cite",
        "citations": [{ "block_id": id(2), "passage_id": id(3) }]
    }))
    .unwrap();
    assert_eq!(
        cited.edit,
        AgentEdit::Cite {
            citations: vec![citation(&id(2), &id(3))]
        }
    );
    let (_dir, mut nb) = fixture();
    let receipt = run(
        &mut nb,
        &note(page("Dune"), vec![block("ordinary", vec![])]),
    );
    let mut legacy = serde_json::to_value(receipt).unwrap();
    legacy.as_object_mut().unwrap().remove("created_fields");
    assert!(
        serde_json::from_value::<AgentReceipt>(legacy)
            .unwrap()
            .created_fields
            .is_empty()
    );
}
