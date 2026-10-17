use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tessera_core::Notebook;

use crate::AppState;

pub(super) struct Task {
    task: tokio::task::JoinHandle<()>,
    backup: Arc<tokio::sync::Mutex<()>>,
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
        loop {
            ticks.tick().await;
            if notebook.strong_count() == 0 {
                break;
            }
            let guard = mutex.clone().lock_owned().await;
            let notebook = notebook.clone();
            let store = store.clone();
            let result = tokio::task::spawn_blocking(move || {
                let _guard = guard;
                check(&notebook, &store)
            })
            .await;
            match result {
                Ok(Ok(())) => (),
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

fn check(notebook: &Weak<Mutex<Notebook>>, store: &std::path::Path) -> tessera_core::Result<()> {
    let Some(notebook) = notebook.upgrade() else {
        return Ok(());
    };
    let info = notebook.lock().info()?;
    let backups = tessera_core::finished_backups(store, &info.id)?;
    if due(
        backups.first().map(|(_, manifest)| manifest.created_at),
        tessera_core::now_ms(),
    ) {
        let result = tessera_core::backup_to_store(&info.path, store)?;
        tracing::info!(path = %result.path.display(), created = result.created, "automatic workshop backup finished");
    }
    Ok(())
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
        check(&Arc::downgrade(&notebook), &store).unwrap();
        let first = tessera_core::finished_backups(&store, &id).unwrap();
        assert_eq!(first.len(), 1);
        check(&Arc::downgrade(&notebook), &store).unwrap();
        let second = tessera_core::finished_backups(&store, &id).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].0, second[0].0);
    }
}
