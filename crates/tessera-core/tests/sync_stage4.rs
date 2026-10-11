use parking_lot::Mutex;
use std::sync::{Arc, mpsc};
use tessera_core::sync::*;
use tessera_core::{Actor, Batch, DATABASE_FILE, Notebook, Operation, Result};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn apply(n: &mut Notebook, operations: Vec<Operation>) {
    n.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
}
fn page(n: &mut Notebook, root: u128, title: &str, text: &str) {
    apply(
        n,
        vec![
            Operation::CreatePage {
                id: id(root),
                title: title.into(),
            },
            Operation::Insert {
                id: id(root + 1),
                parent_id: id(root),
                after: None,
                text: text.into(),
                heading: None,
            },
        ],
    );
}
struct Locked(Arc<Mutex<Notebook>>);
impl NotebookAccess for Locked {
    fn with_notebook<T>(&mut self, step: impl FnOnce(&mut Notebook) -> Result<T>) -> Result<T> {
        step(&mut self.0.lock())
    }
}
struct BlockingHub {
    hub: Notebook,
    entered: mpsc::Sender<()>,
    edited: mpsc::Receiver<()>,
}
impl Hub for BlockingHub {
    fn push(&mut self, device: &str, changes: &[PushedChange]) -> Result<Vec<PushReceipt>> {
        self.hub.push(device, changes)
    }
    fn pull(&mut self, device: &str, acknowledged: i64, after: i64) -> Result<Pull> {
        self.entered.send(()).unwrap();
        self.edited
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("editor could not acquire notebook during network pull");
        self.hub.pull(device, acknowledged, after)
    }
    fn missing_snapshots(&mut self, ids: &[String]) -> Result<Vec<String>> {
        self.hub.missing_snapshots(ids)
    }
    fn snapshot_content(&mut self, ids: &[String], from: i64) -> Result<Vec<SnapshotContent>> {
        self.hub.snapshot_content(ids, from)
    }
    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> Result<()> {
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
fn network_pull_releases_notebook_for_edits() {
    let hub_dir = tempfile::tempdir().unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(hub_dir.path()).unwrap();
    page(&mut hub, 1, "Shared", "initial");
    let ticket = hub
        .sync_clone(&replica_dir.path().join(DATABASE_FILE))
        .unwrap()
        .finish()
        .unwrap();
    let mut replica = Notebook::open(replica_dir.path()).unwrap();
    replica.sync_adopt("in-process", &ticket).unwrap();
    apply(
        &mut hub,
        vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "hub pulled".into(),
        }],
    );
    let shared = Arc::new(Mutex::new(replica));
    let local = shared.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (edited_tx, edited_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        sync_with(
            &mut Locked(local),
            &mut BlockingHub {
                hub,
                entered: entered_tx,
                edited: edited_rx,
            },
        )
        .unwrap()
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let mut n = shared.try_lock().expect("network call held notebook lock");
    page(&mut n, 20, "While waiting", "still editable");
    drop(n);
    edited_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap().integrated.applied, 1);
    let n = shared.lock();
    assert_eq!(n.block(&id(21)).unwrap().text, "still editable");
    assert_eq!(n.block(&id(2)).unwrap().text, "hub pulled");
    assert_eq!(n.sync_status().unwrap().unwrap().pending, 1);
}
#[test]
fn independent_import_merges_natural_keys_then_clones_and_keeps_old_database() {
    let hub_dir = tempfile::tempdir().unwrap();
    let phone_dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(hub_dir.path()).unwrap();
    let mut phone = Notebook::open(phone_dir.path()).unwrap();
    for (n, root, text) in [(&mut hub, 1, "Mac"), (&mut phone, 10, "Phone")] {
        page(n, root, "Same title", text);
        apply(
            n,
            vec![
                Operation::CreateJournal {
                    id: id(root + 2),
                    date: "2026-10-11".into(),
                },
                Operation::Insert {
                    id: id(root + 3),
                    parent_id: id(root + 2),
                    after: None,
                    text: text.into(),
                    heading: None,
                },
            ],
        );
    }
    for (n, field) in [(&mut hub, 40), (&mut phone, 50)] {
        let parent_id = n.fields().unwrap().page_id;
        apply(
            n,
            vec![
                Operation::Insert {
                    id: id(field),
                    parent_id,
                    after: None,
                    text: "Author".into(),
                    heading: None,
                },
                Operation::SetFieldKind {
                    id: id(field),
                    base_revision: 1,
                    kind: tessera_core::FieldKind::Text,
                },
            ],
        );
    }
    // Histories predating migration 022 have no global stamps. Import assigns
    // stable IDs from the original notebook identity and local seq.
    rusqlite::Connection::open(phone_dir.path().join(DATABASE_FILE))
        .unwrap()
        .execute(
            "UPDATE changes SET change_id = NULL, origin = NULL WHERE seq = 1",
            [],
        )
        .unwrap();
    let cursor = phone.editor_cursor().unwrap();
    let ticket = hub
        .sync_clone(&hub_dir.path().join("import.db"))
        .unwrap()
        .finish()
        .unwrap();
    let report = sync_import(&mut phone, &mut hub, &ticket.device_id).unwrap();
    assert!(
        report
            .pushed
            .iter()
            .all(|p| matches!(p.outcome, PushOutcome::Accepted { .. }))
    );
    let repeated = sync_import(&mut phone, &mut hub, &ticket.device_id).unwrap();
    assert_eq!(report.pushed, repeated.pushed);
    for root in [1, 3] {
        assert_eq!(hub.page(&id(root)).unwrap().rows.len(), 2);
    }
    assert_eq!(hub.fields().unwrap().fields.len(), 1);
    let clone = phone_dir.path().join("clone.db");
    let ticket = hub.sync_clone(&clone).unwrap().finish().unwrap();
    let previous = phone
        .sync_install_clone(&clone, "in-process", &ticket, "before-pairing", None)
        .unwrap();
    assert!(previous.exists());
    assert_eq!(phone.info().unwrap().id, hub.info().unwrap().id);
    assert!(phone.editor_cursor().unwrap() > cursor);
    assert!(!phone.changes_since(cursor, 100).unwrap().is_empty());
    for root in [1, 3] {
        assert_eq!(hub.page(&id(root)).unwrap(), phone.page(&id(root)).unwrap());
    }
}
#[test]
fn rebase_keeps_editor_cursor_monotonic_and_marks_same_revision_changes() {
    let hub_dir = tempfile::tempdir().unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(hub_dir.path()).unwrap();
    page(&mut hub, 1, "Same revision", "initial");
    let ticket = hub
        .sync_clone(&replica_dir.path().join(DATABASE_FILE))
        .unwrap()
        .finish()
        .unwrap();
    let mut replica = Notebook::open(replica_dir.path()).unwrap();
    replica.sync_adopt("in-process", &ticket).unwrap();
    apply(
        &mut replica,
        vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "phone".into(),
        }],
    );
    let cursor = replica.editor_cursor().unwrap();
    let revision = replica.block(&id(2)).unwrap().revision;
    apply(
        &mut hub,
        vec![Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "mac".into(),
        }],
    );
    replica.sync_with(&mut hub).unwrap();
    assert_eq!(replica.block(&id(2)).unwrap().revision, revision);
    let events = replica.changes_since(cursor, 100).unwrap();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e.seq > cursor));
    assert!(events.iter().any(|e| e.actor
        == Actor::Client {
            name: "sync".into()
        }
        && e.restructured_pages.contains(&id(1))
        && e.blocks.iter().any(|b| b.id == id(2) && b.text == "mac")));
    assert!(
        replica
            .changes_since(events.last().unwrap().seq, 100)
            .unwrap()
            .is_empty()
    );
}
