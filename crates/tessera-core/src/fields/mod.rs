use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::storage::{validate_id, validation};
use crate::{CountsAs, FieldDefinition, FieldHide, FieldKind, FieldOption, FieldRole, Result};

mod derive;
mod reading;
mod views;

pub(crate) use derive::{
    FieldChanges, invalid_source_page_counts, rebuild, validates_source_page_counts,
};
pub(crate) use reading::{
    ReadingContext, constrained_reading, identifier, partial_date, reading, span, target_label,
};

pub(crate) fn ensure_page(conn: &Connection) -> Result<()> {
    let named: Option<String> = conn
        .query_row(
            "SELECT id FROM blocks WHERE kind = 'page' AND title_key = 'fields' AND deletion_id IS NULL",
            [],
            |row| row.get(0),
        )
        .optional()?;
    // Before renaming Fields was refused, a workshop could rename its register, and opening then made an
    // empty Fields page beside it. The page that holds the field definitions takes the name back, and an
    // untouched empty Fields page made that way gives it up, so the definitions keep their register.
    let register: Option<String> = conn
        .query_row(
            "SELECT p.id FROM fields f
             JOIN blocks d ON d.id = f.block_id AND d.deletion_id IS NULL
             JOIN blocks p ON p.id = d.parent_id AND p.kind = 'page' AND p.deletion_id IS NULL
             GROUP BY p.id ORDER BY COUNT(*) DESC, p.id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let now = crate::notebook::now_ms();
    if let Some(register) = register.filter(|register| named.as_ref() != Some(register)) {
        let named_is_bare = match &named {
            None => true,
            Some(named) => {
                conn.execute(
                    "DELETE FROM blocks WHERE id = ?1 AND revision = 1
                     AND NOT EXISTS(SELECT 1 FROM blocks c WHERE c.page_id = ?1 AND c.id <> ?1)
                     AND NOT EXISTS(SELECT 1 FROM links l WHERE l.target_id = ?1)",
                    [named],
                )? > 0
            }
        };
        if named_is_bare {
            conn.execute(
                "UPDATE blocks SET text = 'Fields', title_key = 'fields', revision = revision + 1, updated_at = ?2
                 WHERE id = ?1",
                params![register, now],
            )?;
        }
        return Ok(());
    }
    if named.is_some() {
        return Ok(());
    }
    let id = crate::notebook::new_ulid().to_string();
    conn.execute(
        "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
         VALUES (?1, 'page', ?1, 1024, 'Fields', 'fields', 1, ?2, ?2)",
        params![id, now],
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

pub(crate) fn definition_map(definitions: &[FieldDefinition]) -> HashMap<&str, &FieldDefinition> {
    definitions.iter().map(|d| (d.id.as_str(), d)).collect()
}
