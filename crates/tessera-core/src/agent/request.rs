//! Agent request and receipt types.

use serde::{Deserialize, Serialize};

use crate::{Actor, Block, CardQuery, Committed, Deck, RelationKind, Revision, TaskState};

/// The most characters an agent may give a page title.
pub(super) const TITLE_LIMIT: usize = 1000;
/// The most atoms one note may add, counting nested ones.
pub(super) const NOTE_LIMIT: usize = 5000;
/// The longest idempotency key, in bytes.
pub(super) const KEY_LIMIT: usize = 255;

/// Where a note is appended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteTarget {
    /// The live page with this title, ignoring tags and case, else the one
    /// page whose title or alias matches it folded, as `[[Name]]` links;
    /// created when none matches. A name several pages share is refused.
    Page { title: String },
    /// The journal root for a `YYYY-MM-DD` date, or today in the workshop
    /// time zone; created when missing.
    Journal {
        #[serde(default)]
        date: Option<String>,
    },
    /// After the last child of an existing block.
    Block { id: String },
}

/// One block of a note and its nested children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteBlock {
    /// `Name:: value` becomes a field entry with the value as its first
    /// child, before `children`; nested blocks use the same shorthand.
    pub text: String,
    /// Heading level 1 to 3.
    #[serde(default)]
    pub heading: Option<u8>,
    /// Makes the block a task. A done state is reached through completion,
    /// on `completed_on` or today.
    #[serde(default)]
    pub task: Option<TaskState>,
    #[serde(default)]
    pub children: Vec<NoteBlock>,
}

/// Evidence to attach to an existing block. A quote selects its first exact
/// occurrence in one passage; otherwise the whole passage or range is cited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentCitation {
    pub block_id: String,
    #[serde(default)]
    pub revision: Option<i64>,
    pub passage_id: String,
    #[serde(default)]
    pub end_passage_id: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
}

/// What an agent asks to change. `revision`, when given, must be the
/// target's current revision (a card's own revision for `SetCardHeld`, or a
/// deck's for deck edits), so a change made since it was read is not overwritten.
/// Unknown fields are refused rather than ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentEdit {
    /// Append an outline after the target's last child.
    AddNote {
        target: NoteTarget,
        blocks: Vec<NoteBlock>,
    },
    /// Replace a block's text, its heading level, or both. Level 0 removes
    /// the heading. Editing a page root renames the page; ordinary blocks
    /// accept the same field shorthand as [`NoteBlock`].
    EditBlock {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        heading: Option<u8>,
    },
    /// Move a block and its children: after `after`, first under
    /// `parent_id` when `first` is set, or last under `parent_id`.
    MoveBlock {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
        #[serde(default)]
        parent_id: Option<String>,
        #[serde(default)]
        after: Option<String>,
        #[serde(default)]
        first: bool,
    },
    /// Delete a block and its children, or a whole page.
    DeleteBlock {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
    },
    /// Replace a block's task state; `None` makes it an ordinary block.
    /// Reaching done records a completion on `completed_on` or today.
    SetTask {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
        task: Option<TaskState>,
    },
    /// Set or remove an explicitly authored relation kind.
    SetRelation {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
        relation: Option<RelationKind>,
    },
    /// Revisit a note or question, move its date, resolve it, or reopen it.
    Revisit {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
        action: crate::RevisitAction,
        next_on: Option<String>,
    },
    /// Hold a card out of review, or release it, using its own revision.
    SetCardHeld {
        card_id: String,
        #[serde(default)]
        revision: Option<i64>,
        held: bool,
    },
    /// Create a deck when `id` is absent, or replace a deck's name and query,
    /// checked against its revision when given.
    SaveDeck {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        revision: Option<i64>,
        name: String,
        query: Box<CardQuery>,
    },
    /// Delete a saved deck. Its cards are untouched.
    DeleteDeck {
        id: String,
        #[serde(default)]
        revision: Option<i64>,
    },
    /// Attach library evidence to one or several existing blocks.
    Cite { citations: Vec<AgentCitation> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRequest {
    pub actor: Actor,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub edit: AgentEdit,
}

/// The result of [`crate::Workshop::agent_edit`]. A keyed request sent again returns
/// its first receipt with `committed.replayed` set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentReceipt {
    /// The change to pass to [`crate::Workshop::undo_change`].
    pub seq: i64,
    pub summary: String,
    /// The page or journal root the change landed on; `None` for deck edits
    /// or once deleted.
    pub page: Option<Block>,
    /// New and changed blocks with their resulting revisions, new blocks in
    /// reading order.
    pub blocks: Vec<Revision>,
    /// Pages the change created: a missing target page or pages named by
    /// `[[Title]]` references.
    pub created_pages: Vec<Block>,
    /// Field definitions created by `Name:: value` shorthand.
    #[serde(default)]
    pub created_fields: Vec<Block>,
    /// Saved decks as stored after the change; empty for deck deletions.
    #[serde(default)]
    pub decks: Vec<Deck>,
    pub committed: Committed,
}
