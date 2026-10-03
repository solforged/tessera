use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::calendar::{add_days, days_between, validate_civil_date};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, validate_id, validation};
use crate::{
    Agenda, AgendaItem, AgendaReason, BlockInPage, DateRange, Error, Notebook, Operation, Result,
    Revision, TaskPriority, TaskQuery, TaskQueryResult, TaskRow, TaskSelection, TaskState,
    TaskStatus, TaskView,
};

pub(crate) fn validate(conn: &Connection, query: &TaskQuery) -> Result<()> {
    validate_filter(conn, query)?;
    if let Some(source) = &query.source {
        crate::query::validate_source_query(conn, source)?;
    }
    Ok(())
}

fn validate_filter(conn: &Connection, query: &TaskQuery) -> Result<()> {
    validate_civil_date(&query.context_date)?;
    if query.limit.is_some_and(|limit| limit > 2000) {
        return Err(validation("task query limit must not exceed 2000"));
    }
    if !(1..=3660).contains(&query.filter.recent_days) {
        return Err(validation("recent days must be between 1 and 3660"));
    }
    for range in [&query.filter.scheduled, &query.filter.deadline]
        .into_iter()
        .flatten()
    {
        if let Some(from) = &range.from {
            validate_civil_date(from)?;
        }
        if let Some(through) = &range.through {
            validate_civil_date(through)?;
        }
        if let (Some(from), Some(through)) = (&range.from, &range.through)
            && from > through
        {
            return Err(validation("date range starts after it ends"));
        }
    }
    if let Some(id) = &query.filter.project_id {
        validate_id(id)?;
        let live = conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT EXISTS(SELECT 1 FROM projects pr JOIN blocks b ON b.id = pr.block_id
             JOIN blocks p ON p.id = b.page_id WHERE pr.block_id = ?1 AND pr.active = 1
             AND b.deletion_id IS NULL AND p.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden))"
            ))?
            .query_row([id], |row| row.get::<_, bool>(0))?;
        if !live {
            return Err(validation(format!("not a live project: {id}")));
        }
    }
    Ok(())
}

fn state_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<TaskState> {
    let json: String = row.get(offset)?;
    serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn visible_tasks(conn: &Connection, project_id: Option<&str>) -> Result<Vec<TaskRow>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        ", visible_tasks AS MATERIALIZED (
            SELECT t.block_id, t.state FROM tasks t JOIN blocks b ON b.id = t.block_id
            JOIN blocks p ON p.id = b.page_id WHERE t.active = 1
            AND b.deletion_id IS NULL AND p.deletion_id IS NULL
            AND b.rowid NOT IN (SELECT rowid FROM hidden)
         ), ancestors(task_id, ancestor_id, depth) AS (
            SELECT t.block_id, b.parent_id, 1 FROM visible_tasks t JOIN blocks b ON b.id = t.block_id
            WHERE b.parent_id IS NOT NULL
            UNION ALL
            SELECT a.task_id, b.parent_id, a.depth + 1 FROM ancestors a
            JOIN blocks b ON b.id = a.ancestor_id WHERE b.parent_id IS NOT NULL
         ) SELECT ", block_columns!("b"), ", ", block_columns!("p"), ", t.state,
         (SELECT a.ancestor_id FROM ancestors a JOIN projects pr ON pr.block_id = a.ancestor_id
          WHERE a.task_id = t.block_id AND pr.active = 1 ORDER BY a.depth LIMIT 1)
         FROM visible_tasks t JOIN blocks b ON b.id = t.block_id JOIN blocks p ON p.id = b.page_id
         WHERE ?1 IS NULL OR EXISTS (SELECT 1 FROM ancestors a
             WHERE a.task_id = t.block_id AND a.ancestor_id = ?1)"
    ))?;
    Ok(statement
        .query_map([project_id], |row| {
            Ok(TaskRow {
                source: BlockInPage {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                },
                task: state_at(row, 20)?,
                project_id: row.get(21)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn unfinished(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Todo | TaskStatus::Doing | TaskStatus::Waiting
    )
}

fn in_range(date: Option<&str>, range: Option<&DateRange>) -> bool {
    range.is_none_or(|range| {
        date.is_some_and(|date| {
            range.from.as_deref().is_none_or(|from| date >= from)
                && range
                    .through
                    .as_deref()
                    .is_none_or(|through| date <= through)
        })
    })
}

fn missing_last<T: Ord>(left: Option<T>, right: Option<T>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn planning(state: &TaskState) -> (Option<&str>, Option<&str>) {
    if state.scheduled.is_some() {
        (state.scheduled.as_deref(), state.scheduled_time.as_deref())
    } else {
        (state.deadline.as_deref(), state.deadline_time.as_deref())
    }
}

fn priority(priority: Option<TaskPriority>) -> u8 {
    match priority {
        Some(TaskPriority::High) => 0,
        Some(TaskPriority::Medium) => 1,
        Some(TaskPriority::Low) => 2,
        None => 3,
    }
}

fn compare_tasks(left: &TaskRow, right: &TaskRow) -> Ordering {
    let (left_date, left_time) = planning(&left.task);
    let (right_date, right_time) = planning(&right.task);
    missing_last(left_date, right_date)
        .then_with(|| missing_last(left_time, right_time))
        .then_with(|| priority(left.task.priority).cmp(&priority(right.task.priority)))
        .then_with(|| left.source.block.id.cmp(&right.source.block.id))
}

fn agenda_plan(state: &TaskState, date: &str) -> Result<(Vec<AgendaReason>, Option<String>)> {
    let scheduled = state.scheduled.as_deref().is_some_and(|day| day <= date);
    let deadline = state.deadline.as_deref().is_some_and(|day| day <= date);
    let warning = match (state.deadline.as_deref(), state.warning_days) {
        (Some(day), Some(lead)) if day >= date => days_between(date, day)? <= i64::from(lead),
        _ => false,
    };
    let mut reasons = Vec::new();
    if scheduled {
        reasons.push(AgendaReason::Scheduled);
    }
    if deadline {
        reasons.push(AgendaReason::Deadline);
    }
    if warning {
        reasons.push(AgendaReason::Warning);
    }
    if state.deadline.as_deref().is_some_and(|day| day < date) {
        reasons.push(AgendaReason::Overdue);
    }
    if state.scheduled.is_none() && state.deadline.is_none() {
        reasons.push(AgendaReason::Unplanned);
    }
    let scheduled_time = scheduled
        .then_some(state.scheduled_time.as_deref())
        .flatten();
    let deadline_time = (deadline || warning)
        .then_some(state.deadline_time.as_deref())
        .flatten();
    let time = match (scheduled_time, deadline_time) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    };
    Ok((reasons, time.map(str::to_owned)))
}

fn stored_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskView> {
    let json: String = row.get(2)?;
    let query = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(TaskView {
        id: row.get(0)?,
        name: row.get(1)?,
        query,
        revision: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub(crate) fn apply_view(
    conn: &Connection,
    operation: &Operation,
    now: i64,
    index: usize,
) -> Result<Revision> {
    let (id, expected) = match operation {
        Operation::SaveTaskView {
            id, base_revision, ..
        } => (id, *base_revision),
        Operation::DeleteTaskView { id, base_revision } => (id, Some(*base_revision)),
        _ => return Err(validation("not a task view operation")),
    };
    validate_id(id)?;
    let found = conn
        .prepare_cached("SELECT revision FROM task_views WHERE id = ?1")?
        .query_row([id], |row| row.get::<_, i64>(0))
        .optional()?;
    if matches!(operation, Operation::DeleteTaskView { .. }) && found.is_none() {
        return Err(not_found(id));
    }
    if found != expected {
        return Err(Error::Conflict {
            op_index: index,
            id: id.clone(),
            expected: expected.unwrap_or(0),
            found,
        });
    }
    let revision = found
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| validation("task view revision overflow"))?;
    match operation {
        Operation::SaveTaskView { name, query, .. } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 120 {
                return Err(validation(
                    "task view name must contain 1 to 120 characters",
                ));
            }
            validate(conn, query)?;
            conn.execute(
                "INSERT INTO task_views(id, name, query, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query,
                 revision = excluded.revision, updated_at = excluded.updated_at",
                params![
                    id,
                    name,
                    serde_json::to_string(query).expect("task query serializes"),
                    revision,
                    now
                ],
            )?;
        }
        Operation::DeleteTaskView { .. } => {
            conn.execute("DELETE FROM task_views WHERE id = ?1", [id])?;
        }
        _ => unreachable!("task view operation checked"),
    }
    Ok(Revision {
        id: id.clone(),
        revision,
    })
}

impl Notebook {
    pub fn task_query(&self, query: &TaskQuery) -> Result<TaskQueryResult> {
        validate_filter(&self.conn, query)?;
        let sources = query
            .source
            .as_ref()
            .map(|source| {
                self.query_all_sources(source).map(|result| {
                    result
                        .rows
                        .into_iter()
                        .map(|row| row.block.block.id)
                        .collect::<HashSet<_>>()
                })
            })
            .transpose()?;
        let filter = &query.filter;
        let recent = if filter.selection == TaskSelection::UnfinishedOrRecent {
            // A valid early civil date still has a valid, shortened history window.
            let days = i64::from(filter.recent_days - 1)
                .min(days_between("0001-01-01", &query.context_date)?);
            let from = add_days(&query.context_date, -days)?;
            self.conn
                .prepare_cached(
                    "SELECT DISTINCT block_id FROM task_occurrences
                 WHERE reversed = 0 AND completed_on >= ?1 AND completed_on <= ?2",
                )?
                .query_map(params![from, query.context_date], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<HashSet<_>>>()?
        } else {
            HashSet::new()
        };
        let mut rows = visible_tasks(&self.conn, filter.project_id.as_deref())?;
        rows.retain(|row| {
            let state = &row.task;
            (state.status != TaskStatus::Cancelled
                || filter.statuses.contains(&TaskStatus::Cancelled))
                && sources
                    .as_ref()
                    .is_none_or(|sources| sources.contains(&row.source.block.id))
                && (filter.statuses.is_empty() || filter.statuses.contains(&state.status))
                && (match filter.selection {
                    TaskSelection::All => true,
                    TaskSelection::Unfinished => unfinished(state.status),
                    TaskSelection::UnfinishedOrRecent => {
                        unfinished(state.status) || recent.contains(&row.source.block.id)
                    }
                })
                && in_range(state.scheduled.as_deref(), filter.scheduled.as_ref())
                && in_range(state.deadline.as_deref(), filter.deadline.as_ref())
                && filter
                    .priority
                    .is_none_or(|priority| state.priority == Some(priority))
        });
        rows.sort_unstable_by(compare_tasks);
        let total = rows.len();
        rows.truncate(query.limit.unwrap_or(500));
        Ok(TaskQueryResult { rows, total })
    }

    /// The displayed civil date is authoritative. Currently cancelled tasks are
    /// excluded; a latest same-day occurrence takes precedence over mutable state
    /// and supplies all planning for one historical, projected-done source row.
    pub fn agenda(&self, date: &str) -> Result<Agenda> {
        validate_civil_date(date)?;
        let mut completed = self.conn.prepare_cached(
            "SELECT o.block_id, o.snapshot FROM task_occurrences o JOIN tasks t ON t.block_id = o.block_id
             WHERE t.active = 1 AND o.rowid IN (
                 SELECT MAX(rowid) FROM task_occurrences WHERE reversed = 0 AND completed_on = ?1 GROUP BY block_id
             )"
        )?.query_map([date], |row| Ok((row.get::<_, String>(0)?, state_at(row, 1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        let mut items = Vec::new();
        for row in visible_tasks(&self.conn, None)? {
            if row.task.status == TaskStatus::Cancelled {
                continue;
            }
            let occurrence = completed.remove(&row.source.block.id);
            if occurrence.is_none() && !unfinished(row.task.status) {
                continue;
            }
            let historical = occurrence.is_some();
            let mut task = occurrence.unwrap_or(row.task);
            let (mut reasons, time) = agenda_plan(&task, date)?;
            if historical {
                task.status = TaskStatus::Done;
                task.completed_on = Some(date.to_owned());
                reasons.push(AgendaReason::RecentlyCompleted);
            }
            if !reasons.is_empty() {
                items.push(AgendaItem {
                    source: row.source,
                    task,
                    reasons,
                    time,
                    project_id: row.project_id,
                });
            }
        }
        items.sort_unstable_by(|left, right| {
            missing_last(left.time.as_deref(), right.time.as_deref())
                .then_with(|| priority(left.task.priority).cmp(&priority(right.task.priority)))
                .then_with(|| left.source.block.id.cmp(&right.source.block.id))
        });
        Ok(Agenda {
            date: date.to_owned(),
            items,
        })
    }

    pub fn task_views(&self) -> Result<Vec<TaskView>> {
        let mut views = self
            .conn
            .prepare_cached(
                "SELECT id, name, query, revision, created_at, updated_at FROM task_views",
            )?
            .query_map([], stored_view)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        views.sort_by_cached_key(|view| (view.name.to_lowercase(), view.id.clone()));
        Ok(views)
    }

    pub fn task_view(&self, id: &str) -> Result<TaskView> {
        validate_id(id)?;
        self.conn.prepare_cached(
            "SELECT id, name, query, revision, created_at, updated_at FROM task_views WHERE id = ?1"
        )?.query_row([id], stored_view).optional()?.ok_or_else(|| not_found(id))
    }
}
