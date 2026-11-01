//! Tools for tasks: set one block's task state, and read the agenda or a
//! filtered task list.

use anyhow::Context;
use serde_json::Value;
use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater, add_days};
use tessera_core::{
    Agenda, AgendaItem, AgendaReason, AgentEdit, Block, BlockCapabilities, DateRange, TaskFilter,
    TaskPriority, TaskQuery, TaskQueryResult, TaskRow, TaskSelection, TaskState, TaskStatus,
    TaskView,
};

use super::notes::clock;
use super::render::{location, marker, name, one_line, task_details};
use super::{Session, Titles, boolean, choice, integer, limit, required, segment, string, strings};

const STATUSES: &str = "todo, doing, waiting, done or cancelled";
const MODES: &str = "fixed, catch_up or after_completion";

/// What tessera_set_task sets besides `status`.
const TASK_FIELDS: [&str; 9] = [
    "scheduled",
    "scheduled_time",
    "deadline",
    "deadline_time",
    "warning_days",
    "repeat",
    "repeat_mode",
    "priority",
    "completed_on",
];

/// The longest warning lead before a deadline, in days.
const WARNING_DAYS: u32 = 365;

/// The tessera_tasks arguments only the list view reads.
const LIST_ONLY: [&str; 10] = [
    "status",
    "include",
    "scheduled_from",
    "scheduled_through",
    "deadline_from",
    "deadline_through",
    "priority",
    "project",
    "saved",
    "limit",
];

impl Session<'_> {
    /// Merge the given fields into the block's current task state.
    pub(super) async fn set_task(&self, arguments: &Value) -> anyhow::Result<String> {
        let id = required(arguments, "id")?;
        let api = self.api().await?;
        // The write names the revision the merge starts from, so a change made
        // in between is refused instead of overwritten. It is read before the
        // task state; a caller's own revision is older still.
        let revision = match integer(arguments, "revision")? {
            Some(revision) => revision,
            None => {
                api.get::<Block>(&format!("/api/blocks/{}", segment(&id)))
                    .await?
                    .revision
            }
        };
        let current: BlockCapabilities = api
            .get(&format!("/api/blocks/{}/capabilities", segment(&id)))
            .await?;
        let today = if sets_repeat(arguments)? {
            Some(clock(&api).await?.today)
        } else {
            None
        };
        let task = merge(current.task.as_ref(), arguments, today.as_deref())?;
        self.submit(
            arguments,
            AgentEdit::SetTask {
                id,
                revision: Some(revision),
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
        let list_only: Vec<&str> = LIST_ONLY
            .into_iter()
            .filter(|key| given(arguments, key))
            .collect();
        anyhow::ensure!(
            list_only.is_empty(),
            "The agenda does not take these list filters: {}. Pass view list to use them, or leave them out.",
            list_only.join(", ")
        );
        let api = self.api().await?;
        let start = match string(arguments, "date")? {
            None | Some("today") => clock(&api).await?.today,
            Some(date) => date.to_owned(),
        };
        let days = limit(arguments, "days", 1, 31)?;
        let unplanned = boolean(arguments, "unplanned")?.unwrap_or(false);
        let mut hidden = 0;
        let mut listed = Vec::new();
        for offset in 0..days {
            let date = add_days(&start, offset as i64)?;
            let agenda: Agenda = api.get(&format!("/api/agenda/{}", segment(&date))).await?;
            let items: Vec<AgendaItem> = agenda
                .items
                .into_iter()
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
            if offset == 0 || !items.is_empty() {
                listed.push((date, items));
            }
        }
        let titles = Titles::load(
            &api,
            listed
                .iter()
                .flat_map(|(_, items)| items)
                .map(|item| item.source.block.text.as_str()),
        )
        .await?;
        let mut text = String::new();
        for (date, items) in &listed {
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
                    &titles.show(&item.source.block.text),
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
            None => {
                let statuses: Vec<TaskStatus> = strings(arguments, "status")?
                    .iter()
                    .map(|status| choice(status, "status", STATUSES))
                    .collect::<anyhow::Result<_>>()?;
                let finished = statuses
                    .iter()
                    .any(|status| matches!(status, TaskStatus::Done | TaskStatus::Cancelled));
                let selection = match string(arguments, "include")? {
                    // Done and cancelled tasks are never unfinished, so asking
                    // for them lists every one.
                    None if finished => TaskSelection::All,
                    None => TaskSelection::Unfinished,
                    Some(include) => choice(
                        include,
                        "include",
                        "unfinished, unfinished_or_recent or all",
                    )?,
                };
                anyhow::ensure!(
                    !finished || selection != TaskSelection::Unfinished,
                    "include unfinished leaves out done and cancelled tasks. Pass include all or \
                     unfinished_or_recent, or leave include out."
                );
                TaskQuery {
                    source: None,
                    filter: TaskFilter {
                        selection,
                        statuses,
                        recent_days: 7,
                        scheduled: range(arguments, "scheduled")?,
                        deadline: range(arguments, "deadline")?,
                        priority: string(arguments, "priority")?
                            .map(|priority| choice(priority, "priority", "high, medium or low"))
                            .transpose()?,
                        project_id: string(arguments, "project")?.map(str::to_owned),
                        sort: Default::default(),
                        project_via: Default::default(),
                    },
                    context_date: today,
                    limit: Some(limit(arguments, "limit", 50, 500)?),
                }
            }
        };
        let result: TaskQueryResult = api.post("/api/tasks/query", &query).await?;
        if result.rows.is_empty() {
            return Ok("No tasks match.".into());
        }
        let titles = Titles::load(
            &api,
            result.rows.iter().map(|row| row.source.block.text.as_str()),
        )
        .await?;
        let mut text = format!("{} of {} tasks:\n", result.rows.len(), result.total);
        for TaskRow { source, task, .. } in &result.rows {
            text.push_str(&task_line(
                task.status,
                &titles.show(&source.block.text),
                &source.block.id,
                &location(&source.page),
                &task_details(task),
            ));
        }
        Ok(text)
    }
}

/// The task state a tessera_set_task call asks for: its fields merged into
/// the block's `current` task, or `None` to remove the task. `today` must be
/// given when the call sets a repeat (see `sets_repeat`).
fn merge(
    current: Option<&TaskState>,
    arguments: &Value,
    today: Option<&str>,
) -> anyhow::Result<Option<TaskState>> {
    let fields: Vec<&str> = TASK_FIELDS
        .into_iter()
        .filter(|key| given(arguments, key))
        .collect();
    let status = match string(arguments, "status")? {
        Some("none") => {
            anyhow::ensure!(
                fields.is_empty(),
                "status none removes the whole task, so give it alone. Leave these out: {}.",
                fields.join(", ")
            );
            return Ok(None);
        }
        Some(status) => Some(choice::<TaskStatus>(
            status,
            "status",
            "todo, doing, waiting, done, cancelled or none",
        )?),
        None => None,
    };
    anyhow::ensure!(
        status.is_some() || !fields.is_empty(),
        "Give a status, or a task field to set such as scheduled, deadline, repeat or priority."
    );
    let mut task = current.cloned().unwrap_or_default();
    if status.is_some() {
        task.status = status;
    }
    if task.status != Some(TaskStatus::Done) {
        task.completed_on = None;
    }
    for (key, field) in [
        ("scheduled", &mut task.scheduled),
        ("deadline", &mut task.deadline),
        ("scheduled_time", &mut task.scheduled_time),
        ("deadline_time", &mut task.deadline_time),
        ("completed_on", &mut task.completed_on),
    ] {
        if let Some(value) = string(arguments, key)? {
            *field = (!value.is_empty()).then(|| value.to_owned());
        }
    }
    if let Some(days) = integer(arguments, "warning_days")? {
        let days = u32::try_from(days)
            .ok()
            .filter(|days| *days <= WARNING_DAYS)
            .with_context(|| format!("warning_days must be from 0 to {WARNING_DAYS}"))?;
        task.warning_days = (days > 0).then_some(days);
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
        (task.deadline_time.is_none() && task.warning_days.is_none()) || task.deadline.is_some(),
        "deadline_time and warning_days need a deadline."
    );
    // As in the editor, a repeat counts from a date: setting one on an undated
    // task schedules it today, and clearing the last date clears the repeat.
    if task.repeater.is_some() && task.scheduled.is_none() && task.deadline.is_none() {
        if sets_repeat(arguments)? {
            let today = today.context("today's date is needed to start a repeat")?;
            task.scheduled = Some(today.to_owned());
        } else {
            task.repeater = None;
        }
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
    if current.is_none() && status.is_none() {
        anyhow::ensure!(
            task != TaskState::default(),
            "This atom has no task, so there is nothing to clear. Give status todo, or a date, \
             repeat or priority to plan it."
        );
        // A date alone makes an appointment, as `@` planning does in the
        // editor. Anything more makes a todo task: a repeat without a status
        // could never advance, and a deadline or priority needs a checkbox.
        let appointment = TaskState {
            scheduled: task.scheduled.clone(),
            scheduled_time: task.scheduled_time.clone(),
            ..TaskState::default()
        };
        if task.scheduled.is_none() || task != appointment {
            task.status = Some(TaskStatus::Todo);
        }
    }
    Ok(Some(task))
}

/// Whether the call sets a repeat interval or mode, which starts an undated
/// task today.
fn sets_repeat(arguments: &Value) -> anyhow::Result<bool> {
    Ok(
        !matches!(string(arguments, "repeat")?, None | Some("" | "none"))
            || string(arguments, "repeat_mode")?.is_some(),
    )
}

/// Whether `arguments` gives `key` a value; null counts as left out.
fn given(arguments: &Value, key: &str) -> bool {
    arguments.get(key).is_some_and(|value| !value.is_null())
}

/// `- [ ] text (block ID) on atom "Title" (id ID): details`.
fn task_line(
    status: Option<TaskStatus>,
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

/// `1d`, `2w`, `3m` or `1y` with a repeat mode.
fn repeater(interval: &str, mode: RepeatMode) -> anyhow::Result<Repeater> {
    let invalid = || format!("repeat must look like 1d, 2w, 3m or 1y, not {interval:?}");
    let (count, unit) = interval
        .char_indices()
        .last()
        .map(|(at, unit)| (&interval[..at], unit))
        .with_context(invalid)?;
    // Digits only: `parse` would also take a leading sign.
    let every: u32 = Some(count)
        .filter(|count| count.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|count| count.parse().ok())
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
    use serde_json::json;

    const TODAY: &str = "2026-10-31";

    fn merged(current: Option<&TaskState>, arguments: Value) -> anyhow::Result<Option<TaskState>> {
        merge(current, &arguments, Some(TODAY))
    }

    fn todo() -> TaskState {
        TaskState {
            status: Some(TaskStatus::Todo),
            ..TaskState::default()
        }
    }

    #[test]
    fn repeat_intervals_read_count_and_unit() {
        let weekly = repeater("2w", RepeatMode::Fixed).unwrap();
        assert_eq!((weekly.every, weekly.unit), (2, RepeatUnit::Week));
        assert_eq!(repeater("12m", RepeatMode::CatchUp).unwrap().every, 12);
        for bad in ["", "w", "0d", "1x", "-1d", "+1w", "1.5w"] {
            assert!(repeater(bad, RepeatMode::Fixed).is_err(), "{bad}");
        }
    }

    #[test]
    fn clearing_the_last_date_clears_the_repeat_instead_of_scheduling_today() {
        let monthly = TaskState {
            deadline: Some("2026-11-01".into()),
            warning_days: Some(5),
            repeater: Some(repeater("1m", RepeatMode::Fixed).unwrap()),
            ..todo()
        };
        let task = merged(Some(&monthly), json!({ "deadline": "", "warning_days": 0 }))
            .unwrap()
            .unwrap();
        assert_eq!(
            (task.scheduled, task.deadline, task.repeater),
            (None, None, None)
        );

        let fortnightly = TaskState {
            scheduled: Some("2026-11-05".into()),
            scheduled_time: Some("09:30".into()),
            repeater: Some(repeater("2w", RepeatMode::CatchUp).unwrap()),
            ..todo()
        };
        let task = merged(
            Some(&fortnightly),
            json!({ "scheduled": "", "scheduled_time": "" }),
        )
        .unwrap()
        .unwrap();
        assert_eq!((task.scheduled, task.repeater), (None, None));
    }

    #[test]
    fn a_repeat_set_on_an_undated_task_schedules_it_today() {
        let task = merged(Some(&todo()), json!({ "repeat": "1w" }))
            .unwrap()
            .unwrap();
        assert_eq!(task.scheduled.as_deref(), Some(TODAY));
        assert_eq!(
            task.repeater.map(|repeat| repeat.mode),
            Some(RepeatMode::CatchUp)
        );
        // Clearing the date in the same call still starts the new repeat today.
        let dated = TaskState {
            deadline: Some("2026-11-20".into()),
            ..todo()
        };
        let task = merged(Some(&dated), json!({ "deadline": "", "repeat": "1d" }))
            .unwrap()
            .unwrap();
        assert_eq!(task.scheduled.as_deref(), Some(TODAY));
    }

    #[test]
    fn planning_an_ordinary_block_makes_it_a_todo_task_or_an_appointment() {
        for arguments in [
            json!({ "priority": "high" }),
            json!({ "scheduled": "2026-11-05", "deadline": "2026-11-09" }),
            json!({ "repeat": "1w" }),
        ] {
            let task = merged(None, arguments.clone()).unwrap().unwrap();
            assert_eq!(task.status, Some(TaskStatus::Todo), "{arguments}");
        }
        // A repeat on a block with no task starts today, so it can advance.
        let task = merged(None, json!({ "repeat": "1w" })).unwrap().unwrap();
        assert_eq!(task.scheduled.as_deref(), Some(TODAY));
        // A date alone makes an appointment, as `@` planning does.
        let task = merged(
            None,
            json!({ "scheduled": "2026-11-05", "scheduled_time": "10:00" }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(task.status, None);
        // An appointment keeps having no status.
        let appointment = TaskState {
            scheduled: Some("2026-11-05".into()),
            ..TaskState::default()
        };
        let task = merged(Some(&appointment), json!({ "scheduled_time": "10:00" }))
            .unwrap()
            .unwrap();
        assert_eq!(task.status, None);
    }

    #[test]
    fn a_call_that_sets_nothing_is_refused() {
        for arguments in [
            json!({ "id": "block", "reason": "noop" }),
            json!({ "scheduled": null }),
            json!({ "warning_days": 0 }),
            json!({ "priority": "" }),
            json!({ "scheduled": "", "repeat": "none" }),
        ] {
            assert!(merged(None, arguments.clone()).is_err(), "{arguments}");
        }
        assert!(merged(Some(&todo()), json!({ "reason": "noop" })).is_err());
    }

    #[test]
    fn status_none_takes_no_other_task_field() {
        assert_eq!(
            merged(Some(&todo()), json!({ "status": "none" })).unwrap(),
            None
        );
        assert_eq!(
            merged(Some(&todo()), json!({ "status": "none", "priority": null })).unwrap(),
            None
        );
        let error = merged(
            Some(&todo()),
            json!({ "status": "none", "priority": "high", "scheduled": "2027-01-01" }),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("scheduled, priority"), "{error}");
    }

    #[test]
    fn warning_days_and_completed_on_take_bounded_or_empty_values() {
        let due = TaskState {
            deadline: Some("2026-12-24".into()),
            ..todo()
        };
        for days in [json!(-1), json!(366), json!(4_294_967_295_u64)] {
            let error = merged(Some(&due), json!({ "warning_days": days }))
                .unwrap_err()
                .to_string();
            assert_eq!(error, "warning_days must be from 0 to 365");
        }
        let task = merged(Some(&due), json!({ "warning_days": 365 }))
            .unwrap()
            .unwrap();
        assert_eq!(task.warning_days, Some(365));
        // An empty completion date means today, as leaving it out does.
        let task = merged(Some(&due), json!({ "status": "done", "completed_on": "" }))
            .unwrap()
            .unwrap();
        assert_eq!(
            (task.status, task.completed_on),
            (Some(TaskStatus::Done), None)
        );
    }
}
