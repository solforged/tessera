//! Types shared by every client: the blocks they read and the operations they
//! submit. Every write is a [`Batch`] of [`Operation`]s committed in one
//! transaction; nothing else changes a workshop.

use serde::{Deserialize, Serialize};

use crate::capabilities::{
    BlockCapabilities, CardQuery, ProjectState, ReviewSession, ReviewSessionState, TaskQuery,
    TaskState, WorkSession,
};
use crate::library::{PassagePoint, SourceState};
use crate::scheduler::Grade;
use crate::{AssessmentState, QuestionState, RelationKind, Topic};

/// What a block is. Pages and journal days are roots; everything else has a
/// parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Block,
    Page,
    Journal,
}

/// One live block as stored. A root's text is its title; a journal root's
/// text is its date in `YYYY-MM-DD` form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Block {
    pub id: String,
    pub kind: BlockKind,
    pub parent_id: Option<String>,
    pub page_id: String,
    pub text: String,
    /// Heading level 1 to 3.
    #[ts(type = "1 | 2 | 3 | null")]
    pub heading: Option<u8>,
    pub archived: bool,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub kept_copy: Option<KeptCopy>,
}

/// A live, unsettled version kept beside its original by sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct KeptCopy {
    pub of: String,
    pub origin: String,
    pub origin_name: Option<String>,
    pub mine: bool,
}

/// Who committed a batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
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
        #[ts(optional, type = "Citation[\"color\"]")]
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
        #[ts(type = "Citation[\"triage\"]")]
        triage: Option<String>,
    },
    SetCitationColor {
        id: String,
        base_revision: i64,
        #[ts(type = "Citation[\"color\"]")]
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
        #[ts(type = "1 | 2 | 3 | null")]
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
        #[ts(type = "1 | 2 | 3 | null")]
        heading: Option<u8>,
    },
    CreateCardTemplate {
        id: String,
        type_id: String,
        name: String,
        front: String,
        back: String,
        #[serde(default)]
        #[ts(optional = nullable)]
        hint: Option<String>,
        #[serde(default)]
        #[ts(optional = nullable)]
        details: Vec<String>,
        new_per_day: u32,
    },
    UpdateCardTemplate {
        id: String,
        base_revision: i64,
        name: String,
        front: String,
        back: String,
        #[serde(default)]
        #[ts(optional = nullable)]
        hint: Option<String>,
        #[serde(default)]
        #[ts(optional = nullable)]
        details: Vec<String>,
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
    /// Transfer a card between syntax and recipe keys without replacing its history.
    /// A missing source creates a held counterpart; a null destination removes it.
    TransferCardKey {
        source_id: String,
        key: String,
        to_key: Option<String>,
        base_revision: Option<i64>,
        held: bool,
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
    /// What a field's values count as in creator readings; `None` counts as nothing.
    SetFieldCountsAs {
        id: String,
        base_revision: i64,
        counts_as: Option<CountsAs>,
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
    SetImage {
        id: String,
        base_revision: i64,
        image: Option<crate::capabilities::ImageRef>,
    },
    SetOcclusion {
        id: String,
        base_revision: i64,
        occlusion: Option<crate::occlusion::Occlusion>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct Batch {
    pub actor: Actor,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    /// Retrying a batch with the same key and the same operations returns
    /// the original result without applying it again. The same key with
    /// different operations is rejected.
    #[serde(default)]
    #[ts(optional = nullable)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Revision {
    pub id: String,
    pub revision: i64,
}

/// A source considered for automatic tag rewriting during a page rename.
/// Equal-text entries are revision-checked spelling guards for undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct TextRewrite {
    pub id: String,
    pub before: String,
    pub after: String,
    pub revision: i64,
}

/// A provisional tag page removed by derivation, retained for exact history replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct PrunedPage {
    pub id: String,
    pub deletion_id: String,
    pub revision: i64,
}

/// The result of a committed batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct Committed {
    /// Position in the workshop's change sequence.
    pub seq: i64,
    /// The resulting revision of every block the batch changed, in first-
    /// touched order.
    pub revisions: Vec<Revision>,
    /// Touched blocks that are no longer live after the batch, including
    /// provisional pages removed by derivation.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub removed: Vec<String>,
    /// Exact restoration tickets for unused provisional pages pruned by this batch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pruned_pages: Vec<PrunedPage>,
    /// Deletion events created by `Delete` and `Merge`, in operation order.
    pub deletions: Vec<String>,
    /// Pages holding a block the batch changed or removed, plus pages whose
    /// order or nesting it changed, sorted. A window learns from its own
    /// receipt which pages it touched without fetching each block. `None`
    /// in receipts stored before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pages: Option<Vec<String>>,
    /// Pages where the engine placed a block somewhere other than the request
    /// named, because its `after` sibling had been moved or deleted, sorted.
    /// The sender reloads these pages to learn the order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reanchored_pages: Vec<String>,
    /// Text normalized by the engine or changed by tag removal/merge operations.
    /// The client applies these rewrites to its editor and undo history.
    /// Older persisted receipts predate tag rewriting.
    #[serde(default)]
    pub text_rewrites: Vec<TextRewrite>,
    /// Resulting revisions of settings, which are not blocks.
    #[serde(default)]
    pub settings: Vec<SettingRevision>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub capabilities: Vec<BlockCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cards: Vec<Revision>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub work_sessions: Vec<WorkSession>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub review_sessions: Vec<ReviewSession>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub views: Vec<Revision>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decks: Vec<Revision>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub task_views: Vec<Revision>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub library_views: Vec<Revision>,
    /// Workshop-wide data the batch changed. `None` where a commit did not
    /// record them: receipts stored before they were, synced changes and
    /// the browser build. A client then assumes any of it may have changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub topics: Option<Vec<Topic>>,
    /// True when this is the stored result of an earlier identical batch.
    pub replayed: bool,
}

/// A block in a page, in reading (preorder) order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Row {
    pub block: Block,
    /// 0 for the root's children.
    pub depth: u32,
    pub manual_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Subtree {
    /// Includes the root at depth 0, followed by its visible descendants.
    pub rows: Vec<Row>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuotedRow {
    pub id: String,
    pub depth: u32,
    pub text: String,
    #[ts(type = "1 | 2 | 3 | null")]
    pub heading: Option<u8>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuoteState {
    pub target_id: String,
    pub captured_at: i64,
    pub rows: Vec<QuotedRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuoteStatus {
    pub block_id: String,
    pub source_live: bool,
    pub changed: bool,
}

/// Everything needed to show one page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct PageView {
    pub root: Block,
    /// Explicit tags on the page itself, separate from descendant memberships.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub root_manual_types: Vec<String>,
    /// Live descendants in preorder, including archived ones (flagged).
    pub rows: Vec<Row>,
    /// Live blocks outside this page that its rows reference, and the pages
    /// named by its tags. A missing reference target is unresolved.
    pub targets: Vec<Block>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub capabilities: Vec<BlockCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Backlink {
    pub source: Block,
    pub page: Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct BlockInPage {
    pub block: Block,
    pub page: Block,
}

/// One committed batch, for clients catching up after `seq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
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
    /// The receipt's `pages`: every page this change touched. `None` for
    /// changes recorded before it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pages: Option<Vec<String>>,
    /// Views saved or deleted by this change; clients reload their view list.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub views: Vec<String>,
    /// Settings changed by this batch; clients reload their settings.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub settings: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub capabilities: Vec<BlockCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cards: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub work_sessions: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub review_sessions: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decks: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub task_views: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub library_views: Vec<String>,
    /// The receipt's `topics`; `None` means any workshop-wide data may have
    /// changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub topics: Option<Vec<Topic>>,
}

mod query;
pub use query::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SettingRevision {
    pub key: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SettingsView {
    pub settings: Vec<Setting>,
    pub today: String,
    pub time_zone: String,
}
