//! Explicit relation reads and undoable kind edits.
use anyhow::Context;
use serde_json::Value;
use tessera_core::{AgentEdit, RelationKind, RelationRow};

use super::{Session, choice, integer, limit, required, string};

const KINDS: &str = "supports, disputes, qualifies or answers";

fn edit(arguments: &Value) -> anyhow::Result<AgentEdit> {
    let value = arguments
        .get("relation")
        .context("relation is required; use null to remove it")?;
    let relation = if value.is_null() {
        None
    } else {
        Some(choice::<RelationKind>(
            value
                .as_str()
                .context("relation must be a string or null")?,
            "relation",
            KINDS,
        )?)
    };
    Ok(AgentEdit::SetRelation {
        id: required(arguments, "id")?,
        revision: integer(arguments, "revision")?,
        relation,
    })
}

impl Session<'_> {
    pub(super) async fn set_relation(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(arguments, edit(arguments)?).await
    }

    pub(super) async fn relations(&self, arguments: &Value) -> anyhow::Result<String> {
        let mut query = Vec::new();
        for key in ["kind", "source", "target", "source_holder", "target_holder"] {
            if let Some(value) = string(arguments, key)? {
                if key == "kind" {
                    choice::<RelationKind>(value, key, KINDS)?;
                }
                query.push((key, value));
            }
        }
        anyhow::ensure!(
            !query.is_empty(),
            "Give a kind, source, target, source_holder or target_holder filter."
        );
        let count = limit(arguments, "limit", 50, 500)?.to_string();
        query.push(("limit", &count));
        let rows: Vec<RelationRow> = self.api().await?.get_with("/api/relations", &query).await?;
        Ok(serde_json::to_string_pretty(&rows)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn removing_a_relation_requires_explicit_null() {
        assert!(edit(&json!({ "id": "edge" })).is_err());
        assert!(edit(&json!({ "id": "edge", "relation": "none" })).is_err());
        assert!(matches!(
            edit(&json!({ "id": "edge", "relation": null })).unwrap(),
            AgentEdit::SetRelation { relation: None, .. }
        ));
        assert!(matches!(
            edit(&json!({ "id": "edge", "relation": "disputes", "revision": 7 })).unwrap(),
            AgentEdit::SetRelation {
                relation: Some(RelationKind::Disputes),
                revision: Some(7),
                ..
            }
        ));
    }
}
