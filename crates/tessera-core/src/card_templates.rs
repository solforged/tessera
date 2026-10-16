use std::collections::{HashMap, HashSet};

use jiff::{Timestamp, tz::TimeZone};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::fields::{constrained_reading, definitions};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, validate_id, validation};
use crate::{
    BlockKind, CardUnit, Error, FieldDefinition, Notebook, Operation, Reading, ReadingValue,
    Result, Revision,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardTemplate {
    pub id: String,
    pub type_id: String,
    pub name: String,
    pub front: String,
    pub back: String,
    pub position: i64,
    pub applied: bool,
    pub new_per_day: u32,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardTemplateProvenance {
    pub id: String,
    pub name: String,
    pub type_id: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardTemplatePreview {
    pub member_id: String,
    pub member_text: String,
    pub front: String,
    pub back: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardTemplateWaiting {
    pub id: String,
    pub text: String,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardTemplateInfo {
    #[serde(flatten)]
    pub template: CardTemplate,
    pub front_display: String,
    pub back_display: String,
    pub ready: usize,
    pub waiting_total: usize,
    pub units_active: usize,
    pub missing: Vec<String>,
    pub preview: Option<CardTemplatePreview>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TemplateLoadDay {
    pub date: String,
    pub due: usize,
    pub added: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardTemplateForecast {
    pub members: usize,
    pub ready: usize,
    pub waiting_total: usize,
    pub waiting: Vec<CardTemplateWaiting>,
    pub existing_units: usize,
    pub cards_to_create: usize,
    pub new_per_day: u32,
    pub days_to_introduce: usize,
    pub last_day: Option<String>,
    pub load: Vec<TemplateLoadDay>,
}

const COLUMNS: &str = "id, type_id, name, front, back, position, applied, new_per_day, revision, created_at, updated_at";

fn template_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardTemplate> {
    Ok(CardTemplate {
        id: row.get(0)?,
        type_id: row.get(1)?,
        name: row.get(2)?,
        front: row.get(3)?,
        back: row.get(4)?,
        position: row.get(5)?,
        applied: row.get(6)?,
        new_per_day: row.get(7)?,
        revision: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub(crate) fn get(conn: &Connection, id: &str) -> Result<CardTemplate> {
    validate_id(id)?;
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM card_templates WHERE id = ?1"
    ))?
    .query_row([id], template_at)
    .optional()?
    .ok_or_else(|| not_found(id))
}

#[derive(Debug)]
enum Part<'a> {
    Literal(&'a str),
    Field(&'a str),
}

// Scan UTF-8 at ASCII delimiters. Escaped braces stay literal; field identity is never a name.
fn pattern(text: &str) -> Result<Vec<Part<'_>>> {
    let mut parts = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' && bytes.get(at + 1) == Some(&b'{') {
            parts.push(Part::Literal(&text[start..at]));
            parts.push(Part::Literal("{"));
            at += 2;
            start = at;
        } else if bytes[at] == b'{' {
            parts.push(Part::Literal(&text[start..at]));
            let end = text[at + 1..]
                .find('}')
                .map(|n| at + 1 + n)
                .ok_or_else(|| validation("unclosed field token"))?;
            let id = &text[at + 1..end];
            validate_id(id).map_err(|_| validation("patterns use field IDs inside braces"))?;
            parts.push(Part::Field(id));
            at = end + 1;
            start = at;
        } else {
            at += 1;
        }
    }
    parts.push(Part::Literal(&text[start..]));
    Ok(parts)
}

fn render(parts: &[Part<'_>], mut field: impl FnMut(&str) -> String) -> String {
    let mut text = String::new();
    for part in parts {
        match part {
            Part::Literal(literal) => text.push_str(literal),
            Part::Field(id) => text.push_str(&field(id)),
        }
    }
    text
}

fn validate(conn: &Connection, name: &str, front: &str, back: &str, limit: u32) -> Result<()> {
    if name.trim().is_empty() || name.chars().count() > 120 {
        return Err(validation("template name must contain 1 to 120 characters"));
    }
    if !(1..=9999).contains(&limit) {
        return Err(validation("new per day must be between 1 and 9999"));
    }
    for text in [front, back] {
        crate::storage::validate_text(BlockKind::Block, text)?;
        for part in pattern(text)? {
            if let Part::Field(id) = part {
                crate::fields::require_definition(conn, id)?;
            }
        }
    }
    Ok(())
}

/// The operation returns the affected type and template revision. Units reconcile at batch end.
pub(crate) fn apply(
    conn: &Connection,
    operation: &Operation,
    now: i64,
    index: usize,
) -> Result<(String, Revision)> {
    if let Operation::CreateCardTemplate {
        id,
        type_id,
        name,
        front,
        back,
        new_per_day,
    } = operation
    {
        validate_id(id)?;
        let owner = crate::storage::stored(conn, type_id)?.ok_or_else(|| not_found(type_id))?;
        if owner.block.kind != BlockKind::Page || owner.deletion_id.is_some() {
            return Err(validation("template type must be a live page"));
        }
        validate(conn, name, front, back, *new_per_day)?;
        if conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM card_templates WHERE id = ?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(validation("card template already exists"));
        }
        conn.execute("INSERT INTO card_templates(id, type_id, name, front, back, position, new_per_day, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position), -1) + 1 FROM card_templates WHERE type_id = ?2), ?6, 1, ?7, ?7)", params![id, type_id, name.trim(), front, back, new_per_day, now])?;
        return Ok((
            type_id.clone(),
            Revision {
                id: id.clone(),
                revision: 1,
            },
        ));
    }
    let (id, base) = match operation {
        Operation::UpdateCardTemplate {
            id, base_revision, ..
        }
        | Operation::SetCardTemplateApplied {
            id, base_revision, ..
        }
        | Operation::DeleteCardTemplate { id, base_revision } => (id, *base_revision),
        _ => unreachable!("template operation"),
    };
    let old = get(conn, id)?;
    if old.revision != base {
        return Err(Error::Conflict {
            op_index: index,
            id: id.clone(),
            expected: base,
            found: Some(old.revision),
        });
    }
    match operation {
        Operation::UpdateCardTemplate {
            name,
            front,
            back,
            new_per_day,
            ..
        } => {
            validate(conn, name, front, back, *new_per_day)?;
            conn.execute("UPDATE card_templates SET name = ?2, front = ?3, back = ?4, new_per_day = ?5, revision = revision + 1, updated_at = ?6 WHERE id = ?1", params![id, name.trim(), front, back, new_per_day, now])?;
        }
        Operation::SetCardTemplateApplied { applied, .. } => {
            if *applied {
                validate(conn, &old.name, &old.front, &old.back, old.new_per_day)?;
                if old.front.trim().is_empty() || old.back.trim().is_empty() {
                    return Err(validation("fill both patterns before enabling a template"));
                }
            }
            conn.execute("UPDATE card_templates SET applied = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1", params![id, applied, now])?;
        }
        Operation::DeleteCardTemplate { .. } => {
            conn.execute("DELETE FROM card_templates WHERE id = ?1", [id])?;
        }
        _ => unreachable!("template operation"),
    }
    Ok((
        old.type_id,
        Revision {
            id: id.clone(),
            revision: base + 1,
        },
    ))
}

struct Member {
    id: String,
    text: String,
    values: HashMap<String, String>,
}

/// One member read and one field-value read, independent of member count.
fn members(
    conn: &Connection,
    type_id: &str,
    only: Option<&str>,
    defs: &[FieldDefinition],
) -> Result<Vec<Member>> {
    let mut members = conn.prepare_cached(concat!(hidden_blocks!(),
        "SELECT b.id, b.text FROM blocks b WHERE b.deletion_id IS NULL
         AND b.rowid NOT IN (SELECT rowid FROM hidden)
         AND EXISTS(SELECT 1 FROM blocks t WHERE t.id = ?1 AND t.deletion_id IS NULL AND t.rowid NOT IN (SELECT rowid FROM hidden))
         AND EXISTS(SELECT 1 FROM memberships m WHERE m.block_id = b.id AND m.type_id = ?1)
         AND (?2 IS NULL OR b.id IN (SELECT value FROM json_each(?2)))
         ORDER BY b.created_at, b.id"))?
        .query_map(params![type_id, only], |row| Ok(Member { id: row.get(0)?, text: row.get(1)?, values: HashMap::new() }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if members.is_empty() {
        return Ok(members);
    }
    let ids = serde_json::to_string(&members.iter().map(|m| &m.id).collect::<Vec<_>>())
        .expect("member IDs serialize");
    let indices: HashMap<_, _> = members
        .iter()
        .enumerate()
        .map(|(i, m)| (m.id.clone(), i))
        .collect();
    let definitions: HashMap<_, _> = defs.iter().map(|d| (d.id.as_str(), d)).collect();
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        "SELECT f.owner_id, f.field_id, v.text, ",
        block_columns!("t"),
        " FROM field_values f JOIN blocks v ON v.id = f.value_id
          JOIN blocks e ON e.id = f.entry_id
          LEFT JOIN links l ON l.source_id = v.id AND l.occurrence = 0
          LEFT JOIN blocks t ON t.id = l.target_id AND t.deletion_id IS NULL
          WHERE f.owner_id IN (SELECT value FROM json_each(?1))
            AND v.deletion_id IS NULL AND v.rowid NOT IN (SELECT rowid FROM hidden)
          ORDER BY e.ordinal, e.id, f.ordinal, v.id"
    ))?;
    let mut cursor = statement.query([ids])?;
    while let Some(row) = cursor.next()? {
        let owner: String = row.get(0)?;
        let field: String = row.get(1)?;
        let text: String = row.get(2)?;
        if text.trim().is_empty() {
            continue;
        }
        let Some(def) = definitions.get(field.as_str()) else {
            continue;
        };
        let target = if matches!(row.get_ref(3)?, rusqlite::types::ValueRef::Null) {
            None
        } else {
            Some(block_at(row, 3)?)
        };
        let rendered = match constrained_reading(conn, def.kind, def, &text, target.as_ref())? {
            Reading::Value {
                value: ReadingValue::Text(value),
                target: Some(_),
                ..
            } => value,
            _ => text,
        };
        if rendered.trim().is_empty() {
            continue;
        }
        let value = members[indices[&owner]].values.entry(field).or_default();
        if !value.is_empty() {
            value.push_str(", ");
        }
        value.push_str(&rendered);
    }
    Ok(members)
}

fn references<'a>(front: &[Part<'a>], back: &[Part<'a>]) -> Vec<&'a str> {
    let mut fields = Vec::new();
    for part in front.iter().chain(back) {
        if let Part::Field(id) = part
            && !fields.contains(id)
        {
            fields.push(*id);
        }
    }
    fields
}

fn resolved(
    member: &Member,
    front: &[Part<'_>],
    back: &[Part<'_>],
    refs: &[&str],
) -> Option<(String, String)> {
    if refs.iter().any(|id| !member.values.contains_key(*id)) {
        return None;
    }
    let front = render(front, |id| member.values[id].clone());
    let back = render(back, |id| member.values[id].clone());
    if front.trim().is_empty() || back.trim().is_empty() {
        None
    } else {
        Some((front, back))
    }
}

/// Reconcile only affected owners, except template/type edits which reconcile that type in bulk.
/// All reads are batched; writes reuse prepared statements and never touch schedules on updates.
pub(crate) fn derive(
    conn: &Connection,
    owners: Option<&[String]>,
    types: Option<&[String]>,
    now: i64,
) -> Result<Vec<Revision>> {
    let types_set: HashSet<&str> = types
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect();
    let owners = owners.map(|ids| serde_json::to_string(ids).expect("owner IDs serialize"));
    let types = types.map(|ids| serde_json::to_string(ids).expect("type IDs serialize"));
    let templates = conn.prepare_cached(&format!("SELECT {COLUMNS} FROM card_templates t
        WHERE ?1 IS NULL OR type_id IN (SELECT value FROM json_each(?2))
          OR EXISTS(SELECT 1 FROM memberships m WHERE m.type_id = t.type_id AND m.block_id IN (SELECT value FROM json_each(?1)))
          OR EXISTS(SELECT 1 FROM card_units c WHERE c.key = 'tpl:' || t.id AND c.source_block_id IN (SELECT value FROM json_each(?1)))
        ORDER BY type_id, position, id"))?
        .query_map(params![owners, types], template_at)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let defs = if templates.is_empty() {
        Vec::new()
    } else {
        definitions(conn)?
    };
    let mut desired: HashMap<(String, String), (String, String)> = HashMap::new();
    for template in &templates {
        if !template.applied {
            continue;
        }
        let only = if types_set.contains(template.type_id.as_str()) {
            None
        } else {
            owners.as_deref()
        };
        let front = pattern(&template.front)?;
        let back = pattern(&template.back)?;
        let refs = references(&front, &back);
        let key = format!("tpl:{}", template.id);
        for member in members(conn, &template.type_id, only, &defs)? {
            if let Some(sides) = resolved(&member, &front, &back, &refs) {
                desired.insert((member.id, key.clone()), sides);
            }
        }
    }
    let template_keys: Vec<_> = templates
        .iter()
        .filter(|t| types_set.contains(t.type_id.as_str()))
        .map(|t| format!("tpl:{}", t.id))
        .collect();
    let keys = serde_json::to_string(&template_keys).expect("template keys serialize");
    // Orphan keys (deleted templates) are deactivated as well, without deleting retained history.
    let mut existing = conn.prepare_cached("SELECT id, source_block_id, key, active, front, back, revision FROM card_units
        WHERE key LIKE 'tpl:%' AND (?1 IS NULL OR source_block_id IN (SELECT value FROM json_each(?1))
          OR key IN (SELECT value FROM json_each(?2)) OR NOT EXISTS(SELECT 1 FROM card_templates t WHERE card_units.key = 'tpl:' || t.id))")?;
    let mut update = conn.prepare_cached("UPDATE card_units SET active = ?2, front = ?3, back = ?4, definition_revision = definition_revision + 1, revision = revision + 1, updated_at = ?5 WHERE id = ?1")?;
    let mut changed = Vec::new();
    let mut cursor = existing.query(params![owners, keys])?;
    while let Some(row) = cursor.next()? {
        let id: String = row.get(0)?;
        let source: String = row.get(1)?;
        let key: String = row.get(2)?;
        let active: bool = row.get(3)?;
        let front: String = row.get(4)?;
        let back: String = row.get(5)?;
        let sides = desired.remove(&(source, key));
        let (next_active, next_front, next_back) = match sides {
            Some((f, b)) => (true, f, b),
            None => (false, front.clone(), back.clone()),
        };
        if active == next_active && front == next_front && back == next_back {
            continue;
        }
        update.execute(params![id, next_active, next_front, next_back, now])?;
        changed.push(Revision {
            id,
            revision: row.get::<_, i64>(6)? + 1,
        });
    }
    if desired.is_empty() {
        changed.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        return Ok(changed);
    }
    let mut insert = conn.prepare_cached("INSERT INTO card_units(id, source_block_id, key, kind, active, definition_revision, front, back, revision, schedule, created_at, updated_at) VALUES (?1, ?2, ?3, 'forward', 1, 1, ?4, ?5, 1, ?6, ?7, ?7)")?;
    let schedule =
        serde_json::to_string(&crate::scheduler::new_card(now)).expect("schedule serializes");
    for ((source, key), (front, back)) in desired {
        let id = crate::notebook::derived_id(&["card", &source, &key]);
        insert.execute(params![id, source, key, front, back, schedule, now])?;
        changed.push(Revision { id, revision: 1 });
    }
    changed.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    Ok(changed)
}

pub(crate) fn provenance(conn: &Connection, cards: &mut [CardUnit]) -> Result<()> {
    crate::occlusion::hydrate_cards(conn, cards)?;
    let ids: Vec<_> = cards
        .iter()
        .filter_map(|c| c.key.strip_prefix("tpl:"))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut by_id: HashMap<String, CardTemplateProvenance> = conn.prepare_cached("SELECT t.id, t.name, t.type_id, b.text FROM card_templates t JOIN blocks b ON b.id = t.type_id WHERE t.id IN (SELECT value FROM json_each(?1))")?
        .query_map([serde_json::to_string(&ids).expect("template IDs serialize")], |row| { let id: String = row.get(0)?; Ok((id.clone(), CardTemplateProvenance { id, name: row.get(1)?, type_id: row.get(2)?, type_name: row.get(3)? })) })?.collect::<rusqlite::Result<_>>()?;
    for card in cards {
        if let Some(id) = card.key.strip_prefix("tpl:") {
            card.template = by_id.get_mut(id).map(|p| p.clone());
        }
    }
    Ok(())
}

pub(crate) fn local_day(conn: &Connection, now: i64) -> Result<(String, i64, i64)> {
    let zone: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'time_zone'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let zone = match zone {
        Some(name) => TimeZone::get(&name).map_err(|e| validation(e.to_string()))?,
        None => TimeZone::system(),
    };
    let day = Timestamp::from_millisecond(now)
        .map_err(|e| validation(e.to_string()))?
        .to_zoned(zone.clone())
        .date();
    let midnight = |day: jiff::civil::Date| -> Result<i64> {
        Ok(day
            .at(0, 0, 0, 0)
            .to_zoned(zone.clone())
            .map_err(|e| validation(e.to_string()))?
            .timestamp()
            .as_millisecond())
    };
    Ok((
        day.to_string(),
        midnight(day)?,
        midnight(
            day.checked_add(jiff::Span::new().days(1))
                .map_err(|e| validation(e.to_string()))?,
        )?,
    ))
}

impl Notebook {
    pub fn card_template(&self, id: &str) -> Result<CardTemplate> {
        get(&self.conn, id)
    }

    pub fn card_templates(&self, type_id: &str) -> Result<Vec<CardTemplateInfo>> {
        self.type_info(type_id)?;
        let templates = self
            .conn
            .prepare_cached(&format!(
                "SELECT {COLUMNS} FROM card_templates WHERE type_id = ?1 ORDER BY position, id"
            ))?
            .query_map([type_id], template_at)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let defs = definitions(&self.conn)?;
        let names: HashMap<_, _> = defs
            .iter()
            .map(|d| (d.id.as_str(), d.name.as_str()))
            .collect();
        let members = members(&self.conn, type_id, None, &defs)?;
        let counts: HashMap<String, usize> = self.conn.prepare_cached("SELECT c.key, COUNT(*) FROM card_units c JOIN card_templates t ON c.key = 'tpl:' || t.id WHERE t.type_id = ?1 AND c.active = 1 GROUP BY c.key")?.query_map([type_id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))?.collect::<rusqlite::Result<_>>()?;
        templates
            .into_iter()
            .map(|template| {
                let front = pattern(&template.front)?;
                let back = pattern(&template.back)?;
                let refs = references(&front, &back);
                let mut ready = 0;
                let mut preview = None;
                let mut missing: HashMap<&str, usize> = HashMap::new();
                for member in &members {
                    if let Some((front, back)) = resolved(member, &front, &back, &refs) {
                        ready += 1;
                        if preview.is_none() {
                            preview = Some(CardTemplatePreview {
                                member_id: member.id.clone(),
                                member_text: member.text.clone(),
                                front,
                                back,
                            });
                        }
                    } else {
                        for id in &refs {
                            if !member.values.contains_key(*id) {
                                *missing.entry(id).or_default() += 1;
                            }
                        }
                    }
                }
                let mut missing: Vec<_> = missing.into_iter().collect();
                missing.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
                let display = |parts: &[Part<'_>]| {
                    render(parts, |id| {
                        format!("{{{}}}", names.get(id).copied().unwrap_or(id))
                    })
                };
                Ok(CardTemplateInfo {
                    front_display: display(&front),
                    back_display: display(&back),
                    ready,
                    waiting_total: members.len() - ready,
                    units_active: counts
                        .get(&format!("tpl:{}", template.id))
                        .copied()
                        .unwrap_or(0),
                    missing: missing
                        .into_iter()
                        .map(|(id, _)| names.get(id).copied().unwrap_or(id).to_owned())
                        .collect(),
                    preview,
                    template,
                })
            })
            .collect()
    }

    pub fn card_template_forecast(
        &self,
        id: &str,
        days: usize,
        now: i64,
    ) -> Result<CardTemplateForecast> {
        if !(1..=365).contains(&days) {
            return Err(validation("forecast days must be between 1 and 365"));
        }
        let template = get(&self.conn, id)?;
        let defs = definitions(&self.conn)?;
        let names: HashMap<_, _> = defs
            .iter()
            .map(|d| (d.id.as_str(), d.name.as_str()))
            .collect();
        let members = members(&self.conn, &template.type_id, None, &defs)?;
        let front = pattern(&template.front)?;
        let back = pattern(&template.back)?;
        let refs = references(&front, &back);
        let retained: HashMap<String, bool> = self.conn.prepare_cached("SELECT source_block_id, held = 1 OR json_extract(schedule, '$.last_reviewed_at') IS NOT NULL FROM card_units WHERE key = ?1")?.query_map([format!("tpl:{id}")], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut waiting = Vec::new();
        let mut ready = 0;
        let mut cards_to_create = 0;
        let mut introductions = 0;
        for member in &members {
            if resolved(member, &front, &back, &refs).is_some() {
                ready += 1;
                if !retained.contains_key(&member.id) {
                    cards_to_create += 1;
                }
                if !retained.get(&member.id).copied().unwrap_or(false) {
                    introductions += 1;
                }
            } else if waiting.len() < 50 {
                waiting.push(CardTemplateWaiting {
                    id: member.id.clone(),
                    text: member.text.clone(),
                    missing: refs
                        .iter()
                        .filter(|id| !member.values.contains_key(**id))
                        .map(|id| names.get(*id).copied().unwrap_or(id).to_owned())
                        .collect(),
                });
            }
        }
        let (date, start, end) = local_day(&self.conn, now)?;
        let introduced = self
            .conn
            .prepare_cached(concat!(
                crate::review_store::review_pacing!(),
                "SELECT COALESCE((SELECT count FROM introduced WHERE key = ?4), 0)"
            ))?
            .query_row(
                params![None::<&str>, start, end, format!("tpl:{id}")],
                |row| row.get::<_, i64>(0),
            )? as usize;
        let limit = template.new_per_day as usize;
        let first = limit.saturating_sub(introduced);
        let days_to_introduce = if introductions == 0 {
            0
        } else if introductions <= first {
            1
        } else {
            1 + (introductions - first).div_ceil(limit)
        };
        let forecast = crate::review_store::forecast(&self.conn, None, &date, days, true)?;
        let mut remaining = introductions;
        let load = forecast
            .into_iter()
            .enumerate()
            .map(|(offset, day)| {
                let added = remaining.min(if offset == 0 { first } else { limit });
                remaining -= added;
                TemplateLoadDay {
                    date: day.date,
                    due: day.count,
                    added,
                }
            })
            .collect();
        Ok(CardTemplateForecast {
            members: members.len(),
            ready,
            waiting_total: members.len() - ready,
            waiting,
            existing_units: retained.len(),
            cards_to_create,
            new_per_day: template.new_per_day,
            days_to_introduce,
            last_day: if days_to_introduce == 0 {
                None
            } else {
                Some(crate::calendar::add_days(
                    &date,
                    days_to_introduce as i64 - 1,
                )?)
            },
            load,
        })
    }
}
