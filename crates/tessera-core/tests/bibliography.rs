use tessera_core::library::{CreatorRole, LibraryPerson, LibraryQuery};
use tessera_core::{Actor, AgentEdit, AgentRequest, NoteBlock, NoteTarget, Notebook};

fn block(text: &str, children: Vec<NoteBlock>) -> NoteBlock {
    NoteBlock {
        text: text.into(),
        heading: None,
        task: None,
        children,
    }
}

/// Files a note as an agent does through MCP, returning its page id.
fn add_note(notebook: &mut Notebook, title: &str, blocks: Vec<NoteBlock>) -> String {
    notebook
        .agent_edit(&AgentRequest {
            actor: Actor::Agent {
                name: "claude".into(),
            },
            reason: None,
            edit: AgentEdit::AddNote {
                target: NoteTarget::Page {
                    title: title.into(),
                },
                blocks,
            },
        })
        .unwrap()
        .page
        .unwrap()
        .id
}

fn person(id: Option<&str>, name: &str) -> LibraryPerson {
    LibraryPerson {
        id: id.map(Into::into),
        name: name.into(),
        role: CreatorRole::Author,
    }
}

#[test]
fn bibliography_links_creator_pages_and_names_the_form() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let ada = add_note(&mut nb, "Ada Lovelace #person", vec![block("x", vec![])]);
    let paper = add_note(
        &mut nb,
        "Note G #source",
        vec![
            block("form:: paper", vec![]),
            block(
                "author::",
                vec![
                    block("[[Ada Lovelace]]", vec![]),
                    block("Luigi Menabrea", vec![]),
                    block("et al.", vec![]),
                ],
            ),
        ],
    );

    let index = nb.kind_notes("source").unwrap();
    let source = index.summaries[&paper].source.as_ref().unwrap();
    assert_eq!(source.form.as_deref(), Some("paper"));
    assert_eq!(
        source.authors,
        [
            person(Some(&ada), "Ada Lovelace"),
            person(None, "Luigi Menabrea"),
            person(None, "et al."),
        ],
        "a linked creator carries its page id; plain names stay plain"
    );

    let library = nb.library(&LibraryQuery::default()).unwrap();
    let row = library
        .rows
        .iter()
        .find(|row| row.page.id == paper)
        .unwrap();
    assert_eq!(row.form.as_deref(), Some("paper"));
}
