/**
 * JSON shapes of the service API. These mirror the wire models in
 * `crates/tessera-core/src/` field for field (snake_case, as serialized).
 * Change both together.
 */

export type BlockKind = 'block' | 'page' | 'journal';

export interface Block {
  id: string;
  kind: BlockKind;
  parent_id: string | null;
  page_id: string;
  /** A page's title; a journal's date as `YYYY-MM-DD`. */
  text: string;
  heading: 1 | 2 | 3 | null;
  archived: boolean;
  revision: number;
  created_at: number;
  updated_at: number;
}

export type Actor =
  | { kind: 'person' }
  | { kind: 'agent'; name: string }
  | { kind: 'client'; name: string };

export type Operation =
  | { op: 'create_page'; id: string; title: string }
  | { op: 'create_journal'; id: string; date: string }
  | { op: 'insert'; id: string; parent_id: string; after: string | null; text: string; heading: 1 | 2 | 3 | null }
  | { op: 'edit_text'; id: string; base_revision: number; text: string }
  | { op: 'set_heading'; id: string; base_revision: number; heading: 1 | 2 | 3 | null }
  | { op: 'split'; id: string; base_revision: number; new_id: string; left: string; right: string }
  | { op: 'merge'; source_id: string; source_revision: number; destination_id: string; destination_revision: number }
  | { op: 'move'; id: string; base_revision: number; parent_id: string; after: string | null }
  | { op: 'delete'; id: string; base_revision: number }
  | { op: 'restore'; id: string; deletion_id: string; revision: number }
  | { op: 'set_archived'; id: string; base_revision: number; archived: boolean }
  | { op: 'add_type'; id: string; base_revision: number; title: string }
  | { op: 'remove_type'; id: string; base_revision: number; title: string }
  | { op: 'set_field_kind'; id: string; base_revision: number; kind: FieldKind }
  | { op: 'set_type_fields'; type_id: string; base_revision: number; fields: string[] }
  | { op: 'save_view'; id: string; base_revision: number | null; name: string; query: Query }
  | { op: 'delete_view'; id: string; base_revision: number }
  | { op: 'set_setting'; key: string; base_revision: number | null; value: string }
  | { op: 'set_task'; id: string; base_revision: number; task: TaskState | null }
  | { op: 'complete_task'; id: string; base_revision: number; occurrence_id: string; completed_on: string }
  | { op: 'reverse_task_completion'; id: string; base_revision: number; occurrence_id: string }
  | { op: 'set_project'; id: string; base_revision: number; project: ProjectState | null }
  | { op: 'start_work'; id: string; base_revision: number; session_id: string; started_at: number; note: string }
  | { op: 'stop_work'; id: string; base_revision: number; session_id: string; session_revision: number; ended_at: number; note: string }
  | { op: 'edit_work_note'; id: string; base_revision: number; session_id: string; session_revision: number; note: string }
  | { op: 'set_work_session_state'; id: string; base_revision: number; session_id: string; session_revision: number; ended_at: number | null; reversed: boolean }
  | { op: 'start_review_session'; id: string; deck_id: string | null; started_at: number }
  | { op: 'finish_review_session'; id: string; base_revision: number; state: ReviewSessionState; ended_at: number }
  | { op: 'grade_card'; id: string; base_revision: number; definition_revision: number; event_id: string; session_id: string | null; grade: Grade; reset: boolean; shown_front: string; shown_back: string; reviewed_at: number }
  | { op: 'reset_card'; id: string; base_revision: number; event_id: string; session_id: string | null; reviewed_at: number }
  | { op: 'save_deck'; id: string; base_revision: number | null; name: string; query: CardQuery }
  | { op: 'delete_deck'; id: string; base_revision: number }
  | { op: 'save_task_view'; id: string; base_revision: number | null; name: string; query: TaskQuery }
  | { op: 'delete_task_view'; id: string; base_revision: number };

export interface Batch {
  actor: Actor;
  reason?: string | null;
  idempotency_key?: string | null;
  operations: Operation[];
}

export interface Revision {
  id: string;
  revision: number;
}

export interface Committed {
  seq: number;
  /** Resulting revision of every block the batch changed, in first-touched order. */
  revisions: Revision[];
  settings: SettingRevision[];
  /** Deletion events created by `delete` and `merge`, in operation order. */
  deletions: string[];
  replayed: boolean;
  /**
   * Source text the service rewrote on its own, such as tag tokens after a
   * page rename. Every matched source is listed, even when `before` equals
   * `after`, so undo can restore exact spellings with a revision check.
   */
  text_rewrites: TextRewrite[];
  /** Absent in persisted receipts from before Action and Learning. */
  capabilities?: BlockCapabilities[];
  cards?: Revision[];
  work_sessions?: WorkSession[];
  review_sessions?: ReviewSession[];
  decks?: Revision[];
  task_views?: Revision[];
}

export interface TextRewrite {
  id: string;
  before: string;
  after: string;
  /** The block's revision after the rewrite. */
  revision: number;
}

export interface Row {
  block: Block;
  depth: number;
  manual_types: string[];
}

export interface PageView {
  root: Block;
  /** Live descendants in preorder, archived ones included and flagged. */
  rows: Row[];
  /** Live blocks outside the page that its rows reference, and the pages its tags name. */
  targets: Block[];
  /** Absent in persisted page snapshots from before Action and Learning. */
  capabilities?: BlockCapabilities[];
}

/** A block shown with its page: backlinks, search hits and type members. */
export interface BlockInPage {
  block: Block;
  page: Block;
}

export interface Backlink {
  source: Block;
  page: Block;
}

/**
 * One committed batch as clients see it, from `GET /api/changes` and the
 * `/api/changes/stream` WebSocket. Block state is current, not historical:
 * `blocks` holds the live state of blocks this change touched, `removed` the
 * touched IDs that are no longer live, and `restructured_pages` the pages
 * whose order or nesting this change altered.
 */
export interface ChangeEvent {
  seq: number;
  actor: Actor;
  reason: string | null;
  created_at: number;
  blocks: Block[];
  removed: string[];
  restructured_pages: string[];
  /** Absent on change events produced before saved views were introduced. */
  views?: string[];
  settings?: string[];
  capabilities?: BlockCapabilities[];
  cards?: string[];
  work_sessions?: string[];
  review_sessions?: string[];
  decks?: string[];
  task_views?: string[];
}

export interface NotebookInfo {
  id: string;
  path: string;
  created_at: number;
  schema_version: number;
  sqlite_version: string;
}

/** `error.details` of a 409 response. */
export interface ConflictDetails {
  op_index: number;
  id: string;
  expected: number;
  found: number | null;
}

export type FieldKind = 'text' | 'number' | 'date' | 'checkbox' | 'choice' | 'instance';
export type Direction = 'asc' | 'desc';
export type FilterOp = 'is' | 'is_not' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'present' | 'set' | 'empty';
export interface Filter { field: string; op: FilterOp; value: string | null }
export interface SortKey { by: 'title' | 'created' | 'updated' | 'field'; field: string | null; direction: Direction }
export interface Query { type: string | null; text: string | null; filters: Filter[]; sort: SortKey[]; limit: number | null }
export type Reading = { ok: true; value: string | number | boolean; target: string | null } | { ok: false; problem: string };
export interface FieldValue { id: string; text: string; reading: Reading }
export interface QueryRow { block: BlockInPage; values: Record<string, FieldValue[]> }
export interface FieldDefinition { id: string; name: string; kind: FieldKind; revision: number; options: { id: string; text: string }[] }
export interface QueryResult { fields: FieldDefinition[]; columns: string[]; rows: QueryRow[]; total: number }
export interface FieldSummary extends FieldDefinition { owners: number; types: { id: string; name: string }[] }
export interface Fields { page_id: string; fields: FieldSummary[] }
export interface Type { page: Block; fields: string[]; members: number }
export interface View { id: string; name: string; query: Query; revision: number; created_at: number; updated_at: number }
export interface SettingRevision { key: string; revision: number }
export interface Setting { key: string; value: string; revision: number; updated_at: number }
export interface SettingsView { settings: Setting[]; today: string; time_zone: string }

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';
export type RepeatMode = 'fixed' | 'catch_up' | 'after_completion';
export interface Repeater { every: number; unit: RepeatUnit; mode: RepeatMode }

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export type TaskPriority = 'high' | 'medium' | 'low';

export interface TaskState {
  status: TaskStatus;
  scheduled: string | null;
  scheduled_time: string | null;
  deadline: string | null;
  deadline_time: string | null;
  warning_days: number | null;
  repeater: Repeater | null;
  priority: TaskPriority | null;
  completed_on: string | null;
}

export interface TaskRecord { block_id: string; state: TaskState }

export interface TaskOccurrence {
  id: string;
  block_id: string;
  completed_on: string;
  snapshot: TaskState;
  reversed: boolean;
  created_at: number;
  change_seq: number;
}

export type ProjectStatus = 'active' | 'done' | 'cancelled';
export interface ProjectState { outcome: string; deadline: string | null; status: ProjectStatus }
export interface ProjectRecord { block_id: string; state: ProjectState }
export interface BlockCapabilities { block_id: string; task: TaskState | null; project: ProjectState | null; merge_protected: boolean; reviewed_cards: boolean }

export interface WorkSession {
  id: string;
  block_id: string;
  started_at: number;
  ended_at: number | null;
  note: string;
  reversed: boolean;
  revision: number;
}

export type CardKind = 'forward' | 'reverse' | 'cloze';
export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface SchedulingState {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: number;
  last_reviewed_at: number | null;
}

export interface CardUnit {
  id: string;
  source_block_id: string;
  key: string;
  kind: CardKind;
  active: boolean;
  definition_revision: number;
  front: string;
  back: string;
  revision: number;
  schedule: SchedulingState;
}

export type ReviewSessionState = 'open' | 'finished' | 'abandoned';

export interface ReviewSession {
  id: string;
  deck_id: string | null;
  started_at: number;
  ended_at: number | null;
  state: ReviewSessionState;
  revision: number;
}

export type ReviewEventKind = 'grade' | 'reset';

export interface ReviewEvent {
  id: string;
  card_id: string;
  session_id: string | null;
  kind: ReviewEventKind;
  grade: Grade | null;
  shown_front: string;
  shown_back: string;
  definition_revision: number;
  scheduler_version: number;
  before: SchedulingState;
  after: SchedulingState;
  created_at: number;
  change_seq: number;
}

export interface DateRange { from: string | null; through: string | null }
export type TaskSelection = 'all' | 'unfinished' | 'unfinished_or_recent';

export interface TaskFilter {
  selection: TaskSelection;
  statuses: TaskStatus[];
  recent_days: number;
  scheduled: DateRange | null;
  deadline: DateRange | null;
  priority: TaskPriority | null;
  project_id: string | null;
}

export interface TaskQuery {
  source: Query | null;
  filter: TaskFilter;
  context_date: string;
  limit: number | null;
}

export interface TaskRow { source: BlockInPage; task: TaskState; project_id: string | null }
export interface TaskQueryResult { rows: TaskRow[]; total: number }
export type AgendaReason = 'scheduled' | 'deadline' | 'warning' | 'overdue' | 'unplanned' | 'recently_completed';

export interface AgendaItem {
  source: BlockInPage;
  task: TaskState;
  reasons: AgendaReason[];
  time: string | null;
  project_id: string | null;
}

export interface Agenda { date: string; items: AgendaItem[] }
export type CardSelection = 'due' | 'new' | 'all';
export interface CardQuery { source: Query | null; selection: CardSelection; limit: number | null }
export interface CardRow { card: CardUnit; source: BlockInPage; last_review: ReviewEvent | null }
export interface CardQueryResult { rows: CardRow[]; total: number }
export interface Deck { id: string; name: string; query: CardQuery; revision: number; created_at: number; updated_at: number }
export interface TaskView { id: string; name: string; query: TaskQuery; revision: number; created_at: number; updated_at: number }
export interface GradePreview { grade: Grade; interval_days: number }
export interface CardPreviews { current: GradePreview[]; reset: GradePreview[] }
