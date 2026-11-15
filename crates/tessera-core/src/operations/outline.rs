//! Pages, blocks, splits, merges and tag membership.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};

use super::{Engine, GAP, NewBlock};
use crate::notebook::derived_id;
use crate::storage::{
    Stored, resolve_type, rewrite_links, rewrite_tags, stored, tag_text, validate_id,
    validate_tag_title, validate_text, validation,
};
use crate::{BlockKind, Error, Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_create_page(&mut self, operation: &Operation, _index: usize) -> Result<()> {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_create_journal(
        &mut self,
        operation: &Operation,
        _index: usize,
    ) -> Result<()> {
        match operation {
            Operation::CreateJournal { id, date } => self.create(NewBlock {
                id,
                kind: BlockKind::Journal,
                parent: None,
                page: id,
                ordinal: GAP,
                text: date,
                heading: None,
            }),
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_insert(&mut self, operation: &Operation, _index: usize) -> Result<()> {
        match operation {
            Operation::Insert {
                id,
                parent_id,
                after,
                text,
                heading,
            } => {
                self.unused(id)?;
                let parent = self.live(parent_id)?;
                let after = self.reanchor(&parent, after.as_deref(), None)?;
                let ordinal = self.ordinal(parent_id, after.as_deref(), None)?;
                self.create(NewBlock {
                    id,
                    kind: BlockKind::Block,
                    parent: Some(parent_id),
                    page: &parent.block.page_id,
                    ordinal,
                    text,
                    heading: *heading,
                })?;
                if parent.block.kind == BlockKind::Page
                    && crate::built_in::field_named(text).is_some()
                {
                    self.new_definitions.insert(id.clone(), false);
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_edit_text(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_heading(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_archived(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_add_type(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_remove_type(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_split(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_move(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::Move {
                id,
                base_revision,
                parent_id,
                after,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                self.move_block(&current, parent_id, after.as_deref())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_merge(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_merge_page(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
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
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_delete(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::Delete { id, base_revision } => {
                self.checked(id, *base_revision, index, false)?;
                self.delete(id)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_restore(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::Restore {
                id,
                deletion_id,
                revision,
            } => {
                let current = self.checked(id, *revision, index, true)?;
                self.restore(&current, deletion_id)
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    fn restore(&mut self, current: &Stored, event: &str) -> Result<()> {
        validate_id(event)?;
        if current.deletion_id.as_deref() != Some(event) {
            return Err(validation("restore deletion event does not match the atom"));
        }
        if let Some(parent) = &current.block.parent_id {
            self.live(parent)?;
        } else {
            self.root_untaken(current, event)?;
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

    /// A deleted page or journal comes back only while no live root has
    /// taken its title or date. Name the change that did, so the caller
    /// knows what to undo first.
    fn root_untaken(&self, current: &Stored, event: &str) -> Result<()> {
        let Some((other, title)) = self
            .tx
            .prepare_cached(
                "SELECT o.id, o.text FROM blocks r JOIN blocks o
                     ON o.kind = r.kind AND o.id <> r.id AND o.deletion_id IS NULL
                     AND CASE r.kind WHEN 'journal' THEN o.text = r.text
                         ELSE o.title_key = r.title_key END
                 WHERE r.id = ?1",
            )?
            .query_row([&current.block.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .optional()?
        else {
            return Ok(());
        };
        let created: Option<i64> = self
            .tx
            .prepare_cached("SELECT MIN(change_seq) FROM change_revisions WHERE block_id = ?1")?
            .query_row([&other], |row| row.get(0))?;
        let deleted: Option<i64> = self
            .tx
            .prepare_cached("SELECT change_seq FROM deletion_events WHERE id = ?1")?
            .query_row([event], |row| row.get(0))
            .optional()?;
        let later = created.filter(|created| deleted.is_none_or(|deleted| *created > deleted));
        Err(validation(
            match (current.block.kind == BlockKind::Journal, later) {
                (true, Some(seq)) => format!(
                    "journal {title} was created again by change {seq}; undo change {seq} or delete that journal first"
                ),
                (true, None) => {
                    format!("journal {title} exists again; delete that journal first")
                }
                (false, Some(seq)) => format!(
                    "change {seq} created another atom titled \"{title}\"; undo change {seq}, or rename or delete that atom first"
                ),
                (false, None) => format!(
                    "another atom is now titled \"{title}\"; rename or delete that atom first"
                ),
            },
        ))
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
}
