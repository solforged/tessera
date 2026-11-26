use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::*;

/// Whether an operation has a safe inverse the history log can replay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UndoSupport {
    /// A targeted read before apply can build the inverse.
    Inverse,
    /// The batch is listed without an undo row.
    None,
}

/// Classify every operation, so a new variant cannot be silently non-undoable.
pub(crate) fn undo_support(operation: &Operation) -> UndoSupport {
    match operation {
        Operation::CreatePage { .. }
        | Operation::CreateJournal { .. }
        | Operation::Insert { .. }
        | Operation::EditText { .. }
        | Operation::SetHeading { .. }
        | Operation::Move { .. }
        | Operation::Delete { .. }
        | Operation::Restore { .. }
        | Operation::SetTask { .. }
        | Operation::RestoreTaskState { .. }
        | Operation::CompleteTask { .. }
        | Operation::SetRelation { .. }
        | Operation::Revisit { .. }
        | Operation::SetCardHeld { .. }
        | Operation::SaveDeck { .. }
        | Operation::DeleteDeck { .. }
        | Operation::Cite { .. }
        | Operation::Uncite { .. }
        | Operation::SetCitationTriage { .. }
        | Operation::SetCitationColor { .. }
        | Operation::SetCitationRange { .. }
        | Operation::RestoreRevisit { event_id: None, .. } => UndoSupport::Inverse,
        // Split and merge have no safe inverse.
        Operation::Split { .. } | Operation::Merge { .. } | Operation::MergePage { .. } => {
            UndoSupport::None
        }
        // Review grades have no safe inverse.
        Operation::GradeCard { .. } | Operation::UndoGrade { .. } | Operation::ResetCard { .. } => {
            UndoSupport::None
        }
        // Review sessions have no captured inverse.
        Operation::StartReviewSession { .. } | Operation::FinishReviewSession { .. } => {
            UndoSupport::None
        }
        // Ingestion has no safe inverse.
        Operation::SetSource { .. } | Operation::AttachSnapshot { .. } => UndoSupport::None,
        // Settings have no safe inverse.
        Operation::SetSetting { .. } => UndoSupport::None,
        // Views have no safe inverse.
        Operation::SaveView { .. }
        | Operation::DeleteView { .. }
        | Operation::SaveTaskView { .. }
        | Operation::DeleteTaskView { .. }
        | Operation::SaveLibraryView { .. }
        | Operation::DeleteLibraryView { .. } => UndoSupport::None,
        // Tag membership edits have no captured inverse.
        Operation::AddType { .. } | Operation::RemoveType { .. } => UndoSupport::None,
        // Definition edits have no safe inverse.
        Operation::SetFieldKind { .. }
        | Operation::SetFieldHide { .. }
        | Operation::SetFieldRole { .. }
        | Operation::SetFieldCountsAs { .. }
        | Operation::SetFieldTargets { .. }
        | Operation::SetTypeFields { .. }
        | Operation::SetTypePresentation { .. }
        | Operation::SetSubjectCriteria { .. }
        | Operation::CreateCardTemplate { .. }
        | Operation::UpdateCardTemplate { .. }
        | Operation::SetCardTemplateApplied { .. }
        | Operation::DeleteCardTemplate { .. }
        | Operation::TransferCardKey { .. } => UndoSupport::None,
        // Sync settlement is a replica decision, not a local inverse.
        Operation::SettleSyncCopy { .. } | Operation::SettleSyncRejection { .. } => {
            UndoSupport::None
        }
        // Archive and the remaining capability writes have no captured inverse.
        Operation::SetArchived { .. }
        | Operation::ReverseTaskCompletion { .. }
        | Operation::SetProject { .. }
        | Operation::SetPosition { .. }
        | Operation::SetSpread { .. }
        | Operation::SetQuote { .. }
        | Operation::SetImage { .. }
        | Operation::SetOcclusion { .. }
        | Operation::SetQuestion { .. }
        | Operation::SetAssessment { .. }
        | Operation::StartWork { .. }
        | Operation::StopWork { .. }
        | Operation::EditWorkNote { .. }
        | Operation::SetWorkSessionState { .. } => UndoSupport::None,
        // A revisit restore that records an event cannot drop that event.
        Operation::RestoreRevisit {
            event_id: Some(_), ..
        } => UndoSupport::None,
    }
}

/// Subtree moves, deletes and restores bump descendants an inverse must advance.
pub(crate) fn needs_inverse_targets(operation: &Operation) -> bool {
    match operation {
        Operation::Move { .. } | Operation::Delete { .. } | Operation::Restore { .. } => true,
        // Other writes do not move an existing subtree under a captured inverse.
        Operation::SettleSyncCopy { .. }
        | Operation::SettleSyncRejection { .. }
        | Operation::SetSource { .. }
        | Operation::AttachSnapshot { .. }
        | Operation::Cite { .. }
        | Operation::Uncite { .. }
        | Operation::SetCitationTriage { .. }
        | Operation::SetCitationColor { .. }
        | Operation::SetCitationRange { .. }
        | Operation::CreatePage { .. }
        | Operation::CreateJournal { .. }
        | Operation::Insert { .. }
        | Operation::EditText { .. }
        | Operation::SetHeading { .. }
        | Operation::CreateCardTemplate { .. }
        | Operation::UpdateCardTemplate { .. }
        | Operation::SetCardTemplateApplied { .. }
        | Operation::DeleteCardTemplate { .. }
        | Operation::TransferCardKey { .. }
        | Operation::Split { .. }
        | Operation::Merge { .. }
        | Operation::MergePage { .. }
        | Operation::SetArchived { .. }
        | Operation::AddType { .. }
        | Operation::RemoveType { .. }
        | Operation::SetFieldKind { .. }
        | Operation::SetFieldHide { .. }
        | Operation::SetFieldRole { .. }
        | Operation::SetFieldCountsAs { .. }
        | Operation::SetFieldTargets { .. }
        | Operation::SetTypeFields { .. }
        | Operation::SetTypePresentation { .. }
        | Operation::SetSubjectCriteria { .. }
        | Operation::SaveView { .. }
        | Operation::DeleteView { .. }
        | Operation::SetSetting { .. }
        | Operation::SetTask { .. }
        | Operation::RestoreTaskState { .. }
        | Operation::CompleteTask { .. }
        | Operation::ReverseTaskCompletion { .. }
        | Operation::SetProject { .. }
        | Operation::SetPosition { .. }
        | Operation::SetRelation { .. }
        | Operation::SetSpread { .. }
        | Operation::Revisit { .. }
        | Operation::RestoreRevisit { .. }
        | Operation::SetQuote { .. }
        | Operation::SetImage { .. }
        | Operation::SetOcclusion { .. }
        | Operation::SetQuestion { .. }
        | Operation::SetAssessment { .. }
        | Operation::StartWork { .. }
        | Operation::StopWork { .. }
        | Operation::EditWorkNote { .. }
        | Operation::SetWorkSessionState { .. }
        | Operation::StartReviewSession { .. }
        | Operation::FinishReviewSession { .. }
        | Operation::GradeCard { .. }
        | Operation::UndoGrade { .. }
        | Operation::SetCardHeld { .. }
        | Operation::ResetCard { .. }
        | Operation::SaveDeck { .. }
        | Operation::DeleteDeck { .. }
        | Operation::SaveTaskView { .. }
        | Operation::DeleteTaskView { .. }
        | Operation::SaveLibraryView { .. }
        | Operation::DeleteLibraryView { .. } => false,
    }
}

/// Only local, fully reversible batches allocate capture state. Unsupported
/// batches have no history row; listing falls back to their committed counts.
#[derive(Default)]
pub(crate) struct Capture {
    pub(crate) steps: Vec<Step>,
    inserted: Vec<String>,
    inserted_ids: HashSet<String>,
    provisional: HashSet<String>,
}

impl Capture {
    pub(crate) fn for_batch(batch: &Batch) -> Option<Self> {
        batch
            .operations
            .iter()
            .all(|operation| undo_support(operation) == UndoSupport::Inverse)
            .then(Self::default)
    }

    /// Read only the operation's target, not its page or descendants. The
    /// engine's revision map then tells the caller whether it was a no-op.
    pub(crate) fn before(
        &mut self,
        conn: &Connection,
        operation: &Operation,
    ) -> Result<Option<(Step, i64)>> {
        let (step, revision) = match operation {
            Operation::CreatePage { id, .. }
            | Operation::CreateJournal { id, .. }
            | Operation::Insert { id, .. } => {
                self.inserted.push(id.clone());
                self.inserted_ids.insert(id.clone());
                return Ok(None);
            }
            Operation::EditText { id, .. }
            | Operation::SetHeading { id, .. }
            | Operation::Delete { id, .. }
            | Operation::Restore { id, .. } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                let row = stored(conn, id)?.ok_or_else(|| not_found(id))?;
                let step = match operation {
                    Operation::EditText { .. } => Step::Text {
                        id: id.clone(),
                        text: row.block.text,
                    },
                    Operation::SetHeading { .. } => Step::Heading {
                        id: id.clone(),
                        heading: row.block.heading,
                    },
                    Operation::Delete { .. } => Step::Restore {
                        id: id.clone(),
                        deletion_id: None,
                    },
                    Operation::Restore { .. } => Step::Delete { id: id.clone() },
                    _ => unreachable!("only these edits are captured here"),
                };
                (step, row.block.revision)
            }
            Operation::Move { id, .. } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                conn.prepare_cached(
                    "SELECT b.parent_id, b.revision,
                        (SELECT s.id FROM blocks s WHERE s.parent_id = b.parent_id
                         AND s.deletion_id IS NULL AND (s.ordinal, s.id) < (b.ordinal, b.id)
                         ORDER BY s.ordinal DESC, s.id DESC LIMIT 1)
                     FROM blocks b WHERE b.id = ?1",
                )?
                .query_row([id], |row| {
                    Ok((
                        Step::Move {
                            id: id.clone(),
                            parent_id: row.get(0)?,
                            after: row.get(2)?,
                        },
                        row.get(1)?,
                    ))
                })?
            }
            Operation::SetTask { id, .. } | Operation::RestoreTaskState { id, .. } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                let (revision, state, text, task_id): (
                    i64,
                    Option<String>,
                    String,
                    Option<String>,
                ) = conn
                    .prepare_cached(
                        "SELECT b.revision, t.state, b.text,
                            (SELECT id FROM blocks WHERE kind = 'page'
                             AND title_key = 'task' AND deletion_id IS NULL)
                         FROM blocks b LEFT JOIN tasks t
                         ON t.block_id = b.id AND t.active = 1 WHERE b.id = ?1",
                    )?
                    .query_row([id], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?;
                if matches!(operation, Operation::SetTask { task: None, .. })
                    && crate::storage::remove_tag(&text, "task", task_id.as_deref()).is_some()
                {
                    let step = Step::Text {
                        id: id.clone(),
                        text,
                    };
                    self.provisional
                        .extend(provisional_undo_targets(conn, std::slice::from_ref(&step))?);
                    self.steps.push(step);
                }
                let before = state
                    .map(|state| serde_json::from_str(&state))
                    .transpose()
                    .map_err(|error| validation(format!("invalid task state: {error}")))?;
                let after = match operation {
                    Operation::SetTask { task, .. } => task.clone(),
                    Operation::RestoreTaskState { task, .. } => Some(task.clone()),
                    _ => unreachable!(),
                };
                (
                    Step::Task {
                        id: id.clone(),
                        states: Box::new((before, after)),
                    },
                    revision,
                )
            }
            Operation::CompleteTask {
                id, occurrence_id, ..
            } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                let revision = conn
                    .prepare_cached("SELECT revision FROM blocks WHERE id = ?1")?
                    .query_row([id], |row| row.get(0))?;
                (
                    Step::Uncomplete {
                        id: id.clone(),
                        occurrence_id: occurrence_id.clone(),
                    },
                    revision,
                )
            }
            Operation::SetRelation { id, .. } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                let (revision, relation): (i64, Option<String>) = conn
                    .prepare_cached(
                        "SELECT b.revision, r.kind FROM blocks b
                     LEFT JOIN relations r ON r.block_id = b.id AND r.active = 1 WHERE b.id = ?1",
                    )?
                    .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let relation = relation
                    .map(|kind| serde_json::from_value(serde_json::Value::String(kind)))
                    .transpose()
                    .map_err(|error| validation(format!("invalid relation: {error}")))?;
                (
                    Step::Relation {
                        id: id.clone(),
                        relation,
                    },
                    revision,
                )
            }
            Operation::Revisit { id, event_id, .. }
            | Operation::RestoreRevisit { id, event_id, .. } => {
                if self.inserted_ids.contains(id) {
                    return Ok(None);
                }
                let (revision, note, question): (i64, crate::NoteState, Option<String>) =
                    conn.prepare_cached(
                        "SELECT b.revision, n.resolved_at, n.revisit_on, n.date_set_at, q.state
                         FROM blocks b LEFT JOIN note_states n ON n.block_id = b.id
                         LEFT JOIN questions q ON q.block_id = b.id AND q.active = 1 WHERE b.id = ?1",
                    )?.query_row([id], |row| Ok((
                        row.get(0)?,
                        crate::NoteState {
                            resolved_at: row.get(1)?,
                            revisit_on: row.get(2)?,
                            date_set_at: row.get(3)?,
                        },
                        row.get(4)?,
                    )))?;
                let question = question
                    .map(|state| serde_json::from_str(&state))
                    .transpose()
                    .map_err(|error| validation(format!("invalid question: {error}")))?;
                (
                    Step::Revisit {
                        id: id.clone(),
                        state: crate::RevisitSnapshot { note, question },
                        event_id: event_id.clone(),
                    },
                    revision,
                )
            }
            Operation::SetCardHeld { id, held, .. } => {
                let (before, revision): (bool, i64) = conn
                    .prepare_cached("SELECT held, revision FROM card_units WHERE id = ?1")?
                    .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                if before == *held {
                    return Ok(None);
                }
                (
                    Step::CardHeld {
                        id: id.clone(),
                        held: before,
                    },
                    revision,
                )
            }
            Operation::SaveDeck { id, .. } | Operation::DeleteDeck { id, .. } => {
                let prior: Option<(String, String, i64)> = conn
                    .prepare_cached("SELECT name, query, revision FROM decks WHERE id = ?1")?
                    .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .optional()?;
                match prior {
                    Some((name, query, revision)) => {
                        let query = serde_json::from_str(&query)
                            .map_err(|error| validation(format!("invalid deck query: {error}")))?;
                        let step = if matches!(operation, Operation::DeleteDeck { .. }) {
                            Step::DeckDeleted {
                                id: id.clone(),
                                name,
                                query,
                            }
                        } else {
                            Step::DeckSaved {
                                id: id.clone(),
                                name,
                                query,
                            }
                        };
                        (step, revision)
                    }
                    None => (Step::DeckCreated { id: id.clone() }, 0),
                }
            }
            Operation::Cite {
                id, citation_id, ..
            } => {
                let revision = conn
                    .prepare_cached("SELECT revision FROM blocks WHERE id = ?1")?
                    .query_row([id], |row| row.get(0))?;
                (
                    Step::Uncite {
                        id: id.clone(),
                        citation_id: citation_id.clone(),
                    },
                    revision,
                )
            }
            Operation::Uncite { citation_id, .. }
            | Operation::SetCitationTriage {
                id: citation_id, ..
            }
            | Operation::SetCitationColor {
                id: citation_id, ..
            }
            | Operation::SetCitationRange {
                id: citation_id, ..
            } => conn
                .prepare_cached(
                    "SELECT c.block_id, b.revision, c.snapshot_id, c.start_passage,
                        c.start_offset, c.end_passage, c.end_offset, c.color, c.triage
                     FROM citations c JOIN blocks b ON b.id = c.block_id WHERE c.id = ?1",
                )?
                .query_row([citation_id], |row| {
                    let id = row.get(0)?;
                    let citation_id = citation_id.clone();
                    let start = crate::library::PassagePoint {
                        passage_id: row.get(3)?,
                        offset: row.get(4)?,
                    };
                    let end = crate::library::PassagePoint {
                        passage_id: row.get(5)?,
                        offset: row.get(6)?,
                    };
                    let step = match operation {
                        Operation::Uncite { .. } => Step::Cite {
                            id,
                            citation_id,
                            snapshot_id: row.get(2)?,
                            start,
                            end,
                            color: row.get(7)?,
                        },
                        Operation::SetCitationTriage { .. } => Step::CitationTriage {
                            id,
                            citation_id,
                            triage: row.get(8)?,
                        },
                        Operation::SetCitationColor { .. } => Step::CitationColor {
                            id,
                            citation_id,
                            color: row.get(7)?,
                        },
                        Operation::SetCitationRange { .. } => Step::CitationRange {
                            id,
                            citation_id,
                            start,
                            end,
                        },
                        _ => unreachable!("only citation edits are captured here"),
                    };
                    Ok((step, row.get(1)?))
                })?,
            other => {
                debug_assert_eq!(
                    undo_support(other),
                    UndoSupport::None,
                    "only fully reversible batches are captured"
                );
                unreachable!("only fully reversible batches are captured")
            }
        };
        if self.inserted_ids.contains(step.id())
            && !matches!(
                step,
                Step::CardHeld { .. }
                    | Step::DeckCreated { .. }
                    | Step::DeckSaved { .. }
                    | Step::DeckDeleted { .. }
            )
        {
            return Ok(None);
        }
        if let Step::Text { .. } = &step {
            self.provisional
                .extend(provisional_undo_targets(conn, std::slice::from_ref(&step))?);
        }
        Ok(Some((step, revision)))
    }

    /// Blocks apply made under ones the change inserted, such as a built-in choice's starting
    /// options, belong to the change: undo takes them away with their parent.
    pub(crate) fn derived(&mut self, ids: Vec<String>) {
        for id in ids {
            self.inserted_ids.insert(id.clone());
            self.inserted.push(id);
        }
    }

    pub(crate) fn record(
        mut self,
        tx: &Transaction,
        batch: &Batch,
        committed: &Committed,
    ) -> Result<()> {
        // Several saves of one deck still restore its state before the batch.
        // A create followed by a delete has nothing left to undo.
        let mut decks = HashSet::new();
        self.steps.retain_mut(|step| {
            let id = match step {
                Step::DeckCreated { id }
                | Step::DeckSaved { id, .. }
                | Step::DeckDeleted { id, .. } => id,
                _ => return true,
            };
            decks.insert(id.clone())
        });
        for step in &mut self.steps {
            let id = match step {
                Step::DeckCreated { id }
                | Step::DeckSaved { id, .. }
                | Step::DeckDeleted { id, .. } => id,
                _ => continue,
            };
            let exists: bool = tx
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM decks WHERE id = ?1)")?
                .query_row([id.as_str()], |row| row.get(0))?;
            let original = std::mem::replace(step, Step::Advance { ids: Vec::new() });
            *step = match original {
                Step::DeckCreated { .. } if !exists => Step::Advance { ids: Vec::new() },
                Step::DeckSaved { id, name, query } if !exists => {
                    Step::DeckDeleted { id, name, query }
                }
                Step::DeckDeleted { id, name, query } if exists => {
                    Step::DeckSaved { id, name, query }
                }
                step => step,
            };
        }
        let mut operations = inverse(&self.steps, committed)?;
        for id in &committed.removed {
            if self.provisional.contains(id) {
                let row = stored(tx, id)?.ok_or_else(|| not_found(id))?;
                operations.push(Operation::Restore {
                    id: id.clone(),
                    revision: row.block.revision,
                    deletion_id: row
                        .deletion_id
                        .ok_or_else(|| validation("missing deletion"))?,
                });
            }
        }
        let revisions: HashMap<_, _> = committed
            .revisions
            .iter()
            .map(|revision| (revision.id.as_str(), revision))
            .collect();
        let mut removable = Vec::new();
        let mut created_pages = Vec::new();
        for id in &self.inserted {
            let row = stored(tx, id)?.ok_or_else(|| not_found(id))?;
            if row.deletion_id.is_some() {
                continue;
            }
            let revision = revisions
                .get(id.as_str())
                .ok_or_else(|| validation(format!("atom {id} has no resulting revision")))?;
            if row.block.kind != BlockKind::Block {
                created_pages.push((*revision).clone());
            } else if row
                .block
                .parent_id
                .as_ref()
                .is_none_or(|parent| !self.inserted_ids.contains(parent))
            {
                removable.push((*revision).clone());
            }
        }
        let undo = Undo {
            operations,
            removable,
            inserted: self.inserted,
            created_pages,
            created_fields: Vec::new(),
        };
        let page_id = committed
            .pages
            .as_ref()
            .filter(|pages| pages.len() == 1)
            .map(|pages| &pages[0]);
        let count = batch.operations.len();
        let verb = if batch
            .operations
            .iter()
            .all(|op| matches!(op, Operation::Delete { .. }))
        {
            "Deleted"
        } else if batch
            .operations
            .iter()
            .all(|op| matches!(op, Operation::Move { .. }))
        {
            "Moved"
        } else if batch.operations.iter().all(|op| {
            matches!(
                op,
                Operation::CreatePage { .. }
                    | Operation::CreateJournal { .. }
                    | Operation::Insert { .. }
            )
        }) {
            "Added"
        } else {
            "Edited"
        };
        let mut summary = if count == 1 {
            format!("{verb} an atom")
        } else {
            format!("{verb} {count} atoms")
        };
        if let Some(page_id) = page_id {
            let title: String = tx
                .prepare_cached("SELECT text FROM blocks WHERE id = ?1")?
                .query_row([page_id], |row| row.get(0))?;
            summary.push_str(" on ");
            summary.push_str(&title);
        }
        // A batch of no-ops has no inverse, rather than an undo that commits nothing.
        let inverse = (!undo.operations.is_empty()
            || !undo.removable.is_empty()
            || !undo.created_pages.is_empty())
        .then(|| serde_json::to_string(&undo).expect("undo serializes"));
        tx.execute(
            "INSERT INTO change_history(seq, summary, page_id, undo) VALUES (?1, ?2, ?3, ?4)",
            params![committed.seq, summary, page_id, inverse],
        )?;
        Ok(())
    }
}

/// Restrict subtree revision bookkeeping to operation targets. Deleting a
/// large subtree must not copy every descendant merely to capture an inverse.
pub(crate) fn inverse_targets(conn: &Connection, operations: &str) -> Result<HashSet<String>> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT CASE WHEN json_extract(value, '$.op') IN
            ('set_citation_triage', 'set_citation_color', 'set_citation_range')
         THEN (SELECT block_id FROM citations WHERE id = json_extract(value, '$.id'))
         ELSE json_extract(value, '$.id') END
         FROM json_each(?1)",
        )?
        .query_map([operations], |row| row.get::<_, Option<String>>(0))?
        .filter_map(|row| row.transpose())
        .collect::<rusqlite::Result<_>>()?)
}
