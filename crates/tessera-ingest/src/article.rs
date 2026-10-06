use scraper::{ElementRef, Html};
use serde_json::Value;
use tessera_core::library::{
    CreatorRole, ExtractedCreator, ExtractedDocument, ExtractedMetadata, PassageKind, SourceFormat,
    TocEntry,
};
use url::Url;

use crate::{
    Error, Result,
    html::{Passages, is_note, noise, plain, selector, text},
    location::{Base, date, normalize},
};

/// Blogs often date posts only in their address, as `/2015/05/21/slug`.
fn path_date(url: &Url) -> Option<String> {
    let segments: Vec<&str> = url.path_segments()?.collect();
    segments.windows(3).find_map(|parts| {
        let found = date(&format!("{}-{}-{}", parts[0], parts[1], parts[2]))?;
        (found.len() == 10).then_some(found)
    })
}

pub(crate) fn extract(contents: &str, address: &str) -> Result<ExtractedDocument> {
    let url = Url::parse(address).map_err(|error| Error::Malformed {
        format: "article",
        message: error.to_string(),
    })?;
    let document = Html::parse_document(contents);
    let root = content_root(&document);
    let metadata = metadata(&document, root, &url);
    let canonical = metadata
        .url
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
        .unwrap_or_else(|| url.clone());
    let base = Base::Article { url, canonical };
    let mut passages = Passages::default();
    passages.read(root, &base);
    // Some themes put the endnotes immediately after the article container.
    for note in document.select(&selector("section, aside, div, ol")) {
        if is_note(note)
            && !note.ancestors().any(|node| node.id() == root.id())
            && !note.ancestors().filter_map(ElementRef::wrap).any(is_note)
        {
            passages.read(note, &base);
        }
    }
    if !passages
        .passages
        .iter()
        .any(|passage| passage.kind != PassageKind::Image && !passage.text.trim().is_empty())
    {
        return Err(Error::Empty("article"));
    }
    passages.finish();
    let toc = passages
        .passages
        .iter()
        .filter(|passage| passage.kind == PassageKind::Heading)
        .map(|passage| TocEntry {
            title: passage.text.clone(),
            locator: passage.locator.clone(),
            level: passage.level.unwrap_or(1),
            ordinal: None,
        })
        .collect();
    Ok(ExtractedDocument {
        format: SourceFormat::Article,
        media_type: "text/html".to_owned(),
        metadata,
        toc,
        passages: passages.passages,
        resources: Vec::new(),
    })
}

fn content_root(document: &Html) -> ElementRef<'_> {
    let semantic = document
        .select(&selector("article, main, [role=main]"))
        .filter(|element| {
            !element
                .ancestors()
                .filter_map(ElementRef::wrap)
                .any(|ancestor| noise(ancestor, true))
                && !noise(*element, true)
        })
        .max_by_key(|element| score(*element));
    if let Some(root) = semantic.filter(|root| score(*root) > 0) {
        return root;
    }
    document
        .select(&selector("body, section, div"))
        .filter(|element| {
            !noise(*element, true)
                && !element
                    .ancestors()
                    .filter_map(ElementRef::wrap)
                    .any(|ancestor| noise(ancestor, true))
        })
        .max_by_key(|element| score(*element))
        .unwrap_or_else(|| document.root_element())
}

fn score(root: ElementRef<'_>) -> usize {
    let mut characters = 0usize;
    let mut linked = 0usize;
    let mut paragraphs = 0usize;
    let mut elements = 0usize;
    for node in root.descendants() {
        if node
            .ancestors()
            .take_while(|ancestor| ancestor.id() != root.id())
            .filter_map(ElementRef::wrap)
            .any(|ancestor| noise(ancestor, true))
        {
            continue;
        }
        if let Some(value) = node.value().as_text() {
            let length = value.trim().chars().count();
            characters += length;
            if node
                .ancestors()
                .take_while(|ancestor| ancestor.id() != root.id())
                .filter_map(ElementRef::wrap)
                .any(|ancestor| ancestor.value().name() == "a")
            {
                linked += length;
            }
        } else if let Some(element) = ElementRef::wrap(node) {
            if noise(element, true) {
                continue;
            }
            elements += 1;
            if element.value().name() == "p" {
                paragraphs += 1;
            }
        }
    }
    let readable = characters.saturating_sub(linked);
    // Prefer sustained prose over link farms and deeply wrapped page chrome.
    (readable + paragraphs * 80) * 100 / (elements + 20)
}

fn meta(document: &Html, key: &str) -> Option<String> {
    document
        .select(&selector("meta[content]"))
        .find(|element| {
            [
                element.value().attr("name"),
                element.value().attr("property"),
            ]
            .into_iter()
            .flatten()
            .any(|name| name.eq_ignore_ascii_case(key))
        })
        .and_then(|element| element.value().attr("content"))
        .map(normalize)
        .filter(|value| !value.is_empty())
}

fn json_articles<'a>(value: &'a Value, output: &mut Vec<&'a Value>) {
    match value {
        Value::Array(values) => {
            for value in values {
                json_articles(value, output);
            }
        }
        Value::Object(object) => {
            let is_article = object.get("@type").is_some_and(|kind| {
                let matches = |kind: &str| {
                    matches!(
                        kind,
                        "Article"
                            | "NewsArticle"
                            | "BlogPosting"
                            | "ScholarlyArticle"
                            | "ReportageNewsArticle"
                    )
                };
                kind.as_str().is_some_and(matches)
                    || kind.as_array().is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| value.as_str().is_some_and(matches))
                    })
            });
            if is_article || object.contains_key("datePublished") || object.contains_key("author") {
                output.push(value);
            }
            if let Some(graph) = object.get("@graph") {
                json_articles(graph, output);
            }
        }
        _ => {}
    }
}

fn add_author(creators: &mut Vec<ExtractedCreator>, name: &str) {
    let name = normalize(name);
    let name = name
        .strip_prefix("By ")
        .or_else(|| name.strip_prefix("by "))
        .unwrap_or(&name)
        .trim();
    if name.is_empty() || Url::parse(name).is_ok() {
        return;
    }
    let creator = ExtractedCreator {
        name: name.to_owned(),
        role: CreatorRole::Author,
    };
    if !creators.contains(&creator) {
        creators.push(creator);
    }
}

fn json_authors(value: &Value, creators: &mut Vec<ExtractedCreator>) {
    match value {
        Value::String(name) => add_author(creators, name),
        Value::Array(authors) => {
            for author in authors {
                json_authors(author, creators);
            }
        }
        Value::Object(author) => {
            if let Some(name) = author.get("name").and_then(Value::as_str) {
                add_author(creators, name);
            }
        }
        _ => {}
    }
}

fn metadata(document: &Html, root: ElementRef<'_>, url: &Url) -> ExtractedMetadata {
    let site = meta(document, "og:site_name").or_else(|| url.host_str().map(str::to_owned));
    let mut title =
        meta(document, "og:title").or_else(|| document.select(&selector("title")).next().map(text));
    if let (Some(title), Some(site)) = (&mut title, &site) {
        for separator in [" | ", " - "] {
            if let Some((prefix, suffix)) = title.rsplit_once(separator)
                && suffix.trim().eq_ignore_ascii_case(site)
            {
                *title = prefix.trim().to_owned();
                break;
            }
        }
    }
    let json_values: Vec<Value> = document
        .select(&selector("script[type='application/ld+json']"))
        .filter_map(|script| serde_json::from_str(&script.text().collect::<String>()).ok())
        .collect();
    let mut json = Vec::new();
    for value in &json_values {
        json_articles(value, &mut json);
    }
    let mut creators = Vec::new();
    for element in document.select(&selector("meta[content]")) {
        if [
            element.value().attr("name"),
            element.value().attr("property"),
        ]
        .into_iter()
        .flatten()
        .any(|name| {
            name.eq_ignore_ascii_case("author") || name.eq_ignore_ascii_case("article:author")
        }) {
            add_author(&mut creators, element.value().attr("content").unwrap_or(""));
        }
    }
    for article in &json {
        if let Some(author) = article.get("author") {
            json_authors(author, &mut creators);
        }
    }
    let bylines =
        selector(".byline, .author, .post-author, .author-name, [rel=author], [itemprop=author]");
    for byline in document.select(&bylines) {
        // Prefer the named child to a wrapper that also includes a publication date.
        if byline.select(&bylines).next().is_none() {
            add_author(&mut creators, &text(byline));
        }
    }
    let published = meta(document, "article:published_time")
        .and_then(|value| date(&value))
        .or_else(|| {
            json.iter().find_map(|article| {
                article
                    .get("datePublished")
                    .and_then(Value::as_str)
                    .and_then(date)
            })
        })
        .or_else(|| {
            root.select(&selector("time[datetime]"))
                .find_map(|time| time.value().attr("datetime").and_then(date))
        })
        .or_else(|| path_date(url));
    let canonical = document
        .select(&selector("link[href]"))
        .find(|link| {
            link.value().attr("rel").is_some_and(|value| {
                value
                    .split_whitespace()
                    .any(|value| value.eq_ignore_ascii_case("canonical"))
            })
        })
        .and_then(|link| link.value().attr("href"))
        .and_then(|href| url.join(href).ok())
        .or_else(|| meta(document, "og:url").and_then(|href| url.join(&href).ok()))
        .unwrap_or_else(|| url.clone());
    let identifiers = document
        .select(&selector("meta[content]"))
        .filter(|element| {
            [
                element.value().attr("name"),
                element.value().attr("property"),
            ]
            .into_iter()
            .flatten()
            .any(|name| {
                ["citation_doi", "citation_arxiv_id", "dc.identifier"]
                    .iter()
                    .any(|key| name.eq_ignore_ascii_case(key))
            })
        })
        .filter_map(|element| element.value().attr("content").map(str::to_owned))
        .collect();
    ExtractedMetadata {
        title,
        creators,
        published,
        site,
        url: Some(canonical.into()),
        identifiers,
        description: meta(document, "og:description")
            .or_else(|| meta(document, "description"))
            .map(|value| plain(&value)),
        language: document
            .select(&selector("html[lang]"))
            .next()
            .and_then(|html| html.value().attr("lang"))
            .map(str::to_owned),
        ..Default::default()
    }
}
