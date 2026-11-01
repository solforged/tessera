//! Tools for pages and blocks: search, read, write, and the change history.

use std::collections::HashSet;

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    Actor, AgentEdit, Block, BlockInPage, BlockKind, CardUnit, FieldsView, HistoryEntry,
    NoteTarget, PageView, SettingsView, UndoReceipt,
};

use super::cards::found;
use super::outline::{block_text, note_problems, outline, text_problems};
use super::render::{
    Clock, Fields, PageContext, age, card_answer, card_front, card_label, kind_label, location,
    one_line, quoted, render, snippet,
};
use super::{Api, Session, Titles, boolean, integer, limit, offset, required, segment, string};

/// The most hits tessera_search returns.
const SEARCH_LIMIT: usize = 200;

/// The most pages one tessera_list_pages call lists.
const PAGES_LIMIT: usize = 1000;

/// The most entries tessera_recent_changes lists, the history route's cap.
const HISTORY_LIMIT: usize = 500;

impl Session<'_> {
    pub(super) async fn search(&self, arguments: &Value) -> anyhow::Result<String> {
        let query = string(arguments, "query")?.context("query is required")?;
        let count = limit(arguments, "limit", 20, SEARCH_LIMIT)?.to_string();
        let api = self.api().await?;
        let hits: Vec<BlockInPage> = api
            .get_with("/api/search", &[("q", query), ("limit", &count)])
            .await?;
        if hits.is_empty() {
            return Ok(format!("No atoms match {query:?}."));
        }
        let titles = Titles::lenient(
            &api,
            hits.iter()
                .flat_map(|hit| [hit.block.text.as_str(), hit.page.text.as_str()]),
        )
        .await;
        let mut text = String::new();
        for hit in &hits {
            text.push_str(&format!(
                "- {} (block {}) {}\n",
                titles.show(&hit.block.text).replace('\n', " "),
                hit.block.id,
                location(&titles.block(&hit.page))
            ));
        }
        Ok(text)
    }

    pub(super) async fn list_pages(&self, arguments: &Value) -> anyhow::Result<String> {
        let count = limit(arguments, "limit", 100, PAGES_LIMIT)?;
        let skip = offset(arguments)?.unwrap_or(0);
        let journals = boolean(arguments, "journals")?.unwrap_or(false);
        let api = self.api().await?;
        let roots: Vec<Block> = api.get("/api/roots").await?;
        let roots: Vec<&Block> = roots
            .iter()
            .filter(|root| journals || root.kind == BlockKind::Page)
            .collect();
        if roots.is_empty() {
            return Ok("The workshop has no titled atoms yet.".into());
        }
        let total = roots.len();
        if skip >= total {
            return Ok(format!(
                "The list has {total} entries, so offset {skip} is past the end; give an offset below {total}."
            ));
        }
        let shown = &roots[skip..total.min(skip + count)];
        let titles = Titles::lenient(&api, shown.iter().map(|root| root.text.as_str())).await;
        let mut text = String::new();
        for root in shown {
            text.push_str(&format!(
                "- {} {:?} (id {})\n",
                kind_label(root.kind),
                titles.show(&root.text),
                root.id
            ));
        }
        let next = skip + shown.len();
        if next < total {
            text.push_str(&format!(
                "{} more follow; pass offset: {next} to list them.\n",
                total - next
            ));
        }
        Ok(text)
    }

    pub(super) async fn read_page(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let id = string(arguments, "id")?;
        let root: Block = match (string(arguments, "title")?, string(arguments, "date")?, id) {
            (Some(title), None, None) => {
                let title = title.trim();
                anyhow::ensure!(!title.is_empty(), "title must not be empty");
                // Another spelling or an alias also finds a page; a name
                // several pages share is refused with the service's message.
                found(&api, &format!("/api/pages/by-title/{}", segment(title)))
                    .await?
                    .with_context(|| format!("No atom is titled {title:?}"))?
            }
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
        let fields = fields(&api).await?;
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
        let blocks = outline(markdown)?;
        anyhow::ensure!(!blocks.is_empty(), "Nothing to add: the text is empty.");
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
        // The change is committed. What follows only reports on it, so a
        // failed read is a note in the result rather than an error that
        // would invite a retry.
        let mut text = self.describe(&receipt).await;
        if let Some(page) = &receipt.page {
            let added: HashSet<&str> = receipt.blocks.iter().map(|b| b.id.as_str()).collect();
            let report = async {
                let api = self.api().await?;
                let cards: Vec<CardUnit> = page_cards(&api, &page.id)
                    .await?
                    .into_iter()
                    .filter(|card| added.contains(card.source_block_id.as_str()))
                    .collect();
                card_report(&api, &cards).await
            };
            text.push_str(&report.await.unwrap_or_else(|error| unread(&error)));
        }
        text.push_str(&problem_report(&problems));
        Ok(text)
    }

    pub(super) async fn edit_block(&self, arguments: &Value) -> anyhow::Result<String> {
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
        let mut report = self.describe(&receipt).await;
        if edited {
            let cards = async {
                let api = self.api().await?;
                let cards: Vec<CardUnit> = api
                    .get::<Vec<CardUnit>>(&format!("/api/blocks/{}/cards", segment(&id)))
                    .await?
                    .into_iter()
                    .filter(|card| card.active)
                    .collect();
                card_report(&api, &cards).await
            };
            report.push_str(&cards.await.unwrap_or_else(|error| unread(&error)));
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
        let count = limit(arguments, "limit", 20, HISTORY_LIMIT)?;
        let before = integer(arguments, "before")?;
        #[derive(serde::Deserialize)]
        struct History {
            entries: Vec<HistoryEntry>,
        }
        let api = self.api().await?;
        let limit = count.to_string();
        let older = before.map(|before| before.to_string());
        let mut query = vec![("limit", limit.as_str())];
        query.extend(older.as_deref().map(|before| ("before", before)));
        let history: History = api.get_with("/api/history", &query).await?;
        if history.entries.is_empty() {
            return Ok(match before {
                Some(before) => format!("No changes before change {before}."),
                None => "No history yet.".into(),
            });
        }
        let titles = Titles::lenient(
            &api,
            history.entries.iter().map(|change| change.summary.as_str()),
        )
        .await;
        let now = tessera_core::now_ms();
        let mut text = String::new();
        for change in &history.entries {
            let who = match &change.actor {
                Actor::Agent { name } => format!("agent {name}"),
                Actor::Client { name } => format!("client {name}"),
                Actor::Person => "a person".into(),
            };
            text.push_str(&format!(
                "- change {}: {} (by {who}, {})",
                change.seq,
                titles.show(&change.summary),
                age(now - change.created_at)
            ));
            if let Some(by) = change.undone_by {
                text.push_str(&format!(", undone by change {by}"));
            }
            if let Some(seq) = change.undoes {
                text.push_str(&format!(", undid change {seq}"));
            }
            if !change.undoable && change.undone_by.is_none() {
                text.push_str(", no undo available");
            }
            text.push('\n');
        }
        if history.entries.len() == count
            && let Some(oldest) = history.entries.last().filter(|oldest| oldest.seq > 1)
        {
            text.push_str(&format!(
                "Older changes may follow; pass before: {} to list them.\n",
                oldest.seq
            ));
        }
        Ok(text)
    }

    pub(super) async fn undo(&self, arguments: &Value) -> anyhow::Result<String> {
        let seq = integer(arguments, "change")?.context("change is required")?;
        let api = self.api().await?;
        let receipt: UndoReceipt = api
            .post(
                &format!("/api/history/{seq}/undo"),
                &serde_json::json!({ "actor": self.actor() }),
            )
            .await?;
        let mut text = format!(
            "Undid change {} as change {}; tessera_recent_changes lists the history.",
            receipt.undone, receipt.seq
        );
        if !receipt.kept_pages.is_empty() {
            let titles = Titles::lenient(
                &api,
                receipt.kept_pages.iter().map(|page| page.text.as_str()),
            )
            .await;
            let kept = titles.blocks(&receipt.kept_pages);
            text.push_str(&format!(" Kept atoms still in use: {}.", quoted(&kept)));
        }
        Ok(text)
    }
}

/// Active cards whose source blocks are on the page, held ones included.
pub(super) async fn page_cards(api: &Api, page_id: &str) -> anyhow::Result<Vec<CardUnit>> {
    api.get(&format!("/api/pages/{}/cards", segment(page_id)))
        .await
}

/// Field definitions as tessera_read_page names them.
pub(super) async fn fields(api: &Api) -> anyhow::Result<Fields> {
    Ok(Fields::from(api.get::<FieldsView>("/api/fields").await?))
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
    let sides: Vec<_> = cards
        .iter()
        .map(|card| (card_front(card), card_answer(card)))
        .collect();
    let titles = Titles::lenient(
        api,
        sides
            .iter()
            .flat_map(|(front, answer)| [front.as_str(), answer.as_str()]),
    )
    .await;
    let labels: Vec<_> = cards
        .iter()
        .zip(&sides)
        .map(|(card, (front, answer))| {
            format!(
                "{} on block {} shows “{}” and asks for “{}”",
                card_label(card, &clock),
                card.source_block_id,
                snippet(&titles.show(front)),
                snippet(&titles.show(answer))
            )
        })
        .collect();
    Ok(format!(" Cards: {}.", labels.join("; ")))
}

/// ` …` for a committed write whose cards could not be read back.
fn unread(error: &anyhow::Error) -> String {
    format!(
        " The change is saved, but its cards could not be read: {error:#}. Do not repeat the \
         call; tessera_read_page shows the cards."
    )
}

/// ` Problems …` for card syntax that made no card and field lines that
/// stayed text, quoting the whole block or line each is about.
fn problem_report(problems: &[(String, String)]) -> String {
    if problems.is_empty() {
        return String::new();
    }
    let lines: Vec<_> = problems
        .iter()
        .map(|(text, message)| {
            let message = message.trim_end_matches('.');
            format!("“{}”: {message}", one_line(text))
        })
        .collect();
    format!(
        " Problems: {}. Fix them with tessera_edit_block.",
        lines.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::outline::text_problems;

    #[test]
    fn problems_quote_the_whole_block_they_are_about() {
        let text = "What is 2 + 2? >> 4\nThe capital of France is {{c1::Paris}}.\n\
                    What is 3 + 3? >> 6 and a long tail that runs past sixty characters";
        assert_eq!(
            problem_report(&text_problems(text)),
            " Problems: “What is 2 + 2? >> 4 / The capital of France is {{c1::Paris}}. / \
             What is 3 + 3? >> 6 and a long tail that runs past sixty characters”: Use only \
             one card operator per atom; “What is 2 + 2? >> 4 / The capital of France is \
             {{c1::Paris}}. / What is 3 + 3? >> 6 and a long tail that runs past sixty \
             characters”: Do not mix card operators and clozes. Fix them with \
             tessera_edit_block."
        );
    }
}
