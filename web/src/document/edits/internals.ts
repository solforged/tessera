import type { Block, BlockCapabilities, WorkSession } from '../../api/types';
import type { BlockState, SourceDetailsEdit } from '../contract';
import type { OutlineIndex } from '../outline-index';
import type { Action, PageCommand } from '../types';

/** Host methods the edit branches call. */
export interface DocumentEditHost {
  todayDate(): string;
  commands(pageId: string): readonly PageCommand[];
  runningWork(): WorkSession | undefined;
  canRestore(ids: readonly string[]): boolean;
  clipboardScope(): string;
}

/**
 * Store accessors and helpers used by per-kind edit functions.
 * `Document` builds this without widening its public surface.
 */
export interface DocumentInternals {
  readonly pageId: string;
  readonly outline: OutlineIndex;
  readonly host: DocumentEditHost;
  readonly work: Map<string, WorkSession>;
  readonly investigationIds: Set<string>;
  block(id: string): BlockState | undefined;
  root(): BlockState | undefined;
  snapshot(id: string, base?: boolean): Block;
  capabilities(id: string, base?: boolean): BlockCapabilities;
  guardHide(id: string): void;
  guardMerge(id: string): void;
  sourceDetailsActions(edit: SourceDetailsEdit): Action[];
}
