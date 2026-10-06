use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::model::{FieldSummary, FieldType};
use crate::reads::hidden_blocks;
use crate::storage::{not_found, validate_date, validate_id, validation};
use crate::{
    Block, BlockKind, FieldDefinition, FieldKind, FieldOption, FieldsView, Notebook, Operation,
    Reading, ReadingValue, Result,
};

pub(crate) fn ensure_page(conn: &Connection) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM blocks WHERE kind = 'page' AND title_key = 'fields' AND deletion_id IS NULL)",
        [], |row| row.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let id = ulid::Ulid::generate().to_string();
    conn.execute(
        "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
         VALUES (?1, 'page', ?1, 1024, 'Fields', 'fields', 1, ?2, ?2)",
        params![id, crate::notebook::now_ms()],
    )?;
    conn.execute(
        "UPDATE memberships SET type_id = ?1 WHERE title_key = 'fields'",
        [&id],
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
         WHERE d.id = ?1 AND d.deletion_id IS NULL AND d.archived = 0
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
    if is_definition(conn, id)? {
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
    let id = inner.split_once('|').map_or(inner, |(id, _)| id);
    validate_id(id).ok()?;
    Some(id)
}

/// Retain old and new ancestry and incoming entries when definitions move or
/// stop being definitions. Work per text edit is local, not a page rebuild.
#[derive(Default)]
pub(crate) struct FieldChanges {
    owners: HashSet<String>,
}
impl FieldChanges {
    pub(crate) fn capture(&mut self, conn: &Connection, id: &str) -> Result<()> {
        let mut statement = conn.prepare_cached(
            "WITH RECURSIVE ancestors(id, depth) AS (
                SELECT ?1, 0 UNION ALL SELECT b.parent_id, a.depth + 1
                FROM ancestors a JOIN blocks b ON b.id = a.id WHERE a.depth < 2 AND b.parent_id IS NOT NULL
             ) SELECT id FROM ancestors
             UNION SELECT e.parent_id FROM links l JOIN blocks e ON e.id = l.source_id
               WHERE l.target_id = ?1 AND e.parent_id IS NOT NULL
             UNION SELECT e.parent_id FROM blocks p JOIN blocks d ON d.parent_id = p.id
               JOIN links l ON l.target_id = d.id JOIN blocks e ON e.id = l.source_id
               WHERE p.id = ?1 AND p.kind = 'page' AND p.title_key = 'fields' AND e.parent_id IS NOT NULL",
        )?;
        for row in statement.query_map([id], |row| row.get::<_, String>(0))? {
            self.owners.insert(row?);
        }
        Ok(())
    }
    pub(crate) fn before(&mut self, conn: &Connection, op: &Operation) -> Result<()> {
        match op {
            Operation::Merge {
                source_id,
                destination_id,
                ..
            } => {
                self.capture(conn, source_id)?;
                self.capture(conn, destination_id)
            }
            Operation::Move { id, parent_id, .. } => {
                self.capture(conn, id)?;
                self.capture(conn, parent_id)
            }
            Operation::CreatePage { id, .. }
            | Operation::CreateJournal { id, .. }
            | Operation::Insert { id, .. }
            | Operation::EditText { id, .. }
            | Operation::SetHeading { id, .. }
            | Operation::Split { id, .. }
            | Operation::Delete { id, .. }
            | Operation::Restore { id, .. }
            | Operation::SetArchived { id, .. }
            | Operation::SetFieldKind { id, .. } => self.capture(conn, id),
            Operation::SetTypeFields { .. }
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
            | Operation::SetTask { .. }
            | Operation::RestoreTaskState { .. }
            | Operation::CompleteTask { .. }
            | Operation::ReverseTaskCompletion { .. }
            | Operation::SetProject { .. }
            | Operation::SetPosition { .. }
            | Operation::SetQuestion { .. }
            | Operation::SetAssessment { .. }
            | Operation::StartWork { .. }
            | Operation::StopWork { .. }
            | Operation::EditWorkNote { .. }
            | Operation::SetWorkSessionState { .. }
            | Operation::StartReviewSession { .. }
            | Operation::FinishReviewSession { .. }
            | Operation::GradeCard { .. }
            | Operation::ResetCard { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. }
            | Operation::SaveTaskView { .. }
            | Operation::DeleteTaskView { .. }
            | Operation::SaveLibraryView { .. }
            | Operation::DeleteLibraryView { .. }
            | Operation::DeleteView { .. } => Ok(()),
        }
    }
    pub(crate) fn derive(self, conn: &Connection) -> Result<()> {
        for owner in self.owners {
            derive_owner(conn, &owner)?;
        }
        Ok(())
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
    let mut insert = conn.prepare_cached(
        "INSERT INTO field_values(owner_id, field_id, entry_id, value_id, ordinal)
         SELECT ?1, ?2, ?3, id, ordinal FROM blocks
         WHERE parent_id = ?3 AND deletion_id IS NULL AND archived = 0",
    )?;
    for row in entries.query_map([owner], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (entry, text) = row?;
        if let Some(field) = reference(&text)
            && is_definition(conn, field)?
        {
            insert.execute(params![owner, field, entry])?;
        }
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

pub(crate) fn definitions(conn: &Connection) -> Result<Vec<FieldDefinition>> {
    let mut statement = conn.prepare_cached(
        "SELECT d.id, d.text, COALESCE(f.kind, 'text'), d.revision, o.id, o.text
         FROM blocks p JOIN blocks d ON d.parent_id = p.id LEFT JOIN fields f ON f.block_id = d.id
         LEFT JOIN blocks o ON o.parent_id = d.id AND o.deletion_id IS NULL AND o.archived = 0
         WHERE p.kind = 'page' AND p.title_key = 'fields' AND p.deletion_id IS NULL
         AND d.deletion_id IS NULL AND d.archived = 0 ORDER BY d.ordinal, d.id, o.ordinal, o.id",
    )?;
    let mut cursor = statement.query([])?;
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
            result.push(FieldDefinition {
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
                revision: row.get(3)?,
                options: Vec::new(),
            });
        }
        if let Some(id) = row.get(4)? {
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

/// A calendar date, or a bare year or year and month for sources dated no
/// more precisely. ISO order keeps partial dates sortable as text.
fn partial_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let year = |digits: &[u8]| {
        digits.len() == 4 && digits.iter().all(u8::is_ascii_digit) && digits != b"0000"
    };
    match bytes.len() {
        4 => year(bytes),
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
    for prefix in ["https://arxiv.org/abs/", "http://arxiv.org/abs/", "arxiv:"] {
        if let Some(rest) = strip_prefix_ignore_case(text, prefix) {
            return arxiv(rest.trim());
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
