//! The edits the shared write tools ask for, read from their arguments. Both
//! the MCP server and the in-app agent commit what these return, so a call
//! means the same on either surface.

use anyhow::Context;
use serde_json::Value;
use tessera_core::calendar::{RepeatMode, RepeatUnit, Repeater};
use tessera_core::{AgentEdit, BlockTarget, TaskPriority, TaskState, TaskStatus};

use super::args::{boolean, choice, given, integer, required, string};
use crate::agent_outline::{block_problems, block_text, outline, text_problems};

const MODES: &str = "fixed, catch_up or after_completion";

/// What set_task sets besides `status`.
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

/// How a `read_page` call identifies the page or block to read.
pub enum PageLookup<'a> {
    Title(&'a str),
    Date(&'a str),
    Block(&'a str),
}

/// Validate a `read_page` call's target and subtree flag.
pub fn read_page_target(arguments: &Value) -> anyhow::Result<(PageLookup<'_>, bool)> {
    let id = string(arguments, "id")?;
    let lookup = match (string(arguments, "title")?, string(arguments, "date")?, id) {
        (Some(title), None, None) => {
            let title = title.trim();
            anyhow::ensure!(!title.is_empty(), "title must not be empty");
            PageLookup::Title(title)
        }
        (None, Some(date), None) => PageLookup::Date(date),
        (None, None, Some(id)) => PageLookup::Block(id),
        _ => anyhow::bail!("Give exactly one of title, date or id."),
    };
    let subtree = boolean(arguments, "subtree")?.unwrap_or(false);
    anyhow::ensure!(!subtree || id.is_some(), "subtree needs id.");
    Ok((lookup, subtree))
}

/// Where add_note appends: a page, a journal day or under a block, and
/// today's journal when none is given.
pub fn block_target(arguments: &Value) -> anyhow::Result<BlockTarget> {
    Ok(
        match (
            string(arguments, "page")?,
            string(arguments, "journal")?,
            string(arguments, "parent_id")?,
        ) {
            (Some(title), None, None) => BlockTarget::Page {
                title: title.to_owned(),
            },
            (None, journal, None) => BlockTarget::Journal {
                date: journal.filter(|date| *date != "today").map(str::to_owned),
            },
            (None, None, Some(id)) => BlockTarget::Block { id: id.to_owned() },
            _ => anyhow::bail!("Give at most one of page, journal or parent_id."),
        },
    )
}

pub use block_target as note_target;

/// A parsed write-tool call with any syntax warnings on its blocks.
pub struct PreparedEdit {
    pub edit: AgentEdit,
    pub edited_id: Option<String>,
    pub problems: Vec<(String, String)>,
}

/// Parse an `add_note` call into its [`AgentEdit`] and any card/shorthand problems.
pub fn add_note(arguments: &Value) -> anyhow::Result<PreparedEdit> {
    let markdown = string(arguments, "markdown")?.context("markdown is required")?;
    let blocks = outline(markdown)?;
    anyhow::ensure!(!blocks.is_empty(), "Nothing to add: the text is empty.");
    let target = block_target(arguments)?;
    let problems = block_problems(&blocks);
    Ok(PreparedEdit {
        edit: AgentEdit::AddBlocks { target, blocks },
        edited_id: None,
        problems,
    })
}

/// An edit_block call: new text, heading level, or both, with any text problems.
pub fn edit_block_with_problems(arguments: &Value) -> anyhow::Result<PreparedEdit> {
    let edit = edit_block(arguments)?;
    let AgentEdit::EditBlock { id, text, .. } = &edit else {
        unreachable!("edit_block reads an EditBlock")
    };
    let edited_id = text.is_some().then(|| id.clone());
    let problems = text.as_deref().map(text_problems).unwrap_or_default();
    Ok(PreparedEdit {
        edit,
        edited_id,
        problems,
    })
}

/// An edit_block call: new text, heading level, or both.
pub fn edit_block(arguments: &Value) -> anyhow::Result<AgentEdit> {
    let text = string(arguments, "text")?.map(block_text);
    let heading = integer(arguments, "heading")?
        .map(|level| {
            u8::try_from(level)
                .ok()
                .filter(|level| *level <= 3)
                .context("heading must be from 0 to 3")
        })
        .transpose()?;
    anyhow::ensure!(
        text.is_some() || heading.is_some(),
        "Give text, heading or both."
    );
    Ok(AgentEdit::EditBlock {
        id: required(arguments, "id")?,
        revision: integer(arguments, "revision")?,
        text,
        heading,
    })
}

pub fn move_block(arguments: &Value) -> anyhow::Result<AgentEdit> {
    Ok(AgentEdit::MoveBlock {
        id: required(arguments, "id")?,
        revision: integer(arguments, "revision")?,
        parent_id: string(arguments, "parent_id")?.map(str::to_owned),
        after: string(arguments, "after")?.map(str::to_owned),
        first: boolean(arguments, "first")?.unwrap_or(false),
    })
}

pub fn delete_block(arguments: &Value) -> anyhow::Result<AgentEdit> {
    Ok(AgentEdit::DeleteBlock {
        id: required(arguments, "id")?,
        revision: integer(arguments, "revision")?,
    })
}

/// The task state a set_task call asks for: its fields merged into the
/// block's `current` task, or `None` to remove the task. `today` must be
/// given when the call sets a repeat (see `sets_repeat`).
pub fn task(
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
pub fn sets_repeat(arguments: &Value) -> anyhow::Result<bool> {
    Ok(
        !matches!(string(arguments, "repeat")?, None | Some("" | "none"))
            || string(arguments, "repeat_mode")?.is_some(),
    )
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
        task(current, &arguments, Some(TODAY))
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
