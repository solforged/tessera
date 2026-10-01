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
    assert_eq!(nb.roots().unwrap().len(), 4);
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
    assert_eq!(nb.info().unwrap().schema_version, 3);
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
