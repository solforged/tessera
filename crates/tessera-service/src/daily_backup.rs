use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use tessera_core::{DATABASE_FILE, Notebook};

use crate::{AppState, BackupFailure, BackupLock};

pub(super) struct Task {
    task: tokio::task::JoinHandle<()>,
    backup: BackupLock,
}

impl Task {
    pub(super) async fn stop(self) {
        self.task.abort();
        // A cancelled spawn_blocking still runs. Keep workshop ownership until
        // its snapshot finishes, just as a cancelled HTTP request does.
        let _guard = self.backup.lock().await;
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn start(state: &AppState) -> Option<Task> {
    let store = state.backup_store.clone()?;
    let notebook = Arc::downgrade(&state.notebook);
    let backup = state.backup.clone();
    let mutex = backup.clone();
    let task = tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(120),
            Duration::from_secs(3600),
        );
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut unchanged = None;
        loop {
            ticks.tick().await;
            if notebook.strong_count() == 0 {
                break;
            }
            let guard = mutex.clone().lock_owned().await;
            let notebook = notebook.clone();
            let store = store.clone();
            let seen = unchanged.take();
            let result = tokio::task::spawn_blocking(move || {
                let mut guard = guard;
                let result = check(&notebook, &store, seen);
                *guard = result.as_ref().err().map(|error| BackupFailure {
                    at: tessera_core::now_ms(),
                    message: error.to_string(),
                });
                result
            })
            .await;
            match result {
                Ok(Ok(fingerprint)) => unchanged = fingerprint,
                Ok(Err(error)) => tracing::info!(%error, "automatic workshop backup failed"),
                Err(error) => tracing::info!(%error, "automatic workshop backup task failed"),
            }
        }
    });
    Some(Task { task, backup })
}

fn due(newest: Option<i64>, now: i64) -> bool {
    newest.is_none_or(|created| now.saturating_sub(created) >= 86_400_000)
}

/// Sizes and modification times of the database and its write-ahead log. Any
/// write moves one of them, so an equal fingerprint means nothing was written.
#[derive(Debug, PartialEq)]
struct Fingerprint([Option<(u64, SystemTime)>; 2]);

fn fingerprint(notebook: &Path) -> Option<Fingerprint> {
    let file = |name: String| match std::fs::metadata(notebook.join(name)) {
        Ok(metadata) => Some(Some((metadata.len(), metadata.modified().ok()?))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    };
    Some(Fingerprint([
        file(DATABASE_FILE.to_owned())?,
        file(format!("{DATABASE_FILE}-wal"))?,
    ]))
}

/// An unchanged workshop keeps its old newest backup, so it stays due. Its
/// fingerprint from that check is returned and skips the next snapshot until
/// something is written.
fn check(
    notebook: &Weak<Mutex<Notebook>>,
    store: &Path,
    unchanged: Option<Fingerprint>,
) -> tessera_core::Result<Option<Fingerprint>> {
    let Some(notebook) = notebook.upgrade() else {
        return Ok(None);
    };
    let info = notebook.lock().info()?;
    let backups = tessera_core::finished_backups(store, &info.id)?;
    if !due(
        backups.first().map(|(_, manifest)| manifest.created_at),
        tessera_core::now_ms(),
    ) {
        return Ok(None);
    }
    // Read before the snapshot, so a write during it is backed up next time.
    let before = fingerprint(&info.path);
    if before.is_some() && before == unchanged {
        return Ok(unchanged);
    }
    let result = tessera_core::backup_to_store(&info.path, store)?;
    tracing::info!(path = %result.path.display(), created = result.created, "automatic workshop backup finished");
    Ok(if result.created { None } else { before })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_backup_starts_when_missing_or_twenty_four_hours_old() {
        assert!(due(None, 0));
        assert!(!due(Some(1), 86_400_000));
        assert!(due(Some(0), 86_400_000));
        assert!(due(Some(0), 86_400_001));
        assert!(!due(Some(100), 0));
    }

    #[test]
    fn automatic_backup_creates_then_skips_a_recent_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(root.path().join("workshop")).unwrap(),
        ));
        let id = notebook.lock().info().unwrap().id;
        let store = root.path().join("backups");
        check(&Arc::downgrade(&notebook), &store, None).unwrap();
        let first = tessera_core::finished_backups(&store, &id).unwrap();
        assert_eq!(first.len(), 1);
        check(&Arc::downgrade(&notebook), &store, None).unwrap();
        let second = tessera_core::finished_backups(&store, &id).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].0, second[0].0);
    }

    #[cfg(unix)]
    #[test]
    fn an_unchanged_workshop_is_not_snapshotted_again_until_it_is_written() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let notebook = Arc::new(Mutex::new(
            Notebook::open(root.path().join("workshop")).unwrap(),
        ));
        let weak = Arc::downgrade(&notebook);
        let id = notebook.lock().info().unwrap().id;
        let store = root.path().join("backups");
        assert_eq!(check(&weak, &store, None).unwrap(), None);
        // Age the only backup so the next check is due but finds nothing changed.
        let (path, _) = tessera_core::finished_backups(&store, &id)
            .unwrap()
            .remove(0);
        let manifest = path.join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        value["created_at"] = (tessera_core::now_ms() - 2 * 86_400_000).into();
        std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        let unchanged = check(&weak, &store, None).unwrap();
        assert!(unchanged.is_some());

        // A snapshot would need to write into the store; with the fingerprint it does not try.
        let directory = tessera_core::backup_directory(&store, &id).unwrap();
        let writable = std::fs::metadata(&directory).unwrap().permissions();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o555)).unwrap();
        let skipped = check(&weak, &store, unchanged);
        std::fs::set_permissions(&directory, writable).unwrap();
        let unchanged = skipped.unwrap();
        assert!(unchanged.is_some());

        notebook
            .lock()
            .apply(&tessera_core::Batch {
                actor: tessera_core::Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![tessera_core::Operation::SetSetting {
                    key: "vim".into(),
                    base_revision: None,
                    value: "true".into(),
                }],
            })
            .unwrap();
        assert_eq!(check(&weak, &store, unchanged).unwrap(), None);
        assert_eq!(
            tessera_core::finished_backups(&store, &id).unwrap().len(),
            2
        );
    }
}
