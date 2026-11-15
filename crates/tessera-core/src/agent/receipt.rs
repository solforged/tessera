//! Idempotency keys and the stored agent receipt.

use std::default::Default;

use rusqlite::{OptionalExtension, params};

use super::plan::{Plan, next_revision, snippet, touch};
use super::request::KEY_LIMIT;
use super::{AgentEdit, AgentReceipt, AgentRequest};
use crate::history::{Step, Undo, inverse, provisional_undo_targets, resulting};
use crate::notebook::new_ulid;
use crate::storage::validation;
use crate::{Batch, BlockKind, Notebook, Operation, Result};

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
}
