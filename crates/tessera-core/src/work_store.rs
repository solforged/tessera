use rusqlite::{Connection, OptionalExtension, params};

use crate::reads::hidden_blocks;
use crate::storage::{validate_id, validation};
use crate::{Error, Notebook, Operation, Result, TaskStatus, WorkSession};

fn session_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkSession> {
    Ok(WorkSession {
        id: row.get(0)?,
        block_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        note: row.get(4)?,
        reversed: row.get(5)?,
        revision: row.get(6)?,
    })
}

fn session(conn: &Connection, id: &str) -> Result<Option<WorkSession>> {
    Ok(conn
        .prepare_cached(
            "SELECT id, block_id, started_at, ended_at, note, reversed, revision
             FROM work_sessions WHERE id = ?1",
        )?
        .query_row([id], session_at)
        .optional()?)
}

fn checked_session(
    conn: &Connection,
    block_id: &str,
    session_id: &str,
    expected: i64,
    index: usize,
) -> Result<WorkSession> {
    validate_id(block_id)?;
    validate_id(session_id)?;
    let current = session(conn, session_id)?;
    let found = current
        .as_ref()
        .filter(|session| session.block_id == block_id)
        .map(|session| session.revision);
    if found != Some(expected) {
        return Err(Error::Conflict {
            op_index: index,
            id: session_id.to_owned(),
            expected,
            found,
        });
    }
    Ok(current.expect("matching session revision exists"))
}

fn visible(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT EXISTS(
                 SELECT 1 FROM blocks b JOIN blocks p ON p.id = b.page_id
                 WHERE b.id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                   AND b.rowid NOT IN (SELECT rowid FROM hidden)
             )"
        ))?
        .query_row([id], |row| row.get(0))?)
}

fn require_unfinished_task(conn: &Connection, id: &str) -> Result<()> {
    let task = crate::task_store::task(conn, id)?;
    if !task.is_some_and(|task| {
        matches!(
            task.status,
            TaskStatus::Todo | TaskStatus::Doing | TaskStatus::Waiting
        )
    }) || !visible(conn, id)?
    {
        return Err(validation(
            "work requires an active, visible, unfinished task",
        ));
    }
    Ok(())
}

fn require_free_clock(conn: &Connection, session_id: &str) -> Result<()> {
    // The unique partial index remains the database invariant. This preflight
    // gives callers a domain error rather than an expression-index violation.
    let occupied: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM work_sessions
             WHERE ended_at IS NULL AND reversed = 0 AND id != ?1)",
        )?
        .query_row([session_id], |row| row.get(0))?;
    if occupied {
        return Err(validation("stop the running work session first"));
    }
    Ok(())
}

fn validate_end(started_at: i64, ended_at: Option<i64>) -> Result<()> {
    if started_at < 0 || ended_at.is_some_and(|end| end < started_at) {
        return Err(validation(
            "work timestamps must be nonnegative and end at or after start",
        ));
    }
    Ok(())
}

fn save(conn: &Connection, mut session: WorkSession, seq: i64) -> Result<Option<WorkSession>> {
    session.revision = session
        .revision
        .checked_add(1)
        .ok_or_else(|| validation("work session revision is exhausted"))?;
    conn.prepare_cached(
        "UPDATE work_sessions SET ended_at = ?2, note = ?3, reversed = ?4,
         revision = ?5, updated_seq = ?6 WHERE id = ?1",
    )?
    .execute(params![
        session.id,
        session.ended_at,
        session.note,
        session.reversed,
        session.revision,
        seq,
    ])?;
    Ok(Some(session))
}

/// Mutate session state only; Engine checks and bumps the owning block.
/// Event time comes from the operation, never from its delivery/commit time.
pub(crate) fn apply(
    conn: &Connection,
    operation: &Operation,
    _now: i64,
    seq: i64,
    index: usize,
) -> Result<Option<WorkSession>> {
    match operation {
        Operation::StartWork {
            id,
            session_id,
            started_at,
            note,
            ..
        } => {
            validate_id(id)?;
            validate_id(session_id)?;
            validate_end(*started_at, None)?;
            let used: bool = conn
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM work_sessions WHERE id = ?1)")?
                .query_row([session_id], |row| row.get(0))?;
            if used {
                return Err(validation("work session ID is already used"));
            }
            require_unfinished_task(conn, id)?;
            require_free_clock(conn, session_id)?;
            conn.prepare_cached(
                "INSERT INTO work_sessions
                 (id, block_id, started_at, ended_at, note, reversed, revision, created_seq, updated_seq)
                 VALUES (?1, ?2, ?3, NULL, ?4, 0, 1, ?5, ?5)",
            )?
            .execute(params![session_id, id, started_at, note, seq])?;
            Ok(Some(WorkSession {
                id: session_id.clone(),
                block_id: id.clone(),
                started_at: *started_at,
                ended_at: None,
                note: note.clone(),
                reversed: false,
                revision: 1,
            }))
        }
        Operation::StopWork {
            id,
            session_id,
            session_revision,
            ended_at,
            note,
            ..
        } => {
            let mut current = checked_session(conn, id, session_id, *session_revision, index)?;
            if current.reversed || current.ended_at.is_some() {
                return Err(validation("only a running work session can be stopped"));
            }
            validate_end(current.started_at, Some(*ended_at))?;
            current.ended_at = Some(*ended_at);
            current.note.clone_from(note);
            save(conn, current, seq)
        }
        Operation::EditWorkNote {
            id,
            session_id,
            session_revision,
            note,
            ..
        } => {
            let mut current = checked_session(conn, id, session_id, *session_revision, index)?;
            if current.note == *note {
                return Ok(None);
            }
            current.note.clone_from(note);
            save(conn, current, seq)
        }
        Operation::SetWorkSessionState {
            id,
            session_id,
            session_revision,
            ended_at,
            reversed,
            ..
        } => {
            let mut current = checked_session(conn, id, session_id, *session_revision, index)?;
            validate_end(current.started_at, *ended_at)?;
            if current.ended_at == *ended_at && current.reversed == *reversed {
                return Ok(None);
            }
            if ended_at.is_none() && !reversed {
                require_unfinished_task(conn, id)?;
                require_free_clock(conn, session_id)?;
            }
            current.ended_at = *ended_at;
            current.reversed = *reversed;
            save(conn, current, seq)
        }
        _ => Err(validation("operation does not change a work session")),
    }
}

fn running_in_subtree(conn: &Connection, id: &str) -> Result<bool> {
    // At most one running row: walk its ancestors rather than materializing
    // every descendant of a potentially large page.
    Ok(conn
        .prepare_cached(
            "WITH RECURSIVE running_ancestors(id, parent_id) AS (
                 SELECT b.id, b.parent_id FROM work_sessions w JOIN blocks b ON b.id = w.block_id
                 WHERE w.ended_at IS NULL AND w.reversed = 0 AND b.deletion_id IS NULL
                 UNION ALL
                 SELECT b.id, b.parent_id FROM blocks b
                 JOIN running_ancestors a ON b.id = a.parent_id
             ) SELECT EXISTS(SELECT 1 FROM running_ancestors WHERE id = ?1)",
        )?
        .query_row([id], |row| row.get(0))?)
}

pub(crate) fn guard_hide_subtree(conn: &Connection, id: &str) -> Result<()> {
    validate_id(id)?;
    if running_in_subtree(conn, id)? {
        return Err(validation(
            "stop the running work session before hiding its source",
        ));
    }
    Ok(())
}

pub(crate) fn guard_move(conn: &Connection, id: &str, parent_id: &str) -> Result<()> {
    validate_id(id)?;
    validate_id(parent_id)?;
    if running_in_subtree(conn, id)? && !visible(conn, parent_id)? {
        return Err(validation(
            "a running work session cannot move beneath a hidden source",
        ));
    }
    Ok(())
}

impl Notebook {
    /// Chronological audit history, including reversed and hidden/deleted sources.
    pub fn work_sessions(&self, block_id: &str) -> Result<Vec<WorkSession>> {
        validate_id(block_id)?;
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, block_id, started_at, ended_at, note, reversed, revision
                 FROM work_sessions WHERE block_id = ?1 ORDER BY started_at, id",
            )?
            .query_map([block_id], session_at)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn active_work_session(&self) -> Result<Option<WorkSession>> {
        Ok(self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT w.id, w.block_id, w.started_at, w.ended_at, w.note, w.reversed, w.revision
                 FROM work_sessions w JOIN blocks b ON b.id = w.block_id
                 JOIN blocks p ON p.id = b.page_id
                 WHERE w.ended_at IS NULL AND w.reversed = 0
                   AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                   AND b.rowid NOT IN (SELECT rowid FROM hidden)"
            ))?
            .query_row([], session_at)
            .optional()?)
    }
}
