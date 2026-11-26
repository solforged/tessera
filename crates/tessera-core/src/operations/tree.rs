use super::*;

pub(super) const GAP: i64 = 1024;

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

pub(super) struct NewBlock<'a> {
    pub(super) id: &'a str,
    pub(super) kind: BlockKind,
    pub(super) parent: Option<&'a str>,
    pub(super) page: &'a str,
    pub(super) ordinal: i64,
    pub(super) text: &'a str,
    pub(super) heading: Option<u8>,
}

impl Engine<'_, '_> {
    pub(super) fn live(&self, id: &str) -> Result<Stored> {
        validate_id(id)?;
        stored(self.tx, id)?
            .filter(|block| block.deletion_id.is_none())
            .ok_or_else(|| not_found(id))
    }

    pub(super) fn checked(
        &self,
        id: &str,
        expected: i64,
        index: usize,
        deleted: bool,
    ) -> Result<Stored> {
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

    pub(super) fn unused(&self, id: &str) -> Result<()> {
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

    pub(super) fn heading(heading: Option<u8>) -> Result<()> {
        if heading.is_some_and(|level| !(1..=3).contains(&level)) {
            Err(validation("heading must be between 1 and 3"))
        } else {
            Ok(())
        }
    }

    pub(super) fn create(&mut self, block: NewBlock<'_>) -> Result<()> {
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

    pub(super) fn edit(&mut self, current: &Stored, text: &str) -> Result<()> {
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

    pub(super) fn subtree(&self, id: &str) -> Result<Vec<(String, i64, Option<String>)>> {
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
    pub(super) fn event(&mut self, block: &str) -> Result<String> {
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

    pub(super) fn delete(&mut self, id: &str) -> Result<()> {
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

    pub(super) fn would_cycle(&self, id: &str, parent: &str) -> Result<bool> {
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
    pub(super) fn reanchor(
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
    pub(super) fn ordinal(
        &self,
        parent: &str,
        after: Option<&str>,
        excluded: Option<&str>,
    ) -> Result<i64> {
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

    pub(super) fn move_block(
        &mut self,
        current: &Stored,
        parent_id: &str,
        after: Option<&str>,
    ) -> Result<()> {
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

    pub(super) fn built_in_task_definition(&self, id: &str) -> Result<bool> {
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

    pub(super) fn bump(&mut self, current: &Stored, derive_fields: bool) -> Result<()> {
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
}
