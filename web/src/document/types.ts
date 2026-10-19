import type { Block, BlockCapabilities, Batch, Citation, FieldKind, Operation, ProjectState, RelationKind, SourceState, TaskState, WorkSession } from '../api/types';
import type { AssessmentState, QuestionState, QuestionStatus, QuoteState } from '../api/types';
import type { CardTemplateState } from '../api/types';
import type { ImageRef, Occlusion } from '../api/types';
import type { CaptureIntent, Caret, DocumentChange, HistoryCaret, RelationPickIntent } from './contract';
import type { OutlineRow } from './outline-index';
import type { FieldHide } from '../fields/hide';
import type { CountsAs } from '../fields/counts';
import type { FieldRole } from '../fields/roles';

export interface Snapshot { block: Block; row: OutlineRow | null; manual_types: string[]; capabilities?: BlockCapabilities }
export type CapabilityAction =
  | { kind: 'task'; id: string; value: TaskState | null; previous: TaskState | null; baseRevision: number; restore?: boolean }
  | { kind: 'project'; id: string; value: ProjectState | null; previous: ProjectState | null; baseRevision: number }
  | { kind: 'position'; id: string; value: boolean; previous: boolean; baseRevision: number }
  | { kind: 'relation'; id: string; value: RelationKind | null; previous: RelationKind | null; baseRevision: number }
  | { kind: 'spread'; id: string; value: boolean; previous: boolean; baseRevision: number }
  | { kind: 'question'; id: string; value: QuestionState | null; previous: QuestionState | null; baseRevision: number }
  | { kind: 'quote'; id: string; value: QuoteState | null; previous: QuoteState | null; baseRevision: number }
  | { kind: 'image'; id: string; value: ImageRef | null; previous: ImageRef | null; baseRevision: number }
  | { kind: 'occlusion'; id: string; value: Occlusion | null; previous: Occlusion | null; baseRevision: number }
  | { kind: 'assessment'; id: string; value: AssessmentState | null; previous: AssessmentState | null; baseRevision: number }
  | { kind: 'source'; id: string; value: SourceState | null; previous: SourceState | null; baseRevision: number }
  | { kind: 'cite'; id: string; citation: Citation; index?: number; baseRevision: number }
  | { kind: 'uncite'; id: string; citationId: string; baseRevision: number }
  | { kind: 'citationTriage'; id: string; citationId: string; triage: Citation['triage']; previous: Citation['triage']; baseRevision: number }
  | { kind: 'highlightColor'; id: string; citationId: string; color: Citation['color']; previous: Citation['color']; baseRevision: number }
  | { kind: 'citationRange'; id: string; citation: Citation; previous: Citation; baseRevision: number }
  | { kind: 'completeTask'; id: string; occurrenceId: string; completedOn: string; previous: TaskState; baseRevision: number }
  | { kind: 'reverseTaskCompletion'; id: string; occurrenceId: string; completedOn: string; value: TaskState; previous: TaskState; baseRevision: number }
  | { kind: 'startWork'; id: string; session: WorkSession; baseRevision: number }
  | { kind: 'stopWork'; id: string; session: WorkSession; endedAt: number; note: string; baseRevision: number }
  | { kind: 'workNote'; id: string; session: WorkSession; note: string; baseRevision: number }
  | { kind: 'workState'; id: string; session: WorkSession; endedAt: number | null; reversed: boolean; baseRevision: number };
export function isCapabilityAction(action: Action): action is CapabilityAction {
  return ['task', 'project', 'position', 'relation', 'spread', 'question', 'quote', 'image', 'occlusion', 'assessment', 'source', 'cite', 'uncite', 'citationTriage', 'highlightColor', 'citationRange', 'completeTask', 'reverseTaskCompletion', 'startWork', 'stopWork', 'workNote', 'workState'].includes(action.kind);
}
export const emptyCapabilities = (id: string): BlockCapabilities => ({ block_id: id, built_in_tag: false, task: null, project: null, position: null, relation: null, question: null, quote: null, assessment: null, source: null, citations: [], history: false, merge_protected: false, reviewed_cards: false });
export function questionStatus(state: QuestionState, acceptedLive: boolean): QuestionStatus {
  return state.parked ? 'parked' : state.unsettled ? 'unsettled' : acceptedLive ? 'answered' : 'open';
}
export function currentReading(state: QuestionState, accepted: string | null, on: string): QuestionState {
  state = questionState(state)!;
  if (state.accepted === accepted) return state;
  const reading_history = [...(state.reading_history ?? [])];
  if (state.accepted) reading_history.push({ assessment_id: state.accepted, status: accepted ? 'superseded' : 'withdrawn', on });
  if (accepted) reading_history.push({ assessment_id: accepted, status: 'current', on });
  return { ...state, accepted, reading_history };
}
export function questionState(state: QuestionState | null | undefined): QuestionState | null {
  return state ? { ...state, reading_history: (state.reading_history ?? []).map(decision => ({ assessment_id: decision.assessment_id, status: decision.status, on: decision.on })) } : null;
}
export function sourceState(source: SourceState | null | undefined): SourceState | null {
  return source ? { format: source.format, state: source.state, origin: source.origin, match_key: source.match_key, citation_key: source.citation_key } : null;
}
export function sameState(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.entries(left), b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => {
    const other = b.find(([name]) => name === key);
    return other !== undefined && sameState(value, other[1]);
  });
}
export type Action =
  | CapabilityAction
  | { kind: 'cardTemplate'; id: string; value: CardTemplateState | null; previous: CardTemplateState | null; baseRevision: number }
  | { kind: 'cardHeld'; id: string; value: boolean; previous: boolean; baseRevision: number }
  | { kind: 'split'; id: string; block: Block; left: string; right: string }
  | { kind: 'merge'; id: string; destinationId: string; text: string }
  | { kind: 'text'; id: string; text: string; baseRevision?: number; expectedText?: string; relationPick?: RelationPickIntent }
  | { kind: 'settleSyncCopy'; id: string; settled: boolean; copy: NonNullable<Block['kept_copy']> }
  | { kind: 'heading'; id: string; heading: 1 | 2 | 3 | null }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'fieldKind'; id: string; value: FieldKind; previous: FieldKind; baseRevision?: number }
  | { kind: 'fieldHide'; id: string; value: FieldHide; previous: FieldHide; baseRevision?: number }
  | { kind: 'fieldRole'; id: string; value: FieldRole; previous: FieldRole; baseRevision?: number }
  | { kind: 'fieldCountsAs'; id: string; value: CountsAs | null; previous: CountsAs | null; baseRevision?: number }
  | { kind: 'fieldTargets'; id: string; targets: string[]; previous: string[]; baseRevision?: number }
  | { kind: 'subjectCriteria'; id: string; fields: string[]; previous: string[]; baseRevision?: number }
  | { kind: 'typePresentation'; id: string; value: { plural: string | null; icon: string | null }; previous: { plural: string | null; icon: string | null }; baseRevision?: number }
  | { kind: 'addType' | 'removeType'; id: string; title: string }
  | { kind: 'insert'; block: Block; after: string | null }
  | { kind: 'delete'; id: string }
  | { kind: 'restoreTag'; id: string; deletionId: string; revision: number }
  | { kind: 'restore'; id: string; snapshots: Snapshot[]; after: string | null }
  | { kind: 'move'; id: string; parentId: string; after: string | null };
interface CommandRecord {
  id: string;
  order: number;
  pageId: string | null;
  actions: Action[];
  inverse: Action[];
  before: Caret | null;
  after: Caret | null;
  /** Exact JSON request, immutable once persisted and first attempted. */
  frozen?: string;
  deleted?: string[];
  failed?: string;
  rejection?: { text: string; message: string; operations?: readonly Operation[]; actions?: readonly Action[] };
  /** Deferred choice: it never changes an uncertain frozen request. */
  resolutions?: { id: string; text: string; localText: string; remoteRevision: number; deferred: boolean }[];
}
export interface PageCommand extends CommandRecord { kind?: 'page'; pageId: string }
export interface NotebookCommand extends CommandRecord {
  kind: 'notebook';
  pageId: null;
  operations: Operation[];
  /** Prepared into one frozen batch only after earlier commands have committed. */
  capture?: CaptureIntent;
  /** Coalescing text behind an already queued value insertion; frozen requests stay immutable. */
  createdValueText?: { id: string; pageId: string; before: string };
  reason?: string;
  /** Pages whose structure or explicit memberships must be refreshed after acknowledgement/replay. */
  refreshPages?: string[];
}
export type Command = PageCommand | NotebookCommand;
export interface Ticket { deletionId: string; revision: number }
export interface HistoryEntry {
  forward: Action[];
  inverse: Action[];
  before: HistoryCaret | null;
  after: HistoryCaret | null;
  commandId: string;
  commands: Set<string>;
  applied: boolean;
  retained: boolean;
  external?: DocumentChange;
  typing?: { id: string; group?: number };
  rewrites?: Map<string, { before: Extract<Action, { kind: 'text' }>; after: Extract<Action, { kind: 'text' }> }>;
}
export interface Compiled { batch: Batch; deleted: string[] }
