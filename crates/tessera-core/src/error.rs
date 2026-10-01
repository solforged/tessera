use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot create notebook directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(
        "notebook schema version {found} is newer than this build supports ({supported}); upgrade Tessera"
    )]
    SchemaTooNew { found: u32, supported: u32 },
    /// An operation was based on a revision that is no longer current. The
    /// whole batch wrote nothing. `found` is `None` when the block is gone.
    #[error(
        "operation {op_index} is stale for block {id}: expected revision {expected}, found {found:?}"
    )]
    Conflict {
        op_index: usize,
        id: String,
        expected: i64,
        found: Option<i64>,
    },
    #[error("block {id} not found (operation {op_index:?})")]
    NotFound { id: String, op_index: Option<usize> },
    /// The request breaks a domain rule. The whole batch wrote nothing.
    #[error("{message} (operation {op_index:?})")]
    Validation {
        message: String,
        op_index: Option<usize>,
    },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
