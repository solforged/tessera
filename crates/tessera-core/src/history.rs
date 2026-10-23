//! Attributed local history and revision-checked inverses.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::storage::{not_found, stored, validation};
use crate::{
    Actor, Batch, Block, BlockKind, CardQuery, Committed, Error, Notebook, Operation, RelationKind,
    Result, Revision, TaskState,
};

/// One committed change, newest first in history listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub seq: i64,
    pub change_id: Option<String>,
    pub origin: Option<String>,
    pub actor: Actor,
    pub reason: Option<String>,
    pub created_at: i64,
    pub summary: String,
    /// The live page the change landed on, when it has a single page.
    pub page: Option<Block>,
    pub undoable: bool,
    pub undone_by: Option<i64>,
    /// The change this entry undid.
    pub undoes: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UndoReceipt {
    pub undone: i64,
    /// Pages the change created that were kept because they are now in use
    /// or were renamed.
    pub kept_pages: Vec<Block>,
    pub committed: Committed,
}

/// Stored with each reversible change.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Undo {
    /// Inverse operations for edits to existing rows, in undo order.
    pub(crate) operations: Vec<Operation>,
    /// The change's new top-level blocks, deleted on undo while live.
    pub(crate) removable: Vec<Revision>,
    /// Every block the change created.
    pub(crate) inserted: Vec<String>,
    /// Pages the change created, deleted on undo while unused.
    pub(crate) created_pages: Vec<Revision>,
    /// Field definitions the change created, deleted on undo while unused.
    #[serde(default)]
    pub(crate) created_fields: Vec<Revision>,
}

/// The prior state an inverse operation puts back.
pub(crate) enum Step {
    /// A subtree inverse also advances these independently edited targets.
    Advance {
        ids: Vec<String>,
    },
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
        deletion_id: Option<String>,
    },
    Delete {
        id: String,
    },
    Task {
        id: String,
        /// The state before and after the change.
        states: Box<(Option<TaskState>, Option<TaskState>)>,
    },
    Relation {
        id: String,
        relation: Option<RelationKind>,
    },
    Revisit {
        id: String,
        state: crate::RevisitSnapshot,
        event_id: Option<String>,
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
    Cite {
        id: String,
        citation_id: String,
        snapshot_id: String,
        start: crate::library::PassagePoint,
        end: crate::library::PassagePoint,
        color: Option<String>,
    },
    CitationTriage {
        id: String,
        citation_id: String,
        triage: Option<String>,
    },
    CitationColor {
        id: String,
        citation_id: String,
        color: Option<String>,
    },
    CitationRange {
        id: String,
        citation_id: String,
        start: crate::library::PassagePoint,
        end: crate::library::PassagePoint,
    },
}

impl Step {
    pub(crate) fn id(&self) -> &str {
        match self {
            Step::Advance { .. } => unreachable!("revision advances have no target"),
            Step::Text { id, .. }
            | Step::Heading { id, .. }
            | Step::Move { id, .. }
            | Step::Restore { id, .. }
            | Step::Delete { id }
            | Step::Task { id, .. }
            | Step::Relation { id, .. }
            | Step::Revisit { id, .. }
            | Step::Uncomplete { id, .. }
            | Step::CardHeld { id, .. }
            | Step::DeckCreated { id }
            | Step::DeckSaved { id, .. }
            | Step::DeckDeleted { id, .. }
            | Step::Uncite { id, .. }
            | Step::Cite { id, .. }
            | Step::CitationTriage { id, .. }
            | Step::CitationColor { id, .. }
            | Step::CitationRange { id, .. } => id,
        }
    }
}

impl Notebook {
    /// All committed changes, newest first, before an optional exclusive sequence.
    pub fn history(&self, limit: usize, before: Option<i64>) -> Result<Vec<HistoryEntry>> {
        let rows = self
            .conn
            .prepare_cached(
                "SELECT c.seq, c.change_id, c.origin, c.actor, c.reason, c.created_at,
                    COALESCE(h.summary,
                        CASE MAX(COALESCE(json_array_length(c.committed, '$.revisions'), 0),
                                 COALESCE(json_array_length(c.committed, '$.removed'), 0))
                        WHEN 1 THEN '1 atom changed'
                        ELSE MAX(COALESCE(json_array_length(c.committed, '$.revisions'), 0),
                                 COALESCE(json_array_length(c.committed, '$.removed'), 0))
                             || ' atoms changed' END),
                    COALESCE(h.page_id, CASE
                        WHEN json_array_length(c.committed, '$.pages') = 1
                        THEN json_extract(c.committed, '$.pages[0]') END),
                    h.undo IS NOT NULL AND h.undone_seq IS NULL, h.undone_seq, h.undoes_seq
                 FROM changes c LEFT JOIN change_history h ON h.seq = c.seq
                 WHERE (?1 IS NULL OR c.seq < ?1)
                 ORDER BY c.seq DESC LIMIT ?2",
            )?
            .query_map(params![before, limit.min(500) as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(
                |(
                    seq,
                    change_id,
                    origin,
                    actor,
                    reason,
                    created_at,
                    summary,
                    page_id,
                    undoable,
                    undone_by,
                    undoes,
                )| {
                    Ok(HistoryEntry {
                        seq,
                        change_id,
                        origin,
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
                        undoable,
                        undone_by,
                        undoes,
                    })
                },
            )
            .collect()
    }

    /// Reverse a local change as a batch by `actor`. Refuses when a block
    /// it touched changed since, or when a block it added now has children
    /// added by someone else. Pages it created stay when they are in use.
    pub fn undo_change(&mut self, seq: i64, actor: &Actor) -> Result<UndoReceipt> {
        let (undo, undone): (Option<String>, Option<i64>) = self
            .conn
            .query_row(
                "SELECT h.undo, h.undone_seq FROM changes c
                 LEFT JOIN change_history h ON h.seq = c.seq WHERE c.seq = ?1",
                [seq],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| not_found(&format!("change {seq}")))?;
        if let Some(by) = undone {
            return Err(validation(format!(
                "change {seq} was already undone by change {by}"
            )));
        }
        let undo = undo.ok_or_else(|| validation(format!("change {seq} is not undoable")))?;
        let mut undo: Undo = serde_json::from_str(&undo)
            .map_err(|error| validation(format!("invalid stored undo: {error}")))?;
        // Later changes that were themselves undone left their rows as
        // this change did, so undoing in reverse order works.
        let undone_later = self.undone_after(seq)?;
        for operation in &mut undo.operations {
            let card = matches!(operation, Operation::SetCardHeld { .. });
            let deck = matches!(
                operation,
                Operation::SaveDeck { .. } | Operation::DeleteDeck { .. }
            );
            let citation_owner = match operation {
                Operation::SetCitationTriage { id, .. }
                | Operation::SetCitationColor { id, .. }
                | Operation::SetCitationRange { id, .. } => Some(self.conn.query_row(
                    "SELECT block_id FROM citations WHERE id = ?1",
                    [id.as_str()],
                    |row| row.get::<_, String>(0),
                )?),
                _ => None,
            };
            let Some((id, revision)) = base_revision(operation) else {
                // Recreating a deleted deck checks that its ID is still absent.
                continue;
            };
            let id = citation_owner.unwrap_or(id);
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
        // Existing subtrees moved into a newly created parent leave it again
        // before this undo deletes that parent.
        let mut evacuated = Vec::new();
        for operation in &undo.operations {
            if let Operation::Move { id, .. } = operation {
                evacuated.push(id.clone());
                evacuated.extend(self.live_descendants(id)?);
            }
        }
        // Blocks this undo deletes or puts back no longer hold the change's links.
        let mut owned: HashSet<&str> = undo
            .inserted
            .iter()
            .map(String::as_str)
            .chain(evacuated.iter().map(String::as_str))
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
                    "atom {} has children added after change {seq}; move or delete them first",
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
                        "UPDATE change_history SET undone_seq = ?1 WHERE seq = ?2",
                        params![committed.seq, seq],
                    )?;
                    tx.execute(
                        "INSERT INTO change_history(seq, summary, undoes_seq)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(seq) DO UPDATE SET summary = excluded.summary, undoes_seq = excluded.undoes_seq",
                        params![committed.seq, format!("Undid change {seq}"), seq],
                    )?;
                    Ok(())
                },
            )
            .map_err(|error| match error {
                Error::Conflict { id, .. } => validation(format!(
                    "atom {id} changed after change {seq}; undo or revert that edit first"
                )),
                error => error,
            })?;
        Ok(UndoReceipt {
            undone: seq,
            kept_pages,
            committed,
        })
    }

    /// Later changes that were undone, and the changes that undid them.
    fn undone_after(&self, seq: i64) -> Result<HashSet<i64>> {
        let mut seqs = HashSet::new();
        let mut active = HashMap::new();
        let mut statement = self.conn.prepare_cached(
            "SELECT seq, undone_seq FROM change_history
             WHERE seq > ?1 AND undone_seq IS NOT NULL ORDER BY seq DESC",
        )?;
        let rows = statement.query_map([seq], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for row in rows {
            let (change, undo): (i64, i64) = row?;
            // Undoing an undo reactivates the earlier change. Only canceled
            // pairs may advance an older inverse past intervening revisions.
            let effective = !active.get(&undo).copied().unwrap_or(true);
            active.insert(change, effective);
            if !effective {
                seqs.extend([change, undo]);
            }
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

    pub(crate) fn live_block(&self, id: &str) -> Result<Option<Block>> {
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
}

/// Inverse operations in undo order. Each is based on the revision the
/// change left, advanced by the inverses before it on the same block.
pub(crate) fn inverse(steps: &[Step], committed: &Committed) -> Result<Vec<Operation>> {
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
        if let Step::Advance { ids } = step {
            for id in ids {
                if let Some(revision) = revisions.get_mut(id.as_str()) {
                    *revision += 1;
                }
            }
            continue;
        }
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
            Step::Advance { .. } => unreachable!("revision advances are handled above"),
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
            Step::Restore { deletion_id, .. } => Operation::Restore {
                id,
                deletion_id: deletion_id
                    .as_ref()
                    .or(deletion)
                    .ok_or_else(|| validation("delete recorded no deletion event"))?
                    .clone(),
                revision: base_revision,
            },
            Step::Delete { .. } => Operation::Delete { id, base_revision },
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
            Step::Relation { relation, .. } => Operation::SetRelation {
                id,
                base_revision,
                relation: *relation,
            },
            Step::Revisit {
                state, event_id, ..
            } => Operation::RestoreRevisit {
                id,
                base_revision,
                state: state.clone(),
                event_id: event_id.clone(),
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
            Step::Cite {
                citation_id,
                snapshot_id,
                start,
                end,
                color,
                ..
            } => Operation::Cite {
                id,
                base_revision,
                citation_id: citation_id.clone(),
                snapshot_id: snapshot_id.clone(),
                start: start.clone(),
                end: end.clone(),
                color: color.clone(),
            },
            Step::CitationTriage {
                citation_id,
                triage,
                ..
            } => Operation::SetCitationTriage {
                id: citation_id.clone(),
                base_revision,
                triage: triage.clone(),
            },
            Step::CitationColor {
                citation_id, color, ..
            } => Operation::SetCitationColor {
                id: citation_id.clone(),
                base_revision,
                color: color.clone(),
            },
            Step::CitationRange {
                citation_id,
                start,
                end,
                ..
            } => Operation::SetCitationRange {
                id: citation_id.clone(),
                base_revision,
                start: start.clone(),
                end: end.clone(),
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
        | Operation::SetRelation {
            id, base_revision, ..
        }
        | Operation::SetImage {
            id, base_revision, ..
        }
        | Operation::SetOcclusion {
            id, base_revision, ..
        }
        | Operation::RestoreRevisit {
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
        | Operation::Cite {
            id, base_revision, ..
        }
        | Operation::SetCitationTriage {
            id, base_revision, ..
        }
        | Operation::SetCitationColor {
            id, base_revision, ..
        }
        | Operation::SetCitationRange {
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
pub(crate) fn resulting(committed: &Committed, ids: &[String]) -> Result<Vec<Revision>> {
    ids.iter()
        .map(|id| {
            committed
                .revisions
                .iter()
                .find(|revision| &revision.id == id)
                .cloned()
                .ok_or_else(|| validation(format!("atom {id} has no resulting revision")))
        })
        .collect()
}

/// Cleanup can delete a tag page needed by the inverse's canonical text.
pub(crate) fn provisional_undo_targets(
    conn: &Connection,
    steps: &[Step],
) -> Result<HashSet<String>> {
    let extend_targets = |pending: &mut Vec<String>, text: &str| {
        pending.extend(
            crate::storage::tag_tokens(text)
                .filter_map(|token| token.id)
                .chain(crate::storage::reference_spans(text).map(|(_, id, _)| id))
                .map(str::to_owned),
        );
    };
    let mut pending = Vec::new();
    for step in steps {
        if let Step::Text { text, .. } = step {
            extend_targets(&mut pending, text);
        }
    }
    let mut seen = HashSet::new();
    let mut provisional = HashSet::new();
    let mut query = conn.prepare_cached(
        "SELECT b.text FROM provisional_pages p JOIN blocks b ON b.id = p.id WHERE p.id = ?1 AND b.deletion_id IS NULL",
    )?;
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(text) = query
            .query_row([&id], |row| row.get::<_, String>(0))
            .optional()?
        {
            extend_targets(&mut pending, &text);
            provisional.insert(id);
        }
    }
    Ok(provisional)
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
            .all(|operation| {
                matches!(
                    operation,
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
                        | Operation::RestoreRevisit { event_id: None, .. }
                        | Operation::SetCardHeld { .. }
                        | Operation::SaveDeck { .. }
                        | Operation::DeleteDeck { .. }
                        | Operation::Cite { .. }
                        | Operation::Uncite { .. }
                        | Operation::SetCitationTriage { .. }
                        | Operation::SetCitationColor { .. }
                        | Operation::SetCitationRange { .. }
                )
            })
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
                    _ => Step::Delete { id: id.clone() },
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
                        _ => Step::CitationRange {
                            id,
                            citation_id,
                            start,
                            end,
                        },
                    };
                    Ok((step, row.get(1)?))
                })?,
            _ => unreachable!("only fully reversible batches are captured"),
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
