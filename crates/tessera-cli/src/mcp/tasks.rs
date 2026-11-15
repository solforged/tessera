//! Tools for tasks: set one block's task state, and read the agenda or a
//! filtered task list.

use anyhow::Context;
use serde_json::Value;
use tessera_core::calendar::add_days;
use tessera_core::{
    Agenda, AgendaItem, AgendaReason, AgentEdit, Block, BlockCapabilities, DateRange, TaskFilter,
    TaskQuery, TaskQueryResult, TaskRow, TaskSelection, TaskStatus, TaskView,
};
use tessera_service::agent_tools::edits;

use super::notes::clock;
use super::render::{location, marker, name, one_line, task_details};
use super::{
    Session, Titles, boolean, choice, given, integer, limit, required, segment, string, strings,
};

const STATUSES: &str = "todo, doing, waiting, done or cancelled";

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

/// The tessera_tasks arguments only the agenda reads.
const AGENDA_ONLY: [&str; 3] = ["date", "days", "unplanned"];

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
        let today = if edits::sets_repeat(arguments)? {
            Some(clock(&api).await?.today)
        } else {
            None
        };
        let task = edits::task(current.task.as_ref(), arguments, today.as_deref())?;
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
            listed.iter().flat_map(|(_, items)| items).flat_map(|item| {
                [
                    item.source.block.text.as_str(),
                    item.source.page.text.as_str(),
                ]
            }),
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
                    &location(&titles.block(&item.source.page)),
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
        let agenda_only: Vec<&str> = AGENDA_ONLY
            .into_iter()
            .filter(|key| given(arguments, key))
            .collect();
        anyhow::ensure!(
            agenda_only.is_empty(),
            "The task list does not take these agenda arguments: {}. Pass view agenda to use them, or leave them out.",
            agenda_only.join(", ")
        );
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
            result.rows.iter().flat_map(|row| {
                [
                    row.source.block.text.as_str(),
                    row.source.page.text.as_str(),
                ]
            }),
        )
        .await?;
        let mut text = format!("{} of {} tasks:\n", result.rows.len(), result.total);
        for TaskRow { source, task, .. } in &result.rows {
            text.push_str(&task_line(
                task.status,
                &titles.show(&source.block.text),
                &source.block.id,
                &location(&titles.block(&source.page)),
                &task_details(task),
            ));
        }
        Ok(text)
    }
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
