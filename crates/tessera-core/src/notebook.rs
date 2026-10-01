use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::migrate::{SCHEMA_VERSION, migrate};

/// File name of the database inside a notebook directory.
pub const DATABASE_FILE: &str = "notebook.db";

/// A notebook directory and its open SQLite connection.
///
/// All reads and writes go through methods on this type, so every client
/// gets the same rules.
pub struct Notebook {
    dir: PathBuf,
    pub(crate) conn: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotebookInfo {
    pub id: String,
    pub path: PathBuf,
    pub created_at: i64,
    pub schema_version: u32,
    pub sqlite_version: String,
}

impl Notebook {
    /// Open the notebook in `dir`, creating the directory and an empty
    /// notebook if none exists. An existing notebook is migrated forward,
    /// never overwritten.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir).map_err(|source| Error::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let dir = std::fs::canonicalize(dir).map_err(|source| Error::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let mut conn = Connection::open(dir.join(DATABASE_FILE))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // FULL: an acknowledged commit survives power loss, not just a crash.
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        conn.execute(
            "INSERT INTO notebook (singleton, id, created_at) VALUES (1, ?1, ?2)
             ON CONFLICT (singleton) DO NOTHING",
            params![ulid::Ulid::generate().to_string(), now_ms()],
        )?;
        Ok(Self { dir, conn })
    }

    pub fn info(&self) -> Result<NotebookInfo> {
        let (id, created_at) = self.conn.query_row(
            "SELECT id, created_at FROM notebook WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(NotebookInfo {
            id,
            path: self.dir.clone(),
            created_at,
            schema_version: SCHEMA_VERSION,
            sqlite_version: rusqlite::version().to_string(),
        })
    }
}

pub(crate) fn now_ms() -> i64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after 1970");
    i64::try_from(elapsed.as_millis()).expect("timestamp fits in i64")
}
