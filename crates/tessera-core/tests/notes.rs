use tessera_core::{
    Actor, Batch, BlockKind, Error, Note, NoteBlock, NoteReceipt, NoteTarget, Notebook, Operation,
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
fn block(text: &str, children: Vec<NoteBlock>) -> NoteBlock {
    NoteBlock {
        text: text.into(),
        heading: None,
        children,
    }
}
fn note(target: NoteTarget, blocks: Vec<NoteBlock>) -> Note {
    Note {
        actor: Actor::Agent {
            name: "claude".into(),
        },
        reason: Some("summary".into()),
        target,
        blocks,
    }
}
fn page(title: &str) -> NoteTarget {
    NoteTarget::Page {
        title: title.into(),
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
fn add(notebook: &mut Notebook, note: &Note) -> NoteReceipt {
    notebook.add_note(note).unwrap()
}

#[test]
fn a_missing_page_is_created_with_the_nested_outline_and_attributed() {
    let (_dir, mut nb) = fixture();
    let mut heading = block("Summary", vec![block("a", vec![block("a1", vec![])])]);
    heading.heading = Some(2);
    let receipt = add(
        &mut nb,
        &note(page("Reading log"), vec![heading, block("b", vec![])]),
    );

    assert_eq!(receipt.page.kind, BlockKind::Page);
    assert_eq!(receipt.page.text, "Reading log");
    assert_eq!(receipt.parent_id, receipt.page.id);
    assert_eq!(receipt.created_pages, vec![receipt.page.clone()]);
    assert_eq!(
        outline(&nb, &receipt.page.id),
        ["Summary", "  a", "    a1", "b"]
    );
    let rows = nb.page(&receipt.page.id).unwrap().rows;
    assert_eq!(
        receipt.blocks,
        rows.iter()
            .map(|row| row.block.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(rows[0].block.heading, Some(2));
    let change = nb
        .changes_since(receipt.committed.seq - 1, 1)
        .unwrap()
        .remove(0);
    assert_eq!(
        change.actor,
        Actor::Agent {
            name: "claude".into()
        }
    );
    assert_eq!(change.reason.as_deref(), Some("summary"));
}

#[test]
fn an_existing_page_matched_ignoring_case_gets_the_note_after_its_last_top_level_block() {
    let (_dir, mut nb) = fixture();
    seed(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Dune".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "first".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(3),
                parent_id: id(2),
                after: None,
                text: "nested".into(),
                heading: None,
            },
        ],
    );
    let receipt = add(
        &mut nb,
        &note(
            page("  dUNE "),
            vec![block("x", vec![]), block("y", vec![])],
        ),
    );
    assert_eq!(receipt.page.id, id(1));
    assert!(receipt.created_pages.is_empty());
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "x", "y"]);

    let receipt = add(
        &mut nb,
        &note(NoteTarget::Block { id: id(2) }, vec![block("z", vec![])]),
    );
    assert_eq!(receipt.parent_id, id(2));
    assert_eq!(receipt.page.id, id(1));
    assert_eq!(outline(&nb, &id(1)), ["first", "  nested", "  z", "x", "y"]);
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
    let receipt = add(&mut nb, &note(page("Letters"), vec![block(&text, vec![])]));

    let titles: Vec<_> = receipt
        .created_pages
        .iter()
        .map(|p| p.text.as_str())
        .collect();
    assert_eq!(titles, ["Letters", "Seneca"]);
    let seneca = nb.page_by_title("Seneca").unwrap().unwrap().id;
    let written = nb.block(&receipt.blocks[0]).unwrap().text;
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
        assert_eq!(backlinks[0].source.id, receipt.blocks[0]);
    }
}

#[test]
fn a_journal_note_creates_the_day_once_then_appends_to_it() {
    let (_dir, mut nb) = fixture();
    let today = NoteTarget::Journal { date: None };
    let first = add(&mut nb, &note(today.clone(), vec![block("one", vec![])]));
    let second = add(&mut nb, &note(today, vec![block("two", vec![])]));
    assert_eq!(first.page.kind, BlockKind::Journal);
    assert_eq!(first.page.text, nb.today(tessera_core::now_ms()).unwrap());
    assert_eq!(first.created_pages, vec![]);
    assert_eq!(second.page.id, first.page.id);
    assert_eq!(outline(&nb, &first.page.id), ["one", "two"]);

    let dated = add(
        &mut nb,
        &note(
            NoteTarget::Journal {
                date: Some("2024-02-29".into()),
            },
            vec![block("leap", vec![])],
        ),
    );
    assert_eq!(dated.page.text, "2024-02-29");
}

#[test]
fn a_rejected_note_writes_nothing() {
    let (_dir, mut nb) = fixture();
    let mut bad = block("too deep", vec![]);
    bad.heading = Some(4);
    let error = nb
        .add_note(&note(page("Draft"), vec![block("[[Linked]]", vec![]), bad]))
        .unwrap_err();
    assert!(matches!(error, Error::Validation { .. }), "{error}");
    assert!(nb.page_by_title("Draft").unwrap().is_none());
    assert!(nb.page_by_title("Linked").unwrap().is_none());

    let error = nb
        .add_note(&note(
            NoteTarget::Journal {
                date: Some("2026-02-30".into()),
            },
            vec![block("x", vec![])],
        ))
        .unwrap_err();
    assert!(matches!(error, Error::Validation { .. }), "{error}");
    assert!(nb.add_note(&note(page("Empty"), vec![])).is_err());
    assert!(nb.page_by_title("Empty").unwrap().is_none());
}
