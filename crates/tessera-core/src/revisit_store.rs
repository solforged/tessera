//! Note state and authored revisit history; questions keep their single review date.
use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::calendar::{add_days, days_between, validate_civil_date};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    Actor, BlockCapabilities, BlockInPage, Notebook, Operation, QuestionState, QuestionStatus,
    Result,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteState {
    pub resolved_at: Option<i64>,
    pub revisit_on: Option<String>,
    pub date_set_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisitSnapshot {
    pub note: NoteState,
    pub question: Option<QuestionState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisitAction {
    Revisited,
    Later,
    Resolve,
    Reopen,
    KeepRecurrent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisitEvent {
    pub id: String,
    pub block_id: String,
    pub revisited_on: String,
    pub next_on: Option<String>,
    pub created_at: i64,
    pub change_seq: i64,
    pub actor: Actor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisitRow {
    pub block: BlockInPage,
    pub note: NoteState,
    pub question_status: Option<QuestionStatus>,
    pub revisit_on: String,
    pub last_revisited_on: Option<String>,
    pub proposed_on: String,
}

pub(crate) fn snapshot(conn: &Connection, id: &str) -> Result<RevisitSnapshot> {
    let note = conn
        .prepare_cached(
            "SELECT resolved_at, revisit_on, date_set_at FROM note_states WHERE block_id = ?1",
        )?
        .query_row([id], |r| {
            Ok(NoteState {
                resolved_at: r.get(0)?,
                revisit_on: r.get(1)?,
                date_set_at: r.get(2)?,
            })
        })
        .optional()?
        .unwrap_or_default();
    let question: Option<String> = conn
        .prepare_cached("SELECT state FROM questions WHERE block_id = ?1 AND active = 1")?
        .query_row([id], |r| r.get(0))
        .optional()?;
    Ok(RevisitSnapshot {
        note,
        question: question
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|error| validation(error.to_string()))?,
    })
}

fn store(conn: &Connection, id: &str, note: &NoteState) -> Result<()> {
    if note == &NoteState::default() {
        conn.execute("DELETE FROM note_states WHERE block_id = ?1", [id])?;
    } else {
        conn.execute("INSERT INTO note_states(block_id, resolved_at, revisit_on, date_set_at) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(block_id) DO UPDATE SET resolved_at = excluded.resolved_at, revisit_on = excluded.revisit_on, date_set_at = excluded.date_set_at",
            params![id, note.resolved_at, note.revisit_on, note.date_set_at])?;
    }
    Ok(())
}

pub(crate) fn question_changed(
    conn: &Connection,
    id: &str,
    before: &RevisitSnapshot,
    now: i64,
) -> Result<()> {
    let after = snapshot(conn, id)?;
    let mut note = after.note;
    if before.question.as_ref().and_then(|q| q.review_on.as_ref())
        != after.question.as_ref().and_then(|q| q.review_on.as_ref())
    {
        note.date_set_at = after
            .question
            .as_ref()
            .and_then(|q| q.review_on.as_ref())
            .map(|_| now);
    }
    if after.question.is_some() {
        note.revisit_on = None;
    }
    store(conn, id, &note)?;
    Ok(())
}

pub(crate) fn apply(conn: &Connection, operation: &Operation, now: i64, seq: i64) -> Result<bool> {
    match operation {
        Operation::Revisit {
            id,
            action,
            next_on,
            event_id,
            ..
        } => {
            if let Some(date) = next_on {
                validate_civil_date(date)?;
            }
            let mut state = snapshot(conn, id)?;
            let page: bool = conn.query_row(
                "SELECT kind = 'page' AND title_key <> 'fields' FROM blocks WHERE id = ?1",
                [id],
                |r| r.get(0),
            )?;
            if !page && state.question.is_none() {
                return Err(validation("Choose a titled note or a question."));
            }
            if *action == RevisitAction::KeepRecurrent && state.question.is_none() {
                return Err(validation("Only a question can be recurrent."));
            }
            let records_event = matches!(
                action,
                RevisitAction::Revisited | RevisitAction::KeepRecurrent
            );
            if records_event != event_id.is_some() {
                return Err(validation("A completed revisit needs one event ID."));
            }
            let previous = state.clone();
            if *action == RevisitAction::Reopen {
                state.note.resolved_at = None;
            } else {
                let date = if *action == RevisitAction::Resolve {
                    None
                } else {
                    next_on.clone()
                };
                if let Some(question) = &mut state.question {
                    question.review_on = date;
                    if *action == RevisitAction::Resolve {
                        question.unsettled = false;
                    }
                    if *action == RevisitAction::KeepRecurrent {
                        question.unsettled = true;
                    }
                    state.note.revisit_on = None;
                } else {
                    state.note.revisit_on = date;
                    if *action == RevisitAction::Resolve {
                        state.note.resolved_at = Some(now);
                    }
                }
                state.note.date_set_at = state
                    .question
                    .as_ref()
                    .and_then(|q| q.review_on.as_ref())
                    .or(state.note.revisit_on.as_ref())
                    .map(|_| now);
            }
            store(conn, id, &state.note)?;
            if let Some(question) = &state.question {
                crate::question_store::apply(
                    conn,
                    &Operation::SetQuestion {
                        id: id.clone(),
                        base_revision: 0,
                        question: Some(question.clone()),
                    },
                    &crate::settings::today_in_connection(conn, now)?,
                )?;
            }
            if let Some(event_id) = event_id {
                validate_id(event_id)?;
                conn.execute("INSERT INTO revisit_events(id, block_id, revisited_on, next_on, created_at, change_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![event_id, id, date_at(conn, now)?, next_on, now, seq])?;
            }
            Ok(state != previous || records_event)
        }
        Operation::RestoreRevisit {
            id,
            state,
            event_id,
            ..
        } => {
            let page: bool = conn.query_row(
                "SELECT kind = 'page' AND title_key <> 'fields' FROM blocks WHERE id = ?1",
                [id],
                |r| r.get(0),
            )?;
            if !page && state.question.is_none() {
                return Err(validation("Choose a titled note or a question."));
            }
            if state.question.is_some() && state.note.revisit_on.is_some() {
                return Err(validation("A question has one revisit date."));
            }
            if let Some(date) = &state.note.revisit_on {
                validate_civil_date(date)?;
            }
            store(conn, id, &state.note)?;
            crate::question_store::apply(
                conn,
                &Operation::SetQuestion {
                    id: id.clone(),
                    base_revision: 0,
                    question: state.question.clone(),
                },
                &crate::settings::today_in_connection(conn, now)?,
            )?;
            if let Some(event_id) = event_id {
                let changed = conn.execute("UPDATE revisit_events SET undone = 1 WHERE id = ?1 AND block_id = ?2 AND undone = 0", params![event_id, id])?;
                if changed == 0 {
                    return Err(validation(
                        "The revisit was already undone or belongs to another note.",
                    ));
                }
            }
            Ok(true)
        }
        _ => Err(validation("This operation does not change a revisit.")),
    }
}

fn date_at(conn: &Connection, now: i64) -> Result<String> {
    let zone: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'time_zone'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let zone = zone
        .map(|name| jiff::tz::TimeZone::get(&name))
        .transpose()
        .map_err(|e| validation(e.to_string()))?
        .unwrap_or_else(jiff::tz::TimeZone::system);
    Ok(jiff::Timestamp::from_millisecond(now)
        .map_err(|e| validation(e.to_string()))?
        .to_zoned(zone)
        .date()
        .to_string())
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    let ids: Vec<_> = capabilities.iter().map(|c| c.block_id.as_str()).collect();
    let mut notes: HashMap<String, (NoteState, bool)> = conn
        .prepare_cached(
            "SELECT n.block_id, n.resolved_at, n.revisit_on, n.date_set_at,
        EXISTS(SELECT 1 FROM blocks b WHERE b.page_id = n.block_id AND b.updated_at > n.resolved_at)
        FROM note_states n WHERE n.block_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map(
            [serde_json::to_string(&ids).expect("block IDs serialize")],
            |r| {
                Ok((
                    r.get(0)?,
                    (
                        NoteState {
                            resolved_at: r.get(1)?,
                            revisit_on: r.get(2)?,
                            date_set_at: r.get(3)?,
                        },
                        r.get(4)?,
                    ),
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    for capability in &mut capabilities {
        if let Some((note, changed)) = notes.remove(&capability.block_id) {
            capability.note = Some(note);
            capability.note_changed = changed;
        }
    }
    Ok(capabilities)
}

impl Notebook {
    pub fn revisits(&self, due: &str, now: i64) -> Result<Vec<RevisitRow>> {
        let today = self.today(now)?;
        let due = if due == "today" { today.as_str() } else { due };
        validate_civil_date(due)?;
        let mut statement = self.conn.prepare_cached(concat!(hidden_blocks!(), " SELECT ", block_columns!("b"), ", ", block_columns!("root"), ",
            CASE WHEN q.active = 1 THEN json_extract(q.state, '$.review_on') ELSE n.revisit_on END AS due_on,
            (SELECT revisited_on FROM revisit_events e WHERE e.block_id = b.id AND undone = 0 ORDER BY created_at DESC, change_seq DESC, id DESC LIMIT 1)
            FROM blocks b JOIN blocks root ON root.id = b.page_id
            LEFT JOIN note_states n ON n.block_id = b.id LEFT JOIN questions q ON q.block_id = b.id
            WHERE b.deletion_id IS NULL AND root.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
            AND (q.active = 1 OR b.kind = 'page') AND b.title_key IS NOT 'fields'
            AND NOT (q.active = 1 AND COALESCE(json_extract(q.state, '$.parked'), 0) = 1)
            AND due_on <= ?1 ORDER BY due_on, b.id"))?;
        let rows = statement
            .query_map([due], |r| {
                Ok((
                    BlockInPage {
                        block: block_at(r, 0)?,
                        page: block_at(r, 10)?,
                    },
                    r.get::<_, String>(20)?,
                    r.get::<_, Option<String>>(21)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let ids: Vec<_> = rows
            .iter()
            .map(|(block, _, _)| block.block.id.clone())
            .collect();
        let mut capabilities: HashMap<_, _> =
            crate::task_store::capabilities_for(&self.conn, &ids)?
                .into_iter()
                .map(|c| (c.block_id.clone(), c))
                .collect();
        let mut result = Vec::with_capacity(rows.len());
        for (block, revisit_on, last_revisited_on) in rows {
            let capability = capabilities
                .remove(&block.block.id)
                .expect("queue block hydrated");
            let note = capability.note.unwrap_or_default();
            let anchor = match &last_revisited_on {
                Some(date) => date.clone(),
                None => date_at(
                    &self.conn,
                    note.date_set_at.unwrap_or(block.block.updated_at),
                )?,
            };
            let interval = days_between(&anchor, &today)?.max(1);
            let proposed_on = add_days(&today, interval)?;
            let question_status = capability.question.map(|q| q.status);
            result.push(RevisitRow {
                block,
                note,
                question_status,
                revisit_on,
                last_revisited_on,
                proposed_on,
            });
        }
        Ok(result)
    }

    pub fn revisit_events(&self, id: &str) -> Result<Vec<RevisitEvent>> {
        validate_id(id)?;
        Ok(self.conn.prepare_cached("SELECT e.id, e.block_id, e.revisited_on, e.next_on, e.created_at, e.change_seq, c.actor FROM revisit_events e JOIN changes c ON c.seq = e.change_seq WHERE e.block_id = ?1 AND e.undone = 0 ORDER BY e.created_at, e.change_seq, e.id")?
            .query_map([id], |r| { let actor: String = r.get(6)?; Ok(RevisitEvent { id: r.get(0)?, block_id: r.get(1)?, revisited_on: r.get(2)?, next_on: r.get(3)?, created_at: r.get(4)?, change_seq: r.get(5)?, actor: serde_json::from_str(&actor).map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e)))? }) })?.collect::<rusqlite::Result<_>>()?)
    }
}
