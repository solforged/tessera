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

mod fields;
mod library;
mod notes;
mod outline;
mod review;
mod sync;
mod tasks;
mod views;

const GAP: i64 = 1024;

impl Workshop {
    /// Commit a revision-checked batch atomically, including derived indexes,
    /// as a new change made on this device now.
    pub fn apply(&mut self, batch: &Batch) -> Result<Committed> {
        self.apply_with(batch, |_, _| Ok(()))
    }

    /// [`Notebook::apply`] under an identity chosen elsewhere, such as a change
    /// another device made. The stamp's time becomes every timestamp the
    /// change writes, and IDs the change creates derive from its ID, so every
    /// device reaches the same state. A change ID that was already committed
    /// with the same operations returns the original result.
    pub fn apply_stamped(&mut self, batch: &Batch, stamp: &ChangeStamp) -> Result<Committed> {
        self.commit(batch, Some(stamp), &Extras::default(), |_, _| Ok(()))
    }

    /// [`Notebook::apply`], running `record` in the same transaction just
    /// before commit. A replayed batch does not run it.
    pub(crate) fn apply_with(
        &mut self,
        batch: &Batch,
        record: impl FnOnce(&Transaction, &Committed) -> Result<()>,
    ) -> Result<Committed> {
        self.commit(batch, None, &Extras::default(), record)
    }

    pub(crate) fn commit(
        &mut self,
        batch: &Batch,
        stamp: Option<&ChangeStamp>,
        extras: &Extras,
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
        let mut history = local
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
            decks: engine.decks.into_values().collect(),
            task_views: engine.task_views.into_values().collect(),
            library_views: engine.library_views.into_values().collect(),
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
        if local
            && committed
                .capabilities
                .iter()
                .any(|caps| caps.task.is_some())
            && self.task_fields_need_ensure()?
        {
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
            Error::Validation {
                message: message
                    .unwrap_or_else(|| "operation violates a uniqueness or integrity rule".into()),
                op_index: Some(index),
            }
        }
        other => other,
    }
}

/// Membership, not capability presence, decides whether a text edit added or removed behavior.
pub(crate) fn capability_memberships(conn: &rusqlite::Connection, id: &str) -> Result<u8> {
    let mut mask = 0;
    let mut statement = conn.prepare_cached(
        "SELECT DISTINCT p.title_key FROM memberships m JOIN blocks p ON p.id = m.type_id
         WHERE m.block_id = ?1 AND p.kind = 'page' AND p.deletion_id IS NULL",
    )?;
    for key in statement.query_map([id], |row| row.get::<_, String>(0))? {
        let key = key?;
        if let Some(index) = crate::notes::CAPABILITY_KINDS
            .iter()
            .position(|(name, ..)| *name == key)
        {
            mask |= 1 << index;
        }
    }
    Ok(mask)
}

/// Apply the same lifecycle rules for membership derivation and check repair.
pub(crate) fn derive_capability(
    conn: &rusqlite::Connection,
    id: &str,
    key: &str,
    present: bool,
    now: i64,
    seq: i64,
) -> Result<bool> {
    let (_, _, _, table, _) = crate::notes::CAPABILITY_KINDS
        .iter()
        .find(|(name, ..)| *name == key)
        .expect("built-in capability");
    let active: bool = conn
        .prepare_cached(&format!(
            "SELECT EXISTS(SELECT 1 FROM {table} WHERE block_id = ?1 AND active = 1)"
        ))?
        .query_row([id], |row| row.get(0))?;
    if present
        && active
        && (key != "task"
            || crate::task_store::task(conn, id)?.is_some_and(|task| task.status.is_some()))
    {
        return Ok(false);
    }
    // Membership reactivation restores retained state, rather than replacing it
    // with the defaults used for a capability's first activation.
    if present && !active {
        let restored = conn
            .prepare_cached(&format!(
                "UPDATE {table} SET active = 1 WHERE block_id = ?1 AND active = 0"
            ))?
            .execute([id])?
            != 0;
        if restored
            && (key != "task"
                || crate::task_store::task(conn, id)?.is_some_and(|task| task.status.is_some()))
        {
            return Ok(true);
        }
    }
    let id = id.to_owned();
    let operation = match key {
        "task" => Operation::SetTask {
            task: if present {
                let mut task = crate::task_store::task(conn, &id)?.unwrap_or_default();
                task.status = Some(crate::TaskStatus::Todo);
                Some(task)
            } else {
                None
            },
            id,
            base_revision: 0,
        },
        "project" => Operation::SetProject {
            id,
            base_revision: 0,
            project: present.then(crate::ProjectState::default),
        },
        "question" => Operation::SetQuestion {
            id,
            base_revision: 0,
            question: present.then(crate::QuestionState::default),
        },
        "source" => Operation::SetSource {
            id,
            base_revision: 0,
            source: present.then_some(crate::library::SourceState {
                format: crate::library::SourceFormat::Record,
                state: crate::library::ReadingState::Inbox,
                origin: None,
                match_key: None,
                citation_key: None,
            }),
        },
        _ => unreachable!("built-in capability"),
    };
    match &operation {
        Operation::SetQuestion { id, .. } => {
            if present && stored(conn, id)?.is_some_and(|row| row.block.kind == BlockKind::Journal)
            {
                return Err(validation("Make a non-journal atom a question."));
            }
            let before = crate::revisit_store::snapshot(conn, id)?;
            let today = crate::settings::today_in_connection(conn, now)?;
            let changed = crate::question_store::apply(conn, &operation, &today)?;
            if changed {
                crate::revisit_store::question_changed(conn, id, &before, now)?;
            }
            Ok(changed)
        }
        Operation::SetSource { .. } => crate::library_store::apply(conn, &operation, now, seq),
        _ => crate::task_store::apply(conn, &operation, now, seq),
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

/// What a request's `after` marks under the parent it names.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Anchor {
    /// No `after`: the block goes first.
    First,
    /// A live sibling.
    Sibling,
    /// A sibling deleted under this parent, whose ordinal still marks its slot.
    Slot,
    /// A block that now sits under another parent.
    Adrift,
}

struct Touched {
    position: usize,
    tags: bool,
    fields: bool,
}

struct NewBlock<'a> {
    id: &'a str,
    kind: BlockKind,
    parent: Option<&'a str>,
    page: &'a str,
    ordinal: i64,
    text: &'a str,
    heading: Option<u8>,
}

impl Engine<'_, '_> {
    fn touch(&mut self, id: &str, revision: i64) {
        self.card_sources.insert(id.to_owned());
        self.record_revision(id, revision);
        self.positions.get_mut(id).expect("touched block").fields = true;
    }

    fn record_revision(&mut self, id: &str, revision: i64) {
        if self.inverse_root.is_some_and(|root| root != id) && self.inverse_targets.contains(id) {
            self.inverse_bumps.push(id.to_owned());
        }
        if let Some(position) = self.rewrite_positions.get(id) {
            self.text_rewrites[*position].revision = revision;
        }
        if let Some(position) = self.positions.get(id) {
            self.revisions[position.position].revision = revision;
        } else {
            self.positions.insert(
                id.to_owned(),
                Touched {
                    position: self.revisions.len(),
                    tags: false,
                    fields: false,
                },
            );
            self.revisions.push(Revision {
                id: id.to_owned(),
                revision,
            });
        }
    }

    fn tags_changed(&mut self, id: &str) -> Result<()> {
        if !self.capability_memberships.contains_key(id) {
            self.capability_memberships
                .insert(id.to_owned(), capability_memberships(self.tx, id)?);
        }
        self.positions.get_mut(id).expect("touched block").tags = true;
        Ok(())
    }

    fn remove_capability_tag(&mut self, id: &str, key: &str) -> Result<bool> {
        let current = self.live(id)?;
        let type_id: Option<String> = self.tx.prepare_cached(
            "SELECT id FROM blocks WHERE kind = 'page' AND title_key = ?1 AND deletion_id IS NULL",
        )?.query_row([key], |row| row.get(0)).optional()?;
        let text = crate::storage::remove_tag(&current.block.text, key, type_id.as_deref());
        let manual: bool = self.tx.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM memberships WHERE block_id = ?1 AND type_id = ?2 AND manual = 1)",
        )?.query_row(params![id, type_id], |row| row.get(0))?;
        let pending = self
            .pending_types
            .remove(&(id.to_owned(), key.to_owned()))
            .is_some();
        if text.is_none() && !manual && !pending {
            return Ok(false);
        }
        self.record_revision(id, current.block.revision);
        self.tags_changed(id)?;
        // The explicit removal has already deactivated this record. A later edit
        // in the same batch that adds its tag again must count as a new gain.
        let index = crate::notes::CAPABILITY_KINDS
            .iter()
            .position(|(name, ..)| *name == key)
            .expect("built-in capability");
        *self
            .capability_memberships
            .get_mut(id)
            .expect("captured membership") &= !(1 << index);
        let manual = self.tx.execute(
            "DELETE FROM memberships WHERE block_id = ?1 AND type_id = ?2 AND manual = 1",
            params![id, type_id],
        )? + usize::from(pending);
        if let Some(text) = text {
            self.edit(&current, &text)?;
            self.record_text_rewrite(id, current.block.text, text, current.block.revision + 1);
        } else if manual != 0 {
            self.bump(&current, true)?;
        }
        if manual != 0 {
            self.restructured_pages.insert(current.block.page_id);
        }
        self.capability_sources.insert(id.to_owned());
        Ok(true)
    }

    fn derive_cards(&mut self) -> Result<()> {
        if self.card_sources.is_empty() {
            return Ok(());
        }
        let mut sources: Vec<_> = self.card_sources.drain().collect();
        sources.sort_unstable();
        for revision in crate::card_store::derive_sources(self.tx, &sources, self.now)? {
            self.cards.insert(revision.id.clone(), revision);
        }
        Ok(())
    }

    fn derive_templates(&mut self, mut owners: Vec<String>) -> Result<()> {
        owners.extend(self.revisions.iter().map(|revision| revision.id.clone()));
        owners.sort_unstable();
        owners.dedup();
        let mut types: Vec<_> = self.template_types.iter().cloned().collect();
        types.extend(owners.iter().cloned());
        for revision in
            crate::card_templates::derive(self.tx, Some(&owners), Some(&types), self.now)?
        {
            self.cards.insert(revision.id.clone(), revision);
        }
        Ok(())
    }

    fn capabilities(&mut self) -> Result<Vec<BlockCapabilities>> {
        if !self.cards.is_empty() {
            let ids: Vec<_> = self.cards.keys().collect();
            let mut sources = self.tx.prepare_cached(
                "SELECT DISTINCT source_block_id FROM card_units
                 WHERE id IN (SELECT value FROM json_each(?1))",
            )?;
            for source in sources.query_map(
                [serde_json::to_string(&ids).expect("card IDs serialize")],
                |row| row.get::<_, String>(0),
            )? {
                self.capability_sources.insert(source?);
            }
        }
        let changed: Vec<_> = self.revisions.iter().map(|revision| &revision.id).collect();
        let mut retained = self.tx.prepare_cached(
            "SELECT block_id FROM positions WHERE active = 1
             AND block_id IN (SELECT value FROM json_each(?1))
             UNION SELECT q.block_id FROM json_each(?1) ids
             JOIN quotes q ON q.block_id = ids.value",
        )?;
        for id in retained.query_map(
            [serde_json::to_string(&changed).expect("block IDs serialize")],
            |row| row.get::<_, String>(0),
        )? {
            self.capability_sources.insert(id?);
        }
        if self.capability_sources.is_empty() {
            return Ok(Vec::new());
        }
        let mut ids: Vec<_> = self.capability_sources.drain().collect();
        ids.sort_unstable();
        crate::task_store::capabilities_for(self.tx, &ids)
    }

    fn record_text_rewrite(&mut self, id: &str, before: String, after: String, revision: i64) {
        if let Some(position) = self.rewrite_positions.get(id) {
            self.text_rewrites[*position].after = after;
            self.text_rewrites[*position].revision = revision;
        } else {
            self.rewrite_positions
                .insert(id.to_owned(), self.text_rewrites.len());
            self.text_rewrites.push(TextRewrite {
                id: id.to_owned(),
                before,
                after,
                revision,
            });
        }
    }

    /// Resolve against the final live titles, so an explicitly-created page
    /// later in the batch wins over automatic creation.
    fn derive_tags(&mut self) -> Result<()> {
        for ((id, key), title) in std::mem::take(&mut self.pending_types) {
            if stored(self.tx, &id)?.is_none_or(|block| block.deletion_id.is_some()) {
                continue;
            }
            let mut created = Vec::new();
            let type_id = resolve_type(
                self.tx,
                &title,
                &key,
                Some(TypeCreation {
                    change_id: Some(self.change_id),
                    now: self.now,
                }),
                &mut created,
            )?
            .expect("creation requested");
            self.tx.execute(
                "INSERT OR IGNORE INTO memberships(block_id, type_id, manual, title) VALUES (?1, ?2, 1, ?3)",
                params![id, type_id, title],
            )?;
            for revision in created {
                self.changed_pages.insert(revision.id.clone());
                self.touch(&revision.id, revision.revision);
                self.tags_changed(&revision.id)?;
                self.restructured_pages.insert(revision.id);
            }
        }
        let mut position = 0;
        while position < self.revisions.len() {
            let id = self.revisions[position].id.clone();
            if self.positions[&id].tags {
                let text: Option<String> = self
                    .tx
                    .prepare_cached(
                        "SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL",
                    )?
                    .query_row([&id], |row| row.get(0))
                    .optional()?;
                if let Some(text) = text {
                    let create = Some(TypeCreation {
                        change_id: Some(self.change_id),
                        now: self.now,
                    });
                    let mut created = Vec::new();
                    let normalized = normalize_tags(self.tx, &text, create, true, &mut created)?;
                    let source = normalized.as_deref().unwrap_or(&text);
                    if let Some(after) = &normalized {
                        self.tx.execute(
                            "UPDATE blocks SET text = ?1, title_key = CASE WHEN kind = 'page' THEN ?2 ELSE NULL END WHERE id = ?3",
                            params![after, crate::storage::title_key(after), id],
                        )?;
                        derive_links(self.tx, &id, after)?;
                        self.record_text_rewrite(
                            &id,
                            text.clone(),
                            after.clone(),
                            self.revisions[position].revision,
                        );
                    }
                    derive_memberships(self.tx, &id, source, None)?;
                    self.positions.get_mut(&id).expect("touched block").tags = false;
                    for revision in created {
                        self.changed_pages.insert(revision.id.clone());
                        self.touch(&revision.id, revision.revision);
                        self.tags_changed(&revision.id)?;
                        self.restructured_pages.insert(revision.id);
                    }
                }
            }
            position += 1;
        }
        self.reconcile_tags()?;
        for (id, before) in std::mem::take(&mut self.capability_memberships) {
            let Some(current) = stored(self.tx, &id)?.filter(|row| row.deletion_id.is_none())
            else {
                continue;
            };
            let after = capability_memberships(self.tx, &id)?;
            for (index, (key, ..)) in crate::notes::CAPABILITY_KINDS.iter().enumerate() {
                let mask = 1 << index;
                if (before ^ after) & mask != 0
                    && derive_capability(self.tx, &id, key, after & mask != 0, self.now, self.seq)?
                {
                    let current = self.live(&current.block.id)?;
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                    if *key == "source" && after & mask != 0 {
                        self.activated_sources.insert(id.clone());
                    }
                }
            }
        }
        Ok(())
    }

    /// A source this change made without a citation key gets its suggested key, read from the title and
    /// fields the change leaves it with, as ingestion assigns one. It is never recomputed afterwards.
    fn assign_citation_keys(&mut self) -> Result<()> {
        for id in std::mem::take(&mut self.activated_sources) {
            let title: Option<String> = self
                .tx
                .prepare_cached(
                    "SELECT b.text FROM sources s JOIN blocks b ON b.id = s.block_id
                     WHERE s.block_id = ?1 AND s.active = 1 AND s.citation_key IS NULL
                     AND b.deletion_id IS NULL",
                )?
                .query_row([&id], |row| row.get(0))
                .optional()?;
            let Some(title) = title else {
                continue;
            };
            let key =
                crate::library_ingest::source_citation_key(self.tx, &id, &title, &HashSet::new())?;
            self.tx.execute(
                "UPDATE sources SET citation_key = ?2 WHERE block_id = ?1",
                params![id, key],
            )?;
        }
        Ok(())
    }

    /// A field definition this change made with a built-in name takes the core's definition, whichever
    /// client made it and whatever kind it asked for: the lowercase name, kind and starting role, Links to
    /// types where those type pages exist, and a choice's starting options when it has none. A role the
    /// change itself set stays, as opening keeps a chosen one. Agent shorthand and templates already write
    /// the same. Returns the option atoms made here, whose IDs derive from the definition and their text.
    fn settle_built_in_definitions(&mut self) -> Result<Vec<String>> {
        let mut seeded = Vec::new();
        for (id, role_chosen) in std::mem::take(&mut self.new_definitions) {
            let Some(current) = stored(self.tx, &id)?.filter(|row| row.deletion_id.is_none())
            else {
                continue;
            };
            let Some(field) = crate::built_in::field_named(&current.block.text) else {
                continue;
            };
            if !crate::fields::is_definition(self.tx, &id)? {
                continue;
            }
            if current.block.text != field.name {
                self.tx.execute(
                    "UPDATE blocks SET text = ?1 WHERE id = ?2",
                    params![field.name, id],
                )?;
                self.record_text_rewrite(
                    &id,
                    current.block.text.clone(),
                    field.name.to_owned(),
                    current.block.revision,
                );
            }
            self.tx.execute(
                "INSERT INTO fields(block_id, kind) VALUES (?1, ?2)
                 ON CONFLICT(block_id) DO UPDATE SET kind = excluded.kind",
                params![id, field.kind.as_str()],
            )?;
            if !role_chosen {
                self.tx.execute(
                    "UPDATE fields SET role = ?2 WHERE block_id = ?1",
                    params![id, field.role.as_str()],
                )?;
            }
            if field.kind == crate::FieldKind::Instance
                && crate::fields::targets(self.tx, &id)?.is_empty()
            {
                let targets = crate::built_in::targets(self.tx, field)?;
                crate::fields::file_targets(self.tx, &id, &targets)?;
            }
            let has_children: bool = self
                .tx
                .prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL)",
                )?
                .query_row([&id], |row| row.get(0))?;
            if field.kind != crate::FieldKind::Choice || has_children {
                continue;
            }
            let mut after: Option<String> = None;
            for &text in field.options {
                let option = derived_id(&["field-option", &id, text]);
                let ordinal = self.ordinal(&id, after.as_deref(), None)?;
                self.create(NewBlock {
                    id: &option,
                    kind: BlockKind::Block,
                    parent: Some(&id),
                    page: &current.block.page_id,
                    ordinal,
                    text,
                    heading: None,
                })?;
                seeded.push(option.clone());
                after = Some(option);
            }
        }
        Ok(seeded)
    }

    fn cleanup_provisional_pages(&mut self) -> Result<()> {
        self.reconcile_tags()?;
        // A generated title can itself contain a tag or link. Removing it can
        // leave another provisional page unused, so repeat until nothing goes.
        loop {
            // Unused first: most provisional pages stay in use, so a typing batch
            // costs a few indexed probes per page and returns early. CROSS JOIN
            // keeps provisional_pages the outer loop; otherwise the planner may
            // walk every live block and run the probes for each. Every probe
            // must use an index (migration 025), so each column gets its own
            // probe instead of an OR across columns, and `+b.id` drops the
            // column's affinity so the JSON expression index applies.
            let candidates = self.tx.prepare_cached(
                "SELECT b.id, b.title_key FROM provisional_pages p CROSS JOIN blocks b ON b.id = p.id
                 WHERE b.deletion_id IS NULL AND b.revision = 1
                 AND NOT EXISTS (SELECT 1 FROM memberships m JOIN blocks s ON s.id = m.block_id WHERE m.type_id = b.id AND s.deletion_id IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM links l JOIN blocks s ON s.id = l.source_id WHERE l.target_id = b.id AND s.deletion_id IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.parent_id = b.id AND c.deletion_id IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.block_id = b.id AND m.manual = 1)
                 AND NOT EXISTS (SELECT 1 FROM type_fields f WHERE f.type_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM type_fields f WHERE f.field_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM subject_criteria f WHERE f.subject_id = b.id OR f.field_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM fields f WHERE f.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM field_values f WHERE f.owner_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM field_values f WHERE f.field_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM field_values f WHERE f.entry_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM field_values f WHERE f.value_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM images i WHERE i.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM questions q WHERE json_extract(q.state, '$.accepted') = +b.id)
                 AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM citations c WHERE c.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM task_occurrences t WHERE t.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM work_sessions w WHERE w.block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM card_units c WHERE c.source_block_id = b.id)
                 AND NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.target_source = b.id)"
            )?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if candidates.is_empty() {
                return Ok(());
            }
            // Queries store IDs (including nested source/filter IDs) and free text.
            // Search text naming a title also claims that page. Settings currently
            // hold only time_zone and vim; pins are local client navigation state.
            // This is query prose, not a page title: #title still claims Title.
            let query_values = self.tx.prepare_cached(
                "SELECT DISTINCT j.atom FROM (
                     SELECT query FROM views UNION ALL SELECT query FROM decks
                     UNION ALL SELECT query FROM task_views UNION ALL SELECT query FROM library_views
                 ) saved, json_tree(saved.query) j WHERE j.type = 'text'"
            )?.query_map([], |row| row.get::<_, String>(0))?
                .map(|value| value.map(|value| crate::storage::fold_title(&value)))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut deleted = false;
            for (id, title) in candidates {
                if crate::notes::built_in_tag_name(&title).is_some() {
                    continue;
                }
                let claimed = query_values.iter().any(|value| {
                    value.eq_ignore_ascii_case(&id)
                        || value.match_indices(title.as_str()).any(|(start, matched)| {
                            let boundary = |c: char| !c.is_alphanumeric() && c != '_';
                            value[..start].chars().next_back().is_none_or(boundary)
                                && value[start + matched.len()..]
                                    .chars()
                                    .next()
                                    .is_none_or(boundary)
                        })
                });
                if !claimed {
                    self.delete(&id)?;
                    self.pruned_pages.push(crate::PrunedPage {
                        id: id.clone(),
                        deletion_id: self
                            .deletions
                            .last()
                            .expect("pruning records a deletion")
                            .clone(),
                        revision: self.revisions[self.positions[&id].position].revision,
                    });
                    self.tx
                        .execute("DELETE FROM provisional_pages WHERE id = ?1", [&id])?;
                    deleted = true;
                }
            }
            if !deleted {
                return Ok(());
            }
        }
    }

    fn reconcile_tags(&mut self) -> Result<()> {
        for target in std::mem::take(&mut self.changed_pages) {
            // Only creation, deletion and restoration can change resolution.
            // Renaming a page never visits its members. The ID is one search
            // token, so the index finds the few live sources naming it without
            // reading every block's text.
            let sources = self
                .tx
                .prepare_cached(
                    "SELECT b.id, b.text FROM blocks_fts f
                     JOIN search_blocks s ON s.rowid = f.rowid
                     JOIN blocks b ON b.id = s.block_id
                     WHERE blocks_fts MATCH ?1 AND b.deletion_id IS NULL AND instr(b.text, ?2) > 0",
                )?
                .query_map([format!("\"{target}\""), target.clone()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, text) in sources {
                if !self.capability_memberships.contains_key(&id) {
                    self.capability_memberships
                        .insert(id.clone(), capability_memberships(self.tx, &id)?);
                }
                derive_memberships(self.tx, &id, &text, None)?;
            }
        }
        Ok(())
    }

    fn live(&self, id: &str) -> Result<Stored> {
        validate_id(id)?;
        stored(self.tx, id)?
            .filter(|block| block.deletion_id.is_none())
            .ok_or_else(|| not_found(id))
    }

    fn checked(&self, id: &str, expected: i64, index: usize, deleted: bool) -> Result<Stored> {
        validate_id(id)?;
        let current = stored(self.tx, id)?;
        let found = current
            .as_ref()
            .filter(|block| deleted || block.deletion_id.is_none())
            .map(|block| block.block.revision);
        if found != Some(expected) {
            return Err(Error::Conflict {
                op_index: index,
                what: "atom",
                id: id.to_owned(),
                expected,
                found,
            });
        }
        Ok(current.expect("matching revision exists"))
    }

    fn unused(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let used: bool = self
            .tx
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1)")?
            .query_row([id], |row| row.get(0))?;
        if used {
            Err(validation(format!("atom ID is already used: {id}")))
        } else {
            Ok(())
        }
    }

    fn heading(heading: Option<u8>) -> Result<()> {
        if heading.is_some_and(|level| !(1..=3).contains(&level)) {
            Err(validation("heading must be between 1 and 3"))
        } else {
            Ok(())
        }
    }

    fn create(&mut self, block: NewBlock<'_>) -> Result<()> {
        let NewBlock {
            id,
            kind,
            parent,
            page,
            ordinal,
            text,
            heading,
        } = block;
        self.unused(id)?;
        Self::heading(heading)?;
        validate_text(kind, text)?;
        let (kind, title_key) = match kind {
            BlockKind::Block => ("block", None),
            BlockKind::Page => ("page", Some(crate::storage::title_key(text))),
            BlockKind::Journal => ("journal", None),
        };
        self.tx.prepare_cached(
            "INSERT INTO blocks(id, kind, parent_id, page_id, ordinal, text, title_key, heading, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
        )?.execute(params![id, kind, parent, page, ordinal, text, title_key, heading, self.now])?;
        if title_key.is_some() {
            self.changed_pages.insert(id.to_owned());
        }
        derive_links(self.tx, id, text)?;
        self.touch(id, 1);
        self.tags_changed(id)?;
        self.restructured_pages.insert(page.to_owned());
        Ok(())
    }

    fn edit(&mut self, current: &Stored, text: &str) -> Result<()> {
        validate_text(current.block.kind, text)?;
        if current.block.text == text {
            return Ok(());
        }
        let title_key =
            (current.block.kind == BlockKind::Page).then(|| crate::storage::title_key(text));
        let old_key = title_key
            .as_ref()
            .map(|_| crate::storage::title_key(&current.block.text));
        if let Some(name) = old_key.as_deref().and_then(crate::notes::built_in_tag_name)
            && old_key != title_key
        {
            return Err(validation(format!(
                "{name} is a built-in tag; its name cannot change."
            )));
        }
        // Field lookups find the register by this key.
        if old_key.as_deref() == Some("fields") && old_key != title_key {
            return Err(validation(
                "Fields is the register of field definitions; its name cannot change.",
            ));
        }
        if title_key.is_some() {
            let tagged: bool = self
                .tx
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM memberships WHERE type_id = ?1)")?
                .query_row([&current.block.id], |row| row.get(0))?;
            if tagged {
                validate_tag_title(text)?;
            }
        }
        self.tx.prepare_cached(
            "UPDATE blocks SET text = ?1, title_key = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4",
        )?.execute(params![text, title_key, self.now, current.block.id])?;
        derive_links(self.tx, &current.block.id, text)?;
        self.touch(&current.block.id, current.block.revision + 1);
        // A descriptor child's front names this text. Only text edits query the
        // children, so moving a row out of a large page stays free of per-row work.
        let mut descriptors = self.tx.prepare_cached(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND instr(text, ';;') > 0",
        )?;
        for id in descriptors.query_map([&current.block.id], |row| row.get::<_, String>(0))? {
            self.card_sources.insert(id?);
        }
        self.tags_changed(&current.block.id)?;
        if let Some(position) = self.rewrite_positions.get(&current.block.id) {
            text.clone_into(&mut self.text_rewrites[*position].after);
        }
        Ok(())
    }

    fn subtree(&self, id: &str) -> Result<Vec<(String, i64, Option<String>)>> {
        let mut statement = self.tx.prepare_cached(
            "WITH RECURSIVE subtree(id, depth) AS (
                 SELECT ?1, 0 UNION ALL
                 SELECT b.id, s.depth + 1 FROM blocks b JOIN subtree s ON b.parent_id = s.id
             ) SELECT b.id, b.revision, b.deletion_id FROM subtree s JOIN blocks b ON b.id = s.id
               ORDER BY s.depth, b.parent_id, b.ordinal, b.id",
        )?;
        Ok(statement
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// A deletion event for `block`. An operation deletes a block at most
    /// once, so the change, operation and block identify the event.
    fn event(&mut self, block: &str) -> Result<String> {
        let id = derived_id(&[
            "deletion",
            self.change_id,
            &self.op_index.to_string(),
            block,
        ]);
        self.tx.execute(
            "INSERT INTO deletion_events(id, change_seq, created_at) VALUES (?1, ?2, ?3)",
            params![id, self.seq, self.now],
        )?;
        self.deletions.push(id.clone());
        Ok(id)
    }

    fn delete(&mut self, id: &str) -> Result<()> {
        let current = self.live(id)?;
        crate::work_store::guard_hide_subtree(self.tx, id)?;
        // Definitions are children of the register, which cannot be deleted, so only the block itself can be one.
        if self.built_in_task_definition(id)? {
            return Err(validation("Built-in task fields cannot be deleted."));
        }
        if current.block.kind == BlockKind::Page {
            let key = crate::storage::title_key(&current.block.text);
            // Every field definition, built-in task fields included, lives below it.
            if key == "fields" {
                return Err(validation(
                    "Fields is the register of field definitions and cannot be deleted; delete single fields instead.",
                ));
            }
            if let Some(name) = crate::notes::built_in_tag_name(&key) {
                return Err(validation(format!(
                    "{name} is a built-in tag and cannot be deleted."
                )));
            }
            self.changed_pages.insert(current.block.id.clone());
        }
        self.restructured_pages.insert(current.block.page_id);
        let event = self.event(id)?;
        for (id, revision, deletion) in self.subtree(id)? {
            if deletion.is_none() {
                self.tx.prepare_cached(
                    "UPDATE blocks SET deletion_id = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                )?.execute(params![event, self.now, id])?;
                self.touch(&id, revision + 1);
                self.removed.insert(id);
            }
        }
        Ok(())
    }

    fn would_cycle(&self, id: &str, parent: &str) -> Result<bool> {
        Ok(self.tx.query_row(
            "WITH RECURSIVE ancestors(id, parent_id) AS (
                 SELECT id, parent_id FROM blocks WHERE id = ?1 UNION ALL
                 SELECT b.id, b.parent_id FROM blocks b JOIN ancestors a ON b.id = a.parent_id
             ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?2)",
            params![parent, id],
            |row| row.get(0),
        )?)
    }

    /// What a request's `after` still marks under `parent`. Another writer may
    /// have moved or deleted that sibling since the sender last saw the list.
    fn anchor(&self, parent: &str, after: Option<&str>, excluded: Option<&str>) -> Result<Anchor> {
        let Some(after) = after else {
            return Ok(Anchor::First);
        };
        if Some(after) == excluded {
            return Err(validation("an atom cannot be placed after itself"));
        }
        validate_id(after)?;
        let sibling = stored(self.tx, after)?.ok_or_else(|| not_found(after))?;
        Ok(if sibling.block.parent_id.as_deref() != Some(parent) {
            Anchor::Adrift
        } else if sibling.deletion_id.is_some() {
            Anchor::Slot
        } else {
            Anchor::Sibling
        })
    }

    /// The sibling a new child of `parent` goes after, re-anchored when the
    /// request's `after` is stale: a sibling deleted under this parent keeps
    /// its slot, and one that left for another parent sends the block to the
    /// end. The receipt names the page so the sender reloads its order.
    fn reanchor(
        &mut self,
        parent: &Stored,
        after: Option<&str>,
        excluded: Option<&str>,
    ) -> Result<Option<String>> {
        let anchor = self.anchor(&parent.block.id, after, excluded)?;
        if matches!(anchor, Anchor::Slot | Anchor::Adrift) {
            self.reanchored_pages.insert(parent.block.page_id.clone());
        }
        if anchor != Anchor::Adrift {
            return Ok(after.map(str::to_owned));
        }
        Ok(self
            .tx
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                 AND (?2 IS NULL OR id != ?2) ORDER BY ordinal DESC, id DESC LIMIT 1",
            )?
            .query_row(params![parent.block.id, excluded], |row| row.get(0))
            .optional()?)
    }

    /// `after` is a row under `parent`, live or deleted; a deleted row's
    /// ordinal still marks its slot among the live siblings.
    fn ordinal(&self, parent: &str, after: Option<&str>, excluded: Option<&str>) -> Result<i64> {
        if self.anchor(parent, after, excluded)? == Anchor::Adrift {
            return Err(validation("after must be a sibling under the new parent"));
        }
        let bounds = |engine: &Self| -> Result<(Option<i64>, Option<i64>)> {
            let left = after
                .map(|id| {
                    stored(engine.tx, id)?
                        .map(|row| row.ordinal)
                        .ok_or_else(|| not_found(id))
                })
                .transpose()?;
            let right = if let Some(left) = left {
                engine
                    .tx
                    .prepare_cached(
                        "SELECT ordinal FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                     AND ordinal > ?2 AND (?3 IS NULL OR id != ?3) ORDER BY ordinal, id LIMIT 1",
                    )?
                    .query_row(params![parent, left, excluded], |row| row.get(0))
                    .optional()?
            } else {
                engine
                    .tx
                    .prepare_cached(
                        "SELECT ordinal FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                     AND (?2 IS NULL OR id != ?2) ORDER BY ordinal, id LIMIT 1",
                    )?
                    .query_row(params![parent, excluded], |row| row.get(0))
                    .optional()?
            };
            Ok((left, right))
        };
        let choose = |left: Option<i64>, right: Option<i64>| -> Option<i64> {
            match (left, right) {
                (None, None) => Some(GAP),
                (Some(left), None) => left.checked_add(GAP),
                (None, Some(right)) => right.checked_sub(GAP),
                (Some(left), Some(right)) => {
                    let gap = i128::from(right) - i128::from(left);
                    (gap > 1).then(|| (i128::from(left) + gap / 2) as i64)
                }
            }
        };
        let (left, right) = bounds(self)?;
        if let Some(ordinal) = choose(left, right) {
            return Ok(ordinal);
        }
        let siblings = self
            .tx
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1
             AND (?2 IS NULL OR id != ?2) ORDER BY ordinal, id",
            )?
            .query_map(params![parent, excluded], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Rebalance tombstones too, preserving restore positions in the same
        // coordinate system without invalidating authored sibling revisions.
        let mut update = self
            .tx
            .prepare_cached("UPDATE blocks SET ordinal = ?1 WHERE id = ?2")?;
        for (position, id) in siblings.iter().enumerate() {
            let ordinal = i64::try_from(position + 1)
                .ok()
                .and_then(|value| value.checked_mul(GAP))
                .ok_or_else(|| validation("sibling list exceeds ordinal capacity"))?;
            update.execute(params![ordinal, id])?;
        }
        let (left, right) = bounds(self)?;
        choose(left, right).ok_or_else(|| validation("sibling list exceeds ordinal capacity"))
    }

    fn move_block(&mut self, current: &Stored, parent_id: &str, after: Option<&str>) -> Result<()> {
        if current.block.kind != BlockKind::Block {
            return Err(validation("a root cannot be moved"));
        }
        let parent = self.live(parent_id)?;
        if self.would_cycle(&current.block.id, parent_id)? {
            return Err(validation("move would create a cycle"));
        }
        let same_parent = current.block.parent_id.as_deref() == Some(parent_id);
        // Reordering after a sibling that has left this parent names no place
        // in it any more, so the block stays where it is.
        if same_parent && self.anchor(parent_id, after, Some(&current.block.id))? == Anchor::Adrift
        {
            self.reanchored_pages.insert(parent.block.page_id.clone());
            return Ok(());
        }
        let after = self.reanchor(&parent, after, Some(&current.block.id))?;
        let after = after.as_deref();
        let predecessor: Option<String> = self.tx.query_row(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL AND ordinal < ?2
             ORDER BY ordinal DESC, id DESC LIMIT 1",
            params![current.block.parent_id, current.ordinal], |row| row.get(0),
        ).optional()?;
        if same_parent && predecessor.as_deref() == after {
            return Ok(());
        }
        crate::work_store::guard_move(self.tx, &current.block.id, parent_id)?;
        // Under anything but the register a definition stops being one, which would lose the field.
        if self.built_in_task_definition(&current.block.id)?
            && crate::fields::page_id(self.tx)?.as_deref() != Some(parent_id)
        {
            return Err(validation(
                "Built-in task fields stay on the Fields page; reorder them there.",
            ));
        }
        let ordinal = self.ordinal(parent_id, after, Some(&current.block.id))?;
        self.restructured_pages
            .insert(current.block.page_id.clone());
        self.restructured_pages.insert(parent.block.page_id.clone());
        if let Some(old_parent) = &current.block.parent_id {
            self.card_sources.insert(old_parent.clone());
        }
        self.tx.prepare_cached(
            "UPDATE blocks SET parent_id = ?1, page_id = ?2, ordinal = ?3, revision = revision + 1,
             updated_at = ?4 WHERE id = ?5",
        )?.execute(params![parent_id, parent.block.page_id, ordinal, self.now, current.block.id])?;
        self.touch(&current.block.id, current.block.revision + 1);
        if current.block.page_id != parent.block.page_id {
            for (id, revision, _) in self.subtree(&current.block.id)?.into_iter().skip(1) {
                self.tx.prepare_cached(
                    "UPDATE blocks SET page_id = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                )?.execute(params![parent.block.page_id, self.now, id])?;
                self.touch(&id, revision + 1);
            }
        }
        Ok(())
    }

    fn built_in_task_definition(&self, id: &str) -> Result<bool> {
        if !crate::fields::is_definition(self.tx, id)? {
            return Ok(false);
        }
        let text: String =
            self.tx
                .query_row("SELECT text FROM blocks WHERE id = ?1", [id], |row| {
                    row.get(0)
                })?;
        Ok(crate::built_in::task_field(&text).is_some())
    }

    fn bump(&mut self, current: &Stored, derive_fields: bool) -> Result<()> {
        self.tx.execute(
            "UPDATE blocks SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
            params![self.now, current.block.id],
        )?;
        if derive_fields {
            self.touch(&current.block.id, current.block.revision + 1);
        } else {
            self.record_revision(&current.block.id, current.block.revision + 1);
        }
        Ok(())
    }

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
