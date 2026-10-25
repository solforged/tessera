use tessera_core::{Actor, Batch, ChangeStamp, Error, Notebook, Operation};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Client {
            name: "tessera-web:test".into(),
        },
        reason: Some("Editor change".into()),
        idempotency_key: None,
        operations,
    }
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

fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    notebook
        .apply(&batch(vec![
            Operation::CreatePage {
                id: id(1),
                title: "Work".into(),
            },
            insert(2, 1, None, "First"),
            insert(3, 2, None, "Nested"),
            insert(4, 1, Some(2), "Second"),
            insert(5, 1, Some(4), "Third"),
            insert(6, 5, None, "Deleted child"),
        ]))
        .unwrap();
    (dir, notebook)
}

fn outline(notebook: &Notebook) -> Vec<(String, String, u32)> {
    notebook
        .page(&id(1))
        .unwrap()
        .rows
        .into_iter()
        .map(|row| (row.block.id, row.block.text, row.depth))
        .collect()
}

fn refused(notebook: &mut Notebook, seq: i64, message: &str) {
    match notebook.undo_change(seq, &Actor::Person) {
        Err(Error::Validation {
            message: actual, ..
        }) => assert!(actual.contains(message), "{actual}"),
        other => panic!("expected refusal containing {message}, got {other:?}"),
    }
}

#[test]
fn editor_batches_list_and_undo_text_position_and_deleted_subtrees() {
    let (_dir, mut notebook) = fixture();
    let before = outline(&notebook);
    let committed = notebook
        .apply(&batch(vec![
            Operation::EditText {
                id: id(2),
                base_revision: 1,
                text: "Edited first".into(),
            },
            Operation::Move {
                id: id(4),
                base_revision: 1,
                parent_id: id(2),
                after: Some(id(3)),
            },
            Operation::Delete {
                id: id(5),
                base_revision: 1,
            },
        ]))
        .unwrap();
    let edited = outline(&notebook);
    let history = notebook.history(1, None).unwrap();
    let entry = &history[0];
    assert_eq!(entry.seq, committed.seq);
    assert_eq!(entry.actor, batch(vec![]).actor);
    assert_eq!(entry.reason.as_deref(), Some("Editor change"));
    assert!(entry.change_id.is_some());
    assert!(entry.origin.is_some());
    assert!(entry.undoable);
    assert!(entry.summary.contains("3 atoms"), "{}", entry.summary);
    assert!(entry.summary.contains("Work"));
    assert_eq!(entry.page.as_ref().unwrap().id, id(1));
    assert_eq!(entry.undoes, None);

    let undone = notebook.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(outline(&notebook), before);
    assert_eq!(notebook.block(&id(6)).unwrap().parent_id, Some(id(5)));
    let history = notebook.history(2, None).unwrap();
    assert_eq!(history[0].seq, undone.committed.seq);
    assert_eq!(history[0].undoes, Some(committed.seq));
    assert_eq!(history[0].summary, format!("Undid: {}", entry.summary));
    assert_eq!(history[0].actor, Actor::Person);
    assert!(history[0].undoable);
    assert_eq!(history[1].undone_by, Some(undone.committed.seq));
    assert!(!history[1].undoable);
    refused(&mut notebook, committed.seq, "already undone");
    notebook
        .undo_change(undone.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(outline(&notebook), edited);
    assert_eq!(
        notebook.history(1, None).unwrap()[0].summary,
        format!("Redid: {}", entry.summary)
    );
}

#[test]
fn a_merge_makes_the_entire_editor_batch_non_undoable() {
    let (_dir, mut notebook) = fixture();
    let committed = notebook
        .apply(&batch(vec![
            Operation::EditText {
                id: id(2),
                base_revision: 1,
                text: "Edited first".into(),
            },
            Operation::Merge {
                source_id: id(5),
                source_revision: 1,
                destination_id: id(4),
                destination_revision: 1,
            },
        ]))
        .unwrap();
    let entry = notebook.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, committed.seq);
    assert!(!entry.undoable);
    assert!(!entry.summary.is_empty());
    refused(&mut notebook, committed.seq, "not undoable");
    assert_eq!(notebook.block(&id(2)).unwrap().text, "Edited first");
}

#[test]
fn remote_stamped_changes_keep_their_origin_without_local_inverses() {
    let (_dir, mut notebook) = fixture();
    let stamp = ChangeStamp {
        id: id(100),
        origin: id(101),
        at: 1_800_000_000_000,
    };
    let remote = batch(vec![Operation::EditText {
        id: id(2),
        base_revision: 1,
        text: "From the phone".into(),
    }]);
    let committed = notebook.apply_stamped(&remote, &stamp).unwrap();
    let entry = notebook.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, committed.seq);
    assert_eq!(entry.change_id.as_deref(), Some(stamp.id.as_str()));
    assert_eq!(entry.origin.as_deref(), Some(stamp.origin.as_str()));
    assert_eq!(entry.created_at, stamp.at);
    assert!(!entry.undoable);
    refused(&mut notebook, committed.seq, "not undoable");
    let replay = notebook.apply_stamped(&remote, &stamp).unwrap();
    assert!(replay.replayed);
    assert_eq!(notebook.history(1, None).unwrap()[0], entry);
}

#[test]
fn history_pages_exclusively_and_replays_do_not_replace_inverses() {
    let (_dir, mut notebook) = fixture();
    let mut edit = batch(vec![Operation::EditText {
        id: id(2),
        base_revision: 1,
        text: "Updated".into(),
    }]);
    edit.idempotency_key = Some("history-editor-edit".into());
    let committed = notebook.apply(&edit).unwrap();
    let entry = notebook.history(1, None).unwrap().remove(0);
    assert!(notebook.apply(&edit).unwrap().replayed);
    assert_eq!(notebook.history(1, None).unwrap()[0], entry);
    let previous = notebook.history(500, Some(committed.seq)).unwrap();
    assert!(previous.iter().all(|entry| entry.seq < committed.seq));
    assert!(
        previous
            .windows(2)
            .all(|entries| entries[0].seq > entries[1].seq)
    );
    assert!(notebook.history(0, None).unwrap().is_empty());
    notebook.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, "First");
}

#[test]
fn creation_batches_remove_nested_blocks_without_deleting_their_existing_page() {
    let (_dir, mut notebook) = fixture();
    let committed = notebook
        .apply(&batch(vec![
            insert(10, 1, Some(5), "New parent"),
            insert(11, 10, None, "New child"),
            Operation::EditText {
                id: id(11),
                base_revision: 1,
                text: "New edited child".into(),
            },
        ]))
        .unwrap();
    notebook.undo_change(committed.seq, &Actor::Person).unwrap();
    assert!(notebook.block(&id(10)).is_err());
    assert!(notebook.block(&id(11)).is_err());
    assert!(notebook.block(&id(1)).is_ok());
}

#[test]
fn subtree_inverses_advance_revisions_of_independently_edited_descendants() {
    for cross_page in [false, true] {
        let (_dir, mut notebook) = fixture();
        let before = outline(&notebook);
        let second = if cross_page {
            notebook
                .apply(&batch(vec![Operation::CreatePage {
                    id: id(10),
                    title: "Other page".into(),
                }]))
                .unwrap();
            Operation::Move {
                id: id(2),
                base_revision: 1,
                parent_id: id(10),
                after: None,
            }
        } else {
            Operation::Delete {
                id: id(2),
                base_revision: 1,
            }
        };
        let committed = notebook
            .apply(&batch(vec![
                Operation::EditText {
                    id: id(3),
                    base_revision: 1,
                    text: "Edited child".into(),
                },
                second,
            ]))
            .unwrap();
        notebook.undo_change(committed.seq, &Actor::Person).unwrap();
        assert_eq!(outline(&notebook), before);
        assert_eq!(notebook.block(&id(3)).unwrap().page_id, id(1));
    }
}

#[test]
fn mixed_creations_and_moves_evacuate_existing_subtrees_before_removing_new_parents() {
    let (_dir, mut notebook) = fixture();
    let before = outline(&notebook);
    let committed = notebook
        .apply(&batch(vec![
            insert(10, 1, Some(5), "New parent"),
            Operation::Move {
                id: id(2),
                base_revision: 1,
                parent_id: id(10),
                after: None,
            },
        ]))
        .unwrap();
    notebook.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(outline(&notebook), before);
    assert!(notebook.block(&id(10)).is_err());
}

#[test]
fn deck_batches_restore_their_initial_state_even_after_multiple_saves_or_deletion() {
    for delete in [false, true] {
        let (_dir, mut notebook) = fixture();
        notebook
            .apply(&batch(vec![Operation::SaveDeck {
                id: id(20),
                base_revision: None,
                name: "Original deck".into(),
                query: tessera_core::CardQuery::default(),
            }]))
            .unwrap();
        let final_op = if delete {
            Operation::DeleteDeck {
                id: id(20),
                base_revision: 2,
            }
        } else {
            Operation::SaveDeck {
                id: id(20),
                base_revision: Some(2),
                name: "Final deck".into(),
                query: tessera_core::CardQuery::default(),
            }
        };
        let committed = notebook
            .apply(&batch(vec![
                Operation::SaveDeck {
                    id: id(20),
                    base_revision: Some(1),
                    name: "Intermediate deck".into(),
                    query: tessera_core::CardQuery::default(),
                },
                final_op,
            ]))
            .unwrap();
        notebook.undo_change(committed.seq, &Actor::Person).unwrap();
        assert_eq!(notebook.deck(&id(20)).unwrap().name, "Original deck");
    }
}

#[test]
fn removing_a_task_restores_both_its_state_and_its_authored_tag_on_undo() {
    let (_dir, mut notebook) = fixture();
    notebook
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "#Task First".into(),
        }]))
        .unwrap();
    let before_text = notebook.block(&id(2)).unwrap().text;
    let before_state = notebook.capabilities(&id(2)).unwrap().task;
    let committed = notebook
        .apply(&batch(vec![Operation::SetTask {
            id: id(2),
            base_revision: notebook.block(&id(2)).unwrap().revision,
            task: None,
        }]))
        .unwrap();
    notebook.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, before_text);
    assert_eq!(notebook.capabilities(&id(2)).unwrap().task, before_state);
}

#[test]
fn migration_preserves_previous_agent_inverses() {
    let (_dir, mut notebook) = fixture();
    let receipt = notebook
        .agent_edit(&tessera_core::AgentRequest {
            actor: Actor::Agent {
                name: "Migration test".into(),
            },
            reason: None,
            edit: tessera_core::AgentEdit::EditBlock {
                id: id(2),
                revision: None,
                text: Some("Agent edit".into()),
                heading: None,
            },
        })
        .unwrap();
    let path = notebook
        .info()
        .unwrap()
        .path
        .join(tessera_core::DATABASE_FILE);
    drop(notebook);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("ALTER TABLE change_history RENAME TO saved_history;")
        .unwrap();
    conn.execute_batch(include_str!("../migrations/019_agent_changes.sql"))
        .unwrap();
    conn.execute_batch(
        "INSERT INTO agent_changes(seq, summary, page_id, undo, undone_seq)
         SELECT seq, summary, page_id, undo, undone_seq FROM saved_history WHERE undo IS NOT NULL;
         DROP TABLE saved_history;
         PRAGMA user_version = 53;",
    )
    .unwrap();
    drop(conn);
    let mut notebook = Notebook::open(path.parent().unwrap()).unwrap();
    let entry = notebook.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, receipt.seq);
    assert_eq!(entry.summary, receipt.summary);
    assert!(entry.undoable);
    notebook.undo_change(receipt.seq, &Actor::Person).unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, "First");
}

#[test]
fn undoing_an_undo_does_not_let_older_inverses_overwrite_reactivated_edits() {
    let (_dir, mut notebook) = fixture();
    let first = notebook
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "First edit".into(),
        }]))
        .unwrap();
    let second = notebook
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 2,
            text: "Second edit".into(),
        }]))
        .unwrap();
    let undo = notebook.undo_change(second.seq, &Actor::Person).unwrap();
    let redo = notebook
        .undo_change(undo.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, "Second edit");
    refused(&mut notebook, first.seq, "changed after change");
    notebook
        .undo_change(redo.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, "First edit");
    notebook.undo_change(first.seq, &Actor::Person).unwrap();
    assert_eq!(notebook.block(&id(2)).unwrap().text, "First");
}
