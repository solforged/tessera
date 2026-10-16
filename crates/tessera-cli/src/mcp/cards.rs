//! Tools for flashcards: list a block's, a page's or a queue's cards, review
//! statistics and decks, and hold or release a card.

use std::collections::HashMap;

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    AgentEdit, Block, CardQuery, CardQueryResult, CardSelection, CardUnit, Deck, FieldDefinition,
    FieldsView, Query, TypeInfo,
};

use super::notes::{clock, page_cards};
use super::query::filters;
use super::render::{Clock, card_answer, card_front, card_label, location, name};
use super::{Api, Session, boolean, choice, describe, integer, limit, required, segment, string};

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
                let names = Names::load(&api).await?;
                Ok(decks
                    .iter()
                    .map(|deck| {
                        format!(
                            "- {:?} (deck {} r{}): {} cards from {}\n",
                            deck.name,
                            deck.id,
                            deck.revision,
                            name(deck.query.selection),
                            names.scope(deck.query.source.as_ref())
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

    pub(super) async fn save_deck(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let decks: Vec<Deck> = api.get("/api/decks").await?;
        let existing = string(arguments, "deck")?
            .map(|wanted| find_deck(&decks, wanted))
            .transpose()?;
        let revision = integer(arguments, "revision")?;
        if boolean(arguments, "delete")?.unwrap_or(false) {
            let deck = existing.context("Give the deck to delete.")?;
            return self
                .submit(
                    arguments,
                    AgentEdit::DeleteDeck {
                        id: deck.id.clone(),
                        revision,
                    },
                )
                .await;
        }
        let fields: FieldsView = api.get("/api/fields").await?;
        let definitions: Vec<&FieldDefinition> = fields
            .fields
            .iter()
            .map(|field| &field.definition)
            .collect();
        let r#type = match string(arguments, "type")? {
            Some(wanted) => Some(type_id(&api, wanted).await?),
            None => None,
        };
        let text = string(arguments, "text")?.map(str::to_owned);
        let filters = filters(arguments, &definitions)?;
        // Selecting arguments replace an existing deck's source; without any,
        // it keeps the one it has.
        let source = if r#type.is_some() || text.is_some() || !filters.is_empty() {
            Some(Query {
                r#type,
                text,
                filters,
                sort: Vec::new(),
                limit: None,
                offset: 0,
                ..Default::default()
            })
        } else {
            existing.and_then(|deck| deck.query.source.clone())
        };
        anyhow::ensure!(
            source.is_some(),
            "A deck needs type, text or filters to choose its cards."
        );
        let selection = match string(arguments, "selection")? {
            Some(selection) => choice(selection, "selection", "due, new or all")?,
            None => existing.map_or(CardSelection::Due, |deck| deck.query.selection),
        };
        let deck_name = match (string(arguments, "name")?, existing) {
            (Some(name), _) => name.to_owned(),
            (None, Some(deck)) => deck.name.clone(),
            (None, None) => anyhow::bail!("A new deck needs a name."),
        };
        let receipt = self
            .send(
                arguments,
                AgentEdit::SaveDeck {
                    id: existing.map(|deck| deck.id.clone()),
                    revision,
                    name: deck_name,
                    query: Box::new(CardQuery {
                        source,
                        selection,
                        limit: None,
                    }),
                },
            )
            .await?;
        let mut text = describe(&receipt);
        let names = Names::load(&api).await?;
        for deck in &receipt.decks {
            let all: CardQueryResult = api
                .post(
                    "/api/cards/query",
                    &CardQuery {
                        source: deck.query.source.clone(),
                        selection: CardSelection::All,
                        limit: Some(1),
                    },
                )
                .await?;
            text.push_str(&format!(
                " Deck {} r{} reviews {} cards from {}; it holds {} cards now.",
                deck.id,
                deck.revision,
                name(deck.query.selection),
                names.scope(deck.query.source.as_ref()),
                all.total
            ));
        }
        Ok(text)
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
        (Some(wanted), None) => find_deck(&api.get::<Vec<Deck>>("/api/decks").await?, wanted)?
            .query
            .source
            .clone(),
        (None, Some(wanted)) => Some(Query {
            r#type: Some(type_id(api, wanted).await?),
            text: None,
            filters: Vec::new(),
            sort: Vec::new(),
            limit: None,
            offset: 0,
            ..Default::default()
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
            card_front(&row.card),
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
                card_front(card),
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

/// A deck by ID or name, ignoring case.
fn find_deck<'a>(decks: &'a [Deck], wanted: &str) -> anyhow::Result<&'a Deck> {
    decks
        .iter()
        .find(|deck| deck.id == wanted || deck.name.eq_ignore_ascii_case(wanted))
        .with_context(|| format!("No deck is named {wanted:?}."))
}

/// Type and field names, for saying which blocks a deck draws from.
struct Names {
    types: HashMap<String, String>,
    fields: HashMap<String, String>,
}

impl Names {
    async fn load(api: &Api) -> anyhow::Result<Self> {
        let types: Vec<TypeInfo> = api.get("/api/types").await?;
        let fields: FieldsView = api.get("/api/fields").await?;
        Ok(Self {
            types: types
                .into_iter()
                .map(|info| (info.page.id, info.page.text))
                .collect(),
            fields: fields
                .fields
                .into_iter()
                .map(|field| (field.definition.id, field.definition.name))
                .collect(),
        })
    }

    /// `blocks of type Kanji with Language is ja`, or `every block`.
    fn scope(&self, source: Option<&Query>) -> String {
        let Some(source) = source else {
            return "every block".into();
        };
        let mut text = match &source.r#type {
            Some(id) => format!(
                "blocks of type {}",
                self.types.get(id).map_or(id.as_str(), String::as_str)
            ),
            None => "blocks".into(),
        };
        if let Some(words) = &source.text {
            text.push_str(&format!(" containing {words:?}"));
        }
        let conditions: Vec<_> = source
            .filters
            .iter()
            .map(|filter| {
                let field = self
                    .fields
                    .get(&filter.field)
                    .map_or(filter.field.as_str(), String::as_str);
                match &filter.value {
                    Some(value) => format!("{field} {} {value:?}", name(filter.op)),
                    None => format!("{field} {}", name(filter.op)),
                }
            })
            .collect();
        if !conditions.is_empty() {
            text.push_str(" with ");
            text.push_str(&conditions.join(" and "));
        }
        text
    }
}
