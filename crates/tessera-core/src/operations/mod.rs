use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::notebook::{derived_id, new_ulid, now_ms};
use crate::storage::{
    Stored, TypeCreation, derive_links, derive_memberships, normalize_tags, not_found,
    resolve_type, stored, validate_id, validate_tag_title, validate_text, validation,
};
use crate::{
    Batch, BlockCapabilities, BlockKind, ChangeStamp, Committed, Error, Operation, Result,
    ReviewSession, Revision, SettingRevision, TextRewrite, WorkSession, Workshop,
};

/// Grades, resets and holds read a card revision earlier edits in the batch may have moved.
fn checks_shown_card(operation: &Operation) -> bool {
    match operation {
        Operation::GradeCard { .. }
        | Operation::UndoGrade { .. }
        | Operation::ResetCard { .. }
        | Operation::SetCardHeld { .. } => true,
        // Other writes do not check a shown card revision.
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
        | Operation::Move { .. }
        | Operation::Delete { .. }
        | Operation::Restore { .. }
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
        | Operation::SaveDeck { .. }
        | Operation::DeleteDeck { .. }
        | Operation::SaveTaskView { .. }
        | Operation::DeleteTaskView { .. }
        | Operation::SaveLibraryView { .. }
        | Operation::DeleteLibraryView { .. } => false,
    }
}

/// Blocks whose question or relation indexes this operation can disturb.
struct AffectedIds<'a> {
    questions: Option<&'a str>,
    relations: Option<&'a str>,
}

fn affected_ids(operation: &Operation) -> AffectedIds<'_> {
    match operation {
        Operation::SetQuestion { id, .. }
        | Operation::SetAssessment { id, .. }
        | Operation::SetArchived { id, .. }
        | Operation::Move { id, .. }
        | Operation::Delete { id, .. }
        | Operation::Restore { id, .. } => AffectedIds {
            questions: Some(id),
            relations: Some(id),
        },
        Operation::Merge { source_id, .. } | Operation::MergePage { source_id, .. } => {
            AffectedIds {
                questions: Some(source_id),
                relations: Some(source_id),
            }
        }
        // Text, splits and relation edits disturb relations without a question tree.
        Operation::SetPosition { id, .. }
        | Operation::SetRelation { id, .. }
        | Operation::EditText { id, .. }
        | Operation::Split { id, .. } => AffectedIds {
            questions: None,
            relations: Some(id),
        },
        // The rest do not retarget a question or relation index.
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
        | Operation::SetHeading { .. }
        | Operation::CreateCardTemplate { .. }
        | Operation::UpdateCardTemplate { .. }
        | Operation::SetCardTemplateApplied { .. }
        | Operation::DeleteCardTemplate { .. }
        | Operation::TransferCardKey { .. }
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
        | Operation::SetSpread { .. }
        | Operation::Revisit { .. }
        | Operation::RestoreRevisit { .. }
        | Operation::SetQuote { .. }
        | Operation::SetImage { .. }
        | Operation::SetOcclusion { .. }
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
        | Operation::DeleteLibraryView { .. } => AffectedIds {
            questions: None,
            relations: None,
        },
    }
}

mod derive;
mod fields;
mod library;
mod notes;
mod outline;
mod review;
mod sync;
mod tasks;
mod tree;
pub(crate) mod views;

pub(crate) use derive::derive_capability;
use tree::{GAP, NewBlock};

impl Workshop {
    /// Commit a revision-checked batch atomically, including derived indexes,
    /// as a new change made on this device now.
    pub fn apply(&mut self, batch: &Batch) -> Result<Committed> {
        self.apply_with(batch, |_, _| Ok(()))
    }

    /// [`Workshop::apply`] under an identity chosen elsewhere, such as a change
    /// another device made. The stamp's time becomes every timestamp the
    /// change writes, and IDs the change creates derive from its ID, so every
    /// device reaches the same state. A change ID that was already committed
    /// with the same operations returns the original result.
    pub fn apply_stamped(&mut self, batch: &Batch, stamp: &ChangeStamp) -> Result<Committed> {
        self.commit(batch, Some(stamp), &Extras::default(), false, |_, _| Ok(()))
    }

    /// [`Workshop::apply`], running `record` in the same transaction just
    /// before commit. A replayed batch does not run it.
    pub(crate) fn apply_with(
        &mut self,
        batch: &Batch,
        record: impl FnOnce(&Transaction, &Committed) -> Result<()>,
    ) -> Result<Committed> {
        self.commit(batch, None, &Extras::default(), true, record)
    }

    /// [`Workshop::apply_with`] when `record` writes its own `change_history`
    /// row (such as [`Workshop::agent_edit`]), skipping redundant batch capture.
    pub(crate) fn apply_without_capture(
        &mut self,
        batch: &Batch,
        record: impl FnOnce(&Transaction, &Committed) -> Result<()>,
    ) -> Result<Committed> {
        self.commit(batch, None, &Extras::default(), false, record)
    }

    pub(crate) fn commit(
        &mut self,
        batch: &Batch,
        stamp: Option<&ChangeStamp>,
        extras: &Extras,
        capture_history: bool,
        record: impl FnOnce(&Transaction, &Committed) -> Result<()>,
    ) -> Result<Committed> {
        let operations = serde_json::to_string(&batch.operations).expect("operations serialize");
        let hash = operations_hash(&operations);
        let local = stamp.is_none();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stamp) = stamp {
            validate_id(&stamp.id)?;
            validate_id(&stamp.origin)?;
            if let Some(committed) = replay(&tx, "change_id", &stamp.id, &hash)? {
                return Ok(committed);
            }
        }
        if let Some(key) = &batch.idempotency_key
            && let Some(committed) = replay(&tx, "idempotency_key", key, &hash)?
        {
            return Ok(committed);
        }
        if batch.operations.is_empty() {
            return Err(validation("batch must contain an operation"));
        }
        let stamp = match stamp {
            Some(stamp) => stamp.clone(),
            None => ChangeStamp {
                id: new_ulid().to_string(),
                origin: tx.query_row(
                    "SELECT device_id FROM replica WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )?,
                at: now_ms(),
            },
        };
        let now = stamp.at;
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let recording = crate::sync::begin(&tx, batch, extras)?;
        let watch = crate::topics::watch(&tx, batch)?;
        tx.execute(
            "INSERT INTO changes(actor, reason, created_at, idempotency_key, operations_hash, operations, committed, change_id, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?8)",
            params![serde_json::to_string(&batch.actor).expect("actor serializes"), batch.reason, now,
                batch.idempotency_key, hash, operations, stamp.id, stamp.origin],
        )?;
        let seq = tx.last_insert_rowid();
        extras.write(&tx, &stamp, seq)?;
        let validate_page_counts = batch
            .operations
            .iter()
            .any(crate::fields::validates_source_page_counts);
        let previous_invalid_counts = if validate_page_counts {
            crate::fields::invalid_source_page_counts(&tx, &operations)?
        } else {
            HashSet::new()
        };
        let mut field_changes = crate::fields::FieldChanges::default();
        let mut history = (local && capture_history)
            .then(|| crate::history::Capture::for_batch(batch))
            .flatten();
        let inverse_targets = if history.is_some()
            && batch.operations.len() > 1
            && batch
                .operations
                .iter()
                .any(crate::history::needs_inverse_targets)
        {
            crate::history::inverse_targets(&tx, &operations)?
        } else {
            HashSet::new()
        };
        let mut engine = Engine {
            tx: &tx,
            object_dir: &self.dir,
            local,
            now,
            seq,
            change_id: &stamp.id,
            revisions: Vec::new(),
            settings: Vec::new(),
            capability_sources: HashSet::new(),
            activated_sources: BTreeSet::new(),
            new_definitions: BTreeMap::new(),
            card_sources: HashSet::new(),
            template_types: HashSet::new(),
            cards: BTreeMap::new(),
            work_sessions: BTreeMap::new(),
            review_sessions: BTreeMap::new(),
            views: BTreeMap::new(),
            decks: BTreeMap::new(),
            task_views: BTreeMap::new(),
            library_views: BTreeMap::new(),
            positions: HashMap::new(),
            deletions: Vec::new(),
            removed: HashSet::new(),
            pruned_pages: Vec::new(),
            restructured_pages: HashSet::new(),
            reanchored_pages: BTreeSet::new(),
            changed_pages: HashSet::new(),
            pending_types: BTreeMap::new(),
            capability_memberships: BTreeMap::new(),
            text_rewrites: Vec::new(),
            rewrite_positions: HashMap::new(),
            op_index: 0,
            inverse_targets,
            inverse_root: None,
            inverse_bumps: Vec::new(),
        };
        for (index, operation) in batch.operations.iter().enumerate() {
            engine.op_index = index;
            field_changes.before(&tx, operation)?;
            if checks_shown_card(operation) {
                engine.derive_tags()?;
                for revision in &engine.revisions {
                    if engine.positions[&revision.id].fields {
                        field_changes.capture(&tx, &revision.id)?;
                    }
                }
                let owners = field_changes.derive(&tx)?;
                engine.derive_templates(owners)?;
            }
            if history.is_some() && matches!(operation, Operation::SetCardHeld { .. }) {
                engine.derive_cards()?;
            }
            let before = history
                .as_mut()
                .map(|history| history.before(&tx, operation))
                .transpose()?
                .flatten();
            engine.inverse_root = match operation {
                Operation::Move { id, .. }
                | Operation::Delete { id, .. }
                | Operation::Restore { id, .. }
                    if before.is_some() =>
                {
                    Some(id.as_str())
                }
                _ => None,
            };
            engine
                .operation(operation, index)
                .map_err(|error| indexed(error, index))?;
            engine.inverse_root = None;
            if let Some((mut step, revision)) = before {
                let after = match &step {
                    crate::history::Step::CardHeld { .. } => {
                        engine.cards.get(step.id()).map(|row| row.revision)
                    }
                    crate::history::Step::DeckCreated { .. }
                    | crate::history::Step::DeckSaved { .. }
                    | crate::history::Step::DeckDeleted { .. } => {
                        engine.decks.get(step.id()).map(|row| row.revision)
                    }
                    _ => engine
                        .positions
                        .get(step.id())
                        .map(|position| engine.revisions[position.position].revision),
                };
                if after.is_some_and(|after| after > revision) {
                    if let crate::history::Step::Restore { deletion_id, .. } = &mut step {
                        *deletion_id = engine.deletions.last().cloned();
                    }
                    if !engine.inverse_bumps.is_empty() {
                        history.as_mut().expect("local capture").steps.push(
                            crate::history::Step::Advance {
                                ids: std::mem::take(&mut engine.inverse_bumps),
                            },
                        );
                    }
                    history.as_mut().expect("local capture").steps.push(step);
                }
            }
            engine.inverse_bumps.clear();
        }
        let seeded = engine.settle_built_in_definitions()?;
        if let Some(history) = history.as_mut() {
            history.derived(seeded);
        }
        engine.derive_tags()?;
        engine.cleanup_provisional_pages()?;
        engine.reconcile_tags()?;
        engine.derive_cards()?;
        for revision in &engine.revisions {
            if engine.positions[&revision.id].fields {
                field_changes.capture(&tx, &revision.id)?;
            }
        }
        crate::spreads::validate_pages(&tx, &engine.revisions)?;
        let owners = field_changes.derive(&tx)?;
        if validate_page_counts
            && let Some((_, _, id, _)) =
                crate::fields::invalid_source_page_counts(&tx, &operations)?
                    .difference(&previous_invalid_counts)
                    .next()
        {
            return Err(validation(format!(
                "Pages must be a positive whole number (value {id})"
            )));
        }
        engine.derive_templates(owners)?;
        engine.assign_citation_keys()?;
        let mut views: Vec<&str> = Vec::new();
        for operation in &batch.operations {
            if let Operation::SaveView { id, .. } | Operation::DeleteView { id, .. } = operation
                && !views.contains(&id.as_str())
            {
                views.push(id);
            }
        }
        let capabilities = engine.capabilities()?;
        let mut restructured_pages: Vec<_> = engine.restructured_pages.into_iter().collect();
        restructured_pages.sort_unstable();
        let mut removed: Vec<_> = engine.removed.into_iter().collect();
        removed.sort_unstable();
        let mut pages: BTreeSet<String> = restructured_pages.iter().cloned().collect();
        {
            let mut page_of = tx.prepare_cached("SELECT page_id FROM blocks WHERE id = ?1")?;
            for id in engine
                .revisions
                .iter()
                .map(|revision| &revision.id)
                .chain(&removed)
            {
                // Deleted blocks keep their row; pruned provisional pages do not.
                if let Some(page) = page_of.query_row([id], |row| row.get(0)).optional()? {
                    pages.insert(page);
                }
            }
        }
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let synced = recording.is_some();
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        let synced = false;
        let topics = Some(watch.finish(&tx, synced)?);
        let committed = Committed {
            seq,
            revisions: engine.revisions,
            removed,
            pruned_pages: engine.pruned_pages,
            settings: engine.settings,
            deletions: engine.deletions,
            pages: Some(pages.into_iter().collect()),
            reanchored_pages: engine.reanchored_pages.into_iter().collect(),
            text_rewrites: engine.text_rewrites,
            capabilities,
            cards: engine.cards.into_values().collect(),
            work_sessions: engine.work_sessions.into_values().collect(),
            review_sessions: engine.review_sessions.into_values().collect(),
            views: engine.views.into_values().collect(),
            decks: engine.decks.into_values().collect(),
            task_views: engine.task_views.into_values().collect(),
            library_views: engine.library_views.into_values().collect(),
            topics,
            replayed: false,
        };
        let mut insert = tx.prepare_cached(
            "INSERT INTO change_revisions(change_seq, position, block_id, revision) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (position, revision) in committed.revisions.iter().enumerate() {
            insert.execute(params![
                seq,
                position as i64,
                revision.id,
                revision.revision
            ])?;
        }
        drop(insert);
        tx.execute(
            "UPDATE changes SET committed = ?1, restructured_pages = ?3, views = ?4 WHERE seq = ?2",
            params![
                serde_json::to_string(&committed).expect("result serializes"),
                seq,
                serde_json::to_string(&restructured_pages).expect("page IDs serialize"),
                serde_json::to_string(&views).expect("view IDs serialize")
            ],
        )?;
        if let Some(history) = history {
            history.record(&tx, batch, &committed)?;
        }
        record(&tx, &committed)?;
        crate::reads::record_editor_event(&tx, seq, false)?;
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        if let Some(recording) = { recording } {
            crate::sync::finish(&tx, recording, seq, &stamp, batch, extras)?;
        }
        tx.commit()?;
        if local && self.built_in_fields_need_ensure(&committed)? {
            self.ensure_built_in_fields()?;
        }
        Ok(committed)
    }
}

/// The SHA-256 of a batch's serialized operations, in hex.
pub(crate) fn operations_hash(operations: &str) -> String {
    Sha256::digest(operations.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
            hex
        })
}

/// What a replicated apply records alongside the change it commits.
#[derive(Default)]
pub(crate) struct Extras<'a> {
    /// IDs the change created that resolve to existing records: (alias, target).
    pub aliases: Vec<(String, String)>,
    pub conflicts: Vec<ConflictRow>,
    /// The batch and base texts as the origin made them, when the committed
    /// batch is a rewrite of it. A replica keeps these in its outbox; the
    /// browser build does not sync.
    #[cfg_attr(all(target_arch = "wasm32", target_os = "unknown"), allow(dead_code))]
    pub origin_batch: Option<&'a Batch>,
    #[cfg_attr(all(target_arch = "wasm32", target_os = "unknown"), allow(dead_code))]
    pub bases: Option<&'a BTreeMap<String, String>>,
}

/// A row of `sync_conflicts`; the change supplies the rest.
pub(crate) struct ConflictRow {
    pub id: String,
    pub kind: &'static str,
    pub block_id: Option<String>,
    pub text: Option<String>,
    pub batch: Option<String>,
    pub error: Option<String>,
}

impl Extras<'_> {
    pub(crate) fn write(&self, tx: &Transaction, stamp: &ChangeStamp, seq: i64) -> Result<()> {
        for (alias, target) in &self.aliases {
            tx.execute(
                "INSERT INTO id_aliases(alias, target, change_seq) VALUES (?1, ?2, ?3)",
                params![alias, target, seq],
            )?;
        }
        for row in &self.conflicts {
            tx.execute(
                "INSERT INTO sync_conflicts(id, kind, change_id, origin, block_id, text, batch, error, created_at, change_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET text = excluded.text, change_id = excluded.change_id,
                     created_at = excluded.created_at, change_seq = excluded.change_seq",
                params![row.id, row.kind, stamp.id, stamp.origin, row.block_id, row.text, row.batch,
                    row.error, stamp.at, seq],
            )?;
        }
        Ok(())
    }
}

/// The stored result of the change whose `column` is `value`, when one
/// exists. The same identity with different operations is refused.
fn replay(tx: &Transaction, column: &str, value: &str, hash: &str) -> Result<Option<Committed>> {
    let prior: Option<(String, String)> = tx
        .query_row(
            &format!("SELECT operations_hash, committed FROM changes WHERE {column} = ?1"),
            [value],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((prior_hash, result)) = prior else {
        return Ok(None);
    };
    if hash != prior_hash {
        let what = if column == "change_id" {
            "change ID"
        } else {
            "idempotency key"
        };
        return Err(validation(format!(
            "{what} was already used for different operations"
        )));
    }
    let mut committed: Committed = serde_json::from_str(&result)
        .map_err(|error| validation(format!("invalid stored result: {error}")))?;
    committed.replayed = true;
    Ok(Some(committed))
}

fn indexed(error: Error, index: usize) -> Error {
    match error {
        Error::NotFound { what, id, .. } => Error::NotFound {
            what,
            id,
            op_index: Some(index),
        },
        Error::Validation { message, .. } => Error::Validation {
            message,
            op_index: Some(index),
        },
        Error::Sqlite(rusqlite::Error::SqliteFailure(code, message))
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            let message = match message {
                Some(text) if text.contains("blocks.title_key") => {
                    "page title already exists".into()
                }
                Some(text) => text,
                None => "operation violates a uniqueness or integrity rule".into(),
            };
            Error::Validation {
                message,
                op_index: Some(index),
            }
        }
        other => other,
    }
}

struct Engine<'a, 'conn> {
    tx: &'a Transaction<'conn>,
    object_dir: &'a std::path::Path,
    local: bool,
    now: i64,
    seq: i64,
    /// The change being applied; IDs it creates derive from this.
    change_id: &'a str,
    revisions: Vec<Revision>,
    settings: Vec<SettingRevision>,
    capability_sources: HashSet<String>,
    /// Sources this change made or reactivated, which get a citation key at its end if they have none.
    activated_sources: BTreeSet<String>,
    /// Blocks this change put on a page's top level with a built-in field's name, and whether it also
    /// chose their role. Those that are field definitions at its end take the core's definition.
    new_definitions: BTreeMap<String, bool>,
    card_sources: HashSet<String>,
    template_types: HashSet<String>,
    cards: BTreeMap<String, Revision>,
    work_sessions: BTreeMap<String, WorkSession>,
    review_sessions: BTreeMap<String, ReviewSession>,
    views: BTreeMap<String, Revision>,
    decks: BTreeMap<String, Revision>,
    task_views: BTreeMap<String, Revision>,
    library_views: BTreeMap<String, Revision>,
    positions: HashMap<String, Touched>,
    inverse_targets: HashSet<String>,
    inverse_root: Option<&'a str>,
    inverse_bumps: Vec<String>,
    deletions: Vec<String>,
    removed: HashSet<String>,
    pruned_pages: Vec<crate::PrunedPage>,
    restructured_pages: HashSet<String>,
    reanchored_pages: BTreeSet<String>,
    changed_pages: HashSet<String>,
    pending_types: BTreeMap<(String, String), String>,
    capability_memberships: BTreeMap<String, u8>,
    text_rewrites: Vec<TextRewrite>,
    rewrite_positions: HashMap<String, usize>,
    op_index: usize,
}

struct Touched {
    position: usize,
    tags: bool,
    fields: bool,
}

impl Engine<'_, '_> {
    fn operation(&mut self, operation: &Operation, index: usize) -> Result<()> {
        let AffectedIds {
            questions: affected,
            relations: relation_affected,
        } = affected_ids(operation);
        if let Some(id) = affected {
            crate::question_store::affected(self.tx, id, &mut self.capability_sources, false)?;
        }
        if let Some(id) = relation_affected {
            crate::relation_store::affected(self.tx, id, &mut self.capability_sources)?;
        }
        self.apply_operation(operation, index)?;
        if let Some(id) = affected {
            crate::question_store::affected(self.tx, id, &mut self.capability_sources, true)?;
        }
        if let Some(id) = relation_affected {
            crate::relation_store::affected(self.tx, id, &mut self.capability_sources)?;
        }
        if let Operation::Merge { destination_id, .. }
        | Operation::MergePage { destination_id, .. } = operation
        {
            crate::relation_store::affected(self.tx, destination_id, &mut self.capability_sources)?;
            crate::question_store::affected(
                self.tx,
                destination_id,
                &mut self.capability_sources,
                true,
            )?;
        }
        Ok(())
    }

    fn apply_operation(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SettleSyncCopy { .. } => self.apply_settle_sync_copy(operation, index),
            Operation::SettleSyncRejection { .. } => {
                self.apply_settle_sync_rejection(operation, index)
            }
            Operation::CreatePage { .. } => self.apply_create_page(operation, index),
            Operation::CreateJournal { .. } => self.apply_create_journal(operation, index),
            Operation::Insert { .. } => self.apply_insert(operation, index),
            Operation::EditText { .. } => self.apply_edit_text(operation, index),
            Operation::SetHeading { .. } => self.apply_set_heading(operation, index),
            Operation::SetArchived { .. } => self.apply_set_archived(operation, index),
            Operation::AddType { .. } => self.apply_add_type(operation, index),
            Operation::RemoveType { .. } => self.apply_remove_type(operation, index),
            Operation::Split { .. } => self.apply_split(operation, index),
            Operation::Move { .. } => self.apply_move(operation, index),
            Operation::Merge { .. } => self.apply_merge(operation, index),
            Operation::MergePage { .. } => self.apply_merge_page(operation, index),
            Operation::Delete { .. } => self.apply_delete(operation, index),
            Operation::Restore { .. } => self.apply_restore(operation, index),
            Operation::SetFieldKind { .. } => self.apply_set_field_kind(operation, index),
            Operation::SetFieldHide { .. } => self.apply_set_field_hide(operation, index),
            Operation::SetFieldRole { .. } => self.apply_set_field_role(operation, index),
            Operation::SetFieldCountsAs { .. } => self.apply_set_field_counts_as(operation, index),
            Operation::SetFieldTargets { .. } => self.apply_set_field_targets(operation, index),
            Operation::SetTypeFields { .. } => self.apply_set_type_fields(operation, index),
            Operation::SetTypePresentation { .. } => {
                self.apply_set_type_presentation(operation, index)
            }
            Operation::SetSubjectCriteria { .. } => {
                self.apply_set_subject_criteria(operation, index)
            }
            Operation::TransferCardKey { .. } => self.apply_transfer_card_key(operation, index),
            Operation::CreateCardTemplate { .. }
            | Operation::UpdateCardTemplate { .. }
            | Operation::SetCardTemplateApplied { .. }
            | Operation::DeleteCardTemplate { .. } => self.apply_card_template(operation, index),
            Operation::SaveView { .. } => self.apply_save_view(operation, index),
            Operation::DeleteView { .. } => self.apply_delete_view(operation, index),
            Operation::SetSetting { .. } => self.apply_set_setting(operation, index),
            Operation::SetSource { .. }
            | Operation::AttachSnapshot { .. }
            | Operation::Cite { .. }
            | Operation::Uncite { .. } => self.apply_library_source(operation, index),
            Operation::SetCitationTriage { .. }
            | Operation::SetCitationRange { .. }
            | Operation::SetCitationColor { .. } => self.apply_citation(operation, index),
            Operation::SetPosition { .. } => self.apply_set_position(operation, index),
            Operation::SetRelation { .. } => self.apply_set_relation(operation, index),
            Operation::SetSpread { .. } => self.apply_set_spread(operation, index),
            Operation::Revisit { .. } | Operation::RestoreRevisit { .. } => {
                self.apply_revisit(operation, index)
            }
            Operation::SetQuote { .. } => self.apply_set_quote(operation, index),
            Operation::SetImage { .. } => self.apply_set_image(operation, index),
            Operation::SetOcclusion { .. } => self.apply_set_occlusion(operation, index),
            Operation::SetQuestion { .. } | Operation::SetAssessment { .. } => {
                self.apply_set_question(operation, index)
            }
            Operation::SetTask { .. }
            | Operation::RestoreTaskState { .. }
            | Operation::CompleteTask { .. }
            | Operation::ReverseTaskCompletion { .. }
            | Operation::SetProject { .. } => self.apply_task(operation, index),
            Operation::StartWork { .. }
            | Operation::StopWork { .. }
            | Operation::EditWorkNote { .. }
            | Operation::SetWorkSessionState { .. } => self.apply_work(operation, index),
            Operation::StartReviewSession { .. }
            | Operation::FinishReviewSession { .. }
            | Operation::GradeCard { .. }
            | Operation::UndoGrade { .. }
            | Operation::ResetCard { .. }
            | Operation::SetCardHeld { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. } => self.apply_review(operation, index),
            Operation::SaveTaskView { .. } | Operation::DeleteTaskView { .. } => {
                self.apply_task_view(operation, index)
            }
            Operation::SaveLibraryView { .. } | Operation::DeleteLibraryView { .. } => {
                self.apply_library_view(operation, index)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_persisted_receipt_replays_and_streams_without_new_sidecars() {
        let directory = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(directory.path()).unwrap();
        let id = ulid::Ulid::from(1u128).to_string();
        let batch = Batch {
            actor: crate::Actor::Person,
            reason: None,
            idempotency_key: Some("legacy-receipt".into()),
            operations: vec![Operation::CreatePage {
                id: id.clone(),
                title: "Legacy".into(),
            }],
        };
        let committed = workshop.apply(&batch).unwrap();
        let mut legacy = serde_json::to_value(&committed).unwrap();
        for field in [
            "capabilities",
            "cards",
            "work_sessions",
            "review_sessions",
            "decks",
            "task_views",
            "library_views",
            "settings",
            "text_rewrites",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        workshop
            .conn
            .execute(
                "UPDATE changes SET committed = ?1 WHERE seq = ?2",
                params![serde_json::to_string(&legacy).unwrap(), committed.seq],
            )
            .unwrap();
        drop(workshop);

        let mut workshop = Workshop::open(directory.path()).unwrap();
        let replayed = workshop.apply(&batch).unwrap();
        assert!(replayed.replayed);
        assert_eq!(replayed.seq, committed.seq);
        assert_eq!(replayed.revisions, committed.revisions);
        assert!(replayed.capabilities.is_empty());
        assert!(replayed.cards.is_empty());
        assert!(replayed.work_sessions.is_empty());
        assert!(replayed.review_sessions.is_empty());
        assert!(replayed.decks.is_empty());
        assert!(replayed.task_views.is_empty());
        assert!(replayed.library_views.is_empty());
        let changes = workshop.changes_since(0, 10).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].seq, committed.seq);
        assert_eq!(changes[0].blocks, vec![workshop.block(&id).unwrap()]);
        assert!(changes[0].capabilities.is_empty());
        assert!(changes[0].cards.is_empty());
        assert!(changes[0].work_sessions.is_empty());
        assert!(changes[0].review_sessions.is_empty());
        assert!(changes[0].decks.is_empty());
        assert!(changes[0].task_views.is_empty());
        assert!(changes[0].library_views.is_empty());
    }
}
