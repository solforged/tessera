use super::*;

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

impl Engine<'_, '_> {
    pub(super) fn touch(&mut self, id: &str, revision: i64) {
        self.card_sources.insert(id.to_owned());
        self.record_revision(id, revision);
        self.positions.get_mut(id).expect("touched block").fields = true;
    }

    pub(super) fn record_revision(&mut self, id: &str, revision: i64) {
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

    pub(super) fn tags_changed(&mut self, id: &str) -> Result<()> {
        if !self.capability_memberships.contains_key(id) {
            self.capability_memberships
                .insert(id.to_owned(), capability_memberships(self.tx, id)?);
        }
        self.positions.get_mut(id).expect("touched block").tags = true;
        Ok(())
    }

    pub(super) fn remove_capability_tag(&mut self, id: &str, key: &str) -> Result<bool> {
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

    pub(super) fn derive_cards(&mut self) -> Result<()> {
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

    pub(super) fn derive_templates(&mut self, mut owners: Vec<String>) -> Result<()> {
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

    pub(super) fn capabilities(&mut self) -> Result<Vec<BlockCapabilities>> {
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
        crate::capabilities::capabilities_for(self.tx, &ids)
    }

    pub(super) fn record_text_rewrite(
        &mut self,
        id: &str,
        before: String,
        after: String,
        revision: i64,
    ) {
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
    pub(super) fn derive_tags(&mut self) -> Result<()> {
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
    pub(super) fn assign_citation_keys(&mut self) -> Result<()> {
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
    pub(super) fn settle_built_in_definitions(&mut self) -> Result<Vec<String>> {
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
            for option in crate::built_in::starting_options(field, &id) {
                let ordinal = self.ordinal(&id, after.as_deref(), None)?;
                self.create(NewBlock {
                    id: &option.id,
                    kind: BlockKind::Block,
                    parent: Some(&id),
                    page: &current.block.page_id,
                    ordinal,
                    text: &option.text,
                    heading: None,
                })?;
                seeded.push(option.id.clone());
                after = Some(option.id);
            }
        }
        Ok(seeded)
    }

    pub(super) fn cleanup_provisional_pages(&mut self) -> Result<()> {
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

    pub(super) fn reconcile_tags(&mut self) -> Result<()> {
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
}
