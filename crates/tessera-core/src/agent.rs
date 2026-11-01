//! The agent write path. Agents name a target by title, date or ID instead
//! of tracking sibling order, and each request becomes one attributed batch.
//! Hand-written `[[Title]]` references link the way the browser links them
//! when a block is left. Every change stores its inverse in the same
//! transaction, so a person or the agent can undo it later; an undo refuses
//! rather than overwrite anything changed since.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::history::{Step, Undo, inverse, provisional_undo_targets, resulting};
use crate::notebook::{new_ulid, now_ms};
use crate::storage::{validate_date, validate_id, validation};
use crate::{
    Actor, Batch, Block, BlockKind, CardQuery, Committed, Deck, Error, FieldKind, FieldOption,
    Notebook, Operation, RelationKind, Result, Revision, TaskState, TaskStatus,
};

/// The most characters an agent may give a page title.
const TITLE_LIMIT: usize = 1000;
/// The most atoms one note may add, counting nested ones.
const NOTE_LIMIT: usize = 5000;
/// The longest idempotency key, in bytes.
const KEY_LIMIT: usize = 255;

/// Where a note is appended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteTarget {
    /// The live page with this title, ignoring tags and case, else the one
    /// page whose title or alias matches it folded, as `[[Name]]` links;
    /// created when none matches. A name several pages share is refused.
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

/// The result of [`Notebook::agent_edit`]. A keyed request sent again returns
/// its first receipt with `committed.replayed` set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentReceipt {
    /// The change to pass to [`Notebook::undo_change`].
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

#[derive(Default)]
struct Plan {
    operations: Vec<Operation>,
    steps: Vec<Step>,
    /// Pages resolved or created for this batch, by lowercase title.
    titles: HashMap<String, String>,
    /// Pages a `[[Name]]` reached by alias or another spelling of their title,
    /// by folded name.
    names: HashMap<String, String>,
    created: Vec<String>,
    /// Live and newly created field definitions, keyed by lowercase name.
    fields: Option<HashMap<String, String>>,
    /// Choice fields by definition ID, with their name and live options.
    choices: HashMap<String, (String, Vec<FieldOption>)>,
    /// Fields whose values must read as their kind, by definition ID, with
    /// their name and kind.
    checked: HashMap<String, (String, FieldKind)>,
    created_fields: Vec<String>,
    /// Option atoms of created definitions, removed with them by undo.
    options: Vec<String>,
    inserted: Vec<String>,
    removable: Vec<String>,
    changed: Vec<String>,
    saved_decks: Vec<String>,
    /// The revision the next operation on each touched block is based on.
    revisions: HashMap<String, i64>,
}

impl Plan {
    fn create_page(&mut self, title: &str) -> Result<String> {
        page_title(title)?;
        let id = new_ulid().to_string();
        self.operations.push(Operation::CreatePage {
            id: id.clone(),
            title: title.to_owned(),
        });
        self.titles
            .insert(crate::storage::title_key(title), id.clone());
        self.created.push(id.clone());
        Ok(id)
    }
}

/// `Name:: value` shorthand with its name resolved to a field definition.
struct Entry<'a> {
    field: String,
    name: &'a str,
    value: Option<&'a str>,
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
        self.agent_edit_keyed(request, None)
    }

    /// [`Notebook::agent_edit`] under an idempotency key, so a client that
    /// lost the answer can send the request again. The same key with the same
    /// request returns the stored receipt and writes nothing; the same key
    /// with a different request is refused.
    pub fn agent_edit_keyed(
        &mut self,
        request: &AgentRequest,
        key: Option<&str>,
    ) -> Result<AgentReceipt> {
        let keyed = match key {
            Some(key) => {
                if key.is_empty() || key.len() > KEY_LIMIT || key.contains(char::is_control) {
                    return Err(validation(format!(
                        "an idempotency key must have 1 to {KEY_LIMIT} characters and no control characters"
                    )));
                }
                let value = serde_json::to_value(request).expect("request serializes");
                let hash = crate::operations::operations_hash(&value.to_string());
                if let Some(receipt) = self.keyed_receipt(key, &hash)? {
                    return Ok(receipt);
                }
                Some((key, hash))
            }
            None => None,
        };
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
                plan.steps.push(Step::Restore {
                    id: id.clone(),
                    deletion_id: None,
                });
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
            AgentEdit::SetRelation {
                id,
                revision,
                relation,
            } => {
                let block = self.block(id)?;
                touch(&mut plan, &block, *revision);
                let previous = self.capabilities(id)?.relation.map(|info| info.kind);
                if previous == *relation {
                    return Err(validation(match relation {
                        Some(kind) => format!(
                            "nothing to change: the atom already has the {} relation",
                            kind.as_str()
                        ),
                        None => "nothing to change: the atom has no relation".into(),
                    }));
                }
                plan.operations.push(Operation::SetRelation {
                    id: id.clone(),
                    base_revision: next_revision(&mut plan.revisions, id),
                    relation: *relation,
                });
                plan.steps.push(Step::Relation {
                    id: id.clone(),
                    relation: previous,
                });
                plan.changed.push(id.clone());
                let summary = match relation {
                    Some(kind) => format!("Set {} relation", kind.as_str()),
                    None => "Removed relation".into(),
                };
                (Some(block.page_id), summary)
            }
            AgentEdit::Revisit {
                id,
                revision,
                action,
                next_on,
            } => {
                let block = self.block(id)?;
                touch(&mut plan, &block, *revision);
                let state = crate::revisit_store::snapshot(&self.conn, id)?;
                let changes = match action {
                    crate::RevisitAction::Revisited | crate::RevisitAction::KeepRecurrent => true,
                    crate::RevisitAction::Reopen => state.note.resolved_at.is_some(),
                    crate::RevisitAction::Later => {
                        let current = state
                            .question
                            .as_ref()
                            .map_or(state.note.revisit_on.as_ref(), |q| q.review_on.as_ref());
                        match next_on {
                            // Moving to the date it already has changes nothing.
                            Some(date) => current != Some(date),
                            None => {
                                state.note.revisit_on.is_some()
                                    || state.note.date_set_at.is_some()
                                    || state
                                        .question
                                        .as_ref()
                                        .is_some_and(|q| q.review_on.is_some())
                            }
                        }
                    }
                    crate::RevisitAction::Resolve => {
                        state.question.as_ref().map_or_else(
                            || state.note.resolved_at.is_none(),
                            |q| q.unsettled || q.review_on.is_some(),
                        ) || state.note.revisit_on.is_some()
                            || state.note.date_set_at.is_some()
                    }
                };
                // A target that cannot be revisited at all is refused when
                // applied, with that reason instead.
                let revisitable = state.question.is_some()
                    || block.kind == BlockKind::Page
                        && crate::fields::page_id(&self.conn)?.as_deref() != Some(id.as_str());
                if !changes && revisitable {
                    let reason = match action {
                        crate::RevisitAction::Reopen => "the atom is not resolved",
                        crate::RevisitAction::Later if next_on.is_some() => {
                            "the atom already revisits on that date"
                        }
                        crate::RevisitAction::Later => "the atom has no revisit date to clear",
                        crate::RevisitAction::Resolve if state.question.is_some() => {
                            "the question has no revisit date and is not kept recurrent"
                        }
                        crate::RevisitAction::Resolve => "the atom is already resolved",
                        crate::RevisitAction::Revisited | crate::RevisitAction::KeepRecurrent => {
                            unreachable!("a completed revisit always changes the atom")
                        }
                    };
                    return Err(validation(format!("nothing to change: {reason}")));
                }
                let event_id = matches!(
                    action,
                    crate::RevisitAction::Revisited | crate::RevisitAction::KeepRecurrent
                )
                .then(|| new_ulid().to_string());
                plan.operations.push(Operation::Revisit {
                    id: id.clone(),
                    base_revision: next_revision(&mut plan.revisions, id),
                    action: *action,
                    next_on: next_on.clone(),
                    event_id: event_id.clone(),
                });
                if changes {
                    plan.steps.push(Step::Revisit {
                        id: id.clone(),
                        state,
                        event_id,
                    });
                    plan.changed.push(id.clone());
                }
                let summary = match action {
                    crate::RevisitAction::Revisited => "Revisited",
                    crate::RevisitAction::Later => "Moved the revisit date",
                    crate::RevisitAction::Resolve => "Resolved",
                    crate::RevisitAction::Reopen => "Reopened",
                    crate::RevisitAction::KeepRecurrent => "Kept recurrent",
                };
                (Some(block.page_id), summary.into())
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
            options,
            inserted,
            removable,
            changed,
            saved_decks,
            ..
        } = plan;
        // Undo deletes a created definition only while the change made every
        // atom under it, so its starting options count as made here.
        let created_atoms: Vec<String> = inserted.iter().chain(&options).cloned().collect();
        let provisional = provisional_undo_targets(&self.conn, &steps)?;
        let committed = self.apply_with(
            &Batch {
                actor: request.actor.clone(),
                reason: request.reason.clone(),
                idempotency_key: None,
                operations,
            },
            |tx, committed| {
                let mut operations = inverse(&steps, committed)?;
                for id in &committed.removed {
                    if provisional.contains(id) {
                        let row = crate::storage::stored(tx, id)?.expect("deleted page exists");
                        operations.push(Operation::Restore {
                            id: id.clone(),
                            revision: row.block.revision,
                            deletion_id: row.deletion_id.expect("cleaned page has a deletion"),
                        });
                    }
                }
                let mut created_pages = resulting(committed, &created)?;
                for revision in &committed.revisions {
                    if revision.revision == 1
                        && !created.contains(&revision.id)
                        && crate::storage::stored(tx, &revision.id)?
                            .is_some_and(|row| row.block.kind == BlockKind::Page
                                && crate::notes::built_in_tag_name(&crate::storage::title_key(&row.block.text)).is_none())
                    {
                        created_pages.push(revision.clone());
                    }
                }
                let undo = Undo {
                    operations,
                    removable: resulting(committed, &removable)?,
                    inserted: created_atoms.clone(),
                    created_pages,
                    created_fields: resulting(committed, &created_fields)?,
                };
                tx.execute(
                    "INSERT INTO change_history(seq, summary, page_id, undo, idempotency_key, request_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(seq) DO UPDATE SET summary = excluded.summary, page_id = excluded.page_id,
                         undo = excluded.undo, idempotency_key = excluded.idempotency_key,
                         request_hash = excluded.request_hash",
                    params![
                        committed.seq,
                        summary,
                        page_id,
                        serde_json::to_string(&undo).expect("undo serializes"),
                        keyed.as_ref().map(|(key, _)| *key),
                        keyed.as_ref().map(|(_, hash)| hash),
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
        let receipt = AgentReceipt {
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
        };
        if keyed.is_some() {
            self.conn.execute(
                "UPDATE change_history SET receipt = ?1 WHERE seq = ?2",
                params![
                    serde_json::to_string(&receipt).expect("receipt serializes"),
                    receipt.seq
                ],
            )?;
        }
        Ok(receipt)
    }

    /// The stored receipt of the change made under `key`, when there is one.
    fn keyed_receipt(&self, key: &str, hash: &str) -> Result<Option<AgentReceipt>> {
        let Some((seq, prior, receipt)) = self
            .conn
            .query_row(
                "SELECT seq, request_hash, receipt FROM change_history WHERE idempotency_key = ?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        if prior.as_deref() != Some(hash) {
            return Err(validation(format!(
                "idempotency key {key} was already used for a different request, change {seq}; send this request with a new key"
            )));
        }
        let Some(receipt) = receipt else {
            return Err(validation(format!(
                "change {seq} was made under idempotency key {key}, but its receipt was not kept; read the change in history instead"
            )));
        };
        let mut receipt: AgentReceipt = serde_json::from_str(&receipt)
            .map_err(|error| validation(format!("invalid stored receipt: {error}")))?;
        // Sync can renumber a replica's changes; the history row keeps the current number.
        receipt.seq = seq;
        receipt.committed.seq = seq;
        receipt.committed.replayed = true;
        Ok(Some(receipt))
    }

    fn plan_note(
        &self,
        plan: &mut Plan,
        target: &NoteTarget,
        blocks: &[NoteBlock],
    ) -> Result<(String, String)> {
        if blocks.is_empty() {
            return Err(validation("a capture must contain an atom"));
        }
        if note_size(blocks) > NOTE_LIMIT {
            return Err(validation(format!(
                "a note can add at most {NOTE_LIMIT} atoms, counting nested ones; split it into several notes"
            )));
        }
        let mut tagged = Vec::new();
        let mut values = None;
        let (page_id, parent_id, after, title) = match target {
            NoteTarget::Page { title } => {
                let title = title.trim();
                page_title(title)?;
                if crate::storage::title_key(title) == "fields" {
                    return Err(fields_target());
                }
                let page = match self.named_page(title)? {
                    crate::aliases::Named::Title(page) => {
                        plan.titles
                            .insert(crate::storage::title_key(title), page.id.clone());
                        Some(page)
                    }
                    // A link with the same wording in the note keeps it, as
                    // `[[Name]]` does when it reaches a page by another name.
                    crate::aliases::Named::Folded(page) => {
                        plan.names
                            .insert(crate::aliases::fold(title), page.id.clone());
                        Some(page)
                    }
                    crate::aliases::Named::Several(matches) => {
                        return Err(self.ambiguous_name(title, &matches)?);
                    }
                    crate::aliases::Named::None => None,
                };
                match page {
                    Some(page) => {
                        if crate::fields::page_id(&self.conn)?.as_deref() == Some(page.id.as_str())
                        {
                            return Err(fields_target());
                        }
                        tagged = self.plan_tags(plan, &page, title)?;
                        let after = self.last_child(&page.id, &page.id)?;
                        (page.id.clone(), page.id, after, page.text)
                    }
                    None => {
                        let id = plan.create_page(title)?;
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
                if crate::fields::page_id(&self.conn)?.as_deref() == Some(block.page_id.as_str()) {
                    return Err(fields_target());
                }
                let after = self.last_child(&block.page_id, &block.id)?;
                let title = self.block(&block.page_id)?.text;
                values = self.choice_entry(plan, &block)?;
                (block.page_id, block.id, after, title)
            }
        };
        self.plan_blocks(plan, &parent_id, after, blocks, true, values.as_deref())?;
        let count = plan.inserted.len();
        let mut summary = format!(
            "Added {count} atom{} to {title}",
            if count == 1 { "" } else { "s" }
        );
        if !tagged.is_empty() {
            summary.push_str(" and tagged it ");
            summary.push_str(&listed(&tagged));
        }
        Ok((page_id, summary))
    }

    /// File an existing page under the tags its target title gives, as
    /// creating the page with that title would: each tag the page is not
    /// yet filed under is appended to its title as written. Tags never
    /// change a page's name, so this is not a rename. Returns those tags.
    fn plan_tags<'a>(&self, plan: &mut Plan, page: &Block, title: &'a str) -> Result<Vec<&'a str>> {
        let mut seen = HashSet::new();
        let mut missing = Vec::new();
        for token in crate::tag_tokens(title) {
            let key = crate::storage::title_key(token.title);
            let type_id = match token.id {
                Some(id) => crate::storage::live_tag(&self.conn, id)?.map(|_| id.to_owned()),
                None => crate::storage::resolve_type(
                    &self.conn,
                    token.title,
                    &key,
                    None,
                    &mut Vec::new(),
                )?,
            };
            let filed = match &type_id {
                // A page is never filed under itself.
                Some(type_id) => {
                    *type_id == page.id
                        || self.conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM memberships WHERE block_id = ?1 AND type_id = ?2)",
                            params![page.id, type_id],
                            |row| row.get(0),
                        )?
                }
                None => false,
            };
            if seen.insert(type_id.unwrap_or(key)) && !filed {
                missing.push(&title[token.span]);
            }
        }
        if !missing.is_empty() {
            touch(plan, page, None);
            plan_text(
                plan,
                page,
                format!("{} {}", page.text.trim_end(), missing.join(" ")),
            );
            plan.changed.push(page.id.clone());
        }
        Ok(missing)
    }

    /// Plan `blocks` under `parent_id`. When the parent is an entry of the
    /// choice field `values`, each block is one of its values and links the
    /// option it names, as the entry's shorthand value does.
    fn plan_blocks(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        mut after: Option<String>,
        blocks: &[NoteBlock],
        top: bool,
        values: Option<&str>,
    ) -> Result<()> {
        for block in blocks {
            let id = new_ulid().to_string();
            let (text, entry) = match values {
                Some(field) => (self.value_text(plan, field, &block.text)?, None),
                None => self.note_text(plan, &block.text)?,
            };
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
            let value_id = self.plan_value(plan, &id, entry.as_ref(), false)?;
            let choice = entry
                .as_ref()
                .map(|entry| entry.field.as_str())
                .filter(|field| plan.choices.contains_key(*field));
            self.plan_blocks(plan, &id, value_id, &block.children, false, choice)?;
        }
        Ok(())
    }

    /// Convert editor field shorthand before resolving ordinary title links.
    fn note_text<'a>(&self, plan: &mut Plan, text: &'a str) -> Result<(String, Option<Entry<'a>>)> {
        if let Some((name, value)) = field_shorthand(text) {
            let field = self.field_target(plan, name)?;
            Ok((
                format!("[[{field}]]"),
                Some(Entry {
                    field,
                    name,
                    value: (!value.is_empty()).then_some(value),
                }),
            ))
        } else {
            Ok((self.link_titles(plan, text)?, None))
        }
    }

    /// Load the live field definitions into the plan once: their IDs by
    /// lowercase name, choice fields' options and the kinds values must read as.
    fn load_fields(&self, plan: &mut Plan) -> Result<()> {
        if plan.fields.is_some() {
            return Ok(());
        }
        let mut fields = HashMap::new();
        for field in crate::fields::definitions(&self.conn)? {
            match field.kind {
                // Status and priority keep their task options, never value links.
                FieldKind::Choice if crate::built_in::task_options(&field.name).is_empty() => {
                    plan.choices
                        .insert(field.id.clone(), (field.name.clone(), field.options));
                }
                kind if value_form(kind).is_some() => {
                    plan.checked
                        .insert(field.id.clone(), (field.name.clone(), kind));
                }
                _ => {}
            }
            fields.insert(field.name.to_lowercase(), field.id);
        }
        plan.fields = Some(fields);
        Ok(())
    }

    /// The choice field `block` is an entry of, whose values are the blocks
    /// under it.
    fn choice_entry(&self, plan: &mut Plan, block: &Block) -> Result<Option<String>> {
        let Some(field) = crate::fields::reference(&block.text) else {
            return Ok(None);
        };
        if block.kind != BlockKind::Block {
            return Ok(None);
        }
        self.load_fields(plan)?;
        Ok(plan.choices.contains_key(field).then(|| field.to_owned()))
    }

    fn field_target(&self, plan: &mut Plan, name: &str) -> Result<String> {
        self.load_fields(plan)?;
        let key = name.to_lowercase();
        if let Some(id) = plan.fields.as_ref().and_then(|fields| fields.get(&key)) {
            return Ok(id.clone());
        }
        let page = match crate::fields::page_id(&self.conn)? {
            Some(id) => id,
            None => match plan.titles.get("fields") {
                Some(id) => id.clone(),
                None => plan.create_page("Fields")?,
            },
        };
        let after = if let Some(id) = plan.created_fields.last() {
            Some(id.clone())
        } else if plan.created.contains(&page) {
            None
        } else {
            self.last_child(&page, &page)?
        };
        // A built-in name gets the definition the core owns: its lowercase
        // name, kind and starting options, as a template would make it.
        let built_in = crate::built_in::field_named(name);
        let id = match built_in {
            Some(field) if crate::built_in::task_field(field.name).is_some() => {
                crate::notebook::derived_id(&["task-field", &page, field.name])
            }
            _ => new_ulid().to_string(),
        };
        plan.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: page,
            after,
            text: built_in.map_or(name, |field| field.name).to_owned(),
            heading: None,
        });
        if let Some(field) = built_in.filter(|field| field.kind != FieldKind::Text) {
            // Setting a relation's kind files Links to its types where those pages exist.
            plan.operations.push(Operation::SetFieldKind {
                id: id.clone(),
                base_revision: 1,
                kind: field.kind,
            });
            if field.kind == FieldKind::Choice {
                if crate::built_in::task_options(field.name).is_empty() {
                    let (operations, options) = crate::built_in::starting_options(field, &id);
                    plan.operations.extend(operations);
                    plan.options
                        .extend(options.iter().map(|option| option.id.clone()));
                    plan.choices
                        .insert(id.clone(), (field.name.to_owned(), options));
                }
            } else if value_form(field.kind).is_some() {
                plan.checked
                    .insert(id.clone(), (field.name.to_owned(), field.kind));
            }
        }
        if let Some(field) = built_in.filter(|field| field.role != crate::FieldRole::Attribute) {
            // A gloss reads as a standfirst under its owner, as the editor's Gloss makes it.
            plan.operations.push(Operation::SetFieldRole {
                id: id.clone(),
                base_revision: if field.kind == FieldKind::Text { 1 } else { 2 },
                role: field.role,
            });
        }
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
        entry: Option<&Entry>,
        removable: bool,
    ) -> Result<Option<String>> {
        let Some((field, value)) = entry.and_then(|entry| Some((&entry.field, entry.value?)))
        else {
            return Ok(None);
        };
        let id = new_ulid().to_string();
        let text = self.value_text(plan, field, value)?;
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

    /// A field value as stored: a link to the option it names for a choice
    /// field, which never creates a page, or the text with its title
    /// references linked for any other field. A value a number, date, span,
    /// URL, identifier or checkbox field cannot read is refused.
    fn value_text(&self, plan: &mut Plan, field: &str, value: &str) -> Result<String> {
        let Some((name, options)) = plan.choices.get(field) else {
            let text = self.link_titles(plan, value)?;
            let Some((name, kind)) = plan.checked.get(field) else {
                return Ok(text);
            };
            let target = match crate::fields::reference(&text) {
                Some(id) if validate_id(id).is_ok() => self.live_block(id)?,
                _ => None,
            };
            let crate::Reading::Problem { problem, .. } =
                crate::fields::reading(*kind, field, &text, target.as_ref())
            else {
                return Ok(text);
            };
            let (noun, form) = value_form(*kind).expect("checked kinds have a written form");
            return Err(validation(format!(
                "{name} is {noun} field and “{}” is {problem}; {form}",
                value.trim()
            )));
        };
        let wanted = value.trim();
        let label = wanted
            .strip_prefix("[[")
            .and_then(|inner| inner.strip_suffix("]]"))
            .map_or(wanted, |inner| {
                crate::storage::reference_parts(inner).0.trim()
            });
        let folded = label.to_lowercase();
        if let Some(option) = options
            .iter()
            .find(|option| option.id == label || option.text.trim().to_lowercase() == folded)
        {
            return Ok(format!("[[{}]]", option.id));
        }
        Err(validation(if options.is_empty() {
            format!(
                "{name} is a choice field with no options yet; a person adds its options on the Fields page"
            )
        } else {
            let options: Vec<&str> = options.iter().map(|option| option.text.trim()).collect();
            format!(
                "“{wanted}” is not an option of {name}; use one of {}",
                listed(&options)
            )
        }))
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
        if block.kind != BlockKind::Block && heading.is_some_and(|level| level != 0) {
            return Err(validation(
                "a page or journal title cannot be a heading; set the heading on an atom inside it",
            ));
        }
        touch(plan, &block, revision);
        if let Some(text) = text {
            if block.kind == BlockKind::Block {
                let current = match crate::fields::reference(&block.text) {
                    Some(field) if crate::fields::is_definition(&self.conn, field)? => Some(field),
                    _ => None,
                };
                // A value under a choice entry links the option it names.
                let values = match (current, &block.parent_id) {
                    (None, Some(parent)) => self.choice_entry(plan, &self.block(parent)?)?,
                    _ => None,
                };
                let (linked, entry) = match &values {
                    Some(field) => (self.value_text(plan, field, text)?, None),
                    None => self.note_text(plan, text)?,
                };
                match (current, &entry) {
                    (Some(current), Some(entry)) if current != entry.field => {
                        return Err(validation(format!(
                            "this atom is the {} entry and cannot change to {}; delete it and write `{}:: …` as a new atom, or edit its value atom instead",
                            self.block(current)?.text,
                            entry.name,
                            entry.name
                        )));
                    }
                    (Some(_), Some(entry)) => {
                        self.plan_entry_value(plan, &block, revision, entry)?
                    }
                    _ => {
                        self.plan_value(plan, id, entry.as_ref(), true)?;
                        plan_text(plan, &block, linked);
                    }
                }
            } else {
                if block.kind == BlockKind::Page {
                    page_title(text.trim())?;
                }
                plan_text(plan, &block, text.to_owned());
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
        if plan.steps.is_empty() && plan.inserted.is_empty() {
            return Err(validation(
                "nothing to change: the atom already reads that way",
            ));
        }
        plan.changed.push(id.to_owned());
        let summary = match (block.kind, text) {
            (BlockKind::Page, Some(text)) if text != block.text => {
                format!("Renamed {} to {text}", block.text)
            }
            _ => format!(
                "Edited “{}” on {}",
                snippet(&self.readable(text.unwrap_or(&block.text))?),
                self.block(&block.page_id)?.text
            ),
        };
        Ok((block.page_id, summary))
    }

    /// Replace a field entry's first value, or give a value to an entry that
    /// has none, leaving the entry itself as it is.
    fn plan_entry_value(
        &self,
        plan: &mut Plan,
        block: &Block,
        revision: Option<i64>,
        entry: &Entry,
    ) -> Result<()> {
        // No operation may touch the entry itself, so check its revision here.
        if let Some(expected) = revision
            && expected != block.revision
        {
            return Err(Error::Conflict {
                op_index: plan.operations.len(),
                what: "atom",
                id: block.id.clone(),
                expected,
                found: Some(block.revision),
            });
        }
        let Some(value) = entry.value else {
            return Ok(());
        };
        let Some(first) = self.first_child(&block.id)? else {
            self.plan_value(plan, &block.id, Some(entry), true)?;
            return Ok(());
        };
        let text = self.value_text(plan, &entry.field, value)?;
        if text != first.text {
            touch(plan, &first, None);
            plan.changed.push(first.id.clone());
            plan_text(plan, &first, text);
        }
        Ok(())
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
                what: "card",
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
        let existing = id.map(|id| self.deck(id)).transpose()?;
        if existing.is_none() && revision.is_some() {
            return Err(validation(
                "revision applies only to an existing deck; give the deck's id, or leave revision out to create a deck",
            ));
        }
        let trimmed = name.trim();
        if let Some(deck) = &existing
            && deck.name == trimmed
            && deck.query == *query
        {
            return Err(validation(format!(
                "nothing to change: deck {} already has that name and query",
                deck.name
            )));
        }
        // Keeping a name that already matches another deck lets an older
        // duplicate still be saved; taking such a name is refused.
        let folded = trimmed.to_lowercase();
        if existing
            .as_ref()
            .is_none_or(|deck| deck.name.to_lowercase() != folded)
            && let Some(other) = self.decks()?.into_iter().find(|deck| {
                deck.name.to_lowercase() == folded
                    && existing.as_ref().is_none_or(|own| own.id != deck.id)
            })
        {
            return Err(validation(format!(
                "a deck named {} already exists ({}); choose another name, or save that deck by its id",
                other.name, other.id
            )));
        }
        let (id, base_revision, summary) = if let Some(deck) = existing {
            let base_revision = revision.unwrap_or(deck.revision);
            plan.steps.push(Step::DeckSaved {
                id: deck.id.clone(),
                name: deck.name,
                query: deck.query,
            });
            (
                deck.id,
                Some(base_revision),
                format!("Saved deck {trimmed}"),
            )
        } else {
            let id = new_ulid().to_string();
            plan.steps.push(Step::DeckCreated { id: id.clone() });
            (id, None, format!("Created deck {trimmed}"))
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
        let summary = format!("Deleted deck {} ({})", deck.name, deck.id);
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
        let mut pages: Vec<Block> = Vec::new();
        // The passage ordinals each snapshot's citations cover, to count each passage once.
        let mut covered: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        let mut planned = HashSet::new();
        for citation in citations {
            let block = self.block(&citation.block_id)?;
            if let Some(expected) = citation.revision
                && expected != block.revision
            {
                return Err(Error::Conflict {
                    op_index: plan.operations.len(),
                    what: "atom",
                    id: block.id,
                    expected,
                    found: Some(block.revision),
                });
            }
            if !pages.iter().any(|page| page.id == block.page_id) {
                pages.push(self.block(&block.page_id)?);
            }
            if !plan.revisions.contains_key(&block.id) {
                touch(plan, &block, citation.revision);
                plan.changed.push(block.id.clone());
            }
            if citation.quote.is_some() && citation.end_passage_id.is_some() {
                return Err(validation("give quote or end_passage_id, not both"));
            }
            if citation.quote.as_deref() == Some("") {
                return Err(validation(
                    "quote is empty; leave quote out to cite the whole passage",
                ));
            }
            let first = self.passage(&citation.passage_id)?;
            let snapshot: String = self.conn.query_row(
                "SELECT snapshot_id FROM passages WHERE id = ?1",
                [&first.id],
                |row| row.get(0),
            )?;
            let (start_offset, end_id, end_offset, last_ordinal) =
                if let Some(quote) = &citation.quote {
                    let offset = first.text.find(quote).ok_or_else(|| {
                        validation(format!("quote not found in passage {}", first.id))
                    })?;
                    (
                        first.text[..offset].encode_utf16().count(),
                        first.id.clone(),
                        first.text[..offset + quote.len()].encode_utf16().count(),
                        first.ordinal,
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
                    (
                        0,
                        last.id.clone(),
                        last.text.encode_utf16().count(),
                        last.ordinal,
                    )
                };
            let start_offset = u32::try_from(start_offset)
                .map_err(|_| validation("citation offset exceeds UTF-16 range"))?;
            let end_offset = u32::try_from(end_offset)
                .map_err(|_| validation("citation offset exceeds UTF-16 range"))?;
            let duplicate = !planned.insert((
                block.id.clone(),
                first.id.clone(),
                start_offset,
                end_id.clone(),
                end_offset,
            )) || self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM citations WHERE block_id = ?1 AND active = 1
                     AND start_passage = ?2 AND start_offset = ?3 AND end_passage = ?4 AND end_offset = ?5)",
                params![block.id, first.id, start_offset, end_id, end_offset],
                |row| row.get::<_, bool>(0),
            )?;
            if duplicate {
                return Err(validation(format!(
                    "nothing to change: atom {} already has this citation",
                    block.id
                )));
            }
            covered.entry(snapshot.clone()).or_default().push((
                first.ordinal.min(last_ordinal),
                first.ordinal.max(last_ordinal),
            ));
            let citation_id = new_ulid().to_string();
            plan.operations.push(Operation::Cite {
                id: block.id.clone(),
                base_revision: next_revision(&mut plan.revisions, &block.id),
                citation_id: citation_id.clone(),
                snapshot_id: snapshot,
                start: crate::library::PassagePoint {
                    passage_id: first.id,
                    offset: start_offset,
                },
                end: crate::library::PassagePoint {
                    passage_id: end_id,
                    offset: end_offset,
                },
                color: None,
            });
            plan.steps.push(Step::Uncite {
                id: block.id,
                citation_id,
            });
        }
        let count: i64 = covered
            .into_values()
            .map(|mut ranges| {
                ranges.sort_unstable();
                let (mut count, mut end) = (0, i64::MIN);
                for (from, through) in ranges {
                    let from = from.max(end.saturating_add(1));
                    if through >= from {
                        count += through - from + 1;
                    }
                    end = end.max(through);
                }
                count
            })
            .sum();
        let titles: Vec<&str> = pages.iter().map(|page| page.text.as_str()).collect();
        Ok((
            pages[0].id.clone(),
            format!(
                "Cited {count} passage{} on {}",
                if count == 1 { "" } else { "s" },
                listed(&titles)
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
            return Err(validation("a titled atom cannot be moved"));
        };
        let (parent, after) = match (parent_id, after, first) {
            (_, Some(_), true) => return Err(validation("give after or first, not both")),
            (parent, Some(after), false) => {
                let sibling = self.block(after)?;
                let sibling_parent = sibling.parent_id.ok_or_else(|| {
                    validation("an atom cannot be placed beside the outline's root")
                })?;
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
            return Err(validation("nothing to change: the atom is already there"));
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
            let (target, alias, locator) = crate::storage::reference_parts(reference);
            let label = match alias.filter(|alias| !alias.is_empty()) {
                Some(alias) => Some(alias.to_owned()),
                None if validate_id(target).is_ok() => {
                    self.live_block(target)?.map(|block| block.text)
                }
                None => None,
            };
            shown.push_str(&rest[..start]);
            shown.push_str(label.as_deref().unwrap_or(&rest[start..start + 4 + end]));
            if label.is_some()
                && let Some(locator) = locator.filter(|locator| !locator.is_empty())
            {
                shown.push('\u{2009}');
                shown.push_str(locator);
            }
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
        let finishing = target.status == Some(TaskStatus::Done)
            && current
                .as_ref()
                .is_none_or(|current| current.status != Some(TaskStatus::Done));
        if !finishing {
            let verb = match target.status {
                Some(status)
                    if current
                        .as_ref()
                        .is_some_and(|current| current.status == Some(status)) =>
                {
                    "Updated the task".to_owned()
                }
                Some(status) => format!("Set to {}", status_name(status)),
                None => "Scheduled".to_owned(),
            };
            set(plan, current, Some(target));
            return Ok(verb);
        }
        if current.as_ref().is_some_and(|task| task.status.is_none()) {
            return Err(validation("Add #task before completing."));
        }
        let open = TaskState {
            status: Some(match current.as_ref().and_then(|current| current.status) {
                Some(status @ (TaskStatus::Doing | TaskStatus::Waiting)) => status,
                _ => TaskStatus::Todo,
            }),
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

    fn first_child(&self, parent_id: &str) -> Result<Option<Block>> {
        let id: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                 ORDER BY ordinal, id LIMIT 1",
            )?
            .query_row([parent_id], |row| row.get(0))
            .optional()?;
        id.map(|id| self.block(&id)).transpose()
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

    /// Rewrite `[[Title]]` to `[[id]]` for the live page with that title, or
    /// to `[[id|Title]]` for the one page with that name or alias, creating it
    /// when missing, and keep any `|alias|locator`. A date names a journal day
    /// and stays as written when that day does not exist. ID references and
    /// `#[[Tag]]` tags are left alone.
    fn link_titles(&self, plan: &mut Plan, text: &str) -> Result<String> {
        let mut linked = String::with_capacity(text.len());
        let mut rest = text;
        let mut code = crate::storage::inline_code_spans(text).peekable();
        while let Some(start) = rest.find("[[") {
            let absolute_start = text.len() - rest.len() + start;
            while code.peek().is_some_and(|span| span.end <= absolute_start) {
                code.next();
            }
            let in_code = code.peek().is_some_and(|span| span.start <= absolute_start);
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
            let (target, alias, locator) = crate::storage::reference_parts(reference);
            let title = target.trim();
            let resolved = if in_code
                || tag
                || title.is_empty()
                || target
                    .get(..8)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                || target
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
                || title.contains(['[', ']', '\n', '\r'])
                || alias.is_some_and(|alias| alias.contains(']'))
                || validate_id(target).is_ok()
                || target
                    .strip_prefix("view:")
                    .is_some_and(|id| validate_id(id).is_ok())
            {
                None
            } else {
                self.title_target(plan, title)?
            };
            linked.push_str(before);
            match resolved {
                Some((id, renamed)) => {
                    linked.push_str("[[");
                    linked.push_str(&id);
                    // A page reached by another name keeps the typed wording.
                    let label = if renamed && alias.is_none_or(str::is_empty) {
                        Some(title)
                    } else {
                        alias
                    };
                    if let Some(label) = label {
                        linked.push('|');
                        linked.push_str(label);
                    }
                    if let Some(locator) = locator {
                        linked.push('|');
                        linked.push_str(locator);
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

    /// The page a hand-typed `[[Name]]` links, found as the editor finds it: a
    /// journal day for a date; the page with that title; else the one page
    /// whose title or alias matches ignoring case, diacritics and
    /// punctuation, marked `true` so the link keeps the typed name; else a
    /// new page. A name several pages share is refused with their IDs rather
    /// than guessed or duplicated.
    fn title_target(&self, plan: &mut Plan, title: &str) -> Result<Option<(String, bool)>> {
        let key = crate::storage::title_key(title);
        if let Some(id) = plan.titles.get(&key) {
            return Ok(Some((id.clone(), false)));
        }
        if date_shaped(title) {
            return Ok(match validate_date(title) {
                Ok(()) => self.journal(title)?.map(|day| (day.id, false)),
                Err(_) => None,
            });
        }
        if let Some(page) = self.page_by_title(title)? {
            plan.titles.insert(key, page.id.clone());
            return Ok(Some((page.id, false)));
        }
        let name = crate::aliases::fold(title);
        if let Some(id) = plan.names.get(&name) {
            return Ok(Some((id.clone(), true)));
        }
        let id = match self.folded_page(title)? {
            crate::aliases::Named::None => {
                // A page this change creates is not stored yet, so match it here.
                let created = plan
                    .titles
                    .iter()
                    .find(|(known, id)| {
                        !name.is_empty()
                            && plan.created.contains(id)
                            && crate::aliases::fold(known) == name
                    })
                    .map(|(_, id)| id.clone());
                match created {
                    Some(id) => id,
                    None => return plan.create_page(title).map(|id| Some((id, false))),
                }
            }
            crate::aliases::Named::Title(page) | crate::aliases::Named::Folded(page) => page.id,
            crate::aliases::Named::Several(matches) => {
                return Err(validation(format!(
                    "[[{title}]] could link {}, which share that name or alias; link the one you mean as [[ID|{title}]]",
                    self.name_candidates(&matches)?
                )));
            }
        };
        plan.names.insert(name, id.clone());
        Ok(Some((id, true)))
    }
}

/// Start tracking an existing block's revision for this plan.
fn touch(plan: &mut Plan, block: &Block, revision: Option<i64>) {
    plan.revisions
        .insert(block.id.clone(), revision.unwrap_or(block.revision));
}

/// Replace `block`'s text unless it already reads that way.
fn plan_text(plan: &mut Plan, block: &Block, text: String) {
    if text != block.text {
        plan.operations.push(Operation::EditText {
            id: block.id.clone(),
            base_revision: next_revision(&mut plan.revisions, &block.id),
            text,
        });
        plan.steps.push(Step::Text {
            id: block.id.clone(),
            text: block.text.clone(),
        });
    }
}

/// Refuse a page title that is too long, can never be linked, or is a date,
/// which names a journal day instead.
fn page_title(title: &str) -> Result<()> {
    if title.chars().count() > TITLE_LIMIT {
        return Err(validation(format!(
            "a page title can have at most {TITLE_LIMIT} characters"
        )));
    }
    if title.contains("[[") || title.contains("]]") {
        return Err(validation(
            "a page title cannot contain [[ or ]]; give the title without brackets",
        ));
    }
    if date_shaped(title) {
        return Err(validation(format!(
            "a page title cannot be a date: {title} names a journal day, which the journal target writes to"
        )));
    }
    Ok(())
}

fn fields_target() -> Error {
    validation(
        "the Fields page holds field definitions, not notes; to give an atom a field, write `Name:: value` in its note",
    )
}

/// `YYYY-MM-DD` in shape, whether or not it is a real date.
fn date_shaped(title: &str) -> bool {
    let bytes = title.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// How many atoms `blocks` holds, counting nested ones.
fn note_size(blocks: &[NoteBlock]) -> usize {
    blocks
        .iter()
        .map(|block| 1 + note_size(&block.children))
        .sum()
}

/// How a field kind whose unreadable values are refused is named, and how to
/// write a value it reads; `None` for kinds that keep any text.
fn value_form(kind: FieldKind) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        FieldKind::Number => ("a number", "write a number such as 42 or 3.5"),
        FieldKind::Date => (
            "a date",
            "write YYYY-MM-DD, YYYY-MM or YYYY, or link an existing journal day",
        ),
        FieldKind::Span => (
            "a span",
            "write years such as 1791–1871, c. 1493, b. 1947, d. 1871 or 1947–?",
        ),
        FieldKind::Url => (
            "a URL",
            "write an address that starts with https:// or http://",
        ),
        FieldKind::Identifier => ("an identifier", "write an ISBN, DOI or arXiv ID"),
        FieldKind::Checkbox => ("a checkbox", "write yes or no"),
        FieldKind::Text | FieldKind::Choice | FieldKind::Instance => return None,
    })
}

/// Names joined as prose: "A", "A and B", "A, B and C".
pub(crate) fn listed(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
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

/// The start of a block's text for summaries. A tag or reference the cut
/// would split is kept whole, so no identifier is truncated.
fn snippet(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(48) {
        Some((end, _)) => {
            let end = crate::tag_tokens(line)
                .map(|token| token.span)
                .chain(crate::reference_spans(line).map(|(span, _, _)| span))
                .find(|span| span.start < end && end < span.end)
                .map_or(end, |span| span.end);
            format!("{}…", line[..end].trim_end())
        }
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
