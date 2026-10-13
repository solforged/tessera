use serde::{Deserialize, Serialize};

use crate::calendar::Repeater;
use crate::card_text::CardKind;
use crate::scheduler::{Grade, SchedulingState};
use crate::{BlockInPage, Query};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    #[default]
    Todo,
    Doing,
    Waiting,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskState {
    pub status: TaskStatus,
    pub scheduled: Option<String>,
    pub scheduled_time: Option<String>,
    pub deadline: Option<String>,
    pub deadline_time: Option<String>,
    pub warning_days: Option<u32>,
    pub repeater: Option<Repeater>,
    pub priority: Option<TaskPriority>,
    pub completed_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRecord {
    pub block_id: String,
    pub state: TaskState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOccurrence {
    pub id: String,
    pub block_id: String,
    pub completed_on: String,
    pub snapshot: TaskState,
    pub reversed: bool,
    pub created_at: i64,
    pub change_seq: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    #[default]
    Active,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectState {
    pub outcome: String,
    pub deadline: Option<String>,
    pub status: ProjectStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub block_id: String,
    pub state: ProjectState,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    #[default]
    Open,
    Answered,
    Parked,
    Unsettled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionState {
    pub unsettled: bool,
    pub parked: bool,
    pub review_on: Option<String>,
    pub accepted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssessmentState {
    pub assessed_on: String,
    pub aporia: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionInfo {
    pub state: QuestionState,
    pub status: QuestionStatus,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub parent_explicit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssessmentInfo {
    pub state: AssessmentState,
    pub question_id: Option<String>,
    pub accepted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionQuery {
    pub status: Option<QuestionStatus>,
    pub review_by: Option<String>,
    pub parent: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionRow {
    pub block: BlockInPage,
    pub info: QuestionInfo,
    #[serde(default)]
    pub position_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionInfo {
    pub holder_id: Option<String>,
    pub subject_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Supports,
    Disputes,
    Qualifies,
    Answers,
}

impl RelationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supports => "supports",
            Self::Disputes => "disputes",
            Self::Qualifies => "qualifies",
            Self::Answers => "answers",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationInfo {
    pub kind: RelationKind,
    pub source_id: String,
    pub target_id: Option<String>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationQuery {
    pub kind: Option<RelationKind>,
    pub source: Option<String>,
    pub target: Option<String>,
    pub source_holder: Option<String>,
    pub target_holder: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationEndpoint {
    pub block: BlockInPage,
    pub holder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationRow {
    pub block: BlockInPage,
    pub kind: RelationKind,
    pub source: RelationEndpoint,
    pub target: Option<RelationEndpoint>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionQuery {
    pub holder: Option<String>,
    pub subject: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionRow {
    pub block: BlockInPage,
    pub holder_id: Option<String>,
    pub subject_id: String,
    pub fields: Vec<PositionField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionField {
    pub field_id: String,
    pub entry_id: String,
    pub values: Vec<crate::FieldOption>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubjectCriteria {
    pub explicit: bool,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionQuestion {
    pub block: BlockInPage,
    pub info: QuestionInfo,
    pub criterion: Option<String>,
    pub holders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PositionQueryResult {
    pub rows: Vec<PositionRow>,
    pub criteria: SubjectCriteria,
    pub questions: Vec<PositionQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockCapabilities {
    pub block_id: String,
    pub task: Option<TaskState>,
    pub project: Option<ProjectState>,
    #[serde(default)]
    pub position: Option<PositionInfo>,
    #[serde(default)]
    pub question: Option<QuestionInfo>,
    #[serde(default)]
    pub assessment: Option<AssessmentInfo>,
    #[serde(default)]
    pub relation: Option<RelationInfo>,
    #[serde(default)]
    pub quote: Option<crate::QuoteState>,
    #[serde(default)]
    pub source: Option<crate::library::SourceRecord>,
    #[serde(default)]
    pub citations: Vec<crate::library::Citation>,
    /// Non-reversed task occurrences or work sessions exist for this source.
    #[serde(default)]
    pub history: bool,
    /// Live capability state, history, or reviewed cards.
    pub merge_protected: bool,
    pub reviewed_cards: bool,
    #[serde(default)]
    pub template_cards: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkSession {
    pub id: String,
    pub block_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub note: String,
    pub reversed: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardAnswerBlock {
    pub id: String,
    pub text: String,
    pub children: Vec<CardAnswerBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardUnit {
    pub id: String,
    pub source_block_id: String,
    pub key: String,
    pub kind: CardKind,
    pub active: bool,
    pub held: bool,
    pub definition_revision: i64,
    pub front: String,
    pub back: String,
    pub answer_blocks: Vec<CardAnswerBlock>,
    pub revision: i64,
    pub schedule: SchedulingState,
    #[serde(default)]
    pub template: Option<crate::CardTemplateProvenance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSessionState {
    Open,
    Finished,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewSession {
    pub id: String,
    pub deck_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub state: ReviewSessionState,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEventKind {
    Grade,
    Reset,
}

/// Retained evidence is not rewritten when changing scheduling algorithms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReviewSchedulingState {
    Legacy {
        ease_factor: f64,
        interval_days: u32,
        repetitions: u32,
        lapses: u32,
        due_at: i64,
        last_reviewed_at: Option<i64>,
    },
    Fsrs(SchedulingState),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewEvent {
    pub id: String,
    pub card_id: String,
    pub session_id: Option<String>,
    pub kind: ReviewEventKind,
    pub grade: Option<Grade>,
    pub shown_front: String,
    pub shown_back: String,
    pub definition_revision: i64,
    pub scheduler_version: String,
    pub before: ReviewSchedulingState,
    pub after: ReviewSchedulingState,
    pub created_at: i64,
    pub change_seq: i64,
    /// Original evidence remains readable after an immutable correction.
    #[serde(default)]
    pub undone_by: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateRange {
    pub from: Option<String>,
    pub through: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSelection {
    All,
    Unfinished,
    #[default]
    UnfinishedOrRecent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSort {
    #[default]
    Plan,
    Outline,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskProjectVia {
    #[default]
    Both,
    Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskFilter {
    pub selection: TaskSelection,
    pub statuses: Vec<TaskStatus>,
    pub recent_days: u32,
    pub scheduled: Option<DateRange>,
    pub deadline: Option<DateRange>,
    pub priority: Option<TaskPriority>,
    pub project_id: Option<String>,
    pub sort: TaskSort,
    pub project_via: TaskProjectVia,
}

impl Default for TaskFilter {
    fn default() -> Self {
        Self {
            selection: TaskSelection::UnfinishedOrRecent,
            statuses: Vec::new(),
            recent_days: 7,
            scheduled: None,
            deadline: None,
            priority: None,
            project_id: None,
            sort: TaskSort::Plan,
            project_via: TaskProjectVia::Both,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskQuery {
    pub source: Option<Query>,
    #[serde(default)]
    pub filter: TaskFilter,
    pub context_date: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRow {
    pub source: BlockInPage,
    pub task: TaskState,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub section_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskQueryResult {
    pub rows: Vec<TaskRow>,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgendaReason {
    Scheduled,
    Deadline,
    Warning,
    Overdue,
    Unplanned,
    RecentlyCompleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgendaItem {
    pub source: BlockInPage,
    pub task: TaskState,
    pub reasons: Vec<AgendaReason>,
    pub time: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agenda {
    pub date: String,
    pub items: Vec<AgendaItem>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardSelection {
    #[default]
    Due,
    New,
    All,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CardQuery {
    pub source: Option<Query>,
    pub selection: CardSelection,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardRow {
    pub card: CardUnit,
    pub source: BlockInPage,
    pub last_review: Option<ReviewEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardQueryResult {
    pub rows: Vec<CardRow>,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deck {
    pub id: String,
    pub name: String,
    pub query: CardQuery,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskView {
    pub id: String,
    pub name: String,
    pub query: TaskQuery,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GradePreview {
    pub grade: Grade,
    pub interval_days: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardPreviews {
    pub current: Vec<GradePreview>,
    pub reset: Vec<GradePreview>,
}
