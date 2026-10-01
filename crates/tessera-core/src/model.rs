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
    CreatePage { id: String, title: String },
    /// Create the root for one calendar day. Dates are unique among live
    /// journal roots.
    CreateJournal { id: String, date: String },
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
    Delete { id: String, base_revision: i64 },
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
    /// True when this is the stored result of an earlier identical batch.
    pub replayed: bool,
}

/// A block in a page, in reading (preorder) order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub block: Block,
    /// 0 for the root's children.
    pub depth: u32,
}

/// Everything needed to show one page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageView {
    pub root: Block,
    /// Live descendants in preorder, including archived ones (flagged).
    pub rows: Vec<Row>,
    /// Live blocks outside this page that its rows reference, so references
    /// render their target's current text. A missing target is unresolved.
    pub targets: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backlink {
    pub source: Block,
    pub page: Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub block: Block,
    pub page: Block,
}

/// One committed batch, for clients catching up after `seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub seq: i64,
    pub actor: Actor,
    pub reason: Option<String>,
    pub created_at: i64,
    pub revisions: Vec<Revision>,
}
