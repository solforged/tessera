//! Tools for flashcards: list a block's, a page's or a queue's cards, review
//! statistics and decks, and hold or release a card.

use std::collections::HashMap;

use anyhow::Context;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tessera_core::{
    AgentEdit, Block, BlockKind, CardQuery, CardQueryResult, CardSelection, CardUnit, Deck,
    FieldDefinition, FieldsView, Filter, Query, TagDeck, TypeInfo,
};

use super::notes::{clock, page_cards};
use super::query::{filters, unused};
use super::render::{Clock, card_answer, card_front, card_label, location, name};
use super::{Api, Session, Titles, boolean, choice, integer, limit, required, segment, string};

/// The arguments only the queue, stats and decks views read.
const VIEW_ARGUMENTS: [&str; 5] = ["view", "selection", "deck", "type", "limit"];

/// Attributes that make a query read notes whatever its type.
const NOTE_ATTRIBUTES: [&str; 3] = ["@kind", "@resolved", "@revisit"];

impl Session<'_> {
    pub(super) async fn cards(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let clock = clock(&api).await?;
        match (string(arguments, "block_id")?, string(arguments, "page")?) {
            (Some(id), None) => {
                unused(arguments, &VIEW_ARGUMENTS, "with block_id")?;
                let cards: Vec<CardUnit> = api
                    .get(&format!("/api/blocks/{}/cards", segment(id)))
                    .await?;
                let cards: Vec<_> = cards.into_iter().filter(|card| card.active).collect();
                return unit_list(&api, &cards, &clock, &format!("Atom {id} makes no card.")).await;
            }
            (None, Some(wanted)) => {
                unused(arguments, &VIEW_ARGUMENTS, "with page")?;
                let page = page_root(&api, wanted, &clock).await?;
                let cards = page_cards(&api, &page.id).await?;
                let titles = Titles::load(&api, [page.text.as_str()]).await?;
                return unit_list(
                    &api,
                    &cards,
                    &clock,
                    &format!("{:?} has no cards.", titles.show(&page.text)),
                )
                .await;
            }
            (Some(_), Some(_)) => anyhow::bail!("Give block_id or page, not both."),
            (None, None) => {}
        }
        match string(arguments, "view")?.unwrap_or("queue") {
            "queue" => queue(&api, arguments, &clock).await,
            "stats" => {
                unused(
                    arguments,
                    &["selection", "type", "limit"],
                    "in view stats, which takes a saved deck or a tag deck as deck",
                )?;
                stats(&api, arguments).await
            }
            "decks" => {
                unused(
                    arguments,
                    &["selection", "deck", "type", "limit"],
                    "in view decks",
                )?;
                let decks: Vec<Deck> = api.get("/api/decks").await?;
                let tag_decks: Vec<TagDeck> = api.get("/api/tag-decks").await?;
                if decks.is_empty() && tag_decks.is_empty() {
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
                    .chain(tag_decks.iter().map(|deck| {
                        format!(
                            "- {:?} (tag {}): cards tagged #{}\n",
                            deck.name, deck.id, deck.name
                        )
                    }))
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
            .map(|wanted| saved_deck(&decks, wanted))
            .transpose()?;
        let revision = integer(arguments, "revision")?;
        anyhow::ensure!(
            revision.is_none() || existing.is_some(),
            "revision needs deck: a new deck has no revision yet."
        );
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
            card_filters(r#type.is_some(), &filters)?;
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
            None
        };
        let selection = string(arguments, "selection")?
            .map(|selection| choice(selection, "selection", "due, new or all"))
            .transpose()?;
        let edit = merged(
            existing,
            revision,
            string(arguments, "name")?,
            source,
            selection,
        )?;
        let receipt = self.send(arguments, edit).await?;
        let mut text = self.describe(&receipt).await;
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

/// A deck save from the arguments given, keeping the rest from the deck it
/// changes. Without a revision it names the one it read, so a change made to
/// the deck since is refused rather than overwritten by this merge.
fn merged(
    existing: Option<&Deck>,
    revision: Option<i64>,
    name: Option<&str>,
    source: Option<Query>,
    selection: Option<CardSelection>,
) -> anyhow::Result<AgentEdit> {
    let source = source.or_else(|| existing.and_then(|deck| deck.query.source.clone()));
    anyhow::ensure!(
        source.is_some(),
        "A deck needs type, text or filters to choose its cards."
    );
    let name = match (name, existing) {
        (Some(name), _) => name.to_owned(),
        (None, Some(deck)) => deck.name.clone(),
        (None, None) => anyhow::bail!("A new deck needs a name."),
    };
    Ok(AgentEdit::SaveDeck {
        id: existing.map(|deck| deck.id.clone()),
        revision: revision.or(existing.map(|deck| deck.revision)),
        name,
        query: Box::new(CardQuery {
            source,
            selection: selection
                .or(existing.map(|deck| deck.query.selection))
                .unwrap_or_default(),
            limit: None,
        }),
    })
}

/// Due, new or all cards, optionally from a deck or a type's members.
async fn queue(api: &Api, arguments: &Value, clock: &Clock) -> anyhow::Result<String> {
    let (source, deck_selection) = match (string(arguments, "deck")?, string(arguments, "type")?) {
        (Some(_), Some(_)) => anyhow::bail!("Give deck or type, not both."),
        (Some(wanted), None) => {
            let (_, query) = listed_deck(api, wanted).await?;
            (query.source, Some(query.selection))
        }
        (None, Some(wanted)) => (
            Some(Query {
                r#type: Some(type_id(api, wanted).await?),
                text: None,
                filters: Vec::new(),
                sort: Vec::new(),
                limit: None,
                offset: 0,
                ..Default::default()
            }),
            None,
        ),
        (None, None) => (None, None),
    };
    // A deck reviews its own selection unless the call names one, as in the
    // editor.
    let selection: CardSelection = match string(arguments, "selection")? {
        None => deck_selection.unwrap_or_default(),
        Some(selection) => choice(selection, "selection", "due, new or all")?,
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
    let faces = faces(api, result.rows.iter().map(|row| &row.card)).await?;
    let pages = Titles::load(
        api,
        result.rows.iter().map(|row| row.source.page.text.as_str()),
    )
    .await?;
    for (row, (front, answer)) in result.rows.iter().zip(faces) {
        text.push_str(&format!(
            "- {}: {front} → {answer} (block {}) {}",
            card_label(&row.card, clock),
            row.source.block.id,
            location(&pages.block(&row.source.page))
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
        query.push(("deck", listed_deck(api, wanted).await?.0));
    }
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    // ReviewStats is serialize-only; read the fields this tool reports.
    let stats: Value = api.get_with("/api/review/stats", &query).await?;
    let count = |key: &str| stats[key].as_u64().unwrap_or(0);
    let mut text = format!(
        "{}: {} reviews and {} new cards due; {} cards in all",
        stats["date"].as_str().unwrap_or_default(),
        count("due_review"),
        count("due_new"),
        count("total_cards"),
    );
    // Held cards stay out of every other count here.
    let held = count("held_cards");
    if held > 0 {
        text.push_str(&format!(", plus {held} held"));
    }
    text.push_str(&format!(
        "; {} reviews in the last 7 days; streak {} days",
        count("reviews_past_week"),
        count("streak"),
    ));
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

async fn unit_list(
    api: &Api,
    cards: &[CardUnit],
    clock: &Clock,
    empty: &str,
) -> anyhow::Result<String> {
    if cards.is_empty() {
        return Ok(empty.to_owned());
    }
    let faces = faces(api, cards).await?;
    Ok(cards
        .iter()
        .zip(faces)
        .map(|(card, (front, answer))| {
            format!(
                "- {}: {front} → {answer} (block {})\n",
                card_label(card, clock),
                card.source_block_id
            )
        })
        .collect())
}

/// Each card's front and answer, with the pages they link shown by title.
async fn faces<'a>(
    api: &Api,
    cards: impl IntoIterator<Item = &'a CardUnit>,
) -> anyhow::Result<Vec<(String, String)>> {
    let faces: Vec<_> = cards
        .into_iter()
        .map(|card| (card_front(card), card_answer(card)))
        .collect();
    let titles = Titles::load(
        api,
        faces
            .iter()
            .flat_map(|(front, answer)| [front.as_str(), answer.as_str()]),
    )
    .await?;
    Ok(faces
        .iter()
        .map(|(front, answer)| (titles.show(front), titles.show(answer)))
        .collect())
}

/// The page or journal day `wanted` names: today, a date as YYYY-MM-DD, the
/// ID of a page or journal day, or a page title.
async fn page_root(api: &Api, wanted: &str, clock: &Clock) -> anyhow::Result<Block> {
    let date = match wanted {
        "today" => Some(clock.today.as_str()),
        date => tessera_core::calendar::validate_civil_date(date)
            .is_ok()
            .then_some(date),
    };
    if let Some(date) = date
        && let Some(day) = found(api, &format!("/api/journal/{}", segment(date))).await?
    {
        return Ok(day);
    }
    if is_id(wanted)
        && let Some(block) =
            found::<Block>(api, &format!("/api/blocks/{}", segment(wanted))).await?
    {
        anyhow::ensure!(
            block.kind != BlockKind::Block,
            "{wanted} is a block inside a page; give it as block_id, or give its page."
        );
        return Ok(block);
    }
    found(api, &format!("/api/pages/by-title/{}", segment(wanted)))
        .await?
        .with_context(|| match date {
            Some(date) => format!("There is no journal day {date} and no page titled {wanted:?}."),
            None => format!("No page is titled {wanted:?}, and no page has that ID."),
        })
}

/// The JSON at `path`, or `None` when the service has nothing there.
pub(super) async fn found<T: DeserializeOwned>(api: &Api, path: &str) -> anyhow::Result<Option<T>> {
    let response = api.0.request(reqwest::Method::GET, path).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    super::body(response).await.map(Some)
}

/// Whether `text` is written the way IDs are: a ULID in its canonical form.
pub(super) fn is_id(text: &str) -> bool {
    const DIGITS: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    text.len() == 26
        && text.as_bytes()[0] <= b'7'
        && text.bytes().all(|byte| DIGITS.contains(&byte))
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
        .with_context(|| format!("No tag is named {wanted:?}; tessera_query lists tags."))
}

/// A saved deck, which save_deck can change, by ID or name.
fn saved_deck<'a>(decks: &'a [Deck], wanted: &str) -> anyhow::Result<&'a Deck> {
    find_deck(decks, wanted, "saved deck", |deck| {
        (deck.id.as_str(), deck.name.as_str())
    })
}

/// A saved deck or a tag deck by ID or name, as tessera_cards view decks
/// lists them: its ID and its card query.
async fn listed_deck(api: &Api, wanted: &str) -> anyhow::Result<(String, CardQuery)> {
    let decks: Vec<Deck> = api.get("/api/decks").await?;
    let tag_decks: Vec<TagDeck> = api.get("/api/tag-decks").await?;
    let listed: Vec<(&str, &str, &CardQuery)> = decks
        .iter()
        .map(|deck| (deck.id.as_str(), deck.name.as_str(), &deck.query))
        .chain(
            tag_decks
                .iter()
                .map(|deck| (deck.id.as_str(), deck.name.as_str(), &deck.query)),
        )
        .collect();
    let (id, _, query) = find_deck(&listed, wanted, "deck", |deck| (deck.0, deck.1))?;
    Ok(((*id).to_owned(), (*query).clone()))
}

/// The deck `wanted` names: the one with that ID, else the one with exactly
/// that name, else the one whose name matches ignoring case. Decks saved
/// before names had to differ can share one; those are told apart by ID.
fn find_deck<'a, T>(
    decks: &'a [T],
    wanted: &str,
    noun: &str,
    key: impl Fn(&T) -> (&str, &str),
) -> anyhow::Result<&'a T> {
    if let Some(deck) = decks.iter().find(|deck| key(deck).0 == wanted) {
        return Ok(deck);
    }
    let rules: [fn(&str, &str) -> bool; 2] = [|name, wanted| name == wanted, same_name];
    for rule in rules {
        let named: Vec<&T> = decks
            .iter()
            .filter(|deck| rule(key(deck).1, wanted))
            .collect();
        match named.as_slice() {
            [] => {}
            [deck] => return Ok(deck),
            named => {
                let ids: Vec<&str> = named.iter().map(|deck| key(deck).0).collect();
                anyhow::bail!(
                    "{} {noun}s are named {wanted:?}: {}. Give the deck's ID instead.",
                    named.len(),
                    ids.join(", ")
                );
            }
        }
    }
    anyhow::bail!("No {noun} is named {wanted:?}; tessera_cards view decks lists them.")
}

/// Whether two names are the same, ignoring case.
fn same_name(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_lowercase)
        .eq(b.chars().flat_map(char::to_lowercase))
}

/// Refuses filters under which a deck's query reads notes rather than card
/// blocks, so that it would hold no cards: an attribute filter without a
/// type, and the note attributes with or without one.
fn card_filters(typed: bool, filters: &[Filter]) -> anyhow::Result<()> {
    for filter in filters {
        if NOTE_ATTRIBUTES.contains(&filter.field.as_str()) {
            anyhow::bail!(
                "{} applies to notes, not card blocks, so a deck cannot filter on it.",
                filter.field
            );
        }
        anyhow::ensure!(
            typed || !filter.field.starts_with('@'),
            "Without type, a filter on {} reads titled notes rather than card blocks, so the \
             deck would hold no cards. Add type, or filter on a field by name.",
            filter.field
        );
    }
    Ok(())
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
        let titles = Titles::lenient(api, types.iter().map(|info| info.page.text.as_str())).await;
        Ok(Self {
            types: types
                .into_iter()
                .map(|info| (info.page.id, titles.show(&info.page.text)))
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
                let mut condition = match &filter.value {
                    Some(value) => format!("{field} {} {value:?}", name(filter.op)),
                    None => format!("{field} {}", name(filter.op)),
                };
                if filter.or_empty {
                    condition.push_str(" or empty");
                }
                condition
            })
            .collect();
        if !conditions.is_empty() {
            text.push_str(" with ");
            text.push_str(&conditions.join(" and "));
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tessera_core::{AgentEdit, CardQuery, CardSelection, Deck, Filter, FilterOp, Query};

    fn deck(id: &str, name: &str, revision: i64) -> Deck {
        Deck {
            id: id.into(),
            name: name.into(),
            query: CardQuery {
                source: Some(Query {
                    r#type: Some("01M69SDQZNBWE883TZJQ98XQSC".into()),
                    ..Query::default()
                }),
                selection: CardSelection::New,
                limit: None,
            },
            revision,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn find<'a>(decks: &'a [Deck], wanted: &str) -> Result<&'a str, String> {
        super::saved_deck(decks, wanted)
            .map(|deck| deck.id.as_str())
            .map_err(|error| error.to_string())
    }

    #[test]
    fn decks_match_by_id_then_exact_name_then_one_name_ignoring_case() {
        let decks = [
            deck("01M69T8NR0ZGQ69PAZYB805RJA", "Twin", 1),
            deck("01M69T8NR0ZGQ69PAZYB805RJB", "twin", 1),
            deck("01M69T8NR0ZGQ69PAZYB805RJC", "Über", 1),
        ];
        assert_eq!(
            find(&decks, "01M69T8NR0ZGQ69PAZYB805RJB"),
            Ok("01M69T8NR0ZGQ69PAZYB805RJB")
        );
        assert_eq!(find(&decks, "Twin"), Ok("01M69T8NR0ZGQ69PAZYB805RJA"));
        assert_eq!(find(&decks, "twin"), Ok("01M69T8NR0ZGQ69PAZYB805RJB"));
        assert_eq!(find(&decks, "üBER"), Ok("01M69T8NR0ZGQ69PAZYB805RJC"));
        let ambiguous = find(&decks, "TWIN").unwrap_err();
        assert!(
            ambiguous.contains("01M69T8NR0ZGQ69PAZYB805RJA")
                && ambiguous.contains("01M69T8NR0ZGQ69PAZYB805RJB"),
            "{ambiguous}"
        );
        assert!(find(&decks, "Triplet").is_err());
    }

    #[test]
    fn decks_saved_under_one_name_are_told_apart_by_id() {
        let decks = [
            deck("01M69T8NR0ZGQ69PAZYB805RJA", "Stoic", 1),
            deck("01M69T8NR0ZGQ69PAZYB805RJB", "Stoic", 3),
        ];
        let ambiguous = find(&decks, "Stoic").unwrap_err();
        assert!(
            ambiguous.contains("01M69T8NR0ZGQ69PAZYB805RJA")
                && ambiguous.contains("01M69T8NR0ZGQ69PAZYB805RJB"),
            "{ambiguous}"
        );
        assert_eq!(
            find(&decks, "01M69T8NR0ZGQ69PAZYB805RJB"),
            Ok("01M69T8NR0ZGQ69PAZYB805RJB")
        );
    }

    #[test]
    fn a_merged_deck_save_names_the_revision_it_read() {
        let read = deck("01M69T8NR0ZGQ69PAZYB805RJA", "Italian", 4);
        let renamed = super::merged(Some(&read), None, Some("Italian words"), None, None).unwrap();
        assert_eq!(
            renamed,
            AgentEdit::SaveDeck {
                id: Some(read.id.clone()),
                revision: Some(4),
                name: "Italian words".into(),
                query: Box::new(read.query.clone()),
            }
        );
        let given = super::merged(Some(&read), Some(2), None, None, Some(CardSelection::All));
        assert!(matches!(
            given.unwrap(),
            AgentEdit::SaveDeck { revision: Some(2), name, query, .. }
                if name == "Italian" && query.selection == CardSelection::All
        ));
        let new = super::merged(None, None, Some("New"), read.query.source.clone(), None);
        assert!(matches!(
            new.unwrap(),
            AgentEdit::SaveDeck { id: None, revision: None, query, .. }
                if query.selection == CardSelection::Due
        ));
    }

    #[test]
    fn deck_filters_that_would_read_notes_instead_of_cards_are_refused() {
        let filter = |field: &str| Filter {
            field: field.into(),
            op: FilterOp::Gte,
            value: Some("-30d".into()),
            or_empty: false,
        };
        assert!(super::card_filters(false, &[filter("@created")]).is_err());
        assert!(super::card_filters(true, &[filter("@created")]).is_ok());
        assert!(super::card_filters(true, &[filter("@revisit")]).is_err());
        assert!(super::card_filters(false, &[filter("01M69SDQZNP4C3JYP9GGSVQY2H")]).is_ok());
    }

    #[test]
    fn deck_scopes_say_when_empty_values_match_too() {
        let names = super::Names {
            types: HashMap::from([("TYPE".into(), "Kanji".into())]),
            fields: HashMap::from([("STAGE".into(), "Stage".into())]),
        };
        let source = Query {
            r#type: Some("TYPE".into()),
            filters: vec![Filter {
                field: "STAGE".into(),
                op: FilterOp::Is,
                value: Some("Budding".into()),
                or_empty: true,
            }],
            ..Query::default()
        };
        assert_eq!(
            names.scope(Some(&source)),
            r#"blocks of type Kanji with Stage is "Budding" or empty"#
        );
    }

    #[test]
    fn only_canonical_ulids_count_as_ids() {
        assert!(super::is_id("01M69SDQZNP4C3JYP9GGSVQY2H"));
        for text in [
            "Antidisestablishmentarians",
            "ANTIDISESTABLISHMENTARIANS",
            "01m69sdqznp4c3jyp9ggsvqy2h",
            "81M69SDQZNP4C3JYP9GGSVQY2H",
            "01M69SDQZNP4C3JYP9GGSVQY2",
            "01M69SDQZNP4C3JYP9GGSVQYIL",
        ] {
            assert!(!super::is_id(text), "{text}");
        }
    }
}
