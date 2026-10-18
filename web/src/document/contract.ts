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
import type { PositionInfo, RelationInfo, RelationKind } from '../api/types';
import type { FieldHide } from '../fields/hide';
import type { CountsAs } from '../fields/counts';
import type { FieldRole } from '../fields/roles';
import type { AssessmentInfo, AssessmentState, QuestionInfo, QuestionState, QuoteState } from '../api/types';
import type { ApiClient } from '../api/client';
import type { CardTemplate, CardTemplateState } from '../api/types';
import type { BlockCapabilities } from '../api/types';
import type { ImageRef, Occlusion } from '../api/types';

import type { LiveSubtree } from './subtrees';
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
  readonly keptCopy: Block['kept_copy'];
  readonly manual_types: readonly string[];
  readonly task: TaskState | null;
  readonly project: ProjectState | null;
  readonly position: PositionInfo | null;
  readonly relation: RelationInfo | null;
  readonly spread?: boolean;
  readonly question: QuestionInfo | null;
  readonly assessment: AssessmentInfo | null;
  readonly quote: QuoteState | null;
  readonly image: ImageRef | null;
  readonly occlusion: Occlusion | null;
  readonly mergeProtected: boolean;
  readonly reviewedCards: boolean;
  readonly templateCards?: number;
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

/** Ordinary source fields, source capability and explicit page tags in one command. */
export interface SourceDetailsEdit {
  kind: 'sourceDetails';
  title?: string;
  fields: { id: string; entries: string[]; values: string[] }[];
  source?: SourceState;
  tags?: string[];
}

/** A committed transaction; history remains usable after its documents close. */
export interface DocumentChange {
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** Complete block subtrees on the clipboard, with depths relative to each selected root. */
export interface ClipboardBlock {
  block: Block;
  depth: number;
  manualTypes: string[];
  capabilities: BlockCapabilities;
}
export interface BlockClipboard {
  version: 1;
  scope: string;
  cut: boolean;
  blocks: ClipboardBlock[];
}

/** External clipboard content, expressed only as native text, rows and capabilities. */
export interface PasteRow {
  text: string;
  indent: number;
  heading: 1 | 2 | 3 | null;
  task: 'todo' | 'done' | null;
}

/** An accepted relation query, persisted with its literal value before any candidate lookup. */
export interface RelationPickIntent {
  query: string;
  targets: string[];
  owner?: { id: string; page: string };
  targetId?: string;
  createId?: string;
  create?: { typeTitle?: string; source?: boolean };
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
  | { kind: 'text'; id: string; text: string; heading?: 1 | 2 | 3 | null; caret?: number; group?: number; relationPick?: RelationPickIntent }
  /** An explicit holder/subject change never coalesces with typing or another picker choice. */
  | { kind: 'positionLinks'; id: string; text: string }
  /** Resolve a version kept beside its original, in one batch and undo step. */
  | { kind: 'keptCopy'; id: string; choice: 'use' | 'discard' | 'both' }
  | { kind: 'task'; id: string; value: TaskState | null }
  | { kind: 'planTask'; id: string; text: string; value: TaskState }
  | { kind: 'completeTask'; id: string; completedOn: string; stopWork?: WorkSession }
  | { kind: 'project'; id: string; value: ProjectState | null }
  /** Replace or remove a task's explicit Project field in one undo step. */
  | { kind: 'taskProject'; id: string; fieldId: string; projectId: string | null }
  | { kind: 'position'; id: string; value: boolean }
  /** Insert an attributed reading and its Gist slot together, as one undo step. */
  | { kind: 'addReading'; parentId: string; after: string | null; holderId: string; gistFieldId: string }
  /** Set the authored kind and optional text together (including a slash command's removal). */
  | { kind: 'relation'; id: string; value: RelationKind | null; text?: string }
  /** Insert a last child with its kind and target in one authored change. */
  | { kind: 'addRelation'; parentId: string; value: RelationKind; targetId: string; sourceText?: string }
  | { kind: 'spread'; id: string; value: boolean }
  | { kind: 'question'; id: string; value: QuestionState | null }
  /** Capture or update frozen rows; optional text replaces the picker query in the same undo step. */
  | { kind: 'quote'; id: string; value: QuoteState | null; text?: string }
  | { kind: 'assessment'; id: string; value: AssessmentState | null }
  /** Insert a dated assessment or a structurally parented branch in one undo step. */
  | { kind: 'writeAssessment'; parentId: string; assessedOn: string }
  | { kind: 'addBranchQuestion'; parentId: string }
  | { kind: 'startWork'; id: string; startedAt: number }
  | { kind: 'stopWork'; id: string; session: WorkSession; endedAt: number; note: string }
  | { kind: 'workNote'; id: string; session: WorkSession; note: string }
  /** Set, change or remove a page's source capability. */
  | { kind: 'source'; id: string; value: SourceState | null }
  /** Change source title and ordinary page fields together, retaining their block identities. */
  | SourceDetailsEdit
  | { kind: 'cite'; id: string; citation: NewCitation }
  /** Remove the selected citations together in one undo step. */
  | { kind: 'uncite'; id: string; citationIds: string[] }
  | { kind: 'citationTriage'; id: string; citationId: string; triage: Citation['triage'] }
  | { kind: 'highlightColor'; id: string; citationId: string; color: Citation['color'] }
  /**
   * Append a block with `text` under `parentId` (after `after`, or last when
   * omitted) that cites `citation`; one undo step. `created[0]` is its ID.
   */
  | { kind: 'highlight'; parentId: string; after?: string | null; text: string; citation: NewCitation; color?: Citation['color']; note?: boolean }
  /** Update evidence and absorb unreferenced source-page highlights in one undo step. */
  | { kind: 'mergeHighlights'; merges: { citation: Citation; removeIds: string[]; removeCitationIds?: string[] }[]; note?: boolean }
  /**
   * Enter at the start inserts an empty block above and keeps the original.
   * At a parent's end, insert its first child; otherwise insert a sibling.
   * A caret inside a complete reference or tag splits just after it.
   * `fieldEntry` identifies a known parent field; an empty leaf value exits it.
   */
  | { kind: 'split'; id: string; offset: number; zoomRoot?: string | null; fieldEntry?: string | null }
  /** A new block, optionally with a frozen quote captured in the same undo step. */
  | { kind: 'insert'; parentId: string; after: string | null; text?: string; quote?: QuoteState }
  | { kind: 'image'; id: string; image: ImageRef | null }
  | { kind: 'occlusion'; id: string; occlusion: Occlusion | null }
  | { kind: 'insertImages'; parentId: string; after: string | null; images: ImageRef[] }
  | { kind: 'placeImages'; targetId: string; images: ImageRef[] }
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
      fieldEntry?: string | null;
    }
  /** Paste plain text at a caret; lines become sibling blocks, leading indentation nests them. */
  | { kind: 'paste'; at: Caret; text: string }
  /** Converted external content; a row selection replaces its complete subtrees. */
  | { kind: 'pasteRows'; range: TextRange; between: string[]; rows: PasteRow[]; replaceRoots?: string[]; zoomRoot?: string | null }
  /** Insert copied subtrees, or restore and move cut subtrees, without merging their identities into text. */
  | { kind: 'pasteBlocks'; range: TextRange; between: string[]; content: BlockClipboard; replaceRoots?: string[]; zoomRoot?: string | null }
  | { kind: 'heading'; id: string; level: 1 | 2 | 3 | null }
  /** Append a definition to the Fields page with its kind in one undo step. */
  | { kind: 'addField'; name: string; value: FieldKind; role?: FieldRole }
  /** The definition snapshot supplies the previous kind and revision for undo. */
  | { kind: 'fieldKind'; definition: FieldDefinition; value: FieldKind }
  | { kind: 'fieldHide'; definition: FieldDefinition; value: FieldHide }
  | { kind: 'fieldRole'; definition: FieldDefinition; value: FieldRole }
  | { kind: 'fieldCountsAs'; definition: FieldDefinition; value: CountsAs | null }
  | { kind: 'fieldTargets'; definition: FieldDefinition; targets: string[] }
  /** Replace the subject's explicit criteria; an empty previous list restores derivation on undo. */
  | { kind: 'subjectCriteria'; id: string; fields: string[]; previous: string[]; revision: number }
  | { kind: 'typePresentation'; id: string; revision: number; value: { plural: string | null; icon: string | null }; previous: { plural: string | null; icon: string | null } }
  | { kind: 'cardTemplate'; id: string; previous: CardTemplate | null; value: CardTemplateState | null }
  /** Hold or release the supplied current card snapshots as one undo step. */
  | { kind: 'cardHeld'; cards: { id: string; source_block_id: string; revision: number; held: boolean; active: boolean }[]; held: boolean }
  /** An entry per field under `parentId` after `after`, each with one value block holding `value`; one undo step, caret at the end of the first value. */
  | { kind: 'addFieldEntries'; parentId: string; after: string | null; entries: { fieldId: string; value: string; quote?: QuoteState }[] }
  /** Convert a block to a field entry, keeping the text after `from` in its first value; one undo step. */
  | { kind: 'fieldEntry'; id: string; fieldId: string; from: number }
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

/** A cell accepted before async name resolution: each replacement uses the normal durable outbox and one history entry. */
export interface PendingTextCommit {
  readonly result: EditResult;
  replace(text: string): EditResult;
  finish(): void;
}

/** Where undo or redo leaves the user: a caret, plus the text or row selection to restore if there was one. */
export type HistoryCaret = Caret & { range?: TextRange; selection?: { anchor: string; head: string } };

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
  /** Engine-derived behavior and system-tag protection for a live atom. */
  capabilities(id: string): BlockCapabilities;
  /** Whether a block is archived, untracked; pair it with `archivedVersion` to follow every block's flag at once. */
  isArchived(id: string): boolean;
  /** Changes whenever any block's archived flag changes. */
  archivedVersion(): number;
  outline: OutlineReader;
  /** Capture selected roots and every descendant, including folded and archived rows. */
  clipboard(ids: readonly string[], cut?: boolean): BlockClipboard;
  /** Resolve a cut's shared restore tickets before changing its destination. */
  prepareClipboard(content: BlockClipboard): Promise<BlockClipboard>;

  /** `caretBefore` is restored by undo. */
  edit(edit: Edit, caretBefore?: HistoryCaret | null): EditResult;
  /** Accept authored text now, then amend that same undoable commit until its async work finishes. */
  beginTextCommit(write: (edit: PageDocument['edit']) => EditResult): PendingTextCommit;
  /** Reserve a cross-page change's undo boundary immediately; Undo waits for a pending change to finish. */
  rememberChange(change: DocumentChange | Promise<DocumentChange>): DocumentChange;
  /** Renames a page. Journal titles cannot change. */
  rename(title: string): EditResult;
  addType(blockId: string, title: string): EditResult;
  removeType(blockId: string, title: string): EditResult;
  undo(): HistoryCaret | null;
  redo(): HistoryCaret | null;
  /** A notice when the latest history entry could not safely be replayed. */
  historyMessage(): string;
  canUndo(): boolean;
  canRedo(): boolean;

  saveState(): SaveState;
  saveMessage(): string;
  /** Wait for this page's pending commands to commit; uncertainty remains pending. */
  flush(): Promise<void>;
  /** Hold `id`'s unsent typing while its caret is inside an unfinished `#tag`, or release it. */
  holdTag(id: string, typing: boolean): void;
  /** Keep the local version (rewrites over the remote one) or take the remote one. */
  resolveConflict(id: string, keep: 'mine' | 'theirs'): void;
  /** Drop one pane's hold; the document closes when no pane holds it. */
  release(): void;
}

/** A cleared capture, kept before any title or journal lookup starts. */
export interface CaptureIntent {
  date: string;
  text: string;
  task: TaskState | null;
  picked: [string, string][];
  targetPageId?: string;
  question?: boolean;
}

export interface CaptureResult {
  pageId: string;
  blockId: string;
  undo(): Promise<void>;
}

/** Acceptance is durable; delivery can finish later, including after an offline interval. */
export interface CaptureReceipt {
  delivered: Promise<CaptureResult | null>;
}

/** A type page created by this window's own edit, with the change sequence that created it. */
export interface DerivedType { id: string; title: string; sequence: number }

/** The notebook-wide client. One per window. */
export interface NotebookClient {
  readonly api: ApiClient;
  /** Durable notebook command; structural writes name pages whose outlines must refresh before acknowledgement is exposed. */
  commit(operations: readonly Operation[], reason?: string, refreshPages?: readonly string[]): Promise<Committed>;
  /** Keep text for a value whose creation is already queued, before its editor can mount. */
  queueCreatedValueText(valueId: string, pageId: string, text: string): Promise<void>;
  /** Resolves once the capture is in the outbox, not when the service acknowledges it. */
  appendCapture(text: string, task: TaskState | null, picked?: readonly [string, string][], options?: Pick<CaptureIntent, 'targetPageId' | 'question'>): Promise<CaptureReceipt>;
  /** One acknowledged transaction across pages, with exact field-level undo/redo. */
  editSourceDetails(edits: readonly { pageId: string; edit: SourceDetailsEdit }[]): Promise<DocumentChange>;
  /** Move a journal subtree and leave a live reference, in one transaction with undo/redo. */
  integrateBlock(id: string, destinationId: string): Promise<DocumentChange>;
  /** Move selected subtrees to the end of another titled page, preserving identities, in one undoable transaction. */
  moveBlocks(ids: readonly string[], destinationId: string): Promise<DocumentChange>;
  /** Make a journal block's text a project page, move its children there and leave a link, in one transaction with undo/redo. Reuses a page of that title. */
  promoteToProject(id: string, title: string): Promise<{ pageId: string; change: DocumentChange }>;
  commandState(): SaveState;
  commandMessage(): string;
  /** Open (or share) a page's document. Call `release()` when done. */
  open(pageId: string): PageDocument;
  /** Live pages, then journal days newest first; follows remote changes. */
  roots: Accessor<readonly Block[]>;
  /** Today's journal day in the notebook's time zone, created if missing. */
  today(signal?: AbortSignal): Promise<string>;
  /** Service calendar date, or the device date when offline. */
  todayDate(): string;
  /** The open work session this window knows of; reactive. */
  runningWork(): WorkSession | undefined;
  settings(): SettingsView | undefined;
  refreshSettings(): Promise<void>;
  vim(): boolean;
  confirmViewDelete(): boolean;
  setSetting(key: 'time_zone' | 'vim' | 'confirm_view_delete', value: string): Promise<void>;
  settingsBusy(): boolean;
  settingsMessage(): string;
  canUndoSetting(): boolean;
  canRedoSetting(): boolean;
  undoSetting(): Promise<void>;
  redoSetting(): Promise<void>;
  /** The journal root for `YYYY-MM-DD`, created if missing. */
  journal(date: string, signal?: AbortSignal): Promise<string>;
  /** A new page; fails when the title is taken (ignoring case). */
  createPage(title: string): Promise<string>;
  /** Resolves once pending edits, including just-created pages, have reached the service. */
  flush(): Promise<void>;
  /** The page with this title, created if missing (for tags). */
  pageByTitle(title: string, create: boolean): Promise<string | null>;
  /** Permanently merge two pages after saving their pending edits; resolves after acknowledgement. */
  mergePage(from: string, into: string): Promise<void>;
  /** Retain local edit history when undoing creation, so redo can replay later edits after restoration. */
  deletePage(pageId: string, options?: { retainHistory?: boolean }): Promise<void>;
  /** Restore a retained page deletion, including one from before reload or another window. */
  restorePage(pageId: string): Promise<void>;
  /**
   * Current state of any block, for references. undefined while loading,
   * null when it does not exist or is deleted. Follows local and remote edits.
   */
  lookup(id: string): Accessor<Block | null | undefined>;
  /** A mounted live subtree; concurrent subscriptions share a bounded batch read. */
  watchSubtree(id: string): LiveSubtree;
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
  /**
   * Type pages this window's own edits derived, newest last: a `#tag` or Add type whose title named no page.
   * Reactive; the outline reads it to offer a template on a tag's first use.
   */
  derivedTypes(): readonly DerivedType[];
}
