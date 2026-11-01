//! Revisit reads and undoable revisit edits.
use anyhow::Context;
use serde_json::Value;
use tessera_core::{AgentEdit, RevisitAction, RevisitRow};

use super::render::{kind_label, location, name, one_line};
use super::{Session, Titles, choice, integer, limit, required, string};

/// The edit a tessera_revisit call asks for.
fn edit(arguments: &Value) -> anyhow::Result<AgentEdit> {
    let id = required(arguments, "id")?;
    let action = choice::<RevisitAction>(
        &required(arguments, "action")?,
        "action",
        "revisited, later, resolve, reopen or keep_recurrent",
    )?;
    let next = arguments.get("next_on").filter(|next| !next.is_null());
    let next_on = match action {
        RevisitAction::Resolve => {
            anyhow::ensure!(
                next.is_none(),
                "resolve clears the revisit date, so it takes no next_on. Leave next_on out."
            );
            None
        }
        RevisitAction::Reopen => {
            anyhow::ensure!(
                next.is_none(),
                "reopen takes no next_on. Leave next_on out, then set a date with action later."
            );
            None
        }
        RevisitAction::Revisited | RevisitAction::Later | RevisitAction::KeepRecurrent => {
            anyhow::ensure!(
                arguments.get("next_on").is_some(),
                "next_on is required; use null for no revisit date"
            );
            next.map(|next| {
                next.as_str()
                    .map(str::to_owned)
                    .context("next_on must be a date or null")
            })
            .transpose()?
        }
    };
    Ok(AgentEdit::Revisit {
        id,
        revision: integer(arguments, "revision")?,
        action,
        next_on,
    })
}

impl Session<'_> {
    pub(super) async fn revisits(&self, arguments: &Value) -> anyhow::Result<String> {
        let due = string(arguments, "due")?.unwrap_or("today");
        let count = limit(arguments, "limit", 50, 500)?;
        let api = self.api().await?;
        let rows: Vec<RevisitRow> = api.get_with("/api/revisits", &[("due", due)]).await?;
        if rows.is_empty() {
            return Ok(format!("Nothing is due for a revisit by {due}."));
        }
        let shown = &rows[..rows.len().min(count)];
        let titles = Titles::load(
            &api,
            shown
                .iter()
                .flat_map(|row| [row.block.block.text.as_str(), row.block.page.text.as_str()]),
        )
        .await?;
        let mut text = format!(
            "{} of {} revisits due by {due}, earliest first:\n",
            shown.len(),
            rows.len()
        );
        for row in shown {
            text.push_str(&revisit_line(row, &titles));
        }
        Ok(text)
    }

    pub(super) async fn revisit(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(arguments, edit(arguments)?).await
    }
}

/// `- atom "Title" (id ID): due DATE, …` for a titled note, or
/// `- “text” (block ID) on atom "Title" (id ID): question open, due DATE, …`.
fn revisit_line(row: &RevisitRow, titles: &Titles) -> String {
    let (block, page) = (&row.block.block, &row.block.page);
    let mut line = if block.id == page.id {
        format!(
            "- {} {:?} (id {})",
            kind_label(page.kind),
            titles.show(&page.text),
            page.id
        )
    } else {
        format!(
            "- “{}” (block {}) {}",
            one_line(&titles.show(&block.text)),
            block.id,
            location(&titles.block(page))
        )
    };
    let mut details = Vec::new();
    if let Some(status) = row.question_status {
        details.push(format!("question {}", name(status)));
    }
    details.push(format!("due {}", row.revisit_on));
    details.push(match &row.last_revisited_on {
        Some(day) => format!("last revisited {day}"),
        None => "never revisited".into(),
    });
    details.push(format!("proposed next_on {}", row.proposed_on));
    line.push_str(": ");
    line.push_str(&details.join(", "));
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn next_on(arguments: Value) -> anyhow::Result<Option<String>> {
        match edit(&arguments)? {
            AgentEdit::Revisit { next_on, .. } => Ok(next_on),
            edit => panic!("{edit:?}"),
        }
    }

    #[test]
    fn resolve_and_reopen_take_no_next_on() {
        for action in ["resolve", "reopen"] {
            assert_eq!(
                next_on(json!({ "id": "q", "action": action })).unwrap(),
                None
            );
            assert_eq!(
                next_on(json!({ "id": "q", "action": action, "next_on": null })).unwrap(),
                None
            );
            assert!(
                next_on(json!({ "id": "q", "action": action, "next_on": "2026-12-01" })).is_err(),
                "{action}"
            );
        }
    }

    #[test]
    fn other_actions_need_next_on_or_an_explicit_null() {
        for action in ["revisited", "later", "keep_recurrent"] {
            assert!(
                next_on(json!({ "id": "q", "action": action })).is_err(),
                "{action}"
            );
            assert_eq!(
                next_on(json!({ "id": "q", "action": action, "next_on": null })).unwrap(),
                None
            );
            assert_eq!(
                next_on(json!({ "id": "q", "action": action, "next_on": "2026-12-01" }))
                    .unwrap()
                    .as_deref(),
                Some("2026-12-01")
            );
            assert!(next_on(json!({ "id": "q", "action": action, "next_on": 5 })).is_err());
        }
    }
}
