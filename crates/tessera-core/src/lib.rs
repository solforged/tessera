//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod error;
mod fields;
mod migrate;
mod model;
mod notebook;
mod operations;
mod query;
mod reads;
mod storage;

pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockInPage, BlockKind, ChangeEvent, Committed, Direction,
    FieldDefinition, FieldKind, FieldOption, FieldSummary, FieldType, FieldValue, FieldsView,
    Filter, FilterOp, Operation, PageView, Query, QueryResult, QueryRow, Reading, ReadingValue,
    Revision, Row, SortBy, SortKey, TextRewrite, TypeInfo, View,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo};
