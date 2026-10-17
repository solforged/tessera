//! Tools for pages and blocks: search, read, write, and the change history.

use std::collections::{HashMap, HashSet};

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    AgentChange, AgentEdit, Block, BlockInPage, BlockKind, CardUnit, FieldsView, NoteTarget,
    PageView, SettingsView, UndoReceipt,
};

use super::outline::{note_problems, outline, text_problems};
use super::render::{
    Clock, PageContext, age, card_answer, card_front, card_label, kind_label, location, quoted,
    render, snippet,
};
use super::{Api, Session, boolean, describe, integer, required, segment, string};

impl Session<'_> {
    pub(super) async fn search(&self, arguments: &Value) -> anyhow::Result<String> {
        let query = string(arguments, "query")?.context("query is required")?;
        let limit = arguments["limit"].as_u64().unwrap_or(20).to_string();
        let hits: Vec<BlockInPage> = self
            .api()
            .await?
            .get_with("/api/search", &[("q", query), ("limit", &limit)])
            .await?;
        if hits.is_empty() {
            return Ok(format!("No blocks match {query:?}."));
        }
        let mut text = String::new();
        for hit in hits {
            text.push_str(&format!(
                "- {} (block {}) {}\n",
                hit.block.text.replace('\n', " "),
                hit.block.id,
                location(&hit.page)
            ));
        }
        Ok(text)
    }

    pub(super) async fn list_pages(&self, arguments: &Value) -> anyhow::Result<String> {
        let limit = arguments["limit"].as_u64().unwrap_or(100) as usize;
        let journals = arguments["journals"].as_bool().unwrap_or(false);
        let roots: Vec<Block> = self.api().await?.get("/api/roots").await?;
        let mut text = String::new();
        for root in roots
            .iter()
            .filter(|root| journals || root.kind == BlockKind::Page)
            .take(limit)
        {
            text.push_str(&format!(
                "- {} {:?} (id {})\n",
                kind_label(root.kind),
                root.text,
                root.id
            ));
        }
        Ok(if text.is_empty() {
            "The workshop has no pages yet.".into()
        } else {
            text
        })
    }

    pub(super) async fn read_page(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let id = string(arguments, "id")?;
        let root: Block = match (string(arguments, "title")?, string(arguments, "date")?, id) {
            (Some(title), None, None) => api
                .get(&format!("/api/pages/by-title/{}", segment(title)))
                .await
                .with_context(|| format!("No page is titled {title:?}"))?,
            (None, Some(date), None) => api
                .get(&format!("/api/journal/{}", segment(date)))
                .await
                .with_context(|| format!("No journal day {date}"))?,
            (None, None, Some(id)) => api.get(&format!("/api/blocks/{}", segment(id))).await?,
            _ => anyhow::bail!("Give exactly one of title, date or id."),
        };
        let subtree = boolean(arguments, "subtree")?.unwrap_or(false);
        anyhow::ensure!(!subtree || id.is_some(), "subtree needs id.");
        let page: PageView = api.get(&format!("/api/pages/{}", root.page_id)).await?;
        let cards = page_cards(&api, &page.root.id).await?;
        let fields = field_names(&api).await?;
        let clock = clock(&api).await?;
        render(
            &page,
            &PageContext {
                fields: &fields,
                cards: &cards,
                clock: &clock,
            },
            subtree.then_some(root.id.as_str()),
        )
    }

    pub(super) async fn add_note(&self, arguments: &Value) -> anyhow::Result<String> {
        let markdown = string(arguments, "markdown")?.context("markdown is required")?;
        let blocks = outline(markdown);
        anyhow::ensure!(!blocks.is_empty(), "The note has no content.");
        let target = match (
            string(arguments, "page")?,
            string(arguments, "journal")?,
            string(arguments, "parent_id")?,
        ) {
            (Some(title), None, None) => NoteTarget::Page {
                title: title.to_owned(),
            },
            (None, journal, None) => NoteTarget::Journal {
                date: journal.filter(|date| *date != "today").map(str::to_owned),
            },
            (None, None, Some(id)) => NoteTarget::Block { id: id.to_owned() },
            _ => anyhow::bail!("Give at most one of page, journal or parent_id."),
        };
        let problems = note_problems(&blocks);
        let receipt = self
            .send(arguments, AgentEdit::AddNote { target, blocks })
            .await?;
        let mut text = describe(&receipt);
        if let Some(page) = &receipt.page {
            let api = self.api().await?;
            let added: HashSet<&str> = receipt.blocks.iter().map(|b| b.id.as_str()).collect();
            let cards: Vec<CardUnit> = page_cards(&api, &page.id)
                .await?
                .into_iter()
                .filter(|card| added.contains(card.source_block_id.as_str()))
                .collect();
            text.push_str(&card_report(&api, &cards).await?);
        }
        text.push_str(&problem_report(&problems));
        Ok(text)
    }

    pub(super) async fn edit_block(&self, arguments: &Value) -> anyhow::Result<String> {
        let text = string(arguments, "text")?.map(str::to_owned);
        let heading = integer(arguments, "heading")?
            .map(|level| u8::try_from(level).context("heading must be 0 to 3"))
            .transpose()?;
        anyhow::ensure!(
            text.is_some() || heading.is_some(),
            "Give text, heading or both."
        );
        let id = required(arguments, "id")?;
        let problems = text.as_deref().map(text_problems).unwrap_or_default();
        let edited = text.is_some();
        let receipt = self
            .send(
                arguments,
                AgentEdit::EditBlock {
                    id: id.clone(),
                    revision: integer(arguments, "revision")?,
                    text,
                    heading,
                },
            )
            .await?;
        let mut report = describe(&receipt);
        if edited {
            let api = self.api().await?;
            let cards: Vec<CardUnit> = api
                .get::<Vec<CardUnit>>(&format!("/api/blocks/{}/cards", segment(&id)))
                .await?
                .into_iter()
                .filter(|card| card.active)
                .collect();
            report.push_str(&card_report(&api, &cards).await?);
        }
        report.push_str(&problem_report(&problems));
        Ok(report)
    }

    pub(super) async fn move_block(&self, arguments: &Value) -> anyhow::Result<String> {
        let first = boolean(arguments, "first")?.unwrap_or(false);
        self.submit(
            arguments,
            AgentEdit::MoveBlock {
                id: required(arguments, "id")?,
                revision: integer(arguments, "revision")?,
                parent_id: string(arguments, "parent_id")?.map(str::to_owned),
                after: string(arguments, "after")?.map(str::to_owned),
                first,
            },
        )
        .await
    }

    pub(super) async fn delete_block(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(
            arguments,
            AgentEdit::DeleteBlock {
                id: required(arguments, "id")?,
                revision: integer(arguments, "revision")?,
            },
        )
        .await
    }

    pub(super) async fn recent_changes(&self, arguments: &Value) -> anyhow::Result<String> {
        let limit = integer(arguments, "limit")?.unwrap_or(20).to_string();
        let changes: Vec<AgentChange> = self
            .api()
            .await?
            .get_with("/api/agent-changes", &[("limit", &limit)])
            .await?;
        if changes.is_empty() {
            return Ok("No agent changes yet.".into());
        }
        let now = tessera_core::now_ms();
        let mut text = String::new();
        for change in changes {
            let who = match &change.actor {
                tessera_core::Actor::Agent { name } | tessera_core::Actor::Client { name } => {
                    name.as_str()
                }
                tessera_core::Actor::Person => "a person",
            };
            text.push_str(&format!(
                "- change {}: {} (by {who}, {})",
                change.seq,
                change.summary,
                age(now - change.created_at)
            ));
            if let Some(by) = change.undone_by {
                text.push_str(&format!(", undone by change {by}"));
            }
            text.push('\n');
        }
        Ok(text)
    }

    pub(super) async fn undo(&self, arguments: &Value) -> anyhow::Result<String> {
        let seq = integer(arguments, "change")?.context("change is required")?;
        let receipt: UndoReceipt = self
            .api()
            .await?
            .post(
                &format!("/api/agent-changes/{seq}/undo"),
                &serde_json::json!({ "actor": self.actor() }),
            )
            .await?;
        // The undo's own number is an agent change number, which the receipt
        // lacks; `committed.seq` counts every notebook change, so it is not it.
        let mut text = format!(
            "Undid change {}; tessera_recent_changes lists the undo.",
            receipt.undone
        );
        if !receipt.kept_pages.is_empty() {
            text.push_str(&format!(
                " Kept pages still in use: {}.",
                quoted(&receipt.kept_pages)
            ));
        }
        Ok(text)
    }
}

/// Active cards whose source blocks are on the page, held ones included.
pub(super) async fn page_cards(api: &Api, page_id: &str) -> anyhow::Result<Vec<CardUnit>> {
    api.get(&format!("/api/pages/{}/cards", segment(page_id)))
        .await
}

/// Field definition names by ID.
pub(super) async fn field_names(api: &Api) -> anyhow::Result<HashMap<String, String>> {
    let fields: FieldsView = api.get("/api/fields").await?;
    Ok(fields
        .fields
        .into_iter()
        .map(|field| (field.definition.id, field.definition.name))
        .collect())
}

pub(super) async fn clock(api: &Api) -> anyhow::Result<Clock> {
    Clock::new(&api.get::<SettingsView>("/api/settings").await?)
}

/// ` Cards: …` naming the cards a write left on its blocks, with what each
/// shows and what it asks for, so a reversed direction is plain at once.
async fn card_report(api: &Api, cards: &[CardUnit]) -> anyhow::Result<String> {
    if cards.is_empty() {
        return Ok(String::new());
    }
    let clock = clock(api).await?;
    let labels: Vec<_> = cards
        .iter()
        .map(|card| {
            format!(
                "{} on block {} shows “{}” and asks for “{}”",
                card_label(card, &clock),
                card.source_block_id,
                snippet(&card_front(card)),
                snippet(&card_answer(card))
            )
        })
        .collect();
    Ok(format!(" Cards: {}.", labels.join("; ")))
}

/// ` Problems …` for card syntax that made no card and field lines that
/// stayed text.
fn problem_report(problems: &[(String, String)]) -> String {
    if problems.is_empty() {
        return String::new();
    }
    let lines: Vec<_> = problems
        .iter()
        .map(|(text, message)| {
            let message = message.trim_end_matches('.');
            format!("“{}”: {message}", snippet(text))
        })
        .collect();
    format!(
        " Problems: {}. Fix them with tessera_edit_block.",
        lines.join("; ")
    )
}
