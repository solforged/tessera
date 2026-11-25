//! Tools for pages and blocks: search, read, write, and the change history.

use std::collections::HashSet;

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    Actor, Block, BlockInPage, BlockKind, CardUnit, FieldsView, HistoryEntry, PageView,
    SettingsView, UndoReceipt,
};
use tessera_service::agent_tools::edits::{self, PageLookup};

use super::cards::found;
use super::render::{
    Clock, Fields, PageContext, TitleMap, age, card_answer, card_front, format_card_report,
    kind_label, location, problem_report, quoted, render, unread_cards_report,
};
use super::{Api, Session, Titles, boolean, integer, limit, offset, segment, string};

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
        let (lookup, subtree) = edits::read_page_target(arguments)?;
        let root: Block = match lookup {
            PageLookup::Title(title) => {
                // Another spelling or an alias also finds a page; a name
                // several pages share is refused with the service's message.
                found(&api, &format!("/api/pages/by-title/{}", segment(title)))
                    .await?
                    .with_context(|| format!("No atom is titled {title:?}"))?
            }
            PageLookup::Date(date) => api
                .get(&format!("/api/journal/{}", segment(date)))
                .await
                .with_context(|| format!("No journal day {date}"))?,
            PageLookup::Block(id) => api.get(&format!("/api/blocks/{}", segment(id))).await?,
        };
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
        let prepared = edits::add_note(arguments)?;
        let receipt = self.send(arguments, prepared.edit).await?;
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
            text.push_str(
                &report
                    .await
                    .unwrap_or_else(|error| unread_cards_report(&error, "tessera_read_page")),
            );
        }
        text.push_str(&problem_report(&prepared.problems, "tessera_edit_block"));
        Ok(text)
    }

    pub(super) async fn edit_block(&self, arguments: &Value) -> anyhow::Result<String> {
        let prepared = edits::edit_block_with_problems(arguments)?;
        let receipt = self.send(arguments, prepared.edit).await?;
        let mut report = self.describe(&receipt).await;
        if let Some(id) = prepared.edited_id {
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
            report.push_str(
                &cards
                    .await
                    .unwrap_or_else(|error| unread_cards_report(&error, "tessera_read_page")),
            );
        }
        report.push_str(&problem_report(&prepared.problems, "tessera_edit_block"));
        Ok(report)
    }

    pub(super) async fn move_block(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(arguments, edits::move_block(arguments)?).await
    }

    pub(super) async fn delete_block(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(arguments, edits::delete_block(arguments)?)
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
    Ok(format_card_report(cards, &clock, &TitleMap(titles.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_service::agent_outline::text_problems;

    #[test]
    fn problems_quote_the_whole_block_they_are_about() {
        let text = "What is 2 + 2? >> 4\nThe capital of France is {{c1::Paris}}.\n\
                    What is 3 + 3? >> 6 and a long tail that runs past sixty characters";
        assert_eq!(
            problem_report(&text_problems(text), "tessera_edit_block"),
            " Problems: “What is 2 + 2? >> 4 / The capital of France is {{c1::Paris}}. / \
             What is 3 + 3? >> 6 and a long tail that runs past sixty characters”: Use only \
             one card operator per atom; “What is 2 + 2? >> 4 / The capital of France is \
             {{c1::Paris}}. / What is 3 + 3? >> 6 and a long tail that runs past sixty \
             characters”: Do not mix card operators and clozes. Fix them with \
             tessera_edit_block."
        );
    }
}
