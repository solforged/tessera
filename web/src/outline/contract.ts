/** What the shell gives the outline view, which `OutlinePane` in `OutlinePane.tsx` implements. */

import type { NoteKind } from '../api/types';
import type { CommandRegistry, OpenTarget, PageProjection, PaneId, ViewState } from '../core/contract';
import type { NotebookClient } from '../document/contract';

export interface OutlinePaneProps {
  pane: PaneId;
  pageId: string;
  /** One-time request to open a journal ledger on arrival. */
  journalPeriod?: Extract<OpenTarget, { kind: 'page' }>['journalPeriod'];
  /** Initial view; the pane reports changes through `onViewChange`. */
  view: ViewState;
  projection?: PageProjection;
  onProjection?(projection: PageProjection): void;
  projectionReason?(projection: PageProjection): string | undefined;
  onViewChange(view: ViewState): void;
  onDelete?(anchor: HTMLElement): void;
  /** Reuses the outline's loaded kind metadata for the pane header. */
  onNoteKinds?(kinds: NoteKind[] | undefined): void;
  /** Open a page or block, here or in the other pane. */
  onOpen(target: OpenTarget, beside: boolean): void;
  /** Why opening beside is unavailable at the current pane width. */
  besideReason?: string;
  /** This pane holds keyboard focus. */
  active: boolean;
  onActivate(): void;
  vim: boolean;
  /** Vim mode indicator for the header, or null when Vim is off. */
  onVimMode(mode: 'insert' | 'normal' | 'visual' | 'outline' | null): void;
  commands: CommandRegistry;
  notebook: NotebookClient;
}
