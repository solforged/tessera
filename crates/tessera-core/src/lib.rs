//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod error;
mod migrate;
mod notebook;

pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo};
