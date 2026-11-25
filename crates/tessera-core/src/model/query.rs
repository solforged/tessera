use serde::{Deserialize, Serialize};

use super::{Block, BlockInPage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Number,
    Date,
    Span,
    Checkbox,
    Choice,
    Instance,
    /// An absolute `http` or `https` address.
    Url,
    /// An ISBN, DOI or arXiv ID, read in a normalized `scheme:value` form.
    Identifier,
}

impl FieldKind {
    pub const ALL: [Self; 9] = [
        Self::Text,
        Self::Number,
        Self::Date,
        Self::Span,
        Self::Checkbox,
        Self::Choice,
        Self::Instance,
        Self::Url,
        Self::Identifier,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Date => "date",
            Self::Span => "span",
            Self::Checkbox => "checkbox",
            Self::Choice => "choice",
            Self::Instance => "instance",
            Self::Url => "url",
            Self::Identifier => "identifier",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum FieldHide {
    #[default]
    Never,
    WhenEmpty,
    Always,
}

impl FieldHide {
    pub const ALL: [Self; 3] = [Self::Never, Self::WhenEmpty, Self::Always];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::WhenEmpty => "when_empty",
            Self::Always => "always",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|hide| hide.as_str() == value)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum FieldRole {
    Standfirst,
    #[default]
    Attribute,
    Prose,
    Citation,
}

impl FieldRole {
    pub const ALL: [Self; 4] = [
        Self::Standfirst,
        Self::Attribute,
        Self::Prose,
        Self::Citation,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standfirst => "standfirst",
            Self::Attribute => "attribute",
            Self::Prose => "prose",
            Self::Citation => "citation",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.as_str() == value)
    }
}

/// What a field's values count as, so readers find creators by meaning rather than by field name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum CountsAs {
    /// Who made the work: bylines, sigla, sorting and `@creator`.
    Creator,
    /// Listed after the creators, never in a byline, siglum or sort: `@contributor`.
    Contributor,
    /// Who first proposed a concept, and where.
    Originator,
}

impl CountsAs {
    pub const ALL: [Self; 3] = [Self::Creator, Self::Contributor, Self::Originator];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creator => "creator",
            Self::Contributor => "contributor",
            Self::Originator => "originator",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|counts| counts.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Is,
    IsNot,
    Contains,
    Gt,
    Gte,
    Lt,
    Lte,
    Overlaps,
    Before,
    After,
    Present,
    Set,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub or_empty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    Title,
    Created,
    Updated,
    Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SortKey {
    pub by: SortBy,
    pub field: Option<String>,
    pub direction: Direction,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum QuerySource {
    #[default]
    Notes,
    Questions,
    Positions,
    Sources,
    Tasks,
    Highlights,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum QueryLayout {
    #[default]
    Table,
    Register,
    Matrix,
    Desk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryColumn {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryGrouping {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub collapsed: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct DeskQuery {
    pub positions: Query,
    pub sources: Query,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Query {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<QuerySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layout: Option<QueryLayout>,
    pub r#type: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
    pub limit: Option<usize>,
    /// Rows skipped after sorting; total and column metadata cover all matches.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: usize,
    /// Restrict to this finding-aid kind's members, including inline capability atoms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cites: Vec<String>,
    /// Presentation travels in the existing saved query JSON, not a second view store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note_view: Option<NoteView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub columns: Option<Vec<QueryColumn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group: Option<QueryGrouping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub card: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub desk: Option<Box<DeskQuery>>,
    /// Remembered labels for references left behind by field detachment or deletion.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub field_names: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct NoteView {
    pub layout: NoteLayout,
    /// `letter`, `source`, `link`, `created`, or `field:<definition id>`.
    pub grouping: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum NoteLayout {
    Index,
    Table,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct NoteGroup {
    pub key: String,
    pub title: String,
    pub target: Option<String>,
    pub siglum: Option<String>,
    pub note_ids: Vec<String>,
}

/// Inclusive historical years; missing bounds are open, and BCE years are negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct YearSpan {
    pub from: Option<i32>,
    pub through: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(untagged)]
pub enum ReadingValue {
    Text(String),
    Number(f64),
    Checkbox(bool),
    Span(YearSpan),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(untagged)]
pub enum Reading {
    Value {
        #[ts(type = "true")]
        ok: bool,
        value: ReadingValue,
        target: Option<String>,
    },
    Problem {
        #[ts(type = "false")]
        ok: bool,
        problem: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldValue {
    pub id: String,
    pub text: String,
    pub reading: Reading,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryAttributeValue {
    pub text: String,
    pub reading: Reading,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryAttribute {
    pub key: String,
    pub name: String,
    pub kind: FieldKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryGroup {
    pub key: String,
    pub title: String,
    pub target: Option<String>,
    pub row_ids: Vec<String>,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryRow {
    pub block: BlockInPage,
    pub values: std::collections::BTreeMap<String, Vec<FieldValue>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub attributes: std::collections::BTreeMap<String, Vec<QueryAttributeValue>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldDefinition {
    pub id: String,
    pub name: String,
    pub kind: FieldKind,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub hide: FieldHide,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub role: FieldRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts_as: Option<CountsAs>,
    #[ts(optional = nullable)]
    pub archived: bool,
    pub revision: i64,
    pub options: Vec<FieldOption>,
    #[serde(default)]
    pub targets: Vec<String>,
    /// Created by the app and named by it: the name cannot change except in case.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub built_in: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct QueryResult {
    pub fields: Vec<FieldDefinition>,
    pub columns: Vec<String>,
    pub rows: Vec<QueryRow>,
    pub total: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub note_groups: Vec<NoteGroup>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub attributes: Vec<QueryAttribute>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub groups: Vec<QueryGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct View {
    pub id: String,
    pub name: String,
    pub query: Query,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(rename = "Type")]
pub struct TypeInfo {
    pub page: Block,
    pub plural: Option<String>,
    pub icon: Option<String>,
    pub fields: Vec<String>,
    pub members: usize,
    pub card_templates: usize,
    /// Template fields the type's built-in schema requires, in template order.
    #[serde(default)]
    pub required: Vec<RequiredField>,
    /// Field names the built-in starting template would add to an empty template; empty otherwise.
    #[serde(default)]
    pub starting: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct RequiredField {
    pub field_id: String,
    /// Members with no nonblank value for the field.
    pub missing: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(rename = "Fields")]
pub struct FieldsView {
    pub page_id: String,
    pub fields: Vec<FieldSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldSummary {
    #[serde(flatten)]
    pub definition: FieldDefinition,
    pub owners: usize,
    pub types: Vec<FieldType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldType {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldOwner {
    pub id: String,
    pub text: String,
    pub page_id: String,
    pub page_title: String,
}

/// A relation field value pointing at a block, read from the target's side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct IncomingFieldValue {
    pub field_id: String,
    pub field_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts_as: Option<CountsAs>,
    pub owner: FieldOwner,
    pub value_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldOwnerValues {
    pub owner: FieldOwner,
    /// The first entry in outline order when this owner has several entries.
    pub entry_id: String,
    pub values: Vec<FieldValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldValueUse {
    pub owner: FieldOwner,
    pub entry_id: String,
    pub value: FieldValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldTemplate {
    pub type_id: String,
    pub name: String,
    pub position: usize,
    pub members: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldOptionUse {
    pub option_id: String,
    pub uses: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldChoiceValue {
    pub id: String,
    pub text: String,
    pub revision: i64,
    pub page_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldChoiceCandidate {
    pub text: String,
    pub option_id: Option<String>,
    pub values: Vec<FieldChoiceValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldInterpretation {
    pub text: String,
    pub reading: Reading,
    pub values: Vec<FieldChoiceValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct FieldDetail {
    pub field: FieldSummary,
    pub kind: FieldKind,
    pub owners_total: usize,
    pub values_total: usize,
    pub empty_total: usize,
    pub problems_total: usize,
    pub templates: Vec<FieldTemplate>,
    pub option_uses: Vec<FieldOptionUse>,
    pub owners: Vec<FieldOwnerValues>,
    pub problems: Vec<FieldValueUse>,
    pub readable: Vec<FieldValueUse>,
    /// Complete conversion candidates, not limited by the displayed samples.
    pub choice_candidates: Vec<FieldChoiceCandidate>,
    /// Every distinct written value, for reviewed interpretation across all owners.
    pub interpretations: Vec<FieldInterpretation>,
    /// All entry identities, including empty entries, for lossless schema changes.
    pub entries: Vec<String>,
}
