//! `tessera_library` reads sources, their contents, passages and highlights;
//! `tessera_cite` links existing blocks to passages.

use anyhow::Context;
use serde_json::Value;
use tessera_core::library::{
    HighlightQuery, HighlightResult, LibraryQuery, LibraryResult, PassageHit, PassageKind,
    PassagePage, ReadingState, SourceView,
};
use tessera_core::{AgentCitation, AgentEdit, Block};

use super::cards::{found, is_id};
use super::render::{location, name, one_line, snippet};
use super::{Api, Session, boolean, choice, integer, limit, segment, string, strings};

impl Session<'_> {
    pub(super) async fn library(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        match string(arguments, "view")?.unwrap_or("sources") {
            "sources" => sources(&api, arguments).await,
            "contents" => contents(&api, arguments).await,
            "read" => read(&api, arguments).await,
            "search" => search(&api, arguments).await,
            "highlights" => highlights(&api, arguments).await,
            view => anyhow::bail!(
                "view must be sources, contents, read, search or highlights, not {view:?}"
            ),
        }
    }

    pub(super) async fn cite(&self, arguments: &Value) -> anyhow::Result<String> {
        let citations = arguments
            .get("citations")
            .and_then(Value::as_array)
            .filter(|citations| !citations.is_empty())
            .context("citations must be a non-empty array")?
            .iter()
            .map(|citation| {
                Ok(AgentCitation {
                    block_id: string(citation, "block_id")?
                        .context("each citation needs a block_id")?
                        .to_owned(),
                    revision: integer(citation, "revision")?,
                    passage_id: string(citation, "passage_id")?
                        .context("each citation needs a passage_id")?
                        .to_owned(),
                    end_passage_id: string(citation, "end_passage_id")?.map(str::to_owned),
                    quote: string(citation, "quote")?.map(str::to_owned),
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        self.submit(arguments, AgentEdit::Cite { citations }).await
    }
}

/// Books and articles, newest first, with reading state and highlights.
async fn sources(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let result: LibraryResult = api
        .post(
            "/api/library/query",
            &LibraryQuery {
                text: string(arguments, "text")?.map(str::to_owned),
                states: strings(arguments, "state")?
                    .iter()
                    .map(|state| choice(state, "state", "inbox, reading, finished or abandoned"))
                    .collect::<anyhow::Result<_>>()?,
                limit: Some(limit(arguments, "limit", 50, 500)?),
                ..LibraryQuery::default()
            },
        )
        .await?;
    if result.rows.is_empty() {
        return Ok("No sources match.".into());
    }
    let mut text = format!("{} of {} sources:\n", result.rows.len(), result.total);
    for row in &result.rows {
        text.push_str(&format!("- {:?} (source {})", row.page.text, row.page.id));
        if !row.creators.is_empty() {
            text.push_str(&format!(" by {}", row.creators.join(", ")));
        }
        if let Some(published) = &row.published {
            text.push_str(&format!(", {published}"));
        }
        text.push_str(&format!(
            ": {} {}",
            name(row.source.format),
            name(row.source.state)
        ));
        if row.source.state != ReadingState::Finished {
            text.push_str(&format!(", {:.0}% read", row.progress * 100.0));
        }
        if row.highlights > 0 {
            text.push_str(&format!(
                ", {} highlights ({} unprocessed)",
                row.highlights, row.unprocessed
            ));
        }
        text.push('\n');
    }
    Ok(text)
}

/// A source's table of contents with passage ordinals to read from.
async fn contents(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let view = source(api, arguments).await?;
    let mut text = format!(
        "{:?} (source {}): {} {}",
        view.page.text,
        view.page.id,
        name(view.source.format),
        name(view.source.state)
    );
    if let Some(snapshot) = view.snapshots.first() {
        text.push_str(&format!(", {} passages", snapshot.passage_count));
    } else {
        text.push_str(", no reading content");
    }
    if let Some(position) = &view.position {
        text.push_str(&format!(
            ", reading position at passage {}",
            position.passage_ordinal
        ));
    }
    text.push_str(".\n");
    for entry in &view.toc {
        let indent = "  ".repeat(entry.level.saturating_sub(1) as usize);
        match entry.ordinal {
            Some(ordinal) => {
                text.push_str(&format!("{indent}- {} [from {ordinal}]\n", entry.title))
            }
            None => text.push_str(&format!("{indent}- {}\n", entry.title)),
        }
    }
    Ok(text)
}

/// Passages in reading order from an ordinal, with their IDs for citing.
async fn read(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let view = source(api, arguments).await?;
    let snapshot = view
        .source
        .current_snapshot_id
        .as_deref()
        .with_context(|| format!("{:?} has no reading content to read.", view.page.text))?;
    let from = match integer(arguments, "from")? {
        Some(from) => from,
        None => view
            .position
            .as_ref()
            .map_or(0, |position| position.passage_ordinal),
    };
    let count = limit(arguments, "limit", 30, 200)?.to_string();
    let page: PassagePage = api
        .get_with(
            &format!("/api/snapshots/{}/passages", segment(snapshot)),
            &[("from", &from.to_string()), ("limit", &count)],
        )
        .await?;
    let mut text = heading(&view.page.text, from, page.passages.len(), page.total);
    if page.passages.is_empty() {
        return Ok(text);
    }
    for (passage, cited) in page.passages.iter().zip(citing(&page)) {
        let prefix = match passage.kind {
            PassageKind::Heading => format!("{} ", "#".repeat(passage.level.unwrap_or(1) as usize)),
            PassageKind::Quote => "> ".into(),
            PassageKind::ListItem => "- ".into(),
            _ => String::new(),
        };
        text.push_str(&format!(
            "[{}] (passage {}) {prefix}{}",
            passage.ordinal,
            passage.id,
            one_line(&passage.text)
        ));
        if !cited.is_empty() {
            text.push_str(&format!(" (cited by atom {})", cited.join(", ")));
        }
        text.push('\n');
    }
    if from + (page.passages.len() as i64) < page.total {
        text.push_str(&format!(
            "(Continue with from: {}.)\n",
            from + page.passages.len() as i64
        ));
    }
    Ok(text)
}

/// The first line of a read: which passages follow, or, from at or past the
/// end, that none do and how many there are.
fn heading(title: &str, from: i64, shown: usize, total: i64) -> String {
    match (shown, total) {
        (_, 0) => format!("{title:?} has no passages."),
        (0, total) => format!(
            "{title:?} has {total} passages, from 0 to {}; none start at {from}.",
            total - 1
        ),
        (shown, total) => format!(
            "{title:?} passages {from}–{} of {total}:\n",
            from + shown as i64 - 1
        ),
    }
}

/// For each passage on a page, the blocks whose citations cover it. A
/// citation runs from its start passage through its end passage, so a range
/// marks its inner and last passages too. The page carries only citations
/// that reach into it, so one whose end is not on the page runs past it. An
/// end at the very start of a later passage leaves that passage out, as the
/// service does.
fn citing(page: &PassagePage) -> Vec<Vec<&str>> {
    let ranges: Vec<(i64, i64, &str)> = page
        .citations
        .iter()
        .map(|citation| {
            let last = page
                .passages
                .iter()
                .find(|passage| passage.id == citation.end.passage_id)
                .map_or(i64::MAX, |end| {
                    if citation.end.offset == 0 && end.ordinal > citation.ordinal {
                        end.ordinal - 1
                    } else {
                        end.ordinal
                    }
                });
            (citation.ordinal, last, citation.block_id.as_str())
        })
        .collect();
    page.passages
        .iter()
        .map(|passage| {
            ranges
                .iter()
                .filter(|(first, last, _)| (*first..=*last).contains(&passage.ordinal))
                .map(|(_, _, block)| *block)
                .collect()
        })
        .collect()
}

/// Full-text search over passages, in one source or the whole library.
async fn search(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let query = string(arguments, "query")?.context("query is required for search")?;
    let count = limit(arguments, "limit", 20, 200)?.to_string();
    let source_id = match string(arguments, "source")? {
        Some(_) => Some(source(api, arguments).await?.page.id),
        None => None,
    };
    let mut params = vec![("q", query), ("limit", count.as_str())];
    if let Some(id) = &source_id {
        params.push(("source", id));
    }
    let hits: Vec<PassageHit> = api.get_with("/api/passages/search", &params).await?;
    if hits.is_empty() {
        return Ok(format!("No passages match {query:?}."));
    }
    Ok(hits
        .iter()
        .map(|hit| {
            format!(
                "- {:?} [{}] (passage {}, source {}): {}\n",
                hit.title,
                hit.passage.ordinal,
                hit.passage.id,
                hit.source_id,
                one_line(
                    &hit.snippet_parts
                        .iter()
                        .map(|part| part.text.as_str())
                        .collect::<String>()
                )
            )
        })
        .collect())
}

/// Highlight blocks with their quotes, newest first.
async fn highlights(api: &Api, arguments: &Value) -> anyhow::Result<String> {
    let source_id = match string(arguments, "source")? {
        Some(_) => Some(source(api, arguments).await?.page.id),
        None => None,
    };
    let result: HighlightResult = api
        .post(
            "/api/highlights/query",
            &HighlightQuery {
                source_id,
                unprocessed: boolean(arguments, "unprocessed")?.unwrap_or(false),
                limit: Some(limit(arguments, "limit", 50, 500)?),
                ..HighlightQuery::default()
            },
        )
        .await?;
    if result.rows.is_empty() {
        return Ok("No highlights match.".into());
    }
    let mut text = format!("{} of {} highlights:\n", result.rows.len(), result.total);
    for row in &result.rows {
        text.push_str(&format!(
            "- “{}” from {:?} at {} (passage {}): block {} {}",
            snippet(&row.citation.quote),
            row.source_title,
            row.citation.locator,
            row.citation.start.passage_id,
            row.block.block.id,
            location(&row.block.page)
        ));
        if !row.processed {
            text.push_str(", unprocessed");
        }
        if row.notes > 0 {
            text.push_str(&format!(", {} child atoms", row.notes));
        }
        text.push('\n');
    }
    Ok(text)
}

/// The source named by `source`: a source page's ID, or its title. Text that
/// merely looks like an ID is a title when no source has it as its ID.
async fn source(api: &Api, arguments: &Value) -> anyhow::Result<SourceView> {
    let wanted = string(arguments, "source")?.context("source is required")?;
    if is_id(wanted)
        && let Some(view) = found(api, &format!("/api/sources/{}", segment(wanted))).await?
    {
        return Ok(view);
    }
    let page: Block = found(api, &format!("/api/pages/by-title/{}", segment(wanted)))
        .await?
        .with_context(|| format!("No source has the title or ID {wanted:?}."))?;
    found(api, &format!("/api/sources/{}", segment(&page.id)))
        .await?
        .with_context(|| format!("{wanted:?} is not a library source."))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tessera_core::library::PassagePage;

    /// Passages 139 to 141 of a long source, with these citations.
    fn page(citations: Value) -> PassagePage {
        let passages: Vec<_> = (139..=141)
            .map(|ordinal| {
                json!({
                    "id": format!("P{ordinal}"), "ordinal": ordinal, "kind": "paragraph",
                    "level": null, "text": "Some passage text.", "locator": format!("#p{ordinal}"),
                    "anchor": null, "resource": null, "marks": [], "start": 0,
                })
            })
            .collect();
        serde_json::from_value(json!({
            "passages": passages, "citations": citations, "total": 1234, "toc": [],
        }))
        .unwrap()
    }

    fn citation(block: &str, start: (&str, i64), end: (&str, u32)) -> Value {
        json!({
            "id": format!("C{block}"), "block_id": block, "source_id": "S", "snapshot_id": "N",
            "start": { "passage_id": start.0, "offset": 0 },
            "end": { "passage_id": end.0, "offset": end.1 },
            "quote": "", "locator": "", "ordinal": start.1, "triage": null, "color": null,
        })
    }

    #[test]
    fn a_citation_marks_every_passage_from_its_start_through_its_end() {
        let page = page(json!([
            citation("RANGE", ("P139", 139), ("P141", 4)),
            citation("EARLIER", ("P100", 100), ("P140", 4)),
            citation("LATER", ("P141", 141), ("P150", 2)),
            citation("EDGE", ("P139", 139), ("P140", 0)),
        ]));
        assert_eq!(
            super::citing(&page),
            [
                vec!["RANGE", "EARLIER", "EDGE"],
                vec!["RANGE", "EARLIER"],
                vec!["RANGE", "LATER"],
            ]
        );
    }

    #[test]
    fn reading_from_the_end_says_how_many_passages_there_are() {
        assert_eq!(
            super::heading("Meditations", 1230, 4, 1234),
            "\"Meditations\" passages 1230–1233 of 1234:\n"
        );
        for from in [1234, 5000] {
            let text = super::heading("Meditations", from, 0, 1234);
            assert!(
                text.contains("1234 passages, from 0 to 1233") && !text.contains('–'),
                "{text}"
            );
        }
    }
}
