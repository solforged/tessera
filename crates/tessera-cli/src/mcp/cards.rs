//! Tools for flashcards: list a block's, a page's or a queue's cards, review
//! statistics and decks, and hold or release a card.

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    AgentEdit, Block, CardQuery, CardQueryResult, CardSelection, CardUnit, Deck, Query, TypeInfo,
};

use super::notes::{clock, page_cards};
use super::render::{Clock, card_answer, card_label, location, name, one_line};
use super::{Api, Session, boolean, choice, integer, limit, required, segment, string};

impl Session<'_> {
    pub(super) async fn cards(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let clock = clock(&api).await?;
        match (string(arguments, "block_id")?, string(arguments, "page")?) {
            (Some(id), None) => {
                let cards: Vec<CardUnit> = api
                    .get(&format!("/api/blocks/{}/cards", segment(id)))
                    .await?;
                let cards: Vec<_> = cards.into_iter().filter(|card| card.active).collect();
                return Ok(unit_list(
                    &cards,
                    &clock,
                    &format!("Block {id} makes no card."),
                ));
            }
            (None, Some(title)) => {
                let page: Block = api
                    .get(&format!("/api/pages/by-title/{}", segment(title)))
                    .await
                    .with_context(|| format!("No page is titled {title:?}"))?;
                let cards = page_cards(&api, &page.id).await?;
                return Ok(unit_list(
                    &cards,
                    &clock,
                    &format!("{title:?} has no cards."),
                ));
            }
            (Some(_), Some(_)) => anyhow::bail!("Give block_id or page, not both."),
            (None, None) => {}
        }
        match string(arguments, "view")?.unwrap_or("queue") {
            "queue" => queue(&api, arguments, &clock).await,
            "stats" => stats(&api, arguments).await,
            "decks" => {
                let decks: Vec<Deck> = api.get("/api/decks").await?;
                if decks.is_empty() {
                    return Ok("No decks yet; every card is in the default queue.".into());
                }
                Ok(decks
                    .iter()
                    .map(|deck| {
                        format!(
                            "- {:?} (deck {}): {} cards\n",
                            deck.name,
                            deck.id,
                            name(deck.query.selection)
                        )
                    })
                    .collect())
            }
            view => anyhow::bail!("view must be queue, stats or decks, not {view:?}"),
        }
    }

    pub(super) async fn hold_card(&self, arguments: &Value) -> anyhow::Result<String> {
        self.submit(
            arguments,
            AgentEdit::SetCardHeld {
                card_id: required(arguments, "card_id")?,
                revision: integer(arguments, "revision")?,
                held: boolean(arguments, "held")?.unwrap_or(true),
            },
        )
        .await
    }
}

/// Due, new or all cards, optionally from a deck or a type's members.
async fn queue(api: &Api, arguments: &Value, clock: &Clock) -> anyhow::Result<String> {
    let selection: CardSelection = match string(arguments, "selection")? {
        None => CardSelection::Due,
        Some(selection) => choice(selection, "selection", "due, new or all")?,
    };
    let source = match (string(arguments, "deck")?, string(arguments, "type")?) {
        (Some(_), Some(_)) => anyhow::bail!("Give deck or type, not both."),
        (Some(wanted), None) => {
            let decks: Vec<Deck> = api.get("/api/decks").await?;
            let deck = decks
                .into_iter()
                .find(|deck| deck.id == wanted || deck.name.eq_ignore_ascii_case(wanted))
                .with_context(|| format!("No deck is named {wanted:?}."))?;
            deck.query.source
        }
        (None, Some(wanted)) => Some(Query {
            r#type: Some(type_id(api, wanted).await?),
            text: None,
            filters: Vec::new(),
            sort: Vec::new(),
            limit: None,
            offset: 0,
        }),
        (None, None) => None,
    };
    let result: CardQueryResult = api
        .post(
            "/api/cards/query",
            &CardQuery {
                source,
                selection,
                limit: Some(limit(arguments, "limit", 20, 500)?),
            },
        )
        .await?;
    if result.rows.is_empty() {
        return Ok(format!("No {} cards.", name(selection)));
    }
    let mut text = format!(
        "{} of {} {} cards:\n",
        result.rows.len(),
        result.total,
        name(selection)
    );
    for row in &result.rows {
        text.push_str(&format!(
            "- {}: {} → {} (block {}) {}",
            card_label(&row.card, clock),
            one_line(&row.card.front),
            card_answer(&row.card),
            row.source.block.id,
            location(&row.source.page)
        ));
        if let Some(review) = &row.last_review {
            text.push_str(&format!(
                ", last {} {}",
                review.grade.map(name).unwrap_or_else(|| "reset".into()),
                clock.date(review.created_at)
            ));
        }
        text.push('\n');
    }
    Ok(text)
}

/// Today's due counts, retention, streak and the coming week's forecast.
async fn stats(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let mut query = Vec::new();
    if let Some(wanted) = string(arguments, "deck")? {
        let decks: Vec<Deck> = api.get("/api/decks").await?;
        let deck = decks
            .into_iter()
            .find(|deck| deck.id == wanted || deck.name.eq_ignore_ascii_case(wanted))
            .with_context(|| format!("No deck is named {wanted:?}."))?;
        query.push(("deck", deck.id));
    }
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    // ReviewStats is serialize-only; read the fields this tool reports.
    let stats: Value = api.get_with("/api/review/stats", &query).await?;
    let count = |key: &str| stats[key].as_u64().unwrap_or(0);
    let mut text = format!(
        "{}: {} reviews and {} new cards due; {} cards in all; {} reviews this week; streak {} days",
        stats["date"].as_str().unwrap_or_default(),
        count("due_review"),
        count("due_new"),
        count("total_cards"),
        count("reviews_this_week"),
        count("streak"),
    );
    if let Some(retention) = stats["retention"].as_f64() {
        text.push_str(&format!("; retention {:.0}%", retention * 100.0));
    }
    text.push_str(".\n");
    let forecast: Vec<_> = stats["forecast"]
        .as_array()
        .into_iter()
        .flatten()
        .take(7)
        .map(|day| {
            format!(
                "{} {}",
                day["date"].as_str().unwrap_or_default(),
                day["count"].as_u64().unwrap_or(0)
            )
        })
        .collect();
    if !forecast.is_empty() {
        text.push_str(&format!("Due by day: {}.\n", forecast.join(", ")));
    }
    Ok(text)
}

fn unit_list(cards: &[CardUnit], clock: &Clock, empty: &str) -> String {
    if cards.is_empty() {
        return empty.to_owned();
    }
    cards
        .iter()
        .map(|card| {
            format!(
                "- {}: {} → {} (block {})\n",
                card_label(card, clock),
                one_line(&card.front),
                card_answer(card),
                card.source_block_id
            )
        })
        .collect()
}

/// A type's page ID from its title or plural, ignoring case.
pub(super) async fn type_id(api: &Api, wanted: &str) -> anyhow::Result<String> {
    let types: Vec<TypeInfo> = api.get("/api/types").await?;
    types
        .into_iter()
        .find(|info| {
            info.page.id == wanted
                || info.page.text.eq_ignore_ascii_case(wanted)
                || info
                    .plural
                    .as_deref()
                    .is_some_and(|plural| plural.eq_ignore_ascii_case(wanted))
        })
        .map(|info| info.page.id)
        .with_context(|| format!("No type is named {wanted:?}; tessera_query lists types."))
}
