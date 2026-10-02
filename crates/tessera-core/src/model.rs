//! Types shared by every client: the blocks they read and the operations they
//! submit. Every write is a [`Batch`] of [`Operation`]s committed in one
//! transaction; nothing else changes a notebook.

use serde::{Deserialize, Serialize};

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
    SetTypeFields {
        type_id: String,
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
    /// Deletion events created by `Delete` and `Merge`, in operation order.
    pub deletions: Vec<String>,
    /// Incoming-tag sources considered by a rename, including equal-text
    /// guards needed to preserve exact spelling on undo.
    /// Older persisted receipts predate tag rewriting.
    #[serde(default)]
    pub text_rewrites: Vec<TextRewrite>,
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

/// Everything needed to show one page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageView {
    pub root: Block,
    /// Live descendants in preorder, including archived ones (flagged).
    pub rows: Vec<Row>,
    /// Live blocks outside this page that its rows reference, and the pages
    /// named by its tags. A missing reference target is unresolved.
    pub targets: Vec<Block>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Number,
    Date,
    Checkbox,
    Choice,
    Instance,
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
    Set,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Query {
    pub r#type: Option<String>,
    pub text: Option<String>,
    pub filters: Vec<Filter>,
    pub sort: Vec<SortKey>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReadingValue {
    Text(String),
    Number(f64),
    Checkbox(bool),
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
pub struct QueryRow {
    pub block: BlockInPage,
    pub values: std::collections::BTreeMap<String, Vec<FieldValue>>,
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
    pub revision: i64,
    pub options: Vec<FieldOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryResult {
    pub fields: Vec<FieldDefinition>,
    pub columns: Vec<String>,
    pub rows: Vec<QueryRow>,
    pub total: usize,
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
    pub fields: Vec<String>,
    pub members: usize,
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
