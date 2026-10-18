/**
 * JSON shapes of the service API. These mirror the wire models in
 * `crates/tessera-core/src/` field for field (snake_case, as serialized).
 * Change both together.
 */
import type { fieldKinds } from '../fields/kinds';
import type { FieldHide } from '../fields/hide';
import type { CountsAs } from '../fields/counts';
import type { FieldRole } from '../fields/roles';

export type BlockKind = 'block' | 'page' | 'journal';
export interface KeptCopy { of: string; origin: string; origin_name: string | null; mine: boolean }

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
  kept_copy?: KeptCopy | null;
}

/** A retained root deletion, with the event and exact revision needed to restore it. */
export interface DeletedPage { block: Block; deletion_id: string; deleted_at: number }

export type Completion = Block & { alias: string | null };
export interface NameMatch { page: Block; alias: string | null }

export type Actor =
  | { kind: 'person' }
  | { kind: 'agent'; name: string }
  | { kind: 'client'; name: string };

export interface ProviderView {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  has_key: boolean;
}

export interface ProviderInput {
  id?: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  api_key?: string | null;
}

export interface AgentProviders { providers: ProviderView[]; default: string | null }
export interface SaveAgentProviders { providers: ProviderInput[]; default: string | null }
export interface ThreadMessage { role: 'user' | 'assistant'; text: string }
export interface ContextRef { page_id: string; block_id?: string }
export interface StartAgentTurn {
  provider: string;
  prompt: string;
  messages: ThreadMessage[];
  context: ContextRef[];
}
export interface AgentTurnStarted { turn: string }
export type TurnEvent =
  | { n: number; kind: 'text'; delta: string }
  | { n: number; kind: 'tool'; name: string; summary: string }
  | { n: number; kind: 'edit'; seq: number; summary: string; page: string | null; blocks: string[] }
  | { n: number; kind: 'error'; message: string }
  | { n: number; kind: 'done'; stop: 'end' | 'cancelled' | 'limit' | 'error' };
export interface AgentTurnEvents { events: TurnEvent[]; done: boolean }

export type Operation =
  | { op: 'settle_sync_copy'; id: string; settled: boolean }
  | { op: 'settle_sync_rejection'; id: string; settled: boolean }
  | { op: 'create_page'; id: string; title: string }
  | { op: 'set_source'; id: string; base_revision: number; source: SourceState | null }
  | { op: 'attach_snapshot'; id: string; base_revision: number; snapshot_id: string }
  | { op: 'cite'; id: string; base_revision: number; citation_id: string; snapshot_id: string; start: PassagePoint; end: PassagePoint; color?: Citation['color'] }
  | { op: 'uncite'; id: string; base_revision: number; citation_id: string }
  | { op: 'set_citation_triage'; id: string; base_revision: number; triage: Citation['triage'] }
  | { op: 'set_citation_color'; id: string; base_revision: number; color: Citation['color'] }
  | { op: 'set_citation_range'; id: string; base_revision: number; start: PassagePoint; end: PassagePoint }
  | { op: 'create_journal'; id: string; date: string }
  | { op: 'insert'; id: string; parent_id: string; after: string | null; text: string; heading: 1 | 2 | 3 | null }
  | { op: 'edit_text'; id: string; base_revision: number; text: string }
  | { op: 'set_heading'; id: string; base_revision: number; heading: 1 | 2 | 3 | null }
  | { op: 'split'; id: string; base_revision: number; new_id: string; left: string; right: string }
  | { op: 'merge'; source_id: string; source_revision: number; destination_id: string; destination_revision: number }
  | { op: 'merge_page'; source_id: string; source_revision: number; destination_id: string; destination_revision: number }
  | { op: 'move'; id: string; base_revision: number; parent_id: string; after: string | null }
  | { op: 'delete'; id: string; base_revision: number }
  | { op: 'restore'; id: string; deletion_id: string; revision: number }
  | { op: 'set_archived'; id: string; base_revision: number; archived: boolean }
  | { op: 'add_type'; id: string; base_revision: number; title: string }
  | { op: 'remove_type'; id: string; base_revision: number; title: string }
  | { op: 'set_field_kind'; id: string; base_revision: number; kind: FieldKind }
  | { op: 'set_field_hide'; id: string; base_revision: number; hide: FieldHide }
  | { op: 'set_field_role'; id: string; base_revision: number; role: FieldRole }
  | { op: 'set_field_counts_as'; id: string; base_revision: number; counts_as: CountsAs | null }
  | { op: 'set_field_targets'; id: string; base_revision: number; targets: string[] }
  | { op: 'set_type_fields'; type_id: string; base_revision: number; fields: string[] }
  | { op: 'set_type_presentation'; type_id: string; base_revision: number; plural: string | null; icon: string | null }
  | { op: 'set_subject_criteria'; subject_id: string; base_revision: number; fields: string[] }
  | { op: 'create_card_template'; id: string; type_id: string; name: string; front: string; back: string; new_per_day: number }
  | { op: 'update_card_template'; id: string; base_revision: number; name: string; front: string; back: string; new_per_day: number }
  | { op: 'set_card_template_applied'; id: string; base_revision: number; applied: boolean }
  | { op: 'delete_card_template'; id: string; base_revision: number }
  | { op: 'save_view'; id: string; base_revision: number | null; name: string; query: Query }
  | { op: 'delete_view'; id: string; base_revision: number }
  | { op: 'set_setting'; key: string; base_revision: number | null; value: string }
  | { op: 'set_task'; id: string; base_revision: number; task: TaskState | null }
  | { op: 'restore_task_state'; id: string; base_revision: number; expected: TaskState; task: TaskState }
  | { op: 'complete_task'; id: string; base_revision: number; occurrence_id: string; completed_on: string }
  | { op: 'reverse_task_completion'; id: string; base_revision: number; occurrence_id: string }
  | { op: 'set_project'; id: string; base_revision: number; project: ProjectState | null }
  | { op: 'set_position'; id: string; base_revision: number; position: boolean }
  | { op: 'set_relation'; id: string; base_revision: number; relation: RelationKind | null }
  | { op: 'set_spread'; id: string; base_revision: number; spread: boolean }
  | { op: 'revisit'; id: string; base_revision: number; action: RevisitAction; next_on: string | null; event_id: string | null }
  | { op: 'restore_revisit'; id: string; base_revision: number; state: RevisitSnapshot; event_id: string | null }
  | { op: 'set_quote'; id: string; base_revision: number; quote: QuoteState | null }
  | { op: 'set_image'; id: string; base_revision: number; image: ImageRef | null }
  | { op: 'set_occlusion'; id: string; base_revision: number; occlusion: Occlusion | null }
  | { op: 'set_question'; id: string; base_revision: number; question: QuestionState | null }
  | { op: 'set_assessment'; id: string; base_revision: number; assessment: AssessmentState | null }
  | { op: 'start_work'; id: string; base_revision: number; session_id: string; started_at: number; note: string }
  | { op: 'stop_work'; id: string; base_revision: number; session_id: string; session_revision: number; ended_at: number; note: string }
  | { op: 'edit_work_note'; id: string; base_revision: number; session_id: string; session_revision: number; note: string }
  | { op: 'set_work_session_state'; id: string; base_revision: number; session_id: string; session_revision: number; ended_at: number | null; reversed: boolean }
  | { op: 'start_review_session'; id: string; deck_id: string | null; started_at: number }
  | { op: 'finish_review_session'; id: string; base_revision: number; state: ReviewSessionState; ended_at: number }
  | { op: 'grade_card'; id: string; base_revision: number; definition_revision: number; event_id: string; session_id: string | null; grade: Grade; reset: boolean; shown_front: string; shown_back: string; reviewed_at: number }
  | { op: 'undo_grade'; id: string; base_revision: number; review_id: string; event_id: string; session_revision: number | null; undone_at: number }
  | { op: 'reset_card'; id: string; base_revision: number; event_id: string; session_id: string | null; reviewed_at: number }
  | { op: 'set_card_held'; id: string; base_revision: number; held: boolean }
  | { op: 'save_deck'; id: string; base_revision: number | null; name: string; query: CardQuery }
  | { op: 'delete_deck'; id: string; base_revision: number }
  | { op: 'save_task_view'; id: string; base_revision: number | null; name: string; query: TaskQuery }
  | { op: 'delete_task_view'; id: string; base_revision: number }
  | { op: 'save_library_view'; id: string; base_revision: number | null; name: string; query: LibraryQuery }
  | { op: 'delete_library_view'; id: string; base_revision: number };

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
  /** Touched blocks removed by the batch, including pruned provisional pages. */
  removed?: string[];
  /** Pages holding a block the batch changed or removed, plus restructured pages. Absent in receipts stored before it was recorded. */
  pages?: string[];
  settings: SettingRevision[];
  /** Deletion events created by `delete`, `merge` and `merge_page`, in operation order. */
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
  library_views?: Revision[];
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
  /** Explicit page tags; absent in older cached page snapshots. */
  root_manual_types?: string[];
  /** Live descendants in preorder, archived ones included and flagged. */
  rows: Row[];
  /** Live blocks outside the page that its rows reference, and the pages its tags name. */
  targets: Block[];
  /** Absent in persisted page snapshots from before Action and Learning. */
  capabilities?: BlockCapabilities[];
}

export interface BatchSubtree { id: string; page: Block | null; rows: Row[]; truncated: boolean }
export interface BatchSubtrees { trees: BatchSubtree[]; truncated: boolean }
export interface StreamArrival { block: Block; page: Block; anchor_id: string }

/** A block shown with its page: backlinks, search hits and type members. */
export interface BlockInPage {
  block: Block;
  page: Block;
}

export interface Backlink {
  source: Block;
  page: Block;
}

export interface PageReferences { total: number; groups: ReferenceGroup[] }
export interface ReferenceGroup { page: Block; sources: ReferenceSource[] }
export interface ReferenceSource { source: Block; targets: string[] }
export interface ReferenceCount { block_id: string; count: number }
export interface UnlinkedMentions { total: number; rows: Mention[] }
export interface Mention { block: Block; page: Block; term: string }

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
  /** Every page the change touched, from its receipt. Absent for changes recorded before it was. */
  pages?: string[];
  /** Absent on change events produced before saved views were introduced. */
  views?: string[];
  settings?: string[];
  capabilities?: BlockCapabilities[];
  cards?: string[];
  work_sessions?: string[];
  review_sessions?: string[];
  decks?: string[];
  task_views?: string[];
  library_views?: string[];
}

export interface NotebookInfo {
  id: string;
  path: string;
  created_at: number;
  schema_version: number;
  sqlite_version: string;
}

export interface ServiceInfo {
  version: string;
  build: string | null;
  port: number;
  assets: 'embedded' | 'directory' | 'none';
  launch_agent: { installed: boolean; path: string | null };
}

export interface BackupInfo { path: string; name: string; created_at: number; object_count: number; size: number }
export interface OtherBackups { workshop_id: string; count: number; size: number; newest_at: number | null; path: string }
export interface Backups { backups: BackupInfo[]; store_size: number; others: OtherBackups[] }
export interface CreatedBackup { created: boolean; backups: Backups }
/**
 * A workshop the switcher knows. `available` is false when its folder no longer holds a workshop; `display_path`
 * writes the home folder as `~`; `named` marks one made by name in the workshops folder.
 */
export interface KnownNotebook { path: string; display_path: string; name: string; current: boolean; default: boolean; available: boolean; named: boolean }
export interface KnownNotebooks { notebooks: KnownNotebook[] }

/** Hub side: Tailscale Serve publishing this Mac's sync listener. */
export interface SyncSharing { available: boolean; on: boolean; url: string | null; error: string | null }
export interface SyncVersion { version: string | null; build: string | null; schema: number }
export interface SyncAttempt { at: number; first_at: number; ok: boolean; code: string | null; message: string | null; count: number }
export interface PairedDevice {
  id: string; name: string; paired_at: number; state: 'active' | 'retired' | 'never_synced';
  last_seen_at: number | null; retired_at: number | null; version: SyncVersion | null; last_attempt_at: number | null;
  refused: { code: string; message: string; since: number; attempts: number } | null; attempts: SyncAttempt[];
}
export interface SyncDevices { this_device: SyncVersion; sharing: SyncSharing; hub_name: string; devices: PairedDevice[]; retained: { changes: number; bytes: number } }
export interface PairingCode { code: string; display: string; expires_at: number; url: string; qr_svg: string }
export interface PairingStatus { state: 'none' | 'waiting' | 'paired' | 'expired'; device: { id: string; name: string } | null }
/** Replica side: this device's copy of a hub's notebook. */
export interface ReplicaState {
  hub_url: string; hub_name: string | null; device_name: string | null; device_id: string;
  pending: number; unapplied: number; synced_at: number | null; syncing: boolean;
  last_error: { code: string; message: string } | null; retired: boolean;
  hub_version: SyncVersion | null; failing_since: number | null; attempts: SyncAttempt[];
  kept_copies: number; rejected: number; offline: { books: number; bytes: number };
}
export interface SyncState { this_device: SyncVersion; role: 'hub' | 'replica' | 'none'; replica: ReplicaState | null }
export interface KeptCopyRow { id: string; of: string; page_id: string; page_title: string; text: string; origin: string; origin_name: string | null; mine: boolean; created_at: number }
export interface RejectedChange {
  id: string; change_id: string; error: string; created_at: number; origin: string; origin_name: string | null; mine: boolean;
  page_id: string | null; page_title: string | null; texts: string[];
}
export interface SyncConflicts { kept: KeptCopyRow[]; rejected: RejectedChange[] }

/** `error.details` of a 409 response. */
export interface ConflictDetails {
  op_index: number;
  id: string;
  expected: number;
  found: number | null;
}

export type FieldKind = typeof fieldKinds[number];
export type Direction = 'asc' | 'desc';
export type FilterOp = 'is' | 'is_not' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'overlaps' | 'before' | 'after' | 'present' | 'set' | 'empty';
export interface Filter { field: string; op: FilterOp; value: string | null; or_empty?: boolean }
export interface SortKey { by: 'title' | 'created' | 'updated' | 'field'; field: string | null; direction: Direction }
export interface NoteView { layout: 'index' | 'table'; grouping: string }
export interface NoteGroup { key: string; title: string; target: string | null; siglum: string | null; note_ids: string[] }
export type QuerySource = 'notes' | 'questions' | 'positions' | 'sources' | 'tasks' | 'highlights';
export type QueryLayout = 'table' | 'register' | 'matrix' | 'desk';
export interface QueryColumn { key: string; width?: number }
export interface QueryGrouping { key: string; collapsed?: string[] }
export interface DeskQuery { positions: Query; sources: Query }
export interface Query { source?: QuerySource; layout?: QueryLayout; type: string | null; text: string | null; filters: Filter[]; sort: SortKey[]; limit: number | null; offset?: number; note_kind?: string; links?: string[]; from?: string[]; cites?: string[]; note_view?: NoteView; columns?: QueryColumn[]; group?: QueryGrouping; card?: string[]; purpose?: string; desk?: DeskQuery; field_names?: Record<string, string> }
export interface YearSpan { from: number | null; through: number | null }
export type Reading = { ok: true; value: string | number | boolean | YearSpan; target: string | null } | { ok: false; problem: string };
export interface FieldValue { id: string; text: string; reading: Reading }
export interface QueryAttributeValue { text: string; reading: Reading }
export interface QueryAttribute { key: string; name: string; kind: FieldKind }
export interface QueryGroup { key: string; title: string; target: string | null; row_ids: string[]; count: number }
export interface QueryRow { block: BlockInPage; values: Record<string, FieldValue[]>; attributes?: Record<string, QueryAttributeValue[]> }
export interface FieldDefinition { id: string; name: string; kind: FieldKind; revision: number; options: { id: string; text: string }[]; targets: string[]; hide?: FieldHide; role?: FieldRole; /** Absent counts as nothing. */ counts_as?: CountsAs | null; archived?: boolean; /** Created and named by the app: only its case can change. */ built_in?: boolean }
export interface QueryResult { fields: FieldDefinition[]; columns: string[]; rows: QueryRow[]; total: number; note_groups?: NoteGroup[]; attributes?: QueryAttribute[]; groups?: QueryGroup[] }
export interface FieldSummary extends FieldDefinition { owners: number; types: { id: string; name: string }[] }
export interface Fields { page_id: string; fields: FieldSummary[] }
export interface FieldOwner { id: string; text: string; page_id: string; page_title: string }
export interface FieldOwnerValues { owner: FieldOwner; entry_id: string; values: FieldValue[] }
export interface FieldValueUse { owner: FieldOwner; entry_id: string; value: FieldValue }
/** A relation field value pointing at a block, read from the target's side. */
export interface IncomingFieldValue { field_id: string; field_name: string; counts_as?: CountsAs | null; owner: FieldOwner; value_id: string }
export interface FieldChoiceCandidate {
  text: string;
  option_id: string | null;
  values: { id: string; text: string; revision: number; page_id: string }[];
}
export interface FieldDetail {
  field: FieldSummary;
  kind: FieldKind;
  owners_total: number;
  values_total: number;
  empty_total: number;
  problems_total: number;
  templates: { type_id: string; name: string; position: number; members: number }[];
  option_uses: { option_id: string; uses: number }[];
  owners: FieldOwnerValues[];
  problems: FieldValueUse[];
  readable: FieldValueUse[];
  choice_candidates: FieldChoiceCandidate[];
  interpretations: { text: string; reading: Reading; values: FieldChoiceCandidate['values'] }[];
  entries: string[];
}
/** A template field the type's built-in schema requires, with how many members have no nonblank value for it. */
export interface RequiredField { field_id: string; missing: number }
/** `starting` names the built-in starting template's fields while the template is empty. */
export interface Type { page: Block; fields: string[]; members: number; card_templates: number; plural: string | null; icon: string | null; required: RequiredField[]; starting: string[] }
export interface View { id: string; name: string; query: Query; revision: number; created_at: number; updated_at: number }
/** A kind notes are filed under: `person`, `group`, `concept`, `thesis`, `question`, `source`, `project`, `type:<id>` or `unfiled`. */
export interface NoteKind { key: string; name: string; plural: string; icon: string | null; type_id: string | null }
/** `shelf` is the sidebar group: built-in note kinds, sources (and types mostly of sources), work, other types, Unfiled. */
export type Shelf = 'notes' | 'sources' | 'work' | 'tags' | 'loose';
/** The tag registry row: counts, the tag deck's card count, the template's field ids (empty without a type page) and whether `#name` names it. */
export interface IndexKind extends NoteKind { count: number; tagged_block_count: number; cards: number; fields: string[]; tag: boolean; shelf: Shelf }
export interface NoteIndex { kinds: IndexKind[]; notes: number; fields: number; spreads: SeeTarget[] }
export interface NoteEntry { id: string; title: string; sort_as: string | null; created_at: number }
export interface SeeTarget { id: string; title: string }
export interface SpreadValue { text: string; target_id: string | null; shared: boolean; between_columns: boolean }
export interface SpreadColumn { id: string; title: string; kinds: NoteKind[]; gloss: SpreadValue[]; sources: SpreadValue[]; links: SpreadValue[]; opening: SpreadValue[] }
export interface SpreadField { id: string; name: string; cells: SpreadValue[][] }
export interface SpreadReference { block_id: string; note_id: string }
export interface Spread { note_ids: string[]; columns: SpreadColumn[]; fields: SpreadField[]; references: SpreadReference[] }
export interface CrossReference { alias: string; targets: SeeTarget[] }
export interface SummaryField { name: string; value: string }
export interface SourceSummary { siglum: string; citation_key: string | null; format: SourceFormat; authors: string[]; publisher: string | null; published: string | null; highlights: number }
export interface NoteSummary { preview: string | null; field: SummaryField | null; block_count: number; text_blocks: number; prose_excerpt: string[]; backlinks: number; referenced_from: SeeTarget[]; source: SourceSummary | null }
export interface KindIndex { notes: NoteEntry[]; see: CrossReference[]; summaries: Record<string, NoteSummary> }
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
export interface PositionInfo { holder_id: string | null; subject_id: string; deleted_holder?: { id: string; text: string } | null; problem?: string | null }
export interface PositionFieldEntry { field_id: string; entry_id: string; values: { id: string; text: string }[] }
export interface PositionRow { block: BlockInPage; holder_id: string | null; subject_id: string; deleted_holder?: { id: string; text: string } | null; fields: PositionFieldEntry[] }
export interface SubjectCriteria { explicit: boolean; fields: string[] }
export interface PositionQuestion extends QuestionRow { criterion: string | null; holders: string[] }
export interface PositionQueryResult { rows: PositionRow[]; criteria: SubjectCriteria; questions: PositionQuestion[] }
export type RelationKind = 'supports' | 'disputes' | 'qualifies' | 'answers';
export interface RelationInfo { kind: RelationKind; source_id: string; target_id: string | null; problem: string | null }
export interface RelationQuery { kind?: RelationKind; source?: string; target?: string; source_holder?: string; target_holder?: string; subject?: string; limit?: number }
export interface RelationEndpoint { block: BlockInPage; holder_id: string | null }
export interface RelationRow { block: BlockInPage; kind: RelationKind; source: RelationEndpoint; target: RelationEndpoint | null; problem: string | null }
export type QuestionStatus = 'open' | 'answered' | 'parked' | 'unsettled';
export type ReadingStatus = 'current' | 'superseded' | 'withdrawn';
export interface ReadingDecision { assessment_id: string; status: ReadingStatus; on: string }
export interface QuestionState { unsettled: boolean; parked: boolean; review_on: string | null; accepted: string | null; parent?: string | null; reading_history?: ReadingDecision[] }
export interface AssessmentState { assessed_on: string; aporia: boolean }
export interface QuestionInfo { state: QuestionState; status: QuestionStatus; parent_id: string | null; parent_explicit: boolean }
export interface AssessmentInfo { state: AssessmentState; question_id: string | null; accepted: boolean }
export type QuestionFilter = 'active' | 'recurrent' | 'due' | 'answered' | 'parked';
export interface QuestionQuery { status?: QuestionStatus; review_by?: string; parent?: string; limit?: number; state?: QuestionFilter; include_inline?: boolean }
export interface CurrentReading { id: string; assessed_on: string; text: string }
export interface QuestionRow { block: BlockInPage; info: QuestionInfo; position_count: number; current: CurrentReading | null; review_on: string | null }
export interface QuotedRow { id: string; depth: number; text: string; heading: number | null; revision: number }
export interface QuoteState { target_id: string; captured_at: number; rows: QuotedRow[]; truncated: boolean }
export interface Subtree { rows: Row[]; truncated: boolean }
export interface QuoteStatus { block_id: string; source_live: boolean; changed: boolean }
export interface NoteState { resolved_at: number | null; revisit_on: string | null; date_set_at: number | null }
export type RevisitAction = 'revisited' | 'later' | 'resolve' | 'reopen' | 'keep_recurrent';
export interface RevisitSnapshot { note: NoteState; question: QuestionState | null }
export interface RevisitRow { block: BlockInPage; note: NoteState; question_status: QuestionStatus | null; revisit_on: string; last_revisited_on: string | null; proposed_on: string }
export interface RevisitEvent { id: string; block_id: string; revisited_on: string; next_on: string | null; created_at: number; change_seq: number; actor: Actor }
export interface BlockCapabilities { block_id: string; task: TaskState | null; project: ProjectState | null; note?: NoteState | null; note_changed?: boolean; position: PositionInfo | null; relation: RelationInfo | null; question: QuestionInfo | null; assessment: AssessmentInfo | null; quote?: QuoteState | null; history: boolean; merge_protected: boolean; reviewed_cards: boolean; template_cards?: number }
export interface BlockCapabilities { spread?: boolean }
export interface ImageRef { sha256: string; media_type: string; width: number; height: number }
export interface BlockCapabilities { image?: ImageRef | null }
export interface Rect { x: number; y: number; w: number; h: number }
export interface OcclusionGroup { id: string; hint?: string; answer?: string; area?: Rect }
export interface OcclusionMask extends Rect { id: string; group: string; shape: 'rect' | 'ellipse' }
export interface Occlusion { mode: 'hide_one' | 'hide_all'; groups: OcclusionGroup[]; masks: OcclusionMask[] }
export interface BlockCapabilities { occlusion?: Occlusion | null }

export interface WorkSession {
  id: string;
  block_id: string;
  started_at: number;
  ended_at: number | null;
  note: string;
  reversed: boolean;
  revision: number;
}

export type CardKind = 'forward' | 'reverse' | 'cloze' | 'multiline' | 'list' | 'descriptor' | 'occlusion';
export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface SchedulingState {
  stability: number | null;
  difficulty: number | null;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: number;
  last_reviewed_at: number | null;
}

export interface CardAnswerBlock { id: string; text: string; image?: ImageRef | null; children: CardAnswerBlock[] }
export type ReviewSchedulingState = SchedulingState | (Omit<SchedulingState, 'stability' | 'difficulty'> & { ease_factor: number });

export interface CardUnit {
  id: string;
  source_block_id: string;
  key: string;
  kind: CardKind;
  active: boolean;
  held: boolean;
  definition_revision: number;
  front: string;
  back: string;
  answer_blocks: CardAnswerBlock[];
  revision: number;
  schedule: SchedulingState;
  template: CardTemplateProvenance | null;
  occlusion_index?: number;
}

export interface CardTemplateState { type_id: string; name: string; front: string; back: string; applied: boolean; new_per_day: number }
export interface CardTemplate extends CardTemplateState { id: string; position: number; revision: number; created_at: number; updated_at: number }
export interface CardTemplateProvenance { id: string; name: string; type_id: string; type_name: string }
export interface CardTemplateInfo extends CardTemplate {
  front_display: string; back_display: string; ready: number; waiting_total: number; units_active: number; missing: string[];
  preview: { member_id: string; member_text: string; front: string; back: string } | null;
}
export interface CardTemplateForecast {
  members: number; ready: number; waiting_total: number;
  waiting: { id: string; text: string; missing: string[] }[];
  existing_units: number; cards_to_create: number; new_per_day: number; days_to_introduce: number; last_day: string | null;
  load: { date: string; due: number; added: number }[];
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
  scheduler_version: string;
  before: ReviewSchedulingState;
  after: ReviewSchedulingState;
  created_at: number;
  change_seq: number;
  undone_by: string | null;
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
  sort?: 'plan' | 'outline';
  project_via?: 'both' | 'field';
}

export interface TaskQuery {
  source: Query | null;
  filter: TaskFilter;
  context_date: string;
  limit: number | null;
}

export interface TaskRow { source: BlockInPage; task: TaskState; project_id: string | null; section_id: string | null; section_text: string | null }
export interface TaskQueryResult { rows: TaskRow[]; total: number }
export type AgendaReason = 'scheduled' | 'deadline' | 'warning' | 'overdue' | 'unplanned' | 'in_progress' | 'recently_completed';

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
export interface TagDeck { id: string; name: string; query: CardQuery }
export interface TaskView { id: string; name: string; query: TaskQuery; revision: number; created_at: number; updated_at: number }
export interface GradePreview { grade: Grade; interval_days: number }
export interface CardPreviews { current: GradePreview[]; reset: GradePreview[] }
export interface ReviewForecastDay { date: string; count: number }
export interface ReviewStats {
  date: string; due_review: number; due_new: number; forecast: ReviewForecastDay[];
  retention: number | null; reviews_this_week: number; streak: number; total_cards: number; held_cards: number;
}

export type SourceFormat = 'epub' | 'article' | 'record';
export type ReadingState = 'inbox' | 'reading' | 'finished' | 'abandoned';
export interface SourceState {
  format: SourceFormat; state: ReadingState; origin: string | null;
  match_key: string | null; citation_key: string | null;
}
export interface SourceRecord extends SourceState {
  block_id: string; added_at: number; state_changed_at: number;
  last_read_at: number | null; current_snapshot_id: string | null;
  siglum: string; siglum_basis: string; siglum_authored: boolean;
  siglum_disambiguation: { year: string | null; title_initial: string | null } | null;
}
export interface PassagePoint { passage_id: string; offset: number }
export interface Citation {
  id: string; block_id: string; source_id: string; snapshot_id: string;
  start: PassagePoint; end: PassagePoint; quote: string; locator: string; ordinal: number;
  /** UTF-16 offset of the start in the snapshot's whole text: the unit of `text_length`, passage starts and `TocEntry.start`. The server always sends it; an optimistic citation lacks it until acknowledged. */
  position?: number;
  chapter_title?: string | null;
  triage: 'processed' | 'unprocessed' | null;
  color: 'yellow' | 'green' | 'blue' | 'red' | 'purple' | null;
}
export interface BlockCapabilities { source?: SourceRecord | null; citations?: Citation[] }
export interface ExtractedCreator { name: string; role: 'author' | 'editor' | 'translator'; kind?: 'person' | 'organisation'; create_page?: boolean }
export interface ExtractedMetadata {
  title: string | null; subtitle: string | null; creators: ExtractedCreator[];
  published: string | null; publisher: string | null; language: string | null;
  identifiers: string[]; unique_id: string | null; url: string | null;
  site: string | null; description: string | null; cover: string | null;
  volume?: string | null; issue?: string | null; page_range?: string | null;
}
export interface LookupPreview { metadata: ExtractedMetadata; cover_url: string | null; provider: string }
/** `start` is the entry's character offset in the snapshot text, present once the entry resolves to a passage. */
export interface TocEntry { title: string; locator: string; level: number; ordinal: number | null; start?: number }
export type PassageKind = 'heading' | 'paragraph' | 'quote' | 'list_item' | 'code' | 'footnote' | 'image';
export type MarkKind = { kind: 'emphasis' | 'strong' | 'code' } | { kind: 'link'; href: string } | { kind: 'internal' | 'note_ref'; locator: string };
export interface Mark { start: number; end: number; kind: MarkKind }
export interface Passage {
  id: string; ordinal: number; kind: PassageKind; level: number | null;
  text: string; locator: string; anchor: string | null; resource: string | null;
  marks: Mark[]; start: number;
}
export interface SnapshotSummary {
  id: string; sha256: string; format: SourceFormat; media_type: string;
  metadata: ExtractedMetadata; passage_count: number; text_length: number;
  attached_at: number; change_seq: number;
}
export interface ReadingPosition {
  snapshot_id: string; passage_ordinal: number; updated_at: number;
}
export interface ReadingProgress {
  position: ReadingPosition; progress: number; state_changed: boolean; seq: number | null;
}
export interface SourceView {
  source: SourceRecord; page: Block; snapshots: SnapshotSummary[]; toc: TocEntry[];
  position: ReadingPosition | null; progress: number;
}
export interface PassagePage { passages: Passage[]; citations: Citation[]; total: number; toc: TocEntry[] }
export interface PassageHit { source_id: string; title: string; snapshot_id: string; passage: Passage; snippet_parts: { text: string; match: boolean }[] }
/** Browse filters: AND across fields, OR within one; empty means no filter. `people` holds person page ids. */
export interface LibraryFilters { people: string[]; decades: number[]; years: number[]; publishers: string[]; languages: string[] }
export interface LibraryQuery extends Partial<LibraryFilters> {
  states?: ReadingState[]; format?: SourceFormat | null; text?: string | null;
  collection_id?: string | null;
  sort?: 'added' | 'title' | 'author' | 'year' | 'last_read' | 'progress'; direction?: Direction; limit?: number | null;
}
export interface LibraryView { id: string; name: string; query: LibraryQuery; revision: number; created_at: number; updated_at: number }
export interface LibraryPerson { id: string | null; name: string; role: ExtractedCreator['role'] }
export interface LibraryRow {
  page: Block; source: SourceRecord; creators: string[]; people: LibraryPerson[]; published: string | null;
  publisher: string | null; language: string | null; site: string | null; cover: string | null;
  /** The current snapshot's format; a record with a saved web page reads `article` here before its source loads. */
  snapshot_format: SourceFormat | null;
  progress: number; section: string | null; highlights: number; unprocessed: number;
}
export interface LibraryFacets {
  people: { id: string | null; name: string; count: number }[];
  decades: { decade: number; count: number }[];
  years: { year: number; count: number }[];
  publishers: { value: string; count: number }[];
  languages: { value: string; count: number }[];
}
export interface LibraryResult {
  rows: LibraryRow[]; total: number; counts: { inbox: number; reading: number; finished: number; abandoned: number };
  facets: LibraryFacets;
}
export interface HighlightQuery { source_id?: string | null; unprocessed?: boolean; colors?: string[]; tags?: string[]; limit?: number | null }
export interface HighlightRow { block: BlockInPage; citation: Citation; source_title: string; processed: boolean; notes: number; triage: Citation['triage']; color: Citation['color']; tags: string[]; created_at: number }
export interface HighlightResult { rows: HighlightRow[]; total: number }
export type SurfacingAction = 'kept' | 'opened' | 'muted';
export interface Surfacing extends HighlightRow { action: SurfacingAction | null }
export interface IngestJob {
  id: string; input_kind: 'url' | 'file'; input: string; name: string; target_source: string | null;
  state: 'queued' | 'running' | 'failed' | 'done'; attempts: number; error: string | null;
  next_attempt_at: number | null; source_id: string | null; snapshot_id: string | null;
  created_at: number; updated_at: number;
}
export interface StagedSnapshot { id: string; existing: boolean }
export interface IngestPlan { source_id: string; created: boolean; unchanged: boolean; operations: Operation[] }
