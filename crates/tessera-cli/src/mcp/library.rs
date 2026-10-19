//! `tessera_library` reads sources, their contents, passages and highlights;
//! `tessera_cite` links existing blocks to passages.

use anyhow::Context;
use serde_json::Value;
use tessera_core::library::{
    HighlightQuery, HighlightResult, LibraryQuery, LibraryResult, PassageHit, PassageKind,
    PassagePage, SourceView,
};
use tessera_core::{AgentCitation, AgentEdit, Block};

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
            ": {} {}, {:.0}% read",
            name(row.source.format),
            name(row.source.state),
            row.progress * 100.0
        ));
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
    let mut text = format!(
        "{:?} passages {}–{} of {}:\n",
        view.page.text,
        from,
        from + page.passages.len() as i64 - 1,
        page.total
    );
    for passage in &page.passages {
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
        let cited: Vec<_> = page
            .citations
            .iter()
            .filter(|citation| citation.start.passage_id == passage.id)
            .map(|citation| citation.block_id.as_str())
            .collect();
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

/// The source named by `source`: a page title, or a source page ID.
async fn source(api: &Api, arguments: &Value) -> anyhow::Result<SourceView> {
    let wanted = string(arguments, "source")?.context("source is required")?;
    let id = if wanted.len() == 26 && wanted.bytes().all(|b| b.is_ascii_alphanumeric()) {
        wanted.to_owned()
    } else {
        api.get::<Block>(&format!("/api/pages/by-title/{}", segment(wanted)))
            .await
            .with_context(|| format!("No atom is titled {wanted:?}"))?
            .id
    };
    api.get(&format!("/api/sources/{}", segment(&id)))
        .await
        .with_context(|| format!("{wanted:?} is not a library source"))
}
