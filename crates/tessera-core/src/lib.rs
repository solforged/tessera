//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod error;
mod migrate;
mod model;
mod notebook;
mod operations;
mod reads;
mod storage;

pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockKind, Change, Committed, Operation, PageView, Revision,
    Row, SearchHit,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo};
