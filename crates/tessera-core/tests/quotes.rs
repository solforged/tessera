mod common;

use tessera_core::{Actor, Batch, Committed, Error, Notebook, Operation, QuoteState, QuotedRow};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&batch(operations)).unwrap()
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
fn edit(nb: &mut Notebook, value: u128, text: &str) -> Committed {
    let op = Operation::EditText {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        text: text.into(),
    };
    apply(nb, vec![op])
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Source".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Quotes".into(),
            },
            insert(10, 1, None, "Root"),
            insert(11, 10, None, "First child"),
            insert(12, 11, None, "Grandchild"),
            insert(13, 10, Some(11), "Last child"),
        ],
    );
    (dir, nb)
}
fn set(nb: &Notebook, value: u128, quote: Option<QuoteState>) -> Operation {
    Operation::SetQuote {
        id: id(value),
        base_revision: nb.block(&id(value)).unwrap().revision,
        quote,
    }
}
fn quoted(nb: &mut Notebook) -> QuoteState {
    let quote = nb.quote_snapshot(&id(10), 123).unwrap();
    let receipt = apply(
        nb,
        vec![
            insert(20, 2, None, &format!("(({}))", id(10))),
            Operation::SetQuote {
                id: id(20),
                base_revision: 1,
                quote: Some(quote.clone()),
            },
        ],
    );
    assert_eq!(
        receipt
            .capabilities
            .iter()
            .find(|caps| caps.block_id == id(20))
            .unwrap()
            .quote
            .as_ref(),
        Some(&quote)
    );
    quote
}

#[test]
fn insert_and_set_quote_capture_preorder_in_one_batch() {
    let (_dir, mut nb) = fixture();
    let quote = quoted(&mut nb);
    assert_eq!(quote.captured_at, 123);
    assert_eq!(
        quote
            .rows
            .iter()
            .map(|row| (row.id.clone(), row.depth))
            .collect::<Vec<_>>(),
        vec![(id(10), 0), (id(11), 1), (id(12), 2), (id(13), 1)]
    );
    assert!(!quote.truncated);
    assert!(!nb.quote_status(&id(2)).unwrap()[0].changed);
}

#[test]
fn quote_validation_rejects_mismatch_self_bad_shape_and_caps_atomically() {
    let (_dir, mut nb) = fixture();
    let quote = nb.quote_snapshot(&id(10), 123).unwrap();
    let mut invalid = Vec::new();
    let mut state = quote.clone();
    state.target_id = id(11);
    invalid.push(state);
    let mut state = quote.clone();
    state.rows.clear();
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[0].depth = 1;
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[0].id = id(11);
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].depth = 0;
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].depth = 2;
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].id = id(10);
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].id = "bad".into();
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].heading = Some(4);
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[1].revision = 0;
    invalid.push(state);
    let mut state = quote.clone();
    state.rows[0].text = "é".repeat(32769);
    invalid.push(state);
    let mut state = quote.clone();
    state.rows.extend((100..297).map(|n| QuotedRow {
        id: id(n),
        depth: 1,
        text: String::new(),
        heading: None,
        revision: 1,
    }));
    invalid.push(state);
    for quote in invalid {
        assert!(matches!(
            nb.apply(&batch(vec![
                insert(20, 2, None, &format!("(({}))", id(10))),
                Operation::SetQuote {
                    id: id(20),
                    base_revision: 1,
                    quote: Some(quote)
                }
            ])),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(nb.block(&id(20)), Err(Error::NotFound { .. })));
    }
    apply(&mut nb, vec![insert(20, 2, None, "not a quote")]);
    let operation = set(&nb, 20, Some(quote.clone()));
    assert!(matches!(
        nb.apply(&batch(vec![operation])),
        Err(Error::Validation { .. })
    ));
    edit(&mut nb, 10, &format!("(({}))", id(10)));
    let operation = set(&nb, 10, Some(quote));
    assert!(matches!(
        nb.apply(&batch(vec![operation])),
        Err(Error::Validation { .. })
    ));
}

#[test]
fn quote_capability_is_inert_until_exact_text_returns_and_none_removes_it() {
    let (_dir, mut nb) = fixture();
    let quote = quoted(&mut nb);
    let away = edit(&mut nb, 20, "ordinary text");
    assert!(
        away.capabilities
            .iter()
            .find(|caps| caps.block_id == id(20))
            .unwrap()
            .quote
            .is_none()
    );
    assert!(nb.capabilities(&id(20)).unwrap().quote.is_none());
    assert!(nb.quote_status(&id(2)).unwrap().is_empty());
    edit(&mut nb, 20, &format!("\n\t(({}))\u{2003}", id(10)));
    assert_eq!(nb.capabilities(&id(20)).unwrap().quote, Some(quote.clone()));
    let revision = nb.block(&id(20)).unwrap().revision;
    let op = set(&nb, 20, Some(quote));
    apply(&mut nb, vec![op]);
    assert_eq!(nb.block(&id(20)).unwrap().revision, revision);
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetQuote {
            id: id(20),
            base_revision: 1,
            quote: None
        }])),
        Err(Error::Conflict { .. })
    ));
    let op = set(&nb, 20, None);
    apply(&mut nb, vec![op]);
    assert!(nb.capabilities(&id(20)).unwrap().quote.is_none());
}

#[test]
fn source_edits_additions_and_deletions_never_mutate_frozen_rows() {
    let (_dir, mut nb) = fixture();
    let quote = quoted(&mut nb);
    apply(&mut nb, vec![insert(14, 10, Some(13), "New child")]);
    assert!(nb.quote_status(&id(2)).unwrap()[0].changed);
    let fresh = nb.quote_snapshot(&id(10), 124).unwrap();
    let op = set(&nb, 20, Some(fresh));
    apply(&mut nb, vec![op]);
    assert!(!nb.quote_status(&id(2)).unwrap()[0].changed);
    let op = set(&nb, 20, Some(quote.clone()));
    apply(&mut nb, vec![op]);
    edit(&mut nb, 11, "Edited child");
    let status = nb.quote_status(&id(2)).unwrap().remove(0);
    assert!(status.source_live && status.changed);
    let source = nb.block(&id(10)).unwrap();
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: source.id,
            base_revision: source.revision,
        }],
    );
    let status = nb.quote_status(&id(2)).unwrap().remove(0);
    assert!(!status.source_live && status.changed);
    assert_eq!(
        nb.page(&id(2))
            .unwrap()
            .capabilities
            .iter()
            .find(|caps| caps.block_id == id(20))
            .unwrap()
            .quote
            .as_ref(),
        Some(&quote)
    );
    let op = set(&nb, 20, Some(quote.clone()));
    apply(&mut nb, vec![op]);
    assert_eq!(nb.capabilities(&id(20)).unwrap().quote, Some(quote));
}

#[test]
fn deleted_child_changes_status_while_source_stays_live() {
    let (_dir, mut nb) = fixture();
    quoted(&mut nb);
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(12),
            base_revision: 1,
        }],
    );
    let status = nb.quote_status(&id(2)).unwrap().remove(0);
    assert!(status.source_live && status.changed);
}

#[test]
fn quote_links_are_whole_row_only_and_track_text_edits() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(20, 2, None, &format!(" \t(({}))\n", id(10))),
            insert(
                21,
                2,
                Some(20),
                &format!("inline (({})) remains text", id(10)),
            ),
            insert(22, 2, Some(21), &format!("(({})) (({}))", id(10), id(10))),
            insert(23, 2, Some(22), "((not-an-id))"),
        ],
    );
    assert_eq!(
        nb.backlinks(&id(10), 100)
            .unwrap()
            .iter()
            .map(|b| b.source.id.clone())
            .collect::<Vec<_>>(),
        vec![id(20)]
    );
    edit(&mut nb, 20, "no reference");
    assert!(nb.backlinks(&id(10), 100).unwrap().is_empty());
}

#[test]
fn page_merge_redirects_quote_identity_but_keeps_frozen_text() {
    let (_dir, mut nb) = fixture();
    let quote = nb.quote_snapshot(&id(1), 123).unwrap();
    apply(
        &mut nb,
        vec![
            insert(20, 2, None, &format!(" (({})) ", id(1))),
            Operation::SetQuote {
                id: id(20),
                base_revision: 1,
                quote: Some(quote.clone()),
            },
            insert(21, 2, Some(20), &format!("inline (({}))", id(1))),
        ],
    );
    apply(
        &mut nb,
        vec![Operation::CreatePage {
            id: id(3),
            title: "Destination".into(),
        }],
    );
    let op = Operation::MergePage {
        source_id: id(1),
        source_revision: nb.block(&id(1)).unwrap().revision,
        destination_id: id(3),
        destination_revision: nb.block(&id(3)).unwrap().revision,
    };
    let receipt = apply(&mut nb, vec![op]);
    assert_eq!(nb.block(&id(20)).unwrap().text, format!(" (({})) ", id(3)));
    assert_eq!(
        nb.block(&id(21)).unwrap().text,
        format!("inline (({}))", id(1))
    );
    let current = nb.capabilities(&id(20)).unwrap().quote.unwrap();
    assert_eq!(current.target_id, id(3));
    assert_eq!(current.rows[0].id, id(3));
    assert_eq!(current.rows[0].text, quote.rows[0].text);
    assert_eq!(
        receipt
            .capabilities
            .iter()
            .find(|caps| caps.block_id == id(20))
            .unwrap()
            .quote
            .as_ref(),
        Some(&current)
    );
    assert_eq!(nb.backlinks(&id(3), 100).unwrap().len(), 1);
}

#[test]
fn subtree_limits_preserve_preorder_and_exclude_archived_ancestry() {
    let (_dir, mut nb) = fixture();
    let limited = nb.subtree(&id(10), 2).unwrap();
    assert!(limited.truncated);
    assert_eq!(limited.rows[1].block.id, id(11));
    let empty = nb.subtree(&id(10), 0).unwrap();
    assert!(empty.truncated && empty.rows.is_empty());
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(11),
            base_revision: 1,
            archived: true,
        }],
    );
    assert_eq!(
        nb.subtree(&id(10), 200)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10), id(13)]
    );
    assert!(matches!(
        nb.quote_snapshot(&id(12), 1),
        Err(Error::NotFound { .. })
    ));
    let revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(1),
            base_revision: revision,
            archived: true,
        }],
    );
    assert!(matches!(
        nb.subtree(&id(10), 1),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn snapshot_caps_stop_at_whole_rows_and_reject_an_oversized_root() {
    let (_dir, mut nb) = fixture();
    let ops = (100..301)
        .map(|n| insert(n, 13, (n > 100).then_some(n - 1), "row"))
        .collect();
    apply(&mut nb, ops);
    let quote = nb.quote_snapshot(&id(13), 1).unwrap();
    assert!(quote.truncated);
    assert_eq!(quote.rows.len(), 200);
    edit(&mut nb, 11, &"é".repeat(32766));
    let quote = nb.quote_snapshot(&id(10), 1).unwrap();
    assert!(quote.truncated);
    assert_eq!(quote.rows.len(), 2);
    assert_eq!(
        quote.rows.iter().map(|row| row.text.len()).sum::<usize>(),
        65536
    );
    edit(&mut nb, 10, &"x".repeat(65537));
    assert!(matches!(
        nb.quote_snapshot(&id(10), 1),
        Err(Error::Validation { .. })
    ));
}

#[test]
fn migration_indexes_existing_quote_markers() {
    let (dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![insert(20, 2, None, &format!("\u{2003}(({}))\n", id(10)))],
    );
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    common::restore_authored_search(&conn);
    conn.execute_batch(
        "DROP TABLE quotes; DELETE FROM links; ALTER TABLE fields DROP COLUMN hide; PRAGMA user_version = 35;",
    )
    .unwrap();
    drop(conn);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.backlinks(&id(10), 100).unwrap().len(), 1);
    assert!(matches!(
        nb.quote_status(&id(999)),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(
        nb.quote_snapshot("invalid", 0),
        Err(Error::Validation { .. })
    ));
}
