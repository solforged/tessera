//! The agent write path. Agents name a target by title, date or ID instead
//! of tracking sibling order, and each request becomes one attributed batch.
//! Hand-written `[[Title]]` references link the way the browser links them
//! when a block is left. Every change stores its inverse in the same
//! transaction, so a person or the agent can undo it later; an undo refuses
//! rather than overwrite anything changed since.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::notebook::{new_ulid, now_ms};
use crate::storage::{validate_date, validate_id, validation};
use crate::{
    Actor, Batch, Block, BlockKind, CardQuery, Committed, Deck, Error, Notebook, Operation, Result,
    Revision, TaskState, TaskStatus,
};

/// Where a note is appended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteTarget {
    /// The live page with this title, ignoring case; created when missing.
    Page { title: String },
    /// The journal root for a `YYYY-MM-DD` date, or today in the notebook
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
        query: CardQuery,
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

/// The result of [`Notebook::agent_edit`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReceipt {
    /// The change to pass to [`Notebook::undo_agent_change`].
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

/// One change made through the agent write path, newest first in listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentChange {
    pub seq: i64,
    pub actor: Actor,
    pub reason: Option<String>,
    pub created_at: i64,
    pub summary: String,
    /// The live page the change landed on.
    pub page: Option<Block>,
    /// The change that undid this one.
    pub undone_by: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoReceipt {
    pub undone: i64,
    /// Pages the change created that were kept because they are now in use
    /// or were renamed.
    pub kept_pages: Vec<Block>,
    pub committed: Committed,
}

/// Stored with each agent change.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Undo {
    /// Inverse operations for edits to existing rows, in undo order.
    operations: Vec<Operation>,
    /// The change's new top-level blocks, deleted on undo while live.
    removable: Vec<Revision>,
    /// Every block the change created.
    inserted: Vec<String>,
    /// Pages the change created, deleted on undo while unused.
    created_pages: Vec<Revision>,
    /// Field definitions the change created, deleted on undo while unused.
    #[serde(default)]
    created_fields: Vec<Revision>,
}

/// The prior state an inverse operation puts back.
enum Step {
    Text {
        id: String,
        text: String,
    },
    Heading {
        id: String,
        heading: Option<u8>,
    },
    Move {
        id: String,
        parent_id: String,
        after: Option<String>,
    },
    Restore {
        id: String,
    },
    Task {
        id: String,
        /// The state before and after the change.
        states: Box<(Option<TaskState>, Option<TaskState>)>,
    },
    Uncomplete {
        id: String,
        occurrence_id: String,
    },
    CardHeld {
        id: String,
        held: bool,
    },
    DeckCreated {
        id: String,
    },
    DeckSaved {
        id: String,
        name: String,
        query: CardQuery,
    },
    DeckDeleted {
        id: String,
        name: String,
        query: CardQuery,
    },
    Uncite {
        id: String,
        citation_id: String,
    },
}

impl Step {
    fn id(&self) -> &str {
        match self {
            Step::Text { id, .. }
            | Step::Heading { id, .. }
            | Step::Move { id, .. }
            | Step::Restore { id }
            | Step::Task { id, .. }
            | Step::Uncomplete { id, .. }
            | Step::CardHeld { id, .. }
            | Step::DeckCreated { id }
            | Step::DeckSaved { id, .. }
            | Step::DeckDeleted { id, .. }
            | Step::Uncite { id, .. } => id,
        }
    }
}

#[derive(Default)]
struct Plan {
    operations: Vec<Operation>,
    steps: Vec<Step>,
    /// Pages resolved or created for this batch, by lowercase title.
    titles: HashMap<String, String>,
    created: Vec<String>,
    /// Live and newly created field definitions, keyed by lowercase name.
    fields: Option<HashMap<String, String>>,
    created_fields: Vec<String>,
    inserted: Vec<String>,
    removable: Vec<String>,
    changed: Vec<String>,
    saved_decks: Vec<String>,
    /// The revision the next operation on each touched block is based on.
    revisions: HashMap<String, i64>,
}

impl Plan {
    fn create_page(&mut self, title: &str) -> String {
        let id = new_ulid().to_string();
        self.operations.push(Operation::CreatePage {
            id: id.clone(),
            title: title.to_owned(),
        });
        self.titles.insert(title.to_lowercase(), id.clone());
        self.created.push(id.clone());
        id
    }
}

/// The base revision for the next operation on `id`, which bumps it.
fn next_revision(revisions: &mut HashMap<String, i64>, id: &str) -> i64 {
    let revision = revisions
        .get_mut(id)
        .expect("touched blocks start with a revision");
    *revision += 1;
    *revision - 1
}

impl Notebook {
    /// Apply one agent request as an attributed batch and record how to undo
    /// it. A failure writes nothing.
    pub fn agent_edit(&mut self, request: &AgentRequest) -> Result<AgentReceipt> {
        let mut plan = Plan::default();
        let on_page = |(id, summary): (String, String)| (Some(id), summary);
        let (page_id, summary) = match &request.edit {
            AgentEdit::AddNote { target, blocks } => {
                on_page(self.plan_note(&mut plan, target, blocks)?)
            }
            AgentEdit::EditBlock {
                id,
                revision,
                text,
                heading,
            } => on_page(self.plan_edit(&mut plan, id, *revision, text.as_deref(), *heading)?),
            AgentEdit::MoveBlock {
                id,
                revision,
                parent_id,
                after,
                first,
            } => on_page(self.plan_move(
                &mut plan,
                id,
                *revision,
                parent_id.as_deref(),
                after.as_deref(),
                *first,
            )?),
            AgentEdit::DeleteBlock { id, revision } => {
                let block = self.block(id)?;
                touch(&mut plan, &block, *revision);
                plan.operations.push(Operation::Delete {
                    id: id.clone(),
                    base_revision: next_revision(&mut plan.revisions, id),
                });
                plan.steps.push(Step::Restore { id: id.clone() });
                let summary = if block.kind == BlockKind::Block {
                    format!(
                        "Deleted “{}” from {}",
                        snippet(&self.readable(&block.text)?),
                        self.block(&block.page_id)?.text
                    )
                } else {
                    format!("Deleted {}", block.text)
                };
                (Some(block.page_id), summary)
            }
            AgentEdit::SetTask { id, revision, task } => {
                let block = self.block(id)?;
                touch(&mut plan, &block, *revision);
                let current = crate::task_store::task(&self.conn, id)?;
                let summary = self.plan_task(&mut plan, id, current, task.clone(), true)?;
                plan.changed.push(id.clone());
                let page = self.block(&block.page_id)?.text;
                (
                    Some(block.page_id),
                    format!(
                        "{summary} “{}” on {page}",
                        snippet(&self.readable(&block.text)?)
                    ),
                )
            }
            AgentEdit::SetCardHeld {
                card_id,
                revision,
                held,
            } => on_page(self.plan_card_held(&mut plan, card_id, *revision, *held)?),
            AgentEdit::SaveDeck {
                id,
                revision,
                name,
                query,
            } => (
                None,
                self.plan_save_deck(&mut plan, id.as_deref(), *revision, name, query)?,
            ),
            AgentEdit::DeleteDeck { id, revision } => {
                (None, self.plan_delete_deck(&mut plan, id, *revision)?)
            }
            AgentEdit::Cite { citations } => on_page(self.plan_citations(&mut plan, citations)?),
        };
        let Plan {
            operations,
            steps,
            created,
            created_fields,
            inserted,
            removable,
            changed,
            saved_decks,
            ..
        } = plan;
        let committed = self.apply_with(
            &Batch {
                actor: request.actor.clone(),
                reason: request.reason.clone(),
                idempotency_key: None,
                operations,
            },
            |tx, committed| {
                let undo = Undo {
                    operations: inverse(&steps, committed)?,
                    removable: resulting(committed, &removable)?,
                    inserted: inserted.clone(),
                    created_pages: resulting(committed, &created)?,
                    created_fields: resulting(committed, &created_fields)?,
                };
                tx.execute(
                    "INSERT INTO agent_changes(seq, summary, page_id, undo) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        committed.seq,
                        summary,
                        page_id,
                        serde_json::to_string(&undo).expect("undo serializes")
                    ],
                )?;
                Ok(())
            },
        )?;
        let blocks = inserted
            .iter()
            .chain(&changed)
            .filter_map(|id| committed.revisions.iter().find(|r| &r.id == id).cloned())
            .collect();
        Ok(AgentReceipt {
            seq: committed.seq,
            summary,
            page: match &page_id {
                Some(id) => self.live_block(id)?,
                None => None,
            },
            blocks,
            created_pages: created
                .iter()
                .map(|id| self.block(id))
                .collect::<Result<_>>()?,
            created_fields: created_fields
                .iter()
                .map(|id| self.block(id))
                .collect::<Result<_>>()?,
            decks: saved_decks
                .iter()
                .map(|id| self.deck(id))
                .collect::<Result<_>>()?,
            committed,
        })
    }

    /// Changes made through [`Notebook::agent_edit`], newest first.
    pub fn agent_changes(&self, limit: usize) -> Result<Vec<AgentChange>> {
        let rows = self
            .conn
            .prepare_cached(
                "SELECT a.seq, c.actor, c.reason, c.created_at, a.summary, a.page_id, a.undone_seq
                 FROM agent_changes a JOIN changes c ON c.seq = a.seq
                 ORDER BY a.seq DESC LIMIT ?1",
            )?
            .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(
                |(seq, actor, reason, created_at, summary, page_id, undone_by)| {
                    Ok(AgentChange {
                        seq,
                        actor: serde_json::from_str(&actor).map_err(|error| {
                            validation(format!("invalid stored actor: {error}"))
                        })?,
                        reason,
                        created_at,
                        summary,
                        page: match page_id {
                            Some(id) => self.live_block(&id)?,
                            None => None,
                        },
                        undone_by,
                    })
                },
            )
            .collect()
    }

    /// Reverse an agent change as a batch by `actor`. Refuses when a block
    /// it touched changed since, or when a block it added now has children
    /// added by someone else. Pages it created stay when they are in use.
    pub fn undo_agent_change(&mut self, seq: i64, actor: &Actor) -> Result<UndoReceipt> {
        let (undo, undone): (String, Option<i64>) = self
            .conn
            .query_row(
                "SELECT undo, undone_seq FROM agent_changes WHERE seq = ?1",
                [seq],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound {
                id: format!("agent change {seq}"),
                op_index: None,
            })?;
        if let Some(by) = undone {
            return Err(validation(format!(
                "change {seq} was already undone by change {by}"
            )));
        }
        let mut undo: Undo = serde_json::from_str(&undo)
            .map_err(|error| validation(format!("invalid stored undo: {error}")))?;
        // Later agent changes that were themselves undone left their rows as
        // this change did, so undoing in reverse order works.
        let undone_later = self.undone_after(seq)?;
        for operation in &mut undo.operations {
            let card = matches!(operation, Operation::SetCardHeld { .. });
            let deck = matches!(
                operation,
                Operation::SaveDeck { .. } | Operation::DeleteDeck { .. }
            );
            let Some((id, revision)) = base_revision(operation) else {
                // Recreating a deleted deck checks that its ID is still absent.
                continue;
            };
            *revision += if card {
                self.card_revision_shift(seq, &undone_later, &id)?
            } else if deck {
                self.deck_revision_shift(seq, &undone_later, &id)?
            } else {
                self.revision_shift(seq, &undone_later, &id)?
            };
        }
        for block in undo
            .removable
            .iter_mut()
            .chain(&mut undo.created_pages)
            .chain(&mut undo.created_fields)
        {
            block.revision += self.revision_shift(seq, &undone_later, &block.id)?;
        }
        // Blocks this undo deletes or puts back no longer hold the change's links.
        let mut owned: HashSet<&str> = undo
            .inserted
            .iter()
            .map(String::as_str)
            .chain(
                undo.operations
                    .iter()
                    .filter_map(|operation| match operation {
                        Operation::EditText { id, .. } => Some(id.as_str()),
                        _ => None,
                    }),
            )
            .collect();
        let mut operations = undo.operations.clone();
        for block in &undo.removable {
            if self.live_block(&block.id)?.is_none() {
                continue;
            }
            if self
                .live_descendants(&block.id)?
                .iter()
                .any(|id| !owned.contains(id.as_str()))
            {
                return Err(validation(format!(
                    "block {} has children added after change {seq}; move or delete them first",
                    block.id
                )));
            }
            operations.push(Operation::Delete {
                id: block.id.clone(),
                base_revision: block.revision,
            });
        }
        for field in &undo.created_fields {
            let Some(current) = self.live_block(&field.id)? else {
                continue;
            };
            if current.revision == field.revision
                && self
                    .live_descendants(&field.id)?
                    .iter()
                    .all(|id| owned.contains(id.as_str()))
                && self
                    .live_referrers(&field.id)?
                    .iter()
                    .all(|id| owned.contains(id.as_str()))
            {
                operations.push(Operation::Delete {
                    id: field.id.clone(),
                    base_revision: field.revision,
                });
                owned.insert(&field.id);
            }
        }
        let mut kept_pages = Vec::new();
        for page in &undo.created_pages {
            let Some(current) = self.live_block(&page.id)? else {
                continue;
            };
            let unused = current.revision == page.revision
                && self
                    .live_descendants(&page.id)?
                    .iter()
                    .all(|id| owned.contains(id.as_str()))
                && self
                    .live_referrers(&page.id)?
                    .iter()
                    .all(|id| owned.contains(id.as_str()));
            if unused {
                operations.push(Operation::Delete {
                    id: page.id.clone(),
                    base_revision: page.revision,
                });
            } else {
                kept_pages.push(current);
            }
        }
        if operations.is_empty() {
            return Err(validation(format!(
                "nothing is left to undo: everything change {seq} added is already gone"
            )));
        }
        let committed = self
            .apply_with(
                &Batch {
                    actor: actor.clone(),
                    reason: Some(format!("Undo change {seq}")),
                    idempotency_key: None,
                    operations,
                },
                |tx, committed| {
                    tx.execute(
                        "UPDATE agent_changes SET undone_seq = ?1 WHERE seq = ?2",
                        params![committed.seq, seq],
                    )?;
                    Ok(())
                },
            )
            .map_err(|error| match error {
                Error::Conflict { id, .. } => validation(format!(
                    "block {id} changed after change {seq}; undo or revert that edit first"
                )),
                error => error,
            })?;
        Ok(UndoReceipt {
            undone: seq,
            kept_pages,
            committed,
        })
    }

    fn plan_note(
        &self,
        plan: &mut Plan,
        target: &NoteTarget,
        blocks: &[NoteBlock],
    ) -> Result<(String, String)> {
        if blocks.is_empty() {
            return Err(validation("a note must contain a block"));
        }
        let (page_id, parent_id, after, title) = match target {
            NoteTarget::Page { title } => {
                let title = title.trim();
                match self.page_by_title(title)? {
                    Some(page) => {
                        plan.titles.insert(title.to_lowercase(), page.id.clone());
                        let after = self.last_child(&page.id, &page.id)?;
                        (page.id.clone(), page.id, after, page.text)
                    }
                    None => {
                        let id = plan.create_page(title);
                        (id.clone(), id, None, title.to_owned())
                    }
                }
            }
            NoteTarget::Journal { date } => {
                let date = match date {
                    Some(date) => {
                        validate_date(date)?;
                        date.clone()
                    }
                    None => self.today(now_ms())?,
                };
                match self.journal(&date)? {
                    Some(day) => {
                        let after = self.last_child(&day.id, &day.id)?;
                        (day.id.clone(), day.id, after, date)
                    }
                    None => {
                        let id = new_ulid().to_string();
                        plan.operations.push(Operation::CreateJournal {
                            id: id.clone(),
                            date: date.clone(),
                        });
                        plan.created.push(id.clone());
                        (id.clone(), id, None, date)
                    }
                }
            }
            NoteTarget::Block { id } => {
                let block = self.block(id)?;
                let after = self.last_child(&block.page_id, &block.id)?;
                let title = self.block(&block.page_id)?.text;
                (block.page_id, block.id, after, title)
            }
        };
        self.plan_blocks(plan, &parent_id, after, blocks, true)?;
        let count = plan.inserted.len();
        let summary = format!(
            "Added {count} block{} to {title}",
            if count == 1 { "" } else { "s" }
        );
        Ok((page_id, summary))
    }

    fn plan_blocks(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        mut after: Option<String>,
        blocks: &[NoteBlock],
        top: bool,
    ) -> Result<()> {
        for block in blocks {
            let id = new_ulid().to_string();
            let (text, value) = self.note_text(plan, &block.text)?;
            plan.operations.push(Operation::Insert {
                id: id.clone(),
                parent_id: parent_id.to_owned(),
                after: after.replace(id.clone()),
                text,
                heading: block.heading,
            });
            plan.inserted.push(id.clone());
            if top {
                plan.removable.push(id.clone());
            }
            if block.task.is_some() {
                plan.revisions.insert(id.clone(), 1);
                self.plan_task(plan, &id, None, block.task.clone(), false)?;
            }
            let value_id = self.plan_value(plan, &id, value, false)?;
            self.plan_blocks(plan, &id, value_id, &block.children, false)?;
        }
        Ok(())
    }

    /// Convert editor field shorthand before resolving ordinary title links.
    fn note_text<'a>(&self, plan: &mut Plan, text: &'a str) -> Result<(String, Option<&'a str>)> {
        if let Some((name, value)) = field_shorthand(text) {
            let field = self.field_target(plan, name)?;
            Ok((format!("[[{field}]]"), (!value.is_empty()).then_some(value)))
        } else {
            Ok((self.link_titles(plan, text)?, None))
        }
    }

    fn field_target(&self, plan: &mut Plan, name: &str) -> Result<String> {
        if plan.fields.is_none() {
            plan.fields = Some(
                crate::fields::definitions(&self.conn)?
                    .into_iter()
                    .map(|field| (field.name.to_lowercase(), field.id))
                    .collect(),
            );
        }
        let key = name.to_lowercase();
        if let Some(id) = plan.fields.as_ref().and_then(|fields| fields.get(&key)) {
            return Ok(id.clone());
        }
        let page = match crate::fields::page_id(&self.conn)? {
            Some(id) => id,
            None => self
                .title_target(plan, "Fields")?
                .expect("Fields is a page title"),
        };
        let after = if let Some(id) = plan.created_fields.last() {
            Some(id.clone())
        } else if plan.created.contains(&page) {
            None
        } else {
            self.last_child(&page, &page)?
        };
        let id = new_ulid().to_string();
        plan.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: page,
            after,
            text: name.to_owned(),
            heading: None,
        });
        plan.fields
            .as_mut()
            .expect("fields were loaded")
            .insert(key, id.clone());
        plan.created_fields.push(id.clone());
        Ok(id)
    }

    /// A shorthand value always precedes authored children. Values added to
    /// existing blocks are separate roots for undo, not part of their parent.
    fn plan_value(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        value: Option<&str>,
        removable: bool,
    ) -> Result<Option<String>> {
        let Some(value) = value else {
            return Ok(None);
        };
        let id = new_ulid().to_string();
        let text = self.link_titles(plan, value)?;
        plan.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: parent_id.to_owned(),
            after: None,
            text,
            heading: None,
        });
        plan.inserted.push(id.clone());
        if removable {
            plan.removable.push(id.clone());
        }
        Ok(Some(id))
    }

    fn plan_edit(
        &self,
        plan: &mut Plan,
        id: &str,
        revision: Option<i64>,
        text: Option<&str>,
        heading: Option<u8>,
    ) -> Result<(String, String)> {
        let block = self.block(id)?;
        touch(plan, &block, revision);
        if let Some(text) = text {
            let (text, value) = if block.kind == BlockKind::Block {
                self.note_text(plan, text)?
            } else {
                (text.to_owned(), None)
            };
            self.plan_value(plan, id, value, true)?;
            if text != block.text {
                plan.operations.push(Operation::EditText {
                    id: id.to_owned(),
                    base_revision: next_revision(&mut plan.revisions, id),
                    text,
                });
                plan.steps.push(Step::Text {
                    id: id.to_owned(),
                    text: block.text.clone(),
                });
            }
        }
        if let Some(level) = heading {
            let heading = (level != 0).then_some(level);
            if heading != block.heading {
                plan.operations.push(Operation::SetHeading {
                    id: id.to_owned(),
                    base_revision: next_revision(&mut plan.revisions, id),
                    heading,
                });
                plan.steps.push(Step::Heading {
                    id: id.to_owned(),
                    heading: block.heading,
                });
            }
        }
        if plan.steps.is_empty() {
            return Err(validation(
                "nothing to change: the block already reads that way",
            ));
        }
        plan.changed.push(id.to_owned());
        let summary = match (block.kind, text) {
            (BlockKind::Page, Some(text)) if text != block.text => {
                format!("Renamed {} to {text}", block.text)
            }
            _ => format!(
                "Edited “{}” on {}",
                snippet(text.unwrap_or(&block.text)),
                self.block(&block.page_id)?.text
            ),
        };
        Ok((block.page_id, summary))
    }

    fn plan_card_held(
        &self,
        plan: &mut Plan,
        card_id: &str,
        revision: Option<i64>,
        held: bool,
    ) -> Result<(String, String)> {
        let card = self.card(card_id)?;
        if let Some(expected) = revision
            && expected != card.revision
        {
            return Err(Error::Conflict {
                op_index: plan.operations.len(),
                id: card_id.to_owned(),
                expected,
                found: Some(card.revision),
            });
        }
        if !card.active {
            return Err(validation("inactive cards cannot be held or released"));
        }
        if card.held == held {
            return Err(validation(if held {
                "nothing to change: the card is already held"
            } else {
                "nothing to change: the card is already released"
            }));
        }
        let block = self.block(&card.source_block_id)?;
        let page = self.block(&block.page_id)?;
        plan.operations.push(Operation::SetCardHeld {
            id: card_id.to_owned(),
            base_revision: card.revision,
            held,
        });
        plan.steps.push(Step::CardHeld {
            id: card_id.to_owned(),
            held: card.held,
        });
        Ok((
            page.id,
            format!(
                "{} card “{}” on {}",
                if held { "Held" } else { "Released" },
                snippet(&card.front),
                page.text
            ),
        ))
    }

    fn plan_save_deck(
        &self,
        plan: &mut Plan,
        id: Option<&str>,
        revision: Option<i64>,
        name: &str,
        query: &CardQuery,
    ) -> Result<String> {
        let (id, base_revision, summary) = if let Some(id) = id {
            let deck = self.deck(id)?;
            let base_revision = revision.unwrap_or(deck.revision);
            plan.steps.push(Step::DeckSaved {
                id: deck.id.clone(),
                name: deck.name,
                query: deck.query,
            });
            (
                deck.id,
                Some(base_revision),
                format!("Saved deck {}", name.trim()),
            )
        } else {
            let id = new_ulid().to_string();
            plan.steps.push(Step::DeckCreated { id: id.clone() });
            (id, revision, format!("Created deck {}", name.trim()))
        };
        plan.operations.push(Operation::SaveDeck {
            id: id.clone(),
            base_revision,
            name: name.to_owned(),
            query: query.clone(),
        });
        plan.saved_decks.push(id);
        Ok(summary)
    }

    fn plan_delete_deck(&self, plan: &mut Plan, id: &str, revision: Option<i64>) -> Result<String> {
        let deck = self.deck(id)?;
        let summary = format!("Deleted deck {}", deck.name);
        plan.operations.push(Operation::DeleteDeck {
            id: id.to_owned(),
            base_revision: revision.unwrap_or(deck.revision),
        });
        plan.steps.push(Step::DeckDeleted {
            id: deck.id,
            name: deck.name,
            query: deck.query,
        });
        Ok(summary)
    }

    fn plan_citations(
        &self,
        plan: &mut Plan,
        citations: &[AgentCitation],
    ) -> Result<(String, String)> {
        if citations.is_empty() {
            return Err(validation("a cite change must contain a citation"));
        }
        let mut page = None;
        for citation in citations {
            let block = self.block(&citation.block_id)?;
            if let Some(expected) = citation.revision
                && expected != block.revision
            {
                return Err(Error::Conflict {
                    op_index: plan.operations.len(),
                    id: block.id,
                    expected,
                    found: Some(block.revision),
                });
            }
            if page.is_none() {
                page = Some(self.block(&block.page_id)?);
            }
            if !plan.revisions.contains_key(&block.id) {
                touch(plan, &block, citation.revision);
                plan.changed.push(block.id.clone());
            }
            if citation.quote.is_some() && citation.end_passage_id.is_some() {
                return Err(validation("give quote or end_passage_id, not both"));
            }
            let first = self.passage(&citation.passage_id)?;
            let snapshot: String = self.conn.query_row(
                "SELECT snapshot_id FROM passages WHERE id = ?1",
                [&first.id],
                |row| row.get(0),
            )?;
            let (start_offset, end_id, end_offset) = if let Some(quote) = &citation.quote {
                let offset = first.text.find(quote).ok_or_else(|| {
                    validation(format!("quote not found in passage {}", first.id))
                })?;
                (
                    first.text[..offset].encode_utf16().count(),
                    first.id.clone(),
                    first.text[..offset + quote.len()].encode_utf16().count(),
                )
            } else {
                let last = citation
                    .end_passage_id
                    .as_deref()
                    .filter(|id| *id != first.id)
                    .map(|id| self.passage(id))
                    .transpose()?;
                if let Some(last) = &last {
                    let last_snapshot: String = self.conn.query_row(
                        "SELECT snapshot_id FROM passages WHERE id = ?1",
                        [&last.id],
                        |row| row.get(0),
                    )?;
                    if snapshot != last_snapshot {
                        return Err(validation("citation passages must share one snapshot"));
                    }
                }
                let last = last.as_ref().unwrap_or(&first);
                (0, last.id.clone(), last.text.encode_utf16().count())
            };
            let citation_id = new_ulid().to_string();
            plan.operations.push(Operation::Cite {
                id: block.id.clone(),
                base_revision: next_revision(&mut plan.revisions, &block.id),
                citation_id: citation_id.clone(),
                snapshot_id: snapshot,
                start: crate::library::PassagePoint {
                    passage_id: first.id,
                    offset: u32::try_from(start_offset)
                        .map_err(|_| validation("citation offset exceeds UTF-16 range"))?,
                },
                end: crate::library::PassagePoint {
                    passage_id: end_id,
                    offset: u32::try_from(end_offset)
                        .map_err(|_| validation("citation offset exceeds UTF-16 range"))?,
                },
                color: None,
            });
            plan.steps.push(Step::Uncite {
                id: block.id,
                citation_id,
            });
        }
        let page = page.expect("citations are nonempty");
        Ok((
            page.id,
            format!(
                "Cited {} passage{} on {}",
                citations.len(),
                if citations.len() == 1 { "" } else { "s" },
                page.text
            ),
        ))
    }

    fn plan_move(
        &self,
        plan: &mut Plan,
        id: &str,
        revision: Option<i64>,
        parent_id: Option<&str>,
        after: Option<&str>,
        first: bool,
    ) -> Result<(String, String)> {
        let block = self.block(id)?;
        let Some(old_parent) = block.parent_id.clone() else {
            return Err(validation("a page cannot be moved"));
        };
        let (parent, after) = match (parent_id, after, first) {
            (_, Some(_), true) => return Err(validation("give after or first, not both")),
            (parent, Some(after), false) => {
                let sibling = self.block(after)?;
                let sibling_parent = sibling
                    .parent_id
                    .ok_or_else(|| validation("a block cannot be placed after a page"))?;
                if parent.is_some_and(|parent| parent != sibling_parent) {
                    return Err(validation("after must be a child of parent_id"));
                }
                (sibling_parent, Some(after.to_owned()))
            }
            (Some(parent), None, true) => (parent.to_owned(), None),
            (None, None, true) => (old_parent.clone(), None),
            (Some(parent), None, false) => {
                let page = self.block(parent)?.page_id;
                (parent.to_owned(), self.last_child(&page, parent)?)
            }
            (None, None, false) => return Err(validation("give parent_id, after or first")),
        };
        let old_after = self.previous_sibling(&block)?;
        if after.as_deref() == Some(id) || (parent == old_parent && after == old_after) {
            return Err(validation("nothing to change: the block is already there"));
        }
        touch(plan, &block, revision);
        plan.operations.push(Operation::Move {
            id: id.to_owned(),
            base_revision: next_revision(&mut plan.revisions, id),
            parent_id: parent.clone(),
            after,
        });
        plan.steps.push(Step::Move {
            id: id.to_owned(),
            parent_id: old_parent,
            after: old_after,
        });
        plan.changed.push(id.to_owned());
        let page = self.block(&self.block(&parent)?.page_id)?;
        let summary = format!(
            "Moved “{}” to {}",
            snippet(&self.readable(&block.text)?),
            page.text
        );
        Ok((page.id, summary))
    }

    /// `text` with references shown as their alias or their target's text.
    fn readable(&self, text: &str) -> Result<String> {
        let mut shown = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("[[") {
            let Some(end) = rest[start + 2..].find("]]") else {
                break;
            };
            let reference = &rest[start + 2..start + 2 + end];
            let label = match reference.split_once('|') {
                Some((_, alias)) => Some(alias.to_owned()),
                None if validate_id(reference).is_ok() => {
                    self.live_block(reference)?.map(|block| block.text)
                }
                None => None,
            };
            shown.push_str(&rest[..start]);
            shown.push_str(label.as_deref().unwrap_or(&rest[start..start + 4 + end]));
            rest = &rest[start + 4 + end..];
        }
        shown.push_str(rest);
        Ok(shown)
    }

    /// Operations taking a task from `current` to `target`; `record` adds
    /// their inverses. Returns the summary verb.
    fn plan_task(
        &self,
        plan: &mut Plan,
        id: &str,
        current: Option<TaskState>,
        target: Option<TaskState>,
        record: bool,
    ) -> Result<String> {
        if current == target {
            return Err(validation(
                "nothing to change: the task already has that state",
            ));
        }
        let set = |plan: &mut Plan, before: Option<TaskState>, after: Option<TaskState>| {
            plan.operations.push(Operation::SetTask {
                id: id.to_owned(),
                base_revision: next_revision(&mut plan.revisions, id),
                task: after.clone(),
            });
            if record {
                plan.steps.push(Step::Task {
                    id: id.to_owned(),
                    states: Box::new((before, after)),
                });
            }
        };
        let Some(target) = target else {
            set(plan, current, None);
            return Ok("Removed the task from".into());
        };
        let finishing = target.status == TaskStatus::Done
            && current
                .as_ref()
                .is_none_or(|current| current.status != TaskStatus::Done);
        if !finishing {
            let verb = format!("Set to {}", status_name(target.status));
            set(plan, current, Some(target));
            return Ok(verb);
        }
        let open = TaskState {
            status: match current.as_ref().map(|current| current.status) {
                Some(status @ (TaskStatus::Doing | TaskStatus::Waiting)) => status,
                _ => TaskStatus::Todo,
            },
            completed_on: None,
            ..target.clone()
        };
        if current.as_ref() != Some(&open) {
            set(plan, current, Some(open));
        }
        let occurrence_id = new_ulid().to_string();
        plan.operations.push(Operation::CompleteTask {
            id: id.to_owned(),
            base_revision: next_revision(&mut plan.revisions, id),
            occurrence_id: occurrence_id.clone(),
            completed_on: match target.completed_on {
                Some(date) => date,
                None => self.today(now_ms())?,
            },
        });
        if record {
            plan.steps.push(Step::Uncomplete {
                id: id.to_owned(),
                occurrence_id,
            });
        }
        Ok("Completed".into())
    }

    /// Later agent changes that were undone, and the changes that undid them.
    fn undone_after(&self, seq: i64) -> Result<HashSet<i64>> {
        let mut seqs = HashSet::new();
        let mut statement = self.conn.prepare_cached(
            "SELECT seq, undone_seq FROM agent_changes WHERE seq > ?1 AND undone_seq IS NOT NULL",
        )?;
        let rows = statement.query_map([seq], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for row in rows {
            let (change, undo): (i64, i64) = row?;
            seqs.extend([change, undo]);
        }
        Ok(seqs)
    }

    /// How far `id`'s revision moved after change `seq` through changes in
    /// `undone`, which left its state as `seq` did. Zero when anything else
    /// touched it, so the revision check still refuses.
    fn revision_shift(&self, seq: i64, undone: &HashSet<i64>, id: &str) -> Result<i64> {
        let recorded: Option<i64> = self
            .conn
            .prepare_cached(
                "SELECT revision FROM change_revisions WHERE change_seq = ?1 AND block_id = ?2",
            )?
            .query_row(params![seq, id], |row| row.get(0))
            .optional()?;
        let current: Option<i64> = self
            .conn
            .prepare_cached("SELECT revision FROM blocks WHERE id = ?1")?
            .query_row([id], |row| row.get(0))
            .optional()?;
        let (Some(recorded), Some(current)) = (recorded, current) else {
            return Ok(0);
        };
        if current == recorded {
            return Ok(0);
        }
        let later: Vec<i64> = self
            .conn
            .prepare_cached(
                "SELECT DISTINCT change_seq FROM change_revisions WHERE block_id = ?1 AND change_seq > ?2",
            )?
            .query_map(params![id, seq], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(if later.iter().all(|change| undone.contains(change)) {
            current - recorded
        } else {
            0
        })
    }

    /// Cards have their own revision stream, recorded in committed receipts
    /// rather than in the block-only `change_revisions` table.
    fn card_revision_shift(&self, seq: i64, undone: &HashSet<i64>, id: &str) -> Result<i64> {
        let mut statement = self.conn.prepare_cached(
            "SELECT c.seq, json_extract(r.value, '$.revision')
             FROM changes c, json_each(c.committed, '$.cards') r
             WHERE c.seq >= ?1 AND json_extract(r.value, '$.id') = ?2
             ORDER BY c.seq",
        )?;
        let mut rows = statement.query(params![seq, id])?;
        let Some(first) = rows.next()? else {
            return Ok(0);
        };
        if first.get::<_, i64>(0)? != seq {
            return Ok(0);
        }
        let recorded: i64 = first.get(1)?;
        while let Some(row) = rows.next()? {
            if !undone.contains(&row.get::<_, i64>(0)?) {
                return Ok(0);
            }
        }
        Ok(self.card(id)?.revision - recorded)
    }

    /// Deck revisions, like card revisions, live in committed receipts.
    fn deck_revision_shift(&self, seq: i64, undone: &HashSet<i64>, id: &str) -> Result<i64> {
        let mut statement = self.conn.prepare_cached(
            "SELECT c.seq, json_extract(r.value, '$.revision')
             FROM changes c, json_each(c.committed, '$.decks') r
             WHERE c.seq >= ?1 AND json_extract(r.value, '$.id') = ?2
             ORDER BY c.seq",
        )?;
        let mut rows = statement.query(params![seq, id])?;
        let Some(first) = rows.next()? else {
            return Ok(0);
        };
        if first.get::<_, i64>(0)? != seq {
            return Ok(0);
        }
        let recorded: i64 = first.get(1)?;
        while let Some(row) = rows.next()? {
            if !undone.contains(&row.get::<_, i64>(0)?) {
                return Ok(0);
            }
        }
        Ok(self.deck(id)?.revision - recorded)
    }

    fn live_block(&self, id: &str) -> Result<Option<Block>> {
        match self.block(id) {
            Ok(block) => Ok(Some(block)),
            Err(Error::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn live_descendants(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .conn
            .prepare_cached(
                "WITH RECURSIVE below(id) AS (
                     SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                     UNION ALL
                     SELECT b.id FROM blocks b JOIN below ON b.parent_id = below.id
                     WHERE b.deletion_id IS NULL
                 )
                 SELECT id FROM below",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Live blocks that reference or are tagged with `id`.
    fn live_referrers(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT l.source_id FROM links l JOIN blocks b ON b.id = l.source_id
                 WHERE l.target_id = ?1 AND b.deletion_id IS NULL
                 UNION
                 SELECT m.block_id FROM memberships m JOIN blocks b ON b.id = m.block_id
                 WHERE m.type_id = ?1 AND b.deletion_id IS NULL",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    fn previous_sibling(&self, block: &Block) -> Result<Option<String>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT s.id FROM blocks s JOIN blocks b ON b.id = ?1
                 WHERE s.parent_id = b.parent_id AND s.deletion_id IS NULL
                   AND (s.ordinal, s.id) < (b.ordinal, b.id)
                 ORDER BY s.ordinal DESC, s.id DESC LIMIT 1",
            )?
            .query_row([&block.id], |row| row.get(0))
            .optional()?)
    }

    /// The last live child of `parent_id`, which lives on `page_id`.
    fn last_child(&self, page_id: &str, parent_id: &str) -> Result<Option<String>> {
        let page = self.page(page_id)?;
        let (start, depth) = if parent_id == page_id {
            (0, 0)
        } else {
            let index = page
                .rows
                .iter()
                .position(|row| row.block.id == parent_id)
                .ok_or_else(|| crate::storage::not_found(parent_id))?;
            (index + 1, page.rows[index].depth + 1)
        };
        let mut last = None;
        for row in &page.rows[start..] {
            if row.depth < depth {
                break;
            }
            if row.depth == depth {
                last = Some(&row.block.id);
            }
        }
        Ok(last.cloned())
    }

    /// Rewrite `[[Title]]` to `[[id]]` for the live page with that title,
    /// creating it when missing, and keep any `|alias`. A date names a
    /// journal day and stays as written when that day does not exist. ID
    /// references and `#[[Tag]]` tags are left alone.
    fn link_titles(&self, plan: &mut Plan, text: &str) -> Result<String> {
        let mut linked = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("[[") {
            let (before, opened) = rest.split_at(start);
            let Some(end) = opened[2..].find("]]") else {
                break;
            };
            let reference = &opened[2..2 + end];
            let tag = before.strip_suffix('#').is_some_and(|prefix| {
                prefix
                    .chars()
                    .next_back()
                    .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
            });
            let (target, alias) = match reference.split_once('|') {
                Some((target, alias)) => (target, Some(alias)),
                None => (reference, None),
            };
            let title = target.trim();
            let resolved = if tag
                || title.is_empty()
                || title.contains(['[', ']', '\n', '\r'])
                || alias.is_some_and(|alias| alias.contains(']'))
                || validate_id(target).is_ok()
            {
                None
            } else {
                self.title_target(plan, title)?
            };
            linked.push_str(before);
            match resolved {
                Some(id) => {
                    linked.push_str("[[");
                    linked.push_str(&id);
                    if let Some(alias) = alias {
                        linked.push('|');
                        linked.push_str(alias);
                    }
                    linked.push_str("]]");
                }
                None => linked.push_str(&opened[..2 + end + 2]),
            }
            rest = &opened[2 + end + 2..];
        }
        linked.push_str(rest);
        Ok(linked)
    }

    fn title_target(&self, plan: &mut Plan, title: &str) -> Result<Option<String>> {
        if let Some(id) = plan.titles.get(&title.to_lowercase()) {
            return Ok(Some(id.clone()));
        }
        let bytes = title.as_bytes();
        let date_shaped = bytes.len() == 10
            && bytes.iter().enumerate().all(|(index, byte)| match index {
                4 | 7 => *byte == b'-',
                _ => byte.is_ascii_digit(),
            });
        if date_shaped {
            return Ok(match validate_date(title) {
                Ok(()) => self.journal(title)?.map(|day| day.id),
                Err(_) => None,
            });
        }
        if let Some(page) = self.page_by_title(title)? {
            plan.titles.insert(title.to_lowercase(), page.id.clone());
            return Ok(Some(page.id));
        }
        Ok(Some(plan.create_page(title)))
    }
}

/// Start tracking an existing block's revision for this plan.
fn touch(plan: &mut Plan, block: &Block, revision: Option<i64>) {
    plan.revisions
        .insert(block.id.clone(), revision.unwrap_or(block.revision));
}

/// Inverse operations in undo order. Each is based on the revision the
/// change left, advanced by the inverses before it on the same block.
fn inverse(steps: &[Step], committed: &Committed) -> Result<Vec<Operation>> {
    let mut revisions: HashMap<&str, i64> = committed
        .revisions
        .iter()
        .map(|revision| (revision.id.as_str(), revision.revision))
        .collect();
    let mut cards: HashMap<&str, i64> = committed
        .cards
        .iter()
        .map(|revision| (revision.id.as_str(), revision.revision))
        .collect();
    let mut decks: HashMap<&str, i64> = committed
        .decks
        .iter()
        .map(|revision| (revision.id.as_str(), revision.revision))
        .collect();
    let mut deletions = committed.deletions.iter();
    let deletion_ids: Vec<Option<&String>> = steps
        .iter()
        .map(|step| match step {
            Step::Restore { .. } => deletions.next(),
            _ => None,
        })
        .collect();
    let mut operations = Vec::with_capacity(steps.len());
    for (step, deletion) in steps.iter().zip(deletion_ids).rev() {
        if let Step::DeckDeleted { id, name, query } = step {
            operations.push(Operation::SaveDeck {
                id: id.clone(),
                base_revision: None,
                name: name.clone(),
                query: query.clone(),
            });
            continue;
        }
        let revisions = match step {
            Step::CardHeld { .. } => &mut cards,
            Step::DeckCreated { .. } | Step::DeckSaved { .. } => &mut decks,
            _ => &mut revisions,
        };
        let revision = revisions
            .get_mut(step.id())
            .ok_or_else(|| validation(format!("{} did not change", step.id())))?;
        let base_revision = *revision;
        *revision += 1;
        let id = step.id().to_owned();
        operations.push(match step {
            Step::Text { text, .. } => Operation::EditText {
                id,
                base_revision,
                text: text.clone(),
            },
            Step::Heading { heading, .. } => Operation::SetHeading {
                id,
                base_revision,
                heading: *heading,
            },
            Step::Move {
                parent_id, after, ..
            } => Operation::Move {
                id,
                base_revision,
                parent_id: parent_id.clone(),
                after: after.clone(),
            },
            Step::Restore { .. } => Operation::Restore {
                id,
                deletion_id: deletion
                    .ok_or_else(|| validation("delete recorded no deletion event"))?
                    .clone(),
                revision: base_revision,
            },
            Step::Task { states, .. } => match &**states {
                (Some(before), Some(after)) => Operation::RestoreTaskState {
                    id,
                    base_revision,
                    expected: after.clone(),
                    task: before.clone(),
                },
                (before, _) => Operation::SetTask {
                    id,
                    base_revision,
                    task: before.clone(),
                },
            },
            Step::Uncomplete { occurrence_id, .. } => Operation::ReverseTaskCompletion {
                id,
                base_revision,
                occurrence_id: occurrence_id.clone(),
            },
            Step::CardHeld { held, .. } => Operation::SetCardHeld {
                id,
                base_revision,
                held: *held,
            },
            Step::DeckCreated { .. } => Operation::DeleteDeck { id, base_revision },
            Step::DeckSaved { name, query, .. } => Operation::SaveDeck {
                id,
                base_revision: Some(base_revision),
                name: name.clone(),
                query: query.clone(),
            },
            Step::DeckDeleted { .. } => unreachable!("deleted decks are recreated above"),
            Step::Uncite { citation_id, .. } => Operation::Uncite {
                id,
                base_revision,
                citation_id: citation_id.clone(),
            },
        });
    }
    Ok(operations)
}

/// The row and revision an inverse operation is checked against, or `None`
/// when it instead checks that a deleted deck is absent.
fn base_revision(operation: &mut Operation) -> Option<(String, &mut i64)> {
    match operation {
        Operation::EditText {
            id, base_revision, ..
        }
        | Operation::SetHeading {
            id, base_revision, ..
        }
        | Operation::Move {
            id, base_revision, ..
        }
        | Operation::Delete { id, base_revision }
        | Operation::SetTask {
            id, base_revision, ..
        }
        | Operation::RestoreTaskState {
            id, base_revision, ..
        }
        | Operation::ReverseTaskCompletion {
            id, base_revision, ..
        }
        | Operation::SetCardHeld {
            id, base_revision, ..
        }
        | Operation::DeleteDeck { id, base_revision }
        | Operation::Uncite {
            id, base_revision, ..
        }
        | Operation::Restore {
            id,
            revision: base_revision,
            ..
        } => Some((id.clone(), base_revision)),
        Operation::SaveDeck {
            id, base_revision, ..
        } => base_revision
            .as_mut()
            .map(|revision| (id.clone(), revision)),
        _ => unreachable!("undo records only these operations"),
    }
}

/// The revisions `committed` left on `ids`.
fn resulting(committed: &Committed, ids: &[String]) -> Result<Vec<Revision>> {
    ids.iter()
        .map(|id| {
            committed
                .revisions
                .iter()
                .find(|revision| &revision.id == id)
                .cloned()
                .ok_or_else(|| validation(format!("block {id} has no resulting revision")))
        })
        .collect()
}

fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "todo",
        TaskStatus::Doing => "doing",
        TaskStatus::Waiting => "waiting",
        TaskStatus::Done => "done",
        TaskStatus::Cancelled => "cancelled",
    }
}

/// The start of a block's text for summaries.
fn snippet(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(48) {
        Some((end, _)) => format!("{}…", line[..end].trim_end()),
        None => line.to_owned(),
    }
}

/// Match `matchFieldEntry` without allocating a regex for each block. The
/// editor's non-Unicode regex counts name length in UTF-16 code units.
fn field_shorthand(text: &str) -> Option<(&str, &str)> {
    let (name, value) = text.split_once("::")?;
    let length = name.encode_utf16().count();
    if !(1..=60).contains(&length)
        || name.contains([
            '\\', '`', '[', ']', '#', ':', '\n', '\r', '\u{2028}', '\u{2029}',
        ])
    {
        return None;
    }
    let name = name.trim_matches(editor_whitespace);
    if name.is_empty() {
        return None;
    }
    let parsed = crate::card_text::parse_card_text(name);
    if !parsed.cards.is_empty() || !parsed.problems.is_empty() {
        return None;
    }
    let value = match value.chars().next() {
        Some(ch) if editor_whitespace(ch) => &value[ch.len_utf8()..],
        _ => value,
    };
    if value.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((name, value))
}

fn editor_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
