use jiff::{Timestamp, civil::Date, tz::TimeZone};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::{DeserializeOwned, value::StrDeserializer};

use crate::reads::hidden_blocks;
use crate::scheduler::{self, Grade, SchedulingState};
use crate::storage::{not_found, validate_id, validation};
use crate::{
    CardPreviews, CardUnit, Error, GradePreview, Notebook, Operation, Result, ReviewEvent,
    ReviewSession, ReviewSessionState, Revision,
};

#[derive(Debug, Clone, Serialize)]
pub struct ReviewForecastDay {
    pub date: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewStats {
    pub date: String,
    pub due_review: usize,
    pub due_new: usize,
    pub forecast: Vec<ReviewForecastDay>,
    pub retention: Option<f64>,
    pub reviews_this_week: usize,
    pub streak: usize,
    pub total_cards: usize,
    pub held_cards: usize,
}

// Shared visible inventory and stable scoped introduction order. ?1 is the
// optional JSON source scope; introduction consumption is notebook-wide.
macro_rules! review_eligible {
    () => {
        concat!(
            crate::reads::hidden_blocks!(),
            ", visible_cards AS MATERIALIZED (
                SELECT c.id, c.key, c.held, c.source_block_id, t.new_per_day,
                    c.created_at, b.created_at AS source_created_at, b.id AS source_id,
                    json_extract(c.schedule, '$.due_at') AS due_at,
                    json_extract(c.schedule, '$.last_reviewed_at') IS NULL AS is_new
                FROM card_units c JOIN blocks b ON b.id = c.source_block_id
                JOIN blocks p ON p.id = b.page_id
                LEFT JOIN card_templates t ON c.key = 'tpl:' || t.id
                WHERE c.active = 1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                    AND b.rowid NOT IN (SELECT rowid FROM hidden)
            ), eligible AS MATERIALIZED (
                SELECT * FROM visible_cards WHERE held = 0
                    AND (?1 IS NULL OR source_block_id IN (SELECT value FROM json_each(?1)))
            ) "
        )
    };
}

// ?2..?3 are civil-day bounds, not a fixed 24-hour interval.
macro_rules! review_pacing {
    () => {
        concat!(
            crate::review_store::review_eligible!(),
            ", first_reviews AS MATERIALIZED (
                SELECT c.key, c.id, MIN(e.created_at) AS first_at
                FROM card_units c JOIN effective_review_events e ON e.card_id = c.id
                WHERE c.key LIKE 'tpl:%' AND c.held = 0 AND e.kind = 'grade'
                GROUP BY c.id
            ), introduced AS (
                SELECT key, COUNT(*) AS count FROM first_reviews
                WHERE first_at >= ?2 AND first_at < ?3 GROUP BY key
            ), ranked AS MATERIALIZED (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY key, is_new
                    ORDER BY due_at, created_at, source_created_at, source_id, id
                ) AS new_position FROM eligible
            ), paced AS (
                SELECT c.* FROM ranked c LEFT JOIN introduced i ON i.key = c.key
                WHERE NOT c.is_new OR c.new_per_day IS NULL
                    OR c.new_position <= MAX(0, c.new_per_day - COALESCE(i.count, 0))
            ) "
        )
    };
}

pub(crate) use {review_eligible, review_pacing};

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

fn schedule_at(
    row: &rusqlite::Row<'_>,
    column: usize,
) -> rusqlite::Result<crate::ReviewSchedulingState> {
    serde_json::from_str(text_at(row, column)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// Reconstruct memory from immutable grades, including reset events. Never infer
/// FSRS state from ease or copy old intervals. Equal timestamps retain row order.
pub(crate) fn backfill_fsrs(conn: &Connection) -> Result<()> {
    let mut cards = conn.prepare("SELECT id, created_at FROM card_units ORDER BY id")?;
    let mut history = conn.prepare(
        "SELECT grade, created_at FROM effective_review_events WHERE card_id = ?1 ORDER BY created_at, change_seq, event_order, id",
    )?;
    let mut update = conn.prepare("UPDATE card_units SET schedule = ?2 WHERE id = ?1")?;
    let mut rows = cards.query([])?;
    while let Some(row) = rows.next()? {
        let id = text_at(row, 0)?;
        let mut state = scheduler::new_card(row.get(1)?);
        let mut events = history.query([id])?;
        while let Some(event) = events.next()? {
            let at = event.get(1)?;
            state = if matches!(event.get_ref(0)?, rusqlite::types::ValueRef::Null) {
                scheduler::new_card(at)
            } else {
                scheduler::schedule(&state, enum_at(event, 0)?, at)
            };
        }
        update.execute(params![
            id,
            serde_json::to_string(&state).expect("schedule serializes")
        ])?;
    }
    Ok(())
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
        undone_by: None,
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

// Reserve adjacent slots for an optional reset and its grade in one operation.
fn grade_order(index: usize) -> Result<i64> {
    i64::try_from(index)
        .ok()
        .and_then(|index| index.checked_mul(2))
        .and_then(|order| order.checked_add(2))
        .ok_or_else(|| validation("review operation order is exhausted"))
}

/// Recover order from replicated commands, never from device-local rowids.
/// The partial index bounds this work to migration/old-patch insertions only.
pub(crate) fn backfill_event_order(conn: &Connection) -> Result<()> {
    let mut changes = conn.prepare_cached(
        "SELECT c.seq, o.key, json_extract(o.value, '$.op'),
             json_extract(o.value, '$.id'), json_extract(o.value, '$.event_id'),
             COALESCE(json_extract(o.value, '$.reset'), 0)
         FROM changes c JOIN json_each(c.operations) o
         WHERE c.seq IN (SELECT change_seq FROM review_events WHERE event_order = 0)
             AND json_extract(o.value, '$.op') IN ('grade_card', 'reset_card')
         ORDER BY c.seq, o.key",
    )?;
    let mut update = conn.prepare_cached(
        "UPDATE review_events SET event_order = ?4
         WHERE id = ?1 AND card_id = ?2 AND change_seq = ?3 AND event_order = 0",
    )?;
    let mut rows = changes.query([])?;
    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let order = grade_order(row.get(1)?)?;
        let is_grade = text_at(row, 2)? == "grade_card";
        let card_id = text_at(row, 3)?;
        let event_id = text_at(row, 4)?;
        if is_grade && row.get::<_, bool>(5)? {
            let reset_id = crate::notebook::derived_id(&["reset", event_id]);
            update.execute(params![reset_id, card_id, seq, order - 1])?;
        }
        update.execute(params![event_id, card_id, seq, if is_grade { order } else { order - 1 }])?;
    }
    let unresolved: Option<String> = conn.prepare_cached(
        "SELECT id FROM review_events WHERE event_order = 0 LIMIT 1",
    )?.query_row([], |row| row.get(0)).optional()?;
    if let Some(id) = unresolved {
        return Err(validation(format!("review event {id} has no retained operation")));
    }
    Ok(())
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
    event_order: i64,
}

fn insert_event(conn: &Connection, evidence: Evidence<'_>) -> Result<()> {
    let used: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM review_events WHERE id = ?1)
                 OR EXISTS(SELECT 1 FROM review_undos WHERE id = ?1)",
        )?
        .query_row([evidence.id], |row| row.get(0))?;
    if used {
        return Err(validation("review event ID is already used"));
    }
    conn.execute(
        "INSERT INTO review_events(
             id, card_id, session_id, kind, grade, shown_front, shown_back,
             definition_revision, scheduler_version, before_state, after_state, created_at, change_seq,
             event_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            evidence.event_order,
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
    index: usize,
) -> Result<Revision> {
    validate_id(review.event_id)?;
    check_review_session(conn, review.session_id, review.reviewed_at)?;
    let revision = next_revision(card.revision)?;
    let order = grade_order(index)?;
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
            .map(|_| crate::notebook::derived_id(&["reset", review.event_id]));
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
                event_order: order - 1,
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
                event_order: order,
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
                .prepare_cached(
                    "SELECT MAX(at) FROM (
                        SELECT created_at AS at FROM review_events WHERE session_id = ?1
                        UNION ALL
                        SELECT u.undone_at FROM review_undos u JOIN review_events e ON e.id = u.review_id
                        WHERE e.session_id = ?1
                    )",
                )?
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
            visible_card(conn, &card)?;
            if card.held {
                return Err(validation("held cards cannot be graded"));
            }
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
                index,
            )?);
        }
        Operation::UndoGrade {
            id,
            base_revision,
            review_id,
            event_id,
            session_revision,
            undone_at,
        } => {
            nonnegative(*undone_at)?;
            validate_id(review_id)?;
            validate_id(event_id)?;
            let card = checked_card(conn, id, *base_revision, index)?;
            let latest = conn.prepare_cached(
                "SELECT id, card_id, session_id, kind, grade, shown_front, shown_back,
                    definition_revision, scheduler_version, before_state, after_state,
                    created_at, change_seq
                 FROM effective_review_events WHERE card_id = ?1
                 ORDER BY change_seq DESC, event_order DESC, id DESC LIMIT 1",
            )?.query_row([id], |row| review_event_at(row, 0)).optional()?;
            let review = latest.filter(|event| event.id == *review_id && event.grade.is_some())
                .ok_or_else(|| validation("only the latest effective grade can be undone"))?;
            if *undone_at < review.created_at {
                return Err(validation("undo precedes its grade"));
            }
            let used: bool = conn.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM review_events WHERE id = ?1)
                    OR EXISTS(SELECT 1 FROM review_undos WHERE id = ?1)",
            )?.query_row([event_id], |row| row.get(0))?;
            if used {
                return Err(validation("review event ID is already used"));
            }
            if let Some(session_id) = review.session_id.as_deref() {
                let expected = session_revision
                    .ok_or_else(|| validation("undo requires the review session revision"))?;
                let current = session(conn, session_id)?;
                check_revision(session_id, expected, current.as_ref().map(|s| s.revision), index)?;
                let mut current = current.expect("checked existing session");
                if current.state == ReviewSessionState::Abandoned {
                    return Err(validation("abandoned review sessions cannot be reopened"));
                }
                let latest: Option<String> = conn.prepare_cached(
                    "SELECT id FROM effective_review_events
                     WHERE session_id = ?1 AND kind = 'grade'
                     ORDER BY change_seq DESC, event_order DESC, id DESC LIMIT 1",
                )?.query_row([session_id], |row| row.get(0)).optional()?;
                if latest.as_deref() != Some(review_id.as_str()) {
                    return Err(validation("only the latest effective session grade can be undone"));
                }
                current.revision = next_revision(current.revision)?;
                current.state = ReviewSessionState::Open;
                current.ended_at = None;
                conn.execute(
                    "UPDATE review_sessions SET state = 'open', ended_at = NULL, revision = ?2
                     WHERE id = ?1",
                    params![session_id, current.revision],
                )?;
                changes.sessions.push(current);
            } else if session_revision.is_some() {
                return Err(validation("standalone undo must not include a session revision"));
            }
            let restored = match review.before {
                crate::ReviewSchedulingState::Fsrs(state) => state,
                crate::ReviewSchedulingState::Legacy { .. } => {
                    // Old evidence stays in its original scheduler format. Match the
                    // migration's FSRS replay, without the corrected final grade.
                    let created_at = conn.query_row(
                        "SELECT created_at FROM card_units WHERE id = ?1", [id], |row| row.get(0),
                    )?;
                    let mut state = scheduler::new_card(created_at);
                    let mut history = conn.prepare_cached(
                        "SELECT grade, created_at FROM effective_review_events
                         WHERE card_id = ?1 AND id <> ?2 ORDER BY created_at, change_seq, event_order, id",
                    )?;
                    let mut rows = history.query(params![id, review_id])?;
                    while let Some(row) = rows.next()? {
                        state = if matches!(row.get_ref(0)?, rusqlite::types::ValueRef::Null) {
                            scheduler::new_card(row.get(1)?)
                        } else {
                            scheduler::schedule(&state, enum_at(row, 0)?, row.get(1)?)
                        };
                    }
                    state
                }
            };
            conn.execute(
                "INSERT INTO review_undos(id, review_id, undone_at, change_seq) VALUES (?1, ?2, ?3, ?4)",
                params![event_id, review_id, undone_at, seq],
            )?;
            let revision = next_revision(card.revision)?;
            conn.execute(
                "UPDATE card_units SET schedule = ?2, revision = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, serde_json::to_string(&restored).expect("schedule serializes"), revision, now],
            )?;
            changes.cards.push(Revision { id: id.clone(), revision });
        }
        Operation::SetCardHeld {
            id,
            base_revision,
            held,
        } => {
            let card = checked_card(conn, id, *base_revision, index)?;
            if !card.active {
                return Err(validation("inactive cards cannot be held or released"));
            }
            if card.held != *held {
                let revision = next_revision(card.revision)?;
                conn.execute(
                    "UPDATE card_units SET held = ?1, revision = ?2, updated_at = ?3 WHERE id = ?4",
                    params![held, revision, now, id],
                )?;
                changes.cards.push(Revision {
                    id: id.clone(),
                    revision,
                });
            }
        }
        Operation::ResetCard {
            id,
            base_revision,
            event_id,
            session_id,
            reviewed_at,
        } => {
            let card = checked_card(conn, id, *base_revision, index)?;
            visible_card(conn, &card)?;
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
                index,
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

/// Shared civil-day forecast. Template Apply excludes unreviewed cards from existing load.
pub(crate) fn forecast(
    conn: &Connection,
    source_ids: Option<&str>,
    date: &str,
    days: usize,
    reviewed_only: bool,
) -> Result<Vec<ReviewForecastDay>> {
    let zone: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'time_zone'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let zone = match zone {
        Some(name) => TimeZone::get(&name).map_err(|error| validation(error.to_string()))?,
        None => TimeZone::system(),
    };
    let midnight = |label: &str| -> Result<i64> {
        let date: Date = label
            .parse()
            .map_err(|error: jiff::Error| validation(error.to_string()))?;
        Ok(date
            .at(0, 0, 0, 0)
            .to_zoned(zone.clone())
            .map_err(|error| validation(error.to_string()))?
            .timestamp()
            .as_millisecond())
    };
    let bounds: Vec<_> = (0..days).map(|offset| {
        let label = crate::calendar::add_days(date, offset as i64)?;
        let through = crate::calendar::add_days(date, offset as i64 + 1)?;
        Ok(serde_json::json!({ "date": label, "from": midnight(&label)?, "through": midnight(&through)? }))
    }).collect::<Result<_>>()?;
    Ok(conn
        .prepare_cached(concat!(
            review_pacing!(),
            ", days AS MATERIALIZED (
                SELECT key AS day, json_extract(value, '$.date') AS date,
                    json_extract(value, '$.from') AS start,
                    json_extract(value, '$.through') AS end
                FROM json_each(?4)
            ), demand AS MATERIALIZED (
                SELECT d.day, c.key, MAX(0, c.new_per_day - (
                    SELECT COUNT(*) FROM first_reviews f
                    WHERE f.key = c.key AND f.first_at >= d.start AND f.first_at < d.end
                )) AS capacity, COUNT(*) FILTER (WHERE c.due_at < d.end) AS available
                FROM days d CROSS JOIN eligible c
                WHERE NOT ?5 AND c.is_new AND c.new_per_day IS NOT NULL
                GROUP BY d.day, c.key
            ), allocations(day, key, taken, total) AS (
                SELECT day, key, MIN(capacity, available), MIN(capacity, available)
                FROM demand WHERE day = 0
                UNION ALL
                SELECT d.day, d.key, MIN(d.capacity, MAX(0, d.available - a.total)),
                    a.total + MIN(d.capacity, MAX(0, d.available - a.total))
                FROM allocations a JOIN demand d ON d.day = a.day + 1 AND d.key = a.key
            )
            SELECT d.date, COUNT(c.id) + COALESCE((
                SELECT SUM(a.taken) FROM allocations a WHERE a.day = d.day
            ), 0)
            FROM days d LEFT JOIN eligible c
                ON c.due_at < d.end AND (d.day = 0 OR c.due_at >= d.start)
                AND (NOT c.is_new OR (NOT ?5 AND c.new_per_day IS NULL))
            GROUP BY d.day ORDER BY d.day"
        ))?
        .query_map(
            params![
                source_ids,
                midnight(date)?,
                midnight(&crate::calendar::add_days(date, 1)?)?,
                serde_json::to_string(&bounds).expect("day bounds serialize"),
                reviewed_only
            ],
            |row| {
                Ok(ReviewForecastDay {
                    date: row.get(0)?,
                    count: row.get::<_, i64>(1)? as usize,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

impl Notebook {
    /// Local civil-day statistics use the same notebook timezone as Agenda and resurfacing.
    /// Deck scope is its source predicate, not its queue selection or display limit.
    pub fn review_stats(&self, deck_id: Option<&str>, date: &str) -> Result<ReviewStats> {
        crate::calendar::validate_civil_date(date)?;
        let zone = TimeZone::get(&self.settings_view(crate::now_ms())?.time_zone)
            .map_err(|error| validation(error.to_string()))?;
        let day: Date = date
            .parse()
            .map_err(|error: jiff::Error| validation(error.to_string()))?;
        let midnight = |label: &str| -> Result<i64> {
            let date: Date = label
                .parse()
                .map_err(|error: jiff::Error| validation(error.to_string()))?;
            Ok(date
                .at(0, 0, 0, 0)
                .to_zoned(zone.clone())
                .map_err(|error| validation(error.to_string()))?
                .timestamp()
                .as_millisecond())
        };
        let source_ids = if let Some(deck_id) = deck_id {
            let deck = self.deck(deck_id)?;
            deck.query
                .source
                .as_ref()
                .map(|source| {
                    self.query_all_sources(source).map(|result| {
                        serde_json::to_string(
                            &result
                                .rows
                                .iter()
                                .map(|row| &row.block.block.id)
                                .collect::<Vec<_>>(),
                        )
                        .expect("source IDs serialize")
                    })
                })
                .transpose()?
        } else {
            None
        };
        let start = midnight(date)?;
        let end = midnight(&crate::calendar::add_days(date, 1)?)?;
        let week =
            crate::calendar::add_days(date, -i64::from(day.weekday().to_monday_zero_offset()))?;
        let week_start = midnight(&week)?;
        let recent_start = midnight(&crate::calendar::add_days(date, -29)?)?;
        let (due_review, due_new, total_cards, held_cards) = self
            .conn
            .prepare_cached(concat!(
                review_pacing!(),
                "SELECT COUNT(*) FILTER (WHERE due_at < ?3 AND NOT is_new),
                    COUNT(*) FILTER (WHERE due_at < ?3 AND is_new),
                    (SELECT COUNT(*) FROM eligible),
                    (SELECT COUNT(*) FROM visible_cards WHERE held = 1
                        AND (?1 IS NULL OR source_block_id IN (SELECT value FROM json_each(?1))))
                 FROM paced"
            ))?
            .query_row(params![source_ids, start, end], |row| {
                Ok((
                    row.get::<_, i64>(0)? as usize,
                    row.get::<_, i64>(1)? as usize,
                    row.get::<_, i64>(2)? as usize,
                    row.get::<_, i64>(3)? as usize,
                ))
            })?;
        let forecast = forecast(&self.conn, source_ids.as_deref(), date, 14, false)?;
        let (recent, retained, reviews_this_week): (usize, usize, usize) = self
            .conn
            .prepare_cached(concat!(
                review_eligible!(),
                "SELECT COUNT(*) FILTER (WHERE e.created_at >= ?2),
                    COUNT(*) FILTER (WHERE e.created_at >= ?2 AND e.grade <> 'again'),
                    COUNT(*) FILTER (WHERE e.created_at >= ?3)
             FROM effective_review_events e JOIN eligible c ON c.id = e.card_id
             WHERE e.kind = 'grade' AND e.created_at < ?4"
            ))?
            .query_row(params![source_ids, recent_start, week_start, end], |row| {
                Ok((
                    row.get::<_, i64>(0)? as usize,
                    row.get::<_, i64>(1)? as usize,
                    row.get::<_, i64>(2)? as usize,
                ))
            })?;
        // Ordered instants yield ordered local days, including DST folds. Skip duplicate
        // days and allow the run to start yesterday, then stop at its first gap.
        let mut history = self.conn.prepare_cached(concat!(
            review_eligible!(),
            "SELECT DISTINCT e.created_at FROM effective_review_events e JOIN eligible c ON c.id = e.card_id
             WHERE e.kind = 'grade' AND e.created_at < ?2 ORDER BY e.created_at DESC"
        ))?;
        let mut cursor = history.query(params![source_ids, end])?;
        let mut expected = date.to_owned();
        let mut previous = String::new();
        let mut streak = 0;
        while let Some(row) = cursor.next()? {
            let reviewed = Timestamp::from_millisecond(row.get(0)?)
                .map_err(|error| validation(error.to_string()))?
                .to_zoned(zone.clone())
                .date()
                .to_string();
            if reviewed == previous {
                continue;
            }
            if streak == 0 && reviewed != expected {
                expected = crate::calendar::add_days(date, -1)?;
            }
            if reviewed != expected {
                break;
            }
            previous = reviewed;
            streak += 1;
            expected = crate::calendar::add_days(&expected, -1)?;
        }
        Ok(ReviewStats {
            date: date.to_owned(),
            due_review,
            due_new,
            forecast,
            retention: (recent > 0).then(|| retained as f64 / recent as f64),
            reviews_this_week,
            streak,
            total_cards,
            held_cards,
        })
    }

    pub fn review_session_events(&self, id: &str) -> Result<Vec<ReviewEvent>> {
        self.review_session(id)?;
        Ok(self.conn.prepare_cached(
            "SELECT id, card_id, session_id, kind, grade, shown_front, shown_back,
                    definition_revision, scheduler_version, before_state, after_state, created_at, change_seq
             FROM effective_review_events WHERE session_id = ?1 ORDER BY change_seq, event_order, id"
        )?.query_map([id], |row| review_event_at(row, 0))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Retained evidence, including cards whose syntax or source is no longer visible.
    pub fn review_events(&self, card_id: &str) -> Result<Vec<ReviewEvent>> {
        validate_id(card_id)?;
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, card_id, session_id, kind, grade, shown_front, shown_back,
                        definition_revision, scheduler_version, before_state, after_state,
                        created_at, change_seq,
                        (SELECT id FROM review_undos WHERE review_id = review_events.id)
                 FROM review_events WHERE card_id = ?1 ORDER BY created_at, change_seq, event_order, id",
            )?
            .query_map([card_id], |row| {
                let mut event = review_event_at(row, 0)?;
                event.undone_by = row.get(13)?;
                Ok(event)
            })?
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
