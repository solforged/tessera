//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

pub mod calendar;
pub mod capabilities;
pub mod card_text;
mod error;
mod fields;
mod migrate;
mod model;
mod notebook;
mod operations;
mod query;
mod reads;
pub mod scheduler;
mod settings;
mod storage;

pub use capabilities::{
    Agenda, AgendaItem, AgendaReason, BlockCapabilities, CardQuery, CardQueryResult, CardRow,
    CardSelection, CardUnit, DateRange, Deck, ProjectRecord, ProjectState, ProjectStatus,
    ReviewEvent, ReviewEventKind, ReviewSession, ReviewSessionState, TaskFilter, TaskOccurrence,
    TaskPriority, TaskQuery, TaskQueryResult, TaskRecord, TaskRow, TaskSelection, TaskState,
    TaskStatus, WorkSession,
};
pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockInPage, BlockKind, ChangeEvent, Committed, Direction,
    FieldDefinition, FieldKind, FieldOption, FieldSummary, FieldType, FieldValue, FieldsView,
    Filter, FilterOp, Operation, PageView, Query, QueryResult, QueryRow, Reading, ReadingValue,
    Revision, Row, Setting, SettingRevision, SettingsView, SortBy, SortKey, TextRewrite, TypeInfo,
    View,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo};
