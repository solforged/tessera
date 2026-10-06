use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::card_text::{CardKind, parse_card_text};
use crate::scheduler;
use crate::storage::{not_found, validate_id, validation};
use crate::{CardUnit, Notebook, Result, Revision};

fn text_at<'row>(row: &'row rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<&'row str> {
    row.get_ref(offset)?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn kind_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CardKind> {
    match text_at(row, offset)? {
        "forward" => Ok(CardKind::Forward),
        "reverse" => Ok(CardKind::Reverse),
        "cloze" => Ok(CardKind::Cloze),
        kind => Err(rusqlite::Error::FromSqlConversionFailure(
            offset,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid stored card kind: {kind}"),
            )),
        )),
    }
}

fn kind_name(kind: CardKind) -> &'static str {
    match kind {
        CardKind::Forward => "forward",
        CardKind::Reverse => "reverse",
        CardKind::Cloze => "cloze",
    }
}

/// Ten columns shared by direct, queue and review reads: id, source_block_id,
/// key, kind, active, definition_revision, front, back, revision, schedule.
pub(crate) fn card_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CardUnit> {
    let schedule = serde_json::from_str(text_at(row, offset + 9)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset + 9,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(CardUnit {
        id: row.get(offset)?,
        source_block_id: row.get(offset + 1)?,
        key: row.get(offset + 2)?,
        kind: kind_at(row, offset + 3)?,
        active: row.get(offset + 4)?,
        definition_revision: row.get(offset + 5)?,
        front: row.get(offset + 6)?,
        back: row.get(offset + 7)?,
        revision: row.get(offset + 8)?,
        schedule,
    })
}

pub(crate) fn card(conn: &Connection, id: &str) -> Result<CardUnit> {
    validate_id(id)?;
    conn.prepare_cached(
        "SELECT id, source_block_id, key, kind, active, definition_revision,
                front, back, revision, schedule FROM card_units WHERE id = ?1",
    )?
    .query_row([id], |row| card_at(row, 0))
    .optional()?
    .ok_or_else(|| not_found(id))
}

// Derivation does not need to read or deserialize schedules. Only new units
// acquire one; definition updates cannot overwrite an existing schedule.
struct Definition {
    id: String,
    kind: CardKind,
    active: bool,
    front: String,
    back: String,
    revision: i64,
}

pub(crate) fn derive_sources(conn: &Connection, ids: &[String], now: i64) -> Result<Vec<Revision>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = serde_json::to_string(ids).expect("source IDs serialize");
    let mut existing: HashMap<String, HashMap<String, Definition>> = HashMap::new();
    let mut definitions = conn.prepare_cached(
        "SELECT c.source_block_id, c.key, c.id, c.kind, c.active, c.front, c.back, c.revision
         FROM card_units c JOIN blocks b ON b.id = c.source_block_id
         WHERE b.kind = 'block' AND b.id IN (SELECT value FROM json_each(?1))",
    )?;
    let mut rows = definitions.query([&ids])?;
    while let Some(row) = rows.next()? {
        existing.entry(row.get(0)?).or_default().insert(
            row.get(1)?,
            Definition {
                id: row.get(2)?,
                kind: kind_at(row, 3)?,
                active: row.get(4)?,
                front: row.get(5)?,
                back: row.get(6)?,
                revision: row.get(7)?,
            },
        );
    }
    drop(rows);

    let mut sources = conn.prepare_cached(
        "SELECT id, text FROM blocks
         WHERE kind = 'block' AND id IN (SELECT value FROM json_each(?1)) ORDER BY id",
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO card_units
         (id, source_block_id, key, kind, active, definition_revision,
          front, back, revision, schedule, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?6, 1, ?7, ?8, ?8)",
    )?;
    let mut update = conn.prepare_cached(
        "UPDATE card_units SET kind = ?2, active = 1, front = ?3, back = ?4,
         definition_revision = definition_revision + 1, revision = revision + 1,
         updated_at = ?5 WHERE id = ?1",
    )?;
    let mut deactivate = conn.prepare_cached(
        "UPDATE card_units SET active = 0, definition_revision = definition_revision + 1,
         revision = revision + 1, updated_at = ?2 WHERE id = ?1",
    )?;
    let mut changed = Vec::new();
    let mut initial_schedule = None;
    let mut rows = sources.query([&ids])?;
    while let Some(row) = rows.next()? {
        let source_id = text_at(row, 0)?;
        let parsed = parse_card_text(text_at(row, 1)?);
        let mut previous = existing.remove(source_id).unwrap_or_default();
        for parsed in parsed.cards {
            if let Some(old) = previous.remove(&parsed.key) {
                if old.active
                    && old.kind == parsed.kind
                    && old.front == parsed.front
                    && old.back == parsed.back
                {
                    continue;
                }
                update.execute(params![
                    old.id,
                    kind_name(parsed.kind),
                    parsed.front,
                    parsed.back,
                    now,
                ])?;
                changed.push(Revision {
                    id: old.id,
                    revision: old.revision + 1,
                });
            } else {
                let id = crate::notebook::new_ulid().to_string();
                let schedule = initial_schedule.get_or_insert_with(|| {
                    serde_json::to_string(&scheduler::new_card(now))
                        .expect("new card schedule serializes")
                });
                insert.execute(params![
                    id,
                    source_id,
                    parsed.key,
                    kind_name(parsed.kind),
                    parsed.front,
                    parsed.back,
                    schedule.as_str(),
                    now,
                ])?;
                changed.push(Revision { id, revision: 1 });
            }
        }
        for old in previous.into_values().filter(|old| old.active) {
            deactivate.execute(params![old.id, now])?;
            changed.push(Revision {
                id: old.id,
                revision: old.revision + 1,
            });
        }
    }
    changed.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    Ok(changed)
}

pub(crate) fn rebuild(conn: &Connection, now: i64) -> Result<()> {
    let ids = conn
        .prepare_cached("SELECT id FROM blocks WHERE kind = 'block' ORDER BY id")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    derive_sources(conn, &ids, now)?;
    Ok(())
}

fn reviewed(conn: &Connection, source_id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM card_units c
         JOIN review_events e ON e.card_id = c.id WHERE c.source_block_id = ?1)",
        )?
        .query_row([source_id], |row| row.get(0))?)
}

pub(crate) fn guard_merge(conn: &Connection, source_id: &str) -> Result<()> {
    if reviewed(conn, source_id)? {
        return Err(validation(
            "this block has card review history and cannot be merged away",
        ));
    }
    Ok(())
}

pub(crate) fn guard_split(conn: &Connection, id: &str, left: &str, right: &str) -> Result<()> {
    // The engine checks that left + right is exactly the current source. An end
    // split leaves every definition on its existing identity, reviewed or not.
    if right.is_empty() {
        return Ok(());
    }
    let mut statement = conn.prepare_cached("SELECT text FROM blocks WHERE id = ?1")?;
    let parsed = statement
        .query_row([id], |row| Ok(parse_card_text(text_at(row, 0)?)))
        .optional()?
        .ok_or_else(|| not_found(id))?;
    // Inspect current text, not derived rows: earlier operations in this same
    // batch can have changed syntax before the final derivation pass.
    if parsed.cards.is_empty() {
        return Ok(());
    }
    if !left.is_empty() {
        return Err(validation(
            "split at the end of the card text to keep it on one block",
        ));
    }
    if reviewed(conn, id)? {
        return Err(validation(
            "reviewed cards must stay on their original block",
        ));
    }
    Ok(())
}

impl Notebook {
    /// All retained units, including inactive syntax and hidden/deleted sources.
    pub fn source_cards(&self, id: &str) -> Result<Vec<CardUnit>> {
        validate_id(id)?;
        let exists: bool = self
            .conn
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1)")?
            .query_row([id], |row| row.get(0))?;
        if !exists {
            return Err(not_found(id));
        }
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, source_block_id, key, kind, active, definition_revision,
                    front, back, revision, schedule FROM card_units
             WHERE source_block_id = ?1 ORDER BY key, id",
            )?
            .query_map([id], |row| card_at(row, 0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Read a retained card without applying queue visibility rules.
    pub fn card(&self, id: &str) -> Result<CardUnit> {
        card(&self.conn, id)
    }
}

#[cfg(test)]
mod tests {
    use super::{derive_sources, rebuild};
    use crate::scheduler::{Grade, new_card};
    use crate::{Actor, Batch, Notebook, Operation, Revision};

    #[test]
    fn derivation_is_scoped_and_rebuild_preserves_hidden_definitions_and_progress() {
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |value: u128| ulid::Ulid::from(value).to_string();
        let batch = |operations| Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        };
        let insert = |value, text: &str| Operation::Insert {
            id: id(value),
            parent_id: id(1),
            after: None,
            text: text.into(),
            heading: None,
        };
        nb.apply(&batch(vec![
            Operation::CreatePage {
                id: id(1),
                title: "title>>not a card".into(),
            },
            insert(10, "front>>back"),
            insert(11, "archived plain text"),
            insert(12, "deleted plain text"),
            Operation::SetArchived {
                id: id(11),
                base_revision: 1,
                archived: true,
            },
            Operation::Delete {
                id: id(12),
                base_revision: 1,
            },
        ]))
        .unwrap();
        let card = nb.source_cards(&id(10)).unwrap().pop().unwrap();
        nb.apply(&batch(vec![Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(100),
            session_id: None,
            grade: Grade::Good,
            reset: false,
            shown_front: card.front,
            shown_back: card.back,
            reviewed_at: card.schedule.due_at + 1_000,
        }]))
        .unwrap();
        let reviewed = nb.card(&card.id).unwrap();
        let evidence = nb.review_events(&card.id).unwrap();

        // Seed unindexed authored text as an old database would contain it.
        // A local derivation must not discover unrelated stale definitions.
        nb.conn
            .execute(
                "UPDATE blocks SET text = 'changed>>back' WHERE id IN (?1, ?2, ?3)",
                [id(10), id(11), id(12)],
            )
            .unwrap();
        let changed = derive_sources(&nb.conn, &[id(11), id(1)], 500).unwrap();
        let archived = nb.source_cards(&id(11)).unwrap().pop().unwrap();
        assert_eq!(
            changed,
            vec![Revision {
                id: archived.id.clone(),
                revision: 1
            }]
        );
        assert!(archived.active);
        assert_eq!(archived.front, "changed");
        assert_eq!(archived.schedule, new_card(500));
        assert!(nb.source_cards(&id(1)).unwrap().is_empty());
        assert!(nb.source_cards(&id(12)).unwrap().is_empty());
        assert_eq!(nb.card(&reviewed.id).unwrap(), reviewed);
        assert!(derive_sources(&nb.conn, &[], 600).unwrap().is_empty());
        assert!(derive_sources(&nb.conn, &[id(11)], 600).unwrap().is_empty());

        rebuild(&nb.conn, 700).unwrap();
        let updated = nb.card(&reviewed.id).unwrap();
        assert_eq!(updated.front, "changed");
        assert_eq!(updated.id, reviewed.id);
        assert_eq!(updated.revision, reviewed.revision + 1);
        assert_eq!(
            updated.definition_revision,
            reviewed.definition_revision + 1
        );
        assert_eq!(updated.schedule, reviewed.schedule);
        let deleted = nb.source_cards(&id(12)).unwrap().pop().unwrap();
        assert!(deleted.active);
        assert_eq!(deleted.front, "changed");
        assert_eq!(deleted.schedule, new_card(700));
        assert_eq!(nb.card(&archived.id).unwrap(), archived);
        assert!(nb.source_cards(&id(1)).unwrap().is_empty());
        assert_eq!(nb.review_events(&reviewed.id).unwrap(), evidence);
        rebuild(&nb.conn, 800).unwrap();
        assert_eq!(nb.card(&updated.id).unwrap(), updated);
        assert_eq!(nb.card(&archived.id).unwrap(), archived);
        assert_eq!(nb.card(&deleted.id).unwrap(), deleted);
    }
}
