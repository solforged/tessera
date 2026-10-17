use std::path::Path;

use rusqlite::{Connection, types::Value};
use tessera_core::check::ACTOR_NAME;
use tessera_core::replication::applied_tables;
use tessera_core::scheduler::Grade;
use tessera_core::{Actor, Batch, CheckReport, DATABASE_FILE, Error, Notebook, Operation, backup};

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

fn insert(value: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}

/// A notebook with a reference, a tag, a field value, a graded card and a
/// tombstone: one row in every derived table.
fn seeded(dir: &Path) -> Notebook {
    let mut notebook = Notebook::open(dir).unwrap();
    let fields = notebook.fields().unwrap().page_id;
    notebook
        .apply(&batch(vec![
            Operation::CreatePage {
                id: id(1),
                title: "Reading list".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Paris".into(),
            },
            insert(10, &fields, "Year"),
            insert(
                3,
                &id(1),
                &format!("Capital of France? >> [[{}]] #geography", id(2)),
            ),
            insert(4, &id(1), "Deleted later"),
            insert(5, &id(3), &format!("[[{}]]", id(10))),
            insert(6, &id(5), "1970"),
        ]))
        .unwrap();
    let card = notebook.source_cards(&id(3)).unwrap().remove(0);
    notebook
        .apply(&batch(vec![
            Operation::GradeCard {
                id: card.id.clone(),
                base_revision: card.revision,
                definition_revision: card.definition_revision,
                event_id: id(40),
                session_id: None,
                grade: Grade::Good,
                reset: false,
                shown_front: card.front.clone(),
                shown_back: card.back.clone(),
                reviewed_at: 13_000,
            },
            Operation::Delete {
                id: id(4),
                base_revision: 1,
            },
        ]))
        .unwrap();
    notebook
}

fn rows(dir: &Path, sql: &str) -> Vec<Vec<Value>> {
    let conn = Connection::open(dir.join(DATABASE_FILE)).unwrap();
    let mut statement = conn.prepare(sql).unwrap();
    let width = statement.column_count();
    statement
        .query_map([], |row| (0..width).map(|index| row.get(index)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn execute(dir: &Path, sql: &str) {
    Connection::open(dir.join(DATABASE_FILE))
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

/// Everything a repair must leave alone.
fn authored(dir: &Path) -> Vec<Vec<Vec<Value>>> {
    [
        "SELECT * FROM blocks ORDER BY id",
        "SELECT * FROM review_events ORDER BY id",
        "SELECT id, schedule, held FROM card_units ORDER BY id",
        "SELECT * FROM changes ORDER BY seq",
    ]
    .iter()
    .map(|sql| rows(dir, sql))
    .collect()
}

fn differences(report: &CheckReport) -> Vec<(&str, u64, u64)> {
    report
        .derived
        .iter()
        .filter(|table| table.stale + table.missing > 0)
        .map(|table| (table.table.as_str(), table.stale, table.missing))
        .collect()
}

#[test]
fn a_clean_notebook_reports_no_differences_and_repair_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = seeded(dir.path());
    let before = authored(dir.path());
    let report = notebook.check(false).unwrap();
    assert!(report.ok, "{report:#?}");
    assert!(!report.unresolved());
    assert!(report.quick_check.is_empty());
    assert!(report.foreign_keys.is_empty());
    assert!(report.search.is_empty());
    assert_eq!(differences(&report), Vec::<(&str, u64, u64)>::new());
    assert_eq!(
        report
            .derived
            .iter()
            .map(|table| table.table.as_str())
            .collect::<Vec<_>>(),
        [
            "links",
            "memberships",
            "field_values",
            "card_units",
            "search_blocks"
        ]
    );
    assert!(report.invariants.iter().all(|rule| rule.violations == 0));
    assert_eq!(report.invariants.len(), 5);
    assert_eq!(
        report
            .hashes
            .iter()
            .map(|hash| hash.table.as_str())
            .collect::<Vec<_>>(),
        applied_tables().collect::<Vec<_>>()
    );
    let blocks = report
        .hashes
        .iter()
        .find(|hash| hash.table == "blocks")
        .unwrap();
    assert_eq!(
        rows(dir.path(), "SELECT COUNT(*) FROM blocks"),
        [vec![Value::Integer(blocks.rows as i64)]]
    );
    assert_eq!(blocks.sha256.len(), 64);
    assert_eq!(report.repaired, None);

    let repaired = notebook.check(true).unwrap();
    assert_eq!(repaired.repaired, None);
    assert_eq!(repaired.hashes, report.hashes);
    drop(notebook);
    assert_eq!(authored(dir.path()), before);
}

#[test]
fn hand_corrupted_derived_rows_are_reported_then_repaired() {
    let dir = tempfile::tempdir().unwrap();
    drop(seeded(dir.path()));
    let before = authored(dir.path());
    execute(
        dir.path(),
        &format!(
            "DELETE FROM links WHERE source_id = '{block}';
             INSERT INTO links(source_id, occurrence, target_id, alias) VALUES ('{deleted}', 0, '{page}', NULL);
             DELETE FROM memberships WHERE block_id = '{block}';
             DELETE FROM field_values;
             UPDATE card_units SET back = 'wrong' WHERE source_block_id = '{block}';
             UPDATE search_blocks SET text = 'garbage' WHERE block_id = '{block}';",
            block = id(3),
            deleted = id(4),
            page = id(1),
        ),
    );
    let mut notebook = Notebook::open(dir.path()).unwrap();
    assert!(notebook.backlinks(&id(2), 10).unwrap().is_empty());

    let report = notebook.check(false).unwrap();
    assert!(!report.ok);
    assert!(report.unresolved());
    assert_eq!(report.repaired, None);
    assert_eq!(
        differences(&report),
        [
            ("links", 1, 1),
            ("memberships", 0, 1),
            ("field_values", 0, 1),
            ("card_units", 1, 1),
            ("search_blocks", 1, 1),
        ]
    );
    let samples = |table: &str| {
        report
            .derived
            .iter()
            .find(|derived| derived.table == table)
            .unwrap()
            .samples
            .clone()
    };
    assert_eq!(samples("links"), [id(3), id(4)]);
    assert_eq!(samples("memberships"), [id(3)]);
    assert_eq!(samples("field_values"), [id(5)]);
    assert_eq!(samples("search_blocks"), [id(3)]);
    let card = notebook.source_cards(&id(3)).unwrap().remove(0);
    assert_eq!(samples("card_units"), std::slice::from_ref(&card.id));
    assert_eq!(card.back, "wrong");
    // Reporting wrote nothing: the corruption is still there.
    assert!(notebook.backlinks(&id(2), 10).unwrap().is_empty());
    assert_eq!(authored(dir.path()), before);

    let repaired = notebook.check(true).unwrap();
    assert_eq!(differences(&repaired), differences(&report));
    let seq = repaired.repaired.expect("repair wrote a change");
    assert!(!repaired.unresolved());
    let sources: Vec<String> = notebook
        .backlinks(&id(2), 10)
        .unwrap()
        .into_iter()
        .map(|backlink| backlink.source.id)
        .collect();
    assert_eq!(sources, [id(3)]);
    let card_after = notebook.source_cards(&id(3)).unwrap().remove(0);
    assert_eq!(card_after.id, card.id);
    assert_eq!(card_after.back, format!("[[{}]] #geography", id(2)));
    assert_eq!(card_after.revision, card.revision + 1);
    assert_eq!(card_after.schedule, card.schedule);
    assert_eq!(
        notebook
            .search("capital", 10)
            .unwrap()
            .into_iter()
            .map(|hit| hit.block.id)
            .collect::<Vec<_>>(),
        [id(3)]
    );
    assert!(notebook.check(false).unwrap().ok);

    // The repair is one change by the check client, with no operations.
    let change = rows(
        dir.path(),
        &format!(
            "SELECT actor, reason, operations, json_extract(committed, '$.pages'),
                    json_extract(committed, '$.cards[0].id') FROM changes WHERE seq = {seq}"
        ),
    );
    assert_eq!(
        change,
        [vec![
            Value::Text(format!("{{\"kind\":\"client\",\"name\":\"{ACTOR_NAME}\"}}")),
            Value::Text("repair".into()),
            Value::Text("[]".into()),
            Value::Text(format!("[\"{}\"]", id(1))),
            Value::Text(card.id),
        ]]
    );
    let event = notebook.changes_since(0, 100).unwrap().pop().unwrap();
    assert_eq!(
        event.actor,
        Actor::Client {
            name: ACTOR_NAME.into()
        }
    );
    assert_eq!(event.pages, Some(vec![id(1)]));
    drop(notebook);
    // Authored rows and evidence survive; only the change log grew by the repair.
    let after = authored(dir.path());
    assert_eq!(after[..3], before[..3]);
    assert_eq!(after[3].len(), before[3].len() + 1);
    assert_eq!(after[3][..before[3].len()], before[3][..]);
}

#[test]
fn invariant_violations_are_reported_and_left_for_a_person() {
    let dir = tempfile::tempdir().unwrap();
    drop(seeded(dir.path()));
    // A child filed under the wrong page, and a tombstoned parent with a live child.
    execute(
        dir.path(),
        &format!(
            "UPDATE blocks SET page_id = '{paris}' WHERE id = '{value}';
             UPDATE blocks SET deletion_id = (SELECT deletion_id FROM blocks WHERE id = '{deleted}')
             WHERE id = '{entry}';",
            paris = id(2),
            value = id(6),
            deleted = id(4),
            entry = id(5),
        ),
    );
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let report = notebook.check(true).unwrap();
    assert!(!report.ok);
    assert!(report.unresolved());
    let violated: Vec<(&str, u64, &[String])> = report
        .invariants
        .iter()
        .filter(|rule| rule.violations > 0)
        .map(|rule| (rule.name.as_str(), rule.violations, rule.samples.as_slice()))
        .collect();
    assert_eq!(
        violated,
        [
            ("page_id_matches_root", 1, &[id(6)][..]),
            ("no_live_block_under_tombstone", 1, &[id(6)][..]),
        ]
    );
    assert_eq!(
        rows(
            dir.path(),
            &format!("SELECT page_id FROM blocks WHERE id = '{}'", id(6))
        ),
        [vec![Value::Text(id(2))]]
    );
}

#[test]
fn backup_refuses_a_database_that_fails_quick_check() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    drop(seeded(&source));
    let path = source.join(DATABASE_FILE);
    let page_size: usize = Connection::open(&path)
        .unwrap()
        .pragma_query_value(None, "page_size", |row| row.get::<_, i64>(0))
        .unwrap()
        .try_into()
        .unwrap();
    // Overwrite the second page: a b-tree page quick_check reads.
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(bytes.len() > 2 * page_size);
    bytes[page_size..2 * page_size].fill(0xff);
    std::fs::write(&path, bytes).unwrap();
    let error = backup(&source, root.path().join("backup")).unwrap_err();
    let canonical = std::fs::canonicalize(&path).unwrap();
    assert!(
        matches!(&error, Error::Corrupt { path: found, .. } if *found == canonical),
        "{error:?}"
    );
    assert!(error.to_string().contains("quick_check"), "{error}");
    assert!(!root.path().join("backup").join(DATABASE_FILE).exists());
}
