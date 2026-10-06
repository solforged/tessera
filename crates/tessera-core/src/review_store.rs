use rusqlite::{Connection, OptionalExtension, params};
use serde::de::{DeserializeOwned, value::StrDeserializer};

use crate::reads::hidden_blocks;
use crate::scheduler::{self, Grade, SchedulingState};
use crate::storage::{not_found, validate_id, validation};
use crate::{
    CardPreviews, CardUnit, Error, GradePreview, Notebook, Operation, Result, ReviewEvent,
    ReviewSession, ReviewSessionState, Revision,
};

#[derive(Default)]
pub(crate) struct ReviewChanges {
    pub cards: Vec<Revision>,
    pub sessions: Vec<ReviewSession>,
    pub decks: Vec<Revision>,
}

fn text_at<'a>(row: &'a rusqlite::Row<'_>, column: usize) -> rusqlite::Result<&'a str> {
    row.get_ref(column)?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn enum_at<T: DeserializeOwned>(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<T> {
    T::deserialize(StrDeserializer::<serde::de::value::Error>::new(text_at(
        row, column,
    )?))
    .map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn schedule_at(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<SchedulingState> {
    serde_json::from_str(text_at(row, column)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

// SELECT order: id, card_id, session_id, kind, grade, shown_front, shown_back,
// definition_revision, scheduler_version, before_state, after_state, created_at, change_seq.
pub(crate) fn review_event_at(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<ReviewEvent> {
    Ok(ReviewEvent {
        id: row.get(offset)?,
        card_id: row.get(offset + 1)?,
        session_id: row.get(offset + 2)?,
        kind: enum_at(row, offset + 3)?,
        grade: if matches!(row.get_ref(offset + 4)?, rusqlite::types::ValueRef::Null) {
            None
        } else {
            Some(enum_at(row, offset + 4)?)
        },
        shown_front: row.get(offset + 5)?,
        shown_back: row.get(offset + 6)?,
        definition_revision: row.get(offset + 7)?,
        scheduler_version: row.get(offset + 8)?,
        before: schedule_at(row, offset + 9)?,
        after: schedule_at(row, offset + 10)?,
        created_at: row.get(offset + 11)?,
        change_seq: row.get(offset + 12)?,
    })
}

fn session_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewSession> {
    Ok(ReviewSession {
        id: row.get(0)?,
        deck_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        state: enum_at(row, 4)?,
        revision: row.get(5)?,
    })
}

fn session(conn: &Connection, id: &str) -> Result<Option<ReviewSession>> {
    validate_id(id)?;
    Ok(conn
        .prepare_cached(
            "SELECT id, deck_id, started_at, ended_at, state, revision
             FROM review_sessions WHERE id = ?1",
        )?
        .query_row([id], session_at)
        .optional()?)
}

fn deck_revision(conn: &Connection, id: &str) -> Result<Option<i64>> {
    validate_id(id)?;
    Ok(conn
        .prepare_cached("SELECT revision FROM decks WHERE id = ?1")?
        .query_row([id], |row| row.get(0))
        .optional()?)
}

fn check_revision(id: &str, expected: i64, found: Option<i64>, index: usize) -> Result<()> {
    if found != Some(expected) {
        return Err(Error::Conflict {
            op_index: index,
            id: id.to_owned(),
            expected,
            found,
        });
    }
    Ok(())
}

fn next_revision(revision: i64) -> Result<i64> {
    revision
        .checked_add(1)
        .ok_or_else(|| validation("revision is exhausted"))
}

fn nonnegative(timestamp: i64) -> Result<()> {
    if timestamp < 0 {
        return Err(validation("review timestamps must be nonnegative"));
    }
    Ok(())
}

fn visible_card(conn: &Connection, card: &CardUnit) -> Result<()> {
    let visible: bool = conn
        .prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT EXISTS(
                 SELECT 1 FROM blocks b JOIN blocks p ON p.id = b.page_id
                 WHERE b.id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                 AND b.rowid NOT IN (SELECT rowid FROM hidden)
             )"
        ))?
        .query_row([&card.source_block_id], |row| row.get(0))?;
    if !card.active || !visible {
        return Err(validation(
            "card must have active syntax and a visible source",
        ));
    }
    Ok(())
}

fn checked_card(conn: &Connection, id: &str, expected: i64, index: usize) -> Result<CardUnit> {
    validate_id(id)?;
    let card = match crate::card_store::card(conn, id) {
        Ok(card) => card,
        Err(Error::NotFound { .. }) => {
            return Err(Error::Conflict {
                op_index: index,
                id: id.to_owned(),
                expected,
                found: None,
            });
        }
        Err(error) => return Err(error),
    };
    check_revision(id, expected, Some(card.revision), index)?;
    visible_card(conn, &card)?;
    Ok(card)
}

fn check_review_session(conn: &Connection, id: Option<&str>, reviewed_at: i64) -> Result<()> {
    nonnegative(reviewed_at)?;
    if let Some(id) = id {
        let current = session(conn, id)?.ok_or_else(|| not_found(id))?;
        if current.state != ReviewSessionState::Open {
            return Err(validation("review session is closed"));
        }
        if reviewed_at < current.started_at {
            return Err(validation("review precedes the session start"));
        }
    }
    Ok(())
}

fn grade_name(grade: Grade) -> &'static str {
    match grade {
        Grade::Again => "again",
        Grade::Hard => "hard",
        Grade::Good => "good",
        Grade::Easy => "easy",
    }
}

struct Evidence<'a> {
    id: &'a str,
    card: &'a CardUnit,
    session_id: Option<&'a str>,
    grade: Option<Grade>,
    before: &'a str,
    after: &'a str,
    reviewed_at: i64,
    seq: i64,
}

fn insert_event(conn: &Connection, evidence: Evidence<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO review_events(
             id, card_id, session_id, kind, grade, shown_front, shown_back,
             definition_revision, scheduler_version, before_state, after_state, created_at, change_seq
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            evidence.id,
            evidence.card.id,
            evidence.session_id,
            if evidence.grade.is_some() { "grade" } else { "reset" },
            evidence.grade.map(grade_name),
            evidence.card.front,
            evidence.card.back,
            evidence.card.definition_revision,
            scheduler::SCHEDULER_VERSION,
            evidence.before,
            evidence.after,
            evidence.reviewed_at,
            evidence.seq,
        ],
    )?;
    Ok(())
}

struct ReviewWrite<'a> {
    event_id: &'a str,
    session_id: Option<&'a str>,
    grade: Option<Grade>,
    reset: bool,
    reviewed_at: i64,
}

fn write_review(
    conn: &Connection,
    card: &CardUnit,
    review: ReviewWrite<'_>,
    now: i64,
    seq: i64,
) -> Result<Revision> {
    validate_id(review.event_id)?;
    check_review_session(conn, review.session_id, review.reviewed_at)?;
    let used: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM review_events WHERE id = ?1)")?
        .query_row([review.event_id], |row| row.get(0))?;
    if used {
        return Err(validation("review event ID is already used"));
    }
    let revision = next_revision(card.revision)?;
    let reset_state = review
        .reset
        .then(|| scheduler::new_card(review.reviewed_at));
    let before_grade = reset_state.as_ref().unwrap_or(&card.schedule);
    let before_json = serde_json::to_string(&card.schedule).expect("schedule serializes");
    let reset_json = reset_state
        .as_ref()
        .map(|state| serde_json::to_string(state).expect("schedule serializes"));
    let graded_json = review.grade.map(|grade| {
        serde_json::to_string(&scheduler::schedule(
            before_grade,
            grade,
            review.reviewed_at,
        ))
        .expect("schedule serializes")
    });
    if let Some(after) = reset_json.as_deref() {
        // The client event ID always identifies the grade when both are committed.
        let reset_id = review
            .grade
            .map(|_| crate::notebook::new_ulid().to_string());
        insert_event(
            conn,
            Evidence {
                id: reset_id.as_deref().unwrap_or(review.event_id),
                card,
                session_id: review.session_id,
                grade: None,
                before: &before_json,
                after,
                reviewed_at: review.reviewed_at,
                seq,
            },
        )?;
    }
    if let Some(after) = graded_json.as_deref() {
        insert_event(
            conn,
            Evidence {
                id: review.event_id,
                card,
                session_id: review.session_id,
                grade: review.grade,
                before: reset_json.as_deref().unwrap_or(&before_json),
                after,
                reviewed_at: review.reviewed_at,
                seq,
            },
        )?;
    }
    let after = graded_json
        .as_deref()
        .or(reset_json.as_deref())
        .expect("review grades or resets the schedule");
    conn.execute(
        "UPDATE card_units SET schedule = ?1, revision = ?2, updated_at = ?3 WHERE id = ?4",
        params![after, revision, now, card.id,],
    )?;
    Ok(Revision {
        id: card.id.clone(),
        revision,
    })
}

pub(crate) fn apply(
    conn: &Connection,
    operation: &Operation,
    now: i64,
    seq: i64,
    index: usize,
) -> Result<ReviewChanges> {
    if conn.is_autocommit() {
        return Err(validation("review writes require an operation transaction"));
    }
    let mut changes = ReviewChanges::default();
    match operation {
        Operation::StartReviewSession {
            id,
            deck_id,
            started_at,
        } => {
            nonnegative(*started_at)?;
            if session(conn, id)?.is_some() {
                return Err(validation("review session ID is already used"));
            }
            if let Some(deck_id) = deck_id {
                deck_revision(conn, deck_id)?.ok_or_else(|| not_found(deck_id))?;
            }
            conn.execute(
                "INSERT INTO review_sessions(id, deck_id, started_at, ended_at, state, revision)
                 VALUES (?1, ?2, ?3, NULL, 'open', 1)",
                params![id, deck_id, started_at],
            )?;
            changes.sessions.push(ReviewSession {
                id: id.clone(),
                deck_id: deck_id.clone(),
                started_at: *started_at,
                ended_at: None,
                state: ReviewSessionState::Open,
                revision: 1,
            });
        }
        Operation::FinishReviewSession {
            id,
            base_revision,
            state,
            ended_at,
        } => {
            let current = session(conn, id)?;
            check_revision(
                id,
                *base_revision,
                current.as_ref().map(|s| s.revision),
                index,
            )?;
            let mut current = current.expect("checked existing session");
            nonnegative(*ended_at)?;
            if *state == ReviewSessionState::Open {
                return Err(validation("review session must finish or be abandoned"));
            }
            if current.state == *state && current.ended_at == Some(*ended_at) {
                return Ok(changes);
            }
            if current.state != ReviewSessionState::Open {
                return Err(validation("review session is already closed"));
            }
            let latest_review: Option<i64> = conn
                .prepare_cached("SELECT MAX(created_at) FROM review_events WHERE session_id = ?1")?
                .query_row([id], |row| row.get(0))?;
            if *ended_at < current.started_at || latest_review.is_some_and(|at| at > *ended_at) {
                return Err(validation(
                    "session end precedes its start or a committed review",
                ));
            }
            let revision = next_revision(current.revision)?;
            let state_name = match state {
                ReviewSessionState::Finished => "finished",
                ReviewSessionState::Abandoned => "abandoned",
                ReviewSessionState::Open => unreachable!("validated terminal state"),
            };
            conn.execute(
                "UPDATE review_sessions SET ended_at = ?1, state = ?2, revision = ?3 WHERE id = ?4",
                params![ended_at, state_name, revision, id],
            )?;
            current.ended_at = Some(*ended_at);
            current.state = *state;
            current.revision = revision;
            changes.sessions.push(current);
        }
        Operation::GradeCard {
            id,
            base_revision,
            definition_revision,
            event_id,
            session_id,
            grade,
            reset,
            shown_front,
            shown_back,
            reviewed_at,
        } => {
            let card = checked_card(conn, id, *base_revision, index)?;
            if card.definition_revision != *definition_revision
                || card.front != *shown_front
                || card.back != *shown_back
            {
                return Err(validation("shown card definition is no longer current"));
            }
            changes.cards.push(write_review(
                conn,
                &card,
                ReviewWrite {
                    event_id,
                    session_id: session_id.as_deref(),
                    grade: Some(*grade),
                    reset: *reset,
                    reviewed_at: *reviewed_at,
                },
                now,
                seq,
            )?);
        }
        Operation::ResetCard {
            id,
            base_revision,
            event_id,
            session_id,
            reviewed_at,
        } => {
            let card = checked_card(conn, id, *base_revision, index)?;
            changes.cards.push(write_review(
                conn,
                &card,
                ReviewWrite {
                    event_id,
                    session_id: session_id.as_deref(),
                    grade: None,
                    reset: true,
                    reviewed_at: *reviewed_at,
                },
                now,
                seq,
            )?);
        }
        Operation::SaveDeck {
            id,
            base_revision,
            name,
            query,
        } => {
            let found = deck_revision(conn, id)?;
            if found != *base_revision {
                return Err(Error::Conflict {
                    op_index: index,
                    id: id.clone(),
                    expected: base_revision.unwrap_or(0),
                    found,
                });
            }
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 120 {
                return Err(validation("deck name must contain 1 to 120 characters"));
            }
            crate::card_query::validate(conn, query)?;
            let revision = next_revision(found.unwrap_or(0))?;
            conn.execute(
                "INSERT INTO decks(id, name, query, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query,
                     revision = excluded.revision, updated_at = excluded.updated_at",
                params![
                    id,
                    name,
                    serde_json::to_string(query).expect("query serializes"),
                    revision,
                    now
                ],
            )?;
            changes.decks.push(Revision {
                id: id.clone(),
                revision,
            });
        }
        Operation::DeleteDeck { id, base_revision } => {
            let found = deck_revision(conn, id)?;
            check_revision(id, *base_revision, found, index)?;
            let revision = next_revision(*base_revision)?;
            conn.execute("DELETE FROM decks WHERE id = ?1", [id])?;
            changes.decks.push(Revision {
                id: id.clone(),
                revision,
            });
        }
        _ => return Err(validation("operation is not a review or deck write")),
    }
    Ok(changes)
}

impl Notebook {
    /// Retained evidence, including cards whose syntax or source is no longer visible.
    pub fn review_events(&self, card_id: &str) -> Result<Vec<ReviewEvent>> {
        validate_id(card_id)?;
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, card_id, session_id, kind, grade, shown_front, shown_back,
                        definition_revision, scheduler_version, before_state, after_state,
                        created_at, change_seq
                 FROM review_events WHERE card_id = ?1 ORDER BY created_at, rowid",
            )?
            .query_map([card_id], |row| review_event_at(row, 0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn review_sessions(&self) -> Result<Vec<ReviewSession>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, deck_id, started_at, ended_at, state, revision
                 FROM review_sessions ORDER BY started_at, id",
            )?
            .query_map([], session_at)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn review_session(&self, id: &str) -> Result<ReviewSession> {
        session(&self.conn, id)?.ok_or_else(|| not_found(id))
    }

    pub fn card_previews(&self, id: &str, now: i64) -> Result<CardPreviews> {
        nonnegative(now)?;
        let card = crate::card_store::card(&self.conn, id)?;
        visible_card(&self.conn, &card)?;
        let to_preview = |(grade, schedule): (Grade, SchedulingState)| GradePreview {
            grade,
            interval_days: schedule.interval_days,
        };
        Ok(CardPreviews {
            current: scheduler::previews(&card.schedule, now)
                .into_iter()
                .map(to_preview)
                .collect(),
            reset: scheduler::previews(&scheduler::new_card(now), now)
                .into_iter()
                .map(to_preview)
                .collect(),
        })
    }
}
