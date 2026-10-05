use tessera_core::{Actor, Batch, BlockKind, Committed, Notebook, Operation, Revision};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: Some("type regression".into()),
        idempotency_key: None,
        operations,
    })
    .unwrap()
}
fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
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
fn edit(value: u128, revision: i64, text: &str) -> Operation {
    Operation::EditText {
        id: id(value),
        base_revision: revision,
        text: text.into(),
    }
}
fn delete(value: u128, revision: i64) -> Operation {
    Operation::Delete {
        id: id(value),
        base_revision: revision,
    }
}
fn restore(value: u128, revision: i64, deletion: &str) -> Operation {
    Operation::Restore {
        id: id(value),
        revision,
        deletion_id: deletion.into(),
    }
}

#[test]
fn tags_resolve_case_insensitively_create_pages_and_preserve_token_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let committed = apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "BÖÖK"),
            insert(
                10,
                1,
                "# heading word#inside _#inside café#inside #böök #BÖÖK #[[a b]] #中文_2/x-y # #[] #[[]]",
            ),
        ],
    );
    assert!(nb.page_by_title("heading").unwrap().is_none());
    assert!(nb.page_by_title("inside").unwrap().is_none());
    assert_eq!(nb.page_by_title("böök").unwrap().unwrap().id, id(2));
    let multi = nb.page_by_title("A B").unwrap().unwrap();
    let unicode = nb.page_by_title("中文_2/X-Y").unwrap().unwrap();
    for target in [&multi, &unicode] {
        assert_eq!(target.kind, BlockKind::Page);
        assert_eq!(target.parent_id, None);
        assert_eq!(target.page_id, target.id);
        assert!(committed.revisions.contains(&Revision {
            id: target.id.clone(),
            revision: 1
        }));
    }
    assert_eq!(nb.roots().unwrap().len(), 5);
    let members = nb.members(&id(2), 10).unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].block.id, id(10));
    assert_eq!(members[0].page.id, id(1));
    assert!(nb.members(&id(2), 0).unwrap().is_empty());
    assert_eq!(nb.members(&multi.id, 1).unwrap()[0].block.id, id(10));
    let targets = nb.page(&id(1)).unwrap().targets;
    assert_eq!(targets.len(), 3);
    assert!(targets.iter().any(|target| target.id == multi.id));
}

#[test]
fn explicit_type_page_later_in_batch_wins_and_failed_batches_leave_no_generated_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let committed = apply(
        &mut nb,
        vec![page(1, "Notes"), insert(10, 1, "#book"), page(2, "Book")],
    );
    assert_eq!(committed.revisions.len(), 3);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    let failed = nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: vec![edit(10, 1, "#new-type"), edit(10, 1, "stale")],
    });
    assert!(failed.is_err());
    assert!(nb.page_by_title("new-type").unwrap().is_none());
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.text, "#book");
}

#[test]
fn memberships_follow_edits_subtree_deletion_and_same_id_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            page(3, "Film"),
            insert(10, 1, "#book"),
            insert(11, 10, "#book"),
        ],
    );
    apply(&mut nb, vec![edit(10, 1, "#film")]);
    assert_eq!(
        nb.members(&id(2), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(11)]
    );
    assert_eq!(nb.members(&id(3), 10).unwrap()[0].block.id, id(10));
    let deleted = apply(&mut nb, vec![delete(10, 2)]);
    assert!(nb.members(&id(2), 10).unwrap().is_empty());
    assert!(nb.members(&id(3), 10).unwrap().is_empty());
    apply(&mut nb, vec![restore(10, 3, &deleted.deletions[0])]);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(11));
    assert_eq!(nb.members(&id(3), 10).unwrap()[0].block.id, id(10));
    let deleted = apply(&mut nb, vec![delete(2, 1)]);
    assert!(nb.page_by_title("book").unwrap().is_none());
    assert!(nb.members(&id(2), 10).unwrap().is_empty());
    apply(&mut nb, vec![restore(2, 2, &deleted.deletions[0])]);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(11));
}

#[test]
fn change_events_expose_current_blocks_removals_and_apply_time_topology() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "One"),
            page(2, "Two"),
            insert(10, 1, "parent"),
            insert(11, 10, "child"),
        ],
    );
    let edited = apply(&mut nb, vec![edit(10, 1, "edited")]);
    let moved = apply(
        &mut nb,
        vec![Operation::Move {
            id: id(10),
            base_revision: 2,
            parent_id: id(2),
            after: None,
        }],
    );
    let deleted = apply(&mut nb, vec![delete(10, 3)]);
    let changes = nb.changes_since(edited.seq - 1, 10).unwrap();
    assert_eq!(
        changes.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![edited.seq, moved.seq, deleted.seq]
    );
    assert_eq!(changes[0].actor, Actor::Person);
    assert_eq!(changes[0].reason.as_deref(), Some("type regression"));
    assert!(changes[0].created_at > 0);
    assert!(changes[0].blocks.is_empty());
    assert_eq!(changes[0].removed, vec![id(10)]);
    assert!(changes[0].restructured_pages.is_empty());
    assert_eq!(changes[1].restructured_pages, vec![id(1), id(2)]);
    assert_eq!(changes[1].removed, vec![id(10), id(11)]);
    assert_eq!(changes[2].restructured_pages, vec![id(2)]);
    apply(&mut nb, vec![restore(10, 4, &deleted.deletions[0])]);
    let changes = nb.changes_since(edited.seq - 1, 2).unwrap();
    assert_eq!(changes[0].blocks, vec![nb.block(&id(10)).unwrap()]);
    assert!(changes[0].removed.is_empty());
    assert_eq!(
        changes[1].blocks,
        vec![nb.block(&id(10)).unwrap(), nb.block(&id(11)).unwrap()]
    );
    assert_eq!(changes[1].restructured_pages, vec![id(1), id(2)]);
    assert_eq!(changes[0].blocks[0].page_id, id(2));
    assert!(nb.changes_since(0, 0).unwrap().is_empty());
}

#[test]
fn migration_three_backfills_tags_without_rewriting_earlier_schema_or_identity() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(include_str!("../migrations/001_notebook.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../migrations/002_outline.sql"))
        .unwrap();
    conn.execute("INSERT INTO notebook VALUES (1, ?1, 123)", [id(100)])
        .unwrap();
    conn.execute("INSERT INTO blocks(id,kind,page_id,ordinal,text,title_key,revision,created_at,updated_at) VALUES (?1,'page',?1,1024,'Notes','notes',1,123,123)", [id(1)]).unwrap();
    conn.execute("INSERT INTO blocks(id,kind,parent_id,page_id,ordinal,text,revision,created_at,updated_at) VALUES (?1,'block',?2,?2,1024,'#book',1,123,123)", rusqlite::params![id(10),id(1)]).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    drop(conn);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.info().unwrap().id, id(100));
    let book = nb.page_by_title("BOOK").unwrap().unwrap();
    assert_eq!(nb.members(&book.id, 10).unwrap()[0].block.id, id(10));
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
}

#[test]
fn bracketed_tags_with_ulid_titles_do_not_become_block_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Referenced page"),
            insert(10, 1, &format!("#[[{}]]", id(2))),
        ],
    );
    let type_page = nb.page_by_title(&id(2)).unwrap().unwrap();
    assert_ne!(type_page.id, id(2));
    assert_eq!(nb.members(&type_page.id, 10).unwrap()[0].block.id, id(10));
    assert!(nb.backlinks(&id(2), 10).unwrap().is_empty());
    assert_eq!(nb.page(&id(1)).unwrap().targets, vec![type_page]);
    apply(&mut nb, vec![edit(10, 1, &format!("[[{}]]", id(2)))]);
    assert_eq!(nb.backlinks(&id(2), 10).unwrap()[0].source.id, id(10));
}

#[test]
fn renaming_tag_page_keeps_identity_after_a_harmless_source_edit() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "auditfocus"),
            insert(10, 1, "Focus tag #auditfocus"),
        ],
    );
    apply(&mut nb, vec![edit(2, 1, "auditwork")]);
    let source = nb.block(&id(10)).unwrap();
    apply(
        &mut nb,
        vec![edit(10, source.revision, &format!("{}.", source.text))],
    );
    assert_eq!(nb.page_by_title("auditwork").unwrap().unwrap().id, id(2));
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert!(nb.page_by_title("auditfocus").unwrap().is_none());
    assert_eq!(nb.block(&id(10)).unwrap().text, "Focus tag #auditwork.");
}

fn rename_inverse(page_id: &str, original_title: &str, committed: &Committed) -> Vec<Operation> {
    let root = committed
        .revisions
        .iter()
        .find(|revision| revision.id == page_id)
        .unwrap();
    let mut operations = vec![Operation::EditText {
        id: page_id.into(),
        base_revision: root.revision,
        text: original_title.into(),
    }];
    operations.extend(
        committed
            .text_rewrites
            .iter()
            .map(|rewrite| Operation::EditText {
                id: rewrite.id.clone(),
                base_revision: rewrite.revision,
                text: rewrite.before.clone(),
            }),
    );
    operations
}

#[test]
fn rename_rewrites_only_parsed_tokens_and_one_inverse_restores_exact_spellings() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let original = format!(
        "Audit prose auditfocus: #auditfocus #AUDITFOCUS #[[ AuditFocus ]] word#auditfocus _#auditfocus [[auditfocus]] [[{}|auditfocus]] #other",
        id(2)
    );
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "auditfocus"),
            insert(10, 1, &original),
            insert(11, 1, "#AuditFocus"),
        ],
    );
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(11),
            base_revision: 1,
            archived: true,
        }],
    );
    let renamed = apply(&mut nb, vec![edit(2, 1, "Work notes")]);
    let expected = format!(
        "Audit prose auditfocus: #[[Work notes]] #[[Work notes]] #[[Work notes]] word#auditfocus _#auditfocus [[auditfocus]] [[{}|auditfocus]] #other",
        id(2)
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, expected);
    assert_eq!(nb.block(&id(11)).unwrap().text, "#[[Work notes]]");
    assert_eq!(renamed.text_rewrites.len(), 2);
    assert_eq!(renamed.text_rewrites[0].before, original);
    assert_eq!(renamed.text_rewrites[0].after, expected);
    assert_eq!(renamed.text_rewrites[0].revision, 2);
    assert_eq!(
        renamed
            .revisions
            .iter()
            .map(|revision| (revision.id.clone(), revision.revision))
            .collect::<Vec<_>>(),
        vec![(id(2), 2), (id(10), 2), (id(11), 3)]
    );
    assert_eq!(
        nb.members(&id(2), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10)]
    );
    let changes = nb.changes_since(renamed.seq - 1, 1).unwrap();
    assert_eq!(
        changes[0]
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(2), id(10), id(11)]
    );
    assert!(changes[0].restructured_pages.is_empty());
    assert!(changes[0].removed.is_empty());
    assert!(
        nb.search("auditfocus", 10)
            .unwrap()
            .iter()
            .any(|hit| hit.block.id == id(10))
    );
    apply(&mut nb, rename_inverse(&id(2), "auditfocus", &renamed));
    assert_eq!(nb.block(&id(2)).unwrap().text, "auditfocus");
    assert_eq!(nb.block(&id(10)).unwrap().text, original);
    assert_eq!(nb.block(&id(11)).unwrap().text, "#AuditFocus");
    assert!(nb.block(&id(11)).unwrap().archived);
    assert!(nb.page_by_title("Work notes").unwrap().is_none());
}

#[test]
fn rename_case_only_undo_preserves_unchanged_guards_and_original_case_variants() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            insert(10, 1, "#BOOK"),
            insert(11, 1, "#book #[[BoOk]]"),
        ],
    );
    let renamed = apply(&mut nb, vec![edit(2, 1, "BOOK")]);
    assert_eq!(renamed.text_rewrites[0].before, "#BOOK");
    assert_eq!(renamed.text_rewrites[0].after, "#BOOK");
    assert_eq!(renamed.text_rewrites[0].revision, 1);
    assert!(
        !renamed
            .revisions
            .iter()
            .any(|revision| revision.id == id(10))
    );
    assert_eq!(nb.block(&id(11)).unwrap().text, "#BOOK #BOOK");
    apply(&mut nb, rename_inverse(&id(2), "Book", &renamed));
    assert_eq!(nb.block(&id(10)).unwrap().text, "#BOOK");
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    assert_eq!(nb.block(&id(11)).unwrap().text, "#book #[[BoOk]]");
    assert_eq!(nb.members(&id(2), 10).unwrap().len(), 2);
}

#[test]
fn stale_rename_inverse_conflicts_atomically_instead_of_overwriting_a_source_edit() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Notes"), page(2, "Book"), insert(10, 1, "#book")],
    );
    let renamed = apply(&mut nb, vec![edit(2, 1, "Film")]);
    apply(&mut nb, vec![edit(10, 2, "Later source edit #Film")]);
    let result = nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: rename_inverse(&id(2), "Book", &renamed),
    });
    assert!(
        matches!(result, Err(tessera_core::Error::Conflict { id: target, expected: 2, found: Some(3), .. }) if target == id(10))
    );
    assert_eq!(nb.block(&id(2)).unwrap().text, "Film");
    assert_eq!(nb.block(&id(2)).unwrap().revision, 2);
    assert_eq!(nb.block(&id(10)).unwrap().text, "Later source edit #Film");
    assert_eq!(nb.members(&id(2), 10).unwrap().len(), 1);
}

#[test]
fn rename_collision_and_unrepresentable_tag_titles_leave_every_source_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            page(3, "Already exists"),
            insert(10, 1, "#book"),
        ],
    );
    for title in [
        "ALREADY EXISTS",
        "Bad[title",
        "Bad]title",
        "Bad\ntitle",
        "Bad\rtitle",
        " spaces ",
    ] {
        let result = nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![edit(2, 1, title)],
        });
        assert!(
            matches!(
                result,
                Err(tessera_core::Error::Validation {
                    op_index: Some(0),
                    ..
                })
            ),
            "{title:?}"
        );
        assert_eq!(nb.block(&id(2)).unwrap().text, "Book");
        assert_eq!(nb.block(&id(10)).unwrap().text, "#book");
        assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
        assert_eq!(nb.members(&id(2), 10).unwrap().len(), 1);
    }
    // Without incoming tags, ordinary page-title validation is unchanged.
    apply(&mut nb, vec![edit(3, 1, "Ordinary [title]\nwith lines")]);
    assert_eq!(
        nb.block(&id(3)).unwrap().text,
        "Ordinary [title]\nwith lines"
    );
}

#[test]
fn newly_inserted_tags_and_unicode_rename_are_rewritten_in_the_same_batch() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Notes"), page(2, "BÖÖK")]);
    let renamed = apply(
        &mut nb,
        vec![insert(10, 1, "#böök"), edit(2, 1, "中文_2/x-y")],
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "#中文_2/x-y");
    assert_eq!(nb.page_by_title("中文_2/X-Y").unwrap().unwrap().id, id(2));
    assert!(nb.page_by_title("böök").unwrap().is_none());
    assert_eq!(renamed.text_rewrites[0].before, "#böök");
    assert_eq!(renamed.text_rewrites[0].revision, 2);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
}

#[test]
fn retrying_a_rename_replays_original_source_receipts_without_a_second_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Notes"), page(2, "Book"), insert(10, 1, "#book")],
    );
    let request = Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: Some("rename".into()),
        operations: vec![edit(2, 1, "Film")],
    };
    let first = nb.apply(&request).unwrap();
    apply(&mut nb, vec![edit(10, 2, "#Film later")]);
    let replay = nb.apply(&request).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.seq, first.seq);
    assert_eq!(replay.text_rewrites, first.text_rewrites);
    assert_eq!(replay.revisions, first.revisions);
    assert_eq!(nb.block(&id(10)).unwrap().text, "#Film later");
    assert_eq!(nb.block(&id(10)).unwrap().revision, 3);
}

#[test]
fn repeated_renames_in_one_batch_resolve_sources_to_the_final_title_without_intermediate_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Notes"), page(2, "Book"), insert(10, 1, "#BOOK")],
    );
    let renamed = apply(
        &mut nb,
        vec![
            edit(2, 1, "Middle"),
            insert(11, 1, "#middle"),
            edit(2, 2, "Final"),
        ],
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "#Final");
    assert_eq!(nb.block(&id(11)).unwrap().text, "#Final");
    assert_eq!(nb.page_by_title("Final").unwrap().unwrap().id, id(2));
    assert!(nb.page_by_title("Middle").unwrap().is_none());
    assert!(nb.page_by_title("Book").unwrap().is_none());
    assert_eq!(nb.members(&id(2), 10).unwrap().len(), 2);
    assert_eq!(renamed.text_rewrites.len(), 2);
}

#[test]
fn renaming_two_types_in_one_source_emits_one_complete_receipt_and_undo_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            page(3, "Film"),
            insert(10, 1, "#book #[[FILM]]"),
        ],
    );
    let renamed = apply(
        &mut nb,
        vec![edit(2, 1, "Work notes"), edit(3, 1, "Movies")],
    );
    assert_eq!(renamed.text_rewrites.len(), 1);
    assert_eq!(renamed.text_rewrites[0].before, "#book #[[FILM]]");
    assert_eq!(renamed.text_rewrites[0].after, "#[[Work notes]] #Movies");
    let mut inverse = rename_inverse(&id(2), "Book", &renamed);
    inverse.insert(1, edit(3, 2, "Film"));
    apply(&mut nb, inverse);
    assert_eq!(nb.block(&id(10)).unwrap().text, "#book #[[FILM]]");
    assert_eq!(nb.members(&id(2), 10).unwrap().len(), 1);
    assert_eq!(nb.members(&id(3), 10).unwrap().len(), 1);
}

#[test]
fn unchanged_receipt_guard_detects_a_later_source_edit_before_undo() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Notes"), page(2, "Book"), insert(10, 1, "#BOOK")],
    );
    let renamed = apply(&mut nb, vec![edit(2, 1, "BOOK")]);
    apply(&mut nb, vec![edit(10, 1, "#BOOK later")]);
    let result = nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: rename_inverse(&id(2), "Book", &renamed),
    });
    assert!(
        matches!(result, Err(tessera_core::Error::Conflict { id: target, expected: 1, found: Some(2), .. }) if target == id(10))
    );
    assert_eq!(nb.block(&id(2)).unwrap().text, "BOOK");
    assert_eq!(nb.block(&id(10)).unwrap().text, "#BOOK later");
}

#[test]
fn swapping_tag_titles_preserves_each_original_token_target() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "SwapAlpha"),
            page(3, "SwapBeta"),
            insert(10, 1, "#SwapAlpha #SwapBeta"),
        ],
    );
    let swapped = apply(
        &mut nb,
        vec![
            edit(2, 1, "SwapTemp"),
            edit(3, 1, "SwapAlpha"),
            edit(2, 2, "SwapBeta"),
        ],
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "#SwapBeta #SwapAlpha");
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert_eq!(nb.members(&id(3), 10).unwrap()[0].block.id, id(10));
    assert_eq!(swapped.text_rewrites[0].before, "#SwapAlpha #SwapBeta");
    assert_eq!(swapped.text_rewrites[0].after, "#SwapBeta #SwapAlpha");
    assert!(nb.page_by_title("SwapTemp").unwrap().is_none());
}

#[test]
fn restored_tombstone_keeps_its_place_after_live_sibling_rebalancing() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Notes")]);
    for (value, predecessor, text) in [
        (10, None, "L"),
        (11, Some(10), "A"),
        (12, Some(11), "B"),
        (13, Some(12), "C"),
    ] {
        apply(
            &mut nb,
            vec![Operation::Insert {
                id: id(value),
                parent_id: id(1),
                after: predecessor.map(id),
                text: text.into(),
                heading: None,
            }],
        );
    }
    let deleted = apply(&mut nb, vec![delete(12, 1)]);
    for value in 20..33 {
        apply(
            &mut nb,
            vec![Operation::Insert {
                id: id(value),
                parent_id: id(1),
                after: Some(id(10)),
                text: format!("Inserted {value}"),
                heading: None,
            }],
        );
    }
    apply(&mut nb, vec![restore(12, 2, &deleted.deletions[0])]);
    let projected: Vec<_> = nb
        .page(&id(1))
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| [id(10), id(11), id(12), id(13)].contains(&row.block.id))
        .map(|row| row.block.text)
        .collect();
    assert_eq!(projected, vec!["L", "A", "B", "C"]);
    assert_eq!(nb.block(&id(11)).unwrap().revision, 1);
}

#[test]
fn recreated_renamed_and_restored_titles_rebind_untouched_tag_sources() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "LifecycleType"),
            insert(10, 1, "#LifecycleType"),
            insert(11, 1, "#LIFECYCLETYPE"),
        ],
    );
    let old = apply(&mut nb, vec![delete(2, 1)]);
    apply(&mut nb, vec![page(3, "LifecycleType")]);
    assert_eq!(
        nb.members(&id(3), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(11)]
    );
    assert!(nb.members(&id(2), 10).unwrap().is_empty());
    apply(&mut nb, vec![delete(3, 1), page(4, "Other")]);
    apply(&mut nb, vec![edit(4, 1, "LifecycleType")]);
    assert_eq!(nb.members(&id(4), 10).unwrap().len(), 2);
    apply(
        &mut nb,
        vec![delete(4, 2), restore(2, 2, &old.deletions[0])],
    );
    assert_eq!(
        nb.members(&id(2), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(11)]
    );
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    assert_eq!(nb.block(&id(11)).unwrap().revision, 1);
    apply(&mut nb, vec![delete(2, 3)]);
    apply(&mut nb, vec![edit(10, 1, "#LifecycleType updated")]);
    let generated = nb.page_by_title("LifecycleType").unwrap().unwrap();
    assert_eq!(
        nb.members(&generated.id, 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(11)]
    );
    assert_eq!(nb.block(&id(11)).unwrap().revision, 1);
}

#[test]
fn membership_title_upgrade_preserves_unresolved_mentions_without_resurrecting_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "UpgradeType"),
            insert(10, 1, "#UPGRADETYPE"),
        ],
    );
    apply(&mut nb, vec![delete(2, 1)]);
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(
        "DROP TABLE memberships;
         CREATE TABLE memberships (
             block_id TEXT NOT NULL REFERENCES blocks(id),
             type_id TEXT NOT NULL REFERENCES blocks(id),
             PRIMARY KEY(block_id, type_id)
         ) STRICT;
         CREATE INDEX memberships_type ON memberships(type_id, block_id);
         DROP TABLE field_values;
         DROP TABLE type_fields;
         DROP TABLE fields;
         DROP TABLE views;
         DROP TABLE settings;
         DROP TABLE review_events;
         DROP TABLE review_sessions;
         DROP TABLE card_units;
         DROP TABLE decks;
         DROP TABLE task_views;
         DROP TABLE work_sessions;
         DROP TABLE task_occurrences;
         DROP TABLE tasks;
         DROP TABLE projects;
         DROP TABLE citations;
         DROP TABLE reading_positions;
         DROP TABLE source_snapshots;
         DROP TABLE sources;
         DROP TABLE snapshot_resources;
         DROP TABLE passages_fts;
         DROP TABLE passages;
         DROP TABLE snapshots;
         DROP TABLE ingest_jobs;
         ALTER TABLE changes DROP COLUMN views;
         PRAGMA user_version = 4;",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memberships(block_id, type_id) VALUES (?1, ?2)",
        rusqlite::params![id(10), id(2)],
    )
    .unwrap();
    drop(conn);
    let mut nb = Notebook::open(dir.path()).unwrap();
    assert!(nb.page_by_title("UpgradeType").unwrap().is_none());
    assert!(nb.page(&id(1)).unwrap().targets.is_empty());
    apply(&mut nb, vec![page(3, "UpgradeType")]);
    assert_eq!(
        nb.members(&id(3), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10)]
    );
    assert_eq!(nb.page(&id(1)).unwrap().targets[0].id, id(3));
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
}

#[test]
fn deterministic_lifecycle_sequences_match_an_independent_membership_rebuild() {
    struct DeletedType {
        id: String,
        title_key: String,
        revision: i64,
        event: String,
    }
    fn mentions(text: &str, title_key: &str) -> bool {
        // This test generates only whitespace-delimited bare tags. Do not use
        // the production parser or membership index as the expected model.
        text.split_whitespace().any(|word| {
            word.strip_prefix('#')
                .is_some_and(|title| title.to_lowercase() == title_key)
        })
    }
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Alpha"),
            page(3, "Beta"),
            page(4, "Gamma"),
            insert(10, 1, "#Alpha #Beta"),
            insert(11, 1, "#ALPHA"),
            insert(12, 1, "#Gamma"),
        ],
    );
    let names = ["Alpha", "Beta", "Gamma"];
    let mut deleted: Vec<DeletedType> = Vec::new();
    let mut random = 0x4a5b_713c_8dd1_9e03u64;
    for step in 0..128u128 {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let choice = random as usize;
        let roots: Vec<_> = nb
            .roots()
            .unwrap()
            .into_iter()
            .filter(|root| root.id != id(1))
            .collect();
        let vacant: Vec<_> = names
            .iter()
            .filter(|name| {
                !roots
                    .iter()
                    .any(|root| root.text.to_lowercase() == name.to_lowercase())
            })
            .copied()
            .collect();
        match step % 8 {
            1 | 2 if !roots.is_empty() => {
                let target = &roots[choice % roots.len()];
                let result = apply(
                    &mut nb,
                    vec![Operation::Delete {
                        id: target.id.clone(),
                        base_revision: target.revision,
                    }],
                );
                deleted.push(DeletedType {
                    id: target.id.clone(),
                    title_key: target.text.to_lowercase(),
                    revision: target.revision + 1,
                    event: result.deletions[0].clone(),
                });
            }
            3 => {
                let eligible: Vec<_> = deleted
                    .iter()
                    .enumerate()
                    .filter(|(_, ticket)| {
                        roots
                            .iter()
                            .all(|root| root.text.to_lowercase() != ticket.title_key)
                    })
                    .map(|(index, _)| index)
                    .collect();
                if !eligible.is_empty() {
                    let ticket = deleted.swap_remove(eligible[choice % eligible.len()]);
                    apply(
                        &mut nb,
                        vec![Operation::Restore {
                            id: ticket.id,
                            revision: ticket.revision,
                            deletion_id: ticket.event,
                        }],
                    );
                }
            }
            4 if !roots.is_empty() => {
                let target = &roots[choice % roots.len()];
                let title = if vacant.is_empty() {
                    if target.text == target.text.to_uppercase() {
                        target.text.to_lowercase()
                    } else {
                        target.text.to_uppercase()
                    }
                } else {
                    vacant[choice % vacant.len()].to_string()
                };
                apply(
                    &mut nb,
                    vec![Operation::EditText {
                        id: target.id.clone(),
                        base_revision: target.revision,
                        text: title,
                    }],
                );
            }
            5 if !vacant.is_empty() => {
                apply(
                    &mut nb,
                    vec![page(2000 + step, vacant[choice % vacant.len()])],
                );
            }
            _ => {
                let source = 10 + (choice % 3) as u128;
                let text = ["#ALPHA #Beta", "#Gamma #alpha", "#Beta #GAMMA"][choice % 3];
                let revision = nb.block(&id(source)).unwrap().revision;
                apply(
                    &mut nb,
                    vec![edit(source, revision, &format!("{text} sequence{step}"))],
                );
            }
        }
        let roots: Vec<_> = nb
            .roots()
            .unwrap()
            .into_iter()
            .filter(|root| root.id != id(1))
            .collect();
        let sources: Vec<_> = (10..=12)
            .map(|value| nb.block(&id(value)).unwrap())
            .collect();
        for root in &roots {
            let title_key = root.text.to_lowercase();
            let expected: Vec<_> = sources
                .iter()
                .filter(|source| mentions(&source.text, &title_key))
                .map(|source| source.id.clone())
                .collect();
            let actual: Vec<_> = nb
                .members(&root.id, 100)
                .unwrap()
                .into_iter()
                .map(|hit| hit.block.id)
                .collect();
            assert_eq!(
                actual, expected,
                "membership mismatch at step {step}, title {}",
                root.text
            );
        }
        let mut expected_targets: Vec<_> = roots
            .iter()
            .filter(|root| {
                sources
                    .iter()
                    .any(|source| mentions(&source.text, &root.text.to_lowercase()))
            })
            .map(|root| root.id.clone())
            .collect();
        expected_targets.sort_unstable();
        let mut actual_targets: Vec<_> = nb
            .page(&id(1))
            .unwrap()
            .targets
            .into_iter()
            .map(|target| target.id)
            .collect();
        actual_targets.sort_unstable();
        assert_eq!(
            actual_targets, expected_targets,
            "page target mismatch at step {step}"
        );
    }
}

#[test]
fn simultaneous_unicode_renames_resolve_context_sensitive_lowercase_titles() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "ΟΣ"),
            page(3, "ΚΥΚΛΟΣ"),
            insert(10, 1, "#ΟΣ #ΚΥΚΛΟΣ"),
        ],
    );
    apply(&mut nb, vec![edit(2, 1, "ΣΤΟΧΟΣ"), edit(3, 1, "ΑΛΛΟΣ")]);
    assert_eq!(nb.block(&id(10)).unwrap().text, "#ΣΤΟΧΟΣ #ΑΛΛΟΣ");
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert_eq!(nb.members(&id(3), 10).unwrap()[0].block.id, id(10));
    assert!(nb.page_by_title("ΟΣ").unwrap().is_none());
    assert!(nb.page_by_title("ΚΥΚΛΟΣ").unwrap().is_none());
}

fn add_type(value: u128, revision: i64, title: &str) -> Operation {
    Operation::AddType {
        id: id(value),
        base_revision: revision,
        title: title.into(),
    }
}

fn remove_type(value: u128, revision: i64, title: &str) -> Operation {
    Operation::RemoveType {
        id: id(value),
        base_revision: revision,
        title: title.into(),
    }
}

#[test]
fn manual_membership_add_remove_is_revisioned_and_preserves_authored_title() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Notes"), insert(10, 1, "Reading")]);
    let receipt = apply(&mut nb, vec![add_type(10, 1, "BÖÖK shelf")]);
    let target = nb.page_by_title("böök shelf").unwrap().unwrap();
    assert!(receipt.revisions.contains(&Revision {
        id: id(10),
        revision: 2
    }));
    assert!(receipt.revisions.contains(&Revision {
        id: target.id.clone(),
        revision: 1
    }));
    let view = nb.page(&id(1)).unwrap();
    assert_eq!(view.rows[0].manual_types, vec!["BÖÖK shelf"]);
    assert_eq!(view.targets[0].id, target.id);
    assert_eq!(nb.members(&target.id, 10).unwrap()[0].block.id, id(10));
    apply(&mut nb, vec![add_type(10, 2, "böök SHELF")]);
    assert_eq!(
        nb.page(&id(1)).unwrap().rows[0].manual_types,
        vec!["BÖÖK shelf"]
    );
    let receipt = apply(&mut nb, vec![remove_type(10, 3, "böök shelf")]);
    assert_eq!(
        receipt.revisions,
        vec![Revision {
            id: id(10),
            revision: 4
        }]
    );
    assert!(nb.page(&id(1)).unwrap().rows[0].manual_types.is_empty());
    assert!(nb.members(&target.id, 10).unwrap().is_empty());
    assert_eq!(nb.block(&id(10)).unwrap().text, "Reading");
}

#[test]
fn manual_and_text_memberships_count_once_and_either_keeps_the_block() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            insert(10, 1, "#book"),
            add_type(10, 1, "Book"),
        ],
    );
    assert_eq!(
        nb.members(&id(2), 10)
            .unwrap()
            .iter()
            .map(|hit| hit.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10)]
    );
    assert_eq!(nb.type_info(&id(2)).unwrap().members, 1);
    let query = tessera_core::Query {
        r#type: Some(id(2)),
        text: None,
        filters: vec![],
        sort: vec![],
        limit: None,
    };
    assert_eq!(nb.query(&query).unwrap().total, 1);
    apply(&mut nb, vec![edit(10, 2, "No tag")]);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.text, "No tag");
    apply(
        &mut nb,
        vec![edit(10, 3, "#book"), remove_type(10, 4, "Book")],
    );
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.text, "#book");
    assert!(nb.page(&id(1)).unwrap().rows[0].manual_types.is_empty());
}

#[test]
fn removing_text_only_membership_and_stale_manual_writes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Notes"), insert(10, 1, "#Book")]);
    for (operation, conflict) in [
        (remove_type(10, 1, "Book"), false),
        (add_type(10, 0, "Book"), true),
    ] {
        let error = nb
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![operation],
            })
            .unwrap_err();
        assert_eq!(
            matches!(error, tessera_core::Error::Conflict { .. }),
            conflict
        );
        if !conflict {
            assert!(matches!(error, tessera_core::Error::Validation { .. }));
        }
    }
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    assert!(nb.page(&id(1)).unwrap().rows[0].manual_types.is_empty());
    apply(&mut nb, vec![add_type(10, 1, "Book")]);
    assert!(matches!(
        nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![remove_type(10, 1, "Book")]
        }),
        Err(tessera_core::Error::Conflict { .. })
    ));
    assert_eq!(nb.page(&id(1)).unwrap().rows[0].manual_types, vec!["Book"]);
}

#[test]
fn manual_membership_follows_type_rename_without_changing_block_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            page(3, "Film"),
            insert(10, 1, "Reading"),
            add_type(10, 1, "BOOK"),
            add_type(10, 2, "film"),
        ],
    );
    let receipt = apply(&mut nb, vec![edit(2, 1, "Novel"), edit(3, 1, "Book")]);
    assert_eq!(
        nb.page(&id(1)).unwrap().rows[0].manual_types,
        vec!["Book", "Novel"]
    );
    assert_eq!(nb.block(&id(10)).unwrap().text, "Reading");
    assert!(receipt.text_rewrites.is_empty());
    assert!(receipt.revisions.contains(&Revision {
        id: id(10),
        revision: 4
    }));
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert_eq!(nb.members(&id(3), 10).unwrap()[0].block.id, id(10));
    assert!(
        nb.changes_since(receipt.seq - 1, 1).unwrap()[0]
            .restructured_pages
            .contains(&id(1))
    );
    apply(&mut nb, vec![remove_type(10, 4, "Novel")]);
    assert!(nb.members(&id(2), 10).unwrap().is_empty());
}

#[test]
fn manual_membership_survives_subtree_tombstone_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            insert(10, 1, "Parent"),
            insert(11, 10, "Reading"),
            add_type(11, 1, "Book"),
        ],
    );
    let receipt = apply(&mut nb, vec![delete(10, 1)]);
    assert!(nb.members(&id(2), 10).unwrap().is_empty());
    apply(&mut nb, vec![restore(10, 2, &receipt.deletions[0])]);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(11));
    assert_eq!(nb.page(&id(1)).unwrap().rows[1].manual_types, vec!["Book"]);
}

#[test]
fn manual_membership_uses_explicit_later_page_and_validates_tag_titles() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            insert(10, 1, "Reading"),
            add_type(10, 1, "Book"),
            page(2, "BOOK"),
        ],
    );
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    for title in ["", " Book", "Book ", "[Book]", "Book\nshelf"] {
        assert!(matches!(
            nb.apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![add_type(10, 2, title)]
            }),
            Err(tessera_core::Error::Validation { .. })
        ));
    }
    assert_eq!(nb.block(&id(10)).unwrap().revision, 2);
}

#[test]
fn manual_membership_migration_retains_authored_text_tags_and_unresolved_titles() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Notes"),
            page(2, "Book"),
            insert(10, 1, "#BOOK #[[Long Title]]"),
        ],
    );
    apply(&mut nb, vec![delete(2, 1)]);
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(
        "ALTER TABLE memberships RENAME TO modern_memberships;
         DROP INDEX memberships_type;
         DROP INDEX memberships_title;
         CREATE TABLE memberships (block_id TEXT NOT NULL REFERENCES blocks(id), title_key TEXT NOT NULL, type_id TEXT REFERENCES blocks(id), PRIMARY KEY(block_id, title_key)) STRICT;
         INSERT INTO memberships SELECT block_id, title_key, type_id FROM modern_memberships;
         DROP TABLE modern_memberships;
         CREATE INDEX memberships_type ON memberships(type_id, block_id);
         CREATE INDEX memberships_title ON memberships(title_key, block_id);
         DROP TABLE settings;
         DROP TABLE review_events;
         DROP TABLE review_sessions;
         DROP TABLE card_units;
         DROP TABLE decks;
         DROP TABLE task_views;
         DROP TABLE work_sessions;
         DROP TABLE task_occurrences;
         DROP TABLE tasks;
         DROP TABLE projects;
         DROP TABLE citations;
         DROP TABLE reading_positions;
         DROP TABLE source_snapshots;
         DROP TABLE sources;
         DROP TABLE snapshot_resources;
         DROP TABLE passages_fts;
         DROP TABLE passages;
         DROP TABLE snapshots;
         DROP TABLE ingest_jobs;
         PRAGMA user_version = 6;",
    ).unwrap();
    drop(conn);
    let nb = Notebook::open(dir.path()).unwrap();
    assert!(nb.page_by_title("Book").unwrap().is_none());
    assert!(nb.page(&id(1)).unwrap().rows[0].manual_types.is_empty());
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    let titles = conn
        .prepare("SELECT title, manual FROM memberships WHERE block_id = ?1 ORDER BY title_key")
        .unwrap()
        .query_map([id(10)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(titles, vec![("BOOK".into(), 0), ("Long Title".into(), 0)]);
}
