//! Session-free topic derivation for `wasm32-unknown-unknown`, where SQLite's
//! session extension is unavailable. Snapshots derived rows before a commit
//! and compares them afterwards so plain outline typing emits `[]` rather than
//! invalidating every workshop-wide list.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension};

use super::{BlockChange, TABLES, Topic, classify};
use crate::{Batch, Operation, Result};

type BlockSnapshot = (Option<String>, String, String, String, i64, Option<String>);

struct DerivedSnapshot {
    blocks: BTreeMap<String, BlockSnapshot>,
    root_ids: BTreeSet<String>,
    links: Vec<(String, i64, String)>,
    memberships: Vec<(String, String, i64, String)>,
    field_values: Vec<(String, String, String, String, i64)>,
    cards: Vec<(String, String, String, i64, String, String)>,
}

impl DerivedSnapshot {
    fn capture(conn: &Connection, touched: &BTreeSet<String>) -> Result<Self> {
        let mut blocks = BTreeMap::new();
        if !touched.is_empty() {
            let mut stmt = conn.prepare_cached(
                "SELECT parent_id, page_id, kind, text, archived, deletion_id
                 FROM blocks WHERE id = ?1",
            )?;
            for id in touched {
                if let Some(row) = stmt
                    .query_row([id], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                        ))
                    })
                    .optional()?
                {
                    blocks.insert(id.clone(), row);
                }
            }
        }
        let root_ids = conn
            .prepare_cached("SELECT id FROM blocks WHERE parent_id IS NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let links = conn
            .prepare_cached(
                "SELECT source_id, occurrence, target_id FROM links ORDER BY source_id, occurrence",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let memberships = conn
            .prepare_cached(
                "SELECT block_id, type_id, manual, title FROM memberships
                 ORDER BY block_id, type_id, manual",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let field_values = conn
            .prepare_cached(
                "SELECT owner_id, field_id, entry_id, value_id, ordinal FROM field_values
                 ORDER BY owner_id, field_id, entry_id, value_id",
            )?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let cards = conn
            .prepare_cached(
                "SELECT id, source_block_id, key, active, front, back FROM card_units ORDER BY id",
            )?
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            blocks,
            root_ids,
            links,
            memberships,
            field_values,
            cards,
        })
    }
}

pub(crate) struct Watch {
    before: DerivedSnapshot,
    touched: BTreeSet<String>,
    direct: BTreeSet<Topic>,
}

fn add_table(topics: &mut BTreeSet<Topic>, name: &str) {
    if let Some((_, affected)) = TABLES.iter().find(|(table, _)| *table == name) {
        topics.extend(affected.iter().copied());
    }
}

pub(crate) fn watch(conn: &Connection, batch: &Batch) -> Result<Watch> {
    let mut touched = BTreeSet::new();
    let mut direct = BTreeSet::new();
    for op in &batch.operations {
        match op {
            Operation::SettleSyncCopy { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "sync_conflicts");
            }
            Operation::SettleSyncRejection { .. } => add_table(&mut direct, "sync_conflicts"),
            Operation::SetSource { id, .. } | Operation::AttachSnapshot { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "sources");
                add_table(&mut direct, "source_snapshots");
            }
            Operation::Cite { id, .. }
            | Operation::Uncite { id, .. }
            | Operation::SetCitationTriage { id, .. }
            | Operation::SetCitationColor { id, .. }
            | Operation::SetCitationRange { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "citations");
            }
            Operation::CreatePage { id, .. }
            | Operation::CreateJournal { id, .. }
            | Operation::Insert { id, .. }
            | Operation::EditText { id, .. }
            | Operation::SetHeading { id, .. }
            | Operation::Move { id, .. }
            | Operation::Delete { id, .. }
            | Operation::Restore { id, .. }
            | Operation::SetArchived { id, .. }
            | Operation::AddType { id, .. }
            | Operation::RemoveType { id, .. }
            | Operation::SetQuote { id, .. }
            | Operation::SetImage { id, .. }
            | Operation::SetOcclusion { id, .. } => {
                touched.insert(id.clone());
            }
            Operation::Split { id, new_id, .. } => {
                touched.insert(id.clone());
                touched.insert(new_id.clone());
            }
            Operation::Merge {
                source_id,
                destination_id,
                ..
            } => {
                touched.insert(source_id.clone());
                touched.insert(destination_id.clone());
                add_table(&mut direct, "deletion_events");
            }
            Operation::MergePage {
                source_id,
                destination_id,
                ..
            } => {
                touched.insert(source_id.clone());
                touched.insert(destination_id.clone());
                add_table(&mut direct, "id_aliases");
                add_table(&mut direct, "deletion_events");
            }
            Operation::CreateCardTemplate { .. }
            | Operation::UpdateCardTemplate { .. }
            | Operation::SetCardTemplateApplied { .. }
            | Operation::DeleteCardTemplate { .. } => {
                add_table(&mut direct, "card_templates");
            }
            Operation::TransferCardKey { .. }
            | Operation::GradeCard { .. }
            | Operation::UndoGrade { .. }
            | Operation::SetCardHeld { .. }
            | Operation::ResetCard { .. } => {
                add_table(&mut direct, "card_units");
            }
            Operation::StartReviewSession { .. } | Operation::FinishReviewSession { .. } => {
                add_table(&mut direct, "review_sessions");
            }
            Operation::SaveDeck { .. } | Operation::DeleteDeck { .. } => {
                add_table(&mut direct, "decks");
            }
            Operation::SetFieldKind { id, .. }
            | Operation::SetFieldHide { id, .. }
            | Operation::SetFieldRole { id, .. }
            | Operation::SetFieldCountsAs { id, .. }
            | Operation::SetFieldTargets { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "fields");
                add_table(&mut direct, "field_targets");
            }
            Operation::SetTypeFields { type_id, .. } => {
                touched.insert(type_id.clone());
                add_table(&mut direct, "type_fields");
            }
            Operation::SetTypePresentation { type_id, .. } => {
                touched.insert(type_id.clone());
                add_table(&mut direct, "type_presentation");
            }
            Operation::SetSubjectCriteria { subject_id, .. } => {
                touched.insert(subject_id.clone());
                add_table(&mut direct, "subject_criteria");
            }
            Operation::SaveView { .. } | Operation::DeleteView { .. } => {
                add_table(&mut direct, "views");
            }
            Operation::SetSetting { .. } => {}
            Operation::SetTask { id, .. }
            | Operation::RestoreTaskState { id, .. }
            | Operation::CompleteTask { id, .. }
            | Operation::ReverseTaskCompletion { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "tasks");
                add_table(&mut direct, "task_occurrences");
            }
            Operation::SetProject { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "projects");
            }
            Operation::SetPosition { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "positions");
            }
            Operation::SetRelation { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "relations");
            }
            Operation::SetSpread { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "spreads");
            }
            Operation::Revisit { id, .. } | Operation::RestoreRevisit { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "note_states");
                add_table(&mut direct, "revisit_events");
            }
            Operation::SetQuestion { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "questions");
            }
            Operation::SetAssessment { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "assessments");
            }
            Operation::StartWork { id, .. }
            | Operation::StopWork { id, .. }
            | Operation::EditWorkNote { id, .. }
            | Operation::SetWorkSessionState { id, .. } => {
                touched.insert(id.clone());
                add_table(&mut direct, "work_sessions");
            }
            Operation::SaveTaskView { .. } | Operation::DeleteTaskView { .. } => {
                add_table(&mut direct, "task_views");
            }
            Operation::SaveLibraryView { .. } | Operation::DeleteLibraryView { .. } => {
                add_table(&mut direct, "library_views");
            }
        }
    }
    let before = DerivedSnapshot::capture(conn, &touched)?;
    Ok(Watch {
        before,
        touched,
        direct,
    })
}

impl Watch {
    pub(crate) fn finish(self, conn: &Connection, synced: bool) -> Result<Vec<Topic>> {
        let mut topics = self.direct;
        if synced {
            topics.insert(Topic::Sync);
        }
        let after = DerivedSnapshot::capture(conn, &self.touched)?;
        if after.links != self.before.links {
            add_table(&mut topics, "links");
        }
        if after.memberships != self.before.memberships {
            add_table(&mut topics, "memberships");
        }
        if after.field_values != self.before.field_values {
            add_table(&mut topics, "field_values");
        }
        if after.cards != self.before.cards {
            add_table(&mut topics, "card_units");
        }
        // Provisional pages created or pruned by tag edits change `root_ids`.
        if after.root_ids != self.before.root_ids {
            add_table(&mut topics, "provisional_pages");
        }
        let mut blocks = Vec::new();
        for root_id in after.root_ids.symmetric_difference(&self.before.root_ids) {
            if !self.touched.contains(root_id) {
                blocks.push(BlockChange {
                    id: root_id.clone(),
                    root: Some(true),
                    page_id: Some(root_id.clone()),
                    whole: true,
                    text: true,
                    archived: false,
                    deleted: !after.root_ids.contains(root_id),
                    moved: true,
                });
            }
        }
        for id in &self.touched {
            match (self.before.blocks.get(id), after.blocks.get(id)) {
                (None, Some((parent, page, _, _, _, deletion))) => {
                    blocks.push(BlockChange {
                        id: id.clone(),
                        root: Some(parent.is_none()),
                        page_id: Some(page.clone()),
                        whole: true,
                        text: true,
                        archived: false,
                        deleted: deletion.is_some(),
                        moved: true,
                    });
                }
                (Some((parent, page, _, _, _, _)), None) => {
                    blocks.push(BlockChange {
                        id: id.clone(),
                        root: Some(parent.is_none()),
                        page_id: Some(page.clone()),
                        whole: true,
                        text: true,
                        archived: false,
                        deleted: true,
                        moved: true,
                    });
                }
                (Some(old), Some(new)) if old != new => {
                    let deleted = old.5 != new.5;
                    if deleted {
                        add_table(&mut topics, "deletion_events");
                    }
                    blocks.push(BlockChange {
                        id: id.clone(),
                        root: Some(new.0.is_none()),
                        page_id: Some(new.1.clone()),
                        whole: false,
                        text: old.2 != new.2 || old.3 != new.3,
                        archived: old.4 != new.4,
                        deleted,
                        moved: old.0 != new.0 || old.1 != new.1,
                    });
                }
                _ => {}
            }
        }
        if !blocks.is_empty() {
            classify(conn, &blocks, &mut topics)?;
        }
        Ok(topics.into_iter().collect())
    }
}
