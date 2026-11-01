use std::fmt;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot create workshop directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(
        "workshop schema version {found} is newer than this build supports ({supported}); upgrade Tessera"
    )]
    SchemaTooNew { found: u32, supported: u32 },
    /// SQLite's `quick_check` found the file damaged; nothing was copied.
    #[error("database {path} fails SQLite's quick_check: {problems}")]
    Corrupt { path: PathBuf, problems: String },
    /// An operation was based on a revision that is no longer current. The
    /// whole batch wrote nothing. `found` is `None` when the record is gone.
    /// `what` names the kind of record, as in `NotFound`.
    #[error(
        "operation {op_index} is stale for {what} {id}: expected revision {expected}, {}",
        Found(.found)
    )]
    Conflict {
        op_index: usize,
        what: &'static str,
        id: String,
        expected: i64,
        found: Option<i64>,
    },
    /// `what` names the kind of record: "atom" for blocks, or "change",
    /// "passage", "card", "deck" and so on.
    #[error("{what} {id} not found{}", Operation(.op_index))]
    NotFound {
        what: &'static str,
        id: String,
        op_index: Option<usize>,
    },
    /// The request breaks a domain rule. The whole batch wrote nothing.
    #[error("{message}{}", Operation(.op_index))]
    Validation {
        message: String,
        op_index: Option<usize>,
    },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("workshop I/O: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The revision a stale operation found instead of the one it expected.
struct Found<'a>(&'a Option<i64>);

impl fmt::Display for Found<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(revision) => write!(f, "found revision {revision}"),
            None => f.write_str("but it no longer exists"),
        }
    }
}

/// The batch position a refusal came from, when it came from one.
struct Operation<'a>(&'a Option<usize>);

impl fmt::Display for Operation<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(index) => write!(f, " (operation {index})"),
            None => Ok(()),
        }
    }
}
