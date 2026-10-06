use std::path::Path;

use tessera_core::{Actor, Batch, Notebook, NotebookOwnership, Operation, backup, restore};

const PAGE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BLOCK: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

fn seed(path: &Path) -> (Notebook, String) {
    let mut notebook = Notebook::open(path).unwrap();
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![
                Operation::CreatePage {
                    id: PAGE.into(),
                    title: "Backup test".into(),
                },
                Operation::Insert {
                    id: BLOCK.into(),
                    parent_id: PAGE.into(),
                    after: None,
                    text: "Retained block".into(),
                    heading: None,
                },
            ],
        })
        .unwrap();
    let sha = notebook.put_object(b"immutable source bytes").unwrap();
    (notebook, sha)
}

fn assert_copy(original: &Notebook, path: &Path, sha: &str) {
    let copy = Notebook::open(path).unwrap();
    assert_eq!(copy.info().unwrap().id, original.info().unwrap().id);
    assert_eq!(
        copy.page(PAGE).unwrap().rows.len(),
        original.page(PAGE).unwrap().rows.len()
    );
    assert_eq!(copy.block(BLOCK).unwrap().text, "Retained block");
    assert_eq!(copy.read_object(sha).unwrap(), b"immutable source bytes");
}

#[test]
fn backup_online_preserves_identity_blocks_and_objects() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    let _service = NotebookOwnership::acquire(&source, 4397).unwrap();
    assert!(source.join("notebook.db-wal").exists());
    let dest = root.path().join("backup");
    let manifest = backup(&source, &dest).unwrap();
    assert_eq!(manifest.notebook_id, notebook.info().unwrap().id);
    assert_eq!(
        manifest.schema_version,
        notebook.info().unwrap().schema_version
    );
    assert_eq!(manifest.object_count, 1);
    assert!(manifest.db_page_count > 0);
    assert!(manifest.created_at >= notebook.info().unwrap().created_at);
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(json["object_count"], 1);
    assert_eq!(json["notebook_id"], manifest.notebook_id);
    assert!(!dest.join("notebook.db-wal").exists());
    assert_copy(&notebook, &dest, &sha);
}

#[test]
fn restore_round_trip_preserves_notebook() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    let saved = root.path().join("backup");
    backup(&source, &saved).unwrap();
    let restored = root.path().join("restored");
    assert_eq!(
        restore(&saved, &restored, false).unwrap().id,
        notebook.info().unwrap().id
    );
    assert_copy(&notebook, &restored, &sha);
}

#[test]
fn restore_refuses_nonempty_destination_without_force() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    let destination = root.path().join("destination");
    let old_id = Notebook::open(&destination).unwrap().info().unwrap().id;
    let error = restore(&source, &destination, false).unwrap_err();
    assert!(error.to_string().contains("not empty"));
    assert_eq!(
        Notebook::open(&destination).unwrap().info().unwrap().id,
        old_id
    );
    restore(&source, &destination, true).unwrap();
    assert_copy(&notebook, &destination, &sha);
}

#[test]
fn restore_refuses_live_service_even_with_force() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    seed(&source);
    let destination = root.path().join("destination");
    let old_id = Notebook::open(&destination).unwrap().info().unwrap().id;
    let service = NotebookOwnership::acquire(&destination, 4397).unwrap();
    let error = restore(&source, &destination, true).unwrap_err();
    assert!(error.to_string().contains("already served"));
    assert_eq!(
        Notebook::open(&destination).unwrap().info().unwrap().id,
        old_id
    );
    drop(service);
    restore(&source, &destination, true).unwrap();
}

#[test]
fn backup_and_restore_refuse_overlapping_directories() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    seed(&source);
    assert!(backup(&source, &source).is_err());
    assert!(restore(&source, &source, true).is_err());
    assert!(backup(&source, source.join("nested")).is_err());
    assert!(restore(&source, root.path(), true).is_err());
}

#[test]
fn backup_refuses_existing_notebook_without_changing_it() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    seed(&source);
    let destination = root.path().join("destination");
    let id = Notebook::open(&destination).unwrap().info().unwrap().id;
    assert!(backup(&source, &destination).is_err());
    assert_eq!(Notebook::open(&destination).unwrap().info().unwrap().id, id);
}
