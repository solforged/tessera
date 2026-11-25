use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

use crate::calendar::{advance_repeat, advance_window, validate_civil_date, validate_clock_time};
use crate::reads::hidden_blocks;
use crate::storage::{not_found, validate_id, validation};
use crate::{
    Operation, ProjectRecord, ProjectState, Result, TaskOccurrence, TaskState, TaskStatus, Workshop,
};

fn json_at<T: DeserializeOwned>(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<T> {
    let json: String = row.get(index)?;
    serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn validate_task(state: &TaskState) -> Result<()> {
    for (date, time) in [
        (&state.scheduled, &state.scheduled_time),
        (&state.deadline, &state.deadline_time),
    ] {
        if let Some(date) = date {
            validate_civil_date(date)?;
        }
        if let Some(time) = time {
            if date.is_none() {
                return Err(validation("task time requires its planning date"));
            }
            validate_clock_time(time)?;
        }
    }
    if state.warning_days.is_some() && state.deadline.is_none() {
        return Err(validation("task warning requires a deadline"));
    }
    if let Some(repeat) = &state.repeater {
        if state.scheduled.is_none() && state.deadline.is_none() {
            return Err(validation("recurrence requires a planning date"));
        }
        // Validate the interval independently of the current date. A task at
        // the civil-date boundary remains editable even if completion cannot
        // advance its particular window without overflowing.
        advance_repeat("0001-01-01", "0001-01-01", repeat)?;
    }
    match (state.status, state.completed_on.as_deref()) {
        (Some(TaskStatus::Done), Some(date)) => validate_civil_date(date)?,
        (Some(TaskStatus::Done), None) => {
            return Err(validation("done task requires a completion date"));
        }
        (_, Some(_)) => return Err(validation("unfinished task cannot have a completion date")),
        (_, None) => {}
    }
    Ok(())
}

fn guard_running_work(conn: &Connection, id: &str) -> Result<()> {
    let running: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM work_sessions
             WHERE block_id = ?1 AND ended_at IS NULL AND reversed = 0)",
        )?
        .query_row([id], |row| row.get(0))?;
    if running {
        return Err(validation("stop the running work session first"));
    }
    Ok(())
}

pub(crate) fn task(conn: &Connection, id: &str) -> Result<Option<TaskState>> {
    Ok(conn
        .prepare_cached("SELECT state FROM tasks WHERE block_id = ?1 AND active = 1")?
        .query_row([id], |row| json_at(row, 0))
        .optional()?)
}

fn set_task(
    conn: &Connection,
    id: &str,
    next: Option<&TaskState>,
    expected: Option<&TaskState>,
) -> Result<bool> {
    let current: Option<(bool, TaskState)> = conn
        .prepare_cached("SELECT active, state FROM tasks WHERE block_id = ?1")?
        .query_row([id], |row| Ok((row.get(0)?, json_at(row, 1)?)))
        .optional()?;
    if let Some(expected) = expected
        && current
            .as_ref()
            .filter(|(active, _)| *active)
            .map(|(_, state)| state)
            != Some(expected)
    {
        return Err(validation(
            "task changed before its previous state could be restored",
        ));
    }
    let Some(next) = next else {
        if current.as_ref().is_none_or(|(active, _)| !active) {
            return Ok(false);
        }
        guard_running_work(conn, id)?;
        conn.prepare_cached("UPDATE tasks SET active = 0 WHERE block_id = ?1")?
            .execute([id])?;
        return Ok(true);
    };
    validate_task(next)?;
    if next.status == Some(TaskStatus::Done) {
        if expected.is_some() {
            let recorded: bool = conn
                .prepare_cached(
                    "SELECT COALESCE((
                    SELECT json_extract(after_state, '$.status') = 'done'
                       AND json_extract(after_state, '$.completed_on') = ?2
                    FROM task_occurrences WHERE block_id = ?1 AND reversed = 0
                    ORDER BY rowid DESC LIMIT 1
                ), 0)",
                )?
                .query_row(params![id, next.completed_on.as_deref()], |row| row.get(0))?;
            if !recorded {
                return Err(validation(
                    "restoring done requires the latest recorded completion",
                ));
            }
        } else {
            let prior = current
                .as_ref()
                .map(|(_, state)| state)
                .filter(|state| state.status == Some(TaskStatus::Done))
                .ok_or_else(|| validation("use task completion to mark a task done"))?;
            if next.completed_on != prior.completed_on {
                return Err(validation(
                    "editing a done task must retain its completion date",
                ));
            }
        }
    }
    if current
        .as_ref()
        .is_some_and(|(active, state)| *active && state == next)
    {
        return Ok(false);
    }
    if next.status.is_none()
        || next.status == Some(TaskStatus::Cancelled)
        || (expected.is_some() && next.status == Some(TaskStatus::Done))
    {
        guard_running_work(conn, id)?;
    }
    conn.prepare_cached(
        "INSERT INTO tasks(block_id, active, state) VALUES (?1, 1, ?2)
         ON CONFLICT(block_id) DO UPDATE SET active = 1, state = excluded.state",
    )?
    .execute(params![
        id,
        serde_json::to_string(next).expect("task state serializes")
    ])?;
    Ok(true)
}

fn set_project(conn: &Connection, id: &str, next: Option<&ProjectState>) -> Result<bool> {
    let Some(next) = next else {
        return Ok(conn
            .prepare_cached("UPDATE projects SET active = 0 WHERE block_id = ?1 AND active = 1")?
            .execute([id])?
            != 0);
    };
    if let Some(date) = &next.deadline {
        validate_civil_date(date)?;
    }
    let current: Option<ProjectState> = conn
        .prepare_cached("SELECT state FROM projects WHERE block_id = ?1 AND active = 1")?
        .query_row([id], |row| json_at(row, 0))
        .optional()?;
    if current.as_ref() == Some(next) {
        return Ok(false);
    }
    conn.prepare_cached(
        "INSERT INTO projects(block_id, active, state) VALUES (?1, 1, ?2)
         ON CONFLICT(block_id) DO UPDATE SET active = 1, state = excluded.state",
    )?
    .execute(params![
        id,
        serde_json::to_string(next).expect("project state serializes")
    ])?;
    Ok(true)
}

fn complete_task(
    conn: &Connection,
    id: &str,
    occurrence_id: &str,
    completed_on: &str,
    now: i64,
    seq: i64,
) -> Result<bool> {
    validate_id(occurrence_id)?;
    validate_civil_date(completed_on)?;
    let before = task(conn, id)?.ok_or_else(|| validation("task is not active"))?;
    if before.status.is_none() {
        return Err(validation("Add #task before completing."));
    }
    if before.status == Some(TaskStatus::Cancelled) {
        return Err(validation("cancelled task cannot be completed"));
    }
    let used: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM task_occurrences WHERE id = ?1)")?
        .query_row([occurrence_id], |row| row.get(0))?;
    if used {
        return Err(validation("task occurrence ID is already used"));
    }
    if before.status == Some(TaskStatus::Done) && before.repeater.is_none() {
        return Ok(false);
    }
    guard_running_work(conn, id)?;
    let mut after = before.clone();
    if let Some(repeat) = &before.repeater {
        (after.scheduled, after.deadline) = advance_window(
            before.scheduled.as_deref(),
            before.deadline.as_deref(),
            completed_on,
            repeat,
        )?;
        after.status = Some(TaskStatus::Todo);
        after.completed_on = None;
    } else {
        after.status = Some(TaskStatus::Done);
        after.completed_on = Some(completed_on.to_owned());
    }
    let after_json = serde_json::to_string(&after).expect("task state serializes");
    conn.prepare_cached(
        "INSERT INTO task_occurrences
         (id, block_id, completed_on, snapshot, after_state, reversed, created_at, change_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
    )?
    .execute(params![
        occurrence_id,
        id,
        completed_on,
        serde_json::to_string(&before).expect("task state serializes"),
        after_json,
        now,
        seq,
    ])?;
    conn.prepare_cached("UPDATE tasks SET state = ?2 WHERE block_id = ?1")?
        .execute(params![id, after_json])?;
    Ok(true)
}

fn reverse_completion(conn: &Connection, id: &str, occurrence_id: &str, seq: i64) -> Result<bool> {
    validate_id(occurrence_id)?;
    let current = task(conn, id)?.ok_or_else(|| validation("task is not active"))?;
    let occurrence: Option<(TaskState, TaskState, bool)> = conn
        .prepare_cached(
            "SELECT snapshot, after_state, reversed FROM task_occurrences
             WHERE id = ?1 AND block_id = ?2",
        )?
        .query_row(params![occurrence_id, id], |row| {
            Ok((json_at(row, 0)?, json_at(row, 1)?, row.get(2)?))
        })
        .optional()?;
    let (snapshot, after, reversed) = occurrence.ok_or_else(|| not_found(occurrence_id))?;
    if reversed {
        if current == snapshot {
            return Ok(false);
        }
        return Err(validation("task changed after completion was reversed"));
    }
    // Caller-selected ULIDs and wall-clock timestamps do not establish commit
    // order. Row insertion order also distinguishes occurrences in one batch.
    let latest: String = conn
        .prepare_cached(
            "SELECT id FROM task_occurrences
             WHERE block_id = ?1 AND reversed = 0 ORDER BY rowid DESC LIMIT 1",
        )?
        .query_row([id], |row| row.get(0))?;
    if latest != occurrence_id {
        return Err(validation(
            "only the latest task completion can be reversed",
        ));
    }
    if current != after {
        return Err(validation("task changed after completion"));
    }
    // A done snapshot is possible if a repeater was added to an already-done
    // task. Reversing that later recurrence must not strand a running clock.
    if matches!(
        snapshot.status,
        None | Some(TaskStatus::Done | TaskStatus::Cancelled)
    ) {
        guard_running_work(conn, id)?;
    }
    conn.prepare_cached("UPDATE tasks SET state = ?2 WHERE block_id = ?1")?
        .execute(params![
            id,
            serde_json::to_string(&snapshot).expect("task state serializes")
        ])?;
    conn.prepare_cached(
        "UPDATE task_occurrences SET reversed = 1, reversed_seq = ?2 WHERE id = ?1",
    )?
    .execute(params![occurrence_id, seq])?;
    Ok(true)
}

/// Apply capability state only; Engine checks and bumps owning block revisions.
pub(crate) fn apply(conn: &Connection, operation: &Operation, now: i64, seq: i64) -> Result<bool> {
    match operation {
        Operation::SetTask { id, task, .. } => {
            validate_id(id)?;
            set_task(conn, id, task.as_ref(), None)
        }
        Operation::RestoreTaskState {
            id, expected, task, ..
        } => {
            validate_id(id)?;
            set_task(conn, id, Some(task), Some(expected))
        }
        Operation::CompleteTask {
            id,
            occurrence_id,
            completed_on,
            ..
        } => {
            validate_id(id)?;
            complete_task(conn, id, occurrence_id, completed_on, now, seq)
        }
        Operation::ReverseTaskCompletion {
            id, occurrence_id, ..
        } => {
            validate_id(id)?;
            reverse_completion(conn, id, occurrence_id, seq)
        }
        Operation::SetProject { id, project, .. } => {
            validate_id(id)?;
            set_project(conn, id, project.as_ref())
        }
        _ => Err(validation("operation does not update a task or project")),
    }
}

impl Workshop {
    /// Includes reversed evidence and occurrences on inactive/deleted sources.
    pub fn task_occurrences(&self, id: &str) -> Result<Vec<TaskOccurrence>> {
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
                "SELECT id, block_id, completed_on, snapshot, reversed, created_at, change_seq
                 FROM task_occurrences WHERE block_id = ?1 ORDER BY rowid",
            )?
            .query_map([id], |row| {
                Ok(TaskOccurrence {
                    id: row.get(0)?,
                    block_id: row.get(1)?,
                    completed_on: row.get(2)?,
                    snapshot: json_at(row, 3)?,
                    reversed: row.get(4)?,
                    created_at: row.get(5)?,
                    change_seq: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn projects(&self) -> Result<Vec<ProjectRecord>> {
        Ok(self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT p.block_id, p.state FROM projects p
                 JOIN blocks b ON b.id = p.block_id JOIN blocks root ON root.id = b.page_id
                 WHERE p.active = 1 AND b.deletion_id IS NULL AND root.deletion_id IS NULL
                 AND b.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY b.text COLLATE NOCASE, b.id"
            ))?
            .query_map([], |row| {
                Ok(ProjectRecord {
                    block_id: row.get(0)?,
                    state: json_at(row, 1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
}
