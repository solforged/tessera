use std::path::Path;

use rusqlite::{Connection, types::Value};
use tessera_core::replication::{Replication, TABLES};
use tessera_core::scheduler::Grade;
use tessera_core::{Actor, Batch, ChangeStamp, Committed, Error, Notebook, Operation, library::*};

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

fn stamp(change: u128, at: i64) -> ChangeStamp {
    ChangeStamp {
        id: id(1_000 + change),
        origin: id(999),
        at,
    }
}

fn document() -> ExtractedDocument {
    let passage = |text: &str, locator: &str| ExtractedPassage {
        kind: PassageKind::Paragraph,
        level: None,
        text: text.into(),
        locator: locator.into(),
        anchor: None,
        resource: None,
        marks: vec![],
    };
    ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".into(),
        metadata: ExtractedMetadata {
            title: Some("Shared Evidence".into()),
            creators: vec![ExtractedCreator {
                name: "García, Ana".into(),
                role: CreatorRole::Author,
            }],
            ..Default::default()
        },
        toc: vec![],
        passages: vec![
            passage("First evidence", "chapter#first"),
            passage("Second evidence", "chapter#second"),
        ],
        resources: vec![],
    }
}

/// Every row of the tables a replica must agree on, without rowids.
fn replicated_state(dir: &Path) -> Vec<(String, Vec<String>)> {
    let conn = Connection::open(dir.join(tessera_core::DATABASE_FILE)).unwrap();
    let mut state = Vec::new();
    for (table, class) in TABLES {
        let virtual_table = table.ends_with("_fts");
        if matches!(class, Replication::Local | Replication::Unlogged)
            || virtual_table
            || *table == "browser_objects"
        {
            continue;
        }
        let mut statement = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let columns: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut rows: Vec<String> = statement
            .query_map([], |row| {
                Ok(columns
                    .iter()
                    .enumerate()
                    // Each device stages content itself here; sync ships the row.
                    .filter(|(_, name)| !(*table == "snapshots" && *name == "created_at"))
                    .filter(|(_, name)| *name != "rowid")
                    .map(|(index, name)| {
                        format!("{name}={:?}", row.get::<_, Value>(index).unwrap())
                    })
                    .collect::<Vec<_>>()
                    .join(", "))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        rows.sort();
        state.push(((*table).to_owned(), rows));
    }
    state
}

/// Two copies of one notebook, as a clone for a second device would be.
fn two_devices() -> (tempfile::TempDir, tempfile::TempDir) {
    let first = tempfile::tempdir().unwrap();
    drop(Notebook::open(first.path()).unwrap());
    let second = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(first.path()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            std::fs::copy(entry.path(), second.path().join(entry.file_name())).unwrap();
        }
    }
    let conn = Connection::open(second.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute("UPDATE replica SET device_id = ?1", [id(2_000)])
        .unwrap();
    (first, second)
}

#[test]
fn every_table_has_a_replication_class() {
    let dir = tempfile::tempdir().unwrap();
    drop(Notebook::open(dir.path()).unwrap());
    let conn = Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let virtual_tables: Vec<&str> = TABLES
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| name.ends_with("_fts"))
        .collect();
    for table in &tables {
        let shadow = virtual_tables
            .iter()
            .any(|parent| table.starts_with(&format!("{parent}_")));
        assert!(
            shadow || TABLES.iter().any(|(name, _)| name == table),
            "table {table} needs a class in replication::TABLES"
        );
    }
    for (name, _) in TABLES {
        // Only the browser build keeps source objects in the database.
        if *name != "browser_objects" {
            assert!(
                tables.contains(&(*name).to_owned()),
                "{name} no longer exists"
            );
        }
    }
}

/// Apply one stamped change to every device; each must commit it the same way.
fn apply_both(
    devices: &mut [Notebook],
    change: u128,
    at: i64,
    operations: Vec<Operation>,
) -> Committed {
    let batch = batch(operations);
    let stamp = stamp(change, at);
    let receipts: Vec<serde_json::Value> = devices
        .iter_mut()
        .map(|device| serde_json::to_value(device.apply_stamped(&batch, &stamp).unwrap()).unwrap())
        .collect();
    assert_eq!(
        receipts[0], receipts[1],
        "change {change} committed differently"
    );
    serde_json::from_value(receipts[0].clone()).unwrap()
}

#[test]
fn two_copies_reach_the_same_state_from_the_same_changes() {
    let (first, second) = two_devices();
    let mut devices = [
        Notebook::open(first.path()).unwrap(),
        Notebook::open(second.path()).unwrap(),
    ];
    // A tag creates a type page, and card text derives a card.
    apply_both(
        &mut devices,
        1,
        10_000,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Reading list".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "Capital of France? >> Paris #geography".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(3),
                parent_id: id(1),
                after: Some(id(2)),
                text: "Delete me, then bring me back".into(),
                heading: None,
            },
        ],
    );
    // The restore names the deletion event the first device created.
    let deleted = apply_both(
        &mut devices,
        2,
        11_000,
        vec![Operation::Delete {
            id: id(3),
            base_revision: 1,
        }],
    );
    apply_both(
        &mut devices,
        3,
        12_000,
        vec![Operation::Restore {
            id: id(3),
            deletion_id: deleted.deletions[0].clone(),
            revision: 2,
        }],
    );
    // A grade with a reset names the card the first device derived and
    // records a reset event alongside the grade.
    let card = devices[0].source_cards(&id(2)).unwrap().remove(0);
    apply_both(
        &mut devices,
        4,
        13_000,
        vec![Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(40),
            session_id: None,
            grade: Grade::Good,
            reset: true,
            shown_front: card.front.clone(),
            shown_back: card.back.clone(),
            reviewed_at: 13_000,
        }],
    );

    // Each device stages the same book; the citation names the first
    // device's snapshot and passages.
    let doc = document();
    let staged: Vec<String> = devices
        .iter_mut()
        .map(|device| {
            let hash = device.put_object(b"shared book bytes").unwrap();
            device.stage_snapshot(&doc, &hash, &[]).unwrap().id
        })
        .collect();
    assert_eq!(staged[0], staged[1]);
    let plan = devices[0]
        .plan_ingest(&staged[0], None, Some("shared.epub"))
        .unwrap();
    let source = plan.source_id.clone();
    apply_both(&mut devices, 5, 14_000, plan.operations);
    let passage = devices[0].passages(&staged[0], 0, 10).unwrap().passages[1].clone();
    apply_both(
        &mut devices,
        6,
        15_000,
        vec![
            Operation::Insert {
                id: id(60),
                parent_id: source,
                after: None,
                text: "Second evidence".into(),
                heading: None,
            },
            Operation::Cite {
                id: id(60),
                base_revision: 1,
                citation_id: id(61),
                snapshot_id: staged[0].clone(),
                start: PassagePoint {
                    passage_id: passage.id.clone(),
                    offset: 0,
                },
                end: PassagePoint {
                    passage_id: passage.id,
                    offset: 15,
                },
                color: None,
            },
        ],
    );

    drop(devices);
    assert_eq!(
        replicated_state(first.path()),
        replicated_state(second.path())
    );
}

#[test]
fn a_change_id_commits_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let create = batch(vec![Operation::CreatePage {
        id: id(1),
        title: "Arrived twice".into(),
    }]);
    let first = notebook.apply_stamped(&create, &stamp(1, 5_000)).unwrap();
    let again = notebook.apply_stamped(&create, &stamp(1, 9_000)).unwrap();
    assert!(again.replayed);
    assert_eq!(again.seq, first.seq);
    assert_eq!(notebook.block(&id(1)).unwrap().created_at, 5_000);

    let different = batch(vec![Operation::CreatePage {
        id: id(2),
        title: "Same change, other operations".into(),
    }]);
    let error = notebook
        .apply_stamped(&different, &stamp(1, 5_000))
        .unwrap_err();
    assert!(matches!(error, Error::Validation { .. }), "{error:?}");
    assert!(notebook.block(&id(2)).is_err());
}

#[test]
fn local_changes_record_this_device_as_origin() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let device = notebook.device_id().unwrap();
    let committed = notebook
        .apply(&batch(vec![Operation::CreatePage {
            id: id(1),
            title: "Written here".into(),
        }]))
        .unwrap();
    drop(notebook);
    let conn = Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    let (change, origin): (String, String) = conn
        .query_row(
            "SELECT change_id, origin FROM changes WHERE seq = ?1",
            [committed.seq],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(origin, device);
    assert!(change.parse::<ulid::Ulid>().is_ok());
    // A reopened notebook keeps its device.
    assert_eq!(
        Notebook::open(dir.path()).unwrap().device_id().unwrap(),
        device
    );
}
