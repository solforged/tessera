/**
 * The client-side notebook: one shared document per page, a notebook-wide
 * block cache for references, and the sync engine behind them. Implemented in
 * `web/src/document/`; the outline view and the shell use only these types.
 *
 * Rules every implementation keeps:
 * - Typing never waits on the network, the service or storage.
 * - No per-keystroke work proportional to page or notebook size.
 * - Edits are saved as revision-checked operations, coalescing text for
 *   150 to 300 ms (1 s at most); pending batches live in an IndexedDB outbox
 *   until the service acknowledges them. "Saved" means committed.
 * - A stale write never overwrites a newer one. When a remote change touches
 *   a block with unsent local text, the block enters conflict and keeps both.
 */

import type { Accessor } from 'solid-js';
import type { Block, BlockKind, ChangeEvent, Citation, Committed, FieldDefinition, FieldKind, Operation, PassagePoint, ProjectState, SettingsView, SourceRecord, SourceState, TaskState, WorkSession } from '../api/types';
import type { PositionInfo } from '../api/types';
import type { AssessmentInfo, AssessmentState, QuestionInfo, QuestionState } from '../api/types';
import type { ApiClient } from '../api/client';

/** A position in a block's text, in UTF-16 code units. */
export interface Caret {
  id: string;
  offset: number;
}

/** A text selection that may span blocks; anchor and head in any order. */
export interface TextRange {
  anchor: Caret;
  head: Caret;
}

/** One block as the client sees it. Reading fields inside a reactive scope tracks them. */
export interface BlockState {
  readonly id: string;
  readonly kind: BlockKind;
  readonly parentId: string | null;
  readonly pageId: string;
  /** Local text, which may be ahead of the service. */
  readonly text: string;
  readonly heading: 1 | 2 | 3 | null;
  readonly archived: boolean;
  readonly manual_types: readonly string[];
  readonly task: TaskState | null;
  readonly project: ProjectState | null;
  readonly position: PositionInfo | null;
  readonly question: QuestionInfo | null;
  readonly assessment: AssessmentInfo | null;
  readonly mergeProtected: boolean;
  readonly reviewedCards: boolean;
  /** Present on a source page's root. */
  readonly source: SourceRecord | null;
  /** Active citations of this block, in creation order. */
  readonly citations: readonly Citation[];
  /** Last revision the service acknowledged; 0 until a new block is committed. */
  readonly revision: number;
  /** Local changes not yet acknowledged. */
  readonly pending: boolean;
  /** Set when a remote change met unsent local text. Both versions are kept. */
  readonly conflict: { readonly remoteText: string; readonly remoteRevision: number } | null;
}

/**
 * Order and nesting of a page's live descendants (the root excluded), in
 * preorder. Reads are O(log n) or better. `version()` changes on structural
 * edits only, never on text edits, so lists can depend on it cheaply.
 */
export interface OutlineReader {
  version(): number;
  size(): number;
  idAt(index: number): string;
  /** -1 when the block is not in this page. */
  indexOf(id: string): number;
  /** 0 for children of the root. */
  depth(id: string): number;
  /** The root's ID for top-level blocks. */
  parentOf(id: string): string;
  children(id: string): readonly string[];
  /** Exclusive preorder end of the subtree starting at `index`. */
  subtreeEnd(index: number): number;
}

/**
 * Intent-level edits. The document turns each into operations plus an inverse
 * for undo; the outline view never builds operations itself.
 */
export type Edit =
  /**
   * Replace text (from the active CodeMirror). Consecutive text edits to one
   * block coalesce into one undo step. `heading`, when present, sets the
   * heading in the same undo step (the `# ` input rule).
   */
  | { kind: 'text'; id: string; text: string; heading?: 1 | 2 | 3 | null }
  | { kind: 'task'; id: string; value: TaskState | null }
  | { kind: 'planTask'; id: string; text: string; value: TaskState }
  | { kind: 'completeTask'; id: string; completedOn: string; stopWork?: WorkSession }
  | { kind: 'project'; id: string; value: ProjectState | null }
  | { kind: 'position'; id: string; value: boolean }
  | { kind: 'question'; id: string; value: QuestionState | null }
  | { kind: 'assessment'; id: string; value: AssessmentState | null }
  | { kind: 'startWork'; id: string; startedAt: number }
  | { kind: 'stopWork'; id: string; session: WorkSession; endedAt: number; note: string }
  | { kind: 'workNote'; id: string; session: WorkSession; note: string }
  /** Set, change or remove a page's source capability. */
  | { kind: 'source'; id: string; value: SourceState | null }
  | { kind: 'cite'; id: string; citation: NewCitation }
  /** Remove the selected citations together in one undo step. */
  | { kind: 'uncite'; id: string; citationIds: string[] }
  | { kind: 'citationTriage'; id: string; citationId: string; triage: Citation['triage'] }
  | { kind: 'highlightColor'; id: string; citationId: string; color: Citation['color'] }
  /**
   * Append a block with `text` under `parentId` (after `after`, or last when
   * omitted) that cites `citation`; one undo step. `created[0]` is its ID.
   */
  | { kind: 'highlight'; parentId: string; after?: string | null; text: string; citation: NewCitation; color?: Citation['color'] }
  /**
   * Enter: the original keeps its ID, children and text before `offset`.
   * At a parent's end, insert its first child; otherwise insert a sibling.
   * A caret inside a complete reference or tag is a no-op.
   */
  | { kind: 'split'; id: string; offset: number; zoomRoot?: string | null }
  /** A new empty block. */
  | { kind: 'insert'; parentId: string; after: string | null; text?: string }
  /** Backspace at the start: append `sourceId` to `destinationId`, which keeps its ID. */
  | { kind: 'merge'; sourceId: string; destinationId: string }
  /**
   * Each with its subtree. Boundary moves are silent no-ops without history.
   * `zoomRoot` confines edits to its descendants; its direct children cannot
   * outdent. Outdent leaves unselected following siblings with their parent.
   */
  | { kind: 'indent'; ids: string[]; zoomRoot?: string | null }
  | { kind: 'outdent'; ids: string[]; zoomRoot?: string | null }
  | { kind: 'move'; ids: string[]; direction: 'up' | 'down'; zoomRoot?: string | null }
  | { kind: 'moveTo'; ids: string[]; parentId: string; after: string | null }
  /** Delete blocks with their subtrees. */
  | { kind: 'delete'; ids: string[] }
  /**
   * Delete a cross-block text range: the first block keeps its ID, its prefix
   * and the last block's suffix; the last block's children move to it; blocks
   * between are deleted. `between` lists the blocks the pane shows strictly
   * between the endpoints, in preorder. If any other live block lies between
   * them (folded, archived or hidden), the edit fails with a reason and
   * changes nothing: text selection never deletes what the user cannot see.
   */
  | { kind: 'deleteRange'; range: TextRange; between: string[] }
  /**
   * Replace a text range (possibly one caret, possibly across blocks, same
   * rules as `deleteRange`) with `text` as one batch and one undo step.
   * `text` inserts literally, newlines included; `paste` turns lines into
   * sibling blocks with leading indentation nesting them; `split` is Enter
   * over a selection, heading-aware like `split`. Empty text deletion expands
   * partial reference endpoints to whole tokens. `selectionBefore` preserves
   * the actual selection when key routing supplies an expanded removal range.
   */
  | {
      kind: 'replaceRange';
      range: TextRange;
      selectionBefore?: TextRange;
      between: string[];
      text: string;
      mode: 'text' | 'paste' | 'split';
      zoomRoot?: string | null;
    }
  /** Paste plain text at a caret; lines become sibling blocks, leading indentation nests them. */
  | { kind: 'paste'; at: Caret; text: string }
  | { kind: 'heading'; id: string; level: 1 | 2 | 3 | null }
  /** Append a definition to the Fields page with its kind in one undo step. */
  | { kind: 'addField'; name: string; value: FieldKind }
  /** The definition snapshot supplies the previous kind and revision for undo. */
  | { kind: 'fieldKind'; definition: FieldDefinition; value: FieldKind }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'addType' | 'removeType'; id: string; title: string };

/** What a new citation needs; `quote`, `locator` and `ordinal` make the optimistic state complete until the receipt replaces it. */
export interface NewCitation {
  id: string;
  sourceId: string;
  snapshotId: string;
  start: PassagePoint;
  end: PassagePoint;
  quote: string;
  locator: string;
  /** Start passage's ordinal. */
  ordinal: number;
}

export type EditResult =
  | { ok: true; caret: Caret | null; created: string[] }
  | { ok: false; reason: string };

/** Where undo or redo leaves the user: a caret, plus the text selection to restore if there was one. */
export type HistoryCaret = Caret & { range?: TextRange };

export type SaveState =
  /** Everything committed. */
  | 'saved'
  /** A batch is waiting for its acknowledgment. */
  | 'saving'
  /** Local edits waiting to be sent. */
  | 'queued'
  /** The service is unreachable; edits are kept in the outbox and retried. */
  | 'offline'
  /** At least one block holds both versions. */
  | 'conflict'
  /** A batch was rejected and needs attention; `saveMessage` says why. */
  | 'error';

/** One page's shared document. Both panes showing a page share one instance. */
export interface PageDocument {
  readonly pageId: string;
  status(): 'loading' | 'ready' | 'missing' | 'error';
  /** Load error or missing-page message. */
  statusMessage(): string;
  root(): BlockState | undefined;
  /** Live blocks of this page, by ID; undefined when absent. */
  block(id: string): BlockState | undefined;
  /** Whether a block is archived, untracked; pair it with `archivedVersion` to follow every block's flag at once. */
  isArchived(id: string): boolean;
  /** Changes whenever any block's archived flag changes. */
  archivedVersion(): number;
  outline: OutlineReader;

  /** `caretBefore` is restored by undo. */
  edit(edit: Edit, caretBefore?: Caret | null): EditResult;
  /** Renames a page. Journal titles cannot change. */
  rename(title: string): EditResult;
  addType(blockId: string, title: string): EditResult;
  removeType(blockId: string, title: string): EditResult;
  undo(): HistoryCaret | null;
  redo(): HistoryCaret | null;
  canUndo(): boolean;
  canRedo(): boolean;

  saveState(): SaveState;
  saveMessage(): string;
  /** Wait for this page's pending commands to commit; uncertainty remains pending. */
  flush(): Promise<void>;
  /** Keep the local version (rewrites over the remote one) or take the remote one. */
  resolveConflict(id: string, keep: 'mine' | 'theirs'): void;
  /** Drop one pane's hold; the document closes when no pane holds it. */
  release(): void;
}

/** The notebook-wide client. One per window. */
export interface NotebookClient {
  readonly api: ApiClient;
  /** Durable notebook command; resolves only after acknowledgement. */
  commit(operations: readonly Operation[], reason?: string): Promise<Committed>;
  commandState(): SaveState;
  commandMessage(): string;
  /** Open (or share) a page's document. Call `release()` when done. */
  open(pageId: string): PageDocument;
  /** Live pages, then journal days newest first; follows remote changes. */
  roots: Accessor<readonly Block[]>;
  /** Today's journal day in the notebook's time zone, created if missing. */
  today(): Promise<string>;
  /** Service calendar date, or the device date when offline. */
  todayDate(): string;
  settings(): SettingsView | undefined;
  refreshSettings(): Promise<void>;
  vim(): boolean;
  setSetting(key: 'time_zone' | 'vim', value: string): Promise<void>;
  settingsBusy(): boolean;
  settingsMessage(): string;
  canUndoSetting(): boolean;
  canRedoSetting(): boolean;
  undoSetting(): Promise<void>;
  redoSetting(): Promise<void>;
  /** The journal root for `YYYY-MM-DD`, created if missing. */
  journal(date: string): Promise<string>;
  /** A new page; fails when the title is taken (ignoring case). */
  createPage(title: string): Promise<string>;
  /** The page with this title, created if missing (for tags). */
  pageByTitle(title: string, create: boolean): Promise<string | null>;
  deletePage(pageId: string): Promise<void>;
  /** Undo the last page deletion in this window. */
  restorePage(pageId: string): Promise<void>;
  /**
   * Current state of any block, for references. undefined while loading,
   * null when it does not exist or is deleted. Follows local and remote edits.
   */
  lookup(id: string): Accessor<Block | null | undefined>;
  /** Change stream state. */
  connection(): 'connecting' | 'live' | 'offline';
  /** Worst save state across open documents, plus outbox items for closed ones. */
  saveState(): SaveState;
  /** Why the notebook is in `error` or `conflict`, including documents no longer open. */
  saveMessage(): string;
  /** Operations persisted in the outbox and not yet acknowledged. */
  queuedChanges(): number;
  /** `failed` when IndexedDB is unavailable or a write failed: edits live only in this tab. */
  localPersistence(): 'ready' | 'failed';
  /** Send queued batches now (after `error` or `offline`). */
  retry(): void;
  /** Plain text of every block with unacknowledged local text, for "Copy unsaved text". */
  unsavedText(): string;
  /** Pages holding a conflict, including ones no pane has open, so "Review conflict" can open them. */
  conflictedPages(): readonly string[];
  /**
   * Text from edits the service rejected and that could not be reapplied
   * (for example a paste whose position no longer exists). It is kept
   * durably, shown in `saveMessage` and `unsavedText`, and keeps the save
   * state at `error` until the user dismisses it after copying.
   */
  rejectedText(): string;
  dismissRejected(): void;
  /** Last committed change sequence this window has observed (own or remote). Reactive. */
  changeSequence(): number;
  /** Latest observed change; catch-up events combine affected view IDs. */
  lastChange(): ChangeEvent | null;
}
