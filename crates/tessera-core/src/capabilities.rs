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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockCapabilities {
    pub block_id: String,
    pub task: Option<TaskState>,
    pub project: Option<ProjectState>,
    /// Non-reversed task occurrences or work sessions exist for this source.
    #[serde(default)]
    pub history: bool,
    /// Live task/project state, completion/work history, or reviewed cards.
    pub merge_protected: bool,
    pub reviewed_cards: bool,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardUnit {
    pub id: String,
    pub source_block_id: String,
    pub key: String,
    pub kind: CardKind,
    pub active: bool,
    pub definition_revision: i64,
    pub front: String,
    pub back: String,
    pub revision: i64,
    pub schedule: SchedulingState,
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
    pub scheduler_version: u32,
    pub before: SchedulingState,
    pub after: SchedulingState,
    pub created_at: i64,
    pub change_seq: i64,
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
