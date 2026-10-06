//! What an extractor reads from one file or web page. `tessera-ingest`
//! produces an [`ExtractedDocument`] without touching a notebook; the
//! service stores its bytes and resources in the object store and commits it
//! as a snapshot of a source.
//!
//! Offsets are UTF-16 code units, the unit browsers use for selections, so a
//! highlight's range can be stored without conversion.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceFormat {
    Epub,
    Article,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedDocument {
    pub format: SourceFormat,
    /// `application/epub+zip` or `text/html`.
    pub media_type: String,
    pub metadata: ExtractedMetadata,
    /// Navigation entries in reading order, each pointing at a passage.
    pub toc: Vec<TocEntry>,
    /// Passages in reading order. Locators are unique within the document.
    pub passages: Vec<ExtractedPassage>,
    /// Images and other bytes that passages reference by `href`. Article
    /// extractors leave this empty and use absolute URLs, which the service
    /// may fetch.
    pub resources: Vec<ExtractedResource>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub creators: Vec<ExtractedCreator>,
    /// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
    pub published: Option<String>,
    pub publisher: Option<String>,
    /// BCP 47, such as `en` or `grc`.
    pub language: Option<String>,
    /// Raw identifier strings as found, such as `urn:isbn:9780262033848`,
    /// `doi:10.1145/3065386` or a bare ISBN. Unrecognized schemes are kept.
    pub identifiers: Vec<String>,
    /// The EPUB package's unique identifier, used to recognise a re-import
    /// of the same book with different bytes.
    pub unique_id: Option<String>,
    /// Canonical address of an article.
    pub url: Option<String>,
    /// Site or publication name of an article.
    pub site: Option<String>,
    /// Plain-text description or abstract.
    pub description: Option<String>,
    /// `href` of the cover image among the resources.
    pub cover: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedCreator {
    /// As written by the publisher, such as `Ursula K. Le Guin` or
    /// `Le Guin, Ursula K.`.
    pub name: String,
    pub role: CreatorRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreatorRole {
    Author,
    Editor,
    Translator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TocEntry {
    pub title: String,
    pub locator: String,
    /// 1 for top-level entries.
    pub level: u8,
    /// Resolved passage ordinal in the snapshot; absent during extraction.
    pub ordinal: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassageKind {
    Heading,
    Paragraph,
    Quote,
    ListItem,
    Code,
    Footnote,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedPassage {
    pub kind: PassageKind,
    /// Heading level 1 to 6; list nesting depth from 1 for list items.
    pub level: Option<u8>,
    /// Whitespace-normalized plain text. Image passages carry alt text.
    pub text: String,
    /// Stable position in the document, such as `OEBPS/ch03.xhtml#p12`.
    pub locator: String,
    /// The source element's own ID, when it has one, for link targets.
    pub anchor: Option<String>,
    /// Image passages: `href` of a resource, or an absolute URL for articles.
    pub resource: Option<String>,
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    /// UTF-16 offsets into the passage text, `start < end`.
    pub start: u32,
    pub end: u32,
    pub kind: MarkKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MarkKind {
    Emphasis,
    Strong,
    Code,
    /// An external address.
    Link {
        href: String,
    },
    /// A link to another passage in the same document.
    Internal {
        locator: String,
    },
    /// A footnote or endnote reference.
    NoteRef {
        locator: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedResource {
    pub href: String,
    pub media_type: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingState {
    Inbox,
    Reading,
    Finished,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceState {
    pub format: SourceFormat,
    pub state: ReadingState,
    pub origin: Option<String>,
    pub match_key: Option<String>,
    pub citation_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub block_id: String,
    pub format: SourceFormat,
    pub state: ReadingState,
    pub origin: Option<String>,
    pub match_key: Option<String>,
    pub citation_key: Option<String>,
    pub added_at: i64,
    pub state_changed_at: i64,
    pub last_read_at: Option<i64>,
    pub current_snapshot_id: Option<String>,
}

impl SourceRecord {
    pub fn source_state(&self) -> SourceState {
        SourceState {
            format: self.format,
            state: self.state,
            origin: self.origin.clone(),
            match_key: self.match_key.clone(),
            citation_key: self.citation_key.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassagePoint {
    pub passage_id: String,
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    pub id: String,
    pub block_id: String,
    pub source_id: String,
    pub snapshot_id: String,
    pub start: PassagePoint,
    pub end: PassagePoint,
    pub quote: String,
    pub locator: String,
    /// Reading-order position of the start passage in its snapshot.
    pub ordinal: i64,
    pub triage: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Passage {
    pub id: String,
    pub ordinal: i64,
    pub kind: PassageKind,
    pub level: Option<u8>,
    pub text: String,
    pub locator: String,
    pub anchor: Option<String>,
    pub resource: Option<String>,
    pub marks: Vec<Mark>,
    pub start: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedSnapshot {
    pub id: String,
    pub existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestPlan {
    pub source_id: String,
    pub created: bool,
    pub unchanged: bool,
    pub operations: Vec<crate::Operation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotSummary {
    pub id: String,
    pub sha256: String,
    pub format: SourceFormat,
    pub media_type: String,
    pub metadata: ExtractedMetadata,
    pub passage_count: i64,
    pub text_length: i64,
    pub attached_at: i64,
    pub change_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadingPosition {
    pub snapshot_id: String,
    pub passage_ordinal: i64,
    pub covered: Vec<(i64, i64)>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadingProgress {
    pub position: ReadingPosition,
    pub progress: f64,
    pub state_changed: bool,
    pub seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceView {
    pub source: SourceRecord,
    pub page: crate::Block,
    pub snapshots: Vec<SnapshotSummary>,
    pub toc: Vec<TocEntry>,
    pub position: Option<ReadingPosition>,
    pub progress: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassagePage {
    pub passages: Vec<Passage>,
    pub citations: Vec<Citation>,
    pub total: i64,
    pub toc: Vec<TocEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassageHit {
    pub source_id: String,
    pub title: String,
    pub snapshot_id: String,
    pub passage: Passage,
    pub snippet: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySort {
    #[default]
    Added,
    Title,
    LastRead,
    Progress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryQuery {
    pub states: Vec<ReadingState>,
    pub format: Option<SourceFormat>,
    pub text: Option<String>,
    pub sort: LibrarySort,
    pub direction: crate::Direction,
    pub limit: Option<usize>,
}
impl Default for LibraryQuery {
    fn default() -> Self {
        Self {
            states: vec![],
            format: None,
            text: None,
            sort: LibrarySort::Added,
            direction: crate::Direction::Desc,
            limit: Some(100),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryView {
    pub id: String,
    pub name: String,
    pub query: LibraryQuery,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryRow {
    pub page: crate::Block,
    pub source: SourceRecord,
    pub creators: Vec<String>,
    pub published: Option<String>,
    pub site: Option<String>,
    pub cover: Option<String>,
    pub progress: f64,
    pub highlights: usize,
    pub unprocessed: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryCounts {
    pub inbox: usize,
    pub reading: usize,
    pub finished: usize,
    pub abandoned: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryResult {
    pub rows: Vec<LibraryRow>,
    pub total: usize,
    pub counts: LibraryCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HighlightQuery {
    pub source_id: Option<String>,
    pub unprocessed: bool,
    pub colors: Vec<String>,
    pub tags: Vec<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HighlightRow {
    pub block: crate::BlockInPage,
    pub citation: Citation,
    pub source_title: String,
    pub processed: bool,
    pub notes: u32,
    pub triage: Option<String>,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Surfacing {
    #[serde(flatten)]
    pub row: HighlightRow,
    pub action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HighlightResult {
    pub rows: Vec<HighlightRow>,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Bibtex,
    #[serde(rename = "csl")]
    CslJson,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestInput {
    Url,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestJobState {
    Queued,
    Running,
    Failed,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestJob {
    pub id: String,
    pub input_kind: IngestInput,
    pub input: String,
    pub name: String,
    pub target_source: Option<String>,
    pub state: IngestJobState,
    pub attempts: u32,
    pub error: Option<String>,
    pub next_attempt_at: Option<i64>,
    pub source_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
