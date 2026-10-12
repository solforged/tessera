//! Tools for tasks: set one block's task state, and read the agenda or a
//! filtered task list.

use anyhow::Context;
use serde_json::Value;
use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater, add_days};
use tessera_core::{
    Agenda, AgendaItem, AgendaReason, AgentEdit, BlockCapabilities, DateRange, TaskFilter,
    TaskPriority, TaskQuery, TaskQueryResult, TaskRow, TaskSelection, TaskStatus, TaskView,
};

use super::notes::clock;
use super::render::{location, marker, name, one_line, task_details};
use super::{Session, boolean, choice, integer, limit, required, segment, string, strings};

const STATUSES: &str = "todo, doing, waiting, done or cancelled";
const MODES: &str = "fixed, catch_up or after_completion";

impl Session<'_> {
    /// Merge the given fields into the block's current task state.
    pub(super) async fn set_task(&self, arguments: &Value) -> anyhow::Result<String> {
        let id = required(arguments, "id")?;
        let api = self.api().await?;
        let current: BlockCapabilities = api
            .get(&format!("/api/blocks/{}/capabilities", segment(&id)))
            .await?;
        let task = match string(arguments, "status")? {
            Some("none") => None,
            status => {
                // id alone must not invent a todo. An existing task with no
                // fields still goes through submit, which refuses a no-op.
                require_task_change(current.task.is_some(), arguments)?;
                let mut task = current.task.clone().unwrap_or_default();
                if let Some(status) = status {
                    task.status = choice(status, "status", &format!("{STATUSES} or none"))?;
                }
                if task.status != TaskStatus::Done {
                    task.completed_on = None;
                }
                if let Some(date) = string(arguments, "completed_on")? {
                    task.completed_on = Some(date.to_owned());
                }
                for (key, field) in [
                    ("scheduled", &mut task.scheduled),
                    ("deadline", &mut task.deadline),
                    ("scheduled_time", &mut task.scheduled_time),
                    ("deadline_time", &mut task.deadline_time),
                ] {
                    if let Some(value) = string(arguments, key)? {
                        *field = (!value.is_empty()).then(|| value.to_owned());
                    }
                }
                if let Some(days) = integer(arguments, "warning_days")? {
                    task.warning_days = match days {
                        0 => None,
                        days => {
                            Some(u32::try_from(days).context("warning_days must be 0 or more")?)
                        }
                    };
                }
                let mode = string(arguments, "repeat_mode")?
                    .map(|mode| choice::<RepeatMode>(mode, "repeat_mode", MODES))
                    .transpose()?;
                match (string(arguments, "repeat")?, mode) {
                    (Some("" | "none"), _) => task.repeater = None,
                    (Some(interval), mode) => {
                        let mode = mode
                            .or(task.repeater.map(|repeat| repeat.mode))
                            .unwrap_or(RepeatMode::CatchUp);
                        task.repeater = Some(repeater(interval, mode)?);
                    }
                    (None, Some(mode)) => {
                        task.repeater
                            .as_mut()
                            .context("repeat_mode needs a repeat; give repeat too")?
                            .mode = mode;
                    }
                    (None, None) => {}
                }
                anyhow::ensure!(
                    task.scheduled_time.is_none() || task.scheduled.is_some(),
                    "scheduled_time needs a scheduled date."
                );
                anyhow::ensure!(
                    (task.deadline_time.is_none() && task.warning_days.is_none())
                        || task.deadline.is_some(),
                    "deadline_time and warning_days need a deadline."
                );
                // As in the editor, repeating an undated task schedules it today.
                if task.repeater.is_some() && task.scheduled.is_none() && task.deadline.is_none() {
                    task.scheduled = Some(clock(&api).await?.today);
                }
                if let Some(priority) = string(arguments, "priority")? {
                    task.priority = match priority {
                        "" | "none" => None,
                        priority => Some(choice::<TaskPriority>(
                            priority,
                            "priority",
                            "high, medium, low or none",
                        )?),
                    };
                }
                Some(task)
            }
        };
        self.submit(
            arguments,
            AgentEdit::SetTask {
                id,
                revision: integer(arguments, "revision")?,
                task,
            },
        )
        .await
    }

    pub(super) async fn tasks(&self, arguments: &Value) -> anyhow::Result<String> {
        match string(arguments, "view")?.unwrap_or("agenda") {
            "agenda" => self.agenda(arguments).await,
            "list" => self.task_list(arguments).await,
            view => anyhow::bail!("view must be agenda or list, not {view:?}"),
        }
    }

    /// One day's agenda in full, then what is scheduled or due on each
    /// following day.
    async fn agenda(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let start = match string(arguments, "date")? {
            None | Some("today") => clock(&api).await?.today,
            Some(date) => date.to_owned(),
        };
        let days = limit(arguments, "days", 1, 31)?;
        let unplanned = boolean(arguments, "unplanned")?.unwrap_or(false);
        let mut text = String::new();
        let mut hidden = 0;
        for offset in 0..days {
            let date = add_days(&start, offset as i64)?;
            let agenda: Agenda = api.get(&format!("/api/agenda/{}", segment(&date))).await?;
            let items: Vec<&AgendaItem> = agenda
                .items
                .iter()
                .filter(|item| {
                    if offset > 0 {
                        return item.task.scheduled.as_deref() == Some(date.as_str())
                            || item.task.deadline.as_deref() == Some(date.as_str());
                    }
                    let only_unplanned = item.reasons == [AgendaReason::Unplanned];
                    if only_unplanned && !unplanned {
                        hidden += 1;
                    }
                    unplanned || !only_unplanned
                })
                .collect();
            if offset > 0 && items.is_empty() {
                continue;
            }
            text.push_str(&format!("{date}:\n"));
            if items.is_empty() {
                text.push_str("- Nothing planned.\n");
            }
            for item in items {
                let reasons: Vec<_> = item.reasons.iter().map(|reason| name(*reason)).collect();
                let mut details = vec![reasons.join(" and ")];
                if let Some(time) = &item.time {
                    details.push(format!("at {time}"));
                }
                details.extend(task_details(&item.task));
                text.push_str(&task_line(
                    item.task.status,
                    &item.source.block.text,
                    &item.source.block.id,
                    &location(&item.source.page),
                    &details,
                ));
            }
        }
        if hidden > 0 {
            text.push_str(&format!(
                "({hidden} unplanned task{} hidden; pass unplanned: true to list them.)\n",
                if hidden == 1 { "" } else { "s" }
            ));
        }
        Ok(text)
    }

    async fn task_list(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let today = clock(&api).await?.today;
        let query = match string(arguments, "saved")? {
            Some(saved) => {
                let views: Vec<TaskView> = api.get("/api/task-views").await?;
                let view = views
                    .into_iter()
                    .find(|view| view.name.eq_ignore_ascii_case(saved))
                    .with_context(|| format!("No saved task view is named {saved:?}."))?;
                TaskQuery {
                    context_date: today,
                    limit: Some(limit(arguments, "limit", 50, 500)?),
                    ..view.query
                }
            }
            None => TaskQuery {
                source: None,
                filter: TaskFilter {
                    selection: match string(arguments, "include")? {
                        None => TaskSelection::Unfinished,
                        Some(include) => choice(
                            include,
                            "include",
                            "unfinished, unfinished_or_recent or all",
                        )?,
                    },
                    statuses: strings(arguments, "status")?
                        .iter()
                        .map(|status| choice(status, "status", STATUSES))
                        .collect::<anyhow::Result<_>>()?,
                    recent_days: 7,
                    scheduled: range(arguments, "scheduled")?,
                    deadline: range(arguments, "deadline")?,
                    priority: string(arguments, "priority")?
                        .map(|priority| choice(priority, "priority", "high, medium or low"))
                        .transpose()?,
                    project_id: string(arguments, "project")?.map(str::to_owned),
                },
                context_date: today,
                limit: Some(limit(arguments, "limit", 50, 500)?),
            },
        };
        let result: TaskQueryResult = api.post("/api/tasks/query", &query).await?;
        if result.rows.is_empty() {
            return Ok("No tasks match.".into());
        }
        let mut text = format!("{} of {} tasks:\n", result.rows.len(), result.total);
        for TaskRow { source, task, .. } in &result.rows {
            text.push_str(&task_line(
                task.status,
                &source.block.text,
                &source.block.id,
                &location(&source.page),
                &task_details(task),
            ));
        }
        Ok(text)
    }
}

/// `- [ ] text (block ID) on page "Title" (page ID): details`.
fn task_line(
    status: TaskStatus,
    text: &str,
    id: &str,
    location: &str,
    details: &[String],
) -> String {
    let mut line = format!(
        "- {}{} (block {id}) {location}",
        marker(status),
        one_line(text)
    );
    let details: Vec<_> = details.iter().filter(|part| !part.is_empty()).collect();
    if !details.is_empty() {
        line.push_str(": ");
        line.push_str(
            &details
                .iter()
                .map(|part| part.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    line.push('\n');
    line
}

/// `{key}_from` and `{key}_through` as a date range.
fn range(arguments: &Value, key: &str) -> anyhow::Result<Option<DateRange>> {
    let from = string(arguments, &format!("{key}_from"))?.map(str::to_owned);
    let through = string(arguments, &format!("{key}_through"))?.map(str::to_owned);
    Ok((from.is_some() || through.is_some()).then_some(DateRange { from, through }))
}

/// Refuse an id-only call on a block that is not yet a task.
fn require_task_change(has_task: bool, arguments: &Value) -> anyhow::Result<()> {
    if has_task || string(arguments, "status")?.is_some() || task_field_given(arguments)? {
        return Ok(());
    }
    anyhow::bail!(
        "This block is not a task. Give status or another field to make it one; id alone changes nothing."
    );
}

/// True when the call names a task field other than status. `reason` and `revision` do not count.
fn task_field_given(arguments: &Value) -> anyhow::Result<bool> {
    for key in [
        "completed_on",
        "scheduled",
        "deadline",
        "scheduled_time",
        "deadline_time",
        "repeat",
        "repeat_mode",
        "priority",
    ] {
        if string(arguments, key)?.is_some() {
            return Ok(true);
        }
    }
    Ok(integer(arguments, "warning_days")?.is_some())
}

/// `1d`, `2w`, `3m` or `1y` with a repeat mode.
fn repeater(interval: &str, mode: RepeatMode) -> anyhow::Result<Repeater> {
    let invalid = || format!("repeat must look like 1d, 2w, 3m or 1y, not {interval:?}");
    let (count, unit) = interval
        .char_indices()
        .last()
        .map(|(at, unit)| (&interval[..at], unit))
        .with_context(invalid)?;
    let every: u32 = count
        .parse()
        .ok()
        .filter(|every| *every > 0)
        .with_context(invalid)?;
    let unit = match unit {
        'd' => RepeatUnit::Day,
        'w' => RepeatUnit::Week,
        'm' => RepeatUnit::Month,
        'y' => RepeatUnit::Year,
        _ => anyhow::bail!(invalid()),
    };
    Ok(Repeater { every, unit, mode })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_only_does_not_make_a_non_task_into_a_todo() {
        let id_only = serde_json::json!({ "id": "block", "reason": "touch", "revision": 3 });
        let error = require_task_change(false, &id_only)
            .unwrap_err()
            .to_string();
        assert!(error.contains("id alone"), "{error}");
        assert!(require_task_change(true, &id_only).is_ok());
        for arguments in [
            serde_json::json!({ "id": "block", "status": "todo" }),
            serde_json::json!({ "status": "none" }),
            serde_json::json!({ "scheduled": "2026-10-12" }),
            serde_json::json!({ "deadline": "" }),
            serde_json::json!({ "priority": "low" }),
            serde_json::json!({ "warning_days": 0 }),
            serde_json::json!({ "repeat": "1w" }),
        ] {
            assert!(
                require_task_change(false, &arguments).is_ok(),
                "{arguments}"
            );
        }
        assert!(require_task_change(false, &serde_json::json!({ "status": null })).is_err());
    }

    #[test]
    fn repeat_intervals_read_count_and_unit() {
        let weekly = repeater("2w", RepeatMode::Fixed).unwrap();
        assert_eq!((weekly.every, weekly.unit), (2, RepeatUnit::Week));
        assert_eq!(repeater("12m", RepeatMode::CatchUp).unwrap().every, 12);
        for bad in ["", "w", "0d", "1x", "-1d", "1.5w"] {
            assert!(repeater(bad, RepeatMode::Fixed).is_err(), "{bad}");
        }
    }
}
