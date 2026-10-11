use std::path::Path;

use rusqlite::{Connection, types::Value};
use tessera_core::replication::{Replication, TABLES};
use tessera_core::sync::{PushOutcome, SyncReport};
use tessera_core::{Actor, Batch, DATABASE_FILE, Notebook, Operation, library::*};

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

fn apply(notebook: &mut Notebook, operations: Vec<Operation>) -> tessera_core::Committed {
    notebook.apply(&batch(operations)).unwrap()
}

fn insert(id_: u128, parent: &str, after: Option<String>, text: &str) -> Operation {
    Operation::Insert {
        id: id(id_),
        parent_id: parent.to_owned(),
        after,
        text: text.into(),
        heading: None,
    }
}

fn edit(notebook: &Notebook, block: &str, text: &str) -> Operation {
    Operation::EditText {
        id: block.to_owned(),
        base_revision: notebook.block(block).unwrap().revision,
        text: text.into(),
    }
}

fn text(notebook: &Notebook, block: &str) -> String {
    notebook.block(block).unwrap().text
}

fn children(notebook: &Notebook, parent: &str) -> Vec<String> {
    let page = notebook.block(parent).unwrap().page_id;
    notebook
        .page(&page)
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.block.parent_id.as_deref() == Some(parent))
        .map(|row| row.block.text)
        .collect()
}

/// A hub with a page holding two blocks, and a replica cloned from it.
struct Pair {
    _hub_dir: tempfile::TempDir,
    _replica_dir: tempfile::TempDir,
    hub: Notebook,
    replica: Notebook,
    page: String,
}

fn pair() -> Pair {
    let hub_dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(hub_dir.path()).unwrap();
    apply(
        &mut hub,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Plans".into(),
            },
            insert(2, &id(1), None, "First"),
            insert(3, &id(1), Some(id(2)), "Second"),
        ],
    );
    let replica_dir = tempfile::tempdir().unwrap();
    let ticket = hub
        .sync_clone(&replica_dir.path().join(DATABASE_FILE))
        .unwrap();
    let mut replica = Notebook::open(replica_dir.path()).unwrap();
    replica.sync_adopt("in-process", &ticket).unwrap();
    Pair {
        _hub_dir: hub_dir,
        _replica_dir: replica_dir,
        hub,
        replica,
        page: id(1),
    }
}

impl Pair {
    fn sync(&mut self) -> SyncReport {
        self.replica.sync_with(&mut self.hub).unwrap()
    }

    /// Both notebooks hold the same replicated rows.
    fn assert_converged(&self) {
        assert_eq!(
            state(&self.hub.info().unwrap().path),
            state(&self.replica.info().unwrap().path)
        );
        assert_eq!(self.replica.sync_status().unwrap().unwrap().pending, 0);
    }
}

/// Every row of the tables replicas must agree on, without rowids.
fn state(dir: &Path) -> Vec<(String, Vec<String>)> {
    let conn = Connection::open(dir.join(DATABASE_FILE)).unwrap();
    let mut state = Vec::new();
    for (table, class) in TABLES {
        if !matches!(class, Replication::Applied | Replication::Content)
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

#[test]
fn edits_on_both_sides_converge_and_stay_searchable() {
    let mut p = pair();
    let page = p.page.clone();
    let first = edit(&p.hub, &id(2), "First, revised on the desktop");
    apply(
        &mut p.hub,
        vec![first, insert(4, &page, Some(id(3)), "Desktop zebra note")],
    );
    let second = edit(&p.replica, &id(3), "Second, revised on the phone");
    apply(
        &mut p.replica,
        vec![second, insert(5, &page, Some(id(3)), "Phone note")],
    );

    let report = p.sync();
    assert_eq!(report.pushed.len(), 1);
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Accepted { .. }
    ));
    p.assert_converged();
    assert_eq!(text(&p.replica, &id(2)), "First, revised on the desktop");
    assert_eq!(text(&p.hub, &id(3)), "Second, revised on the phone");
    // Pulled rows reach the replica's full-text index through its triggers.
    let hits = p.replica.search("zebra", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block.id, id(4));

    // A block made on the phone can be edited on the desktop and comes back.
    let phone = edit(&p.hub, &id(5), "Phone note, tidied on the desktop");
    apply(&mut p.hub, vec![phone]);
    p.sync();
    p.assert_converged();
    assert_eq!(
        text(&p.replica, &id(5)),
        "Phone note, tidied on the desktop"
    );
}

#[test]
fn text_both_devices_changed_is_kept_beside_the_block_once() {
    let mut p = pair();
    let desktop = edit(&p.hub, &id(2), "Desktop wording");
    apply(&mut p.hub, vec![desktop]);
    // Typing arrives as a run of changes to one block.
    for wording in ["P", "Ph", "Phone wording"] {
        let change = edit(&p.replica, &id(2), wording);
        apply(&mut p.replica, vec![change]);
    }

    p.sync();
    p.assert_converged();
    assert_eq!(text(&p.hub, &id(2)), "Desktop wording");
    assert_eq!(
        children(&p.hub, &p.page),
        ["Desktop wording", "Phone wording", "Second"]
    );
    let conflicts = p.replica.sync_conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].kind, "copy");
    assert_eq!(conflicts[0].block_id.as_deref(), Some(id(2).as_str()));
    assert_eq!(conflicts[0].text.as_deref(), Some("Phone wording"));
}

#[test]
fn a_move_on_one_device_and_an_edit_on_the_other_both_apply() {
    let mut p = pair();
    let base = p.hub.block(&id(2)).unwrap().revision;
    apply(
        &mut p.hub,
        vec![Operation::Move {
            id: id(2),
            base_revision: base,
            parent_id: id(3),
            after: None,
        }],
    );
    let change = edit(&p.replica, &id(2), "Edited while it moved");
    apply(&mut p.replica, vec![change]);

    p.sync();
    p.assert_converged();
    let block = p.replica.block(&id(2)).unwrap();
    assert_eq!(block.parent_id.as_deref(), Some(id(3).as_str()));
    assert_eq!(block.text, "Edited while it moved");
    assert!(p.hub.sync_conflicts().unwrap().is_empty());
}

#[test]
fn the_same_day_and_the_same_title_made_offline_become_one() {
    let mut p = pair();
    apply(
        &mut p.hub,
        vec![
            Operation::CreateJournal {
                id: id(10),
                date: "2026-10-10".into(),
            },
            insert(11, &id(10), None, "Desktop morning"),
            Operation::CreatePage {
                id: id(12),
                title: "Reading".into(),
            },
            insert(13, &id(12), None, "Desktop book"),
        ],
    );
    apply(
        &mut p.replica,
        vec![
            Operation::CreateJournal {
                id: id(20),
                date: "2026-10-10".into(),
            },
            insert(21, &id(20), None, "Phone train ride"),
            Operation::CreatePage {
                id: id(22),
                title: "reading".into(),
            },
            insert(23, &id(22), None, "Phone article"),
        ],
    );
    // A later offline change still names the phone's own day.
    apply(
        &mut p.replica,
        vec![insert(24, &id(20), Some(id(21)), "Phone evening")],
    );

    p.sync();
    p.assert_converged();
    assert!(p.replica.block(&id(20)).is_err());
    assert_eq!(
        children(&p.replica, &id(10)),
        ["Desktop morning", "Phone train ride", "Phone evening"]
    );
    assert_eq!(
        children(&p.replica, &id(12)),
        ["Desktop book", "Phone article"]
    );
}

#[test]
fn a_change_that_cannot_apply_is_kept_as_rejected() {
    let mut p = pair();
    let base = p.hub.block(&id(3)).unwrap().revision;
    apply(
        &mut p.hub,
        vec![Operation::Delete {
            id: id(3),
            base_revision: base,
        }],
    );
    let change = edit(&p.replica, &id(3), "Edited after the desktop deleted it");
    apply(&mut p.replica, vec![change]);

    let report = p.sync();
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Rejected { .. }
    ));
    p.assert_converged();
    assert!(p.replica.block(&id(3)).is_err());
    let conflicts = p.replica.sync_conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].kind, "rejected");
    assert!(
        conflicts[0]
            .batch
            .as_deref()
            .unwrap()
            .contains("Edited after the desktop deleted it")
    );
    // The rejected change is in the log, so pushing it again changes nothing.
    let receipts = p
        .hub
        .sync_push(
            &p.replica.device_id().unwrap(),
            &[tessera_core::sync::PushedChange {
                stamp: tessera_core::ChangeStamp {
                    id: conflicts[0].change_id.clone(),
                    origin: p.replica.device_id().unwrap(),
                    at: 0,
                },
                batch: batch(vec![]),
                bases: Default::default(),
            }],
        )
        .unwrap();
    assert!(matches!(receipts[0].outcome, PushOutcome::Rejected { .. }));
}

#[test]
fn local_changes_made_after_a_push_replay_on_the_hub_state() {
    let mut p = pair();
    let page = p.page.clone();
    apply(
        &mut p.replica,
        vec![insert(30, &page, Some(id(3)), "Pushed")],
    );
    p.sync();
    apply(
        &mut p.replica,
        vec![insert(31, &page, Some(id(30)), "Not pushed yet")],
    );
    let desktop = edit(&p.hub, &id(2), "Desktop, meanwhile");
    apply(&mut p.hub, vec![desktop]);

    let device = p.replica.device_id().unwrap();
    let confirmed = p.replica.sync_status().unwrap().unwrap().confirmed_seq;
    let pull = p.hub.sync_pull(&device, confirmed, confirmed, 100).unwrap();
    let report = p.replica.sync_integrate(&pull.changes).unwrap();
    assert_eq!(report.replayed, 1);
    assert_eq!(text(&p.replica, &id(2)), "Desktop, meanwhile");
    assert_eq!(text(&p.replica, &id(31)), "Not pushed yet");
    assert_eq!(p.replica.sync_status().unwrap().unwrap().pending, 1);

    p.sync();
    p.assert_converged();
    assert_eq!(
        children(&p.hub, &page),
        ["Desktop, meanwhile", "Second", "Pushed", "Not pushed yet"]
    );
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
            title: Some("Pocket Book".into()),
            creators: vec![ExtractedCreator {
                name: "Okafor, Ada".into(),
                role: CreatorRole::Author,
            }],
            ..Default::default()
        },
        toc: vec![],
        passages: vec![
            passage("An opening line", "c#1"),
            passage("A line worth keeping", "c#2"),
        ],
        resources: vec![],
    }
}

#[test]
fn a_book_added_on_the_phone_reaches_the_hub_and_highlights_come_back() {
    let mut p = pair();
    let hash = p.replica.put_object(b"pocket book bytes").unwrap();
    let snapshot = p
        .replica
        .stage_snapshot(&document(), &hash, &[])
        .unwrap()
        .id;
    let plan = p
        .replica
        .plan_ingest(&snapshot, None, Some("pocket.epub"))
        .unwrap();
    let source = plan.source_id.clone();
    apply(&mut p.replica, plan.operations);

    let report = p.sync();
    assert_eq!(report.sent_snapshots, 1);
    p.assert_converged();
    let passage = p.hub.passages(&snapshot, 0, 10).unwrap().passages[1].clone();
    assert_eq!(passage.text, "A line worth keeping");

    apply(
        &mut p.hub,
        vec![
            insert(40, &source, None, "A line worth keeping"),
            Operation::Cite {
                id: id(40),
                base_revision: 1,
                citation_id: id(41),
                snapshot_id: snapshot.clone(),
                start: PassagePoint {
                    passage_id: passage.id.clone(),
                    offset: 0,
                },
                end: PassagePoint {
                    passage_id: passage.id,
                    offset: 20,
                },
                color: None,
            },
        ],
    );
    p.sync();
    p.assert_converged();
    assert_eq!(
        p.replica.block(&id(40)).unwrap().text,
        "A line worth keeping"
    );
}

#[test]
fn a_book_added_on_the_hub_arrives_with_its_text() {
    let mut p = pair();
    let hash = p.hub.put_object(b"desk book bytes").unwrap();
    let snapshot = p.hub.stage_snapshot(&document(), &hash, &[]).unwrap().id;
    let plan = p
        .hub
        .plan_ingest(&snapshot, None, Some("desk.epub"))
        .unwrap();
    apply(&mut p.hub, plan.operations);

    let report = p.sync();
    assert_eq!(report.received_snapshots, 1);
    p.assert_converged();
    let page = p.replica.passages(&snapshot, 0, 10).unwrap();
    assert_eq!(page.passages[0].text, "An opening line");
}
