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
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
