//! Explicit relation reads and undoable kind edits.
use anyhow::Context;
use serde_json::Value;
use tessera_core::{AgentEdit, BlockInPage, RelationEndpoint, RelationKind, RelationRow};

use super::render::{kind_label, location, one_line};
use super::{Session, Titles, choice, integer, limit, required, string};

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
        let count = limit(arguments, "limit", 50, 500)?;
        let api = self.api().await?;
        // Every match, so the reply can say how many there are.
        let rows: Vec<RelationRow> = api.get_with("/api/relations", &query).await?;
        if rows.is_empty() {
            return Ok("No relations match.".into());
        }
        let shown = &rows[..rows.len().min(count)];
        let holders: Vec<String> = shown
            .iter()
            .flat_map(|row| [Some(&row.source), row.target.as_ref()])
            .flatten()
            .filter_map(|endpoint| endpoint.holder_id.as_deref().map(reference))
            .collect();
        let texts = shown
            .iter()
            .flat_map(|row| {
                [
                    Some(&row.block),
                    Some(&row.source.block),
                    row.target.as_ref().map(|target| &target.block),
                ]
            })
            .flatten()
            .map(|block| block.block.text.as_str())
            .chain(holders.iter().map(String::as_str));
        let titles = Titles::load(&api, texts).await?;
        let mut text = format!("{} of {} relations:\n", shown.len(), rows.len());
        for row in shown {
            text.push_str(&relation_line(row, &titles));
        }
        Ok(text)
    }
}

/// `- supports “text” (block ID) on atom "Title" (id ID): from SOURCE to
/// TARGET`, then any problem.
fn relation_line(row: &RelationRow, titles: &Titles) -> String {
    let mut line = format!(
        "- {} {}: from {} to ",
        row.kind.as_str(),
        block(&row.block, titles),
        endpoint(&row.source, titles)
    );
    match &row.target {
        Some(target) => line.push_str(&endpoint(target, titles)),
        None => line.push_str("no target"),
    }
    if let Some(problem) = &row.problem {
        line.push_str(&format!("; problem: {problem}"));
    }
    line.push('\n');
    line
}

/// A relation's source or target, with the holder whose perspective it is.
fn endpoint(endpoint: &RelationEndpoint, titles: &Titles) -> String {
    let mut text = block(&endpoint.block, titles);
    if let Some(holder) = &endpoint.holder_id {
        text.push_str(&format!(
            " held by {} (id {holder})",
            titles.show(&reference(holder))
        ));
    }
    text
}

/// A page by its title, or a block by its text and where it lives.
fn block(block: &BlockInPage, titles: &Titles) -> String {
    let page = &block.page;
    if block.block.id == page.id {
        return format!("{} {:?} (id {})", kind_label(page.kind), page.text, page.id);
    }
    format!(
        "“{}” (block {}) {}",
        one_line(&titles.show(&block.block.text)),
        block.block.id,
        location(page)
    )
}

/// `[[ID]]`, which `Titles` shows by the page's title.
fn reference(id: &str) -> String {
    format!("[[{id}]]")
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
