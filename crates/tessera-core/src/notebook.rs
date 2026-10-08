use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::Result;
use crate::migrate::{SCHEMA_VERSION, migrate};

/// File name of the database inside a notebook directory.
pub const DATABASE_FILE: &str = "notebook.db";

/// A notebook directory and its open SQLite connection.
///
/// All reads and writes go through methods on this type, so every client
/// gets the same rules.
pub struct Notebook {
    pub(crate) dir: PathBuf,
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
        // Browsers have no directories; the path names a file in SQLite's VFS.
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let dir = {
            std::fs::create_dir_all(dir).map_err(|source| crate::error::Error::CreateDir {
                path: dir.to_path_buf(),
                source,
            })?;
            std::fs::canonicalize(dir).map_err(|source| crate::error::Error::CreateDir {
                path: dir.to_path_buf(),
                source,
            })?
        };
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        let dir = dir.to_path_buf();
        let mut conn = Connection::open(dir.join(DATABASE_FILE))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // FULL: an acknowledged commit survives power loss, not just a crash.
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        // Source objects are files natively; a browser keeps them in the database.
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS browser_objects (
                 sha256 TEXT PRIMARY KEY,
                 bytes BLOB NOT NULL
             )",
        )?;
        conn.execute(
            "INSERT INTO notebook (singleton, id, created_at) VALUES (1, ?1, ?2)
             ON CONFLICT (singleton) DO NOTHING",
            params![new_ulid().to_string(), now_ms()],
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

/// The current Unix time in milliseconds, using the browser clock on wasm.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after 1970");
    i64::try_from(elapsed.as_millis()).expect("timestamp fits in i64")
}

/// The current Unix time in milliseconds, using the browser clock on wasm.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn new_ulid() -> ulid::Ulid {
    ulid::Ulid::generate()
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub(crate) fn new_ulid() -> ulid::Ulid {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).expect("browser crypto is available");
    ulid::Ulid::from_parts(now_ms() as u64, u128::from_le_bytes(random))
}
