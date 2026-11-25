use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::storage::validate_date;
use crate::{Block, BlockKind, FieldDefinition, FieldKind, Reading, ReadingValue, Result};

use super::{SOURCE_TARGET, reference};

fn number(text: &str) -> Option<f64> {
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

struct AllowedTargets {
    valid_ids: HashSet<String>,
    problem: String,
}

pub(crate) struct ReadingContext<'a> {
    conn: &'a Connection,
    texts: HashMap<String, Option<String>>,
    allowed: HashMap<String, AllowedTargets>,
}

impl<'a> ReadingContext<'a> {
    pub(crate) fn new(conn: &'a Connection) -> Self {
        Self {
            conn,
            texts: HashMap::new(),
            allowed: HashMap::new(),
        }
    }

    pub(crate) fn target_label(&mut self, text: &str) -> String {
        let conn = self.conn;
        let texts = &mut self.texts;
        target_label(text, &mut |id| {
            if let Some(cached) = texts.get(id) {
                return cached.clone();
            }
            let fetched = conn
                .prepare_cached("SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL")
                .ok()
                .and_then(|mut statement| {
                    statement
                        .query_row([id], |row| row.get::<_, String>(0))
                        .optional()
                        .ok()
                        .flatten()
                });
            texts.insert(id.to_owned(), fetched.clone());
            fetched
        })
    }

    fn allowed_targets(&mut self, definition: &FieldDefinition) -> Result<&AllowedTargets> {
        if !self.allowed.contains_key(&definition.id) {
            let targets = serde_json::json!(definition.targets).to_string();
            let links_sources = definition
                .targets
                .iter()
                .any(|target| target == SOURCE_TARGET);
            let valid_ids: HashSet<String> = self
                .conn
                .prepare_cached(
                    "WITH RECURSIVE target_types(id) AS (
                         SELECT ty.id FROM blocks ty
                         WHERE ty.id IN (SELECT value FROM json_each(?1))
                           AND ty.deletion_id IS NULL AND ty.archived = 0
                         UNION
                         SELECT b.id FROM memberships m
                         JOIN target_types tt ON m.type_id = tt.id
                         JOIN blocks ty ON ty.id = tt.id
                         JOIN blocks b ON b.id = m.block_id
                         WHERE b.kind = 'page' AND b.parent_id IS NULL
                           AND b.deletion_id IS NULL AND b.archived = 0
                           AND (
                               (ty.kind = 'page' AND ty.parent_id IS NULL
                                AND ty.title_key IN ('person', 'group', 'concept', 'thesis'))
                               OR EXISTS (SELECT 1 FROM memberships sub WHERE sub.type_id = b.id)
                           )
                     )
                     SELECT m.block_id FROM memberships m
                     JOIN target_types ty ON ty.id = m.type_id
                     UNION
                     SELECT p.block_id FROM projects p
                     WHERE p.active = 1
                       AND EXISTS (
                           SELECT 1 FROM target_types ty
                           JOIN blocks b ON b.id = ty.id
                           WHERE b.kind = 'page' AND b.title_key = 'project'
                       )
                     UNION
                     SELECT s.block_id FROM sources s
                     WHERE s.active = 1 AND ?2 != 0",
                )?
                .query_map(params![&targets, links_sources], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let names = self
                .conn
                .prepare_cached(
                    "SELECT COALESCE(b.text, t.value) FROM json_each(?1) t
                     LEFT JOIN blocks b ON b.id = t.value ORDER BY t.key",
                )?
                .query_map([&targets], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            self.allowed.insert(
                definition.id.clone(),
                AllowedTargets {
                    valid_ids,
                    problem: format!("Not a {}", names.join(" or ").to_lowercase()),
                },
            );
        }
        Ok(&self.allowed[&definition.id])
    }

    pub(crate) fn read(
        &mut self,
        kind: FieldKind,
        definition: &FieldDefinition,
        text: &str,
        target: Option<&Block>,
    ) -> Result<Reading> {
        // A creator or contributor may be a plain name rather than a linked person or group; only a
        // reference keeps the relation's reading. A kind preview still reads the name for mapping.
        if kind == FieldKind::Instance
            && definition.kind == FieldKind::Instance
            && crate::built_in::creator_tier(definition, 0).is_some()
            && reference(text).is_none()
            && !text.trim().is_empty()
        {
            return Ok(Reading::Value {
                ok: true,
                value: ReadingValue::Text(text.trim().to_owned()),
                target: None,
            });
        }
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
            *label = self.target_label(label);
        }
        if definition.targets.is_empty() {
            return Ok(reading);
        }
        if let Reading::Value {
            target: Some(id), ..
        } = &reading
        {
            let allowed = self.allowed_targets(definition)?;
            if !allowed.valid_ids.contains(id) {
                return Ok(Reading::Problem {
                    ok: false,
                    problem: allowed.problem.clone(),
                });
            }
        }
        Ok(reading)
    }
}

pub(crate) fn constrained_reading(
    conn: &Connection,
    kind: FieldKind,
    definition: &FieldDefinition,
    text: &str,
    target: Option<&Block>,
) -> Result<Reading> {
    ReadingContext::new(conn).read(kind, definition, text, target)
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
