use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::notebook::now_ms;
use crate::storage::validation;
use crate::{
    DATABASE_FILE, Error, Notebook, NotebookInfo, NotebookOwnership, Result, SCHEMA_VERSION,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct BackupManifest {
    pub notebook_id: String,
    pub schema_version: u32,
    /// Time of the backup, in Unix milliseconds.
    pub created_at: i64,
    pub object_count: u64,
    pub db_page_count: u32,
    /// Hash of the portable SQLite snapshot; absent in backups from older builds.
    #[serde(default)]
    pub database_sha256: String,
    /// Set on a backup that keeps the state an update or restore replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety: Option<Safety>,
    /// The workshop folder's name when backed up, so a forgotten workshop's
    /// backups can still be named; absent in backups from older builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_name: Option<String>,
}

/// What a safety backup was taken before. Retention keeps these for a week.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Safety {
    Update,
    Restore,
}

/// Take a consistent SQLite snapshot without acquiring the source service lock.
/// Objects are immutable and published before a database row can refer to them.
/// The destination must be empty, apart from a stale ownership lock.
pub fn backup(source: impl AsRef<Path>, destination: impl AsRef<Path>) -> Result<BackupManifest> {
    let (source, destination) = directories(source.as_ref(), destination.as_ref())?;
    let _ownership = NotebookOwnership::acquire(&destination, 0)?;
    require_empty(&destination)?;
    let stage = tempfile::tempdir_in(&destination)?;
    let conn = snapshot(&source, &stage.path().join(DATABASE_FILE))?;
    let schema_version = schema(&conn)?;
    let notebook_id = conn.query_row("SELECT id FROM notebook WHERE singleton = 1", [], |r| {
        r.get(0)
    })?;
    let db_page_count = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
    drop(conn);
    let mut digest = Sha256::new();
    let mut database = File::open(stage.path().join(DATABASE_FILE))?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = database.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    let database_sha256 =
        digest
            .finalize()
            .iter()
            .fold(String::with_capacity(64), |mut hex, byte| {
                use std::fmt::Write as _;
                write!(hex, "{byte:02x}").expect("writing to String cannot fail");
                hex
            });
    let object_count = copy_objects(&source, &destination)?;
    let manifest = BackupManifest {
        notebook_id,
        schema_version,
        created_at: now_ms(),
        object_count,
        db_page_count,
        database_sha256,
        safety: None,
        workshop_name: source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
    };
    fs::rename(
        stage.path().join(DATABASE_FILE),
        destination.join(DATABASE_FILE),
    )?;
    write_manifest(stage.path(), &destination, &manifest)?;
    Ok(manifest)
}

/// Publish `manifest.json` into `destination` by renaming it from `stage`.
fn write_manifest(stage: &Path, destination: &Path, manifest: &BackupManifest) -> Result<()> {
    let mut file = File::create(stage.join("manifest.json.tmp"))?;
    serde_json::to_writer_pretty(&mut file, manifest).map_err(io::Error::other)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(
        stage.join("manifest.json.tmp"),
        destination.join("manifest.json"),
    )?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

/// A store backup either newly published or retained because nothing changed.
#[derive(Debug)]
pub struct StoredBackup {
    pub path: PathBuf,
    pub manifest: BackupManifest,
    pub created: bool,
}

/// One workshop's folder within the explicitly supplied backup store.
pub fn backup_directory(store: &Path, id: &str) -> Result<PathBuf> {
    crate::storage::validate_id(id)?;
    Ok(store.join(id))
}

/// Finished backups for this workshop, newest first. Staging directories and
/// symlinks are never restore points.
pub fn finished_backups(store: &Path, id: &str) -> Result<Vec<(PathBuf, BackupManifest)>> {
    let directory = backup_directory(store, id)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !fs::symlink_metadata(&directory)?.is_dir() {
        return Err(validation("Backup directories must not be symlinks."));
    }
    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_name().as_encoded_bytes().starts_with(b".tmp")
        {
            continue;
        }
        let manifest = match File::open(entry.path().join("manifest.json")) {
            Ok(file) => {
                serde_json::from_reader::<_, BackupManifest>(file).map_err(io::Error::other)?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if manifest.notebook_id == id {
            backups.push((entry.path(), manifest));
        }
    }
    backups.sort_by(|a, b| {
        b.1.created_at
            .cmp(&a.1.created_at)
            .then_with(|| b.0.cmp(&a.0))
    });
    Ok(backups)
}

/// Snapshot into the shared store, skip unchanged state, then apply retention.
/// Reads the identity without opening the workshop, so install can back up
/// before the new build migrates its database.
pub fn backup_to_store(
    notebook: impl AsRef<Path>,
    store: impl AsRef<Path>,
) -> Result<StoredBackup> {
    store_backup(notebook.as_ref(), store.as_ref(), None, None)
}

/// Back up before an update replaces the build, marked so retention keeps it
/// for a week.
pub fn backup_before_update(
    notebook: impl AsRef<Path>,
    store: impl AsRef<Path>,
) -> Result<StoredBackup> {
    store_backup(
        notebook.as_ref(),
        store.as_ref(),
        None,
        Some(Safety::Update),
    )
}

/// Take a safety snapshot without pruning the backup about to be restored.
pub fn backup_to_store_preserving(
    notebook: impl AsRef<Path>,
    store: impl AsRef<Path>,
    preserve: &Path,
) -> Result<StoredBackup> {
    store_backup(
        notebook.as_ref(),
        store.as_ref(),
        Some(preserve),
        Some(Safety::Restore),
    )
}

fn store_backup(
    notebook: &Path,
    store: &Path,
    preserve: Option<&Path>,
    safety: Option<Safety>,
) -> Result<StoredBackup> {
    let notebook = fs::canonicalize(notebook)?;
    let id: String = {
        let conn = Connection::open_with_flags(
            notebook.join(DATABASE_FILE),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.query_row("SELECT id FROM notebook WHERE singleton = 1", [], |r| {
            r.get(0)
        })?
    };
    let directory = backup_directory(store, &id)?;
    fs::create_dir_all(&directory)?;
    if !fs::symlink_metadata(&directory)?.is_dir() {
        return Err(validation("Backup directories must not be symlinks."));
    }
    let stage = tempfile::tempdir_in(&directory)?;
    let mut manifest = backup(&notebook, stage.path())?;
    // This private staging directory is no longer owned after backup returns.
    fs::remove_file(stage.path().join("service.lock"))?;
    if let Some((path, mut previous)) = finished_backups(store, &id)?.into_iter().next()
        && previous.database_sha256 == manifest.database_sha256
        && previous.object_count == manifest.object_count
    {
        // The unchanged backup now holds the state being replaced.
        if safety.is_some() && previous.safety.is_none() {
            previous.safety = safety;
            write_manifest(stage.path(), &path, &previous)?;
        }
        stage.close()?;
        prune_store(store, &id, now_ms(), preserve)?;
        return Ok(StoredBackup {
            path,
            manifest: previous,
            created: false,
        });
    }
    if safety.is_some() {
        manifest.safety = safety;
        write_manifest(stage.path(), stage.path(), &manifest)?;
    }
    let timestamp = jiff::Timestamp::from_millisecond(manifest.created_at)
        .map_err(|error| validation(error.to_string()))?;
    let stem = format!(
        "{}-{:03}",
        timestamp.strftime("%Y-%m-%dT%H-%M-%S"),
        manifest.created_at.rem_euclid(1000)
    );
    let mut attempt = 1;
    let path = loop {
        let path = directory.join(if attempt == 1 {
            stem.clone()
        } else {
            format!("{stem}-{attempt}")
        });
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => attempt += 1,
            Err(error) => return Err(error.into()),
        }
    };
    fs::rename(stage.path(), &path)?;
    File::open(&directory)?.sync_all()?;
    prune_store(store, &id, now_ms(), preserve)?;
    Ok(StoredBackup {
        path,
        manifest,
        created: true,
    })
}

const DAY_MS: i64 = 86_400_000;

/// Indices to retain from `(created_at, safety)` pairs: the newest, safety
/// backups younger than seven days, one per UTC day including today for seven
/// days, then one per seven-day window for the preceding four weeks.
fn retained_backups(backups: &[(i64, bool)], now: i64) -> BTreeSet<usize> {
    let mut newest: Vec<_> = (0..backups.len()).collect();
    newest.sort_by_key(|&index| std::cmp::Reverse(backups[index].0));
    let mut keep: BTreeSet<_> = newest.first().copied().into_iter().collect();
    let mut buckets = BTreeSet::new();
    for index in newest {
        let (created, safety) = backups[index];
        if safety && now - created < 7 * DAY_MS {
            keep.insert(index);
        }
        let age = now.div_euclid(DAY_MS) - created.div_euclid(DAY_MS);
        let bucket = match age {
            0..=6 => age,
            7..=34 => 7 + (age - 7) / 7,
            _ => continue,
        };
        if buckets.insert(bucket) {
            keep.insert(index);
        }
    }
    keep
}

fn prune_store(store: &Path, id: &str, now: i64, preserve: Option<&Path>) -> Result<()> {
    let backups = finished_backups(store, id)?;
    let timestamps: Vec<_> = backups
        .iter()
        .map(|(_, manifest)| (manifest.created_at, manifest.safety.is_some()))
        .collect();
    let keep = retained_backups(&timestamps, now);
    for (index, (path, _)) in backups.into_iter().enumerate() {
        if !keep.contains(&index) && preserve != Some(path.as_path()) {
            fs::remove_dir_all(path)?;
        }
    }
    let now = SystemTime::UNIX_EPOCH + Duration::from_millis(now.max(0) as u64);
    for entry in fs::read_dir(backup_directory(store, id)?)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let staging = entry.file_name().as_encoded_bytes().starts_with(b".tmp");
        if (staging || !entry.path().join("manifest.json").try_exists()?)
            && now
                .duration_since(entry.metadata()?.modified()?)
                .unwrap_or_default()
                >= Duration::from_secs(3600)
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

/// Restore into an offline notebook. Hold the same OS lock as the service for
/// the entire replacement, including migration. Never unlink `service.lock`.
pub fn restore(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    force: bool,
) -> Result<NotebookInfo> {
    let (source, destination) = directories(source.as_ref(), destination.as_ref())?;
    let ownership = NotebookOwnership::acquire(&destination, 0)?;
    restore_with(&ownership, source, destination, force)
}

/// Restore while the caller holds destination ownership and no open database.
/// Keep that ownership alive until the replacement has finished migrating.
pub fn restore_with(
    _ownership: &NotebookOwnership,
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    force: bool,
) -> Result<NotebookInfo> {
    let (source, destination) = directories(source.as_ref(), destination.as_ref())?;
    if !force {
        require_empty(&destination)?;
    }
    let stage = tempfile::tempdir_in(&destination)?;
    let conn = snapshot(&source, &stage.path().join(DATABASE_FILE))?;
    schema(&conn)?;
    drop(conn);
    // Confirm that the database is a notebook and can migrate before replacing
    // anything at the destination. Closing checkpoints this private WAL.
    Notebook::open(stage.path())?.info()?;
    copy_objects(&source, &destination)?;
    for suffix in ["-wal", "-shm"] {
        let path = destination.join(format!("{DATABASE_FILE}{suffix}"));
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    fs::rename(
        stage.path().join(DATABASE_FILE),
        destination.join(DATABASE_FILE),
    )?;
    File::open(&destination)?.sync_all()?;
    Notebook::open(&destination)?.info()
}

fn directories(source: &Path, destination: &Path) -> Result<(PathBuf, PathBuf)> {
    let source = fs::canonicalize(source)?;
    // Do not create a destination for an absent source database.
    File::open(source.join(DATABASE_FILE))?;
    fs::create_dir_all(destination)?;
    let destination = fs::canonicalize(destination)?;
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(validation(
            "Source and destination directories must not overlap.",
        ));
    }
    Ok((source, destination))
}

fn require_empty(directory: &Path) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let name = entry?.file_name();
        if name != "service.lock" && name != "restore.pending" {
            return Err(validation(
                "Destination is not empty; restore requires --force.",
            ));
        }
    }
    Ok(())
}

fn schema(conn: &Connection) -> Result<u32> {
    let found = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(found)
}

/// Copy the source database, refusing one that fails `quick_check`: a backup
/// of a damaged file would only preserve the damage, and a restore from one
/// would spread it.
fn snapshot(source: &Path, destination: &Path) -> Result<Connection> {
    let path = source.join(DATABASE_FILE);
    let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(5))?;
    let problems = crate::check::quick_check(&source)?;
    if !problems.is_empty() {
        return Err(Error::Corrupt {
            path,
            problems: problems.join("; "),
        });
    }
    let mut destination = Connection::open(destination)?;
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
        backup.run_to_completion(128, Duration::from_millis(5), None)?;
    }
    // A portable backup is a single database file, not a database plus a WAL.
    destination.pragma_update(None, "journal_mode", "DELETE")?;
    Ok(destination)
}

fn hex_name(name: &std::ffi::OsStr, length: usize) -> bool {
    name.to_str().is_some_and(|name| {
        name.len() == length
            && name
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn object_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(validation("Object directories must not be symlinks."));
    }
    Ok(())
}

fn copy_objects(source: &Path, destination: &Path) -> Result<u64> {
    let source = source.join("objects");
    let destination = destination.join("objects");
    object_directory(&destination)?;
    if !source.try_exists()? {
        return Ok(0);
    }
    if !fs::symlink_metadata(&source)?.is_dir() {
        return Err(validation("Object directories must not be symlinks."));
    }
    let mut count = 0;
    for shard in fs::read_dir(source)? {
        let shard = shard?;
        if !hex_name(&shard.file_name(), 2) {
            continue;
        }
        if !shard.file_type()?.is_dir() {
            return Err(validation("Object shards must be directories."));
        }
        let target = destination.join(shard.file_name());
        object_directory(&target)?;
        for object in fs::read_dir(shard.path())? {
            let object = object?;
            // Ignore in-flight temporary files from put_object.
            if !hex_name(&object.file_name(), 62) {
                continue;
            }
            if !object.file_type()?.is_file() {
                return Err(validation("Objects must be regular files."));
            }
            let path = target.join(object.file_name());
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => (),
                Ok(_) => return Err(validation("Objects must be regular files.")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if fs::hard_link(object.path(), &path).is_err() {
                        let mut temp = tempfile::NamedTempFile::new_in(&target)?;
                        io::copy(&mut File::open(object.path())?, &mut temp)?;
                        temp.as_file().sync_all()?;
                        temp.persist_noclobber(path).map_err(|error| error.error)?;
                    }
                }
                Err(error) => return Err(error.into()),
            }
            count += 1;
        }
        File::open(target)?.sync_all()?;
    }
    File::open(destination)?.sync_all()?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(timestamps: &[i64]) -> Vec<(i64, bool)> {
        timestamps.iter().map(|&at| (at, false)).collect()
    }

    #[test]
    fn retention_keeps_the_newest_even_outside_the_time_windows() {
        assert_eq!(retained_backups(&[], 0), BTreeSet::new());
        assert_eq!(
            retained_backups(&plain(&[1, 4, 2, 3]), 100 * DAY_MS),
            BTreeSet::from([1])
        );
    }

    #[test]
    fn retention_keeps_safety_backups_for_seven_days_beside_their_day() {
        let now = 100 * DAY_MS;
        let backups = [
            (now, false),
            (now - 1_000, true),
            (now - 2_000, false),
            (now - 7 * DAY_MS + 1, true),
            (now - 7 * DAY_MS + 2, false),
            (now - 8 * DAY_MS, true),
        ];
        // Days 99 and 93 keep their newest beside the safety backup; the
        // eight-day-old one shares day 93's week and is no longer protected.
        assert_eq!(
            retained_backups(&backups, now),
            BTreeSet::from([0, 1, 3, 4])
        );
    }

    #[test]
    fn retention_uses_utc_days_and_four_prior_seven_day_windows() {
        let midnight = 100 * DAY_MS;
        // Two backups in each day, deliberately oldest first.
        let mut timestamps = Vec::new();
        for age in (0..=40).rev() {
            timestamps.push(midnight - age * DAY_MS);
            timestamps.push(midnight - age * DAY_MS + 1);
        }
        timestamps.extend([midnight + 2, midnight + 3]);
        let actual: BTreeSet<_> = retained_backups(&plain(&timestamps), midnight + 4)
            .into_iter()
            .map(|index| timestamps[index])
            .collect();
        let mut expected = BTreeSet::from([midnight + 3]);
        for age in [1, 2, 3, 4, 5, 6, 7, 14, 21, 28] {
            expected.insert(midnight - age * DAY_MS + 1);
        }
        assert_eq!(actual, expected);
        // The last millisecond of yesterday remains in yesterday's bucket,
        // even one millisecond after midnight.
        let timestamps = [
            midnight + 3,
            midnight + 2,
            midnight + 1,
            midnight,
            midnight - 1,
        ];
        assert_eq!(
            retained_backups(&plain(&timestamps), midnight + 4),
            BTreeSet::from([0, 4])
        );
    }

    #[test]
    fn retention_includes_last_day_of_each_week_but_not_day_thirty_six() {
        let now = 100 * DAY_MS;
        let timestamps = [
            now,
            now - 1,
            now - 2,
            now - 13 * DAY_MS,
            now - 20 * DAY_MS,
            now - 27 * DAY_MS,
            now - 34 * DAY_MS,
            now - 35 * DAY_MS,
        ];
        assert_eq!(
            retained_backups(&plain(&timestamps), now),
            BTreeSet::from([0, 1, 3, 4, 5, 6])
        );
    }

    #[test]
    fn pruning_removes_only_old_unfinished_directories() {
        let root = tempfile::tempdir().unwrap();
        let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let directory = backup_directory(root.path(), id).unwrap();
        fs::create_dir_all(&directory).unwrap();
        let now = now_ms();
        for (name, age) in [
            ("old", 3_600_001),
            ("boundary", 3_600_000),
            ("recent", 3_599_000),
        ] {
            let path = directory.join(name);
            fs::create_dir(&path).unwrap();
            File::open(path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis((now - age) as u64))
                .unwrap();
        }
        prune_store(root.path(), id, now, None).unwrap();
        assert!(!directory.join("old").exists());
        assert!(!directory.join("boundary").exists());
        assert!(directory.join("recent").exists());
    }
}
