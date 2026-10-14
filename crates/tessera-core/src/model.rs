//! Types shared by every client: the blocks they read and the operations they
//! submit. Every write is a [`Batch`] of [`Operation`]s committed in one
//! transaction; nothing else changes a notebook.

use serde::{Deserialize, Serialize};

use crate::capabilities::{
    BlockCapabilities, CardQuery, ProjectState, ReviewSession, ReviewSessionState, TaskQuery,
    TaskState, WorkSession,
};
use crate::library::{PassagePoint, SourceState};
use crate::scheduler::Grade;
use crate::{AssessmentState, QuestionState, RelationKind};

/// What a block is. Pages and journal days are roots; everything else has a
/// parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Block,
    Page,
    Journal,
}

/// One live block as stored. A root's text is its title; a journal root's
/// text is its date in `YYYY-MM-DD` form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub kind: BlockKind,
    pub parent_id: Option<String>,
    pub page_id: String,
    pub text: String,
    /// Heading level 1 to 3.
    pub heading: Option<u8>,
    pub archived: bool,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub kept_copy: Option<KeptCopy>,
}

/// A live, unsettled version kept beside its original by sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptCopy {
    pub of: String,
    pub origin: String,
    pub origin_name: Option<String>,
    pub mine: bool,
}

/// Who committed a batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Actor {
    Person,
    Agent { name: String },
    Client { name: String },
}

/// One outline operation. IDs of new blocks are chosen by the client (ULIDs),
/// so a retried creation can be recognised instead of duplicated. Every
/// operation on an existing block names the revision it was based on; a
/// mismatch fails the whole batch and writes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Operation {
    SettleSyncCopy {
        id: String,
        settled: bool,
    },
    SettleSyncRejection {
        id: String,
        settled: bool,
    },
    SetSource {
        id: String,
        base_revision: i64,
        source: Option<SourceState>,
    },
    AttachSnapshot {
        id: String,
        base_revision: i64,
        snapshot_id: String,
    },
    Cite {
        id: String,
        base_revision: i64,
        citation_id: String,
        snapshot_id: String,
        start: PassagePoint,
        end: PassagePoint,
        #[serde(default)]
        color: Option<String>,
    },
    Uncite {
        id: String,
        base_revision: i64,
        citation_id: String,
    },
    SetCitationTriage {
        id: String,
        base_revision: i64,
        triage: Option<String>,
    },
    SetCitationColor {
        id: String,
        base_revision: i64,
        color: Option<String>,
    },
    SetCitationRange {
        id: String,
        base_revision: i64,
        start: PassagePoint,
        end: PassagePoint,
    },
    /// Create a named root. Titles are unique among live pages, ignoring case.
    CreatePage {
        id: String,
        title: String,
    },
    /// Create the root for one calendar day. Dates are unique among live
    /// journal roots.
    CreateJournal {
        id: String,
        date: String,
    },
    /// Insert a new block under `parent_id`, after the sibling `after`, or
    /// first when `after` is `None`.
    Insert {
        id: String,
        parent_id: String,
        after: Option<String>,
        text: String,
        heading: Option<u8>,
    },
    /// Replace a block's text. On a page root this renames the page.
    EditText {
        id: String,
        base_revision: i64,
        text: String,
    },
    SetHeading {
        id: String,
        base_revision: i64,
        heading: Option<u8>,
    },
    CreateCardTemplate {
        id: String,
        type_id: String,
        name: String,
        front: String,
        back: String,
        new_per_day: u32,
    },
    UpdateCardTemplate {
        id: String,
        base_revision: i64,
        name: String,
        front: String,
        back: String,
        new_per_day: u32,
    },
    SetCardTemplateApplied {
        id: String,
        base_revision: i64,
        applied: bool,
    },
    DeleteCardTemplate {
        id: String,
        base_revision: i64,
    },
    /// Split a block in two. `left + right` must equal the current text. The
    /// original ID keeps `left` and its children; `new_id` becomes the next
    /// sibling with `right`.
    Split {
        id: String,
        base_revision: i64,
        new_id: String,
        left: String,
        right: String,
    },
    /// Append `source`'s text to `destination`, move its children to the end
    /// of `destination`'s children, and delete `source` under a new deletion
    /// event. The destination keeps its ID.
    Merge {
        source_id: String,
        source_revision: i64,
        destination_id: String,
        destination_revision: i64,
    },
    /// Permanently combine two ordinary pages. Redirect incoming references,
    /// append children (coalescing matching field entries), and tombstone the
    /// source. Sources, journal days and the Fields page cannot be endpoints.
    MergePage {
        source_id: String,
        source_revision: i64,
        destination_id: String,
        destination_revision: i64,
    },
    /// Move a block and its subtree under `parent_id`, after `after` (first
    /// when `None`). Indent and outdent are moves. The ID never changes.
    Move {
        id: String,
        base_revision: i64,
        parent_id: String,
        after: Option<String>,
    },
    /// Tombstone a block and its whole subtree under one new deletion event.
    Delete {
        id: String,
        base_revision: i64,
    },
    /// Bring back exactly the rows that `deletion_id` tombstoned in this
    /// block's subtree. `revision` is the block's revision after deletion.
    Restore {
        id: String,
        deletion_id: String,
        revision: i64,
    },
    SetArchived {
        id: String,
        base_revision: i64,
        archived: bool,
    },
    AddType {
        id: String,
        base_revision: i64,
        title: String,
    },
    RemoveType {
        id: String,
        base_revision: i64,
        title: String,
    },
    SetFieldKind {
        id: String,
        base_revision: i64,
        kind: FieldKind,
    },
    SetFieldHide {
        id: String,
        base_revision: i64,
        hide: FieldHide,
    },
    SetFieldRole {
        id: String,
        base_revision: i64,
        role: FieldRole,
    },
    SetFieldTargets {
        id: String,
        base_revision: i64,
        targets: Vec<String>,
    },
    SetTypeFields {
        type_id: String,
        base_revision: i64,
        fields: Vec<String>,
    },
    SetTypePresentation {
        type_id: String,
        base_revision: i64,
        plural: Option<String>,
        icon: Option<String>,
    },
    SetSubjectCriteria {
        subject_id: String,
        base_revision: i64,
        fields: Vec<String>,
    },
    SaveView {
        id: String,
        base_revision: Option<i64>,
        name: String,
        query: Query,
    },
    DeleteView {
        id: String,
        base_revision: i64,
    },
    SetSetting {
        key: String,
        base_revision: Option<i64>,
        value: String,
    },
    SetTask {
        id: String,
        base_revision: i64,
        task: Option<TaskState>,
    },
    /// Restore a checked metadata snapshot without inventing a completion.
    RestoreTaskState {
        id: String,
        base_revision: i64,
        expected: TaskState,
        task: TaskState,
    },
    CompleteTask {
        id: String,
        base_revision: i64,
        occurrence_id: String,
        completed_on: String,
    },
    ReverseTaskCompletion {
        id: String,
        base_revision: i64,
        occurrence_id: String,
    },
    SetProject {
        id: String,
        base_revision: i64,
        project: Option<ProjectState>,
    },
    SetPosition {
        id: String,
        base_revision: i64,
        position: bool,
    },
    SetRelation {
        id: String,
        base_revision: i64,
        relation: Option<RelationKind>,
    },
    SetSpread {
        id: String,
        base_revision: i64,
        spread: bool,
    },
    Revisit {
        id: String,
        base_revision: i64,
        action: crate::RevisitAction,
        next_on: Option<String>,
        event_id: Option<String>,
    },
    RestoreRevisit {
        id: String,
        base_revision: i64,
        state: crate::RevisitSnapshot,
        event_id: Option<String>,
    },
    SetQuote {
        id: String,
        base_revision: i64,
        quote: Option<QuoteState>,
    },
    SetQuestion {
        id: String,
        base_revision: i64,
        question: Option<QuestionState>,
    },
    SetAssessment {
        id: String,
        base_revision: i64,
        assessment: Option<AssessmentState>,
    },
    StartWork {
        id: String,
        base_revision: i64,
        session_id: String,
        started_at: i64,
        note: String,
    },
    StopWork {
        id: String,
        base_revision: i64,
        session_id: String,
        session_revision: i64,
        ended_at: i64,
        note: String,
    },
    EditWorkNote {
        id: String,
        base_revision: i64,
        session_id: String,
        session_revision: i64,
        note: String,
    },
    SetWorkSessionState {
        id: String,
        base_revision: i64,
        session_id: String,
        session_revision: i64,
        ended_at: Option<i64>,
        reversed: bool,
    },
    StartReviewSession {
        id: String,
        deck_id: Option<String>,
        started_at: i64,
    },
    FinishReviewSession {
        id: String,
        base_revision: i64,
        state: ReviewSessionState,
        ended_at: i64,
    },
    GradeCard {
        id: String,
        base_revision: i64,
        definition_revision: i64,
        event_id: String,
        session_id: Option<String>,
        grade: Grade,
        reset: bool,
        shown_front: String,
        shown_back: String,
        reviewed_at: i64,
    },
    UndoGrade {
        id: String,
        base_revision: i64,
        review_id: String,
        event_id: String,
        session_revision: Option<i64>,
        undone_at: i64,
    },
    SetCardHeld {
        id: String,
        base_revision: i64,
        held: bool,
    },
    ResetCard {
        id: String,
        base_revision: i64,
        event_id: String,
        session_id: Option<String>,
        reviewed_at: i64,
    },
    SaveDeck {
        id: String,
        base_revision: Option<i64>,
        name: String,
        query: CardQuery,
    },
    DeleteDeck {
        id: String,
        base_revision: i64,
    },
    SaveTaskView {
        id: String,
        base_revision: Option<i64>,
        name: String,
        query: TaskQuery,
    },
    DeleteTaskView {
        id: String,
        base_revision: i64,
    },
    SaveLibraryView {
        id: String,
        base_revision: Option<i64>,
        name: String,
        query: crate::library::LibraryQuery,
    },
    DeleteLibraryView {
        id: String,
        base_revision: i64,
    },
}

/// Operations committed together or not at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub actor: Actor,
    #[serde(default)]
    pub reason: Option<String>,
    /// Retrying a batch with the same key and the same operations returns
    /// the original result without applying it again. The same key with
    /// different operations is rejected.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub operations: Vec<Operation>,
}

/// A change's global identity: its ID, the device that made it and the time
/// that device made it. Applying the same batch with the same stamp to the
/// same state gives the same result on every device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeStamp {
    pub id: String,
    pub origin: String,
    /// Unix milliseconds; every timestamp the change writes.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    pub id: String,
    pub revision: i64,
}

/// A source considered for automatic tag rewriting during a page rename.
/// Equal-text entries are revision-checked spelling guards for undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRewrite {
    pub id: String,
    pub before: String,
    pub after: String,
    pub revision: i64,
}

/// The result of a committed batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Committed {
    /// Position in the notebook's change sequence.
    pub seq: i64,
    /// The resulting revision of every block the batch changed, in first-
    /// touched order.
    pub revisions: Vec<Revision>,
    /// Touched blocks that are no longer live after the batch, including
    /// provisional pages removed by derivation.
    #[serde(default)]
    pub removed: Vec<String>,
    /// Deletion events created by `Delete` and `Merge`, in operation order.
    pub deletions: Vec<String>,
    /// Incoming-tag sources considered by a rename, including equal-text
    /// guards needed to preserve exact spelling on undo.
    /// Older persisted receipts predate tag rewriting.
    #[serde(default)]
    pub text_rewrites: Vec<TextRewrite>,
    /// Resulting revisions of settings, which are not blocks.
    #[serde(default)]
    pub settings: Vec<SettingRevision>,
    #[serde(default)]
    pub capabilities: Vec<BlockCapabilities>,
    #[serde(default)]
    pub cards: Vec<Revision>,
    #[serde(default)]
    pub work_sessions: Vec<WorkSession>,
    #[serde(default)]
    pub review_sessions: Vec<ReviewSession>,
    #[serde(default)]
    pub decks: Vec<Revision>,
    #[serde(default)]
    pub task_views: Vec<Revision>,
    #[serde(default)]
    pub library_views: Vec<Revision>,
    /// True when this is the stored result of an earlier identical batch.
    pub replayed: bool,
}

/// A block in a page, in reading (preorder) order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub block: Block,
    /// 0 for the root's children.
    pub depth: u32,
    pub manual_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subtree {
    /// Includes the root at depth 0, followed by its visible descendants.
    pub rows: Vec<Row>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotedRow {
    pub id: String,
    pub depth: u32,
    pub text: String,
    pub heading: Option<u8>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuoteState {
    pub target_id: String,
    pub captured_at: i64,
    pub rows: Vec<QuotedRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuoteStatus {
    pub block_id: String,
    pub source_live: bool,
    pub changed: bool,
}

/// Everything needed to show one page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageView {
    pub root: Block,
    /// Explicit tags on the page itself, separate from descendant memberships.
    #[serde(default)]
    pub root_manual_types: Vec<String>,
    /// Live descendants in preorder, including archived ones (flagged).
    pub rows: Vec<Row>,
    /// Live blocks outside this page that its rows reference, and the pages
    /// named by its tags. A missing reference target is unresolved.
    pub targets: Vec<Block>,
    #[serde(default)]
    pub capabilities: Vec<BlockCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backlink {
    pub source: Block,
    pub page: Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockInPage {
    pub block: Block,
    pub page: Block,
}

/// One committed batch, for clients catching up after `seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub seq: i64,
    pub actor: Actor,
    pub reason: Option<String>,
    pub created_at: i64,
    /// Current live state, not a historical snapshot.
    pub blocks: Vec<Block>,
    /// Touched IDs that are no longer live.
    pub removed: Vec<String>,
    /// Pages whose order or nesting changed, recorded when the batch applied.
    pub restructured_pages: Vec<String>,
    /// Views saved or deleted by this change; clients reload their view list.
    #[serde(default)]
    pub views: Vec<String>,
    /// Settings changed by this batch; clients reload their settings.
    #[serde(default)]
    pub settings: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<BlockCapabilities>,
    #[serde(default)]
    pub cards: Vec<String>,
    #[serde(default)]
    pub work_sessions: Vec<String>,
    #[serde(default)]
    pub review_sessions: Vec<String>,
    #[serde(default)]
    pub decks: Vec<String>,
    #[serde(default)]
    pub task_views: Vec<String>,
    #[serde(default)]
    pub library_views: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Number,
    Date,
    Span,
    Checkbox,
    Choice,
    Instance,
    /// An absolute `http` or `https` address.
    Url,
    /// An ISBN, DOI or arXiv ID, read in a normalized `scheme:value` form.
    Identifier,
}

impl FieldKind {
    pub const ALL: [Self; 9] = [
        Self::Text,
        Self::Number,
        Self::Date,
        Self::Span,
        Self::Checkbox,
        Self::Choice,
        Self::Instance,
        Self::Url,
        Self::Identifier,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Date => "date",
            Self::Span => "span",
            Self::Checkbox => "checkbox",
            Self::Choice => "choice",
            Self::Instance => "instance",
            Self::Url => "url",
            Self::Identifier => "identifier",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldHide {
    #[default]
    Never,
    WhenEmpty,
    Always,
}

impl FieldHide {
    pub const ALL: [Self; 3] = [Self::Never, Self::WhenEmpty, Self::Always];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::WhenEmpty => "when_empty",
            Self::Always => "always",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|hide| hide.as_str() == value)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldRole {
    Standfirst,
    #[default]
    Attribute,
    Prose,
    Citation,
}

impl FieldRole {
    pub const ALL: [Self; 4] = [
        Self::Standfirst,
        Self::Attribute,
        Self::Prose,
        Self::Citation,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standfirst => "standfirst",
            Self::Attribute => "attribute",
            Self::Prose => "prose",
            Self::Citation => "citation",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Is,
    IsNot,
    Contains,
    Gt,
    Gte,
    Lt,
    Lte,
    Overlaps,
    Before,
    After,
    Present,
    Set,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub or_empty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    Title,
    Created,
    Updated,
    Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortKey {
    pub by: SortBy,
    pub field: Option<String>,
    pub direction: Direction,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuerySource {
    #[default]
    Notes,
    Questions,
    Positions,
    Sources,
    Tasks,
    Highlights,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryLayout {
    #[default]
    Table,
    Register,
    Matrix,
    Desk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryColumn {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryGrouping {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskQuery {
    pub positions: Query,
    pub sources: Query,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Query {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<QuerySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<QueryLayout>,
    pub r#type: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
    pub limit: Option<usize>,
    /// Rows skipped after sorting; total and column metadata cover all matches.
    #[serde(default)]
    pub offset: usize,
    /// Restrict to titled notes of this finding-aid kind, including capability kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cites: Vec<String>,
    /// Presentation travels in the existing saved query JSON, not a second view store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_view: Option<NoteView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<QueryColumn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<QueryGrouping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desk: Option<Box<DeskQuery>>,
    /// Remembered labels for references left behind by field detachment or deletion.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub field_names: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteView {
    pub layout: NoteLayout,
    /// letter, source, link, created, or field:<definition id>.
    pub grouping: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteLayout {
    Index,
    Table,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteGroup {
    pub key: String,
    pub title: String,
    pub target: Option<String>,
    pub siglum: Option<String>,
    pub note_ids: Vec<String>,
}

/// Inclusive historical years; missing bounds are open, and BCE years are negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct YearSpan {
    pub from: Option<i32>,
    pub through: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReadingValue {
    Text(String),
    Number(f64),
    Checkbox(bool),
    Span(YearSpan),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Reading {
    Value {
        ok: bool,
        value: ReadingValue,
        target: Option<String>,
    },
    Problem {
        ok: bool,
        problem: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldValue {
    pub id: String,
    pub text: String,
    pub reading: Reading,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryAttributeValue {
    pub text: String,
    pub reading: Reading,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryAttribute {
    pub key: String,
    pub name: String,
    pub kind: FieldKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryGroup {
    pub key: String,
    pub title: String,
    pub target: Option<String>,
    pub row_ids: Vec<String>,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryRow {
    pub block: BlockInPage,
    pub values: std::collections::BTreeMap<String, Vec<FieldValue>>,
    #[serde(default)]
    pub attributes: std::collections::BTreeMap<String, Vec<QueryAttributeValue>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDefinition {
    pub id: String,
    pub name: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub hide: FieldHide,
    #[serde(default)]
    pub role: FieldRole,
    pub archived: bool,
    pub revision: i64,
    pub options: Vec<FieldOption>,
    #[serde(default)]
    pub targets: Vec<String>,
    /// Created by the app and named by it: the name cannot change except in case.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub built_in: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryResult {
    pub fields: Vec<FieldDefinition>,
    pub columns: Vec<String>,
    pub rows: Vec<QueryRow>,
    pub total: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub note_groups: Vec<NoteGroup>,
    #[serde(default)]
    pub attributes: Vec<QueryAttribute>,
    #[serde(default)]
    pub groups: Vec<QueryGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub id: String,
    pub name: String,
    pub query: Query,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypeInfo {
    pub page: Block,
    pub plural: Option<String>,
    pub icon: Option<String>,
    pub fields: Vec<String>,
    pub members: usize,
    pub card_templates: usize,
    /// Template fields the type's built-in schema requires, in template order.
    #[serde(default)]
    pub required: Vec<RequiredField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredField {
    pub field_id: String,
    /// Members with no nonblank value for the field.
    pub missing: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldsView {
    pub page_id: String,
    pub fields: Vec<FieldSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldSummary {
    #[serde(flatten)]
    pub definition: FieldDefinition,
    pub owners: usize,
    pub types: Vec<FieldType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldType {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldOwner {
    pub id: String,
    pub text: String,
    pub page_id: String,
    pub page_title: String,
}

/// A relation field value pointing at a block, read from the target's side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomingFieldValue {
    pub field_id: String,
    pub field_name: String,
    pub owner: FieldOwner,
    pub value_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldOwnerValues {
    pub owner: FieldOwner,
    /// The first entry in outline order when this owner has several entries.
    pub entry_id: String,
    pub values: Vec<FieldValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldValueUse {
    pub owner: FieldOwner,
    pub entry_id: String,
    pub value: FieldValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldTemplate {
    pub type_id: String,
    pub name: String,
    pub position: usize,
    pub members: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldOptionUse {
    pub option_id: String,
    pub uses: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldChoiceValue {
    pub id: String,
    pub text: String,
    pub revision: i64,
    pub page_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldChoiceCandidate {
    pub text: String,
    pub option_id: Option<String>,
    pub values: Vec<FieldChoiceValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldInterpretation {
    pub text: String,
    pub reading: Reading,
    pub values: Vec<FieldChoiceValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDetail {
    pub field: FieldSummary,
    pub kind: FieldKind,
    pub owners_total: usize,
    pub values_total: usize,
    pub empty_total: usize,
    pub problems_total: usize,
    pub templates: Vec<FieldTemplate>,
    pub option_uses: Vec<FieldOptionUse>,
    pub owners: Vec<FieldOwnerValues>,
    pub problems: Vec<FieldValueUse>,
    pub readable: Vec<FieldValueUse>,
    /// Complete conversion candidates, not limited by the displayed samples.
    pub choice_candidates: Vec<FieldChoiceCandidate>,
    /// Every distinct written value, for reviewed interpretation across all owners.
    pub interpretations: Vec<FieldInterpretation>,
    /// All entry identities, including empty entries, for lossless schema changes.
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingRevision {
    pub key: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsView {
    pub settings: Vec<Setting>,
    pub today: String,
    pub time_zone: String,
}
