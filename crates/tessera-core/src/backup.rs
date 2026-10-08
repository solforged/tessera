use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

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
    let object_count = copy_objects(&source, &destination)?;
    let manifest = BackupManifest {
        notebook_id,
        schema_version,
        created_at: now_ms(),
        object_count,
        db_page_count,
    };
    fs::rename(
        stage.path().join(DATABASE_FILE),
        destination.join(DATABASE_FILE),
    )?;
    let mut file = File::create(stage.path().join("manifest.json"))?;
    serde_json::to_writer_pretty(&mut file, &manifest).map_err(io::Error::other)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(
        stage.path().join("manifest.json"),
        destination.join("manifest.json"),
    )?;
    File::open(&destination)?.sync_all()?;
    Ok(manifest)
}

/// Where the service lists a notebook's backups: `<parent>/backups/<id>`.
pub fn backup_directory(notebook: &Path, id: &str) -> Result<PathBuf> {
    let parent = notebook
        .parent()
        .ok_or_else(|| validation("The notebook has no parent directory."))?;
    Ok(parent.join("backups").join(id))
}

/// Back up into the notebook's [`backup_directory`] under the current UTC
/// second. Reads the notebook ID without opening, so a newer build can back
/// up before it migrates.
pub fn backup_beside(notebook: impl AsRef<Path>) -> Result<(PathBuf, BackupManifest)> {
    let notebook = fs::canonicalize(notebook.as_ref())?;
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
    let directory = backup_directory(&notebook, &id)?;
    fs::create_dir_all(&directory)?;
    let path = directory.join(
        jiff::Timestamp::now()
            .strftime("%Y-%m-%dT%H-%M-%S")
            .to_string(),
    );
    // Fails with AlreadyExists for a second backup within the same second.
    fs::create_dir(&path)?;
    let manifest = backup(&notebook, &path)?;
    Ok((path, manifest))
}

/// Restore into an offline notebook. Hold the same OS lock as the service for
/// the entire replacement, including migration. Never unlink `service.lock`.
pub fn restore(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    force: bool,
) -> Result<NotebookInfo> {
    let (source, destination) = directories(source.as_ref(), destination.as_ref())?;
    let _ownership = NotebookOwnership::acquire(&destination, 0)?;
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
        if entry?.file_name() != "service.lock" {
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

fn snapshot(source: &Path, destination: &Path) -> Result<Connection> {
    let source =
        Connection::open_with_flags(source.join(DATABASE_FILE), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(5))?;
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
                    let mut temp = tempfile::NamedTempFile::new_in(&target)?;
                    io::copy(&mut File::open(object.path())?, &mut temp)?;
                    temp.as_file().sync_all()?;
                    temp.persist_noclobber(path).map_err(|error| error.error)?;
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
