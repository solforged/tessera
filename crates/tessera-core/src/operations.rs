use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::notebook::now_ms;
use crate::storage::{
    Stored, derive_links, derive_memberships, not_found, resolve_type, rewrite_tags, stored,
    tag_names, tag_spelling, tag_title_matches, validate_id, validate_tag_title, validate_text,
    validation,
};
use crate::{
    Batch, BlockCapabilities, BlockKind, Committed, Error, Notebook, Operation, Result,
    ReviewSession, Revision, SettingRevision, TextRewrite, WorkSession,
};

const GAP: i64 = 1024;

impl Notebook {
    /// Commit a revision-checked batch atomically, including derived indexes.
    pub fn apply(&mut self, batch: &Batch) -> Result<Committed> {
        let operations = serde_json::to_string(&batch.operations).expect("operations serialize");
        let hash = Sha256::digest(operations.as_bytes()).iter().fold(
            String::with_capacity(64),
            |mut hex, byte| {
                write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
                hex
            },
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(key) = &batch.idempotency_key {
            let prior: Option<(String, String)> = tx
                .query_row(
                    "SELECT operations_hash, committed FROM changes WHERE idempotency_key = ?1",
                    [key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((prior_hash, result)) = prior {
                if hash != prior_hash {
                    return Err(validation(
                        "idempotency key was already used for different operations",
                    ));
                }
                let mut committed: Committed = serde_json::from_str(&result)
                    .map_err(|error| validation(format!("invalid stored result: {error}")))?;
                committed.replayed = true;
                return Ok(committed);
            }
        }
        if batch.operations.is_empty() {
            return Err(validation("batch must contain an operation"));
        }
        let now = now_ms();
        tx.execute(
            "INSERT INTO changes(actor, reason, created_at, idempotency_key, operations_hash, operations, committed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}')",
            params![serde_json::to_string(&batch.actor).expect("actor serializes"), batch.reason, now,
                batch.idempotency_key, hash, operations],
        )?;
        let seq = tx.last_insert_rowid();
        let mut field_changes = crate::fields::FieldChanges::default();
        let mut engine = Engine {
            tx: &tx,
            now,
            seq,
            revisions: Vec::new(),
            settings: Vec::new(),
            capability_sources: HashSet::new(),
            card_sources: HashSet::new(),
            cards: BTreeMap::new(),
            work_sessions: BTreeMap::new(),
            review_sessions: BTreeMap::new(),
            decks: BTreeMap::new(),
            task_views: BTreeMap::new(),
            library_views: BTreeMap::new(),
            positions: HashMap::new(),
            deletions: Vec::new(),
            restructured_pages: HashSet::new(),
            changed_titles: HashSet::new(),
            pending_renames: Vec::new(),
            text_rewrites: Vec::new(),
            rewrite_positions: HashMap::new(),
            operations: &batch.operations,
            op_index: 0,
        };
        for (index, operation) in batch.operations.iter().enumerate() {
            engine.op_index = index;
            field_changes.before(&tx, operation)?;
            engine
                .operation(operation, index)
                .map_err(|error| indexed(error, index))?;
        }
        engine.rewrite_incoming_tags()?;
        engine.derive_tags()?;
        engine.reconcile_titles()?;
        engine.derive_cards()?;
        for revision in &engine.revisions {
            if engine.positions[&revision.id].fields {
                field_changes.capture(&tx, &revision.id)?;
            }
        }
        field_changes.derive(&tx)?;
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
        let committed = Committed {
            seq,
            revisions: engine.revisions,
            settings: engine.settings,
            deletions: engine.deletions,
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
        tx.commit()?;
        Ok(committed)
    }
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

struct Engine<'a, 'conn> {
    tx: &'a Transaction<'conn>,
    now: i64,
    seq: i64,
    revisions: Vec<Revision>,
    settings: Vec<SettingRevision>,
    capability_sources: HashSet<String>,
    card_sources: HashSet<String>,
    cards: BTreeMap<String, Revision>,
    work_sessions: BTreeMap<String, WorkSession>,
    review_sessions: BTreeMap<String, ReviewSession>,
    decks: BTreeMap<String, Revision>,
    task_views: BTreeMap<String, Revision>,
    library_views: BTreeMap<String, Revision>,
    positions: HashMap<String, Touched>,
    deletions: Vec<String>,
    restructured_pages: HashSet<String>,
    changed_titles: HashSet<String>,
    pending_renames: Vec<TagRename>,
    text_rewrites: Vec<TextRewrite>,
    rewrite_positions: HashMap<String, usize>,
    operations: &'a [Operation],
    op_index: usize,
}

struct Touched {
    position: usize,
    tags: bool,
    fields: bool,
}

struct TagRename {
    title_key: String,
    page_id: String,
    sources: Vec<String>,
    op_index: usize,
}

struct TagReplacement {
    title_key: String,
    title: String,
    spelling: String,
    case_only: bool,
    op_index: usize,
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
        self.record_revision(id, revision);
        self.positions.get_mut(id).expect("touched block").fields = true;
    }

    fn record_revision(&mut self, id: &str, revision: i64) {
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

    fn tags_changed(&mut self, id: &str) {
        self.positions.get_mut(id).expect("touched block").tags = true;
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
        if self.capability_sources.is_empty() {
            return Ok(Vec::new());
        }
        let mut ids: Vec<_> = self.capability_sources.drain().collect();
        ids.sort_unstable();
        crate::task_store::capabilities_for(self.tx, &ids)
    }

    fn prepare_tag_rename(
        &self,
        current: &Stored,
        text: &str,
        title_key: &str,
        old_key: &str,
    ) -> Result<Option<TagRename>> {
        let collision: bool = self
            .tx
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM blocks WHERE kind = 'page' AND deletion_id IS NULL
             AND title_key = ?1 AND id != ?2)",
            )?
            .query_row(params![title_key, current.block.id], |row| row.get(0))?;
        if collision {
            return Err(validation(format!("page title already exists: {text}")));
        }
        let mut sources = HashSet::new();
        let mut incoming = self.tx.prepare_cached(
            "SELECT b.id, b.text, m.manual FROM memberships m JOIN blocks b ON b.id = m.block_id
             WHERE m.title_key = ?1 AND b.deletion_id IS NULL ORDER BY m.block_id",
        )?;
        for row in incoming.query_map([old_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })? {
            let (id, source, manual) = row?;
            if manual || tag_names(&source).any(|name| tag_title_matches(name, old_key)) {
                sources.insert(id);
            }
        }
        // Membership derivation is deferred. Include newly inserted or edited
        // sources that already refer to the old live title at this operation.
        for revision in &self.revisions {
            if !self.positions[&revision.id].tags || sources.contains(&revision.id) {
                continue;
            }
            let source: Option<String> = self
                .tx
                .prepare_cached("SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL")?
                .query_row([&revision.id], |row| row.get(0))
                .optional()?;
            if source.is_some_and(|source| {
                tag_names(&source).any(|name| tag_title_matches(name, old_key))
            }) {
                sources.insert(revision.id.clone());
            }
        }
        if sources.is_empty() {
            if self
                .pending_renames
                .iter()
                .any(|rename| rename.page_id == current.block.id)
            {
                validate_tag_title(text)?;
            }
            return Ok(None);
        }
        validate_tag_title(text)?;
        let mut sources: Vec<_> = sources.into_iter().collect();
        sources.sort_unstable();
        Ok(Some(TagRename {
            page_id: current.block.id.clone(),
            title_key: old_key.to_owned(),
            sources,
            op_index: self.op_index,
        }))
    }

    /// Explicit source inverses run before automatic rewriting. For case-only
    /// renames they remain authoritative, even when the guard edit is a no-op.
    fn rewrite_incoming_tags(&mut self) -> Result<()> {
        let operations = self.operations;
        let mut explicitly_edited: Option<HashSet<&str>> = None;
        while !self.pending_renames.is_empty() {
            let mut replacements = Vec::new();
            let mut source_plans: HashMap<String, Vec<usize>> = HashMap::new();
            for rename in std::mem::take(&mut self.pending_renames) {
                let target: Option<(String, bool)> = self
                    .tx
                    .prepare_cached(
                        "SELECT text, title_key = ?2 FROM blocks WHERE id = ?1 AND deletion_id IS NULL",
                    )?
                    .query_row(params![rename.page_id, rename.title_key], |row| Ok((row.get(0)?, row.get(1)?)))
                    .optional()?;
                let Some((title, case_only)) = target else {
                    continue;
                };
                let spelling =
                    tag_spelling(&title).map_err(|error| indexed(error, rename.op_index))?;
                let position = replacements.len();
                replacements.push(TagReplacement {
                    title_key: rename.title_key,
                    title,
                    spelling,
                    case_only,
                    op_index: rename.op_index,
                });
                for id in rename.sources {
                    source_plans.entry(id).or_default().push(position);
                }
            }
            let mut sources: Vec<_> = source_plans.into_iter().collect();
            sources.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            for (id, plans) in sources {
                let Some(current) =
                    stored(self.tx, &id)?.filter(|source| source.deletion_id.is_none())
                else {
                    continue;
                };
                let preserve_spelling = plans.iter().any(|index| replacements[*index].case_only)
                    && explicitly_edited
                        .get_or_insert_with(|| {
                            operations
                                .iter()
                                .filter_map(|operation| match operation {
                                    Operation::EditText { id, .. } => Some(id.as_str()),
                                    _ => None,
                                })
                                .collect()
                        })
                        .contains(id.as_str());
                let manual = self.tx.prepare_cached(
                    "SELECT title_key, title FROM memberships WHERE block_id = ?1 AND manual = 1",
                )?.query_map([&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let manual_rewrites: Vec<_> = manual
                    .iter()
                    .filter_map(|(key, title)| {
                        let replacement = plans.iter().find_map(|index| {
                            let replacement = &replacements[*index];
                            tag_title_matches(title, &replacement.title_key).then_some(replacement)
                        })?;
                        (title != &replacement.title).then_some((key, &replacement.title))
                    })
                    .collect();
                for (key, _) in &manual_rewrites {
                    self.tx.execute(
                        "DELETE FROM memberships WHERE block_id = ?1 AND title_key = ?2 AND manual = 1",
                        params![id, key],
                    )?;
                }
                for (_, title) in &manual_rewrites {
                    self.tx.execute(
                        "INSERT OR IGNORE INTO memberships(block_id, title_key, type_id, manual, title)
                         VALUES (?1, ?2, (SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?2), 1, ?3)",
                        params![id, title.to_lowercase(), title],
                    )?;
                }
                if !manual_rewrites.is_empty() {
                    self.restructured_pages
                        .insert(current.block.page_id.clone());
                }
                let mut matched = false;
                let text = rewrite_tags(&current.block.text, |title| {
                    // The first captured association owns an original token,
                    // even if another page subsequently reuses that old title.
                    let folded = (!title.is_ascii()).then(|| title.to_lowercase());
                    let replacement = plans.iter().find_map(|index| {
                        let replacement = &replacements[*index];
                        let matches = folded.as_ref().map_or_else(
                            || title.eq_ignore_ascii_case(&replacement.title_key),
                            |title_key| title_key == &replacement.title_key,
                        );
                        matches.then_some(replacement)
                    })?;
                    matched = true;
                    (!(preserve_spelling && replacement.case_only))
                        .then_some(replacement.spelling.as_str())
                });
                if text.is_none() && !manual_rewrites.is_empty() {
                    self.bump(&current, true)?;
                }
                if !matched {
                    continue;
                }
                self.op_index = replacements[plans[0]].op_index;
                let (text, revision) = if let Some(text) = text {
                    self.edit(&current, &text)
                        .map_err(|error| indexed(error, self.op_index))?;
                    (text, current.block.revision + 1)
                } else {
                    (
                        current.block.text.clone(),
                        current.block.revision + i64::from(!manual_rewrites.is_empty()),
                    )
                };
                if let Some(position) = self.rewrite_positions.get(&id) {
                    self.text_rewrites[*position].after = text;
                    self.text_rewrites[*position].revision = revision;
                } else {
                    self.rewrite_positions
                        .insert(id.clone(), self.text_rewrites.len());
                    self.text_rewrites.push(TextRewrite {
                        id,
                        before: current.block.text,
                        after: text,
                        revision,
                    });
                }
            }
        }
        Ok(())
    }

    /// Resolve against the final live titles, so an explicitly-created page
    /// later in the batch wins over automatic creation.
    fn derive_tags(&mut self) -> Result<()> {
        let mut position = 0;
        while position < self.revisions.len() {
            let id = &self.revisions[position].id;
            if self.positions[id].tags {
                let text: Option<String> = self
                    .tx
                    .prepare_cached(
                        "SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL",
                    )?
                    .query_row([id], |row| row.get(0))
                    .optional()?;
                if let Some(text) = text {
                    let mut created = derive_memberships(self.tx, id, &text, self.now, true)?;
                    let manual = self.tx.prepare_cached(
                        "SELECT title_key, title FROM memberships WHERE block_id = ?1 AND manual = 1 AND type_id IS NULL",
                    )?.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    for (key, title) in manual {
                        let type_id =
                            resolve_type(self.tx, &title, &key, self.now, true, &mut created)?;
                        self.tx.execute(
                            "UPDATE memberships SET type_id = ?1 WHERE block_id = ?2 AND title_key = ?3 AND manual = 1",
                            params![type_id, id, key],
                        )?;
                    }
                    for revision in created {
                        let title_key = self
                            .tx
                            .prepare_cached("SELECT title_key FROM blocks WHERE id = ?1")?
                            .query_row([&revision.id], |row| row.get(0))?;
                        self.changed_titles.insert(title_key);
                        self.touch(&revision.id, revision.revision);
                        self.tags_changed(&revision.id);
                        self.restructured_pages.insert(revision.id);
                    }
                }
            }
            position += 1;
        }
        Ok(())
    }

    fn reconcile_titles(&self) -> Result<()> {
        let mut update = self.tx.prepare_cached(
            "WITH target AS (
                 SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?1
             )
             UPDATE memberships SET type_id = (SELECT id FROM target)
             WHERE title_key = ?1 AND type_id IS NOT (SELECT id FROM target)",
        )?;
        for title_key in &self.changed_titles {
            update.execute([title_key])?;
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
            Err(validation(format!("block ID is already used: {id}")))
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
        if kind == BlockKind::Block {
            self.card_sources.insert(id.to_owned());
        }
        let (kind, title_key) = match kind {
            BlockKind::Block => ("block", None),
            BlockKind::Page => ("page", Some(text.to_lowercase())),
            BlockKind::Journal => ("journal", None),
        };
        self.tx.prepare_cached(
            "INSERT INTO blocks(id, kind, parent_id, page_id, ordinal, text, title_key, heading, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
        )?.execute(params![id, kind, parent, page, ordinal, text, title_key, heading, self.now])?;
        if let Some(title_key) = title_key {
            self.changed_titles.insert(title_key);
        }
        derive_links(self.tx, id, text)?;
        self.touch(id, 1);
        self.tags_changed(id);
        self.restructured_pages.insert(page.to_owned());
        Ok(())
    }

    fn edit(&mut self, current: &Stored, text: &str) -> Result<()> {
        validate_text(current.block.kind, text)?;
        if current.block.text == text {
            return Ok(());
        }
        let title_key = (current.block.kind == BlockKind::Page).then(|| text.to_lowercase());
        let old_key = title_key
            .as_ref()
            .map(|_| current.block.text.to_lowercase());
        let rename = if let Some(title_key) = title_key.as_deref() {
            self.prepare_tag_rename(
                current,
                text,
                title_key,
                old_key.as_deref().expect("page title"),
            )?
        } else {
            None
        };
        self.tx.prepare_cached(
            "UPDATE blocks SET text = ?1, title_key = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4",
        )?.execute(params![text, title_key, self.now, current.block.id])?;
        if let Some(title_key) = title_key {
            self.changed_titles.insert(title_key);
            self.changed_titles.insert(old_key.expect("page title"));
        }
        derive_links(self.tx, &current.block.id, text)?;
        self.touch(&current.block.id, current.block.revision + 1);
        self.tags_changed(&current.block.id);
        if current.block.kind == BlockKind::Block {
            self.card_sources.insert(current.block.id.clone());
        }
        if let Some(rename) = rename {
            self.pending_renames.push(rename);
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

    fn event(&mut self) -> Result<String> {
        let id = ulid::Ulid::generate().to_string();
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
        if current.block.kind == BlockKind::Page {
            self.changed_titles
                .insert(current.block.text.to_lowercase());
        }
        self.restructured_pages.insert(current.block.page_id);
        let event = self.event()?;
        for (id, revision, deletion) in self.subtree(id)? {
            if deletion.is_none() {
                self.tx.prepare_cached(
                    "UPDATE blocks SET deletion_id = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                )?.execute(params![event, self.now, id])?;
                self.touch(&id, revision + 1);
            }
        }
        Ok(())
    }

    fn restore(&mut self, current: &Stored, event: &str) -> Result<()> {
        validate_id(event)?;
        if current.deletion_id.as_deref() != Some(event) {
            return Err(validation(
                "restore deletion event does not match the block",
            ));
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
                    self.changed_titles.insert(row.block.text.to_lowercase());
                }
                self.touch(&id, revision + 1);
                self.tags_changed(&id);
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
                return Err(validation("a block cannot be placed after itself"));
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
        match operation {
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
                self.tx.execute(
                    "INSERT OR IGNORE INTO memberships(block_id, title_key, type_id, manual, title)
                     VALUES (?1, ?2, (SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?2), 1, ?3)",
                    params![id, title.to_lowercase(), title],
                )?;
                self.bump(&current, true)?;
                self.tags_changed(id);
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
                let removed = self.tx.execute(
                    "DELETE FROM memberships WHERE block_id = ?1 AND title_key = ?2 AND manual = 1",
                    params![id, title.to_lowercase()],
                )?;
                if removed == 0 {
                    return Err(validation("type has no manual membership"));
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
                self.tx.execute("INSERT INTO fields(block_id, kind) VALUES (?1, ?2) ON CONFLICT(block_id) DO UPDATE SET kind = excluded.kind",
                    params![id, kind.as_str()])?;
                self.bump(&current, true)
            }
            Operation::SetTypeFields {
                type_id,
                base_revision,
                fields,
            } => {
                let current = self.checked(type_id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("type must be a page"));
                }
                let mut unique = HashSet::new();
                for field in fields {
                    crate::fields::require_definition(self.tx, field)?;
                    if !unique.insert(field) {
                        return Err(validation("duplicate field in type template"));
                    }
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
                crate::query::validate_query(self.tx, query)?;
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
                if crate::library_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            Operation::SetCitationTriage {
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
                if crate::task_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
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
            | Operation::ResetCard { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. } => {
                // A preceding text edit must invalidate stale shown definitions
                // before a grade or reset checks the card's own revision.
                if matches!(
                    operation,
                    Operation::GradeCard { .. } | Operation::ResetCard { .. }
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
