//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod agent;
mod aliases;
mod backup;
pub mod calendar;
pub mod capabilities;
mod card_query;
mod card_store;
mod card_templates;
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
mod notes_summary;
mod operations;
mod ownership;
mod position_store;
mod query;
pub mod question_store;
mod reads;
mod references;
pub mod replication;
mod resurface;
mod review_store;
pub mod scheduler;
mod settings;
mod storage;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub mod sync;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod sync_apply;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub mod sync_devices;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod sync_library;
mod task_query;
mod task_store;
mod unlogged;
mod work_store;

pub use agent::{
    AgentChange, AgentCitation, AgentEdit, AgentReceipt, AgentRequest, NoteBlock, NoteTarget,
    UndoReceipt,
};
pub use aliases::{Completion, NameMatch};
pub use backup::{BackupManifest, backup, backup_beside, backup_directory, restore};
pub use capabilities::{
    Agenda, AgendaItem, AgendaReason, BlockCapabilities, CardAnswerBlock, CardPreviews, CardQuery,
    CardQueryResult, CardRow, CardSelection, CardUnit, DateRange, Deck, GradePreview,
    PositionField, PositionInfo, PositionQuery, PositionQueryResult, PositionQuestion, PositionRow,
    ProjectRecord, ProjectState, ProjectStatus, ReviewEvent, ReviewEventKind,
    ReviewSchedulingState, ReviewSession, ReviewSessionState, SubjectCriteria, TaskFilter,
    TaskOccurrence, TaskPriority, TaskQuery, TaskQueryResult, TaskRecord, TaskRow, TaskSelection,
    TaskState, TaskStatus, TaskView, WorkSession,
};
pub use capabilities::{
    AssessmentInfo, AssessmentState, QuestionInfo, QuestionQuery, QuestionRow, QuestionState,
    QuestionStatus,
};
pub use card_templates::{
    CardTemplate, CardTemplateForecast, CardTemplateInfo, CardTemplatePreview,
    CardTemplateProvenance, CardTemplateWaiting, TemplateLoadDay,
};
pub use error::{Error, Result};
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockInPage, BlockKind, ChangeEvent, ChangeStamp, Committed,
    Direction, FieldDefinition, FieldDetail, FieldKind, FieldOption, FieldOptionUse, FieldOwner,
    FieldOwnerValues, FieldSummary, FieldTemplate, FieldType, FieldValue, FieldValueUse,
    FieldsView, Filter, FilterOp, KeptCopy, Operation, PageView, Query, QueryResult, QueryRow,
    Reading, ReadingValue, Revision, Row, Setting, SettingRevision, SettingsView, SortBy, SortKey,
    TextRewrite, TypeInfo, View,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo, now_ms};
pub use notes::{CrossReference, IndexKind, KindIndex, NoteEntry, NoteIndex, NoteKind, SeeTarget};
pub use notes_summary::{NoteSummary, SourceSummary, SummaryField};
pub use ownership::NotebookOwnership;
pub use references::{
    Mention, PageReferences, ReferenceCount, ReferenceGroup, ReferenceSource, UnlinkedMentions,
};
pub use review_store::{ReviewForecastDay, ReviewStats};
