//! Extractors for books and articles. Each takes bytes and returns an
//! [`ExtractedDocument`]; none touches a notebook or the network, so every
//! format is tested on files alone.
//!
//! EPUB extraction follows package spine order, resolves navigation and inline
//! references after collecting passages, and includes referenced image bytes.
//! HTML5 parsing is shared with articles, whose main-content heuristic excludes
//! navigation and other page chrome. Text and nested marks are normalized
//! together so every mark stays in browser-native UTF-16 coordinates.

use std::io::{Cursor, Read};

use tessera_core::library::{ExtractedDocument, SourceFormat};

mod article;
mod epub;
mod html;
mod location;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a supported book or article")]
    Unsupported,
    #[error("malformed {format}: {message}")]
    Malformed {
        format: &'static str,
        message: String,
    },
    #[error("{0} has no readable text")]
    Empty(&'static str),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Recognise a format from the first bytes, a declared media type and a file
/// name, in that order of trust.
pub fn detect(bytes: &[u8], media_type: Option<&str>, name: Option<&str>) -> Option<SourceFormat> {
    let media_type = media_type
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let text = &text[text
        .iter()
        .take_while(|byte| byte.is_ascii_whitespace())
        .count()..];
    let is_html = [b"<!doctype html".as_slice(), b"<html"]
        .iter()
        .any(|prefix| {
            text.get(..prefix.len())
                .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
        });
    if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
        let mimetype = archive.by_name("mimetype").ok()?;
        if mimetype.size() > 64 {
            return None;
        }
        let mut value = String::new();
        mimetype.take(65).read_to_string(&mut value).ok()?;
        return (value.trim() == "application/epub+zip").then_some(SourceFormat::Epub);
    }
    if is_html {
        return Some(SourceFormat::Article);
    }
    if media_type.is_some_and(|mime| {
        mime.eq_ignore_ascii_case("text/html") || mime.eq_ignore_ascii_case("application/xhtml+xml")
    }) {
        return Some(SourceFormat::Article);
    }
    let epub_hint = media_type
        .is_some_and(|mime| mime.eq_ignore_ascii_case("application/epub+zip"))
        || name.is_some_and(|name| {
            name.rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("epub"))
        });
    // Hints may fill in missing bytes, but cannot turn non-ZIP content into a book.
    (epub_hint && (bytes.is_empty() || b"PK\x03\x04".starts_with(bytes)))
        .then_some(SourceFormat::Epub)
}

/// Extract an EPUB 2 or 3 book.
///
/// Rejects malformed packages, entries larger than 64 MiB, archives larger than
/// 512 MiB decompressed, and books without readable text.
pub fn epub(bytes: &[u8]) -> Result<ExtractedDocument> {
    epub::extract(bytes)
}

/// Extract the readable article from an HTML page fetched from `url`.
///
/// Relative image addresses become absolute URLs; this function never fetches
/// them. An article without readable text returns [`Error::Empty`].
pub fn article(html: &str, url: &str) -> Result<ExtractedDocument> {
    article::extract(html, url)
}
