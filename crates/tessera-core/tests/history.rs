use tessera_core::{Actor, Batch, ChangeStamp, Error, Operation, Workshop};

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

fn fixture() -> (tempfile::TempDir, Workshop) {
    let dir = tempfile::tempdir().unwrap();
    let mut workshop = Workshop::open(dir.path()).unwrap();
    workshop
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
    (dir, workshop)
}

fn outline(workshop: &Workshop) -> Vec<(String, String, u32)> {
    workshop
        .page(&id(1))
        .unwrap()
        .rows
        .into_iter()
        .map(|row| (row.block.id, row.block.text, row.depth))
        .collect()
}

fn refused(workshop: &mut Workshop, seq: i64, message: &str) {
    match workshop.undo_change(seq, &Actor::Person) {
        Err(Error::Validation {
            message: actual, ..
        }) => assert!(actual.contains(message), "{actual}"),
        other => panic!("expected refusal containing {message}, got {other:?}"),
    }
}

#[test]
fn editor_batches_list_and_undo_text_position_and_deleted_subtrees() {
    let (_dir, mut workshop) = fixture();
    let before = outline(&workshop);
    let committed = workshop
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
    let edited = outline(&workshop);
    let history = workshop.history(1, None).unwrap();
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

    let undone = workshop.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(outline(&workshop), before);
    assert_eq!(workshop.block(&id(6)).unwrap().parent_id, Some(id(5)));
    let history = workshop.history(2, None).unwrap();
    assert_eq!(history[0].seq, undone.committed.seq);
    assert_eq!(undone.seq, history[0].seq);
    assert_eq!(history[0].undoes, Some(committed.seq));
    assert_eq!(history[0].summary, format!("Undid: {}", entry.summary));
    assert_eq!(history[0].actor, Actor::Person);
    assert!(history[0].undoable);
    assert_eq!(history[1].undone_by, Some(undone.committed.seq));
    assert!(!history[1].undoable);
    refused(&mut workshop, committed.seq, "already undone");
    assert!(matches!(
        workshop.undo_change(999, &Actor::Person),
        Err(Error::NotFound { what: "change", id, .. }) if id == "999"
    ));
    workshop
        .undo_change(undone.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(outline(&workshop), edited);
    assert_eq!(
        workshop.history(1, None).unwrap()[0].summary,
        format!("Redid: {}", entry.summary)
    );
}

#[test]
fn a_merge_makes_the_entire_editor_batch_non_undoable() {
    let (_dir, mut workshop) = fixture();
    let committed = workshop
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
    let entry = workshop.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, committed.seq);
    assert!(!entry.undoable);
    assert!(!entry.summary.is_empty());
    refused(&mut workshop, committed.seq, "not undoable");
    assert_eq!(workshop.block(&id(2)).unwrap().text, "Edited first");
}

#[test]
fn remote_stamped_changes_keep_their_origin_without_local_inverses() {
    let (_dir, mut workshop) = fixture();
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
    let committed = workshop.apply_stamped(&remote, &stamp).unwrap();
    let entry = workshop.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, committed.seq);
    assert_eq!(entry.change_id.as_deref(), Some(stamp.id.as_str()));
    assert_eq!(entry.origin.as_deref(), Some(stamp.origin.as_str()));
    assert_eq!(entry.created_at, stamp.at);
    assert!(!entry.undoable);
    refused(&mut workshop, committed.seq, "not undoable");
    let replay = workshop.apply_stamped(&remote, &stamp).unwrap();
    assert!(replay.replayed);
    assert_eq!(workshop.history(1, None).unwrap()[0], entry);
}

#[test]
fn history_pages_exclusively_and_replays_do_not_replace_inverses() {
    let (_dir, mut workshop) = fixture();
    let mut edit = batch(vec![Operation::EditText {
        id: id(2),
        base_revision: 1,
        text: "Updated".into(),
    }]);
    edit.idempotency_key = Some("history-editor-edit".into());
    let committed = workshop.apply(&edit).unwrap();
    let entry = workshop.history(1, None).unwrap().remove(0);
    assert!(workshop.apply(&edit).unwrap().replayed);
    assert_eq!(workshop.history(1, None).unwrap()[0], entry);
    let previous = workshop.history(500, Some(committed.seq)).unwrap();
    assert!(previous.iter().all(|entry| entry.seq < committed.seq));
    assert!(
        previous
            .windows(2)
            .all(|entries| entries[0].seq > entries[1].seq)
    );
    assert!(workshop.history(0, None).unwrap().is_empty());
    workshop.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, "First");
}

#[test]
fn creation_batches_remove_nested_blocks_without_deleting_their_existing_page() {
    let (_dir, mut workshop) = fixture();
    let committed = workshop
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
    workshop.undo_change(committed.seq, &Actor::Person).unwrap();
    assert!(workshop.block(&id(10)).is_err());
    assert!(workshop.block(&id(11)).is_err());
    assert!(workshop.block(&id(1)).is_ok());
}

#[test]
fn undoing_an_addition_refuses_while_a_nested_block_it_added_holds_a_later_edit() {
    // A new block under an existing page is removed directly; one under a
    // new page goes with the page. Either delete takes the whole subtree.
    for new_page in [false, true] {
        let (_dir, mut workshop) = fixture();
        let mut operations = Vec::new();
        let parent = if new_page {
            operations.push(Operation::CreatePage {
                id: id(20),
                title: "Fresh".into(),
            });
            20
        } else {
            1
        };
        operations.extend([
            insert(10, parent, None, "New parent"),
            insert(11, 10, None, "New child"),
        ]);
        let added = workshop.apply(&batch(operations)).unwrap();
        let edited = workshop
            .apply(&batch(vec![Operation::EditText {
                id: id(11),
                base_revision: 1,
                text: "Someone else's edit".into(),
            }]))
            .unwrap();
        refused(
            &mut workshop,
            added.seq,
            &format!("atom {} changed after change {}", id(11), added.seq),
        );
        assert_eq!(workshop.block(&id(11)).unwrap().text, "Someone else's edit");
        workshop.undo_change(edited.seq, &Actor::Person).unwrap();
        workshop.undo_change(added.seq, &Actor::Person).unwrap();
        assert!(workshop.block(&id(10)).is_err());
        assert!(workshop.block(&id(11)).is_err());
    }
}

#[test]
fn undoing_a_deletion_names_what_took_its_date_or_title_since() {
    let (_dir, mut workshop) = fixture();
    let journal = |value| Operation::CreateJournal {
        id: id(value),
        date: "2026-10-30".into(),
    };
    workshop.apply(&batch(vec![journal(30)])).unwrap();
    let deleted = workshop
        .apply(&batch(vec![Operation::Delete {
            id: id(30),
            base_revision: 1,
        }]))
        .unwrap();
    let again = workshop.apply(&batch(vec![journal(31)])).unwrap();
    refused(
        &mut workshop,
        deleted.seq,
        &format!(
            "journal 2026-10-30 was created again by change {}; undo change {}",
            again.seq, again.seq
        ),
    );
    workshop.undo_change(again.seq, &Actor::Person).unwrap();
    workshop.undo_change(deleted.seq, &Actor::Person).unwrap();
    assert!(workshop.block(&id(30)).is_ok());

    workshop
        .apply(&batch(vec![Operation::CreatePage {
            id: id(40),
            title: "Notes".into(),
        }]))
        .unwrap();
    let deleted = workshop
        .apply(&batch(vec![Operation::Delete {
            id: id(1),
            base_revision: 1,
        }]))
        .unwrap();
    let renamed = workshop
        .apply(&batch(vec![Operation::EditText {
            id: id(40),
            base_revision: 1,
            text: "work".into(),
        }]))
        .unwrap();
    refused(
        &mut workshop,
        deleted.seq,
        "another atom is now titled \"work\"; rename or delete that atom first",
    );
    workshop.undo_change(renamed.seq, &Actor::Person).unwrap();
    workshop.undo_change(deleted.seq, &Actor::Person).unwrap();
    assert_eq!(workshop.block(&id(1)).unwrap().text, "Work");
}

#[test]
fn subtree_inverses_advance_revisions_of_independently_edited_descendants() {
    for cross_page in [false, true] {
        let (_dir, mut workshop) = fixture();
        let before = outline(&workshop);
        let second = if cross_page {
            workshop
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
        let committed = workshop
            .apply(&batch(vec![
                Operation::EditText {
                    id: id(3),
                    base_revision: 1,
                    text: "Edited child".into(),
                },
                second,
            ]))
            .unwrap();
        workshop.undo_change(committed.seq, &Actor::Person).unwrap();
        assert_eq!(outline(&workshop), before);
        assert_eq!(workshop.block(&id(3)).unwrap().page_id, id(1));
    }
}

#[test]
fn mixed_creations_and_moves_evacuate_existing_subtrees_before_removing_new_parents() {
    let (_dir, mut workshop) = fixture();
    let before = outline(&workshop);
    let committed = workshop
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
    workshop.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(outline(&workshop), before);
    assert!(workshop.block(&id(10)).is_err());
}

#[test]
fn deck_batches_restore_their_initial_state_even_after_multiple_saves_or_deletion() {
    for delete in [false, true] {
        let (_dir, mut workshop) = fixture();
        workshop
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
        let committed = workshop
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
        workshop.undo_change(committed.seq, &Actor::Person).unwrap();
        assert_eq!(workshop.deck(&id(20)).unwrap().name, "Original deck");
    }
}

#[test]
fn removing_a_task_restores_both_its_state_and_its_authored_tag_on_undo() {
    let (_dir, mut workshop) = fixture();
    workshop
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "#Task First".into(),
        }]))
        .unwrap();
    let before_text = workshop.block(&id(2)).unwrap().text;
    let before_state = workshop.capabilities(&id(2)).unwrap().task;
    let committed = workshop
        .apply(&batch(vec![Operation::SetTask {
            id: id(2),
            base_revision: workshop.block(&id(2)).unwrap().revision,
            task: None,
        }]))
        .unwrap();
    workshop.undo_change(committed.seq, &Actor::Person).unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, before_text);
    assert_eq!(workshop.capabilities(&id(2)).unwrap().task, before_state);
}

#[test]
fn migration_preserves_previous_agent_inverses() {
    let (_dir, mut workshop) = fixture();
    let receipt = workshop
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
    let path = workshop
        .info()
        .unwrap()
        .path
        .join(tessera_core::DATABASE_FILE);
    drop(workshop);
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
    let mut workshop = Workshop::open(path.parent().unwrap()).unwrap();
    let entry = workshop.history(1, None).unwrap().remove(0);
    assert_eq!(entry.seq, receipt.seq);
    assert_eq!(entry.summary, receipt.summary);
    assert!(entry.undoable);
    workshop.undo_change(receipt.seq, &Actor::Person).unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, "First");
}

#[test]
fn undoing_an_undo_does_not_let_older_inverses_overwrite_reactivated_edits() {
    let (_dir, mut workshop) = fixture();
    let first = workshop
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "First edit".into(),
        }]))
        .unwrap();
    let second = workshop
        .apply(&batch(vec![Operation::EditText {
            id: id(2),
            base_revision: 2,
            text: "Second edit".into(),
        }]))
        .unwrap();
    let undo = workshop.undo_change(second.seq, &Actor::Person).unwrap();
    let redo = workshop
        .undo_change(undo.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, "Second edit");
    refused(&mut workshop, first.seq, "changed after change");
    workshop
        .undo_change(redo.committed.seq, &Actor::Person)
        .unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, "First edit");
    workshop.undo_change(first.seq, &Actor::Person).unwrap();
    assert_eq!(workshop.block(&id(2)).unwrap().text, "First");
}
