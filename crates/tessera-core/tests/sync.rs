mod common;

use std::path::Path;

use rusqlite::{Connection, types::Value};
use tessera_core::Result;
use tessera_core::replication::{Replication, TABLES};
use tessera_core::sync::{
    Hub, Pull, PushOutcome, PushReceipt, PushedChange, RETIRE_AFTER_MS, SnapshotContent,
    SyncReport, UnloggedPull, UnloggedRows,
};
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
    pair_with(|_| {})
}

/// A hub with a page holding two blocks and whatever `setup` adds, and a
/// replica cloned from it.
fn pair_with(setup: impl FnOnce(&mut Notebook)) -> Pair {
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
    setup(&mut hub);
    let replica_dir = tempfile::tempdir().unwrap();
    let ticket = hub
        .sync_clone(&replica_dir.path().join(DATABASE_FILE))
        .unwrap()
        .finish()
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
        let hub = state(&self.hub.info().unwrap().path);
        let replica = state(&self.replica.info().unwrap().path);
        for ((table, hub_rows), (_, replica_rows)) in hub.iter().zip(&replica) {
            let only_hub: Vec<_> = hub_rows
                .iter()
                .filter(|row| !replica_rows.contains(row))
                .collect();
            let only_replica: Vec<_> = replica_rows
                .iter()
                .filter(|row| !hub_rows.contains(row))
                .collect();
            assert!(
                only_hub.is_empty() && only_replica.is_empty(),
                "{table} differs\nhub only: {only_hub:#?}\nreplica only: {only_replica:#?}"
            );
        }
        assert_eq!(self.replica.sync_status().unwrap().unwrap().pending, 0);
    }
}

/// Every row of the tables replicas must agree on, without rowids, the order
/// rows arrived in, or when each device staged a snapshot.
fn state(dir: &Path) -> Vec<(String, Vec<String>)> {
    let conn = Connection::open(dir.join(DATABASE_FILE)).unwrap();
    let mut state = Vec::new();
    for (table, class) in TABLES {
        if !matches!(
            class,
            Replication::Applied | Replication::Content | Replication::Unlogged
        ) || *table == "browser_objects"
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
                    .filter(|(_, name)| {
                        *name != "rowid"
                            && *name != "sync_seq"
                            && !(*table == "snapshots" && *name == "created_at")
                    })
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
fn field_targets_and_their_inverse_replicate_after_offline_edits() {
    let mut p = pair_with(|hub| {
        let fields = hub.fields().unwrap().page_id;
        apply(
            hub,
            vec![
                insert(50, &fields, None, "Related"),
                Operation::SetFieldKind {
                    id: id(50),
                    base_revision: 1,
                    kind: tessera_core::FieldKind::Instance,
                },
                Operation::CreatePage {
                    id: id(51),
                    title: "Person".into(),
                },
                Operation::CreatePage {
                    id: id(52),
                    title: "Group".into(),
                },
            ],
        );
    });
    apply(
        &mut p.replica,
        vec![Operation::SetFieldTargets {
            id: id(50),
            base_revision: 2,
            targets: vec![id(51), id(52)],
        }],
    );
    let rename = edit(&p.hub, &id(50), "Related person");
    apply(&mut p.hub, vec![rename]);
    assert!(
        p.sync()
            .pushed
            .iter()
            .all(|receipt| matches!(receipt.outcome, PushOutcome::Accepted { .. }))
    );
    p.assert_converged();
    assert_eq!(
        p.hub
            .field_detail(&id(50), None, None)
            .unwrap()
            .field
            .definition
            .targets,
        [id(51), id(52)]
    );
    let revision = p.replica.block(&id(50)).unwrap().revision;
    apply(
        &mut p.replica,
        vec![Operation::SetFieldTargets {
            id: id(50),
            base_revision: revision,
            targets: vec![],
        }],
    );
    p.sync();
    p.assert_converged();
    assert!(
        p.hub
            .field_detail(&id(50), None, None)
            .unwrap()
            .field
            .definition
            .targets
            .is_empty()
    );
}

#[test]
fn field_hide_survives_duplicate_field_merge_and_later_edits() {
    let mut p = pair();
    let fields = p.hub.fields().unwrap().page_id;
    for (notebook, value, hide) in [
        (&mut p.hub, 50, tessera_core::FieldHide::WhenEmpty),
        (&mut p.replica, 51, tessera_core::FieldHide::Always),
    ] {
        apply(
            notebook,
            vec![
                insert(value, &fields, None, "Author"),
                Operation::SetFieldKind {
                    id: id(value),
                    base_revision: 1,
                    kind: tessera_core::FieldKind::Instance,
                },
                Operation::SetFieldHide {
                    id: id(value),
                    base_revision: 2,
                    hide,
                },
            ],
        );
    }
    let report = p.sync();
    assert!(
        report
            .pushed
            .iter()
            .all(|receipt| matches!(receipt.outcome, PushOutcome::Accepted { .. })),
        "{report:?}"
    );
    p.assert_converged();
    let definitions = p.hub.fields().unwrap().fields;
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].definition.id, id(50));
    // Settings in a duplicate creation batch never overwrite the existing definition.
    assert_eq!(
        definitions[0].definition.hide,
        tessera_core::FieldHide::WhenEmpty
    );
    assert_eq!(
        definitions[0].definition.kind,
        tessera_core::FieldKind::Instance
    );
    let base_revision = p.replica.block(&id(50)).unwrap().revision;
    apply(
        &mut p.replica,
        vec![Operation::SetFieldHide {
            id: id(50),
            base_revision,
            hide: tessera_core::FieldHide::Never,
        }],
    );
    assert!(
        p.sync()
            .pushed
            .iter()
            .all(|receipt| matches!(receipt.outcome, PushOutcome::Accepted { .. }))
    );
    p.assert_converged();
    assert_eq!(
        p.hub
            .field_detail(&id(50), None, None)
            .unwrap()
            .field
            .definition
            .hide,
        tessera_core::FieldHide::Never
    );
}

#[test]
fn creator_backfill_on_replica_replicates_as_an_ordinary_change() {
    let mut p = pair_with(|hub| {
        let fields = hub.fields().unwrap().page_id;
        apply(
            hub,
            vec![
                Operation::CreatePage {
                    id: id(51),
                    title: "Book".into(),
                },
                Operation::CreatePage {
                    id: id(52),
                    title: "Unfiled author".into(),
                },
                insert(50, &fields, None, "Author"),
                Operation::SetFieldKind {
                    id: id(50),
                    base_revision: 1,
                    kind: tessera_core::FieldKind::Instance,
                },
                Operation::SetTypeFields {
                    type_id: id(51),
                    base_revision: 1,
                    fields: vec![id(50)],
                },
                insert(53, &id(51), None, &format!("[[{}]]", id(50))),
                insert(54, &id(53), None, &format!("[[{}]]", id(52))),
            ],
        );
    });
    p.sync();
    p.assert_converged();
    assert!(
        p.hub
            .kind_notes("person")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.id == id(52))
    );
}

#[test]
fn criteria_set_offline_rebase_over_a_desktop_edit_of_the_subject() {
    let mut p = pair_with(|hub| {
        let fields = hub.fields().unwrap().page_id;
        apply(hub, vec![insert(50, &fields, None, "Shape")]);
    });
    let page = p.page.clone();
    let subject_revision = p.replica.block(&page).unwrap().revision;
    apply(
        &mut p.replica,
        vec![Operation::SetSubjectCriteria {
            subject_id: page.clone(),
            base_revision: subject_revision,
            fields: vec![id(50)],
        }],
    );
    let rename = edit(&p.hub, &page, "Plans, renamed on the desktop");
    apply(&mut p.hub, vec![rename]);

    let report = p.sync();
    assert_eq!(report.pushed.len(), 1);
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Accepted { .. }
    ));
    p.assert_converged();
    let conn = Connection::open(p.hub.info().unwrap().path.join(DATABASE_FILE)).unwrap();
    let criteria: Vec<String> = conn
        .prepare("SELECT field_id FROM subject_criteria WHERE subject_id = ?1")
        .unwrap()
        .query_map([&page], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(criteria, vec![id(50)]);
    assert_eq!(text(&p.hub, &page), "Plans, renamed on the desktop");
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
fn kept_copy_actions_and_their_inverses_replicate() {
    for choice in ["use", "discard", "both"] {
        let mut p = pair();
        let desktop = edit(&p.hub, &id(2), "Desktop wording");
        apply(&mut p.hub, vec![desktop]);
        let phone = edit(&p.replica, &id(2), "Phone wording");
        apply(&mut p.replica, vec![phone]);
        p.sync();
        let copy = p.hub.sync_conflicts().unwrap()[0].id.clone();
        let origin = p.replica.device_id().unwrap();
        let hub_db = Connection::open(p._hub_dir.path().join(DATABASE_FILE)).unwrap();
        hub_db.execute("INSERT INTO sync_devices(id, name, key_hash, paired_at) VALUES ('paired', 'Phone', 'hash', 1)", []).unwrap();
        hub_db
            .execute(
                "UPDATE sync_replicas SET paired_device = 'paired' WHERE device_id = ?1",
                [&origin],
            )
            .unwrap();
        let marker = p.hub.block(&copy).unwrap().kept_copy.unwrap();
        assert_eq!(marker.of, id(2));
        assert_eq!(marker.origin, origin);
        assert_eq!(marker.origin_name.as_deref(), Some("Phone"));
        assert!(!marker.mine);
        assert!(p.replica.block(&copy).unwrap().kept_copy.unwrap().mine);
        assert_eq!(
            p.hub.page(&p.page).unwrap().rows[1].block.kept_copy,
            Some(marker)
        );

        let mut operations = Vec::new();
        if choice == "use" {
            operations.push(edit(&p.replica, &id(2), "Phone wording"));
        }
        operations.push(if choice == "both" {
            Operation::SettleSyncCopy {
                id: copy.clone(),
                settled: true,
            }
        } else {
            Operation::Delete {
                id: copy.clone(),
                base_revision: p.replica.block(&copy).unwrap().revision,
            }
        });
        let committed = apply(&mut p.replica, operations);
        p.sync();
        p.assert_converged();
        for notebook in [&p.hub, &p.replica] {
            assert_eq!(
                text(notebook, &id(2)),
                if choice == "use" {
                    "Phone wording"
                } else {
                    "Desktop wording"
                }
            );
            if choice == "both" {
                assert!(notebook.block(&copy).unwrap().kept_copy.is_none());
                assert!(
                    notebook.page(&p.page).unwrap().rows[1]
                        .block
                        .kept_copy
                        .is_none()
                );
            } else {
                assert!(notebook.block(&copy).is_err());
            }
        }

        let mut inverse = vec![if choice == "both" {
            Operation::SettleSyncCopy {
                id: copy.clone(),
                settled: false,
            }
        } else {
            Operation::Restore {
                id: copy.clone(),
                deletion_id: committed.deletions[0].clone(),
                revision: committed
                    .revisions
                    .iter()
                    .find(|revision| revision.id == copy)
                    .unwrap()
                    .revision,
            }
        }];
        if choice == "use" {
            inverse.push(edit(&p.replica, &id(2), "Desktop wording"));
        }
        apply(&mut p.replica, inverse);
        p.sync();
        p.assert_converged();
        for notebook in [&p.hub, &p.replica] {
            assert_eq!(text(notebook, &id(2)), "Desktop wording");
            assert_eq!(text(notebook, &copy), "Phone wording");
            assert!(notebook.block(&copy).unwrap().kept_copy.is_some());
        }
        // Keep both leaves the block editable at the acknowledged revision.
        apply(
            &mut p.replica,
            vec![Operation::SettleSyncCopy {
                id: copy.clone(),
                settled: true,
            }],
        );
        let changed = edit(&p.replica, &copy, "An ordinary block");
        apply(&mut p.replica, vec![changed]);
        p.sync();
        p.assert_converged();
        assert_eq!(text(&p.hub, &copy), "An ordinary block");
    }
}

#[test]
fn settling_requires_a_copy_conflict() {
    let mut p = pair();
    for target in [id(2), id(999)] {
        assert!(matches!(
            p.hub.apply(&batch(vec![Operation::SettleSyncCopy {
                id: target,
                settled: true
            }])),
            Err(tessera_core::Error::Validation { .. })
        ));
    }
    let stale = edit(&p.replica, &id(2), "Rejected text");
    let revision = p.hub.block(&id(2)).unwrap().revision;
    apply(
        &mut p.hub,
        vec![Operation::Delete {
            id: id(2),
            base_revision: revision,
        }],
    );
    apply(&mut p.replica, vec![stale]);
    p.sync();
    let rejected = p
        .hub
        .sync_conflicts()
        .unwrap()
        .into_iter()
        .find(|row| row.kind == "rejected")
        .unwrap();
    assert!(matches!(
        p.hub.apply(&batch(vec![Operation::SettleSyncCopy {
            id: rejected.id,
            settled: false
        }])),
        Err(tessera_core::Error::Validation { .. })
    ));
}

#[test]
fn rejected_changes_keep_batch_text_and_page_and_settle_with_an_inverse() {
    let mut p = pair();
    let revision = p.hub.block(&id(3)).unwrap().revision;
    apply(
        &mut p.hub,
        vec![Operation::Delete {
            id: id(3),
            base_revision: revision,
        }],
    );
    let change = edit(&p.replica, &id(3), "Call the bookbinder");
    let revision = p.replica.block(&id(2)).unwrap().revision;
    apply(
        &mut p.replica,
        vec![
            Operation::CreatePage {
                id: id(10),
                title: "Recovery".into(),
            },
            insert(11, &p.page, Some(id(3)), "Call the bookbinder"),
            change,
            Operation::Split {
                id: id(2),
                base_revision: revision,
                new_id: id(12),
                left: "Fi".into(),
                right: "rst".into(),
            },
            insert(13, &p.page, Some(id(11)), "  "),
        ],
    );
    p.sync();
    p.assert_converged();
    let origin = p.replica.device_id().unwrap();
    let rejected = p
        .replica
        .sync_replica_conflicts()
        .unwrap()
        .rejected
        .remove(0);
    assert_eq!(rejected.origin, origin);
    assert!(rejected.mine);
    assert_eq!(rejected.page_id.as_deref(), Some(p.page.as_str()));
    assert_eq!(rejected.page_title.as_deref(), Some("Plans"));
    assert_eq!(
        rejected.texts,
        ["Recovery", "Call the bookbinder", "Fi", "rst"]
    );
    let conflict_id = rejected.id;
    apply(
        &mut p.replica,
        vec![Operation::SettleSyncRejection {
            id: conflict_id.clone(),
            settled: true,
        }],
    );
    assert!(
        p.replica
            .sync_replica_conflicts()
            .unwrap()
            .rejected
            .is_empty()
    );
    p.sync();
    p.assert_converged();
    assert!(p.hub.sync_replica_conflicts().unwrap().rejected.is_empty());
    apply(
        &mut p.replica,
        vec![Operation::SettleSyncRejection {
            id: conflict_id,
            settled: false,
        }],
    );
    p.sync();
    p.assert_converged();
    assert_eq!(p.hub.sync_replica_conflicts().unwrap().rejected.len(), 1);
    let revision = p.hub.block(&p.page).unwrap().revision;
    apply(
        &mut p.hub,
        vec![Operation::Delete {
            id: p.page.clone(),
            base_revision: revision,
        }],
    );
    p.sync();
    let rejected = p
        .replica
        .sync_replica_conflicts()
        .unwrap()
        .rejected
        .remove(0);
    assert!(rejected.page_id.is_none());
    assert!(rejected.page_title.is_none());
    assert_eq!(
        rejected.texts,
        ["Recovery", "Call the bookbinder", "Fi", "rst"]
    );
}

#[test]
fn settling_a_rejection_refuses_other_conflict_kinds_and_unknown_ids() {
    let mut p = pair();
    let desktop = edit(&p.hub, &id(2), "Desktop wording");
    let phone = edit(&p.replica, &id(2), "Phone wording");
    apply(&mut p.hub, vec![desktop]);
    apply(&mut p.replica, vec![phone]);
    p.sync();
    let copy = p
        .replica
        .sync_replica_conflicts()
        .unwrap()
        .kept
        .remove(0)
        .id;
    for target in [id(2), id(999), copy] {
        assert!(matches!(
            p.replica.apply(&batch(vec![Operation::SettleSyncRejection {
                id: target,
                settled: true
            }])),
            Err(tessera_core::Error::Validation { .. })
        ));
    }
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

/// A hub that sends one change per pull, stops answering after a few, and
/// counts the snapshot content requests and uploads it serves.
struct Paged<'hub> {
    hub: &'hub mut Notebook,
    pulls_left: usize,
    pieces: usize,
}

impl Hub for Paged<'_> {
    fn push(&mut self, device: &str, changes: &[PushedChange]) -> Result<Vec<PushReceipt>> {
        self.hub.push(device, changes)
    }
    fn pull(&mut self, device: &str, acknowledged: i64, after: i64) -> Result<Pull> {
        if self.pulls_left == 0 {
            return Err(tessera_core::Error::Io(std::io::Error::other("hub gone")));
        }
        self.pulls_left -= 1;
        self.hub.sync_pull(device, acknowledged, after, 1)
    }
    fn missing_snapshots(&mut self, ids: &[String]) -> Result<Vec<String>> {
        self.hub.missing_snapshots(ids)
    }
    fn snapshot_content(&mut self, ids: &[String], from: i64) -> Result<Vec<SnapshotContent>> {
        self.pieces += 1;
        self.hub.snapshot_content(ids, from)
    }
    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> Result<()> {
        self.pieces += 1;
        self.hub.store_snapshots(content)
    }
    fn missing_objects(&mut self, shas: &[String]) -> Result<Vec<String>> {
        self.hub.missing_objects(shas)
    }
    fn object(&mut self, sha: &str) -> Result<Option<Vec<u8>>> {
        self.hub.object(sha)
    }
    fn store_object(&mut self, sha: &str, bytes: &[u8]) -> Result<()> {
        self.hub.store_object(sha, bytes)
    }
    fn exchange_rows(
        &mut self,
        device: &str,
        rows: &UnloggedRows,
        after: i64,
    ) -> Result<UnloggedPull> {
        self.hub.exchange_rows(device, rows, after)
    }
    fn retire(&mut self, device: &str) -> Result<()> {
        self.hub.retire(device)
    }
}

#[test]
fn an_interrupted_catch_up_keeps_the_pages_it_applied() {
    let mut p = pair();
    let page = p.page.clone();
    let start = p.replica.sync_status().unwrap().unwrap().confirmed_seq;
    apply(&mut p.hub, vec![insert(4, &page, Some(id(3)), "Third")]);
    apply(&mut p.hub, vec![insert(5, &page, Some(id(4)), "Fourth")]);
    apply(&mut p.hub, vec![insert(6, &page, Some(id(5)), "Fifth")]);
    let change = edit(&p.replica, &id(2), "First, from the phone");
    apply(&mut p.replica, vec![change]);

    let mut flaky = Paged {
        hub: &mut p.hub,
        pulls_left: 2,
        pieces: 0,
    };
    assert!(p.replica.sync_with(&mut flaky).is_err());
    // Two pages arrived before the hub went away; they stay applied, and the
    // phone's own edit is still in place on top of them.
    let status = p.replica.sync_status().unwrap().unwrap();
    assert_eq!(status.confirmed_seq, start + 2);
    assert_eq!(
        children(&p.replica, &page),
        ["First, from the phone", "Second", "Third", "Fourth"]
    );

    p.sync();
    p.assert_converged();
    assert_eq!(
        children(&p.replica, &page),
        [
            "First, from the phone",
            "Second",
            "Third",
            "Fourth",
            "Fifth"
        ]
    );
}

#[test]
fn a_replica_silent_for_a_month_is_retired_but_its_changes_still_arrive() {
    let mut p = pair();
    let (snapshot, _, _) = import(&mut p.hub, &book("Desk Book", "urn:desk"), b"epub", &[]);
    p.sync();
    let change = edit(&p.replica, &id(2), "Written before the phone went quiet");
    apply(&mut p.replica, vec![change]);
    p.replica.set_reading_position(&snapshot, 1).unwrap();
    let hub_db = Connection::open(p.hub.info().unwrap().path.join(DATABASE_FILE)).unwrap();
    hub_db
        .execute(
            "UPDATE sync_replicas SET seen_at = seen_at - ?1",
            [RETIRE_AFTER_MS + 1],
        )
        .unwrap();

    // The hub's next change retires the quiet replica and keeps no patches.
    let page = p.page.clone();
    apply(&mut p.hub, vec![insert(4, &page, Some(id(3)), "Desk note")]);
    assert!(p.hub.sync_replicas().unwrap()[0].retired_at.is_some());
    let patches: i64 = hub_db
        .query_row("SELECT COUNT(*) FROM change_patches", [], |row| row.get(0))
        .unwrap();
    assert_eq!(patches, 0);

    let error = p.replica.sync_with(&mut p.hub).unwrap_err().to_string();
    assert!(error.contains("cloned again"), "{error}");
    assert_eq!(text(&p.hub, &id(2)), "Written before the phone went quiet");
    let position: i64 = hub_db
        .query_row(
            "SELECT passage_ordinal FROM reading_positions WHERE snapshot_id = ?1",
            [&snapshot],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(position, 1);
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
            creators: vec![ExtractedCreator::new(
                "Okafor, Ada".into(),
                CreatorRole::Author,
            )],
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

/// A book with an identifier, a cover image and two passages.
fn book(title: &str, unique_id: &str) -> ExtractedDocument {
    let mut document = document();
    document.metadata.title = Some(title.into());
    document.metadata.unique_id = Some(unique_id.into());
    document.metadata.cover = Some("cover.png".into());
    document
}

/// Import a book with its file and images; returns the snapshot, the source
/// and the hashes of the file and of each image.
fn import(
    notebook: &mut Notebook,
    document: &ExtractedDocument,
    file: &[u8],
    images: &[(&str, &[u8])],
) -> (String, String, Vec<String>) {
    let file = notebook.put_object(file).unwrap();
    let mut hashes = vec![file.clone()];
    let mut resources = Vec::new();
    for (href, bytes) in images {
        let sha = notebook.put_object(bytes).unwrap();
        resources.push(((*href).to_owned(), sha.clone(), "image/png".to_owned()));
        hashes.push(sha);
    }
    let snapshot = notebook
        .stage_snapshot(document, &file, &resources)
        .unwrap()
        .id;
    let plan = notebook.plan_ingest(&snapshot, None, None).unwrap();
    let source = plan.source_id.clone();
    apply(notebook, plan.operations);
    (snapshot, source, hashes)
}

/// Field definitions, as (id, name), and the Book type's fields in order.
fn book_fields(notebook: &Notebook) -> (Vec<(String, String)>, Vec<String>) {
    let conn = Connection::open(notebook.info().unwrap().path.join(DATABASE_FILE)).unwrap();
    let definitions = conn
        .prepare(
            "SELECT d.id, d.text FROM blocks d JOIN fields f ON f.block_id = d.id
             WHERE d.deletion_id IS NULL ORDER BY d.id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let book = conn
        .prepare(
            "SELECT t.field_id FROM type_fields t JOIN blocks b ON b.id = t.type_id
             WHERE b.title_key = 'book' AND b.deletion_id IS NULL ORDER BY t.position",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    (definitions, book)
}

#[test]
fn a_first_book_imported_offline_on_both_devices_shares_one_set_of_fields() {
    let mut p = pair();
    import(&mut p.hub, &book("Desk Book", "urn:desk"), b"desk", &[]);
    // The desk drops a field from Book before the phone syncs.
    let (_, mut fields) = book_fields(&p.hub);
    fields.retain(|id| p.hub.block(id).unwrap().text != "Translator");
    let book_page = p.hub.page_by_title("Book").unwrap().unwrap();
    apply(
        &mut p.hub,
        vec![Operation::SetTypeFields {
            type_id: book_page.id.clone(),
            base_revision: book_page.revision,
            fields,
        }],
    );
    let desk = book_fields(&p.hub);
    let (_, phone_source, _) = import(
        &mut p.replica,
        &book("Phone Book", "urn:phone"),
        b"phone",
        &[],
    );

    p.sync();
    p.assert_converged();
    // No second Author, Published and so on, and Book keeps the desk's fields.
    assert_eq!(book_fields(&p.hub), desk);
    let conn = Connection::open(p.hub.info().unwrap().path.join(DATABASE_FILE)).unwrap();
    let author: String = conn
        .query_row(
            "SELECT d.text FROM field_values v JOIN blocks d ON d.id = v.field_id
             WHERE v.owner_id = ?1 AND d.deletion_id IS NULL",
            [&phone_source],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(author, "Author");
}

/// A book with more passage text than one content request carries.
fn long_book(title: &str, unique_id: &str) -> ExtractedDocument {
    let mut document = book(title, unique_id);
    let words = "a long line of book text ".repeat(40);
    document.passages = (0..9000)
        .map(|n| ExtractedPassage {
            kind: PassageKind::Paragraph,
            level: None,
            text: format!("{n} {words}"),
            locator: format!("c#{n}"),
            anchor: None,
            resource: None,
            marks: vec![],
        })
        .collect();
    document
}

#[test]
fn a_book_longer_than_one_request_moves_in_pieces_both_ways() {
    let mut p = pair();
    let (up, _, _) = import(
        &mut p.replica,
        &long_book("Phone Tome", "urn:up"),
        b"up",
        &[],
    );
    let (down, _, _) = import(
        &mut p.hub,
        &long_book("Desk Tome", "urn:down"),
        b"down",
        &[],
    );

    let mut hub = Paged {
        hub: &mut p.hub,
        pulls_left: usize::MAX,
        pieces: 0,
    };
    p.replica.sync_with(&mut hub).unwrap();
    // At least two uploads for one book and two requests for the other.
    assert!(hub.pieces >= 4, "{} pieces", hub.pieces);
    p.assert_converged();
    for snapshot in [&up, &down] {
        assert_eq!(p.hub.passages(snapshot, 8999, 1).unwrap().passages.len(), 1);
        assert_eq!(
            p.replica
                .passages(snapshot, 8999, 1)
                .unwrap()
                .passages
                .len(),
            1
        );
    }
}

/// Quote the second passage of `snapshot` in a new block under `source`.
fn highlight(notebook: &mut Notebook, source: &str, snapshot: &str, block: u128, citation: u128) {
    let passage = notebook.passages(snapshot, 0, 10).unwrap().passages[1].clone();
    apply(
        notebook,
        vec![
            insert(block, source, None, "A line worth keeping"),
            Operation::Cite {
                id: id(block),
                base_revision: 1,
                citation_id: id(citation),
                snapshot_id: snapshot.into(),
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
}

fn has(notebook: &Notebook, sha: &str) -> bool {
    notebook.read_object(sha).is_ok()
}

fn reading_ordinal(notebook: &Notebook, snapshot: &str) -> i64 {
    Connection::open(notebook.info().unwrap().path.join(DATABASE_FILE))
        .unwrap()
        .query_row(
            "SELECT passage_ordinal FROM reading_positions WHERE snapshot_id = ?1",
            [snapshot],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn files_reach_the_hub_and_replicas_keep_covers_and_pinned_books() {
    let mut p = pair();
    let (_, _, phone) = import(
        &mut p.replica,
        &book("Phone Book", "urn:phone"),
        b"phone epub",
        &[("cover.png", b"phone cover"), ("fig.png", b"phone figure")],
    );
    let report = p.sync();
    assert_eq!(report.sent_objects, 3);
    assert!(phone.iter().all(|sha| has(&p.hub, sha)));

    let (_, source, desk) = import(
        &mut p.hub,
        &book("Desk Book", "urn:desk"),
        b"desk epub",
        &[("cover.png", b"desk cover"), ("fig.png", b"desk figure")],
    );
    // A cover uploaded for a record is linked from a field value.
    let uploaded = p.hub.put_object(b"uploaded cover").unwrap();
    let page = p.page.clone();
    apply(
        &mut p.hub,
        vec![insert(
            50,
            &page,
            None,
            &format!("/api/library/covers/{uploaded}"),
        )],
    );
    let report = p.sync();
    assert_eq!(report.received_objects, 2);
    assert!(has(&p.replica, &desk[1]) && has(&p.replica, &uploaded));
    assert!(!has(&p.replica, &desk[0]) && !has(&p.replica, &desk[2]));

    p.replica.sync_pin(&source).unwrap();
    let report = p.sync();
    assert_eq!(report.received_objects, 2);
    assert!(desk.iter().all(|sha| has(&p.replica, sha)));
    assert_eq!(p.replica.sync_pins().unwrap(), [source]);

    // A link to a file the hub never had is reported, not fatal.
    let lost = "0".repeat(64);
    apply(
        &mut p.hub,
        vec![insert(
            51,
            &page,
            None,
            &format!("/api/library/covers/{lost}"),
        )],
    );
    assert_eq!(p.sync().unavailable_objects, [lost]);
    p.assert_converged();
}

#[test]
fn the_later_reading_position_wins_on_both_devices() {
    let mut p = pair();
    let (snapshot, _, _) = import(&mut p.hub, &book("Desk Book", "urn:desk"), b"epub", &[]);
    p.sync();
    p.hub.set_reading_position(&snapshot, 0).unwrap();
    p.replica.set_reading_position(&snapshot, 1).unwrap();

    let report = p.sync();
    assert_eq!(report.sent_rows, 1);
    p.assert_converged();
    assert_eq!(reading_ordinal(&p.hub, &snapshot), 1);

    p.hub.set_reading_position(&snapshot, 0).unwrap();
    let report = p.sync();
    assert_eq!((report.sent_rows, report.received_rows), (0, 1));
    p.assert_converged();
    assert_eq!(reading_ordinal(&p.replica, &snapshot), 0);
}

#[test]
fn a_highlight_muted_on_the_phone_stays_muted_on_the_desk() {
    let mut citation = String::new();
    let mut p = pair_with(|hub| {
        let (snapshot, source, _) = import(hub, &book("Desk Book", "urn:desk"), b"epub", &[]);
        highlight(hub, &source, &snapshot, 60, 61);
        citation = id(61);
        // Highlights resurface from the day after they were made.
        Connection::open(hub.info().unwrap().path.join(DATABASE_FILE))
            .unwrap()
            .execute(
                "UPDATE changes SET created_at = 0 WHERE seq IN (SELECT created_seq FROM citations)",
                [],
            )
            .unwrap();
    });
    let picks = p.replica.resurfacing("2020-01-01", 3).unwrap();
    assert_eq!(picks[0].row.citation.id, citation);
    p.replica
        .record_surfacing(&citation, "2020-01-01", "muted")
        .unwrap();

    let report = p.sync();
    assert_eq!(report.sent_rows, 1);
    p.assert_converged();
    assert!(p.hub.resurfacing("2020-01-01", 3).unwrap().is_empty());
    assert!(p.hub.resurfacing("2020-03-01", 3).unwrap().is_empty());
}

#[test]
fn reading_and_surfacing_a_book_before_it_syncs_does_not_break_sync() {
    let mut p = pair();
    let (snapshot, source, _) = import(
        &mut p.replica,
        &book("Phone Book", "urn:phone"),
        b"epub",
        &[],
    );
    highlight(&mut p.replica, &source, &snapshot, 70, 71);
    p.replica.set_reading_position(&snapshot, 1).unwrap();
    // The phone showed the unsynced highlight and it was muted.
    let device = p.replica.device_id().unwrap();
    Connection::open(p.replica.info().unwrap().path.join(DATABASE_FILE))
        .unwrap()
        .execute(
            "INSERT INTO highlight_surfacings(citation_id, date, shown_at, device, sync_seq)
             VALUES (?1, '2020-01-01', 0, ?2, 1000000)",
            [id(71), device],
        )
        .unwrap();
    p.replica
        .record_surfacing(&id(71), "2020-01-01", "muted")
        .unwrap();
    // Undoing the phone's changes now crosses a change from the desk.
    let desk = edit(&p.hub, &id(2), "Desk, meanwhile");
    apply(&mut p.hub, vec![desk]);

    p.sync();
    p.assert_converged();
    assert_eq!(reading_ordinal(&p.hub, &snapshot), 1);
    assert!(p.hub.resurfacing("2020-03-01", 3).unwrap().is_empty());
}

#[test]
fn the_same_book_imported_offline_on_both_devices_is_one_source() {
    // An earlier book, so the type, its fields and the author exist on both.
    let mut p = pair_with(|hub| {
        import(
            hub,
            &book("Earlier Book", "urn:earlier"),
            b"earlier epub",
            &[],
        );
    });
    let document = book("Shared Book", "urn:shared");
    let (snapshot, desk_source, _) = import(&mut p.hub, &document, b"same epub", &[]);
    let (phone_snapshot, phone_source, _) = import(&mut p.replica, &document, b"same epub", &[]);
    assert_eq!(snapshot, phone_snapshot);
    assert_ne!(desk_source, phone_source);
    highlight(&mut p.replica, &phone_source, &snapshot, 80, 81);
    // Reading the book also changes the phone's source.
    p.replica.set_reading_position(&snapshot, 1).unwrap();

    let report = p.sync();
    assert!(
        report
            .pushed
            .iter()
            .all(|receipt| matches!(receipt.outcome, PushOutcome::Accepted { .. }))
    );
    p.assert_converged();
    assert!(p.replica.sync_conflicts().unwrap().is_empty());
    assert!(p.replica.block(&phone_source).is_err());
    let quote = p.replica.block(&id(80)).unwrap();
    assert_eq!(quote.parent_id.as_deref(), Some(desk_source.as_str()));
}

#[test]
fn type_presentation_replicates_rebases_and_resets() {
    let mut p = pair();
    let page = p.page.clone();
    let revision = p.replica.block(&page).unwrap().revision;
    apply(
        &mut p.replica,
        vec![Operation::SetTypePresentation {
            type_id: page.clone(),
            base_revision: revision,
            plural: Some("Plans for later".into()),
            icon: Some("calendar".into()),
        }],
    );
    let rename = edit(&p.hub, &page, "Plan");
    apply(&mut p.hub, vec![rename]);
    let report = p.sync();
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Accepted { .. }
    ));
    p.assert_converged();
    let info = p.hub.type_info(&page).unwrap();
    assert_eq!(info.plural.as_deref(), Some("Plans for later"));
    assert_eq!(info.icon.as_deref(), Some("calendar"));
    apply(
        &mut p.hub,
        vec![Operation::SetTypePresentation {
            type_id: page.clone(),
            base_revision: info.page.revision,
            plural: None,
            icon: None,
        }],
    );
    p.sync();
    p.assert_converged();
    assert_eq!(p.replica.type_info(&page).unwrap().plural, None);
    assert_eq!(p.replica.type_info(&page).unwrap().icon, None);
}

#[test]
fn undo_grade_rebases_and_preserves_same_timestamp_reset_order_in_patches() {
    let mut p = pair_with(|hub| {
        let first = edit(hub, &id(2), "First >> Answer");
        let second = edit(hub, &id(3), "Second >> Answer");
        apply(
            hub,
            vec![first, second, insert(4, &id(1), None, "Offline >> Answer")],
        );
    });
    let first = p.hub.source_cards(&id(2)).unwrap().remove(0);
    let second = p.hub.source_cards(&id(3)).unwrap().remove(0);
    let offline = p.replica.source_cards(&id(4)).unwrap().remove(0);
    let grade = |card: &tessera_core::CardUnit, event, session_id, reset| Operation::GradeCard {
        id: card.id.clone(),
        base_revision: card.revision,
        definition_revision: card.definition_revision,
        event_id: id(event),
        session_id,
        grade: tessera_core::scheduler::Grade::Good,
        reset,
        shown_front: card.front.clone(),
        shown_back: card.back.clone(),
        reviewed_at: 1000,
    };
    // Offline writers can have identical operation ordinals in distinct batches.
    apply(&mut p.replica, vec![grade(&offline, 700, None, false)]);
    apply(
        &mut p.hub,
        vec![
            Operation::StartReviewSession {
                id: id(50),
                deck_id: None,
                started_at: 1000,
            },
            grade(&first, 900, Some(id(50)), true),
            grade(&second, 100, Some(id(50)), true),
            Operation::FinishReviewSession {
                id: id(50),
                base_revision: 1,
                state: tessera_core::ReviewSessionState::Finished,
                ended_at: 1000,
            },
        ],
    );
    p.sync();
    p.assert_converged();
    let events = p.replica.review_session_events(&id(50)).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.grade.is_some())
            .map(|event| event.id.clone())
            .collect::<Vec<_>>(),
        vec![id(900), id(100)]
    );
    let before = match &events.last().unwrap().before {
        tessera_core::ReviewSchedulingState::Fsrs(state) => state.clone(),
        _ => panic!("new grade uses FSRS"),
    };
    let current = p.replica.card(&second.id).unwrap();
    let request = batch(vec![Operation::UndoGrade {
        id: current.id,
        base_revision: current.revision,
        review_id: id(100),
        event_id: id(800),
        session_revision: Some(2),
        undone_at: 1000,
    }]);
    p.replica.apply(&request).unwrap();
    apply(
        &mut p.hub,
        vec![Operation::CreatePage {
            id: id(5),
            title: "Concurrent change".into(),
        }],
    );
    let report = p.sync();
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Accepted { .. }
    ));
    p.assert_converged();
    for notebook in [&p.hub, &p.replica] {
        assert_eq!(notebook.card(&second.id).unwrap().schedule, before);
        assert_eq!(
            notebook.review_session(&id(50)).unwrap().state,
            tessera_core::ReviewSessionState::Open
        );
        let history = notebook.review_events(&second.id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].kind, tessera_core::ReviewEventKind::Reset);
        assert_eq!(history[1].undone_by, Some(id(800)));
        let effective = notebook.review_session_events(&id(50)).unwrap();
        assert_eq!(
            effective
                .iter()
                .filter(|event| event.grade.is_some())
                .count(),
            1
        );
        assert_eq!(effective.len(), 3);
    }
    let first = p.hub.card(&first.id).unwrap();
    apply(
        &mut p.hub,
        vec![Operation::ResetCard {
            id: first.id.clone(),
            base_revision: first.revision,
            event_id: id(90),
            session_id: Some(id(50)),
            reviewed_at: 1000,
        }],
    );
    p.sync();
    p.assert_converged();
    let current = p.replica.card(&first.id).unwrap();
    assert!(matches!(
        p.replica.apply(&batch(vec![Operation::UndoGrade {
            id: current.id,
            base_revision: current.revision,
            review_id: id(900),
            event_id: id(801),
            session_revision: Some(3),
            undone_at: 1000,
        }])),
        Err(tessera_core::Error::Validation { .. })
    ));
    assert_eq!(
        p.replica.card(&first.id).unwrap().schedule,
        tessera_core::scheduler::new_card(1000)
    );
}

fn downgrade_review_order(conn: &Connection) {
    common::restore_authored_search(conn);
    conn.execute_batch(
        "DROP VIEW effective_review_events;
         DROP TABLE review_undos;
         DROP TABLE quotes;
         DROP INDEX review_events_unordered;
         DROP INDEX review_events_card_order;
         DROP INDEX review_events_session_order;
         ALTER TABLE review_events DROP COLUMN event_order;
         ALTER TABLE fields DROP COLUMN hide;
         PRAGMA user_version = 34;",
    )
    .unwrap();
}

#[test]
fn review_upgrade_recovers_same_batch_order_despite_different_replica_rowids() {
    let mut p = pair_with(|hub| {
        let first = edit(hub, &id(2), "First >> Answer");
        let second = edit(hub, &id(3), "Second >> Answer");
        apply(hub, vec![first, second]);
    });
    let first = p.hub.source_cards(&id(2)).unwrap().remove(0);
    let second = p.hub.source_cards(&id(3)).unwrap().remove(0);
    let grade = |card: &tessera_core::CardUnit, event| Operation::GradeCard {
        id: card.id.clone(),
        base_revision: card.revision,
        definition_revision: card.definition_revision,
        event_id: id(event),
        session_id: Some(id(50)),
        grade: tessera_core::scheduler::Grade::Good,
        reset: true,
        shown_front: card.front.clone(),
        shown_back: card.back.clone(),
        reviewed_at: 1000,
    };
    apply(
        &mut p.hub,
        vec![
            Operation::StartReviewSession {
                id: id(50),
                deck_id: None,
                started_at: 1000,
            },
            grade(&first, 900),
            grade(&second, 100),
            Operation::FinishReviewSession {
                id: id(50),
                base_revision: 1,
                state: tessera_core::ReviewSessionState::Finished,
                ended_at: 1000,
            },
        ],
    );
    p.sync();
    let hub_path = p.hub.info().unwrap().path;
    let replica_path = p.replica.info().unwrap().path;
    for path in [&hub_path, &replica_path] {
        let conn = Connection::open(path.join(DATABASE_FILE)).unwrap();
        downgrade_review_order(&conn);
        if path == &replica_path {
            // TEXT-key changesets may insert rows in any order. Keep every
            // replicated value identical while reversing only local rowids.
            conn.execute("UPDATE review_events SET rowid = -rowid", [])
                .unwrap();
        }
    }
    p.hub = Notebook::open(&hub_path).unwrap();
    p.replica = Notebook::open(&replica_path).unwrap();
    p.assert_converged();
    for notebook in [&p.hub, &p.replica] {
        let events = notebook.review_session_events(&id(50)).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.grade.is_some())
                .map(|event| event.id.clone())
                .collect::<Vec<_>>(),
            vec![id(900), id(100)]
        );
        assert_eq!(events[2].kind, tessera_core::ReviewEventKind::Reset);
        assert_eq!(events[3].id, id(100));
    }
    let current = p.replica.card(&second.id).unwrap();
    apply(
        &mut p.replica,
        vec![Operation::UndoGrade {
            id: current.id,
            base_revision: current.revision,
            review_id: id(100),
            event_id: id(800),
            session_revision: Some(2),
            undone_at: 1000,
        }],
    );
    let report = p.sync();
    assert!(matches!(
        report.pushed[0].outcome,
        PushOutcome::Accepted { .. }
    ));
    p.assert_converged();
    assert_eq!(
        p.hub.card(&second.id).unwrap().schedule,
        tessera_core::scheduler::new_card(1000)
    );
    assert_eq!(
        p.hub.review_session(&id(50)).unwrap().state,
        tessera_core::ReviewSessionState::Open
    );
}

#[test]
fn retained_pre_undo_review_patch_is_ordered_before_it_can_be_undone_after_upgrade() {
    let mut p = pair_with(|hub| {
        let operation = edit(hub, &id(2), "First >> Answer");
        apply(hub, vec![operation]);
        let card = hub.source_cards(&id(2)).unwrap().remove(0);
        apply(
            hub,
            vec![Operation::GradeCard {
                id: card.id,
                base_revision: card.revision,
                definition_revision: card.definition_revision,
                event_id: id(900),
                session_id: None,
                grade: tessera_core::scheduler::Grade::Good,
                reset: false,
                shown_front: card.front,
                shown_back: card.back,
                reviewed_at: 1000,
            }],
        );
    });
    let before = p.hub.source_cards(&id(2)).unwrap().remove(0);
    let newer = apply(
        &mut p.hub,
        vec![Operation::GradeCard {
            id: before.id.clone(),
            base_revision: before.revision,
            definition_revision: before.definition_revision,
            event_id: id(100),
            session_id: None,
            grade: tessera_core::scheduler::Grade::Hard,
            reset: false,
            shown_front: before.front.clone(),
            shown_back: before.back.clone(),
            reviewed_at: 1000,
        }],
    );
    let hub_path = p.hub.info().unwrap().path;
    let replica_path = p.replica.info().unwrap().path;
    let mut old_patch = Vec::new();
    {
        let conn = Connection::open(replica_path.join(DATABASE_FILE)).unwrap();
        downgrade_review_order(&conn);
        conn.execute(
            "ATTACH DATABASE ?1 AS hub",
            [hub_path.join(DATABASE_FILE).to_str().unwrap()],
        )
        .unwrap();
        let mut recording = rusqlite::session::Session::new(&conn).unwrap();
        for table in ["changes", "review_events", "card_units"] {
            recording.attach(Some(table)).unwrap();
        }
        // Record the actual grade's effect before undo support, then roll it
        // back so this replica still knows only the earlier grade at upgrade.
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        conn.execute(
            "INSERT INTO changes SELECT * FROM hub.changes WHERE seq = ?1",
            [newer.seq],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_events
             SELECT id, card_id, session_id, kind, grade, shown_front, shown_back,
                 definition_revision, scheduler_version, before_state, after_state, created_at, change_seq
             FROM hub.review_events WHERE change_seq = ?1",
            [newer.seq],
        ).unwrap();
        conn.execute(
            "UPDATE card_units SET
                schedule = (SELECT schedule FROM hub.card_units WHERE id = card_units.id),
                revision = (SELECT revision FROM hub.card_units WHERE id = card_units.id),
                updated_at = (SELECT updated_at FROM hub.card_units WHERE id = card_units.id)
             WHERE id = ?1",
            [&before.id],
        )
        .unwrap();
        recording.changeset_strm(&mut old_patch).unwrap();
        drop(recording);
        conn.execute_batch("ROLLBACK").unwrap();
    }
    {
        let conn = Connection::open(hub_path.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.execute(
                "UPDATE change_patches SET patch = ?1 WHERE seq = ?2",
                rusqlite::params![old_patch, newer.seq]
            )
            .unwrap(),
            1
        );
        downgrade_review_order(&conn);
    }
    p.hub = Notebook::open(&hub_path).unwrap();
    p.replica = Notebook::open(&replica_path).unwrap();
    p.sync();
    p.assert_converged();
    let current = p.replica.card(&before.id).unwrap();
    let undo = |review, event| Operation::UndoGrade {
        id: current.id.clone(),
        base_revision: current.revision,
        review_id: id(review),
        event_id: id(event),
        session_revision: None,
        undone_at: 1000,
    };
    assert!(matches!(
        p.replica.apply(&batch(vec![undo(900, 800)])),
        Err(tessera_core::Error::Validation { .. })
    ));
    assert_eq!(p.replica.card(&before.id).unwrap(), current);
    apply(&mut p.replica, vec![undo(100, 801)]);
    assert_eq!(
        p.replica.card(&before.id).unwrap().schedule,
        before.schedule
    );
    p.sync();
    p.assert_converged();
    assert_eq!(
        p.hub
            .review_events(&before.id)
            .unwrap()
            .iter()
            .find(|event| event.id == id(100))
            .unwrap()
            .undone_by,
        Some(id(801))
    );
}

#[test]
fn frozen_quote_replays_after_hub_source_deletion_and_rebases_its_revision() {
    let mut p = pair_with(|hub| {
        apply(hub, vec![insert(4, &id(2), None, "Nested source")]);
    });
    let quote = p.replica.quote_snapshot(&id(2), 123).unwrap();
    apply(
        &mut p.replica,
        vec![
            insert(20, &id(1), Some(id(3)), &format!("(({}))", id(2))),
            Operation::SetQuote {
                id: id(20),
                base_revision: 1,
                quote: Some(quote.clone()),
            },
        ],
    );
    apply(
        &mut p.hub,
        vec![Operation::Delete {
            id: id(2),
            base_revision: 1,
        }],
    );
    p.sync();
    p.assert_converged();
    assert_eq!(
        p.hub.capabilities(&id(20)).unwrap().quote,
        Some(quote.clone())
    );
    assert!(!p.hub.quote_status(&id(1)).unwrap()[0].source_live);
    let revision = p.replica.block(&id(20)).unwrap().revision;
    let mut updated = quote.clone();
    updated.captured_at = 456;
    apply(
        &mut p.replica,
        vec![Operation::SetQuote {
            id: id(20),
            base_revision: revision,
            quote: Some(updated.clone()),
        }],
    );
    apply(
        &mut p.hub,
        vec![Operation::SetHeading {
            id: id(20),
            base_revision: revision,
            heading: Some(2),
        }],
    );
    p.sync();
    p.assert_converged();
    assert_eq!(p.hub.capabilities(&id(20)).unwrap().quote, Some(updated));
}
