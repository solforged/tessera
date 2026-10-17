//! One-way, non-overwriting migration from the platform layout to the XDG layout.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tessera_core::{DATABASE_FILE, NotebookOwnership};

use crate::notebooks::{Registry, Stored};
use crate::paths;

/// Move old desktop locations before opening the registry-selected workshop.
/// A live owner or an I/O failure stops migration without discarding the source.
pub fn migrate_layout() -> anyhow::Result<Vec<(PathBuf, PathBuf)>> {
    let layout = Layout {
        legacy: dirs::data_dir()
            .context("no legacy data directory")?
            .join("tessera"),
        data: paths::data_dir().context("no workshop data directory")?,
        state: paths::state_dir().context("no workshop state directory")?,
        cache: paths::cache_dir().context("no workshop cache directory")?,
    };
    layout.migrate()
}

struct Layout {
    legacy: PathBuf,
    data: PathBuf,
    state: PathBuf,
    cache: PathBuf,
}

impl Layout {
    fn migrate(&self) -> anyhow::Result<Vec<(PathBuf, PathBuf)>> {
        let mut moved = Vec::new();
        let registry = Registry {
            path: self.state.join("workshops.json"),
            default: self.data.join("workshops/main"),
        };
        let old_registry = Registry {
            path: self.legacy.join("notebooks.json"),
            default: self.legacy.join("notebook"),
        };
        // Read both before moving anything: an unreadable list must not be replaced.
        let original = registry.load_raw()?;
        let old = old_registry.load_raw()?;
        let mut stored = Stored {
            current: original.current.clone().or(old.current),
            notebooks: original.notebooks.clone(),
        };
        for path in old.notebooks {
            if !stored.notebooks.contains(&path) {
                stored.notebooks.push(path);
            }
        }
        let old_default = &old_registry.default;
        if old_default.exists() {
            if stored.current.is_none() {
                stored.current = Some(old_default.clone());
            }
            if !stored.notebooks.contains(old_default) {
                stored.notebooks.push(old_default.clone());
            }
        }
        if Self::workshop(old_default, &registry.default, &mut stored, &registry)? {
            moved.push((old_default.clone(), registry.default.clone()));
        }

        let old_backups = self.legacy.join("backups");
        let new_backups = self.data.join("backups");
        if old_backups != new_backups {
            for id in directories(&old_backups)? {
                for stamp in directories(&id)? {
                    move_path(
                        &stamp,
                        &new_backups
                            .join(id.file_name().unwrap())
                            .join(stamp.file_name().unwrap()),
                    )?;
                }
                remove_empty(&id)?;
            }
            remove_empty(&old_backups)?;
        }
        let seeds = self.data.join("notebooks");
        for source in directories(&seeds)? {
            let target = self
                .data
                .join("workshops")
                .join(source.file_name().unwrap());
            if Self::workshop(&source, &target, &mut stored, &registry)? {
                moved.push((source, target));
            }
        }
        remove_empty(&seeds)?;

        stored.notebooks.retain(|path| {
            path == &registry.default
                || Some(path) == stored.current.as_ref()
                || path.join(DATABASE_FILE).is_file()
        });
        if old_registry.path.exists() || stored != original {
            registry.save(&stored)?;
        }
        if old_registry.path.exists() {
            fs::remove_file(&old_registry.path)?;
            tracing::info!(from = %old_registry.path.display(), to = %registry.path.display(), "moved workshop registry");
        }
        move_path(
            &self.legacy.join("agent.json"),
            &self.state.join("agent.json"),
        )?;
        move_path(
            &self.legacy.join("android-downloads"),
            &self.cache.join("android-downloads"),
        )?;
        if self.legacy != self.data && self.legacy != self.state && self.legacy != self.cache {
            remove_empty(&self.legacy)?;
        }
        Ok(moved)
    }

    fn workshop(
        source: &Path,
        target: &Path,
        stored: &mut Stored,
        registry: &Registry,
    ) -> anyhow::Result<bool> {
        if !exists(source)? || source == target {
            return Ok(false);
        }
        if exists(target)? {
            tracing::warn!(from = %source.display(), to = %target.display(), "workshop destination exists; leaving both folders and their registry paths unchanged");
            return Ok(false);
        }
        // Release before rename as required on platforms that deny moving open files.
        drop(NotebookOwnership::acquire(source, 0)?);
        if move_path(source, target)? {
            if stored.current.as_deref() == Some(source) {
                stored.current = Some(target.to_path_buf());
            }
            for path in &mut stored.notebooks {
                if path == source {
                    *path = target.to_path_buf();
                }
            }
            if !stored.notebooks.iter().any(|path| path == target) {
                stored.notebooks.push(target.to_path_buf());
            }
            // Persist each move, so a later collision or I/O error cannot lose its path.
            registry.save(stored)?;
            return Ok(true);
        }
        Ok(false)
    }
}

fn directories(path: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn remove_empty(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn move_path(source: &Path, target: &Path) -> io::Result<bool> {
    if source == target || !exists(source)? {
        return Ok(false);
    }
    if exists(target)? {
        tracing::warn!(from = %source.display(), to = %target.display(), "migration destination exists; leaving both paths unchanged");
        return Ok(false);
    }
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("migration destination has no parent"))?;
    fs::create_dir_all(parent)?;
    match fs::rename(source, target) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            // Publish only a complete, synced copy; a failed copy leaves the source intact.
            let staging = parent.join(format!(".tessera-migration-{}", std::process::id()));
            fs::create_dir(&staging)?;
            let copied = staging.join("contents");
            let result = copy_synced(source, &copied).and_then(|()| {
                File::open(&staging)?.sync_all()?;
                if exists(target)? {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "migration destination appeared during copy",
                    ));
                }
                fs::rename(&copied, target)?;
                File::open(parent)?.sync_all()
            });
            if result.is_err() {
                let _ = fs::remove_dir_all(&staging);
                return result.map(|()| false);
            }
            fs::remove_dir(&staging)?;
            if fs::symlink_metadata(source)?.is_dir() {
                fs::remove_dir_all(source)?;
            } else {
                fs::remove_file(source)?;
            }
        }
        Err(error) => return Err(error),
    }
    File::open(parent)?.sync_all()?;
    if let Some(parent) = source.parent() {
        File::open(parent)?.sync_all()?;
    }
    tracing::info!(from = %source.display(), to = %target.display(), "moved workshop layout path");
    Ok(true)
}

fn copy_synced(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_synced(&entry.path(), &target.join(entry.file_name()))?;
        }
        fs::set_permissions(target, metadata.permissions())?;
        File::open(target)?.sync_all()
    } else if metadata.is_file() {
        fs::copy(source, target)?;
        File::open(target)?.sync_all()
    } else if metadata.is_symlink() {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fs::read_link(source)?, target)
        }
        #[cfg(not(unix))]
        {
            Err(io::Error::other(
                "cannot migrate symbolic links across filesystems on this platform",
            ))
        }
    } else {
        Err(io::Error::other(
            "cannot migrate a special file across filesystems",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(root: &Path, shared_root: bool) -> Layout {
        Layout {
            legacy: root.join(if shared_root { "data" } else { "legacy" }),
            data: root.join("data"),
            state: root.join("state"),
            cache: root.join("cache"),
        }
    }

    fn database(path: &Path) {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join(DATABASE_FILE), b"preserved database").unwrap();
    }

    #[test]
    fn migrated_layout_preserves_content_merges_registry_and_is_idempotent() {
        for shared_root in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let layout = layout(root.path(), shared_root);
            let old = layout.legacy.join("notebook");
            let seed = layout.data.join("notebooks/reading");
            let external = root.path().join("external");
            for path in [&old, &seed, &external] {
                database(path);
            }
            let backup = layout.legacy.join("backups/id/stamp");
            database(&backup);
            fs::write(layout.legacy.join("agent.json"), b"{\"provider\":\"kept\"}").unwrap();
            fs::create_dir_all(layout.legacy.join("android-downloads")).unwrap();
            fs::write(layout.legacy.join("android-downloads/app.apk"), b"apk").unwrap();
            fs::write(
                layout.legacy.join("notebooks.json"),
                serde_json::to_vec(&Stored {
                    current: Some(old.clone()),
                    notebooks: vec![old.clone(), seed.clone(), root.path().join("missing")],
                })
                .unwrap(),
            )
            .unwrap();
            let registry = Registry {
                path: layout.state.join("workshops.json"),
                default: layout.data.join("workshops/main"),
            };
            registry
                .save(&Stored {
                    current: None,
                    notebooks: vec![external.clone()],
                })
                .unwrap();
            layout.migrate().unwrap();
            let bytes = fs::read(&registry.path).unwrap();
            let stored = registry.load_raw().unwrap();
            assert_eq!(stored.current, Some(registry.default.clone()));
            assert_eq!(stored.notebooks.len(), 3);
            assert!(stored.notebooks.contains(&external));
            assert!(!old.exists());
            assert!(!seed.exists());
            assert_eq!(
                fs::read(registry.default.join(DATABASE_FILE)).unwrap(),
                b"preserved database"
            );
            assert_eq!(
                fs::read(layout.data.join("backups/id/stamp/notebook.db")).unwrap(),
                b"preserved database"
            );
            assert_eq!(
                fs::read(layout.cache.join("android-downloads/app.apk")).unwrap(),
                b"apk"
            );
            assert!(layout.state.join("agent.json").exists());
            layout.migrate().unwrap();
            assert_eq!(fs::read(&registry.path).unwrap(), bytes);
        }
    }

    #[test]
    fn collisions_keep_both_workshops_and_the_legacy_current_path() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path(), false);
        let old = layout.legacy.join("notebook");
        database(&old);
        database(&layout.data.join("workshops/main"));
        fs::write(old.join("unique"), b"legacy").unwrap();
        layout.migrate().unwrap();
        assert_eq!(fs::read(old.join("unique")).unwrap(), b"legacy");
        let registry = Registry {
            path: layout.state.join("workshops.json"),
            default: layout.data.join("workshops/main"),
        };
        assert_eq!(registry.startup(), old);
    }

    #[test]
    fn active_owner_prevents_migration() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path(), false);
        let old = layout.legacy.join("notebook");
        database(&old);
        let _owner = NotebookOwnership::acquire(&old, 12345).unwrap();
        assert!(layout.migrate().is_err());
        assert!(old.join(DATABASE_FILE).is_file());
        assert!(!layout.data.join("workshops/main").exists());
    }
}
