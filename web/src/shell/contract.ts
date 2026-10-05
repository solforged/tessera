/**
 * Seams between the shell (sidebar, panes, history, palettes) and the
 * outline view. The shell implements `CommandRegistry`; the outline view
 * implements `OutlinePane` in `web/src/outline/OutlinePane.tsx`.
 */

import type { Caret, NotebookClient } from '../document/contract';
import type { CardSelection, Query, ReadingState, TaskQuery } from '../api/types';

export type PaneId = 'main' | 'side';

/**
 * One action. Every action appears in the command palette with its shortcut,
 * and in a visible menu or button. `keys` are display strings using the
 * spec's notation, e.g. `⌘Enter`, `⌃⇧F`; the owner of the action handles the
 * key itself, the palette only displays and runs it.
 */
export interface Command {
  id: string;
  title: string;
  section: 'Navigation' | 'Outline' | 'Editing' | 'Vim' | 'Page' | 'View';
  keys?: string[];
  /** Why it cannot run now; shown in the palette. Undefined when enabled. */
  disabledReason?(): string | undefined;
  run(): void;
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
}

export type OpenTarget =
  /** `blockId` zooms; `caretId` (default `blockId`) receives the caret. */
  | { kind: 'page'; pageId: string; blockId?: string; caretId?: string }
  | { kind: 'table'; typeId: string | null; viewId: string | null; query: Query }
  | { kind: 'agenda'; date?: string; viewId?: string; query?: TaskQuery }
  | { kind: 'review'; deckId?: string }
  | { kind: 'fields' }
  | { kind: 'settings' }
  | { kind: 'library'; tab?: LibraryTab }
  /** Read a source. `at` is a passage ID to scroll to; `citationId` flashes that citation's range and does not count as reading. */
  | { kind: 'reader'; sourceId: string; snapshotId?: string; at?: string; citationId?: string };

export type LibraryTab = ReadingState | 'all' | 'highlights';

export interface TableViewState { query: Query; scroll: number }
export interface FieldsViewState { scroll: number }
export interface SettingsViewState { scroll: number }
export interface AgendaViewState { date: string; mode: 'agenda' | 'tasks'; query: TaskQuery; viewId: string | null; scroll: number }
export interface ReviewViewState { deckId: string | null; sessionId: string | null; selection: CardSelection | null; scroll: number }
export interface LibraryViewState { tab: LibraryTab; text: string; sort: 'added' | 'title' | 'last_read' | 'progress'; unprocessedOnly: boolean; scroll: number }
/** `ordinal` is the top passage; `offset` its pixel offset from the pane's top. */
export interface ReaderViewState { snapshotId: string | null; ordinal: number; offset: number }

export interface OutlinePaneProps {
  pane: PaneId;
  pageId: string;
  /** Initial view; the pane reports changes through `onViewChange`. */
  view: ViewState;
  onViewChange(view: ViewState): void;
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
