use rusqlite::{Connection, OptionalExtension};

use crate::{Block, BlockKind, Error, Result};

// Keep joined reads and single-block lookups in the same positional contract,
// without allocating SQL strings on each call.
macro_rules! block_columns {
    ($alias:literal) => {
        concat!(
            $alias,
            ".id, ",
            $alias,
            ".kind, ",
            $alias,
            ".parent_id, ",
            $alias,
            ".page_id, ",
            $alias,
            ".text, ",
            $alias,
            ".heading, ",
            $alias,
            ".archived, ",
            $alias,
            ".revision, ",
            $alias,
            ".created_at, ",
            $alias,
            ".updated_at"
        )
    };
}
pub(crate) use block_columns;

pub(crate) fn block_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Block> {
    let kind: String = row.get(offset + 1)?;
    Ok(Block {
        id: row.get(offset)?,
        kind: match kind.as_str() {
            "page" => BlockKind::Page,
            "journal" => BlockKind::Journal,
            _ => BlockKind::Block,
        },
        parent_id: row.get(offset + 2)?,
        page_id: row.get(offset + 3)?,
        text: row.get(offset + 4)?,
        heading: row.get(offset + 5)?,
        archived: row.get(offset + 6)?,
        revision: row.get(offset + 7)?,
        created_at: row.get(offset + 8)?,
        updated_at: row.get(offset + 9)?,
    })
}

pub(crate) struct Stored {
    pub block: Block,
    pub ordinal: i64,
    pub deletion_id: Option<String>,
}

pub(crate) fn stored(conn: &Connection, id: &str) -> Result<Option<Stored>> {
    Ok(conn
        .prepare_cached(concat!(
            "SELECT ",
            block_columns!("b"),
            ", b.ordinal, b.deletion_id FROM blocks b WHERE b.id = ?1"
        ))?
        .query_row([id], |row| {
            Ok(Stored {
                block: block_at(row, 0)?,
                ordinal: row.get(10)?,
                deletion_id: row.get(11)?,
            })
        })
        .optional()?)
}

pub(crate) fn validation(message: impl Into<String>) -> Error {
    Error::Validation {
        message: message.into(),
        op_index: None,
    }
}

pub(crate) fn not_found(id: &str) -> Error {
    Error::NotFound {
        id: id.to_owned(),
        op_index: None,
    }
}

pub(crate) fn validate_id(id: &str) -> Result<()> {
    // Canonical spelling prevents two spellings from addressing one ULID.
    if id
        .parse::<ulid::Ulid>()
        .is_ok_and(|value| value.to_string() == id)
    {
        Ok(())
    } else {
        Err(validation(format!("invalid ULID: {id}")))
    }
}

pub(crate) fn validate_date(date: &str) -> Result<()> {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return Err(validation("journal date must be YYYY-MM-DD"));
    }
    let year: u32 = date[..4].parse().expect("validated digits");
    let month: u32 = date[5..7].parse().expect("validated digits");
    let day: u32 = date[8..].parse().expect("validated digits");
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days {
        return Err(validation("journal date is not a calendar date"));
    }
    Ok(())
}

pub(crate) fn validate_text(kind: BlockKind, text: &str) -> Result<()> {
    match kind {
        BlockKind::Page if text.trim().is_empty() => {
            Err(validation("page title must not be empty"))
        }
        BlockKind::Journal => validate_date(text),
        _ => Ok(()),
    }
}

pub(crate) fn derive_links(conn: &Connection, id: &str, text: &str) -> Result<()> {
    conn.prepare_cached("DELETE FROM links WHERE source_id = ?1")?
        .execute([id])?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO links(source_id, occurrence, target_id, alias) VALUES (?1, ?2, ?3, ?4)",
    )?;
    let mut rest = text;
    let mut occurrence = 0;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let reference = &rest[..end];
        let (target, alias) = reference
            .split_once('|')
            .map_or((reference, None), |(target, alias)| (target, Some(alias)));
        if validate_id(target).is_ok() {
            insert.execute(rusqlite::params![id, occurrence, target, alias])?;
            occurrence += 1;
        }
        rest = &rest[end + 2..];
    }
    Ok(())
}
