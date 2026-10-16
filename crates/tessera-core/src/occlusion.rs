use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::card_text::{CardKind, ParsedCard};
use crate::storage::validation;
use crate::{BlockCapabilities, ImageRef, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcclusionMode {
    HideOne,
    HideAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaskShape {
    Rect,
    Ellipse,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcclusionGroup {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Rect>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcclusionMask {
    pub id: String,
    pub group: String,
    pub shape: MaskShape,
    #[serde(flatten)]
    pub rect: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Occlusion {
    pub mode: OcclusionMode,
    pub groups: Vec<OcclusionGroup>,
    pub masks: Vec<OcclusionMask>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardMask {
    pub shape: MaskShape,
    #[serde(flatten)]
    pub rect: Rect,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OcclusionFront<I = ImageRef, H = String> {
    pub image: I,
    pub mode: OcclusionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Rect>,
    pub tested: Vec<CardMask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<H>,
    pub covered: Vec<CardMask>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OcclusionBack<A = String> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<A>,
}

fn invalid(reason: &str) -> crate::Error {
    validation(format!("These masks are not valid: {reason}."))
}

fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

fn valid_rect(rect: &Rect) -> bool {
    [rect.x, rect.y, rect.w, rect.h]
        .iter()
        .all(|n| n.is_finite())
        && rect.x >= 0.0
        && rect.y >= 0.0
        && rect.w >= 0.005
        && rect.h >= 0.005
        && rect.x + rect.w <= 1.0
        && rect.y + rect.h <= 1.0
}

fn normalize_text(value: &mut Option<String>) -> Result<()> {
    if let Some(text) = value {
        let trimmed = text.trim();
        if trimmed.chars().count() > 200 {
            return Err(invalid("a hint or answer is longer than 200 characters"));
        }
        if trimmed.is_empty() {
            *value = None;
        } else if trimmed.len() != text.len() {
            *text = trimmed.to_owned();
        }
    }
    Ok(())
}

fn normalize(mut state: Occlusion) -> Result<Occlusion> {
    if state.groups.len() > 100 || state.masks.len() > 300 {
        return Err(invalid("there are more than 100 groups or 300 masks"));
    }
    let mut groups = HashMap::with_capacity(state.groups.len());
    for group in &mut state.groups {
        if !valid_id(&group.id) || groups.insert(group.id.as_str(), 0).is_some() {
            return Err(invalid(
                "group identifiers must be unique letters, numbers, underscores or dashes",
            ));
        }
        normalize_text(&mut group.hint)?;
        normalize_text(&mut group.answer)?;
        if group.area.as_ref().is_some_and(|area| !valid_rect(area)) {
            return Err(invalid("an area lies outside the image or is too small"));
        }
    }
    let mut masks = HashSet::with_capacity(state.masks.len());
    for mask in &state.masks {
        if !valid_id(&mask.id) || !masks.insert(&mask.id) {
            return Err(invalid(
                "mask identifiers must be unique letters, numbers, underscores or dashes",
            ));
        }
        let count = groups
            .get_mut(mask.group.as_str())
            .ok_or_else(|| invalid("a mask has no group"))?;
        *count += 1;
        if !valid_rect(&mask.rect) {
            return Err(invalid("a mask lies outside the image or is too small"));
        }
    }
    if groups.values().any(|count| *count == 0) {
        return Err(invalid("a group has no masks"));
    }
    Ok(state)
}

pub(crate) fn set(conn: &Connection, id: &str, state: Option<&Occlusion>) -> Result<bool> {
    let Some(state) = state else {
        return Ok(conn
            .prepare_cached("DELETE FROM occlusions WHERE block_id = ?1")?
            .execute([id])?
            != 0);
    };
    let image: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM images WHERE block_id = ?1 AND active = 1)")?
        .query_row([id], |row| row.get(0))?;
    if !image {
        return Err(validation("Add an image before drawing masks."));
    }
    let state =
        serde_json::to_string(&normalize(state.clone())?).expect("validated masks serialize");
    Ok(conn.prepare_cached("INSERT INTO occlusions(block_id, state) VALUES (?1, ?2) ON CONFLICT(block_id) DO UPDATE SET state = excluded.state WHERE occlusions.state != excluded.state")?.execute(params![id, state])? != 0)
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    let ids: Vec<_> = capabilities
        .iter()
        .map(|cap| cap.block_id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(capabilities);
    }
    let mut states: HashMap<String, String> = conn.prepare_cached("SELECT block_id, state FROM occlusions WHERE block_id IN (SELECT value FROM json_each(?1))")?
        .query_map([serde_json::to_string(&ids).expect("IDs serialize")], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    for cap in &mut capabilities {
        cap.occlusion = states
            .remove(&cap.block_id)
            .map(|state| serde_json::from_str(&state))
            .transpose()
            .map_err(|_| invalid("stored masks cannot be read"))?;
    }
    Ok(capabilities)
}

pub(crate) fn derive(conn: &Connection, id: &str) -> Result<Vec<ParsedCard>> {
    let data = conn.prepare_cached("SELECT o.state, i.sha256, i.media_type, i.width, i.height FROM occlusions o JOIN images i ON i.block_id = o.block_id AND i.active = 1 WHERE o.block_id = ?1")?
        .query_row([id], |row| Ok((row.get::<_, String>(0)?, crate::image_store::at(row, 1)?.expect("active image")))).optional()?;
    let Some((state, image)) = data else {
        return Ok(Vec::new());
    };
    let state: Occlusion =
        serde_json::from_str(&state).map_err(|_| invalid("stored masks cannot be read"))?;
    state
        .groups
        .iter()
        .map(|group| {
            let mut tested = Vec::new();
            let mut covered = Vec::new();
            for mask in &state.masks {
                let target = if mask.group == group.id {
                    &mut tested
                } else if state.mode == OcclusionMode::HideAll {
                    &mut covered
                } else {
                    continue;
                };
                target.push(CardMask {
                    shape: mask.shape,
                    rect: mask.rect,
                });
            }
            Ok(ParsedCard {
                key: format!("occlusion:{}", group.id),
                kind: CardKind::Occlusion,
                front: serde_json::to_string(&OcclusionFront {
                    image: &image,
                    mode: state.mode,
                    area: group.area,
                    tested,
                    hint: group.hint.as_deref(),
                    covered,
                })
                .expect("card front serializes"),
                back: serde_json::to_string(&OcclusionBack {
                    answer: group.answer.as_deref(),
                })
                .expect("card back serializes"),
            })
        })
        .collect()
}

pub fn group_letter(mut index: usize) -> String {
    let mut letters = Vec::new();
    loop {
        letters.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    letters.reverse();
    String::from_utf8(letters).expect("ASCII letters")
}

pub fn card_subject(card: &crate::CardUnit) -> String {
    if card.kind == CardKind::Occlusion {
        serde_json::from_str::<OcclusionBack>(&card.back)
            .ok()
            .and_then(|back| back.answer)
            .unwrap_or_else(|| format!("Mask {}", group_letter(card.occlusion_index.unwrap_or(0))))
    } else if matches!(card.kind, CardKind::Reverse | CardKind::Cloze) {
        card.back.clone()
    } else {
        card.front.clone()
    }
}

pub(crate) fn hydrate_cards(conn: &Connection, cards: &mut [crate::CardUnit]) -> Result<()> {
    let ids: HashSet<_> = cards
        .iter()
        .filter(|card| card.kind == CardKind::Occlusion)
        .map(|card| card.source_block_id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut groups: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let mut statement = conn.prepare_cached("SELECT o.block_id, json_extract(g.value, '$.id'), CAST(g.key AS INTEGER) FROM occlusions o, json_each(o.state, '$.groups') g WHERE o.block_id IN (SELECT value FROM json_each(?1))")?;
    let mut rows = statement.query([serde_json::to_string(&ids).expect("IDs serialize")])?;
    while let Some(row) = rows.next()? {
        groups
            .entry(row.get(0)?)
            .or_default()
            .insert(row.get(1)?, row.get::<_, i64>(2)? as usize);
    }
    for card in cards {
        card.occlusion_index = card
            .key
            .strip_prefix("occlusion:")
            .and_then(|id| groups.get(&card.source_block_id)?.get(id).copied());
    }
    Ok(())
}
