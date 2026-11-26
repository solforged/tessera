use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::Result;
use crate::migrate::{SCHEMA_VERSION, migrate};

/// File name of the database inside a workshop directory.
pub const DATABASE_FILE: &str = "notebook.db";

/// A workshop directory and its open SQLite connection.
///
/// All reads and writes go through methods on this type, so every client
/// gets the same rules.
pub struct Workshop {
    pub(crate) dir: PathBuf,
    pub(crate) conn: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
pub struct WorkshopInfo {
    pub id: String,
    pub path: PathBuf,
    pub created_at: i64,
    pub schema_version: u32,
    pub sqlite_version: String,
}

impl Workshop {
    /// Open the workshop in `dir`, creating the directory and an empty
    /// workshop if none exists. An existing workshop is migrated forward,
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
             ) STRICT",
        )?;
        conn.execute(
            "INSERT INTO notebook (singleton, id, created_at) VALUES (1, ?1, ?2)
             ON CONFLICT (singleton) DO NOTHING",
            params![new_ulid().to_string(), now_ms()],
        )?;
        conn.execute(
            "INSERT INTO replica (singleton, device_id) VALUES (1, ?1)
             ON CONFLICT (singleton) DO NOTHING",
            [new_ulid().to_string()],
        )?;
        let mut workshop = Self { dir, conn };
        workshop.backfill_library_creators()?;
        workshop.backfill_citation_keys()?;
        workshop.ensure_built_in_fields()?;
        Ok(workshop)
    }

    /// A second, read-only connection to this workshop. A write through it is
    /// refused, so a read that secretly writes fails instead of racing the
    /// writer. WAL lets it read while the writer commits.
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pub fn reader(&self) -> Result<Reader> {
        let conn = Connection::open(self.dir.join(DATABASE_FILE))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "query_only", true)?;
        Ok(Reader(Self {
            dir: self.dir.clone(),
            conn,
        }))
    }

    /// This device's ID, recorded as the origin of the changes it makes.
    pub fn device_id(&self) -> Result<String> {
        Ok(self.conn.query_row(
            "SELECT device_id FROM replica WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn info(&self) -> Result<WorkshopInfo> {
        let (id, created_at) = self.conn.query_row(
            "SELECT id, created_at FROM notebook WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(WorkshopInfo {
            id,
            path: self.dir.clone(),
            created_at,
            schema_version: SCHEMA_VERSION,
            sqlite_version: rusqlite::version().to_string(),
        })
    }
}

/// A read-only connection beside a workshop's writer, from
/// [`Workshop::reader`].
pub struct Reader(Workshop);

impl Reader {
    /// Run `operation` against one snapshot of the workshop: a commit that
    /// lands while it runs is not seen halfway through.
    pub fn read<T>(&self, operation: impl FnOnce(&Workshop) -> Result<T>) -> Result<T> {
        let snapshot = self.0.conn.unchecked_transaction()?;
        let result = operation(&self.0);
        // Nothing was written, so ending the snapshot cannot lose anything.
        drop(snapshot);
        result
    }

    /// Clear cached statements after an in-place clone replacement.
    pub fn flush(&mut self) {
        self.0.conn.flush_prepared_statement_cache();
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

/// An ID that every device computes the same way from `parts`, shaped like a
/// ULID so it mixes with client-chosen IDs. Callers name what the ID is for
/// in the first part, so different kinds of record never collide.
pub(crate) fn derived_id(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"tessera-id-v1");
    for part in parts {
        // Length-prefix each part so ("ab", "c") and ("a", "bc") differ.
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    ulid::Ulid::from_bytes(bytes).to_string()
}
