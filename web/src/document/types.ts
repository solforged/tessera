import type { Block, Batch, FieldKind } from '../api/types';
import type { Caret, HistoryCaret } from './contract';
import type { OutlineRow } from './outline-index';

export interface Snapshot { block: Block; row: OutlineRow | null }
export type Action =
  | { kind: 'text'; id: string; text: string; baseRevision?: number }
  | { kind: 'heading'; id: string; heading: 1 | 2 | 3 | null }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'fieldKind'; id: string; value: FieldKind; previous: FieldKind; baseRevision?: number }
  | { kind: 'insert'; block: Block; after: string | null }
  | { kind: 'delete'; id: string }
  | { kind: 'restore'; id: string; snapshots: Snapshot[]; after: string | null }
  | { kind: 'move'; id: string; parentId: string; after: string | null };
export interface Command {
  id: string;
  order: number;
  pageId: string;
  actions: Action[];
  inverse: Action[];
  before: Caret | null;
  after: Caret | null;
  /** Exact JSON request, immutable once persisted and first attempted. */
  frozen?: string;
  deleted?: string[];
  failed?: string;
  rejection?: { text: string; message: string };
  /** Deferred choice: it never changes an uncertain frozen request. */
  resolutions?: { id: string; text: string; localText: string; remoteRevision: number; deferred: boolean }[];
}
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
