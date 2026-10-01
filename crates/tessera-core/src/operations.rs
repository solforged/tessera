use std::collections::HashMap;
use std::fmt::Write;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::notebook::now_ms;
use crate::storage::{
    Stored, derive_links, not_found, stored, validate_id, validate_text, validation,
};
use crate::{Batch, BlockKind, Committed, Error, Notebook, Operation, Result, Revision};

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
        let mut engine = Engine {
            tx: &tx,
            now,
            seq,
            revisions: Vec::new(),
            positions: HashMap::new(),
            deletions: Vec::new(),
        };
        for (index, operation) in batch.operations.iter().enumerate() {
            engine
                .operation(operation, index)
                .map_err(|error| indexed(error, index))?;
        }
        let committed = Committed {
            seq,
            revisions: engine.revisions,
            deletions: engine.deletions,
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
            "UPDATE changes SET committed = ?1 WHERE seq = ?2",
            params![
                serde_json::to_string(&committed).expect("result serializes"),
                seq
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
    positions: HashMap<String, usize>,
    deletions: Vec<String>,
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
        if let Some(position) = self.positions.get(id) {
            self.revisions[*position].revision = revision;
        } else {
            self.positions.insert(id.to_owned(), self.revisions.len());
            self.revisions.push(Revision {
                id: id.to_owned(),
                revision,
            });
        }
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
        let (kind, title_key) = match kind {
            BlockKind::Block => ("block", None),
            BlockKind::Page => ("page", Some(text.to_lowercase())),
            BlockKind::Journal => ("journal", None),
        };
        self.tx.prepare_cached(
            "INSERT INTO blocks(id, kind, parent_id, page_id, ordinal, text, title_key, heading, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
        )?.execute(params![id, kind, parent, page, ordinal, text, title_key, heading, self.now])?;
        derive_links(self.tx, id, text)?;
        self.touch(id, 1);
        Ok(())
    }

    fn edit(&mut self, current: &Stored, text: &str) -> Result<()> {
        validate_text(current.block.kind, text)?;
        if current.block.text == text {
            return Ok(());
        }
        let title_key = (current.block.kind == BlockKind::Page).then(|| text.to_lowercase());
        self.tx.prepare_cached(
            "UPDATE blocks SET text = ?1, title_key = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4",
        )?.execute(params![text, title_key, self.now, current.block.id])?;
        derive_links(self.tx, &current.block.id, text)?;
        self.touch(&current.block.id, current.block.revision + 1);
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
                self.touch(&id, revision + 1);
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
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
             AND (?2 IS NULL OR id != ?2) ORDER BY ordinal, id",
            )?
            .query_map(params![parent, excluded], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Rebalancing preserves logical order and does not invalidate sibling revisions.
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
        let ordinal = self.ordinal(parent_id, after, Some(&current.block.id))?;
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
        self.delete(&source.block.id)
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
                    self.tx.execute("UPDATE blocks SET archived = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                        params![archived, self.now, id])?;
                    self.touch(id, current.block.revision + 1);
                }
                Ok(())
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
        }
    }
}
