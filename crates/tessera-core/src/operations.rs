use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::CountsAs;
use crate::notebook::{derived_id, new_ulid, now_ms};
use crate::storage::{
    Stored, TypeCreation, derive_links, derive_memberships, normalize_tags, not_found,
    resolve_type, rewrite_links, rewrite_tags, stored, tag_text, validate_id, validate_tag_title,
    validate_text, validation,
};
use crate::{
    Batch, BlockCapabilities, BlockKind, ChangeStamp, Committed, Error, Notebook, Operation,
    Result, ReviewSession, Revision, SettingRevision, TextRewrite, WorkSession,
};

const GAP: i64 = 1024;

impl Notebook {
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
        let validate_page_counts = batch.operations.iter().any(|operation| {
            matches!(
                operation,
                Operation::CreatePage { .. }
                    | Operation::CreateJournal { .. }
                    | Operation::Insert { .. }
                    | Operation::EditText { .. }
                    | Operation::Split { .. }
                    | Operation::Merge { .. }
                    | Operation::MergePage { .. }
                    | Operation::Move { .. }
                    | Operation::Delete { .. }
                    | Operation::Restore { .. }
                    | Operation::SetArchived { .. }
                    | Operation::SetSource { .. }
            )
        });
        let previous_invalid_counts = if validate_page_counts {
            crate::fields::invalid_source_page_counts(&tx, &operations)?
        } else {
            HashSet::new()
        };
        let mut field_changes = crate::fields::FieldChanges::default();
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
            changed_pages: HashSet::new(),
            pending_types: BTreeMap::new(),
            capability_memberships: BTreeMap::new(),
            text_rewrites: Vec::new(),
            rewrite_positions: HashMap::new(),
            op_index: 0,
        };
        for (index, operation) in batch.operations.iter().enumerate() {
            engine.op_index = index;
            field_changes.before(&tx, operation)?;
            if matches!(
                operation,
                Operation::GradeCard { .. }
                    | Operation::UndoGrade { .. }
                    | Operation::ResetCard { .. }
                    | Operation::SetCardHeld { .. }
            ) {
                engine.derive_tags()?;
                for revision in &engine.revisions {
                    if engine.positions[&revision.id].fields {
                        field_changes.capture(&tx, &revision.id)?;
                    }
                }
                let owners = field_changes.derive(&tx)?;
                engine.derive_templates(owners)?;
            }
            engine
                .operation(operation, index)
                .map_err(|error| indexed(error, index))?;
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
        Error::NotFound { id, .. } => Error::NotFound {
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
    card_sources: HashSet<String>,
    template_types: HashSet<String>,
    cards: BTreeMap<String, Revision>,
    work_sessions: BTreeMap<String, WorkSession>,
    review_sessions: BTreeMap<String, ReviewSession>,
    decks: BTreeMap<String, Revision>,
    task_views: BTreeMap<String, Revision>,
    library_views: BTreeMap<String, Revision>,
    positions: HashMap<String, Touched>,
    deletions: Vec<String>,
    removed: HashSet<String>,
    pruned_pages: Vec<crate::PrunedPage>,
    restructured_pages: HashSet<String>,
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
                }
            }
        }
        Ok(())
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
        if crate::fields::is_definition(self.tx, id)?
            && crate::built_in::task_field(&current.block.text).is_some()
        {
            return Err(validation("Built-in task fields cannot be deleted."));
        }
        if current.block.kind == BlockKind::Page {
            if let Some(name) =
                crate::notes::built_in_tag_name(&crate::storage::title_key(&current.block.text))
            {
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

    fn restore(&mut self, current: &Stored, event: &str) -> Result<()> {
        validate_id(event)?;
        if current.deletion_id.as_deref() != Some(event) {
            return Err(validation("restore deletion event does not match the atom"));
        }
        if let Some(parent) = &current.block.parent_id {
            self.live(parent)?;
        }
        self.restructured_pages
            .insert(current.block.page_id.clone());
        // Parent-first order also rejects restoring beneath an independently deleted ancestor.
        for (id, revision, deletion) in self.subtree(&current.block.id)? {
            if deletion.as_deref() == Some(event) {
                let row = stored(self.tx, &id)?.expect("subtree row exists");
                if let Some(parent) = &row.block.parent_id {
                    self.live(parent)?;
                }
                let ordinal = self.restore_ordinal(&row)?;
                self.tx.prepare_cached(
                    "UPDATE blocks SET deletion_id = NULL, ordinal = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                )?.execute(params![ordinal, self.now, id])?;
                if row.block.kind == BlockKind::Page {
                    self.changed_pages.insert(id.clone());
                }
                self.touch(&id, revision + 1);
                self.removed.remove(&id);
                self.tags_changed(&id)?;
            }
        }
        Ok(())
    }

    fn restore_ordinal(&self, row: &Stored) -> Result<i64> {
        let Some(parent) = &row.block.parent_id else {
            return Ok(row.ordinal);
        };
        let collision: bool = self
            .tx
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM blocks WHERE parent_id = ?1
             AND ordinal = ?2 AND deletion_id IS NULL)",
            )?
            .query_row(params![parent, row.ordinal], |row| row.get(0))?;
        if !collision {
            return Ok(row.ordinal);
        }
        // Intervening insertions may reuse a tombstone's gap. Keep their order,
        // then restore this block immediately after the colliding live sibling.
        let predecessor: String = self
            .tx
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
             AND ordinal <= ?2 ORDER BY ordinal DESC, id DESC LIMIT 1",
            )?
            .query_row(params![parent, row.ordinal], |row| row.get(0))?;
        self.ordinal(parent, Some(&predecessor), Some(&row.block.id))
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

    fn ordinal(&self, parent: &str, after: Option<&str>, excluded: Option<&str>) -> Result<i64> {
        if let Some(after) = after {
            if Some(after) == excluded {
                return Err(validation("an atom cannot be placed after itself"));
            }
            let sibling = self.live(after)?;
            if sibling.block.parent_id.as_deref() != Some(parent) {
                return Err(validation("after must be a live sibling of the new parent"));
            }
        }
        let bounds = |engine: &Self| -> Result<(Option<i64>, Option<i64>)> {
            let left = after
                .map(|id| engine.live(id).map(|row| row.ordinal))
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
        let predecessor: Option<String> = self.tx.query_row(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL AND ordinal < ?2
             ORDER BY ordinal DESC, id DESC LIMIT 1",
            params![current.block.parent_id, current.ordinal], |row| row.get(0),
        ).optional()?;
        if current.block.parent_id.as_deref() == Some(parent_id) && predecessor.as_deref() == after
        {
            return Ok(());
        }
        crate::work_store::guard_move(self.tx, &current.block.id, parent_id)?;
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

    fn merge(&mut self, source: &Stored, destination: &Stored) -> Result<()> {
        if source.block.kind != BlockKind::Block {
            return Err(validation("a root cannot be merged away"));
        }
        if self.would_cycle(&source.block.id, &destination.block.id)? {
            return Err(validation(
                "merge destination must be outside the source subtree",
            ));
        }
        crate::image_store::guard_merge(self.tx, &destination.block.id)?;
        crate::task_store::guard_merge(self.tx, &source.block.id)?;
        crate::card_store::guard_merge(self.tx, &source.block.id)?;
        crate::work_store::guard_move(self.tx, &source.block.id, &destination.block.id)?;
        let mut text =
            String::with_capacity(destination.block.text.len() + source.block.text.len());
        text.push_str(&destination.block.text);
        text.push_str(&source.block.text);
        self.edit(destination, &text)?;
        let children = self.tx.prepare_cached(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL ORDER BY ordinal, id",
        )?.query_map([&source.block.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut after: Option<String> = self.tx.query_row(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL ORDER BY ordinal DESC, id DESC LIMIT 1",
            [&destination.block.id], |row| row.get(0),
        ).optional()?;
        for id in children {
            let child = self.live(&id)?;
            self.move_block(&child, &destination.block.id, after.as_deref())?;
            after = Some(id);
        }
        let moved_citations = self.tx.execute(
            "UPDATE citations SET block_id = ?1 WHERE block_id = ?2",
            params![destination.block.id, source.block.id],
        )?;
        if moved_citations > 0 {
            if source.block.text.is_empty() {
                self.bump(destination, false)?;
            }
            self.capability_sources.insert(destination.block.id.clone());
            self.capability_sources.insert(source.block.id.clone());
        }
        self.delete(&source.block.id)
    }

    fn redirect_links(&mut self, from: &str, into: &str) -> Result<()> {
        let incoming = self
            .tx
            .prepare_cached(
                "SELECT DISTINCT b.id FROM links l JOIN blocks b ON b.id = l.source_id
                 WHERE l.target_id = ?1 AND b.deletion_id IS NULL ORDER BY b.id",
            )?
            .query_map([from], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in incoming {
            let current = self.live(&id)?;
            if let Some(text) = rewrite_links(&current.block.text, from, into) {
                self.edit(&current, &text)?;
                self.record_text_rewrite(&id, current.block.text, text, current.block.revision + 1);
            }
        }
        for id in crate::quote_store::redirect(self.tx, from, into)? {
            let current = self.live(&id)?;
            self.bump(&current, false)?;
            self.capability_sources.insert(id);
        }
        Ok(())
    }

    fn page_merge_endpoint(&self, page: &Stored) -> Result<()> {
        if page.block.kind != BlockKind::Page {
            return Err(validation("only titled atoms can be merged"));
        }
        if crate::storage::tag_title_matches(&page.block.text, "fields") {
            return Err(validation("the Fields register cannot be merged"));
        }
        let source: bool = self
            .tx
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM sources WHERE block_id = ?1)")?
            .query_row([&page.block.id], |row| row.get(0))?;
        if source {
            return Err(validation("sources cannot be merged"));
        }
        Ok(())
    }

    fn plain_field_entry<'a>(&self, entry: &'a Stored) -> Result<Option<&'a str>> {
        if entry.block.archived || entry.block.heading.is_some() {
            return Ok(None);
        }
        let Some(field) = crate::fields::reference(&entry.block.text) else {
            return Ok(None);
        };
        if !crate::fields::is_definition(self.tx, field)? {
            return Ok(None);
        }
        for guard in [
            crate::task_store::guard_merge(self.tx, &entry.block.id),
            crate::card_store::guard_merge(self.tx, &entry.block.id),
        ] {
            match guard {
                Ok(()) => {}
                Err(Error::Validation { .. }) => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        let metadata: bool = self
            .tx
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM citations WHERE block_id = ?1)
             OR EXISTS(SELECT 1 FROM memberships WHERE block_id = ?1)",
            )?
            .query_row([&entry.block.id], |row| row.get(0))?;
        Ok((!metadata).then_some(field))
    }

    fn live_children(&self, parent: &str) -> Result<Vec<String>> {
        Ok(self.tx.prepare_cached(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL ORDER BY ordinal, id",
        )?.query_map([parent], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    fn last_child(&self, parent: &str) -> Result<Option<String>> {
        Ok(self
            .tx
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
             ORDER BY ordinal DESC, id DESC LIMIT 1",
            )?
            .query_row([parent], |row| row.get(0))
            .optional()?)
    }

    fn append_children(&mut self, from: &str, into: &str) -> Result<()> {
        let children = self.live_children(from)?;
        let mut after = self.last_child(into)?;
        for id in children {
            let child = self.live(&id)?;
            self.move_block(&child, into, after.as_deref())?;
            after = Some(id);
        }
        Ok(())
    }

    fn merge_page(&mut self, source: &Stored, destination: &Stored) -> Result<()> {
        if source.block.id == destination.block.id {
            return Err(validation("an atom cannot be merged into itself"));
        }
        if source.block.kind == BlockKind::Page
            && let Some(name) =
                crate::notes::built_in_tag_name(&crate::storage::title_key(&source.block.text))
        {
            return Err(validation(format!(
                "{name} is a built-in tag and cannot be merged."
            )));
        }
        self.page_merge_endpoint(source)?;
        self.page_merge_endpoint(destination)?;
        crate::task_store::guard_merge(self.tx, &source.block.id)?;
        crate::card_store::guard_merge(self.tx, &source.block.id)?;
        let metadata: bool = self
            .tx
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM citations WHERE block_id = ?1)
             OR EXISTS(SELECT 1 FROM type_fields WHERE type_id = ?1)
             OR EXISTS(SELECT 1 FROM subject_criteria WHERE subject_id = ?1)",
            )?
            .query_row([&source.block.id], |row| row.get(0))?;
        if metadata {
            return Err(validation(
                "an atom with citations or a field schema cannot be merged away",
            ));
        }
        self.redirect_tags(source, destination)?;
        self.redirect_links(&source.block.id, &destination.block.id)?;
        let mut fields = HashMap::new();
        let children = self.live_children(&destination.block.id)?;
        let mut after = children.last().cloned();
        for id in children {
            let entry = self.live(&id)?;
            if let Some(field) = self.plain_field_entry(&entry)? {
                fields.entry(field.to_owned()).or_insert(id);
            }
        }
        for id in self.live_children(&source.block.id)? {
            let child = self.live(&id)?;
            let field = self.plain_field_entry(&child)?.map(str::to_owned);
            if let Some(target) = field.as_ref().and_then(|field| fields.get(field)) {
                self.append_children(&id, target)?;
                self.redirect_links(&id, target)?;
                self.delete(&id)?;
            } else {
                self.move_block(&child, &destination.block.id, after.as_deref())?;
                if let Some(field) = field {
                    fields.insert(field, id.clone());
                }
                after = Some(id);
            }
        }
        // A merged identity retains every classification, including tags authored
        // in the old title. They become manual memberships on the surviving page.
        self.tx.execute(
            "INSERT OR IGNORE INTO memberships(block_id, type_id, manual, title)
             SELECT ?1, type_id, 1, title FROM memberships WHERE block_id = ?2",
            params![destination.block.id, source.block.id],
        )?;
        let mut next_id = 0;
        let aliases = crate::aliases::plan_alias(
            self.tx,
            &self.live(&destination.block.id)?.block,
            &source.block.text,
            || {
                next_id += 1;
                derived_id(&[
                    "merge-alias",
                    self.change_id,
                    &source.block.id,
                    &next_id.to_string(),
                ])
            },
        )?;
        for operation in aliases {
            self.apply_operation(&operation, self.op_index)?;
        }
        let current = self.live(&destination.block.id)?;
        self.bump(&current, true)?;
        self.delete(&source.block.id)
    }

    fn redirect_tags(&mut self, source: &Stored, destination: &Stored) -> Result<()> {
        let incoming = self.tx.prepare_cached(
            "SELECT DISTINCT b.id FROM blocks b LEFT JOIN memberships m ON m.block_id = b.id
             WHERE b.deletion_id IS NULL AND (m.type_id = ?1 OR instr(b.text, ?1) > 0) ORDER BY b.id",
        )?.query_map([&source.block.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let spelling = tag_text(&destination.block.id, &destination.block.text);
        for id in incoming {
            let current = self.live(&id)?;
            self.record_revision(&id, current.block.revision);
            self.tags_changed(&id)?;
            self.tx.execute(
                "INSERT OR IGNORE INTO memberships(block_id, type_id, manual, title)
                 SELECT block_id, ?1, 1, title FROM memberships WHERE block_id = ?2 AND type_id = ?3 AND manual = 1",
                params![destination.block.id, id, source.block.id],
            )?;
            let manual = self.tx.execute(
                "DELETE FROM memberships WHERE block_id = ?1 AND type_id = ?2 AND manual = 1",
                params![id, source.block.id],
            )?;
            if let Some(text) = rewrite_tags(&current.block.text, |token| {
                (token.id == Some(source.block.id.as_str())).then_some(spelling.as_str())
            }) {
                self.edit(&current, &text)?;
                self.record_text_rewrite(&id, current.block.text, text, current.block.revision + 1);
            } else if manual > 0 {
                self.bump(&current, true)?;
            }
        }
        Ok(())
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

    fn view_revision(&self, id: &str) -> Result<Option<i64>> {
        Ok(self
            .tx
            .prepare_cached("SELECT revision FROM views WHERE id = ?1")?
            .query_row([id], |row| row.get(0))
            .optional()?)
    }

    fn operation(&mut self, operation: &Operation, index: usize) -> Result<()> {
        let affected = match operation {
            Operation::SetQuestion { id, .. }
            | Operation::SetAssessment { id, .. }
            | Operation::SetArchived { id, .. }
            | Operation::Move { id, .. }
            | Operation::Delete { id, .. }
            | Operation::Restore { id, .. } => Some(id),
            Operation::Merge { source_id, .. } | Operation::MergePage { source_id, .. } => {
                Some(source_id)
            }
            _ => None,
        };
        let relation_affected = match operation {
            Operation::SetPosition { id, .. }
            | Operation::SetRelation { id, .. }
            | Operation::EditText { id, .. }
            | Operation::Split { id, .. } => Some(id),
            _ => affected,
        };
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
            Operation::SettleSyncCopy { id, settled } => {
                validate_id(id)?;
                let previous = self.tx.query_row(
                    "SELECT settled_at IS NOT NULL FROM sync_conflicts WHERE id = ?1 AND kind = 'copy'",
                    [id],
                    |row| row.get::<_, bool>(0),
                ).optional()?.ok_or_else(|| validation("unknown sync copy"))?;
                if previous != *settled {
                    self.tx.execute(
                        "UPDATE sync_conflicts SET settled_at = ?2 WHERE id = ?1",
                        params![id, settled.then_some(self.now)],
                    )?;
                    let current =
                        stored(self.tx, id)?.ok_or_else(|| validation("unknown sync copy atom"))?;
                    self.tx.execute(
                        "UPDATE blocks SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                        params![id, self.now],
                    )?;
                    self.record_revision(id, current.block.revision + 1);
                }
                Ok(())
            }
            Operation::SettleSyncRejection { id, settled } => {
                validate_id(id)?;
                let previous = self.tx.query_row(
                    "SELECT settled_at IS NOT NULL FROM sync_conflicts WHERE id = ?1 AND kind = 'rejected'",
                    [id],
                    |row| row.get::<_, bool>(0),
                ).optional()?.ok_or_else(|| validation("unknown sync rejection"))?;
                if previous != *settled {
                    self.tx.execute(
                        "UPDATE sync_conflicts SET settled_at = ?2 WHERE id = ?1",
                        params![id, settled.then_some(self.now)],
                    )?;
                }
                Ok(())
            }
            Operation::CreatePage { id, title } => self.create(NewBlock {
                id,
                kind: BlockKind::Page,
                parent: None,
                page: id,
                ordinal: GAP,
                text: title,
                heading: None,
            }),
            Operation::CreateJournal { id, date } => self.create(NewBlock {
                id,
                kind: BlockKind::Journal,
                parent: None,
                page: id,
                ordinal: GAP,
                text: date,
                heading: None,
            }),
            Operation::Insert {
                id,
                parent_id,
                after,
                text,
                heading,
            } => {
                self.unused(id)?;
                let parent = self.live(parent_id)?;
                let ordinal = self.ordinal(parent_id, after.as_deref(), None)?;
                self.create(NewBlock {
                    id,
                    kind: BlockKind::Block,
                    parent: Some(parent_id),
                    page: &parent.block.page_id,
                    ordinal,
                    text,
                    heading: *heading,
                })
            }
            Operation::EditText {
                id,
                base_revision,
                text,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(problem) = crate::built_in::rename_problem(&current.block.text, text)
                    .filter(|_| crate::fields::is_definition(self.tx, id).unwrap_or(false))
                {
                    return Err(validation(problem));
                }
                self.edit(&current, text)
            }
            Operation::SetHeading {
                id,
                base_revision,
                heading,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                Self::heading(*heading)?;
                if current.block.heading != *heading {
                    self.tx.execute("UPDATE blocks SET heading = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                        params![heading, self.now, id])?;
                    self.touch(id, current.block.revision + 1);
                }
                Ok(())
            }
            Operation::SetArchived {
                id,
                base_revision,
                archived,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if current.block.archived != *archived {
                    if *archived {
                        crate::work_store::guard_hide_subtree(self.tx, id)?;
                    }
                    self.tx.execute("UPDATE blocks SET archived = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                        params![archived, self.now, id])?;
                    self.touch(id, current.block.revision + 1);
                }
                Ok(())
            }
            Operation::AddType {
                id,
                base_revision,
                title,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                validate_text(BlockKind::Page, title)?;
                validate_tag_title(title)?;
                self.record_revision(id, current.block.revision);
                self.tags_changed(id)?;
                let key = crate::storage::title_key(title);
                if let Some(type_id) = resolve_type(self.tx, title, &key, None, &mut Vec::new())? {
                    self.tx.execute(
                        "INSERT OR IGNORE INTO memberships(block_id, type_id, manual, title) VALUES (?1, ?2, 1, ?3)",
                        params![id, type_id, title],
                    )?;
                } else {
                    self.pending_types
                        .entry((id.clone(), key))
                        .or_insert_with(|| title.clone());
                }
                self.bump(&current, true)?;
                self.restructured_pages
                    .insert(current.block.page_id.clone());
                Ok(())
            }
            Operation::RemoveType {
                id,
                base_revision,
                title,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                validate_text(BlockKind::Page, title)?;
                validate_tag_title(title)?;
                self.record_revision(id, current.block.revision);
                self.tags_changed(id)?;
                let removed = self.tx.execute(
                    "DELETE FROM memberships WHERE block_id = ?1 AND manual = 1 AND type_id IN
                     (SELECT id FROM blocks WHERE kind = 'page' AND title_key = ?2 AND deletion_id IS NULL)",
                    params![id, crate::storage::title_key(title)],
                )? + usize::from(self.pending_types.remove(&(id.clone(), crate::storage::title_key(title))).is_some());
                if removed == 0 {
                    return Err(validation("tag has no manual membership"));
                }
                self.restructured_pages
                    .insert(current.block.page_id.clone());
                self.bump(&current, true)
            }
            Operation::Split {
                id,
                base_revision,
                new_id,
                left,
                right,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Block {
                    return Err(validation("a root cannot be split"));
                }
                if left.len().checked_add(right.len()) != Some(current.block.text.len())
                    || !current.block.text.starts_with(left)
                    || &current.block.text[left.len()..] != right
                {
                    return Err(validation("split left + right must equal the current text"));
                }
                crate::card_store::guard_split(self.tx, id, left, right)?;
                self.unused(new_id)?;
                let parent = current
                    .block
                    .parent_id
                    .as_deref()
                    .expect("block has parent");
                let ordinal = self.ordinal(parent, Some(id), None)?;
                self.edit(&current, left)?;
                self.create(NewBlock {
                    id: new_id,
                    kind: BlockKind::Block,
                    parent: Some(parent),
                    page: &current.block.page_id,
                    ordinal,
                    text: right,
                    heading: current.block.heading,
                })
            }
            Operation::Move {
                id,
                base_revision,
                parent_id,
                after,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                self.move_block(&current, parent_id, after.as_deref())
            }
            Operation::Merge {
                source_id,
                source_revision,
                destination_id,
                destination_revision,
            } => {
                let source = self.checked(source_id, *source_revision, index, false)?;
                let destination =
                    self.checked(destination_id, *destination_revision, index, false)?;
                self.merge(&source, &destination)
            }
            Operation::MergePage {
                source_id,
                source_revision,
                destination_id,
                destination_revision,
            } => {
                let source = self.checked(source_id, *source_revision, index, false)?;
                let destination =
                    self.checked(destination_id, *destination_revision, index, false)?;
                self.merge_page(&source, &destination)
            }
            Operation::Delete { id, base_revision } => {
                self.checked(id, *base_revision, index, false)?;
                self.delete(id)
            }
            Operation::Restore {
                id,
                deletion_id,
                revision,
            } => {
                let current = self.checked(id, *revision, index, true)?;
                self.restore(&current, deletion_id)
            }
            Operation::SetFieldKind {
                id,
                base_revision,
                kind,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(field) = crate::built_in::task_field(&current.block.text)
                    && field.kind != *kind
                {
                    return Err(validation("Built-in task field formats cannot change."));
                }
                self.tx.execute("INSERT INTO fields(block_id, kind) VALUES (?1, ?2) ON CONFLICT(block_id) DO UPDATE SET kind = excluded.kind",
                    params![id, kind.as_str()])?;
                // A built-in field that becomes a relation links to its built-in types at once, as opening would.
                if *kind == crate::FieldKind::Instance
                    && let Some(field) = crate::built_in::field_named(&current.block.text)
                    && crate::fields::targets(self.tx, id)?.is_empty()
                {
                    let targets = crate::built_in::targets(self.tx, field)?;
                    crate::fields::file_targets(self.tx, id, &targets)?;
                }
                self.bump(&current, true)
            }
            Operation::SetFieldHide {
                id,
                base_revision,
                hide,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                self.tx.execute("INSERT INTO fields(block_id, kind, hide) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET hide = excluded.hide",
                    params![id, hide.as_str()])?;
                self.bump(&current, true)
            }
            Operation::SetFieldRole {
                id,
                base_revision,
                role,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                self.tx.execute("INSERT INTO fields(block_id, kind, role) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET role = excluded.role",
                    params![id, role.as_str()])?;
                self.bump(&current, true)
            }
            Operation::SetFieldCountsAs {
                id,
                base_revision,
                counts_as,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(field) = crate::built_in::field_named(&current.block.text) {
                    return Err(validation(match field.counts_as {
                        Some(counts) => format!(
                            "{} is built in and counts as {}.",
                            field.name,
                            counts.as_str()
                        ),
                        None => format!("{} is built in and counts as nothing.", field.name),
                    }));
                }
                let kind: Option<String> = self
                    .tx
                    .query_row("SELECT kind FROM fields WHERE block_id = ?1", [id], |row| {
                        row.get(0)
                    })
                    .optional()?;
                if counts_as.is_some()
                    && !matches!(kind.as_deref().unwrap_or("text"), "text" | "instance")
                {
                    return Err(validation(
                        "Only text and relation fields count as a creator, contributor or originator.",
                    ));
                }
                self.tx.execute("INSERT INTO fields(block_id, kind, counts_as) VALUES (?1, 'text', ?2) ON CONFLICT(block_id) DO UPDATE SET counts_as = excluded.counts_as",
                    params![id, counts_as.map(CountsAs::as_str)])?;
                self.bump(&current, true)
            }
            Operation::SetFieldTargets {
                id,
                base_revision,
                targets,
            } => {
                crate::fields::require_definition(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                let instance: bool = self.tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM fields WHERE block_id = ?1 AND kind = 'instance')",
                    [id],
                    |row| row.get(0),
                )?;
                if !instance {
                    return Err(validation("targets require an Instance field"));
                }
                let mut unique = HashSet::with_capacity(targets.len());
                for target in targets {
                    if !unique.insert(target) {
                        return Err(validation("duplicate field target"));
                    }
                }
                for target in targets
                    .iter()
                    .filter(|target| *target != crate::fields::SOURCE_TARGET)
                {
                    let block = self.live(target)?;
                    if block.block.kind != BlockKind::Page || block.block.archived {
                        return Err(validation("target tag must be a live titled atom"));
                    }
                }
                crate::fields::file_targets(self.tx, id, targets)?;
                self.bump(&current, true)
            }
            Operation::SetTypeFields {
                type_id,
                base_revision,
                fields,
            } => {
                let current = self.checked(type_id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("tag must be a titled atom"));
                }
                let mut unique = HashSet::new();
                for field in fields {
                    if !crate::fields::is_definition(self.tx, field)? {
                        return Err(validation(format!(
                            "not a readable field definition: {field}"
                        )));
                    }
                    if !unique.insert(field) {
                        return Err(validation("duplicate field in tag template"));
                    }
                }
                if let Some(problem) =
                    crate::built_in::removal_problem(self.tx, type_id, &current.block.text, fields)?
                {
                    return Err(validation(problem));
                }
                self.tx
                    .execute("DELETE FROM type_fields WHERE type_id = ?1", [type_id])?;
                let mut insert = self.tx.prepare_cached(
                    "INSERT INTO type_fields(type_id, field_id, position) VALUES (?1, ?2, ?3)",
                )?;
                for (position, field) in fields.iter().enumerate() {
                    insert.execute(params![type_id, field, position as i64])?;
                }
                self.bump(&current, true)
            }
            Operation::SetTypePresentation {
                type_id,
                base_revision,
                plural,
                icon,
            } => {
                let current = self.checked(type_id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("tag must be a titled atom"));
                }
                let plural = plural.as_deref().map(str::trim);
                if plural.is_some_and(str::is_empty) {
                    return Err(validation("plural must not be empty"));
                }
                if icon.as_ref().is_some_and(|icon| {
                    icon.is_empty()
                        || icon.len() > 64
                        || !icon
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                }) {
                    return Err(validation("icon must be a short glyph token"));
                }
                self.tx.execute(
                    "INSERT INTO type_presentation(type_id, plural, icon) VALUES (?1, ?2, ?3)
                     ON CONFLICT(type_id) DO UPDATE SET plural = excluded.plural, icon = excluded.icon",
                    params![type_id, plural, icon],
                )?;
                self.bump(&current, true)
            }
            Operation::SetSubjectCriteria {
                subject_id,
                base_revision,
                fields,
            } => {
                let current = self.checked(subject_id, *base_revision, index, false)?;
                let mut unique = HashSet::with_capacity(fields.len());
                for field in fields {
                    crate::fields::require_definition(self.tx, field)?;
                    if !unique.insert(field) {
                        return Err(validation("duplicate field in subject criteria"));
                    }
                }
                self.tx.execute(
                    "DELETE FROM subject_criteria WHERE subject_id = ?1",
                    [subject_id],
                )?;
                let mut insert = self.tx.prepare_cached(
                    "INSERT INTO subject_criteria(subject_id, field_id, position) VALUES (?1, ?2, ?3)",
                )?;
                for (position, field) in fields.iter().enumerate() {
                    insert.execute(params![subject_id, field, position as i64])?;
                }
                self.bump(&current, true)
            }
            Operation::TransferCardKey { source_id, .. } => {
                let revision =
                    crate::card_templates::transfer_key(self.tx, operation, self.now, index)?;
                self.cards.insert(revision.id.clone(), revision);
                self.card_sources.insert(source_id.clone());
                let current = self.live(source_id)?;
                self.record_revision(source_id, current.block.revision);
                Ok(())
            }
            Operation::CreateCardTemplate { .. }
            | Operation::UpdateCardTemplate { .. }
            | Operation::SetCardTemplateApplied { .. }
            | Operation::DeleteCardTemplate { .. } => {
                let (type_id, revision) =
                    crate::card_templates::apply(self.tx, operation, self.now, index)?;
                self.template_types.insert(type_id);
                self.record_revision(&revision.id, revision.revision);
                Ok(())
            }
            Operation::SaveView {
                id,
                base_revision,
                name,
                query,
            } => {
                validate_id(id)?;
                let found = self.view_revision(id)?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        id: id.clone(),
                        expected: base_revision.unwrap_or(0),
                        found,
                    });
                }
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 120 {
                    return Err(validation("view name must contain 1 to 120 characters"));
                }
                crate::query::validate_saved_query(self.tx, query)?;
                let revision = found.unwrap_or(0) + 1;
                self.tx.execute(
                    "INSERT INTO views(id, name, query, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                     ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query, revision = excluded.revision, updated_at = excluded.updated_at",
                    params![id, name, serde_json::to_string(query).expect("query serializes"), revision, self.now])?;
                self.touch(id, revision);
                Ok(())
            }
            Operation::DeleteView { id, base_revision } => {
                validate_id(id)?;
                let found = self.view_revision(id)?.ok_or_else(|| not_found(id))?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        id: id.clone(),
                        expected: *base_revision,
                        found: Some(found),
                    });
                }
                self.tx.execute("DELETE FROM views WHERE id = ?1", [id])?;
                self.touch(id, found + 1);
                Ok(())
            }
            Operation::SetSetting {
                key,
                base_revision,
                value,
            } => {
                crate::settings::validate_setting(key, value)?;
                let found = self
                    .tx
                    .prepare_cached("SELECT revision FROM settings WHERE key = ?1")?
                    .query_row([key], |row| row.get::<_, i64>(0))
                    .optional()?;
                if found != *base_revision {
                    return Err(Error::Conflict {
                        op_index: index,
                        id: key.clone(),
                        expected: base_revision.unwrap_or(0),
                        found,
                    });
                }
                let revision = found.unwrap_or(0) + 1;
                self.tx.execute(
                    "INSERT INTO settings(key, value, revision, updated_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at",
                    params![key, value, revision, self.now],
                )?;
                if let Some(setting) = self.settings.iter_mut().find(|setting| setting.key == *key)
                {
                    setting.revision = revision;
                } else {
                    self.settings.push(SettingRevision {
                        key: key.clone(),
                        revision,
                    });
                }
                Ok(())
            }
            Operation::SetSource {
                id, base_revision, ..
            }
            | Operation::AttachSnapshot {
                id, base_revision, ..
            }
            | Operation::Cite {
                id, base_revision, ..
            }
            | Operation::Uncite {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                let changed = crate::library_store::apply(self.tx, operation, self.now, self.seq)?;
                let removed = matches!(operation, Operation::SetSource { source: None, .. })
                    && self.remove_capability_tag(id, "source")?;
                if changed {
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetCitationTriage {
                id, base_revision, ..
            }
            | Operation::SetCitationRange {
                id, base_revision, ..
            }
            | Operation::SetCitationColor {
                id, base_revision, ..
            } => {
                let block_id: String = self
                    .tx
                    .query_row(
                        "SELECT block_id FROM citations WHERE id = ?1 AND active = 1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| crate::storage::not_found(id))?;
                let current = self.checked(&block_id, *base_revision, index, false)?;
                if crate::library_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(block_id);
                }
                Ok(())
            }
            Operation::SetPosition {
                id,
                base_revision,
                position,
            } => {
                crate::position_store::validate_source(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::position_store::set(self.tx, id, *position)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetRelation {
                id,
                base_revision,
                relation,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::relation_store::set(self.tx, id, *relation)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetSpread {
                id,
                base_revision,
                spread,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("Only a titled atom can be a spread."));
                }
                if crate::spreads::set(self.tx, id, *spread)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::Revisit {
                id, base_revision, ..
            }
            | Operation::RestoreRevisit {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::revisit_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetQuote {
                id,
                base_revision,
                quote,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::quote_store::set(self.tx, &current.block, quote.as_ref())? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetImage {
                id,
                base_revision,
                image,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::image_store::set(
                    self.tx,
                    self.object_dir,
                    self.local,
                    &current.block,
                    image.as_ref(),
                )? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                    self.card_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetOcclusion {
                id,
                base_revision,
                occlusion,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::occlusion::set(self.tx, id, occlusion.as_ref())? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                    self.card_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetQuestion {
                id, base_revision, ..
            }
            | Operation::SetAssessment {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if matches!(
                    operation,
                    Operation::SetQuestion {
                        question: Some(_),
                        ..
                    }
                ) && current.block.kind == BlockKind::Journal
                {
                    return Err(validation("Make a non-journal atom a question."));
                }
                if matches!(
                    operation,
                    Operation::SetAssessment {
                        assessment: Some(_),
                        ..
                    }
                ) && current.block.kind != BlockKind::Block
                {
                    return Err(validation("Make an ordinary atom an answer."));
                }
                let revisit_before = if matches!(operation, Operation::SetQuestion { .. }) {
                    Some(crate::revisit_store::snapshot(self.tx, id)?)
                } else {
                    None
                };
                let today = crate::settings::today_in_connection(self.tx, self.now)?;
                let changed = crate::question_store::apply(self.tx, operation, &today)?;
                let removed = matches!(operation, Operation::SetQuestion { question: None, .. })
                    && self.remove_capability_tag(id, "question")?;
                if changed {
                    if let Some(before) = revisit_before {
                        crate::revisit_store::question_changed(self.tx, id, &before, self.now)?;
                    }
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                    if matches!(
                        operation,
                        Operation::SetAssessment {
                            assessment: None,
                            ..
                        }
                    ) {
                        for owner in crate::question_store::withdraw_acceptance(self.tx, id)? {
                            let question = self.live(&owner)?;
                            self.bump(&question, false)?;
                            self.capability_sources.insert(owner);
                        }
                    }
                }
                Ok(())
            }
            Operation::SetTask {
                id, base_revision, ..
            }
            | Operation::RestoreTaskState {
                id, base_revision, ..
            }
            | Operation::CompleteTask {
                id, base_revision, ..
            }
            | Operation::ReverseTaskCompletion {
                id, base_revision, ..
            }
            | Operation::SetProject {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                let changed = crate::task_store::apply(self.tx, operation, self.now, self.seq)?;
                let removed = match operation {
                    Operation::SetTask { task: None, .. } => {
                        self.remove_capability_tag(id, "task")?
                    }
                    Operation::SetProject { project: None, .. } => {
                        self.remove_capability_tag(id, "project")?
                    }
                    _ => false,
                };
                if changed {
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::StartWork {
                id, base_revision, ..
            }
            | Operation::StopWork {
                id, base_revision, ..
            }
            | Operation::EditWorkNote {
                id, base_revision, ..
            }
            | Operation::SetWorkSessionState {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(session) =
                    crate::work_store::apply(self.tx, operation, self.now, self.seq, index)?
                {
                    self.bump(&current, false)?;
                    if matches!(
                        operation,
                        Operation::StartWork { .. } | Operation::SetWorkSessionState { .. }
                    ) {
                        self.capability_sources.insert(id.clone());
                    }
                    self.work_sessions.insert(session.id.clone(), session);
                }
                Ok(())
            }
            Operation::StartReviewSession { .. }
            | Operation::FinishReviewSession { .. }
            | Operation::GradeCard { .. }
            | Operation::UndoGrade { .. }
            | Operation::ResetCard { .. }
            | Operation::SetCardHeld { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. } => {
                // A preceding text edit must invalidate stale shown definitions
                // before a grade, reset or hold checks the card's own revision.
                if matches!(
                    operation,
                    Operation::GradeCard { .. }
                        | Operation::UndoGrade { .. }
                        | Operation::ResetCard { .. }
                        | Operation::SetCardHeld { .. }
                ) {
                    self.derive_cards()?;
                }
                let changes =
                    crate::review_store::apply(self.tx, operation, self.now, self.seq, index)?;
                for revision in changes.cards {
                    self.cards.insert(revision.id.clone(), revision);
                }
                for session in changes.sessions {
                    self.review_sessions.insert(session.id.clone(), session);
                }
                for revision in changes.decks {
                    self.decks.insert(revision.id.clone(), revision);
                }
                Ok(())
            }
            Operation::SaveTaskView { .. } | Operation::DeleteTaskView { .. } => {
                let revision = crate::task_query::apply_view(self.tx, operation, self.now, index)?;
                self.task_views.insert(revision.id.clone(), revision);
                Ok(())
            }
            Operation::SaveLibraryView { .. } | Operation::DeleteLibraryView { .. } => {
                let revision =
                    crate::library_views::apply_view(self.tx, operation, self.now, index)?;
                self.library_views.insert(revision.id.clone(), revision);
                Ok(())
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
        let mut notebook = Notebook::open(directory.path()).unwrap();
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
        let committed = notebook.apply(&batch).unwrap();
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
        notebook
            .conn
            .execute(
                "UPDATE changes SET committed = ?1 WHERE seq = ?2",
                params![serde_json::to_string(&legacy).unwrap(), committed.seq],
            )
            .unwrap();
        drop(notebook);

        let mut notebook = Notebook::open(directory.path()).unwrap();
        let replayed = notebook.apply(&batch).unwrap();
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
        let changes = notebook.changes_since(0, 10).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].seq, committed.seq);
        assert_eq!(changes[0].blocks, vec![notebook.block(&id).unwrap()]);
        assert!(changes[0].capabilities.is_empty());
        assert!(changes[0].cards.is_empty());
        assert!(changes[0].work_sessions.is_empty());
        assert!(changes[0].review_sessions.is_empty());
        assert!(changes[0].decks.is_empty());
        assert!(changes[0].task_views.is_empty());
        assert!(changes[0].library_views.is_empty());
    }
}
