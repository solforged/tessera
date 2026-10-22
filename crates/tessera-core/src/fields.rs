use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::model::{
    FieldChoiceCandidate, FieldChoiceValue, FieldDetail, FieldInterpretation, FieldOptionUse,
    FieldOwner, FieldOwnerValues, FieldSummary, FieldTemplate, FieldType, FieldValue,
    FieldValueUse, IncomingFieldValue,
};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, validate_date, validate_id, validation};
use crate::{
    Block, BlockKind, CountsAs, FieldDefinition, FieldHide, FieldKind, FieldOption, FieldRole,
    FieldsView, Notebook, Operation, Reading, ReadingValue, Result,
};

pub(crate) fn ensure_page(conn: &Connection) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM blocks WHERE kind = 'page' AND title_key = 'fields' AND deletion_id IS NULL)",
        [], |row| row.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let id = crate::notebook::new_ulid().to_string();
    conn.execute(
        "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
         VALUES (?1, 'page', ?1, 1024, 'Fields', 'fields', 1, ?2, ?2)",
        params![id, crate::notebook::now_ms()],
    )?;
    Ok(())
}

pub(crate) fn page_id(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.prepare_cached("SELECT id FROM blocks WHERE kind = 'page' AND title_key = 'fields' AND deletion_id IS NULL")?
        .query_row([], |row| row.get(0)).optional()?)
}

pub(crate) fn is_definition(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT d.text FROM blocks d JOIN blocks p ON p.id = d.parent_id
         WHERE d.id = ?1 AND d.deletion_id IS NULL
         AND p.kind = 'page' AND p.title_key = 'fields' AND p.deletion_id IS NULL",
        )?
        .query_row([id], |row| {
            row.get_ref(0)?
                .as_str()
                .map(|text| !text.trim().is_empty())
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
        })
        .optional()?
        .unwrap_or(false))
}

pub(crate) fn require_definition(conn: &Connection, id: &str) -> Result<()> {
    if is_definition(conn, id)?
        && !conn.query_row("SELECT archived FROM blocks WHERE id = ?1", [id], |row| {
            row.get::<_, bool>(0)
        })?
    {
        Ok(())
    } else {
        Err(validation(format!("not a live field definition: {id}")))
    }
}

/// Recognize one complete reference, never a tag or an embedded reference.
pub(crate) fn reference(text: &str) -> Option<&str> {
    let inner = text.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.contains("[[") || inner.contains("]]") {
        return None;
    }
    let (id, _, _) = crate::storage::reference_parts(inner);
    validate_id(id).ok()?;
    Some(id)
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

/// The Links to entry for sources, which are a capability rather than a type page; named like their note kind.
pub const SOURCE_TARGET: &str = "source";

/// A relation's Links to entries: [`SOURCE_TARGET`] first when it links to sources, then its type pages.
pub(crate) fn targets(conn: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(conn
        .prepare_cached(
            "SELECT ?2 FROM fields WHERE block_id = ?1 AND links_sources = 1
             UNION ALL SELECT * FROM (SELECT type_id FROM field_targets WHERE field_id = ?1 ORDER BY position)",
        )?
        .query_map(params![id, SOURCE_TARGET], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Replaces a relation's Links to with checked `targets`, [`SOURCE_TARGET`] among them or not.
pub(crate) fn file_targets(conn: &Connection, id: &str, targets: &[String]) -> Result<()> {
    conn.execute(
        "UPDATE fields SET links_sources = ?2 WHERE block_id = ?1",
        params![id, targets.iter().any(|target| target == SOURCE_TARGET)],
    )?;
    conn.execute("DELETE FROM field_targets WHERE field_id = ?1", [id])?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO field_targets(field_id, type_id, position) VALUES (?1, ?2, ?3)",
    )?;
    for (position, target) in targets
        .iter()
        .filter(|target| *target != SOURCE_TARGET)
        .enumerate()
    {
        insert.execute(params![id, target, position as i64])?;
    }
    Ok(())
}

pub(crate) fn definitions(conn: &Connection) -> Result<Vec<FieldDefinition>> {
    definitions_for(conn, None)
}

fn definitions_for(conn: &Connection, id: Option<&str>) -> Result<Vec<FieldDefinition>> {
    let mut statement = conn.prepare_cached(
        "SELECT d.id, d.text, COALESCE(f.kind, 'text'), d.revision, o.id, o.text, COALESCE(f.hide, 'never'), COALESCE(f.role, 'attribute'), d.archived, f.counts_as
         FROM blocks p JOIN blocks d ON d.parent_id = p.id LEFT JOIN fields f ON f.block_id = d.id
         LEFT JOIN blocks o ON o.parent_id = d.id AND o.deletion_id IS NULL AND o.archived = 0
         WHERE p.kind = 'page' AND p.title_key = 'fields' AND p.deletion_id IS NULL
         AND d.deletion_id IS NULL AND (?1 IS NULL OR d.id = ?1)
         ORDER BY d.ordinal, d.id, o.ordinal, o.id",
    )?;
    let mut cursor = statement.query([id])?;
    let mut result: Vec<FieldDefinition> = Vec::new();
    while let Some(row) = cursor.next()? {
        let name = row.get_ref(1)?.as_str().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        if name.trim().is_empty() {
            continue;
        }
        let id: String = row.get(0)?;
        if result.last().is_none_or(|d| d.id != id) {
            let built_in = crate::built_in::field_named(name);
            result.push(FieldDefinition {
                targets: targets(conn, &id)?,
                built_in: built_in.is_some(),
                // A built-in field counts as what the core's schema says; others as they were set.
                counts_as: match built_in {
                    Some(field) => field.counts_as,
                    None => row
                        .get::<_, Option<String>>(9)?
                        .as_deref()
                        .and_then(CountsAs::from_str),
                },
                id,
                name: name.to_owned(),
                kind: FieldKind::from_str(&row.get::<_, String>(2)?).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "unknown field kind",
                        )),
                    )
                })?,
                hide: FieldHide::from_str(&row.get::<_, String>(6)?).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        6,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "unknown field hide setting",
                        )),
                    )
                })?,
                role: FieldRole::from_str(&row.get::<_, String>(7)?).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "unknown field role",
                        )),
                    )
                })?,
                archived: row.get(8)?,
                revision: row.get(3)?,
                options: crate::built_in::task_options(name)
                    .iter()
                    .map(|name| FieldOption {
                        id: (*name).into(),
                        text: (*name).into(),
                    })
                    .collect(),
            });
        }
        if let Some(id) = row.get(4)?
            && crate::built_in::task_options(name).is_empty()
        {
            result
                .last_mut()
                .expect("definition exists")
                .options
                .push(FieldOption {
                    id,
                    text: row.get(5)?,
                });
        }
    }
    Ok(result)
}

impl Notebook {
    pub fn fields(&self) -> Result<FieldsView> {
        let mut fields: Vec<FieldSummary> = definitions(&self.conn)?
            .into_iter()
            .map(|definition| FieldSummary {
                definition,
                owners: 0,
                types: Vec::new(),
            })
            .collect();
        let indices: HashMap<_, _> = fields
            .iter()
            .enumerate()
            .map(|(index, field)| (field.definition.id.clone(), index))
            .collect();
        let mut owners = HashSet::new();
        let mut entries = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT l.target_id, e.text, e.parent_id FROM links l
             JOIN blocks e ON e.id = l.source_id
             JOIN blocks o ON o.id = e.parent_id
             WHERE e.deletion_id IS NULL AND o.deletion_id IS NULL
             AND e.rowid NOT IN (SELECT rowid FROM hidden)"
        ))?;
        let mut cursor = entries.query([])?;
        while let Some(row) = cursor.next()? {
            let field: String = row.get(0)?;
            let Some(&index) = indices.get(&field) else {
                continue;
            };
            let text: String = row.get(1)?;
            if reference(&text) == Some(field.as_str())
                && owners.insert((index, row.get::<_, String>(2)?))
            {
                fields[index].owners += 1;
            }
        }
        // Task-backed fields count their canonical readings, not synthetic child entries.
        let task_counts = self.conn.query_row(
            concat!(
                hidden_blocks!(),
                "SELECT COUNT(json_extract(t.state, '$.status')),
                    COUNT(json_extract(t.state, '$.scheduled')),
                    COUNT(json_extract(t.state, '$.deadline')),
                    COUNT(json_extract(t.state, '$.priority')),
                    COUNT(json_extract(t.state, '$.repeater'))
             FROM tasks t JOIN blocks b ON b.id = t.block_id
             WHERE t.active = 1 AND b.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden)"
            ),
            [],
            |row| {
                Ok([
                    row.get::<_, i64>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ])
            },
        )?;
        for field in &mut fields {
            if let Some(index) = ["status", "scheduled", "deadline", "priority", "repeat"]
                .iter()
                .position(|name| *name == field.definition.name)
            {
                field.owners = task_counts[index] as usize;
            }
        }
        if let Some(index) = fields
            .iter()
            .position(|field| field.definition.name == "project")
        {
            for owner in crate::task_query::project_memberships(&self.conn)?.into_keys() {
                if owners.insert((index, owner)) {
                    fields[index].owners += 1;
                }
            }
        }
        let mut templates = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT f.field_id, b.id, b.text FROM type_fields f
             JOIN blocks b ON b.id = f.type_id
             WHERE b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY b.text COLLATE NOCASE, b.id"
        ))?;
        let mut cursor = templates.query([])?;
        while let Some(row) = cursor.next()? {
            if let Some(&index) = indices.get(&row.get::<_, String>(0)?) {
                fields[index].types.push(FieldType {
                    id: row.get(1)?,
                    name: row.get(2)?,
                });
            }
        }
        Ok(FieldsView {
            page_id: page_id(&self.conn)?.ok_or_else(|| not_found("Fields"))?,
            fields,
        })
    }

    /// Relation field values whose whole text references `target`, so the target can read them back, such as
    /// `← qualifies`. Archived definitions, and values, entries or owners that are hidden, are left out.
    pub fn incoming_field_values(&self, target: &str) -> Result<Vec<IncomingFieldValue>> {
        validate_id(target)?;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT fv.field_id, d.text, o.id, o.text, p.id, p.text, v.id, v.text
             FROM links l
             JOIN field_values fv ON fv.value_id = l.source_id
             JOIN fields f ON f.block_id = fv.field_id AND f.kind = 'instance'
             JOIN blocks d ON d.id = fv.field_id
             JOIN blocks v ON v.id = fv.value_id
             JOIN blocks o ON o.id = fv.owner_id
             JOIN blocks p ON p.id = o.page_id
             WHERE l.target_id = ?1
               AND d.deletion_id IS NULL AND d.archived = 0
               AND v.deletion_id IS NULL AND o.deletion_id IS NULL AND p.deletion_id IS NULL
               AND v.rowid NOT IN (SELECT rowid FROM hidden)
               AND o.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY lower(d.text), fv.field_id, o.id, fv.ordinal"
        ))?;
        let rows = statement.query_map([target], |row| {
            Ok((
                IncomingFieldValue {
                    field_id: row.get(0)?,
                    field_name: row.get(1)?,
                    counts_as: None,
                    owner: FieldOwner {
                        id: row.get(2)?,
                        text: row.get(3)?,
                        page_id: row.get(4)?,
                        page_title: row.get(5)?,
                    },
                    value_id: row.get(6)?,
                },
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut incoming = Vec::new();
        let mut counts: HashMap<String, Option<CountsAs>> = HashMap::new();
        for row in rows {
            let (mut value, text) = row?;
            if !counts.contains_key(&value.field_id) {
                let counted = definitions_for(&self.conn, Some(&value.field_id))?
                    .first()
                    .and_then(|definition| definition.counts_as);
                counts.insert(value.field_id.clone(), counted);
            }
            value.counts_as = counts[&value.field_id];
            // A link inside longer text is a mention, not this relation's value.
            if reference(&text) == Some(target)
                && !incoming
                    .iter()
                    .any(|seen: &IncomingFieldValue| seen.value_id == value.value_id)
            {
                incoming.push(value);
            }
        }
        Ok(incoming)
    }

    /// Read a field and its consequences without changing authored blocks.
    pub fn field_detail(
        &self,
        id: &str,
        kind: Option<FieldKind>,
        limit: Option<usize>,
    ) -> Result<FieldDetail> {
        validate_id(id)?;
        let definition = definitions_for(&self.conn, Some(id))?
            .pop()
            .ok_or_else(|| not_found(id))?;
        let task_path = match crate::built_in::task_field(&definition.name).map(|field| field.name)
        {
            Some("status") => Some("$.status"),
            Some("scheduled") => Some("$.scheduled"),
            Some("deadline") => Some("$.deadline"),
            Some("priority") => Some("$.priority"),
            Some("repeat") => Some("$.repeater"),
            _ => None,
        };
        let kind = kind.unwrap_or(definition.kind);
        let mut definition = definition;
        // A built-in field previewed as a relation reads against the Links to that changing its kind files.
        if kind == FieldKind::Instance
            && definition.kind != kind
            && definition.targets.is_empty()
            && let Some(field) = crate::built_in::field_named(&definition.name)
        {
            definition.targets = crate::built_in::targets(&self.conn, field)?;
        }
        let option_uses = if kind == FieldKind::Choice {
            definition
                .options
                .iter()
                .map(|option| FieldOptionUse {
                    option_id: option.id.clone(),
                    uses: 0,
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut detail = FieldDetail {
            field: FieldSummary {
                definition,
                owners: 0,
                types: Vec::new(),
            },
            kind,
            owners_total: 0,
            values_total: 0,
            empty_total: 0,
            problems_total: 0,
            templates: Vec::new(),
            option_uses,
            owners: Vec::new(),
            problems: Vec::new(),
            readable: Vec::new(),
            choice_candidates: Vec::new(),
            interpretations: Vec::new(),
            entries: Vec::new(),
        };
        let option_indices: HashMap<_, _> = detail
            .option_uses
            .iter()
            .enumerate()
            .map(|(index, option)| (option.option_id.clone(), index))
            .collect();
        let mut choice_values = Vec::<(i64, FieldChoiceValue)>::new();
        let mut interpretation_indices = HashMap::<String, usize>::new();
        // Entries, including empty ones, follow the register's whole-reference
        // and hidden-ancestor rules. Values and targets join once, not per row.
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT o.id, o.text, o.page_id, p.text, e.id, e.text, v.id, v.text, v.revision, v.rowid, ",
            block_columns!("t"),
            " FROM links l JOIN blocks e ON e.id = l.source_id
              JOIN blocks o ON o.id = e.parent_id JOIN blocks p ON p.id = o.page_id
              LEFT JOIN blocks v ON v.parent_id = e.id AND v.deletion_id IS NULL AND v.archived = 0
              LEFT JOIN links vl ON vl.source_id = v.id AND vl.occurrence = 0
              LEFT JOIN blocks t ON t.id = vl.target_id AND t.deletion_id IS NULL
              WHERE l.target_id = ?1 AND l.occurrence = 0 AND ?2 IS NULL
              AND e.deletion_id IS NULL AND o.deletion_id IS NULL AND p.deletion_id IS NULL
              AND e.rowid NOT IN (SELECT rowid FROM hidden)
              ORDER BY o.text COLLATE NOCASE, o.id, e.ordinal, e.id, v.ordinal, v.id"
        ))?;
        let mut cursor = statement.query(params![id, task_path])?;
        let limit = limit.unwrap_or(12).min(500);
        let mut owner_id = String::new();
        let mut entry_id = String::new();
        let mut entry_empty = false;
        let mut seen_project_owners = HashSet::new();
        let mut seen_project_values = HashMap::<String, HashSet<String>>::new();
        while let Some(row) = cursor.next()? {
            let entry_text: String = row.get(5)?;
            if reference(&entry_text) != Some(id) {
                continue;
            }
            let owner = FieldOwner {
                id: row.get(0)?,
                text: row.get(1)?,
                page_id: row.get(2)?,
                page_title: row.get(3)?,
            };
            let entry: String = row.get(4)?;
            if owner.id != owner_id {
                owner_id.clone_from(&owner.id);
                if detail.field.definition.name == "project" {
                    seen_project_owners.insert(owner.id.clone());
                }
                detail.owners_total += 1;
                if detail.owners.len() < limit {
                    detail.owners.push(FieldOwnerValues {
                        owner: owner.clone(),
                        entry_id: entry.clone(),
                        values: Vec::new(),
                    });
                }
            }
            if entry != entry_id {
                detail.entries.push(entry.clone());
                detail.empty_total += usize::from(entry_empty);
                entry_id.clone_from(&entry);
                entry_empty = true;
            }
            let Some(text) = row
                .get::<_, Option<String>>(7)?
                .filter(|text| !text.trim().is_empty())
            else {
                continue;
            };
            entry_empty = false;
            detail.values_total += 1;
            let target = if matches!(row.get_ref(10)?, rusqlite::types::ValueRef::Null) {
                None
            } else {
                Some(block_at(row, 10)?)
            };
            let reading = constrained_reading(
                &self.conn,
                kind,
                &detail.field.definition,
                &text,
                target.as_ref(),
            )?;
            let index = *interpretation_indices
                .entry(text.clone())
                .or_insert_with(|| {
                    let index = detail.interpretations.len();
                    detail.interpretations.push(FieldInterpretation {
                        text: text.clone(),
                        reading: reading.clone(),
                        values: Vec::new(),
                    });
                    index
                });
            detail.interpretations[index].values.push(FieldChoiceValue {
                id: row.get(6)?,
                text: text.clone(),
                revision: row.get(8)?,
                page_id: owner.page_id.clone(),
            });
            if kind == FieldKind::Choice && matches!(reading, Reading::Problem { .. }) {
                choice_values.push((
                    row.get(9)?,
                    FieldChoiceValue {
                        id: row.get(6)?,
                        text: text.clone(),
                        revision: row.get(8)?,
                        page_id: owner.page_id.clone(),
                    },
                ));
            }
            if let Reading::Value {
                target: Some(target),
                ..
            } = &reading
                && let Some(&index) = option_indices.get(target)
            {
                detail.option_uses[index].uses += 1;
            }
            if detail.field.definition.name == "project"
                && let Reading::Value {
                    target: Some(target),
                    ..
                } = &reading
            {
                if let Some(values) = seen_project_values.get_mut(&owner.id) {
                    if !values.contains(target) {
                        values.insert(target.clone());
                    }
                } else {
                    seen_project_values.insert(owner.id.clone(), HashSet::from([target.clone()]));
                }
            }
            let value = FieldValue {
                id: row.get(6)?,
                text,
                reading,
            };
            if let Some(visible) = detail
                .owners
                .last_mut()
                .filter(|item| item.owner.id == owner.id)
            {
                visible.values.push(value.clone());
            }
            let destination = if matches!(value.reading, Reading::Problem { .. }) {
                detail.problems_total += 1;
                (detail.problems.len() < 100).then_some(&mut detail.problems)
            } else {
                (detail.readable.len() < 12).then_some(&mut detail.readable)
            };
            if let Some(destination) = destination {
                destination.push(FieldValueUse {
                    owner,
                    entry_id: entry,
                    value,
                });
            }
        }
        // Row identity preserves insertion order even within one timestamp/batch.
        // Samples stay in owner order; conversion names use first appearance.
        choice_values.sort_unstable_by_key(|(order, _)| *order);
        if !choice_values.is_empty() {
            let mut candidate_indices = HashMap::<String, usize>::new();
            let option_names: HashMap<_, _> = detail
                .field
                .definition
                .options
                .iter()
                .rev()
                .map(|option| (option.text.trim().to_lowercase(), &option.id))
                .collect();
            for (_, value) in choice_values {
                let name = value.text.trim();
                let key = name.to_lowercase();
                let index = match candidate_indices.entry(key) {
                    std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let index = detail.choice_candidates.len();
                        detail.choice_candidates.push(FieldChoiceCandidate {
                            text: name.to_owned(),
                            option_id: option_names.get(entry.key()).map(|id| (*id).clone()),
                            values: Vec::new(),
                        });
                        entry.insert(index);
                        index
                    }
                };
                detail.choice_candidates[index].values.push(value);
            }
        }
        detail.empty_total += usize::from(entry_empty);
        if detail.field.definition.name == "project" {
            for (owner, projects) in crate::task_query::project_memberships(&self.conn)? {
                let authored = seen_project_values.get(&owner);
                for project in projects {
                    if !authored.is_some_and(|values| values.contains(&project)) {
                        detail.values_total += 1;
                    }
                }
                if seen_project_owners.insert(owner) {
                    detail.owners_total += 1;
                }
            }
        }
        if let Some(path) = task_path {
            detail.owners_total = self.conn.query_row(
                concat!(
                    hidden_blocks!(),
                    "SELECT COUNT(json_extract(t.state, ?1))
                     FROM tasks t JOIN blocks b ON b.id = t.block_id
                     WHERE t.active = 1 AND b.deletion_id IS NULL
                     AND b.rowid NOT IN (SELECT rowid FROM hidden)"
                ),
                [path],
                |row| row.get::<_, i64>(0),
            )? as usize;
            detail.values_total = detail.owners_total;
        }
        detail.field.owners = detail.owners_total;
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT t.id, t.text, f.position + 1, COUNT(DISTINCT CASE WHEN p.id IS NOT NULL THEN b.id END)
             FROM type_fields f JOIN blocks t ON t.id = f.type_id
             LEFT JOIN memberships m ON m.type_id = t.id
             LEFT JOIN blocks b ON b.id = m.block_id AND b.deletion_id IS NULL
                 AND b.rowid NOT IN (SELECT rowid FROM hidden)
             LEFT JOIN blocks p ON p.id = b.page_id AND p.deletion_id IS NULL
             WHERE f.field_id = ?1 AND t.deletion_id IS NULL
                 AND t.rowid NOT IN (SELECT rowid FROM hidden)
             GROUP BY t.id ORDER BY t.text COLLATE NOCASE, t.id"
        ))?;
        let mut cursor = statement.query([id])?;
        while let Some(row) = cursor.next()? {
            detail.field.types.push(FieldType {
                id: row.get(0)?,
                name: row.get(1)?,
            });
            detail.templates.push(FieldTemplate {
                type_id: row.get(0)?,
                name: row.get(1)?,
                position: row.get::<_, i64>(2)? as usize,
                members: row.get::<_, i64>(3)? as usize,
            });
        }
        Ok(detail)
    }
}

pub(crate) fn number(text: &str) -> Option<f64> {
    let text = text.trim();
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = digits
        .split_once('.')
        .map_or((digits, None), |(w, f)| (w, Some(f)));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

pub(crate) fn constrained_reading(
    conn: &Connection,
    kind: FieldKind,
    definition: &FieldDefinition,
    text: &str,
    target: Option<&Block>,
) -> Result<Reading> {
    let mut reading = reading(kind, &definition.id, text, target);
    if kind != FieldKind::Instance {
        return Ok(reading);
    }
    if let Reading::Value {
        value: ReadingValue::Text(label),
        target: Some(_),
        ..
    } = &mut reading
    {
        let mut text =
            conn.prepare_cached("SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL")?;
        *label = target_label(label, &mut |id| {
            text.query_row([id], |row| row.get(0))
                .optional()
                .ok()
                .flatten()
        });
    }
    if definition.targets.is_empty() {
        return Ok(reading);
    }
    if let Reading::Value {
        target: Some(id), ..
    } = &reading
    {
        // The definition's own targets, which a kind preview may fill before they are filed.
        let targets = serde_json::json!(definition.targets).to_string();
        let matches: bool = conn
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM blocks ty
             WHERE ty.id IN (SELECT value FROM json_each(?2))
             AND ty.deletion_id IS NULL AND ty.archived = 0
             AND (EXISTS(SELECT 1 FROM memberships m WHERE m.block_id = ?1 AND m.type_id = ty.id)
                 OR (ty.kind = 'page' AND ty.title_key = 'project'
                     AND EXISTS(SELECT 1 FROM projects p WHERE p.block_id = ?1 AND p.active = 1))))
             OR (?3 IN (SELECT value FROM json_each(?2))
                 AND EXISTS(SELECT 1 FROM sources WHERE block_id = ?1 AND active = 1))",
            )?
            .query_row(params![id, targets, SOURCE_TARGET], |row| row.get(0))?;
        if !matches {
            let names = conn
                .prepare_cached(
                    "SELECT COALESCE(b.text, t.value) FROM json_each(?1) t
                 LEFT JOIN blocks b ON b.id = t.value ORDER BY t.key",
                )?
                .query_map([&targets], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Reading::Problem {
                ok: false,
                problem: format!("Not a {}", names.join(" or ").to_lowercase()),
            });
        }
    }
    Ok(reading)
}

/// A relation target's label wherever it sorts, groups, filters or renders: its
/// first line as plain text, with trailing tags dropped, inner tags read as
/// their titles and references as their labels. Nesting stops a few targets deep.
pub(crate) fn target_label(text: &str, resolve: &mut dyn FnMut(&str) -> Option<String>) -> String {
    fn label(text: &str, resolve: &mut dyn FnMut(&str) -> Option<String>, depth: usize) -> String {
        let line = text.trim().lines().next().unwrap_or_default();
        let mut parts: Vec<(std::ops::Range<usize>, String)> = crate::storage::tag_tokens(line)
            .map(|tag| {
                let title = tag.id.and_then(&mut *resolve).unwrap_or_else(|| {
                    if tag.title.is_empty() {
                        tag.id.unwrap_or_default()
                    } else {
                        tag.title
                    }
                    .to_owned()
                });
                (tag.span, title)
            })
            .collect();
        let mut end = line.trim_end().len();
        while let Some((span, _)) = parts
            .last()
            .filter(|(span, _)| line[span.end..end].trim().is_empty())
        {
            end = span.start;
            parts.pop();
        }
        for (span, target, alias) in crate::storage::reference_spans(&line[..end]) {
            let text = match alias {
                Some(alias) => alias.to_owned(),
                None if depth > 0 => resolve(target).map_or_else(
                    || target.to_owned(),
                    |text| label(&text, resolve, depth - 1),
                ),
                None => "…".to_owned(),
            };
            parts.push((span, text));
        }
        parts.sort_by_key(|(span, _)| span.start);
        let mut output = String::with_capacity(end);
        let mut cursor = 0;
        // A tag spelled inside a reference's label belongs to the reference.
        for (span, text) in parts {
            if span.start < cursor {
                continue;
            }
            output.push_str(&line[cursor..span.start]);
            output.push_str(&text);
            cursor = span.end;
        }
        output.push_str(&line[cursor..end]);
        output.trim().to_owned()
    }
    label(text, resolve, 3)
}

pub(crate) fn reading(kind: FieldKind, field: &str, text: &str, target: Option<&Block>) -> Reading {
    let linked = reference(text).and_then(|id| target.filter(|b| b.id == id));
    let value = |value, target| Reading::Value {
        ok: true,
        value,
        target,
    };
    let problem = |problem: &str| Reading::Problem {
        ok: false,
        problem: problem.to_owned(),
    };
    match kind {
        FieldKind::Text => value(ReadingValue::Text(text.to_owned()), None),
        FieldKind::Number => number(text).map_or_else(
            || problem("not a number"),
            |n| value(ReadingValue::Number(n), None),
        ),
        FieldKind::Date => {
            if let Some(target) = linked.filter(|b| b.kind == BlockKind::Journal) {
                value(
                    ReadingValue::Text(target.text.clone()),
                    Some(target.id.clone()),
                )
            } else if partial_date(text.trim()) {
                value(ReadingValue::Text(text.trim().to_owned()), None)
            } else {
                problem("not a date")
            }
        }
        FieldKind::Span => span(text).map_or_else(
            || problem("not a historical span"),
            |span| value(ReadingValue::Span(span), None),
        ),
        FieldKind::Url => {
            if url(text.trim()) {
                value(ReadingValue::Text(text.trim().to_owned()), None)
            } else {
                problem("not a URL")
            }
        }
        FieldKind::Identifier => identifier(text).map_or_else(
            || problem("not an ISBN, DOI or arXiv ID"),
            |id| value(ReadingValue::Text(id), None),
        ),
        FieldKind::Checkbox => match text.trim().to_ascii_lowercase().as_str() {
            "yes" | "true" | "x" | "[x]" | "done" => value(ReadingValue::Checkbox(true), None),
            "no" | "false" | "[ ]" | "" => value(ReadingValue::Checkbox(false), None),
            _ => problem("not a checkbox"),
        },
        FieldKind::Choice | FieldKind::Instance => {
            if let Some(target) = linked.filter(|b| {
                kind == FieldKind::Instance
                    || (!b.archived && b.parent_id.as_deref() == Some(field))
            }) {
                value(
                    ReadingValue::Text(target.text.clone()),
                    Some(target.id.clone()),
                )
            } else {
                problem(if kind == FieldKind::Choice {
                    "not an option"
                } else {
                    "not a reference"
                })
            }
        }
    }
}

pub(crate) use crate::spans::span;

/// A calendar date, or a bare year or year and month for sources dated no
/// more precisely. Sorting pads bare years, never their authored text.
pub(crate) fn partial_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let year = |digits: &[u8]| {
        digits.iter().all(u8::is_ascii_digit) && digits.iter().any(|digit| *digit != b'0')
    };
    match bytes.len() {
        1..=4 => year(bytes),
        7 => {
            year(&bytes[..4])
                && bytes[4] == b'-'
                && matches!(
                    &text[5..7],
                    "01" | "02"
                        | "03"
                        | "04"
                        | "05"
                        | "06"
                        | "07"
                        | "08"
                        | "09"
                        | "10"
                        | "11"
                        | "12"
                )
        }
        _ => validate_date(text).is_ok(),
    }
}

fn url(text: &str) -> bool {
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|rest| {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        !host.is_empty() && !text.chars().any(char::is_whitespace)
    })
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &text[prefix.len()..])
}

/// Normalize an ISBN to `isbn:` and 13 digits, a DOI to lowercase `doi:10.…`
/// and an arXiv ID to `arxiv:…`, accepting their common URL and label forms.
pub(crate) fn identifier(text: &str) -> Option<String> {
    let text = text.trim();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if let Some(rest) = strip_prefix_ignore_case(text, prefix) {
            return doi(rest.trim());
        }
    }
    for prefix in [
        "https://arxiv.org/abs/",
        "http://arxiv.org/abs/",
        "https://arxiv.org/pdf/",
        "http://arxiv.org/pdf/",
        "arxiv:",
    ] {
        if let Some(rest) = strip_prefix_ignore_case(text, prefix) {
            return arxiv(rest.trim().trim_end_matches(".pdf"));
        }
    }
    if let Some(rest) = strip_prefix_ignore_case(text, "isbn") {
        return isbn(rest.trim_start_matches([':', ' ', '-']).trim());
    }
    isbn(text).or_else(|| doi(text)).or_else(|| arxiv(text))
}

fn isbn(text: &str) -> Option<String> {
    let compact: Vec<u8> = text.bytes().filter(|b| *b != b'-' && *b != b' ').collect();
    let digit = |b: u8| (b - b'0') as u32;
    match compact.len() {
        10 if compact[..9].iter().all(u8::is_ascii_digit)
            && (compact[9].is_ascii_digit() || compact[9] == b'X' || compact[9] == b'x') =>
        {
            let check = if compact[9].is_ascii_digit() {
                digit(compact[9])
            } else {
                10
            };
            let sum: u32 = compact[..9]
                .iter()
                .enumerate()
                .map(|(i, b)| (10 - i as u32) * digit(*b))
                .sum::<u32>()
                + check;
            if !sum.is_multiple_of(11) {
                return None;
            }
            let mut thirteen: Vec<u8> = b"978".iter().chain(&compact[..9]).copied().collect();
            thirteen.push(isbn13_check(&thirteen));
            Some(format!(
                "isbn:{}",
                String::from_utf8(thirteen).expect("ASCII digits")
            ))
        }
        13 if compact.iter().all(u8::is_ascii_digit)
            && (compact.starts_with(b"978") || compact.starts_with(b"979"))
            && isbn13_check(&compact[..12]) == compact[12] =>
        {
            Some(format!(
                "isbn:{}",
                String::from_utf8(compact).expect("ASCII digits")
            ))
        }
        _ => None,
    }
}

fn isbn13_check(twelve: &[u8]) -> u8 {
    let sum: u32 = twelve
        .iter()
        .enumerate()
        .map(|(i, b)| (b - b'0') as u32 * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    b'0' + ((10 - sum % 10) % 10) as u8
}

fn doi(text: &str) -> Option<String> {
    let (registrant, suffix) = text.strip_prefix("10.")?.split_once('/')?;
    (registrant.len() >= 4
        && registrant.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && !suffix.is_empty()
        && !text.chars().any(char::is_whitespace))
    .then(|| format!("doi:{}", text.to_lowercase()))
}

fn arxiv(text: &str) -> Option<String> {
    let (base, version) = match text.rsplit_once('v') {
        Some((base, version))
            if !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) =>
        {
            (base, Some(version))
        }
        _ => (text, None),
    };
    let modern = base.split_once('.').is_some_and(|(month, number)| {
        month.len() == 4
            && month.bytes().all(|b| b.is_ascii_digit())
            && matches!(
                &month[2..],
                "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
            )
            && (4..=5).contains(&number.len())
            && number.bytes().all(|b| b.is_ascii_digit())
    });
    let legacy = base.split_once('/').is_some_and(|(archive, number)| {
        let (name, class) = archive
            .split_once('.')
            .map_or((archive, None), |(n, c)| (n, Some(c)));
        !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
            && class.is_none_or(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
            && number.len() == 7
            && number.bytes().all(|b| b.is_ascii_digit())
    });
    (modern || legacy).then(|| match version {
        Some(version) => format!("arxiv:{base}v{version}"),
        None => format!("arxiv:{base}"),
    })
}

pub(crate) fn definition_map(definitions: &[FieldDefinition]) -> HashMap<&str, &FieldDefinition> {
    definitions.iter().map(|d| (d.id.as_str(), d)).collect()
}
