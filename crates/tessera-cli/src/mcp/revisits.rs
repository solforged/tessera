use anyhow::Context;
use serde_json::Value;
use tessera_core::{AgentEdit, RevisitAction, RevisitRow};

use super::{Session, choice, integer, required, string};

impl Session<'_> {
    pub(super) async fn revisits(&self, arguments: &Value) -> anyhow::Result<String> {
        let due = string(arguments, "due")?.unwrap_or("today");
        let rows: Vec<RevisitRow> = self
            .api()
            .await?
            .get_with("/api/revisits", &[("due", due)])
            .await?;
        Ok(serde_json::to_string_pretty(&rows)?)
    }

    pub(super) async fn revisit(&self, arguments: &Value) -> anyhow::Result<String> {
        let next = arguments
            .get("next_on")
            .context("next_on is required; use null for no revisit date")?;
        let next_on = if next.is_null() {
            None
        } else {
            Some(
                next.as_str()
                    .context("next_on must be a date or null")?
                    .to_owned(),
            )
        };
        let action = choice::<RevisitAction>(
            &required(arguments, "action")?,
            "action",
            "revisited, later, resolve, reopen or keep_recurrent",
        )?;
        self.submit(
            arguments,
            AgentEdit::Revisit {
                id: required(arguments, "id")?,
                revision: integer(arguments, "revision")?,
                action,
                next_on,
            },
        )
        .await
    }
}
