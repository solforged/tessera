import type { Block, BlockCapabilities, Batch, FieldKind, Operation, ProjectState, TaskState, WorkSession } from '../api/types';
import type { Caret, HistoryCaret } from './contract';
import type { OutlineRow } from './outline-index';

export interface Snapshot { block: Block; row: OutlineRow | null; manual_types: string[]; capabilities?: BlockCapabilities }
export type CapabilityAction =
  | { kind: 'task'; id: string; value: TaskState | null; previous: TaskState | null; baseRevision: number; restore?: boolean }
  | { kind: 'project'; id: string; value: ProjectState | null; previous: ProjectState | null; baseRevision: number }
  | { kind: 'completeTask'; id: string; occurrenceId: string; completedOn: string; previous: TaskState; baseRevision: number }
  | { kind: 'reverseTaskCompletion'; id: string; occurrenceId: string; completedOn: string; value: TaskState; previous: TaskState; baseRevision: number }
  | { kind: 'startWork'; id: string; session: WorkSession; baseRevision: number }
  | { kind: 'stopWork'; id: string; session: WorkSession; endedAt: number; note: string; baseRevision: number }
  | { kind: 'workNote'; id: string; session: WorkSession; note: string; baseRevision: number }
  | { kind: 'workState'; id: string; session: WorkSession; endedAt: number | null; reversed: boolean; baseRevision: number };
export function isCapabilityAction(action: Action): action is CapabilityAction {
  return ['task', 'project', 'completeTask', 'reverseTaskCompletion', 'startWork', 'stopWork', 'workNote', 'workState'].includes(action.kind);
}
export const emptyCapabilities = (id: string): BlockCapabilities => ({ block_id: id, task: null, project: null, history: false, merge_protected: false, reviewed_cards: false });
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
  | { kind: 'split'; id: string; block: Block; left: string; right: string }
  | { kind: 'merge'; id: string; destinationId: string; text: string }
  | { kind: 'text'; id: string; text: string; baseRevision?: number }
  | { kind: 'heading'; id: string; heading: 1 | 2 | 3 | null }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'fieldKind'; id: string; value: FieldKind; previous: FieldKind; baseRevision?: number }
  | { kind: 'addType' | 'removeType'; id: string; title: string }
  | { kind: 'insert'; block: Block; after: string | null }
  | { kind: 'delete'; id: string }
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
  reason?: string;
}
export type Command = PageCommand | NotebookCommand;
export interface Ticket { deletionId: string; revision: number }
export interface HistoryEntry {
  forward: Action[];
  inverse: Action[];
  before: HistoryCaret | null;
  after: Caret | null;
  commandId: string;
  commands: Set<string>;
  applied: boolean;
  retained: boolean;
  rewrites?: Map<string, { before: Extract<Action, { kind: 'text' }>; after: Extract<Action, { kind: 'text' }> }>;
}
export interface Compiled { batch: Batch; deleted: string[] }
