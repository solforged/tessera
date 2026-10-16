//! Tessera's domain rules and storage. Clients use [`Notebook`]; nothing else
//! writes to the database.

mod agent;
mod aliases;
mod backup;
mod built_in;
pub mod calendar;
pub mod capabilities;
mod card_query;
mod card_store;
mod card_templates;
pub mod card_text;
mod entity_query;
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
mod note_query;
mod notebook;
mod notes;
mod notes_summary;
mod operations;
mod ownership;
mod position_store;
mod query;
pub mod question_store;
mod quote_store;
mod reads;
mod references;
mod relation_store;
pub mod replication;
mod resurface;
mod review_store;
mod revisit_store;
pub mod scheduler;
mod settings;
mod spans;
mod spreads;
mod storage;
mod streams;
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
    TaskOccurrence, TaskPriority, TaskProjectVia, TaskQuery, TaskQueryResult, TaskRecord, TaskRow,
    TaskSelection, TaskSort, TaskState, TaskStatus, TaskView, WorkSession,
};
pub use capabilities::{
    AssessmentInfo, AssessmentState, CurrentReading, QuestionFilter, QuestionInfo, QuestionQuery,
    QuestionRow, QuestionState, QuestionStatus, ReadingDecision, ReadingStatus,
};
pub use capabilities::{RelationEndpoint, RelationInfo, RelationKind, RelationQuery, RelationRow};
pub use card_templates::{
    CardTemplate, CardTemplateForecast, CardTemplateInfo, CardTemplatePreview,
    CardTemplateProvenance, CardTemplateWaiting, TemplateLoadDay,
};
pub use error::{Error, Result};
pub use fields::SOURCE_TARGET;
pub use migrate::SCHEMA_VERSION;
pub use model::{
    Actor, Backlink, Batch, Block, BlockInPage, BlockKind, ChangeEvent, ChangeStamp, Committed,
    CountsAs, Direction, FieldChoiceCandidate, FieldChoiceValue, FieldDefinition, FieldDetail,
    FieldHide, FieldInterpretation, FieldKind, FieldOption, FieldOptionUse, FieldOwner,
    FieldOwnerValues, FieldRole, FieldSummary, FieldTemplate, FieldType, FieldValue, FieldValueUse,
    FieldsView, Filter, FilterOp, IncomingFieldValue, KeptCopy, NoteGroup, NoteLayout, NoteView,
    Operation, PageView, Query, QueryAttribute, QueryAttributeValue, QueryColumn, QueryGroup,
    QueryGrouping, QueryResult, QueryRow, QuerySource, QuoteState, QuoteStatus, QuotedRow, Reading,
    ReadingValue, RequiredField, Revision, Row, Setting, SettingRevision, SettingsView, SortBy,
    SortKey, Subtree, TextRewrite, TypeInfo, View, YearSpan,
};
pub use notebook::{DATABASE_FILE, Notebook, NotebookInfo, now_ms};
pub use notes::{
    CrossReference, IndexKind, KindIndex, NoteEntry, NoteIndex, NoteKind, SeeTarget, Shelf,
};
pub use notes_summary::{NoteSummary, SourceSummary, SummaryField};
pub use ownership::NotebookOwnership;
pub use position_store::{NO_HOLDER, NOT_ENTITY};
pub use reads::DeletedPage;
pub use references::{
    Mention, PageReferences, ReferenceCount, ReferenceGroup, ReferenceSource, UnlinkedMentions,
};
pub use review_store::{ReviewForecastDay, ReviewStats};
pub use revisit_store::{NoteState, RevisitAction, RevisitEvent, RevisitRow, RevisitSnapshot};
pub use spreads::{Spread, SpreadColumn, SpreadField, SpreadReference, SpreadValue};
pub use streams::{BatchSubtree, BatchSubtrees, StreamArrival};
