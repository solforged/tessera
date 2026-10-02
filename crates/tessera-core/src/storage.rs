use rusqlite::{Connection, OptionalExtension};

use crate::{Block, BlockKind, Error, Result, Revision};

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
        let prefix = &rest[..start];
        let is_tag = prefix.strip_suffix('#').is_some_and(|before| {
            before
                .chars()
                .next_back()
                .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
        });
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let reference = &rest[..end];
        let (target, alias) = reference
            .split_once('|')
            .map_or((reference, None), |(target, alias)| (target, Some(alias)));
        if !is_tag && validate_id(target).is_ok() {
            insert.execute(rusqlite::params![id, occurrence, target, alias])?;
            occurrence += 1;
        }
        rest = &rest[end + 2..];
    }
    Ok(())
}

pub(crate) struct TagToken<'a> {
    pub title: &'a str,
    pub span: std::ops::Range<usize>,
}

fn bare_tag_character(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '-' | '_' | '/')
}

/// The same borrowed token spans drive membership derivation and rename.
pub(crate) fn tag_tokens(text: &str) -> impl Iterator<Item = TagToken<'_>> {
    let mut cursor = 0;
    std::iter::from_fn(move || {
        while let Some(relative) = text[cursor..].find('#') {
            let start = cursor + relative;
            cursor = start + 1;
            if text[..start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
            {
                continue;
            }
            let rest = &text[cursor..];
            if let Some(rest) = rest.strip_prefix("[[") {
                let Some(end) = rest.find("]]") else { continue };
                cursor += 2 + end + 2;
                let title = rest[..end].trim();
                if !title.is_empty() && !title.contains(['[', ']']) {
                    return Some(TagToken {
                        title,
                        span: start..cursor,
                    });
                }
                continue;
            }
            let end = rest
                .find(|ch: char| !bare_tag_character(ch))
                .unwrap_or(rest.len());
            cursor += end;
            if end != 0 {
                return Some(TagToken {
                    title: &rest[..end],
                    span: start..cursor,
                });
            }
        }
        None
    })
}

pub(crate) fn tag_names(text: &str) -> impl Iterator<Item = &str> {
    tag_tokens(text).map(|token| token.title)
}

pub(crate) fn tag_title_matches(title: &str, title_key: &str) -> bool {
    if title.is_ascii() && title_key.is_ascii() {
        title.eq_ignore_ascii_case(title_key)
    } else {
        title.to_lowercase() == title_key
    }
}

pub(crate) fn validate_tag_title(title: &str) -> Result<()> {
    if title.contains(['[', ']', '\n', '\r']) {
        return Err(validation(
            "a page referenced by tags cannot have a title containing brackets or line breaks",
        ));
    }
    if title.trim() != title {
        return Err(validation(
            "a page referenced by tags cannot have a title starting or ending with whitespace",
        ));
    }
    Ok(())
}

pub(crate) fn tag_spelling(title: &str) -> Result<String> {
    validate_tag_title(title)?;
    Ok(if title.chars().all(bare_tag_character) {
        format!("#{title}")
    } else {
        format!("#[[{title}]]")
    })
}

pub(crate) fn rewrite_tags<'a>(
    text: &str,
    mut spelling: impl FnMut(&str) -> Option<&'a str>,
) -> Option<String> {
    // Resolve every original token before emitting any replacement. A renamed
    // title can itself be another token's old title in the same transaction.
    let replacements: Vec<_> = tag_tokens(text)
        .filter_map(|token| spelling(token.title).map(|value| (token.span, value)))
        .collect();
    if replacements.is_empty()
        || replacements
            .iter()
            .all(|(span, value)| &text[span.clone()] == *value)
    {
        return None;
    }
    let replaced = replacements.iter().map(|(span, _)| span.len()).sum::<usize>();
    let inserted = replacements.iter().map(|(_, value)| value.len()).sum::<usize>();
    let mut rewritten = String::with_capacity(text.len() - replaced + inserted);
    let mut cursor = 0;
    for (span, value) in replacements {
        rewritten.push_str(&text[cursor..span.start]);
        rewritten.push_str(value);
        cursor = span.end;
    }
    rewritten.push_str(&text[cursor..]);
    Some(rewritten)
}

pub(crate) fn derive_memberships(
    conn: &Connection,
    id: &str,
    text: &str,
    now: i64,
    create_missing: bool,
) -> Result<Vec<Revision>> {
    conn.prepare_cached("DELETE FROM memberships WHERE block_id = ?1")?
        .execute([id])?;
    let mut created = Vec::new();
    let mut titles = Vec::new();
    for title in tag_names(text) {
        let title_key = title.to_lowercase();
        if titles.contains(&title_key) {
            continue;
        }
        let existing: Option<String> = conn
            .prepare_cached(
                "SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?1",
            )?
            .query_row([&title_key], |row| row.get(0))
            .optional()?;
        let type_id = if let Some(id) = existing {
            Some(id)
        } else if create_missing {
            let id = ulid::Ulid::generate().to_string();
            conn.prepare_cached(
                "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
                 VALUES (?1, 'page', ?1, 1024, ?2, ?3, 1, ?4, ?4)",
            )?
            .execute(rusqlite::params![id, title, title_key, now])?;
            derive_links(conn, &id, title)?;
            created.push(Revision {
                id: id.clone(),
                revision: 1,
            });
            Some(id)
        } else {
            None
        };
        conn.prepare_cached(
            "INSERT INTO memberships(block_id, title_key, type_id) VALUES (?1, ?2, ?3)",
        )?
        .execute(rusqlite::params![id, title_key, type_id])?;
        titles.push(title_key);
    }
    Ok(created)
}
