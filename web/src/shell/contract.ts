/**
 * Seams between the shell (sidebar, panes, history, palettes) and the
 * outline view. The shell implements `CommandRegistry`; the outline view
 * implements `OutlinePane` in `web/src/outline/OutlinePane.tsx`.
 */

import type { Caret, NotebookClient } from '../document/contract';
import type { CardSelection, FieldKind, LibraryFilters, Query, ReadingState, TaskQuery } from '../api/types';

export type PaneId = 'main' | 'side';

/**
 * How much of a page shows, from its gloss alone to everything: the depth dial's four stops. The opening is
 * the top-level text before the first heading; perspectives adds the sections' headings and the positions
 * filed under them, each closed to its own row.
 */
export type Depth = 'gloss' | 'opening' | 'perspectives' | 'full';
export const depthStops: readonly Depth[] = ['gloss', 'opening', 'perspectives', 'full'];
export const depthLabels: Record<Depth, string> = { gloss: 'Gloss', opening: 'Opening', perspectives: 'Perspectives', full: 'Full' };
export type PageProjection = 'read' | 'outline' | 'compare';
export interface PagePresentation { projection?: PageProjection; bullets?: boolean }

/**
 * One action. Every action appears in the command palette with its shortcut,
 * and in a visible menu or button. `keys` are display strings using the
 * spec's notation, e.g. `⌘Enter`, `⌃⇧F`; the owner of the action handles the
 * key itself, the palette only displays and runs it.
 */
export interface Command {
  id: string;
  title: string;
  description?: string;
  section: 'Go to' | 'Navigation' | 'Outline' | 'Block' | 'Editing' | 'Vim' | 'Page' | 'View';
  keys?: string[];
  /** Why it cannot run now; shown in the palette. Undefined when enabled. */
  disabledReason?(): string | undefined;
  run(beside?: boolean): void;
  /**
   * Bind the command to the target as it is now (pane, selection, caret).
   * The palette captures every command when it opens, so focus moving into
   * the palette cannot retarget them.
   */
  capture?(): Command;
}

export interface CommandRegistry {
  /** Register a set of commands; the returned function unregisters them. */
  register(commands: Command[]): () => void;
  list(): readonly Command[];
}

/** Where a pane is, restored exactly by back and forward. */
export interface ViewState {
  zoom: string | null;
  caret: Caret | null;
  /** Top visible row and its pixel offset from the pane's top. */
  scroll: { id: string; offset: number } | null;
  /** Collapsed block IDs. `null` on a fresh visit: the pane uses its stored folds for the page. */
  folds: string[] | null;
  /** Archived rows shown. */
  showArchived: boolean;
  /** How much of a titled page shows; absent means full. */
  depth?: Depth;
  /** Catalogue metadata visibility in a source outline; absent means hidden. */
  sourceFieldsVisible?: boolean;
  /** Page-only disclosures and comparison choices never change the document. */
  readDisclosures?: string[];
  compare?: CompareViewState;
  /** Set only by an open that names `caretId`: the pane starts editing at the caret instead of selecting its row. Never reported back, so history does not re-enter editing. */
  edit?: boolean;
}

export type OpenTarget =
  /** `blockId` zooms; `caretId` (default `blockId`) receives the caret at `caretOffset` (default 0). */
  | { kind: 'page'; pageId: string; blockId?: string; caretId?: string; caretOffset?: number; journalPeriod?: 'week' | 'month' | 'quarter' | 'year' }
  | { kind: 'table'; typeId: string | null; viewId: string | null; query: Query }
  | { kind: 'agenda'; date?: string; mode?: AgendaViewState['mode']; viewId?: string; query?: TaskQuery }
  /** `blockId` starts a review of that block's cards. */
  | { kind: 'review'; deckId?: string; blockId?: string; queue?: 'cards' | 'notes'; revisitId?: string }
  | { kind: 'fields'; typeId?: string }
  | { kind: 'field'; fieldId: string; previewKind?: FieldKind; section?: 'options' | 'targets' }
  | { kind: 'cards'; typeId: string; applyId?: string }
  | { kind: 'settings'; section?: 'devices'; deviceId?: string | null }
  | { kind: 'library'; tab?: LibraryTab; add?: boolean; details?: readonly string[] }
  /** Read a source. `at` is a passage ID to scroll to; `citationId` flashes that citation's range and does not count as reading. */
  | { kind: 'reader'; sourceId: string; snapshotId?: string; at?: string; citationId?: string }
  /** The perspectives filed under a subject, side by side. */
  | { kind: 'compare'; subjectId: string }
  | { kind: 'spread'; noteIds: string[] }
  /** One kind's notes by title. `key` is a `NoteKind.key`, or `all` for the kinds directory. */
  | { kind: 'index'; key: string; query?: Query; viewId?: string | null };

export type LibraryTab = ReadingState | 'all' | 'collections' | 'highlights';

export interface TableViewState {
  query: Query; scroll: number;
  /** Pane-local presentation, carried by history rather than the saved query. */
  hiddenFields?: string[]; titleWidth?: number; horizontalScroll?: number;
}
export interface FieldsViewState { scroll: number }
export interface FieldViewState { scroll: number }
export interface SettingsViewState { scroll: number }
export interface CompareViewState { scroll: number; comparison?: 'readings' | 'criteria'; chosen?: string[] | null; focusedQuestion?: string | null }
export interface IndexViewState { scroll: number; noteQuery?: Query; viewId?: string | null }
export interface AgendaViewState { date: string; mode: 'agenda' | 'week' | 'tasks'; query: TaskQuery; viewId: string | null; scroll: number }
/** `blockId` is a one-shot request to review that block's cards; the pane drops it once handled. */
export interface ReviewViewState { deckId: string | null; sessionId: string | null; selection: CardSelection | null; scroll: number; blockId?: string; queue?: 'cards' | 'notes'; revisitId?: string }
export type LibraryGroup = 'none' | 'author' | 'decade' | 'publisher' | 'language';
export interface LibraryViewState { view: string | null; collection?: string | null; tab: LibraryTab; text: string; sort: 'added' | 'title' | 'author' | 'year' | 'last_read' | 'progress'; filters: LibraryFilters; group: LibraryGroup; unprocessedOnly: boolean; colors: string[]; tags: string[]; scroll: number }
/** `ordinal` is the top passage; `offset` its pixel offset from the pane's top. */
export interface ReaderViewState { snapshotId: string | null; ordinal: number; offset: number }

export interface OutlinePaneProps {
  pane: PaneId;
  pageId: string;
  /** One-time request to open a journal ledger on arrival. */
  journalPeriod?: Extract<OpenTarget, { kind: 'page' }>['journalPeriod'];
  /** Initial view; the pane reports changes through `onViewChange`. */
  view: ViewState;
  projection?: PageProjection;
  onProjection?(projection: PageProjection): void;
  onViewChange(view: ViewState): void;
  onDelete?(anchor: HTMLElement): void;
  /** Open a page or block, here or in the other pane. */
  onOpen(target: OpenTarget, beside: boolean): void;
  /** This pane holds keyboard focus. */
  active: boolean;
  onActivate(): void;
  vim: boolean;
  /** Vim mode indicator for the header, or null when Vim is off. */
  onVimMode(mode: 'insert' | 'normal' | 'visual' | 'outline' | null): void;
  commands: CommandRegistry;
  notebook: NotebookClient;
}
