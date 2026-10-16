//! Applying a change another device made, resolving what it collides with.
//! See "Conflicts" and "Natural-key collisions" in `docs/sync.md`.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::Value;

use crate::notebook::derived_id;
use crate::operations::{ConflictRow, Extras, operations_hash};
use crate::storage::validation;
use crate::sync::{PushOutcome, PushedChange, json};
use crate::{Batch, Committed, Error, Notebook, Operation, Result};

/// Field pairs naming a resource and the revision an operation expects of it.
const REVISIONS: &[(&str, &str)] = &[
    ("id", "base_revision"),
    ("source_id", "source_revision"),
    ("destination_id", "destination_revision"),
    ("type_id", "base_revision"),
    ("subject_id", "base_revision"),
    ("key", "base_revision"),
    ("session_id", "session_revision"),
];

/// Errors that mean the change cannot apply, as opposed to failures of the
/// notebook itself.
pub(crate) fn rejectable(error: &Error) -> bool {
    match error {
        Error::Conflict { .. } | Error::NotFound { .. } | Error::Validation { .. } => true,
        Error::Sqlite(rusqlite::Error::SqliteFailure(failure, _)) => {
            failure.code == rusqlite::ErrorCode::ConstraintViolation
        }
        _ => false,
    }
}

/// The batch to commit for a replicated change, and what to record with it.
struct Rewrite {
    batch: Batch,
    aliases: Vec<(String, String)>,
    conflicts: Vec<ConflictRow>,
}

impl Notebook {
    /// Apply a change made on another device, or replay this replica's own.
    /// Revision checks rebase: structure and capabilities take the later
    /// change. Text another device also changed is kept beside the block.
    /// A change that still cannot apply is recorded as rejected when
    /// `reject` is set and returned as an error otherwise.
    pub(crate) fn apply_replicated(
        &mut self,
        change: &PushedChange,
        reject: bool,
    ) -> Result<PushOutcome> {
        if let Some(outcome) = self.outcome_of(&change.stamp.id)? {
            return Ok(outcome);
        }
        let mut rewrite = self.rewrite(change)?;
        let extras = Extras {
            aliases: std::mem::take(&mut rewrite.aliases),
            conflicts: std::mem::take(&mut rewrite.conflicts),
            origin_batch: Some(&change.batch),
            bases: Some(&change.bases),
        };
        // Everything the change made already exists here; keep what it
        // resolved to so later changes that name its IDs still apply.
        if rewrite.batch.operations.is_empty() {
            let seq = self.record_without_effect(change, &extras)?;
            return Ok(PushOutcome::Accepted { seq });
        }
        let mut attempts = rewrite.batch.operations.len() + 2;
        loop {
            let error =
                match self.commit(&rewrite.batch, Some(&change.stamp), &extras, |_, _| Ok(())) {
                    Ok(committed) => return Ok(PushOutcome::Accepted { seq: committed.seq }),
                    Err(error) => error,
                };
            attempts -= 1;
            if let Error::Conflict {
                op_index,
                ref id,
                expected,
                found: Some(found),
            } = error
                && attempts > 0
                && rebase(&mut rewrite.batch, op_index, id, expected, found)
            {
                continue;
            }
            if reject && rejectable(&error) {
                return self.reject(change, &error);
            }
            return Err(error);
        }
    }

    fn outcome_of(&self, change_id: &str) -> Result<Option<PushOutcome>> {
        let Some(seq) = self
            .conn
            .query_row(
                "SELECT seq FROM changes WHERE change_id = ?1",
                [change_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let error = self
            .conn
            .query_row(
                "SELECT error FROM sync_conflicts WHERE change_id = ?1 AND kind = 'rejected'",
                [change_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(Some(match error {
            Some(error) => PushOutcome::Rejected {
                seq,
                error: error.unwrap_or_default(),
            },
            None => PushOutcome::Accepted { seq },
        }))
    }

    /// Record a change that cannot apply as a change without effect, keeping
    /// its batch as a rejected conflict every device sees.
    fn reject(&mut self, change: &PushedChange, error: &Error) -> Result<PushOutcome> {
        let message = error.to_string();
        let extras = Extras {
            conflicts: vec![ConflictRow {
                id: derived_id(&["rejected", &change.stamp.id]),
                kind: "rejected",
                block_id: None,
                text: None,
                batch: Some(json(&change.batch)),
                error: Some(message.clone()),
            }],
            ..Extras::default()
        };
        let seq = self.record_without_effect(change, &extras)?;
        Ok(PushOutcome::Rejected {
            seq,
            error: message,
        })
    }

    /// Log a change that writes nothing else, with what `extras` records.
    fn record_without_effect(&mut self, change: &PushedChange, extras: &Extras) -> Result<i64> {
        let stamp = &change.stamp;
        let operations = json(&change.batch.operations);
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recording = crate::sync::begin(&tx, &change.batch, extras)?;
        tx.execute(
            "INSERT INTO changes(actor, reason, created_at, operations_hash, operations, committed, change_id, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?7)",
            params![json(&change.batch.actor), change.batch.reason, stamp.at,
                operations_hash(&operations), operations, stamp.id, stamp.origin],
        )?;
        let seq = tx.last_insert_rowid();
        let committed = Committed {
            seq,
            revisions: Vec::new(),
            removed: Vec::new(),
            deletions: Vec::new(),
            pages: Some(Vec::new()),
            text_rewrites: Vec::new(),
            settings: Vec::new(),
            capabilities: Vec::new(),
            cards: Vec::new(),
            work_sessions: Vec::new(),
            review_sessions: Vec::new(),
            decks: Vec::new(),
            task_views: Vec::new(),
            library_views: Vec::new(),
            replayed: false,
        };
        tx.execute(
            "UPDATE changes SET committed = ?1 WHERE seq = ?2",
            params![json(&committed), seq],
        )?;
        extras.write(&tx, stamp, seq)?;
        crate::reads::record_editor_event(&tx, seq, false)?;
        if let Some(recording) = { recording } {
            crate::sync::finish(&tx, recording, seq, stamp, &change.batch, extras)?;
        }
        tx.commit()?;
        Ok(seq)
    }

    fn rewrite(&self, change: &PushedChange) -> Result<Rewrite> {
        let stamp = &change.stamp;
        let mut operations: Vec<Value> = change
            .batch
            .operations
            .iter()
            .map(|operation| serde_json::to_value(operation).expect("operations serialize"))
            .collect();
        let mut bases = change.bases.clone();

        // IDs earlier changes resolved to existing records.
        let known: Vec<(String, String)> = self
            .conn
            .prepare("SELECT alias, target FROM id_aliases")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        substitute(&mut operations, &mut bases, &known);

        let mut aliases = Vec::new();
        self.merge_duplicate_sources(&mut operations, &mut aliases)?;
        self.merge_duplicate_fields(&mut operations, &mut aliases)?;

        // A page title or journal day this notebook already has resolves to
        // the existing root; the change's children follow its children.
        let mut kept = Vec::with_capacity(operations.len());
        let mut merged_pages = BTreeSet::new();
        for operation in operations {
            let existing = match field(&operation, "op") {
                Some("create_page") => self
                    .conn
                    .query_row(
                        "SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?1",
                        [crate::storage::title_key(field(&operation, "title").unwrap_or_default())],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?,
                Some("create_journal") => self
                    .conn
                    .query_row(
                        "SELECT id FROM blocks WHERE kind = 'journal' AND deletion_id IS NULL AND text = ?1",
                        [field(&operation, "date").unwrap_or_default()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?,
                _ => None,
            };
            match (existing, field(&operation, "id")) {
                (Some(target), Some(id)) if target != id => {
                    let typed: bool = self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM type_fields WHERE type_id = ?1)",
                        [&target],
                        |row| row.get(0),
                    )?;
                    if typed {
                        merged_pages.insert(id.to_owned());
                    }
                    aliases.push((id.to_owned(), target));
                }
                _ => kept.push(operation),
            }
        }
        // A type the change created resolved to one that already has fields,
        // such as Book on a first import on each device; those fields stay.
        kept.retain(|operation| {
            field(operation, "op") != Some("set_type_fields")
                || !field(operation, "type_id").is_some_and(|id| merged_pages.contains(id))
        });
        let mut operations = kept;
        for (alias, target) in &aliases {
            let last_child: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                     ORDER BY ordinal DESC, id DESC LIMIT 1",
                    [target],
                    |row| row.get(0),
                )
                .optional()?;
            for operation in &mut operations {
                if field(operation, "op") == Some("insert")
                    && field(operation, "parent_id") == Some(alias)
                    && operation["after"].is_null()
                {
                    operation["after"] = last_child.clone().map_or(Value::Null, Value::String);
                }
            }
        }
        substitute(&mut operations, &mut bases, &aliases);

        // Text another device also changed since this change's base.
        let mut divergent: BTreeMap<String, Divergent> = BTreeMap::new();
        for (id, base) in &bases {
            let current: Option<(String, Option<String>)> = self
                .conn
                .query_row(
                    "SELECT text, parent_id FROM blocks WHERE id = ?1 AND deletion_id IS NULL",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((text, parent)) = current
                && text != *base
            {
                divergent.insert(
                    id.clone(),
                    Divergent {
                        current: text,
                        parent,
                        copy: None,
                    },
                );
            }
        }
        let mut conflicts = Vec::new();
        if !divergent.is_empty() {
            let mut rewritten = Vec::with_capacity(operations.len());
            for operation in operations {
                let id = field(&operation, "id").map(str::to_owned);
                let Some(state) = id.as_ref().and_then(|id| divergent.get_mut(id)) else {
                    rewritten.push(operation);
                    continue;
                };
                let id = id.expect("divergent operations name a block");
                let text = match field(&operation, "op") {
                    Some("edit_text") => field(&operation, "text").unwrap_or_default().to_owned(),
                    Some("split") => {
                        rewritten.push(serde_json::json!({
                            "op": "insert",
                            "id": operation["new_id"],
                            "parent_id": state.parent.clone().unwrap_or_else(|| id.clone()),
                            "after": if state.parent.is_some() { Value::String(id.clone()) } else { Value::Null },
                            "text": operation["right"],
                            "heading": null,
                        }));
                        field(&operation, "left").unwrap_or_default().to_owned()
                    }
                    _ => {
                        rewritten.push(operation);
                        continue;
                    }
                };
                if text == state.current {
                    continue;
                }
                let (copy, revision) = match state.copy.take() {
                    Some((copy, revision)) => {
                        rewritten.push(serde_json::json!({
                            "op": "edit_text", "id": copy, "base_revision": revision, "text": text,
                        }));
                        (copy, revision + 1)
                    }
                    None => match self.open_copy(&stamp.origin, &id, &bases[&id])? {
                        Some((copy, revision)) => {
                            rewritten.push(serde_json::json!({
                                "op": "edit_text", "id": copy, "base_revision": revision, "text": text,
                            }));
                            (copy, revision + 1)
                        }
                        None => {
                            let copy = derived_id(&["conflict-copy", &stamp.id, &id]);
                            rewritten.push(serde_json::json!({
                                "op": "insert",
                                "id": copy,
                                "parent_id": state.parent.clone().unwrap_or_else(|| id.clone()),
                                "after": if state.parent.is_some() { Value::String(id.clone()) } else { Value::Null },
                                "text": text,
                                "heading": null,
                            }));
                            (copy, 1)
                        }
                    },
                };
                conflicts.retain(|row: &ConflictRow| row.id != copy);
                conflicts.push(ConflictRow {
                    id: copy.clone(),
                    kind: "copy",
                    block_id: Some(id),
                    text: Some(text),
                    batch: None,
                    error: None,
                });
                state.copy = Some((copy, revision));
            }
            operations = rewritten;
        }

        // Citation keys are unique among active sources.
        for operation in &mut operations {
            if field(operation, "op") != Some("set_source") {
                continue;
            }
            let id = field(operation, "id").unwrap_or_default().to_owned();
            let Some(key) = operation["source"]["citation_key"]
                .as_str()
                .map(str::to_owned)
            else {
                continue;
            };
            let taken = |candidate: &str| -> Result<bool> {
                Ok(self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sources WHERE active = 1
                     AND citation_key = ?1 COLLATE NOCASE AND block_id <> ?2)",
                    params![candidate, id],
                    |row| row.get(0),
                )?)
            };
            if taken(&key)? {
                let mut n = 0;
                let mut candidate = format!("{key}{}", crate::library_ingest::suffix(n));
                while taken(&candidate)? {
                    n += 1;
                    candidate = format!("{key}{}", crate::library_ingest::suffix(n));
                }
                operation["source"]["citation_key"] = Value::String(candidate);
            }
        }

        let operations: Vec<Operation> = operations
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()
            .map_err(|error| validation(format!("invalid replicated operation: {error}")))?;
        Ok(Rewrite {
            batch: Batch {
                operations,
                ..change.batch.clone()
            },
            aliases,
            conflicts,
        })
    }

    /// A book this notebook already has as a source, imported again on
    /// another device: the change's new source page resolves to the existing
    /// source, and what the import put under that page is dropped. A
    /// snapshot the existing source lacks is attached to it.
    fn merge_duplicate_sources(
        &self,
        operations: &mut Vec<Value>,
        aliases: &mut Vec<(String, String)>,
    ) -> Result<()> {
        let created: BTreeSet<String> = operations
            .iter()
            .filter(|operation| field(operation, "op") == Some("create_page"))
            .filter_map(|operation| field(operation, "id").map(str::to_owned))
            .collect();
        // New source pages, with their match key and snapshot.
        let mut books: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
        for operation in operations.iter() {
            let Some(id) = field(operation, "id").filter(|id| created.contains(*id)) else {
                continue;
            };
            match field(operation, "op") {
                Some("set_source") => {
                    books.entry(id.to_owned()).or_default().0 =
                        operation["source"]["match_key"].as_str().map(str::to_owned);
                }
                Some("attach_snapshot") => {
                    books.entry(id.to_owned()).or_default().1 =
                        field(operation, "snapshot_id").map(str::to_owned);
                }
                _ => {}
            }
        }
        let mut dropped = BTreeSet::new();
        let mut attach = BTreeMap::new();
        for (id, (key, snapshot)) in &books {
            let Some(target) = self
                .conn
                .query_row(
                    "SELECT s.block_id FROM sources s JOIN blocks b ON b.id = s.block_id
                     WHERE s.active = 1 AND b.deletion_id IS NULL AND s.block_id <> ?3
                     AND ((?1 IS NOT NULL AND s.match_key = ?1) OR (?2 IS NOT NULL AND EXISTS(
                         SELECT 1 FROM source_snapshots a WHERE a.source_id = s.block_id AND a.snapshot_id = ?2)))
                     ORDER BY CASE WHEN s.match_key = ?1 THEN 0 ELSE 1 END, s.added_at, s.block_id
                     LIMIT 1",
                    params![key, snapshot, id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                continue;
            };
            if let Some(snapshot) = snapshot {
                let attached: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM source_snapshots WHERE source_id = ?1 AND snapshot_id = ?2)",
                    params![target, snapshot],
                    |row| row.get(0),
                )?;
                if !attached {
                    let revision: i64 = self.conn.query_row(
                        "SELECT revision FROM blocks WHERE id = ?1",
                        [&target],
                        |row| row.get(0),
                    )?;
                    attach.insert(id.clone(), revision);
                }
            }
            dropped.insert(id.clone());
            aliases.push((id.clone(), target));
        }
        if dropped.is_empty() {
            return Ok(());
        }
        // Blocks the import inserted under a dropped page go with it.
        loop {
            let before = dropped.len();
            for operation in operations.iter() {
                if field(operation, "op") == Some("insert")
                    && field(operation, "parent_id").is_some_and(|parent| dropped.contains(parent))
                    && let Some(id) = field(operation, "id")
                {
                    dropped.insert(id.to_owned());
                }
            }
            if dropped.len() == before {
                break;
            }
        }
        operations.retain_mut(|operation| {
            let Some(id) = field(operation, "id") else {
                return true;
            };
            if field(operation, "op") == Some("attach_snapshot")
                && let Some(revision) = attach.get(id)
            {
                operation["base_revision"] = Value::from(*revision);
                return true;
            }
            !dropped.contains(id)
        });
        Ok(())
    }

    /// A field another device created with the name of a field this notebook
    /// already has: the new field resolves to the existing one, which keeps
    /// its kind, and the operations creating it are dropped.
    fn merge_duplicate_fields(
        &self,
        operations: &mut Vec<Value>,
        aliases: &mut Vec<(String, String)>,
    ) -> Result<()> {
        let Some(fields_page) = crate::fields::page_id(&self.conn)? else {
            return Ok(());
        };
        // A new field is a block inserted on the Fields page and given a kind.
        let kinded: BTreeSet<&str> = operations
            .iter()
            .filter(|operation| field(operation, "op") == Some("set_field_kind"))
            .filter_map(|operation| field(operation, "id"))
            .collect();
        let new: Vec<(String, String)> = operations
            .iter()
            .filter(|operation| {
                field(operation, "op") == Some("insert")
                    && field(operation, "parent_id") == Some(fields_page.as_str())
            })
            .filter_map(|operation| Some((field(operation, "id")?, field(operation, "text")?)))
            .filter(|(id, _)| kinded.contains(id))
            .map(|(id, name)| (id.to_owned(), name.to_lowercase()))
            .collect();
        if new.is_empty() {
            return Ok(());
        }
        let existing: BTreeMap<String, String> = crate::fields::definitions(&self.conn)?
            .into_iter()
            .map(|definition| (definition.name.to_lowercase(), definition.id))
            .collect();
        let mut dropped = BTreeSet::new();
        for (id, name) in new {
            if let Some(target) = existing.get(&name)
                && *target != id
            {
                aliases.push((id.clone(), target.clone()));
                dropped.insert(id);
            }
        }
        operations.retain(|operation| {
            !matches!(
                field(operation, "op"),
                Some(
                    "insert"
                        | "set_field_kind"
                        | "set_field_hide"
                        | "set_field_role"
                        | "set_field_targets"
                )
            ) || !field(operation, "id").is_some_and(|id| dropped.contains(id))
        });
        Ok(())
    }

    /// A live copy that `origin` keeps beside `block` and last set to `text`,
    /// so a run of edits on one side of a conflict updates one copy.
    fn open_copy(&self, origin: &str, block: &str, text: &str) -> Result<Option<(String, i64)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT c.id, b.revision FROM sync_conflicts c JOIN blocks b ON b.id = c.id
                 WHERE c.kind = 'copy' AND c.origin = ?1 AND c.block_id = ?2 AND c.text = ?3
                 AND c.settled_at IS NULL AND b.deletion_id IS NULL ORDER BY c.change_seq DESC LIMIT 1",
                params![origin, block, text],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }
}

struct Divergent {
    current: String,
    parent: Option<String>,
    /// The copy this batch writes to and its revision after the last write.
    copy: Option<(String, i64)>,
}

fn field<'a>(operation: &'a Value, name: &str) -> Option<&'a str> {
    operation.get(name).and_then(Value::as_str)
}

/// Replace aliased IDs everywhere they occur, including in link text.
fn substitute(
    operations: &mut [Value],
    bases: &mut BTreeMap<String, String>,
    aliases: &[(String, String)],
) {
    if aliases.is_empty() {
        return;
    }
    for operation in operations.iter_mut() {
        let mut text = operation.to_string();
        let mut changed = false;
        for (alias, target) in aliases {
            if text.contains(alias.as_str()) {
                text = text.replace(alias.as_str(), target);
                changed = true;
            }
        }
        if changed {
            *operation = serde_json::from_str(&text).expect("substituted operation is JSON");
        }
    }
    for (alias, target) in aliases {
        if let Some(base) = bases.remove(alias) {
            bases.entry(target.clone()).or_insert(base);
        }
    }
}

/// Move every expectation of `id` from `op_index` on by the revisions the
/// resource gained elsewhere. False when no operation names it.
fn rebase(batch: &mut Batch, op_index: usize, id: &str, expected: i64, found: i64) -> bool {
    let delta = found - expected;
    let mut moved = false;
    for operation in batch.operations.iter_mut().skip(op_index) {
        let mut value = serde_json::to_value(&*operation).expect("operations serialize");
        let mut changed = false;
        for (name, revision) in REVISIONS {
            if value.get(*name).and_then(Value::as_str) != Some(id) {
                continue;
            }
            match value.get(*revision) {
                Some(Value::Number(number)) => {
                    let Some(number) = number.as_i64() else {
                        continue;
                    };
                    value[*revision] = Value::from(number + delta);
                    changed = true;
                }
                Some(Value::Null) if expected == 0 => {
                    value[*revision] = Value::from(found);
                    changed = true;
                }
                _ => {}
            }
        }
        if changed {
            *operation = serde_json::from_value(value).expect("rebased operation parses");
            moved = true;
        }
    }
    moved
}
