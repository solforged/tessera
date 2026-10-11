//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod agent;
mod backup;
pub mod calendar;
pub mod capabilities;
mod card_query;
mod card_store;
pub mod card_text;
mod error;
mod fields;
pub mod library;
mod library_export;
mod library_ingest;
mod library_jobs;
mod library_reads;
mod library_store;
mod library_views;
mod migrate;
mod model;
mod notebook;
mod notes;
mod operations;
mod ownership;
mod position_store;
mod query;
pub mod question_store;
mod reads;
pub mod replication;
mod resurface;
mod review_store;
pub mod scheduler;
mod settings;
mod storage;
mod task_query;
mod task_store;
mod work_store;

pub use agent::{
    AgentChange, AgentEdit, AgentReceipt, AgentRequest, NoteBlock, NoteTarget, UndoReceipt,
};
pub use backup::{BackupManifest, backup, backup_beside, backup_directory, restore};
pub use capabilities::{
    Agenda, AgendaItem, AgendaReason, BlockCapabilities, CardAnswerBlock, CardPreviews, CardQuery,
    CardQueryResult, CardRow, CardSelection, CardUnit, DateRange, Deck, GradePreview, PositionInfo,
    PositionQuery, PositionRow, ProjectRecord, ProjectState, ProjectStatus, ReviewEvent,
    ReviewEventKind, ReviewSchedulingState, ReviewSession, ReviewSessionState, TaskFilter,
    TaskOccurrence, TaskPriority, TaskQuery, TaskQueryResult, TaskRecord, TaskRow, TaskSelection,
    TaskState, TaskStatus, TaskView, WorkSession,
};
pub use capabilities::{
    AssessmentInfo, AssessmentState, QuestionInfo, QuestionQuery, QuestionRow, QuestionState,
    QuestionStatus,
};
pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockInPage, BlockKind, ChangeEvent, ChangeStamp, Committed,
    Direction, FieldDefinition, FieldKind, FieldOption, FieldSummary, FieldType, FieldValue,
    FieldsView, Filter, FilterOp, Operation, PageView, Query, QueryResult, QueryRow, Reading,
    ReadingValue, Revision, Row, Setting, SettingRevision, SettingsView, SortBy, SortKey,
    TextRewrite, TypeInfo, View,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo, now_ms};
pub use notes::{IndexKind, NoteEntry, NoteIndex, NoteKind};
pub use ownership::NotebookOwnership;
