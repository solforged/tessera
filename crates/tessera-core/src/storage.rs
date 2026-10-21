use caseless::Caseless;
use rusqlite::{Connection, OptionalExtension};
use unicode_normalization::UnicodeNormalization;

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
        kept_copy: None,
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
        BlockKind::Page if text.trim().is_empty() => Err(validation("title must not be empty")),
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
    for (occurrence, token) in link_tokens(text).enumerate() {
        insert.execute(rusqlite::params![
            id,
            occurrence as i64,
            token.target,
            token.alias
        ])?;
    }
    Ok(())
}

/// Target before the first pipe; an optional locator follows the last pipe.
/// Any intervening pipes belong to the label.
pub(crate) fn reference_parts(reference: &str) -> (&str, Option<&str>, Option<&str>) {
    let Some((target, tail)) = reference.split_once('|') else {
        return (reference, None, None);
    };
    let (alias, locator) = tail
        .rsplit_once('|')
        .map_or((tail, None), |(alias, locator)| (alias, Some(locator)));
    (target, Some(alias), locator)
}

struct LinkToken<'a> {
    target: &'a str,
    alias: Option<&'a str>,
    span: std::ops::Range<usize>,
    target_span: std::ops::Range<usize>,
}

pub(crate) fn quote_target(text: &str) -> Option<&str> {
    let target = text.trim().strip_prefix("((")?.strip_suffix("))")?;
    validate_id(target).is_ok().then_some(target)
}

/// Only matching backtick runs shield code, as in the web tokenizer. Unmatched
/// runs stay literal; backticks inside a reference or URL belong to that token.
pub(crate) fn inline_code_spans(text: &str) -> impl Iterator<Item = std::ops::Range<usize>> {
    let mut cursor = 0;
    std::iter::from_fn(move || {
        while cursor < text.len() {
            let rest = &text[cursor..];
            if rest.starts_with("[[") && rest.contains("]]") {
                let mut depth = 1;
                cursor += 2;
                while cursor < text.len() && depth != 0 {
                    if text[cursor..].starts_with("[[") {
                        depth += 1;
                        cursor += 2;
                    } else if text[cursor..].starts_with("]]") {
                        depth -= 1;
                        cursor += 2;
                    } else {
                        cursor += text[cursor..].chars().next().expect("in bounds").len_utf8();
                    }
                }
                continue;
            }
            let url = |value: &str| {
                value
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
                    || value
                        .get(..8)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
            };
            if rest.starts_with('[')
                && !rest.starts_with("[[")
                && let Some(end) = rest.find("](")
            {
                let label = &rest[1..end];
                if !label.is_empty()
                    && !label.contains(['[', ']', '\r', '\n'])
                    && url(&rest[end + 2..])
                {
                    cursor += end + 2;
                    let mut depth = 0;
                    while cursor < text.len() {
                        let ch = text[cursor..].chars().next().expect("in bounds");
                        if ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\'') {
                            break;
                        }
                        cursor += ch.len_utf8();
                        if ch == '(' {
                            depth += 1;
                        } else if ch == ')' {
                            if depth == 0 {
                                break;
                            }
                            depth -= 1;
                        }
                    }
                    continue;
                }
            }
            if url(rest) {
                cursor += rest
                    .find(|ch: char| ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\''))
                    .unwrap_or(rest.len());
                continue;
            }
            if rest.starts_with('`') {
                let start = cursor;
                let width = rest.bytes().take_while(|&byte| byte == b'`').count();
                let opening_end = cursor + width;
                let mut closing = opening_end;
                while let Some(next) = text[closing..].find('`') {
                    closing += next;
                    let count = text[closing..]
                        .bytes()
                        .take_while(|&byte| byte == b'`')
                        .count();
                    closing += count;
                    if count == width {
                        cursor = closing;
                        return Some(start..cursor);
                    }
                }
                cursor = opening_end;
                continue;
            }
            cursor += rest.chars().next().expect("in bounds").len_utf8();
        }
        None
    })
}

/// Share reference recognition between indexing and merge rewriting. Tags are
/// memberships rather than ordinary block references.
fn link_tokens(text: &str) -> impl Iterator<Item = LinkToken<'_>> {
    let mut cursor = 0;
    let mut code = inline_code_spans(text).peekable();
    let mut quote = quote_target(text).map(|target| {
        let start = text.len() - text.trim_start().len() + 2;
        LinkToken {
            target,
            alias: None,
            span: 0..text.len(),
            target_span: start..start + target.len(),
        }
    });
    std::iter::from_fn(move || {
        if let Some(token) = quote.take() {
            cursor = text.len();
            return Some(token);
        }
        'references: while let Some(relative) = text[cursor..].find("[[") {
            let start = cursor + relative;
            while code.peek().is_some_and(|span| span.start <= start) {
                let span = code.next().expect("peeked span");
                if start < span.end {
                    cursor = span.end;
                    continue 'references;
                }
            }
            let prefix = &text[..start];
            let is_tag = prefix.strip_suffix('#').is_some_and(|before| {
                before
                    .chars()
                    .next_back()
                    .is_none_or(|ch| !bare_tag_character(ch))
            });
            let target_start = start + 2;
            let rest = &text[target_start..];
            let Some(end) = rest.find("]]") else {
                cursor = text.len();
                return None;
            };
            cursor = target_start + end + 2;
            let reference = &rest[..end];
            let (target, alias, _) = reference_parts(reference);
            if !is_tag && validate_id(target).is_ok() {
                return Some(LinkToken {
                    target,
                    alias,
                    span: start..cursor,
                    target_span: target_start..target_start + target.len(),
                });
            }
        }
        None
    })
}

/// Each block reference's whole span, target and label, as indexing reads them.
pub fn reference_spans(
    text: &str,
) -> impl Iterator<Item = (std::ops::Range<usize>, &str, Option<&str>)> {
    link_tokens(text).map(|token| (token.span, token.target, token.alias))
}

pub(crate) fn rewrite_links(text: &str, from: &str, into: &str) -> Option<String> {
    let mut rewritten = None;
    let mut cursor = 0;
    for token in link_tokens(text).filter(|token| token.target == from) {
        let output = rewritten.get_or_insert_with(|| String::with_capacity(text.len()));
        output.push_str(&text[cursor..token.target_span.start]);
        output.push_str(into);
        cursor = token.target_span.end;
    }
    if let Some(output) = &mut rewritten {
        output.push_str(&text[cursor..]);
    }
    rewritten
}

pub struct TagToken<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub span: std::ops::Range<usize>,
}

fn bare_tag_character(ch: char) -> bool {
    ch.is_alphanumeric()
        || unicode_normalization::char::is_combining_mark(ch)
        || matches!(ch, '-' | '_' | '/')
}

/// Borrowed spans shared by normalization, membership derivation and rendering.
/// A pipe starts a canonical alias only after a valid ULID. Otherwise the
/// whole bracket content remains a legacy title, including its pipes.
pub fn tag_tokens(text: &str) -> impl Iterator<Item = TagToken<'_>> {
    let mut cursor = 0;
    let mut code = inline_code_spans(text).peekable();
    std::iter::from_fn(move || {
        'tags: while let Some(relative) = text[cursor..].find('#') {
            let start = cursor + relative;
            while code.peek().is_some_and(|span| span.start <= start) {
                let span = code.next().expect("peeked span");
                if start < span.end {
                    cursor = span.end;
                    continue 'tags;
                }
            }
            cursor = start + 1;
            if text[..start]
                .chars()
                .next_back()
                .is_some_and(bare_tag_character)
            {
                continue;
            }
            let rest = &text[cursor..];
            if let Some(rest) = rest.strip_prefix("[[") {
                let Some(end) = rest.find("]]") else { continue };
                cursor += 2 + end + 2;
                let value = &rest[..end];
                if let Some((id, alias)) = value.split_once('|')
                    && validate_id(id).is_ok()
                {
                    if !alias.contains(['[', ']', '|', '\r', '\n']) {
                        return Some(TagToken {
                            id: Some(id),
                            title: alias,
                            span: start..cursor,
                        });
                    }
                    continue;
                }
                let title = value.trim();
                if !title.is_empty() && !title.contains(['[', ']']) {
                    return Some(TagToken {
                        id: None,
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
                    id: None,
                    title: &rest[..end],
                    span: start..cursor,
                });
            }
        }
        None
    })
}

#[cfg(test)]
pub(crate) fn tag_names(text: &str) -> impl Iterator<Item = &str> {
    tag_tokens(text).map(|token| token.title)
}

/// A page's identity name, NFC-normalized and Unicode 16 default case-folded.
pub(crate) fn title_key(title: &str) -> String {
    fold_title(&identity_name(title))
}

/// The pre-053 spelling rule, also used after identity extraction.
pub(crate) fn fold_title(title: &str) -> String {
    if title.is_ascii() {
        return title.to_ascii_lowercase();
    }
    title.nfc().default_case_fold().nfc().collect()
}

pub(crate) fn tag_title_matches(title: &str, title_key: &str) -> bool {
    let title = identity_name(title);
    if title.is_ascii() && title_key.is_ascii() {
        title.eq_ignore_ascii_case(title_key)
    } else {
        fold_title(&title) == title_key
    }
}

pub(crate) fn validate_tag_title(title: &str) -> Result<()> {
    if title.contains(['[', ']', '\n', '\r']) {
        return Err(validation(
            "an atom referenced by tags cannot have a title containing brackets or line breaks",
        ));
    }
    if title.trim() != title {
        return Err(validation(
            "an atom referenced by tags cannot have a title starting or ending with whitespace",
        ));
    }
    Ok(())
}

fn tag_alias(alias: &str) -> &str {
    if alias.contains(['[', ']', '|', '\n', '\r']) {
        ""
    } else {
        alias
    }
}

pub(crate) fn tag_text(id: &str, alias: &str) -> String {
    let alias = tag_alias(alias);
    format!("#[[{id}|{alias}]]")
}

pub(crate) fn rewrite_tags<'a>(
    text: &str,
    mut spelling: impl FnMut(&TagToken<'_>) -> Option<&'a str>,
) -> Option<String> {
    let replacements: Vec<_> = tag_tokens(text)
        .filter_map(|token| spelling(&token).map(|value| (token.span, value)))
        .collect();
    if replacements.is_empty()
        || replacements
            .iter()
            .all(|(span, value)| &text[span.clone()] == *value)
    {
        return None;
    }
    let replaced = replacements
        .iter()
        .map(|(span, _)| span.len())
        .sum::<usize>();
    let inserted = replacements
        .iter()
        .map(|(_, value)| value.len())
        .sum::<usize>();
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

/// Remove matching tag tokens and one adjoining space, without changing other prose.
pub(crate) fn remove_tag(text: &str, key: &str, type_id: Option<&str>) -> Option<String> {
    let mut rewritten = String::new();
    let mut cursor = 0;
    let mut found = false;
    for token in tag_tokens(text).filter(|token| match token.id {
        Some(id) => Some(id) == type_id,
        None => tag_title_matches(token.title, key),
    }) {
        found = true;
        rewritten.push_str(&text[cursor..token.span.start.max(cursor)]);
        cursor = token.span.end;
        if text[cursor..].starts_with(' ') {
            cursor += 1;
        } else if rewritten.ends_with(' ') {
            rewritten.pop();
        }
    }
    if !found {
        return None;
    }
    rewritten.push_str(&text[cursor..]);
    Some(rewritten)
}

/// How to create a type page that a tag names but no live page has.
#[derive(Clone, Copy)]
pub(crate) struct TypeCreation<'a> {
    /// The change creating the page; its ID derives from this and the title.
    /// `None` only when migrating a notebook from before change IDs.
    pub change_id: Option<&'a str>,
    pub now: i64,
}

pub(crate) fn derive_memberships(
    conn: &Connection,
    id: &str,
    text: &str,
    create: Option<TypeCreation>,
) -> Result<Vec<Revision>> {
    conn.prepare_cached("DELETE FROM memberships WHERE block_id = ?1 AND manual = 0")?
        .execute([id])?;
    let mut created = Vec::new();
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO memberships(block_id, type_id, manual, title) VALUES (?1, ?2, 0, ?3)",
    )?;
    for token in tag_tokens(text) {
        let type_id = match token.id {
            Some(id) => live_tag(conn, id)?.map(|_| id.to_owned()),
            None => resolve_type(
                conn,
                token.title,
                &title_key(token.title),
                create,
                &mut created,
            )?,
        };
        if let Some(type_id) = type_id {
            insert.execute(rusqlite::params![id, type_id, token.title])?;
        }
    }
    Ok(created)
}

pub(crate) fn live_tag(conn: &Connection, id: &str) -> Result<Option<String>> {
    Ok(conn
        .prepare_cached(
            "SELECT text FROM blocks WHERE id = ?1 AND kind = 'page' AND deletion_id IS NULL",
        )?
        .query_row([id], |row| row.get(0))
        .optional()?)
}

/// Normalize only a block already being written. Missing ID targets stay literal;
/// migration passes no creation policy so unresolved legacy text stays literal too.
pub(crate) fn normalize_tags(
    conn: &Connection,
    text: &str,
    create: Option<TypeCreation<'_>>,
    refresh_alias: bool,
    created: &mut Vec<Revision>,
) -> Result<Option<String>> {
    let mut rewritten = None;
    let mut cursor = 0;
    for token in tag_tokens(text) {
        let replacement = match token.id {
            Some(id) if refresh_alias => live_tag(conn, id)?
                .filter(|title| tag_alias(title) != token.title)
                .map(|title| tag_text(id, &title)),
            Some(_) => None,
            None => resolve_type(conn, token.title, &title_key(token.title), create, created)?
                .map(|id| tag_text(&id, token.title)),
        };
        if let Some(replacement) = replacement {
            let output = rewritten.get_or_insert_with(|| String::with_capacity(text.len()));
            output.push_str(&text[cursor..token.span.start]);
            output.push_str(&replacement);
            cursor = token.span.end;
        }
    }
    if let Some(output) = &mut rewritten {
        output.push_str(&text[cursor..]);
    }
    Ok(rewritten)
}

/// Human-readable tags without changing persisted text. The caller supplies live
/// page titles; a missing page falls back to the authored alias, then the ID.
pub fn render_tags<'a, 'b>(
    text: &'a str,
    mut title: impl FnMut(&str) -> Option<&'b str>,
) -> std::borrow::Cow<'a, str> {
    let mut rewritten = None;
    let mut cursor = 0;
    for token in tag_tokens(text) {
        let Some(id) = token.id else { continue };
        let label = title(id);
        let label = label.unwrap_or(if token.title.is_empty() {
            id
        } else {
            token.title
        });
        let output = rewritten.get_or_insert_with(|| String::with_capacity(text.len()));
        output.push_str(&text[cursor..token.span.start]);
        output.push('#');
        output.push_str(label);
        cursor = token.span.end;
    }
    match rewritten {
        Some(mut output) => {
            output.push_str(&text[cursor..]);
            std::borrow::Cow::Owned(output)
        }
        None => std::borrow::Cow::Borrowed(text),
    }
}

/// The name shared by page identity and display: remove tag tokens and collapse
/// adjoining whitespace. Untagged and tag-only titles keep their full text.
pub fn identity_name(text: &str) -> std::borrow::Cow<'_, str> {
    let mut tags = tag_tokens(text).peekable();
    if tags.peek().is_none() {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for token in tags {
        push_words(&mut output, &text[cursor..token.span.start]);
        cursor = token.span.end;
    }
    push_words(&mut output, &text[cursor..]);
    if output.is_empty() {
        return std::borrow::Cow::Borrowed(text);
    }
    std::borrow::Cow::Owned(output)
}

/// Display the identity name, rendering tag-only titles with live tag labels.
pub fn display_title<'a, 'b>(
    text: &'a str,
    title: impl FnMut(&str) -> Option<&'b str>,
) -> std::borrow::Cow<'a, str> {
    match identity_name(text) {
        std::borrow::Cow::Borrowed(_) => render_tags(text, title),
        name => name,
    }
}

fn push_words(output: &mut String, text: &str) {
    for word in text.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(word);
    }
}

pub(crate) fn resolve_type(
    conn: &Connection,
    title: &str,
    title_key: &str,
    create: Option<TypeCreation>,
    created: &mut Vec<Revision>,
) -> Result<Option<String>> {
    let existing = conn
        .prepare_cached(
            "SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?1",
        )?
        .query_row([title_key], |row| row.get(0))
        .optional()?;
    let Some(create) = create.filter(|_| existing.is_none()) else {
        return Ok(existing);
    };
    let title = crate::notes::built_in_tag_name(title_key).unwrap_or(title);
    // A change creates a title's page at most once: the page stays live
    // until the batch's final cleanup.
    let id = match create.change_id {
        Some(change) => crate::notebook::derived_id(&["type-page", change, title_key]),
        None => crate::notebook::new_ulid().to_string(),
    };
    conn.prepare_cached(
        "INSERT INTO blocks(id, kind, page_id, ordinal, text, title_key, revision, created_at, updated_at)
         VALUES (?1, 'page', ?1, 1024, ?2, ?3, 1, ?4, ?4)",
    )?
    .execute(rusqlite::params![id, title, title_key, create.now])?;
    conn.prepare_cached("INSERT INTO provisional_pages(id) VALUES (?1)")?
        .execute([&id])?;
    derive_links(conn, &id, title)?;
    created.push(Revision {
        id: id.clone(),
        revision: 1,
    });
    Ok(Some(id))
}

impl crate::Notebook {
    /// Render canonical tags for text-only consumers without altering stored text.
    pub fn render_tag_text<'a>(&self, text: &'a str) -> Result<std::borrow::Cow<'a, str>> {
        let titles = self.live_tag_titles(text)?;
        Ok(render_tags(text, |id| {
            titles.get(id).and_then(Option::as_deref)
        }))
    }

    /// A root's display title for text-only consumers: exports and labels.
    pub fn display_title<'a>(&self, text: &'a str) -> Result<std::borrow::Cow<'a, str>> {
        let titles = self.live_tag_titles(text)?;
        Ok(display_title(text, |id| {
            titles.get(id).and_then(Option::as_deref)
        }))
    }

    fn live_tag_titles<'a>(
        &self,
        text: &'a str,
    ) -> Result<std::collections::HashMap<&'a str, Option<String>>> {
        let mut titles = std::collections::HashMap::new();
        for id in tag_tokens(text).filter_map(|token| token.id) {
            if let std::collections::hash_map::Entry::Vacant(entry) = titles.entry(id) {
                entry.insert(live_tag(&self.conn, id)?);
            }
        }
        Ok(titles)
    }
}
#[cfg(test)]
mod reference_tests {
    use super::{inline_code_spans, link_tokens, reference_parts, rewrite_links, tag_names};

    #[test]
    fn identity_keys_strip_only_tags_and_preserve_tag_only_titles() {
        let cases: Vec<(String, String)> =
            serde_json::from_str(include_str!("../tests/fixtures/title-keys.json")).unwrap();
        for (title, key) in cases {
            assert_eq!(super::title_key(&title), key, "{title:?}");
        }
    }

    #[test]
    fn canonical_and_legacy_tags_share_boundaries_and_code_shielding() {
        let id = "00000000000000000000000001";
        let text = format!(
            "#bare #[[Long title]] #[[A|B]] #[[{id}|Alias]] #[[{id}|]] `#[[{id}|Hidden]]` a/#no -#no e\u{301}#no"
        );
        let tokens = super::tag_tokens(&text)
            .map(|token| (token.id, token.title))
            .collect::<Vec<_>>();
        assert_eq!(
            tokens,
            [
                (None, "bare"),
                (None, "Long title"),
                (None, "A|B"),
                (Some(id), "Alias"),
                (Some(id), "")
            ]
        );
        assert_eq!(link_tokens(&text).count(), 0);
        for invalid in [format!("#[[{id}|a|b]]"), format!("#[[{id}|a\nb]]")] {
            assert!(super::tag_tokens(&invalid).next().is_none());
        }
        assert_eq!(
            super::render_tags(&format!("#[[{id}|Old]]"), |_| Some("New")),
            "#New"
        );
        assert_eq!(
            super::render_tags(&format!("#[[{id}|]]"), |_| None),
            format!("#{id}")
        );
        assert_eq!(
            super::display_title(&format!("  Lab  #[[{id}|project]] notes #plain "), |_| None),
            "Lab notes"
        );
        assert_eq!(
            super::display_title("Plain  title", |_| None),
            "Plain  title"
        );
        assert_eq!(
            super::display_title(&format!("#[[{id}|old]]"), |_| Some("Project")),
            "#Project"
        );
    }

    #[test]
    fn code_spans_shield_tags_links_and_rewrites_with_exact_backtick_runs() {
        let id = "00000000000000000000000001";
        for marker in ["`", "``", "```"] {
            let text = format!("{marker}#Hidden [[{id}]]{marker} #Visible [[{id}]]");
            assert_eq!(tag_names(&text).collect::<Vec<_>>(), ["Visible"]);
            assert_eq!(link_tokens(&text).count(), 1);
            assert_eq!(
                rewrite_links(&text, id, "00000000000000000000000002").unwrap(),
                format!("{marker}#Hidden [[{id}]]{marker} #Visible [[00000000000000000000000002]]")
            );
        }
        for text in [
            format!("`#Hidden [[{id}]]`"),
            format!("``#Hidden ` [[{id}]]``"),
            format!("`#Hidden `` [[{id}]]`"),
        ] {
            assert!(tag_names(&text).next().is_none());
            assert!(link_tokens(&text).next().is_none());
        }
        for marker in ["`", "``", "```"] {
            let text = format!("it{marker}s about #History [[{id}]]");
            assert!(inline_code_spans(&text).next().is_none());
            assert_eq!(tag_names(&text).collect::<Vec<_>>(), ["History"]);
            assert_eq!(link_tokens(&text).count(), 1);
        }
        for text in [
            "[[name|`label]] #Visible",
            "[label `code](https://example.org) #Visible",
            "https://example.org/`path #Visible",
            "#[[type `name]] #Visible",
        ] {
            assert!(inline_code_spans(text).next().is_none());
        }
    }

    #[test]
    fn labels_and_locators_split_at_the_first_and_last_pipe() {
        assert_eq!(reference_parts("target"), ("target", None, None));
        assert_eq!(
            reference_parts("target|label"),
            ("target", Some("label"), None)
        );
        assert_eq!(
            reference_parts("target|label|3.12"),
            ("target", Some("label"), Some("3.12"))
        );
        assert_eq!(
            reference_parts("target||3.12"),
            ("target", Some(""), Some("3.12"))
        );
        assert_eq!(
            reference_parts("target|a|b|3.12"),
            ("target", Some("a|b"), Some("3.12"))
        );
    }

    #[test]
    fn indexing_and_merge_keep_locator_references_intact() {
        let from = "00000000000000000000000001";
        let into = "00000000000000000000000002";
        let text = format!("[[{from}|a|b|3.12]] [[{from}||4]]");
        let tokens: Vec<_> = link_tokens(&text).collect();
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].target, from);
        assert_eq!(tokens[0].alias, Some("a|b"));
        assert_eq!(tokens[1].alias, Some(""));
        assert_eq!(
            crate::fields::reference(&format!("[[{from}||3.12]]")),
            Some(from)
        );
        assert_eq!(
            rewrite_links(&text, from, into).unwrap(),
            format!("[[{into}|a|b|3.12]] [[{into}||4]]")
        );
    }
}
