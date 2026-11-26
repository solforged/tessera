use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{Operation, Result};

use super::{is_definition, reference};

/// Whether this operation can change a source's Pages value, so commit rechecks it.
pub(crate) fn validates_source_page_counts(operation: &Operation) -> bool {
    match operation {
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
        | Operation::SetSource { .. } => true,
        // These writes do not change a source's Pages value.
        Operation::SettleSyncCopy { .. }
        | Operation::SettleSyncRejection { .. }
        | Operation::AttachSnapshot { .. }
        | Operation::Cite { .. }
        | Operation::Uncite { .. }
        | Operation::SetCitationTriage { .. }
        | Operation::SetCitationColor { .. }
        | Operation::SetCitationRange { .. }
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
        | Operation::GradeCard { .. }
        | Operation::UndoGrade { .. }
        | Operation::SetCardHeld { .. }
        | Operation::ResetCard { .. }
        | Operation::SaveDeck { .. }
        | Operation::DeleteDeck { .. }
        | Operation::SaveTaskView { .. }
        | Operation::DeleteTaskView { .. }
        | Operation::SaveLibraryView { .. }
        | Operation::DeleteLibraryView { .. } => false,
    }
}

/// Invalid bibliographic counts touched by a command. Retaining the original
/// tuples lets unrelated edits preserve legacy data while rejecting new errors.
pub(crate) fn invalid_source_page_counts(
    conn: &Connection,
    operations: &str,
) -> Result<HashSet<(String, String, String, String)>> {
    let mut statement = conn.prepare_cached(
        "WITH changed(id) AS MATERIALIZED (
           SELECT item.value FROM json_each(?1) operation, json_each(operation.value) item
           WHERE item.key IN ('id', 'source_id', 'destination_id', 'parent_id') AND item.type = 'text'
         ), candidates(id) AS (
           SELECT value_id FROM field_values WHERE value_id IN changed
           UNION SELECT value_id FROM field_values WHERE entry_id IN changed
           UNION SELECT value_id FROM field_values WHERE field_id IN changed
           UNION SELECT value_id FROM field_values WHERE owner_id IN changed
           UNION SELECT value_id FROM field_values WHERE field_id IN (
             SELECT id FROM blocks WHERE parent_id IN changed
           )
         )
         SELECT f.owner_id, f.field_id, v.id, v.text
         FROM candidates c JOIN field_values f ON f.value_id = c.id
         JOIN sources s ON s.block_id = f.owner_id
         JOIN blocks d ON d.id = f.field_id JOIN blocks v ON v.id = f.value_id
         WHERE lower(trim(d.text)) = 'pages'",
    )?;
    let mut rows = statement.query([operations])?;
    let mut invalid = HashSet::new();
    while let Some(row) = rows.next()? {
        let text = row.get_ref(3)?.as_str().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        let value = text.trim();
        if !value.is_empty()
            && (!value.bytes().all(|byte| byte.is_ascii_digit())
                || !value
                    .parse::<u64>()
                    .is_ok_and(|count| (1..=9_007_199_254_740_991).contains(&count)))
        {
            invalid.insert((row.get(0)?, row.get(1)?, row.get(2)?, text.to_owned()));
        }
    }
    Ok(invalid)
}

/// Retain old and new ancestry and incoming entries when definitions move or
/// stop being definitions. Work per text edit is local, not a page rebuild:
/// a block's siblings are never rescanned, so editing one row of a large
/// page derives only that row and the entry it may be a value of.
#[derive(Default)]
pub(crate) struct FieldChanges {
    owners: HashSet<String>,
    entries: HashSet<String>,
    template_owners: HashSet<String>,
}
impl FieldChanges {
    pub(crate) fn capture(&mut self, conn: &Connection, id: &str) -> Result<()> {
        let mut statement = conn.prepare_cached(
            "SELECT ?1 UNION SELECT parent_id FROM blocks WHERE id = ?1 AND parent_id IS NOT NULL
             UNION SELECT l.source_id FROM links l WHERE l.target_id = ?1
             UNION SELECT l.source_id FROM blocks p JOIN blocks d ON d.parent_id = p.id
               JOIN links l ON l.target_id = d.id
               WHERE p.id = ?1 AND p.kind = 'page' AND p.title_key = 'fields'",
        )?;
        for row in statement.query_map([id], |row| row.get::<_, String>(0))? {
            self.entries.insert(row?);
        }
        self.owners.insert(id.to_owned());
        let mut owners = conn.prepare_cached(
            "SELECT owner_id FROM field_values WHERE value_id = ?1 OR entry_id = ?1 OR field_id = ?1
             UNION SELECT e.parent_id FROM blocks v JOIN blocks e ON e.id = v.parent_id WHERE v.id = ?1 AND e.parent_id IS NOT NULL
             UNION SELECT f.owner_id FROM links l JOIN field_values f ON f.value_id = l.source_id WHERE l.target_id = ?1
             UNION SELECT v.parent_id FROM links l JOIN blocks v ON v.id = l.source_id WHERE l.target_id = ?1 AND v.parent_id IS NOT NULL",
        )?;
        for owner in owners.query_map([id], |row| row.get::<_, String>(0))? {
            self.template_owners.insert(owner?);
        }
        Ok(())
    }
    pub(crate) fn before(&mut self, conn: &Connection, op: &Operation) -> Result<()> {
        match op {
            Operation::Merge {
                source_id,
                destination_id,
                ..
            }
            | Operation::MergePage {
                source_id,
                destination_id,
                ..
            } => {
                self.capture(conn, source_id)?;
                self.capture(conn, destination_id)
            }
            Operation::Move { id, .. } => self.capture(conn, id),
            Operation::CreatePage { id, .. }
            | Operation::CreateJournal { id, .. }
            | Operation::Insert { id, .. }
            | Operation::EditText { id, .. }
            | Operation::SetHeading { id, .. }
            | Operation::Split { id, .. }
            | Operation::Delete { id, .. }
            | Operation::Restore { id, .. }
            | Operation::SetArchived { id, .. }
            | Operation::SetFieldKind { id, .. }
            | Operation::SetFieldHide { id, .. }
            | Operation::SetFieldRole { id, .. }
            | Operation::SetFieldCountsAs { id, .. }
            | Operation::SetFieldTargets { id, .. } => self.capture(conn, id),
            Operation::SetTypeFields { .. }
            | Operation::SetTypePresentation { .. }
            | Operation::SetSubjectCriteria { .. }
            | Operation::CreateCardTemplate { .. }
            | Operation::UpdateCardTemplate { .. }
            | Operation::SetCardTemplateApplied { .. }
            | Operation::DeleteCardTemplate { .. }
            | Operation::TransferCardKey { .. }
            | Operation::SettleSyncCopy { .. }
            | Operation::SettleSyncRejection { .. }
            | Operation::AddType { .. }
            | Operation::RemoveType { .. }
            | Operation::SaveView { .. }
            | Operation::SetSetting { .. }
            | Operation::SetSource { .. }
            | Operation::AttachSnapshot { .. }
            | Operation::Cite { .. }
            | Operation::Uncite { .. }
            | Operation::SetCitationTriage { .. }
            | Operation::SetCitationColor { .. }
            | Operation::SetCitationRange { .. }
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
            | Operation::SetQuestion { .. }
            | Operation::SetQuote { .. }
            | Operation::SetImage { .. }
            | Operation::SetOcclusion { .. }
            | Operation::SetAssessment { .. }
            | Operation::StartWork { .. }
            | Operation::StopWork { .. }
            | Operation::EditWorkNote { .. }
            | Operation::SetWorkSessionState { .. }
            | Operation::StartReviewSession { .. }
            | Operation::FinishReviewSession { .. }
            | Operation::GradeCard { .. }
            | Operation::UndoGrade { .. }
            | Operation::ResetCard { .. }
            | Operation::SetCardHeld { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. }
            | Operation::SaveTaskView { .. }
            | Operation::DeleteTaskView { .. }
            | Operation::SaveLibraryView { .. }
            | Operation::DeleteLibraryView { .. }
            | Operation::DeleteView { .. } => Ok(()),
        }
    }
    pub(crate) fn derive(&self, conn: &Connection) -> Result<Vec<String>> {
        for owner in &self.owners {
            derive_owner(conn, owner)?;
        }
        for entry in &self.entries {
            derive_entry(conn, entry)?;
        }
        let mut owners = self
            .owners
            .union(&self.template_owners)
            .cloned()
            .collect::<HashSet<_>>();
        let entries = serde_json::to_string(&self.entries).expect("entry IDs serialize");
        let mut statement = conn.prepare_cached(
            "SELECT DISTINCT parent_id FROM blocks WHERE id IN (SELECT value FROM json_each(?1)) AND parent_id IS NOT NULL",
        )?;
        for owner in statement.query_map([entries], |row| row.get::<_, String>(0))? {
            owners.insert(owner?);
        }
        Ok(owners.into_iter().collect())
    }
}

fn derive_owner(conn: &Connection, owner: &str) -> Result<()> {
    // Entries moved under this owner may still have rows under their old
    // owner; owners derive in no fixed order, so clear by entry too.
    conn.prepare_cached(
        "DELETE FROM field_values WHERE owner_id = ?1
         OR entry_id IN (SELECT id FROM blocks WHERE parent_id = ?1)",
    )?
    .execute([owner])?;
    let mut entries = conn.prepare_cached(
        "SELECT e.id, e.text FROM blocks e JOIN blocks o ON o.id = e.parent_id
         WHERE o.id = ?1 AND o.deletion_id IS NULL AND o.archived = 0
         AND e.deletion_id IS NULL AND e.archived = 0",
    )?;
    for row in entries.query_map([owner], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (entry, text) = row?;
        insert_values(conn, owner, &entry, &text)?;
    }
    Ok(())
}

/// Rederive one entry under its current owner, dropping rows it left behind
/// under a previous owner.
fn derive_entry(conn: &Connection, entry: &str) -> Result<()> {
    conn.prepare_cached("DELETE FROM field_values WHERE entry_id = ?1")?
        .execute([entry])?;
    let row = conn
        .prepare_cached(
            "SELECT o.id, e.text FROM blocks e JOIN blocks o ON o.id = e.parent_id
             WHERE e.id = ?1 AND o.deletion_id IS NULL AND o.archived = 0
             AND e.deletion_id IS NULL AND e.archived = 0",
        )?
        .query_row([entry], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .optional()?;
    if let Some((owner, text)) = row {
        insert_values(conn, &owner, entry, &text)?;
    }
    Ok(())
}

fn insert_values(conn: &Connection, owner: &str, entry: &str, text: &str) -> Result<()> {
    if let Some(field) = reference(text)
        && is_definition(conn, field)?
    {
        conn.prepare_cached(
            "INSERT INTO field_values(owner_id, field_id, entry_id, value_id, ordinal)
             SELECT ?1, ?2, ?3, id, ordinal FROM blocks
             WHERE parent_id = ?3 AND deletion_id IS NULL AND archived = 0",
        )?
        .execute(params![owner, field, entry])?;
    }
    Ok(())
}

pub(crate) fn rebuild(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM field_values", [])?;
    let mut statement = conn.prepare(
        "SELECT DISTINCT parent_id FROM blocks WHERE parent_id IS NOT NULL AND deletion_id IS NULL",
    )?;
    for owner in statement.query_map([], |row| row.get::<_, String>(0))? {
        derive_owner(conn, &owner?)?;
    }
    Ok(())
}
