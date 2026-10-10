use super::invalid;
use crate::{AppState, error::ApiError, run};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tessera_core::{Notebook, library::*};

#[derive(Deserialize)]
pub(super) struct LookupRequest {
    query: String,
}
#[derive(Serialize)]
pub(super) struct Preview {
    metadata: ExtractedMetadata,
    cover_url: Option<String>,
    provider: &'static str,
}

pub(super) async fn lookup(
    State(state): State<AppState>,
    Json(body): Json<LookupRequest>,
) -> Result<Json<Preview>, ApiError> {
    let id = Notebook::normalize_identifier(&body.query)
        .ok_or_else(|| invalid("Enter a valid ISBN, DOI or arXiv ID."))?;
    #[cfg(not(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    )))]
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut preview = native_lookup(&id).await?;
        // The app deliberately permits only same-origin images. Fetch cover bytes only
        // as part of this explicit lookup, and reuse the immutable object when added.
        if let Some(url) = preview.cover_url {
            preview.cover_url = Some(download_cover(&state, &url).await?);
        }
        Ok::<_, ApiError>(preview)
    })
    .await
    .map_err(|_| failed("request timed out"))?;
    #[cfg(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    ))]
    let result = {
        let _ = state;
        native_lookup(&id).await
    };
    result.map(Json)
}

#[cfg(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
))]
async fn native_lookup(_: &str) -> Result<Preview, ApiError> {
    Err(ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "unavailable",
        "Online lookup is unavailable on this device.",
    ))
}

#[cfg(not(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
)))]
async fn native_lookup(id: &str) -> Result<Preview, ApiError> {
    let (kind, value) = id.split_once(':').expect("normalized identifier");
    let client = client()?;
    let response = match kind {
        "isbn" => client.get("https://openlibrary.org/api/books").query(&[
            ("bibkeys", format!("ISBN:{value}")),
            ("format", "json".into()),
            ("jscmd", "data".into()),
        ]),
        "doi" => client.get(format!(
            "https://api.crossref.org/works/{}",
            percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
        )),
        _ => client
            .get("https://export.arxiv.org/api/query")
            .query(&[("id_list", value)]),
    }
    .send()
    .await
    .map_err(network_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(not_found());
    }
    if !response.status().is_success() {
        return Err(failed(&format!(
            "provider returned {}",
            response.status().as_u16()
        )));
    }
    let bytes = response.bytes().await.map_err(network_error)?;
    match kind {
        "isbn" => {
            let mut json: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| failed("invalid Open Library response"))?;
            if let Some(key) = json[format!("ISBN:{value}")]["key"]
                .as_str()
                .filter(|key| key.starts_with("/books/"))
            {
                let edition: serde_json::Value = client
                    .get(format!("https://openlibrary.org{key}.json"))
                    .send()
                    .await
                    .map_err(network_error)?
                    .error_for_status()
                    .map_err(network_error)?
                    .json()
                    .await
                    .map_err(network_error)?;
                json[format!("ISBN:{value}")]["languages"] = edition["languages"].clone();
            }
            open_library(&json, value)
        }
        "doi" => crossref(
            &serde_json::from_slice(&bytes).map_err(|_| failed("invalid Crossref response"))?,
        ),
        _ => arxiv(std::str::from_utf8(&bytes).map_err(|_| failed("invalid arXiv response"))?),
    }
}

#[cfg(not(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
)))]
fn client() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Tessera/0.1 (bibliographic lookup)")
        .build()
        .map_err(network_error)
}
#[cfg(not(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
)))]
fn network_error(error: reqwest::Error) -> ApiError {
    failed(if error.is_timeout() {
        "request timed out"
    } else {
        "provider could not be reached"
    })
}
#[cfg(any(
    test,
    not(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    ))
))]
fn failed(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "lookup_failed", message)
}
#[cfg(any(
    test,
    not(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    ))
))]
fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Nothing found")
}

#[cfg(any(
    test,
    not(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    ))
))]
mod mapping {
    use super::*;
    use serde_json::Value;
    fn text(value: &Value) -> Option<String> {
        value
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
    fn date(value: &str) -> Option<String> {
        let value = value.trim();
        if value.len() >= 4 && value.as_bytes()[..4].iter().all(u8::is_ascii_digit) {
            let value = value.split('T').next().unwrap_or(value);
            if value.len() == 4 || value.len() == 7 || value.len() == 10 {
                return Some(value.into());
            }
        }
        let parts: Vec<_> = value.split([',', ' ']).filter(|s| !s.is_empty()).collect();
        let year = *parts.last()?;
        if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let months = [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ];
        let month = months
            .iter()
            .position(|month| month.starts_with(&parts[0].to_ascii_lowercase()));
        match (
            month,
            parts
                .get(1)
                .and_then(|s| s.parse::<u8>().ok())
                .filter(|day| (1..=31).contains(day)),
        ) {
            (Some(month), Some(day)) if parts.len() > 2 => {
                Some(format!("{year}-{:02}-{day:02}", month + 1))
            }
            (Some(month), _) => Some(format!("{year}-{:02}", month + 1)),
            _ => Some(year.into()),
        }
    }
    pub(super) fn open_library(json: &Value, isbn: &str) -> Result<Preview, ApiError> {
        let book = &json[format!("ISBN:{isbn}")];
        let title = text(&book["title"]).ok_or_else(not_found)?;
        let mut identifiers: Vec<String> = book["identifiers"]["isbn_13"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Notebook::normalize_identifier(v.as_str()?))
            .collect();
        if identifiers.is_empty() {
            identifiers.push(format!("isbn:{isbn}"));
        }
        Ok(Preview {
            metadata: ExtractedMetadata {
                title: Some(title),
                subtitle: text(&book["subtitle"]),
                creators: book["authors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| {
                        Some(ExtractedCreator {
                            name: text(&a["name"])?,
                            role: CreatorRole::Author,
                        })
                    })
                    .collect(),
                published: book["publish_date"].as_str().and_then(date),
                publisher: book["publishers"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|p| text(&p["name"])),
                language: book["languages"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|p| p["key"].as_str())
                    .map(|key| {
                        match key.rsplit('/').next().unwrap_or(key) {
                            "eng" => "en",
                            "fre" => "fr",
                            "ger" => "de",
                            "spa" => "es",
                            other => other,
                        }
                        .into()
                    }),
                identifiers,
                ..Default::default()
            },
            cover_url: text(&book["cover"]["large"]).or_else(|| text(&book["cover"]["medium"])),
            provider: "Open Library",
        })
    }
    pub(super) fn crossref(json: &Value) -> Result<Preview, ApiError> {
        let work = &json["message"];
        let title = text(&work["title"][0]).ok_or_else(not_found)?;
        let mut creators = Vec::new();
        for (key, role) in [
            ("author", CreatorRole::Author),
            ("editor", CreatorRole::Editor),
            ("translator", CreatorRole::Translator),
        ] {
            for person in work[key].as_array().into_iter().flatten() {
                let name = text(&person["name"]).unwrap_or_else(|| {
                    format!(
                        "{} {}",
                        person["given"].as_str().unwrap_or(""),
                        person["family"].as_str().unwrap_or("")
                    )
                    .trim()
                    .to_owned()
                });
                if !name.is_empty() {
                    creators.push(ExtractedCreator { name, role });
                }
            }
        }
        let published = ["published", "published-print", "published-online", "issued"]
            .into_iter()
            .find_map(|key| {
                let parts = work[key]["date-parts"][0].as_array()?;
                let mut parts = parts.iter().take(3).filter_map(Value::as_u64);
                let year = parts.next()?;
                let mut value = format!("{year:04}");
                for part in parts {
                    value.push_str(&format!("-{part:02}"));
                }
                Some(value)
            });
        Ok(Preview {
            metadata: ExtractedMetadata {
                title: Some(title),
                subtitle: text(&work["subtitle"][0]),
                creators,
                published,
                publisher: text(&work["publisher"]),
                language: text(&work["language"]),
                identifiers: work["DOI"]
                    .as_str()
                    .and_then(Notebook::normalize_identifier)
                    .into_iter()
                    .collect(),
                url: text(&work["URL"]),
                site: text(&work["container-title"][0]),
                ..Default::default()
            },
            cover_url: None,
            provider: "Crossref",
        })
    }
    pub(super) fn arxiv(xml: &str) -> Result<Preview, ApiError> {
        let doc = roxmltree::Document::parse(xml).map_err(|_| failed("invalid arXiv response"))?;
        let entry = doc
            .descendants()
            .find(|n| n.has_tag_name("entry"))
            .ok_or_else(not_found)?;
        let value = |tag| {
            entry
                .children()
                .find(|n| n.has_tag_name(tag))
                .and_then(|n| n.text())
                .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        };
        let id = value("id")
            .and_then(|s| Notebook::normalize_identifier(&s))
            .ok_or_else(not_found)?;
        Ok(Preview {
            metadata: ExtractedMetadata {
                title: value("title"),
                creators: entry
                    .children()
                    .filter(|n| n.has_tag_name("author"))
                    .filter_map(|author| {
                        Some(ExtractedCreator {
                            name: author
                                .children()
                                .find(|n| n.has_tag_name("name"))?
                                .text()?
                                .trim()
                                .into(),
                            role: CreatorRole::Author,
                        })
                    })
                    .collect(),
                published: value("published").as_deref().and_then(date),
                identifiers: vec![id],
                description: value("summary"),
                url: value("id"),
                ..Default::default()
            },
            cover_url: None,
            provider: "arXiv",
        })
    }
}
#[cfg(any(
    test,
    not(any(
        all(target_arch = "wasm32", target_os = "unknown"),
        target_os = "android"
    ))
))]
use mapping::*;

#[derive(Deserialize)]
pub(super) struct RecordRequest {
    metadata: ExtractedMetadata,
    cover_url: Option<String>,
}
pub(super) async fn record_plan(
    State(state): State<AppState>,
    Json(mut body): Json<RecordRequest>,
) -> Result<Json<IngestPlan>, ApiError> {
    normalize(&mut body.metadata)?;
    if let Some(url) = body.cover_url {
        body.metadata.cover = Some(if url.starts_with("/api/library/covers/") {
            url
        } else {
            download_cover(&state, &url).await?
        });
    }
    run(&state, move |n| n.plan_source_record(&body.metadata))
        .await
        .map(Json)
}
pub(super) async fn normalize_metadata(
    Json(mut metadata): Json<ExtractedMetadata>,
) -> Result<Json<ExtractedMetadata>, ApiError> {
    normalize(&mut metadata)?;
    Ok(Json(metadata))
}
fn normalize(metadata: &mut ExtractedMetadata) -> Result<(), ApiError> {
    if metadata
        .title
        .as_deref()
        .is_none_or(|s| s.trim().is_empty())
    {
        return Err(invalid("A title is required."));
    }
    metadata.identifiers = metadata
        .identifiers
        .iter()
        .map(|id| {
            Notebook::normalize_identifier(id)
                .ok_or_else(|| invalid("Enter a valid ISBN, DOI or arXiv ID."))
        })
        .collect::<Result<_, _>>()?;
    if let Some(date) = metadata.published.as_deref().filter(|s| !s.is_empty())
        && !Notebook::valid_publication_date(date)
    {
        return Err(invalid("Use YYYY, YYYY-MM or YYYY-MM-DD."));
    }
    Ok(())
}
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
pub(super) async fn upload_cover(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<String>, ApiError> {
    store_cover(&state, body).await.map(Json)
}
async fn store_cover(state: &AppState, body: Bytes) -> Result<String, ApiError> {
    if image_type(&body).is_none() {
        return Err(invalid("Choose a PNG, JPEG or WebP image."));
    }
    run(state, move |n| n.put_object(&body))
        .await
        .map(|sha| format!("/api/library/covers/{sha}"))
}
pub(super) async fn cover(
    State(state): State<AppState>,
    Path(sha): Path<String>,
) -> Result<Response, ApiError> {
    let bytes = run(&state, move |n| n.read_object(&sha)).await?;
    let media = image_type(&bytes).ok_or_else(ApiError::not_found)?;
    Ok((
        [
            (header::CONTENT_TYPE, media),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}
#[cfg(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
))]
async fn download_cover(_: &AppState, _: &str) -> Result<String, ApiError> {
    Err(ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "unavailable",
        "Online covers are unavailable on this device.",
    ))
}
#[cfg(not(any(
    all(target_arch = "wasm32", target_os = "unknown"),
    target_os = "android"
)))]
async fn download_cover(state: &AppState, url: &str) -> Result<String, ApiError> {
    let url = reqwest::Url::parse(url).map_err(|_| invalid("Invalid cover URL."))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(invalid("Invalid cover URL."));
    }
    let mut response = client()?
        .get(url)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(network_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > 10 * 1024 * 1024 {
            return Err(invalid("The cover is too large."));
        }
        bytes.extend_from_slice(&chunk);
    }
    store_cover(state, Bytes::from(bytes)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detect_identifiers() {
        for value in ["9780141439518", "978-0-14-143951-8", "0-14-143951-3"] {
            assert_eq!(
                Notebook::normalize_identifier(value).as_deref(),
                Some("isbn:9780141439518")
            );
        }
        for value in ["9780141439519", "0-14-143951-4", "https://example.com"] {
            assert!(Notebook::normalize_identifier(value).is_none());
        }
        for value in ["10.1038/nature14539", "https://doi.org/10.1038/NATURE14539"] {
            assert_eq!(
                Notebook::normalize_identifier(value).as_deref(),
                Some("doi:10.1038/nature14539")
            );
        }
        for value in [
            "1706.03762",
            "arXiv:1706.03762",
            "https://arxiv.org/abs/1706.03762",
            "https://arxiv.org/pdf/1706.03762.pdf",
        ] {
            assert_eq!(
                Notebook::normalize_identifier(value).as_deref(),
                Some("arxiv:1706.03762")
            );
        }
    }
    #[test]
    fn map_open_library() {
        let mut book: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/open-library.json")).unwrap();
        let edition: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/open-library-edition.json"))
                .unwrap();
        book["ISBN:9780141439518"]["languages"] = edition["languages"].clone();
        let preview = open_library(&book, "9780141439518").unwrap_or_else(|_| panic!("fixture"));
        assert_eq!(
            preview.metadata.title.as_deref(),
            Some("Pride and Prejudice")
        );
        assert_eq!(preview.metadata.creators[0].name, "Jane Austen");
        assert_eq!(preview.metadata.published.as_deref(), Some("2003"));
        assert_eq!(preview.metadata.language.as_deref(), Some("en"));
        assert_eq!(preview.metadata.identifiers, ["isbn:9780141439518"]);
        assert!(preview.cover_url.is_some());
    }
    #[test]
    fn map_crossref() {
        let preview = crossref(
            &serde_json::from_str(include_str!("../tests/fixtures/crossref.json")).unwrap(),
        )
        .unwrap_or_else(|_| panic!("fixture"));
        assert_eq!(preview.metadata.title.as_deref(), Some("Deep learning"));
        assert_eq!(preview.metadata.creators.len(), 3);
        assert_eq!(preview.metadata.published.as_deref(), Some("2015-05-27"));
        assert_eq!(
            preview.metadata.publisher.as_deref(),
            Some("Springer Science and Business Media LLC")
        );
        assert_eq!(preview.metadata.identifiers, ["doi:10.1038/nature14539"]);
    }
    #[test]
    fn map_arxiv() {
        let preview = arxiv(include_str!("../tests/fixtures/arxiv.xml"))
            .unwrap_or_else(|_| panic!("fixture"));
        assert_eq!(
            preview.metadata.title.as_deref(),
            Some("Attention Is All You Need")
        );
        assert_eq!(preview.metadata.published.as_deref(), Some("2017-06-12"));
        assert_eq!(preview.metadata.creators[0].name, "Ashish Vaswani");
        assert_eq!(preview.metadata.identifiers, ["arxiv:1706.03762v7"]);
    }
}
