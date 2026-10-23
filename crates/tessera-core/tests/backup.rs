use std::path::Path;

use tessera_core::{
    Actor, Batch, Notebook, NotebookOwnership, Operation, backup, restore, restore_with,
};

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
fn restore_with_replaces_the_database_under_the_held_service_lock() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    let saved = root.path().join("backup");
    backup(&source, &saved).unwrap();
    let destination = root.path().join("destination");
    let old_id = Notebook::open(&destination).unwrap().info().unwrap().id;
    let ownership = NotebookOwnership::acquire(&destination, 4397).unwrap();
    let lock = destination.join("service.lock");
    let contents = std::fs::read(&lock).unwrap();
    std::fs::write(destination.join("restore.pending"), b"pending").unwrap();

    let restored = restore_with(&ownership, &saved, &destination, true).unwrap();
    assert_ne!(restored.id, old_id);
    assert_eq!(restored.id, notebook.info().unwrap().id);
    assert_eq!(std::fs::read(&lock).unwrap(), contents);
    assert!(NotebookOwnership::acquire(&destination, 0).is_err());
    assert!(destination.join("restore.pending").exists());
    assert_copy(&notebook, &destination, &sha);
    drop(ownership);
    NotebookOwnership::acquire(&destination, 0).unwrap();
}

#[test]
fn pending_restore_is_ignored_by_empty_destinations_and_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    std::fs::write(source.join("restore.pending"), b"pending").unwrap();
    let store = root.path().join("store");
    let saved = tessera_core::backup_to_store(&source, &store).unwrap();
    assert!(!saved.path.join("restore.pending").exists());
    let destination = root.path().join("destination");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("restore.pending"), b"pending").unwrap();
    restore(&saved.path, &destination, false).unwrap();
    assert_copy(&notebook, &destination, &sha);
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

#[test]
fn store_backups_skip_unchanged_state_and_keep_edits_and_new_objects() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("workshop");
    let store = root.path().join("shared-store");
    let (mut notebook, _) = seed(&source);
    let first = tessera_core::backup_to_store(&source, &store).unwrap();
    assert!(first.created);
    assert_eq!(first.manifest.database_sha256.len(), 64);
    let repeated = tessera_core::backup_to_store(&source, &store).unwrap();
    assert!(!repeated.created);
    assert_eq!(first.path, repeated.path);
    assert_eq!(
        std::fs::read_dir(first.path.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![Operation::EditText {
                id: BLOCK.into(),
                base_revision: 1,
                text: "Edited after backup".into(),
            }],
        })
        .unwrap();
    let edited = tessera_core::backup_to_store(&source, &store).unwrap();
    assert!(edited.created);
    assert_ne!(
        edited.manifest.database_sha256,
        first.manifest.database_sha256
    );
    assert_eq!(
        std::fs::read_dir(first.path.parent().unwrap())
            .unwrap()
            .count(),
        2
    );
    notebook
        .put_object(b"new object without a database edit")
        .unwrap();
    let object = tessera_core::backup_to_store(&source, &store).unwrap();
    assert!(object.created);
    assert_eq!(
        object.manifest.database_sha256,
        edited.manifest.database_sha256
    );
    assert_eq!(object.manifest.object_count, 2);
}

#[test]
fn safety_snapshot_preserves_its_selected_restore_point_during_retention() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("workshop");
    let store = root.path().join("backups");
    let (mut notebook, _) = seed(&source);
    let first = tessera_core::backup_to_store(&source, &store).unwrap();
    let directory = first.path.parent().unwrap();
    for index in 1..=3 {
        let path = directory.join(format!("old-{index}"));
        let mut manifest = backup(&source, &path).unwrap();
        manifest.created_at = index;
        std::fs::write(
            path.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![Operation::EditText {
                id: BLOCK.into(),
                base_revision: 1,
                text: "Saved before restoring".into(),
            }],
        })
        .unwrap();
    let selected = directory.join("old-1");
    let safety = tessera_core::backup_to_store_preserving(&source, &store, &selected).unwrap();
    assert!(safety.created);
    assert!(safety.path.join("manifest.json").is_file());
    assert!(selected.join("manifest.json").is_file());
    assert!(!directory.join("old-2").exists());
    assert_eq!(
        Notebook::open(selected).unwrap().block(BLOCK).unwrap().text,
        "Retained block"
    );
}

#[cfg(unix)]
#[test]
fn backup_objects_share_the_live_inode_and_survive_unlinking_the_live_file() {
    use std::os::unix::fs::MetadataExt;
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let (notebook, sha) = seed(&source);
    let destination = root.path().join("backup");
    backup(&source, &destination).unwrap();
    let live = notebook.object_path(&sha).unwrap();
    let saved = destination.join("objects").join(&sha[..2]).join(&sha[2..]);
    let live_meta = std::fs::metadata(&live).unwrap();
    let saved_meta = std::fs::metadata(&saved).unwrap();
    assert_eq!(
        (live_meta.dev(), live_meta.ino()),
        (saved_meta.dev(), saved_meta.ino())
    );
    assert_eq!(saved_meta.nlink(), 2);
    std::fs::remove_file(live).unwrap();
    assert_eq!(std::fs::read(saved).unwrap(), b"immutable source bytes");
}

#[test]
fn old_manifests_remain_readable_and_do_not_skip_the_first_hashed_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("workshop");
    let store = root.path().join("backups");
    seed(&source);
    let first = tessera_core::backup_to_store(&source, &store).unwrap();
    let path = first.path.join("manifest.json");
    let mut manifest = serde_json::to_value(first.manifest).unwrap();
    manifest.as_object_mut().unwrap().remove("database_sha256");
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let decoded: tessera_core::BackupManifest = serde_json::from_value(manifest).unwrap();
    assert!(decoded.database_sha256.is_empty());
    assert!(
        tessera_core::backup_to_store(&source, &store)
            .unwrap()
            .created
    );
}

#[test]
fn skipped_backups_also_prune_finished_history_without_touching_other_workshops() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("workshop");
    let store = root.path().join("backups");
    seed(&source);
    let newest = tessera_core::backup_to_store(&source, &store).unwrap();
    let directory = newest.path.parent().unwrap();
    for index in 1..=5 {
        let path = directory.join(format!("old-{index}"));
        let mut manifest = backup(&source, &path).unwrap();
        manifest.created_at = index;
        std::fs::write(
            path.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }
    let other_source = root.path().join("other");
    Notebook::open(&other_source).unwrap();
    let other = tessera_core::backup_to_store(&other_source, &store).unwrap();
    assert!(
        !tessera_core::backup_to_store(&source, &store)
            .unwrap()
            .created
    );
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 3);
    assert!(directory.join("old-5").exists());
    assert!(directory.join("old-4").exists());
    assert!(other.path.exists());
}
