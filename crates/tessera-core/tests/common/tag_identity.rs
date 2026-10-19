use super::common;

use tessera_core::{Actor, Batch, ChangeStamp, DATABASE_FILE, Notebook, Operation};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn page(n: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(n),
        title: title.into(),
    }
}
fn insert(n: u128, text: &str) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: id(1),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn tag(n: u128, alias: &str) -> String {
    format!("#[[{}|{alias}]]", id(n))
}
fn stamp(n: u128, origin: u128) -> ChangeStamp {
    ChangeStamp {
        id: id(n),
        origin: id(origin),
        at: n as i64,
    }
}

#[test]
fn offline_rename_and_tagging_converge_on_one_page_after_exchanging_batches() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let mut a = Notebook::open(a_dir.path()).unwrap();
    let mut b = Notebook::open(b_dir.path()).unwrap();
    // Book is a protected built-in; Codex exercises the same custom-tag split.
    let seed = batch(vec![
        page(1, "Notes"),
        page(2, "Codex"),
        insert(10, "#Codex"),
    ]);
    a.apply_stamped(&seed, &stamp(100, 1000)).unwrap();
    b.apply_stamped(&seed, &stamp(100, 1000)).unwrap();
    let rename = batch(vec![Operation::EditText {
        id: id(2),
        base_revision: 1,
        text: "Monograph".into(),
    }]);
    let tagging = batch(vec![insert(11, &tag(2, "Codex"))]);
    a.apply_stamped(&rename, &stamp(101, 1000)).unwrap();
    b.apply_stamped(&tagging, &stamp(102, 2000)).unwrap();
    a.apply_stamped(&tagging, &stamp(102, 2000)).unwrap();
    b.apply_stamped(&rename, &stamp(101, 1000)).unwrap();
    for nb in [&mut a, &mut b] {
        assert!(nb.page_by_title("Codex").unwrap().is_none());
        assert_eq!(nb.page_by_title("Monograph").unwrap().unwrap().id, id(2));
        assert_eq!(nb.members(&id(2), 100).unwrap().len(), 2);
        assert_eq!(
            nb.render_tag_text(&nb.block(&id(11)).unwrap().text)
                .unwrap(),
            "#Monograph"
        );
        assert!(nb.check(false).unwrap().ok);
    }
}

#[test]
fn legacy_pipe_titles_and_unrepresentable_live_titles_use_empty_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let text = format!("#[[A|B]] {}", tag(3, "Old"));
    let receipt = nb
        .apply(&batch(vec![
            page(1, "Notes"),
            page(2, "A|B"),
            page(3, "Brackets [here]"),
            insert(10, &text),
        ]))
        .unwrap();
    let canonical = format!("{} {}", tag(2, ""), tag(3, ""));
    assert_eq!(receipt.text_rewrites[0].before, text);
    assert_eq!(receipt.text_rewrites[0].after, canonical);
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert_eq!(
        nb.render_tag_text(&canonical).unwrap(),
        "#A|B #Brackets [here]"
    );
    let receipt = nb.apply(&batch(vec![insert(11, &canonical)])).unwrap();
    assert!(receipt.text_rewrites.is_empty());
    assert!(nb.check(false).unwrap().ok);
}

#[test]
fn migration_051_normalizes_existing_live_tags_without_changes_or_missing_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let receipt = nb
        .apply(&batch(vec![
            page(1, "Notes"),
            page(2, "Codex"),
            page(3, "A|B"),
            insert(10, "placeholder"),
            insert(11, "tahâfut >> incoherence #Codex"),
        ]))
        .unwrap();
    let card = nb.source_cards(&id(11)).unwrap().remove(0);
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    common::restore_title_memberships(&conn);
    conn.execute(
        "UPDATE blocks SET text = ?1 WHERE id = ?2",
        rusqlite::params![
            format!(
                "#CODEX #[[Codex]] #[[A|B]] #Missing [[{}|label]] `#Code`",
                id(2)
            ),
            id(10)
        ],
    )
    .unwrap();
    // A notebook written before 051 holds legacy text in the source and in its card unit.
    conn.execute(
        "UPDATE blocks SET text = 'tahâfut >> incoherence #Codex' WHERE id = ?1",
        [id(11)],
    )
    .unwrap();
    conn.execute(
        "UPDATE card_units SET back = 'incoherence #Codex' WHERE id = ?1",
        [&card.id],
    )
    .unwrap();
    conn.execute("INSERT INTO memberships(block_id, title_key, type_id, manual, title) VALUES (?1, 'codex', ?2, 1, 'Codex'), (?1, 'codex', ?2, 1, 'CODEX')", rusqlite::params![id(10), id(2)]).unwrap();
    conn.execute_batch("ALTER TABLE card_templates DROP COLUMN hint; ALTER TABLE card_templates DROP COLUMN details;").unwrap();
    conn.pragma_update(None, "user_version", 50).unwrap();
    drop(conn);
    let mut nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(tessera_core::SCHEMA_VERSION, 52);
    assert_eq!(
        nb.block(&id(10)).unwrap().text,
        format!(
            "{} {} {} #Missing [[{}|label]] `#Code`",
            tag(2, "CODEX"),
            tag(2, "Codex"),
            tag(3, ""),
            id(2)
        )
    );
    assert_eq!(nb.block(&id(10)).unwrap().revision, 1);
    assert!(nb.changes_since(receipt.seq, 100).unwrap().is_empty());
    assert!(nb.page_by_title("Missing").unwrap().is_none());
    assert!(nb.page_by_title("Code").unwrap().is_none());
    assert_eq!(nb.members(&id(2), 100).unwrap().len(), 2);
    assert!(
        nb.search("CODEX", 100)
            .unwrap()
            .iter()
            .any(|hit| hit.block.id == id(10))
    );
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM memberships WHERE block_id = ?1 AND manual = 1",
            [id(10)],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM links WHERE source_id = ?1",
            [id(10)],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    // The card's source text was rewritten, so its unit keeps its identity with the new back.
    let cards = nb.source_cards(&id(11)).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].id, card.id);
    assert_eq!(cards[0].back, format!("incoherence {}", tag(2, "Codex")));
    let report = nb.check(false).unwrap();
    assert_eq!(
        report
            .invariants
            .iter()
            .find(|rule| rule.name == "tag_tokens_resolve")
            .unwrap()
            .violations,
        1
    );
    // `#Missing` leaves memberships and search for check to resolve; the rewritten card is not stale.
    let cards = report
        .derived
        .iter()
        .find(|table| table.table == "card_units")
        .unwrap();
    assert_eq!((cards.stale, cards.missing), (0, 0), "{:?}", report.derived);
}

#[test]
fn check_reports_legacy_and_wrong_memberships_then_repairs_with_rewrite_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        page(1, "Notes"),
        page(2, "Codex"),
        insert(10, "#Codex"),
    ]))
    .unwrap();
    let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
    conn.execute(
        "UPDATE blocks SET text = '#Codex #Fresh' WHERE id = ?1",
        [id(10)],
    )
    .unwrap();
    conn.execute("DELETE FROM memberships WHERE block_id = ?1", [id(10)])
        .unwrap();
    let before = nb.block(&id(10)).unwrap();
    let report = nb.check(false).unwrap();
    for name in ["tag_tokens_resolve", "memberships_match_tags"] {
        assert_eq!(
            report
                .invariants
                .iter()
                .find(|rule| rule.name == name)
                .unwrap()
                .samples,
            [id(10)]
        );
    }
    assert_eq!(nb.block(&id(10)).unwrap(), before);
    assert!(nb.page_by_title("Fresh").unwrap().is_none());
    let repaired = nb.check(true).unwrap();
    assert!(repaired.repaired.is_some());
    assert!(!repaired.unresolved());
    assert!(nb.check(false).unwrap().ok);
    let fresh = nb.page_by_title("Fresh").unwrap().unwrap();
    assert_eq!(nb.members(&fresh.id, 100).unwrap().len(), 1);
    assert_eq!(nb.members(&id(2), 100).unwrap().len(), 1);
    let receipt: tessera_core::Committed = serde_json::from_str(
        &conn
            .query_row(
                "SELECT committed FROM changes WHERE seq = ?1",
                [repaired.repaired.unwrap()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(receipt.text_rewrites.len(), 1);
    assert_eq!(receipt.text_rewrites[0].before, before.text);
    assert_eq!(
        receipt.text_rewrites[0].after,
        nb.block(&id(10)).unwrap().text
    );
}

#[test]
fn dangling_canonical_tokens_stay_literal_and_never_resolve_by_alias() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let text = format!("{} {}", tag(99, "Codex"), tag(98, ""));
    let receipt = nb
        .apply(&batch(vec![
            page(1, "Notes"),
            page(2, "Codex"),
            insert(10, &text),
        ]))
        .unwrap();
    assert!(receipt.text_rewrites.is_empty());
    assert!(nb.members(&id(2), 100).unwrap().is_empty());
    assert_eq!(
        nb.render_tag_text(&text).unwrap(),
        format!("#Codex #{}", id(98))
    );
    assert!(nb.check(true).unwrap().unresolved());
    assert_eq!(nb.block(&id(10)).unwrap().text, text);
}

#[test]
fn canonical_builtin_identity_drives_capabilities_and_removal_ignores_alias() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        page(1, "Notes"),
        page(2, "Task"),
        page(3, "Custom"),
        insert(10, &tag(2, "Not a task")),
        insert(11, &tag(3, "Task")),
    ]))
    .unwrap();
    assert!(nb.capabilities(&id(10)).unwrap().task.is_some());
    assert!(nb.capabilities(&id(11)).unwrap().task.is_none());
    let current = nb.block(&id(10)).unwrap();
    let receipt = nb
        .apply(&batch(vec![Operation::SetTask {
            id: id(10),
            base_revision: current.revision,
            task: None,
        }]))
        .unwrap();
    assert_eq!(receipt.text_rewrites[0].before, tag(2, "Task"));
    assert_eq!(receipt.text_rewrites[0].after, "");
    assert!(nb.capabilities(&id(10)).unwrap().task.is_none());
    assert!(nb.members(&id(2), 100).unwrap().is_empty());
    assert!(nb.check(false).unwrap().ok);
}
