import { batch, createSignal } from 'solid-js';
import type { Signal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Batch, Block, BlockCapabilities, Committed, PageView, TextRewrite, WorkSession } from '../api/types';
import type {
  BlockClipboard,
  BlockState,
  DocumentChange,
  Edit,
  EditResult,
  HistoryCaret,
  PageDocument,
  PendingTextCommit,
  SaveState,
  SourceDetailsEdit,
} from './contract';
import type { Caret } from '../core/contract';
import { OutlineIndex } from './outline-index';
import type { Action, Command, HistoryEntry, PageCommand, Snapshot } from './types';
import { emptyCapabilities, isCapabilityAction, questionStatus, sameState, sourceState } from './types';
import { isStableReference, textTokens } from '../model/text-tokens';
import { mapTextOffset, rebaseText } from './text-patch';
import { titleKey } from '../model/title-key';

import { EditSession } from './edits/session';
import type { DocumentInternals } from './edits/internals';
import {
  editAddField,
  editAddFieldEntries,
  editFieldCountsAs,
  editFieldEntry,
  editFieldHide,
  editFieldKind,
  editFieldRole,
  editFieldTargets,
  editSubjectCriteria,
} from './edits/fields';
import {
  editAddReading,
  editAddRelation,
  editAssessment,
  editPosition,
  editQuestion,
  editQuestionChild,
  editQuote,
  editRelation,
  editSpread,
} from './edits/inquiry';
import { editCardHeld, editCardTemplate, editImage, editImages, editOcclusion } from './edits/cards';
import { editManualType, editTypePresentation } from './edits/tags';
import { editTaskProject, editTaskWork } from './edits/tasks';
import {
  editDeleteRange,
  editHeading,
  editMerge,
  editPaste,
  editPasteBlocks,
  editPasteRows,
  editPositionLinks,
  editReplaceRange,
  editSplit,
  editText,
} from './edits/text';
import {
  editArchive,
  editDelete,
  editIndent,
  editInsert,
  editKeptCopy,
  editMove,
  editMoveTo,
  editOutdent,
} from './edits/structure';
import {
  editCitationTriage,
  editCite,
  editHighlightColor,
  editMergeHighlights,
  editSource,
  editSourceDetails,
  editUncite,
} from './edits/sources';

export interface DocumentHost {
  ready: Promise<void>;
  todayDate(): string;
  commands(pageId: string): PageCommand[];
  loadPage(id: string): Promise<PageView>;
  cachePage(view: PageView): void;
  enqueue(
    doc: Document,
    actions: Action[],
    inverse: Action[],
    before: Caret | null,
    after: Caret | null,
    coalesce: boolean,
  ): PageCommand;
  flushPage(pageId: string): Promise<void>;
  holdTag(pageId: string, blockId: string, typing: boolean): void;
  runningWork(): WorkSession | undefined;
  state(pageId?: string): SaveState;
  message(pageId?: string): string;
  publish(block: Block | null, id?: string): void;
  lookup(id: string): () => Block | null | undefined;
  updateRoot(block: Block | null, id?: string): void;
  release(doc: Document): void;
  retry(): void;
  titleAvailable(title: string, exceptId: string): boolean;
  canRestore(ids: readonly string[]): boolean;
  clipboardScope(): string;
  prepareClipboard(content: BlockClipboard): Promise<BlockClipboard>;
}
type MutableBlockState = { -readonly [K in keyof BlockState]: BlockState[K] } & { history: boolean };
interface Cell {
  state: MutableBlockState;
  set: SetStoreFunction<MutableBlockState>;
}
const stateOf = (block: Block): BlockState => ({
  id: block.id,
  kind: block.kind,
  parentId: block.parent_id,
  pageId: block.page_id,
  text: block.text,
  heading: block.heading,
  archived: block.archived,
  keptCopy: block.kept_copy,
  manual_types: [],
  task: null,
  project: null,
  position: null,
  relation: null,
  question: null,
  quote: null,
  image: null,
  occlusion: null,
  assessment: null,
  mergeProtected: false,
  reviewedCards: false,
  loggedWorkMs: 0,
  source: null,
  citations: [],
  revision: block.revision,
  pending: false,
  conflict: null,
});
export class Document implements PageDocument {
  readonly outline: OutlineIndex;
  readonly baseOutline: OutlineIndex;
  readonly baseBlocks = new Map<string, Block>();
  private baseManualTypes = new Map<string, string[]>();
  readonly baseCapabilities = new Map<string, BlockCapabilities>();
  private work = new Map<string, WorkSession>();
  private cells = new Map<string, Cell>();
  private investigationIds = new Set<string>();
  private presence = new Map<string, Signal<number>>();
  private conflictVersion = createSignal(0);
  /** Archived block ids outside the stores, so visible-row walks avoid a store read per row. */
  private archived = new Set<string>();
  private archiveChange = createSignal(0);
  archivedVersion = this.archiveChange[0];
  private loadStatus = createSignal<'loading' | 'ready' | 'missing' | 'error'>('loading');
  private loadMessage = createSignal('');
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private textCommit: { entry?: HistoryEntry } | undefined;
  private historyCommands = new Map<string, { entry: HistoryEntry; undo: boolean; travel: boolean }>();
  private guardHistories = new Map<string, Set<HistoryEntry>>();
  private historyVersion = createSignal(0);
  private historyNotice = createSignal('');
  private historyPending: Promise<void> | null = null;
  /** Notebook-owned opt-in for a created page's temporary deletion during undo. */
  retainHistoryOnDelete = false;
  historyMessage = this.historyNotice[0];
  private resolving = new Set<string>();
  private conflicts = new Set<string>();
  private lastTextEditAt = 0;
  private closed = false;
  private inFlightReload?: Promise<void>;
  private reloadQueued: { conflicts: boolean } | null = null;
  private reloadLog: {
    acknowledged: {
      command: Command;
      revisions: Map<string, number>;
      rewrites: readonly TextRewrite[];
      receipt?: Committed;
    }[];
    blocks: Block[];
    capabilities: (readonly BlockCapabilities[])[];
    missing: boolean;
  } | null = null;
  holds = 0;
  status = this.loadStatus[0];
  statusMessage = this.loadMessage[0];
  private setStatus(status: 'ready' | 'missing' | 'error', message = '') {
    this.loadStatus[1](status);
    this.loadMessage[1](message);
    if (this.readyWaiters.length) {
      const waiters = this.readyWaiters.splice(0);
      for (const waiter of waiters) {
        if (status === 'ready') waiter.resolve();
        else waiter.reject(new Error(message));
      }
    }
  }
  ready(): Promise<void> {
    const status = this.status();
    if (status === 'ready') return Promise.resolve();
    if (status !== 'loading') return Promise.reject(new Error(this.statusMessage()));
    const waiter = Promise.withResolvers<void>();
    this.readyWaiters.push(waiter);
    return waiter.promise;
  }
  constructor(
    readonly pageId: string,
    private host: DocumentHost,
  ) {
    this.outline = new OutlineIndex(pageId);
    this.baseOutline = new OutlineIndex(pageId);
    void host.ready
      .then(() => {
        if (this.status() === 'loading') return this.reload();
      })
      .catch(error => this.fail(error));
  }
  root() {
    return this.block(this.pageId);
  }
  block(id: string) {
    let presence = this.presence.get(id);
    if (!presence) {
      presence = createSignal(0);
      this.presence.set(id, presence);
    }
    presence[0]();
    return this.cells.get(id)?.state;
  }
  createdAt(id: string) {
    this.block(id);
    return this.baseBlocks.get(id)?.created_at;
  }
  private presenceChanged(id: string) {
    this.presence.get(id)?.[1](value => value + 1);
  }
  /** Page-only renames refresh cached manual labels without rewriting member text. */
  renameManualType(before: string, after: string) {
    const key = titleKey(before);
    for (const [id, titles] of this.baseManualTypes)
      if (titles.some(title => titleKey(title) === key)) {
        this.baseManualTypes.set(
          id,
          titles.map(title => (titleKey(title) === key ? after : title)),
        );
      }
    for (const cell of this.cells.values())
      if (cell.state.manual_types.some(title => titleKey(title) === key)) {
        cell.set(
          'manual_types',
          cell.state.manual_types.map(title => (titleKey(title) === key ? after : title)),
        );
      }
  }
  isArchived(id: string) {
    return this.archived.has(id);
  }
  private markArchived(id: string, archived: boolean) {
    if (this.archived.has(id) === archived) return;
    if (archived) this.archived.add(id);
    else this.archived.delete(id);
    this.archiveChange[1](value => value + 1);
  }
  needsRefresh(blocks: readonly Block[], removed: readonly string[]) {
    if (this.status() !== 'ready') return true;
    return (
      blocks.some(
        block => block.page_id === this.pageId && (this.baseBlocks.get(block.id)?.revision ?? -1) < block.revision,
      ) || removed.some(id => this.cells.has(id))
    );
  }
  saveState() {
    return this.host.state(this.pageId);
  }
  saveMessage() {
    return this.host.message(this.pageId);
  }
  async flush() {
    while (this.historyPending) await this.historyPending;
    await this.host.flushPage(this.pageId);
  }
  holdTag(id: string, typing: boolean) {
    this.host.holdTag(this.pageId, id, typing);
  }
  canUndo() {
    this.historyVersion[0]();
    return this.status() === 'ready' && !this.historyPending && this.undoStack.length > 0;
  }
  canRedo() {
    this.historyVersion[0]();
    return this.status() === 'ready' && !this.historyPending && this.redoStack.length > 0;
  }
  release() {
    this.host.release(this);
  }
  reload(conflicts = true) {
    if (this.inFlightReload) {
      this.reloadQueued = { conflicts: (this.reloadQueued?.conflicts ?? false) || conflicts };
      return this.inFlightReload;
    }
    const work = this.runReload(conflicts).finally(() => {
      if (this.inFlightReload === work) this.inFlightReload = undefined;
    });
    this.inFlightReload = work;
    return work;
  }
  private async runReload(initialConflicts: boolean) {
    let conflicts = initialConflicts;
    let structuralRetries = 0;
    try {
      while (!this.closed) {
        this.reloadQueued = null;
        const log: NonNullable<Document['reloadLog']> = {
          acknowledged: [],
          blocks: [],
          capabilities: [],
          missing: false,
        };
        this.reloadLog = log;
        let view: PageView;
        try {
          view = await this.host.loadPage(this.pageId);
        } finally {
          if (this.reloadLog === log) this.reloadLog = null;
        }
        if (this.closed || log.missing) return;
        if (this.reconcileReloadLog(view, log) === 'retry' && structuralRetries < 2) {
          structuralRetries++;
          continue;
        }
        this.merge(view, conflicts);
        for (const values of log.capabilities) this.receiveCapabilities(values);
        const next = this.reloadQueued as { conflicts: boolean } | null;
        if (!next) return;
        conflicts = next.conflicts;
        structuralRetries = 0;
      }
    } catch (error) {
      if (!this.closed && (this.status() !== 'ready' || (error instanceof ApiError && error.status === 404)))
        this.fail(error);
    }
  }
  private reconcileReloadLog(view: PageView, log: NonNullable<Document['reloadLog']>): 'ok' | 'retry' {
    const byId = new Map<string, Block>([
      [view.root.id, view.root],
      ...view.rows.map(row => [row.block.id, row.block] as const),
    ]);
    for (const entry of log.acknowledged) {
      const deleted = new Set([...(entry.command.deleted ?? []), ...(entry.receipt?.removed ?? [])]);
      let covered = true;
      for (const id of deleted) if (byId.has(id)) covered = false;
      if (covered)
        for (const [id, revision] of entry.revisions) {
          if (deleted.has(id)) continue;
          const incoming = byId.get(id);
          if (incoming && incoming.revision < revision) {
            covered = false;
            break;
          }
          if (
            !incoming &&
            entry.command.actions.some(
              action => (action.kind === 'insert' || action.kind === 'split') && action.block.id === id,
            )
          ) {
            covered = false;
            break;
          }
        }
      if (covered) continue;
      if (
        entry.command.actions.some(action =>
          ['insert', 'split', 'merge', 'move', 'delete', 'restore', 'addType', 'removeType'].includes(action.kind),
        )
      )
        return 'retry';
      for (const action of entry.command.actions) {
        const incoming = 'id' in action ? byId.get(action.id) : undefined;
        if (!incoming) continue;
        const acknowledgedRevision = entry.revisions.get(incoming.id);
        if (acknowledgedRevision !== undefined && incoming.revision >= acknowledgedRevision) continue;
        if (action.kind === 'text') incoming.text = action.text;
        else if (action.kind === 'heading') incoming.heading = action.heading;
        else if (action.kind === 'archive') incoming.archived = action.archived;
        else if (action.kind === 'settleSyncCopy') incoming.kept_copy = action.settled ? null : action.copy;
      }
      for (const rewrite of entry.rewrites) {
        const incoming = byId.get(rewrite.id);
        if (incoming && incoming.revision <= rewrite.revision) {
          incoming.text = rewrite.after;
          incoming.revision = rewrite.revision;
        }
      }
      for (const [id, revision] of entry.revisions) {
        const incoming = byId.get(id);
        if (incoming && incoming.revision < revision) incoming.revision = revision;
      }
      if (entry.receipt?.capabilities?.length) log.capabilities.push(entry.receipt.capabilities);
    }
    for (const block of log.blocks) {
      const incoming = byId.get(block.id);
      if (!incoming) return 'retry';
      if (incoming.revision < block.revision) Object.assign(incoming, block);
    }
    return 'ok';
  }
  close() {
    this.closed = true;
  }
  markMissing(message = 'This atom has been deleted.') {
    if (this.reloadLog) this.reloadLog.missing = true;
    batch(() => {
      const ids = [...this.cells.keys()];
      this.cells.clear();
      this.baseBlocks.clear();
      this.baseManualTypes.clear();
      this.baseCapabilities.clear();
      this.investigationIds.clear();
      this.work.clear();
      this.archived.clear();
      this.archiveChange[1](value => value + 1);
      this.outline.replace([]);
      this.baseOutline.replace([]);
      this.conflicts.clear();
      this.resolving.clear();
      this.conflictVersion[1](value => value + 1);
      if (!this.retainHistoryOnDelete) {
        this.undoStack = [];
        this.redoStack = [];
        this.historyCommands.clear();
        this.guardHistories.clear();
      }
      this.historyVersion[1](value => value + 1);
      for (const id of ids) this.presenceChanged(id);
      this.host.publish(null, this.pageId);
      this.host.updateRoot(null, this.pageId);
      this.setStatus('missing', message);
    });
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ApiError && error.status === 404) this.markMissing(message);
    else this.setStatus('error', message);
  }
  isResolving(id: string) {
    return this.resolving.has(id);
  }
  private put(
    block: Block,
    pending = false,
    manual_types = this.cells.get(block.id)?.state.manual_types ?? this.baseManualTypes.get(block.id) ?? [],
    capability = this.capabilities(block.id),
  ) {
    const cell = this.cells.get(block.id);
    const sidecar = {
      task: capability.task,
      project: capability.project,
      position: capability.position ?? null,
      relation: capability.relation ?? null,
      spread: capability.spread ?? false,
      question: capability.question ?? null,
      quote: capability.quote ?? null,
      assessment: capability.assessment ?? null,
      source: capability.source ?? null,
      citations: capability.citations ?? [],
      history: capability.history,
      mergeProtected: capability.merge_protected,
      reviewedCards: capability.reviewed_cards,
      loggedWorkMs: capability.logged_work_ms ?? 0,
      templateCards: capability.template_cards ?? 0,
    };
    const image = capability.image ?? null;
    this.trackInvestigation(capability);
    this.markArchived(block.id, block.archived);
    if (cell)
      cell.set({
        ...stateOf(block),
        ...sidecar,
        image,
        occlusion: capability.occlusion ?? null,
        manual_types,
        pending,
        conflict: cell.state.conflict,
      });
    else {
      const [state, set] = createStore<MutableBlockState>({
        ...stateOf(block),
        ...sidecar,
        image,
        occlusion: capability.occlusion ?? null,
        manual_types,
        pending,
      });
      this.cells.set(block.id, { state, set });
      this.presenceChanged(block.id);
    }
    this.host.publish(block);
  }
  snapshot(id: string, base = false): Block {
    if (base) {
      const block = this.baseBlocks.get(id);
      if (!block) throw new Error('The atom no longer exists.');
      return { ...block };
    }
    const state = this.cells.get(id)?.state;
    if (!state) throw new Error('The atom no longer exists.');
    const saved = this.baseBlocks.get(id);
    return {
      id,
      kind: state.kind,
      parent_id: state.parentId,
      page_id: state.pageId,
      text: state.text,
      heading: state.heading,
      archived: state.archived,
      kept_copy: state.keptCopy ? { ...state.keptCopy } : null,
      revision: state.revision,
      created_at: saved?.created_at ?? Date.now(),
      updated_at: saved?.updated_at ?? Date.now(),
    };
  }
  private changed(id: string, patch: Partial<Block>, base: boolean) {
    const block = { ...this.snapshot(id, base), ...patch };
    if (base) this.baseBlocks.set(id, block);
    else {
      this.put(block, true);
      if (block.kind !== 'block') this.host.updateRoot(block);
    }
  }
  capabilities(id: string, base = false): BlockCapabilities {
    const cell = !base && this.cells.get(id)?.state;
    const value = cell
      ? {
          block_id: id,
          built_in_tag: this.baseCapabilities.get(id)?.built_in_tag ?? false,
          task: cell.task,
          project: cell.project,
          position: cell.position,
          relation: cell.relation,
          spread: cell.spread ?? false,
          question: cell.question,
          quote: cell.quote,
          image: cell.image,
          occlusion: cell.occlusion,
          assessment: cell.assessment,
          source: cell.source,
          citations: cell.citations,
          history: cell.history,
          merge_protected: cell.mergeProtected,
          reviewed_cards: cell.reviewedCards,
          logged_work_ms: cell.loggedWorkMs,
          template_cards: cell.templateCards ?? 0,
        }
      : this.baseCapabilities.get(id);
    // Most blocks have no capabilities; a fresh empty value needs no defensive copy.
    return value ? (JSON.parse(JSON.stringify(value)) as BlockCapabilities) : emptyCapabilities(id);
  }
  clipboard(ids: readonly string[], cut = false): BlockClipboard {
    const selected = new Set(ids);
    const roots = [...selected]
      .filter(id => {
        if (this.outline.indexOf(id) < 0) return false;
        let parent = this.outline.parentOf(id);
        while (parent !== this.pageId) {
          if (selected.has(parent)) return false;
          parent = this.outline.parentOf(parent);
        }
        return true;
      })
      .sort((left, right) => this.outline.indexOf(left) - this.outline.indexOf(right));
    return {
      version: 1,
      scope: this.host.clipboardScope(),
      cut,
      blocks: roots.flatMap(id => {
        const at = this.outline.indexOf(id);
        const depth = this.outline.depth(id);
        return this.outline.slice(at, this.outline.subtreeEnd(at)).map(row => ({
          block: this.snapshot(row.id),
          depth: row.depth - depth,
          manualTypes: [...this.block(row.id)!.manual_types],
          capabilities: this.capabilities(row.id),
        }));
      }),
    };
  }
  prepareClipboard(content: BlockClipboard) {
    return this.host.prepareClipboard(content);
  }
  private trackInvestigation(value: BlockCapabilities) {
    if (value.question || value.assessment) this.investigationIds.add(value.block_id);
    else this.investigationIds.delete(value.block_id);
  }
  private updateCapabilities(value: BlockCapabilities, base: boolean) {
    value.merge_protected =
      value.task !== null ||
      value.project !== null ||
      Boolean(value.image || value.position || value.relation || value.spread || value.question || value.assessment) ||
      value.history ||
      value.reviewed_cards;
    if (!base) this.trackInvestigation(value);
    if (base) this.baseCapabilities.set(value.block_id, value);
    else
      this.cells.get(value.block_id)?.set({
        task: value.task,
        project: value.project,
        position: value.position ?? null,
        relation: value.relation ?? null,
        spread: value.spread ?? false,
        question: value.question ?? null,
        quote: value.quote ?? null,
        assessment: value.assessment ?? null,
        source: value.source ?? null,
        citations: value.citations ?? [],
        history: value.history,
        mergeProtected: value.merge_protected,
        reviewedCards: value.reviewed_cards,
        loggedWorkMs: value.logged_work_ms ?? 0,
        templateCards: value.template_cards ?? 0,
        pending: true,
      });
    if (!base) this.cells.get(value.block_id)?.set({ image: value.image ?? null, occlusion: value.occlusion ?? null });
  }
  private guardMerge(id: string) {
    const value = this.capabilities(id);
    if (value.image) throw new Error("Image atoms can't be merged.");
    if (value.merge_protected)
      throw new Error(
        value.history
          ? 'This task has completion or work history; delete it or keep it separate.'
          : 'Cannot merge away an active task, project, perspective, argument, question, answer, or reviewed card.',
      );
  }
  receiveCardRevisions(cards: NonNullable<Committed['cards']>) {
    if (!cards.length) return;
    const revisions = new Map(cards.map(card => [card.id, card.revision]));
    const actions = [
      ...this.host
        .commands(this.pageId)
        .filter(command => !command.frozen)
        .flatMap(command => [...command.actions, ...command.inverse]),
      ...[...this.undoStack, ...this.redoStack].flatMap(entry => [...entry.forward, ...entry.inverse]),
    ];
    for (const action of actions)
      if (action.kind === 'cardHeld' && revisions.has(action.id)) {
        action.baseRevision = revisions.get(action.id)!;
      }
  }
  receiveCapabilities(values: readonly BlockCapabilities[]) {
    if (this.reloadLog && values.length) this.reloadLog.capabilities.push(values);
    const received = new Set<string>();
    for (const value of values) {
      if (!this.baseBlocks.has(value.block_id) && !this.cells.has(value.block_id)) continue;
      this.baseCapabilities.set(value.block_id, structuredClone(value));
      this.cells.get(value.block_id)?.set({
        task: value.task,
        project: value.project,
        position: value.position ?? null,
        relation: value.relation ?? null,
        spread: value.spread ?? false,
        question: value.question ?? null,
        quote: value.quote ?? null,
        assessment: value.assessment ?? null,
        source: value.source ?? null,
        citations: value.citations ?? [],
        history: value.history,
        mergeProtected: value.merge_protected,
        reviewedCards: value.reviewed_cards,
        loggedWorkMs: value.logged_work_ms ?? 0,
        templateCards: value.template_cards ?? 0,
      });
      this.cells.get(value.block_id)?.set({ image: value.image ?? null, occlusion: value.occlusion ?? null });
      this.trackInvestigation(value);
      received.add(value.block_id);
    }
    for (const command of this.host.commands(this.pageId))
      for (const action of command.actions) {
        if (
          isCapabilityAction(action) &&
          (received.has(action.id) || action.kind === 'question' || action.kind === 'assessment')
        )
          this.apply(action);
      }
    if (received.size && this.investigationIds.size) this.refreshInvestigations(false);
  }
  private guardHide(id: string) {
    const known = this.host.runningWork();
    const pendingSessions = new Set<string>();
    for (const command of this.host.commands(this.pageId))
      for (const action of command.actions)
        if (isCapabilityAction(action) && 'session' in action) pendingSessions.add(action.session.id);
    const active =
      [...this.work.values()].find(
        session => pendingSessions.has(session.id) && !session.reversed && session.ended_at === null,
      ) ?? (known && !pendingSessions.has(known.id) ? known : undefined);
    if (!active) return;
    let parent: string | null = active.block_id;
    while (parent) {
      if (parent === id) throw new Error('Stop work before hiding this task.');
      parent = this.block(parent)?.parentId ?? null;
    }
  }
  private refreshInvestigations(base: boolean) {
    const values = base
      ? [...this.baseCapabilities.values()].filter(value => value.question || value.assessment)
      : [...this.investigationIds].filter(id => this.cells.has(id)).map(id => this.capabilities(id));
    const byId = new Map(values.map(value => [value.block_id, value]));
    const parent = (id: string) => (base ? this.baseBlocks.get(id)?.parent_id : this.cells.get(id)?.state.parentId);
    const visible = (id: string) => {
      for (let current: string | null | undefined = id; current; current = parent(current)) {
        const block = base ? this.baseBlocks.get(current) : this.cells.get(current)?.state;
        if (!block || block.archived) return false;
      }
      return true;
    };
    for (const value of values)
      if (value.assessment) {
        let questionId: string | null = null;
        for (let id = parent(value.block_id); id; id = parent(id)) {
          if (byId.get(id)?.question) {
            questionId = id;
            break;
          }
        }
        value.assessment.question_id = questionId;
        value.assessment.accepted =
          visible(value.block_id) &&
          questionId !== null &&
          byId.get(questionId)?.question?.state.accepted === value.block_id;
      }
    for (const value of values) {
      if (value.question) {
        const answer = value.question.state.accepted ? byId.get(value.question.state.accepted)?.assessment : null;
        value.question.status = questionStatus(
          value.question.state,
          Boolean(answer?.accepted && answer.question_id === value.block_id),
        );
        const explicit = value.question.state.parent;
        const local = explicit ? byId.get(explicit)?.question : null;
        // A remote parent is authoritative in server hydration; local parents
        // can be recomputed immediately for undo and capability removal.
        const remote =
          explicit &&
          !this.cells.has(explicit) &&
          !this.baseBlocks.has(explicit) &&
          value.question.parent_explicit &&
          value.question.parent_id === explicit;
        value.question.parent_explicit = Boolean(local || remote);
        value.question.parent_id = local || remote ? explicit! : null;
        if (!value.question.parent_id)
          for (let id = parent(value.block_id); id; id = parent(id)) {
            if (byId.get(id)?.question) {
              value.question.parent_id = id;
              break;
            }
          }
      }
      const current = this.cells.get(value.block_id)?.state;
      if (base || !sameState(current?.question, value.question) || !sameState(current?.assessment, value.assessment))
        this.updateCapabilities(value, base);
    }
  }
  /** Applies only touched blocks/subtrees; inverse size follows the edit, not the page. */
  apply(action: Action, base = false): Action[] {
    const inverse = this.applyAction(action, base);
    if (['question', 'assessment', 'move', 'archive', 'delete', 'restore', 'merge'].includes(action.kind))
      this.refreshInvestigations(base);
    return inverse;
  }
  private applyAction(action: Action, base = false): Action[] {
    const index = base ? this.baseOutline : this.outline;
    switch (action.kind) {
      case 'restoreTag':
        // The target belongs to another page; its receipt refreshes the shared lookup.
        // Restoration claims it, so a later undo removes only this atom's membership.
        return [];
      case 'cardHeld':
        return [{ ...action, value: action.previous, previous: action.value }];
      case 'cardTemplate':
        return [{ ...action, value: action.previous, previous: action.value }];
      case 'task':
      case 'project': {
        const value = this.capabilities(action.id, base);
        const previous = value[action.kind];
        if (action.kind === 'task') value.task = action.value;
        else value.project = action.value;
        this.updateCapabilities(value, base);
        return [
          action.kind === 'task'
            ? {
                ...action,
                value: previous as typeof action.value,
                previous: action.value,
                restore: previous?.status === 'done' && action.value !== null && action.value.status !== 'done',
              }
            : { ...action, value: previous as typeof action.value, previous: action.value },
        ];
      }
      case 'position': {
        const value = this.capabilities(action.id, base);
        const previous = !!value.position;
        value.position = action.value ? { holder_id: null, subject_id: this.pageId } : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'relation': {
        const value = this.capabilities(action.id, base);
        const previous = value.relation?.kind ?? null;
        let source = this.pageId,
          question: string | null = null;
        for (
          let parent = this.snapshot(action.id, base).parent_id;
          parent;
          parent = this.snapshot(parent, base).parent_id
        ) {
          const ancestor = this.capabilities(parent, base);
          if (ancestor.position || ancestor.assessment) {
            source = parent;
            break;
          }
          if (ancestor.question) question ??= parent;
        }
        if (source === this.pageId && question) source = question;
        const first = textTokens(this.snapshot(action.id, base).text).find(token => token.kind === 'reference');
        const target = first && isStableReference(first) ? first.id! : null;
        value.relation = action.value
          ? { kind: action.value, source_id: source, target_id: target, problem: target ? null : 'Choose a target.' }
          : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'spread': {
        const value = this.capabilities(action.id, base);
        const previous = !!value.spread;
        value.spread = action.value;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'question': {
        const value = this.capabilities(action.id, base);
        const previous = value.question?.state ?? null;
        value.question = action.value
          ? {
              state: action.value,
              status: questionStatus(action.value, false),
              parent_id: value.question?.parent_id ?? null,
              parent_explicit: value.question?.parent_explicit ?? false,
            }
          : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'quote': {
        const value = this.capabilities(action.id, base);
        const previous = value.quote ?? null;
        value.quote = action.value;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'image': {
        const value = this.capabilities(action.id, base);
        const previous = value.image ?? null;
        value.image = action.value;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'occlusion': {
        const value = this.capabilities(action.id, base);
        const previous = value.occlusion ?? null;
        value.occlusion = action.value;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'assessment': {
        const value = this.capabilities(action.id, base);
        const previous = value.assessment?.state ?? null;
        value.assessment = action.value ? { state: action.value, question_id: null, accepted: false } : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'source': {
        const value = this.capabilities(action.id, base);
        const previous = sourceState(value.source);
        value.source = action.value
          ? {
              block_id: action.id,
              added_at: Date.now(),
              state_changed_at: Date.now(),
              last_read_at: null,
              current_snapshot_id: null,
              siglum: '?',
              siglum_basis: '?',
              siglum_authored: false,
              siglum_disambiguation: null,
              ...value.source,
              ...action.value,
            }
          : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'cite': {
        const value = this.capabilities(action.id, base);
        const citations = value.citations ?? [];
        if (citations.some(citation => citation.id === action.citation.id)) return [];
        citations.splice(action.index ?? citations.length, 0, action.citation);
        value.citations = citations;
        this.updateCapabilities(value, base);
        return [{ kind: 'uncite', id: action.id, citationId: action.citation.id, baseRevision: action.baseRevision }];
      }
      case 'uncite': {
        const value = this.capabilities(action.id, base);
        const index = value.citations?.findIndex(citation => citation.id === action.citationId) ?? -1;
        if (index < 0) return [];
        const [citation] = value.citations!.splice(index, 1);
        this.updateCapabilities(value, base);
        return [{ kind: 'cite', id: action.id, citation: citation!, index, baseRevision: action.baseRevision }];
      }
      case 'citationRange': {
        const value = this.capabilities(action.id, base);
        const index = value.citations?.findIndex(item => item.id === action.citation.id) ?? -1;
        if (index < 0) throw new Error('Citation not found.');
        const previous = value.citations![index]!;
        value.citations![index] = action.citation;
        this.updateCapabilities(value, base);
        return [{ ...action, citation: previous, previous: action.citation }];
      }
      case 'citationTriage': {
        const value = this.capabilities(action.id, base);
        const citation = value.citations?.find(item => item.id === action.citationId);
        if (!citation) return [];
        const previous = citation.triage;
        citation.triage = action.triage;
        this.updateCapabilities(value, base);
        return [{ ...action, triage: previous, previous: action.triage }];
      }
      case 'highlightColor': {
        const value = this.capabilities(action.id, base);
        const citation = value.citations?.find(item => item.id === action.citationId);
        if (!citation) return [];
        const previous = citation.color;
        citation.color = action.color;
        this.updateCapabilities(value, base);
        return [{ ...action, color: previous, previous: action.color }];
      }
      case 'completeTask': {
        const value = this.capabilities(action.id, base);
        // Recurrence is authoritative server state, never a second client calendar.
        const completed = action.previous.repeater
          ? action.previous
          : { ...action.previous, status: 'done' as const, completed_on: action.completedOn };
        value.task = completed;
        value.history = true;
        this.updateCapabilities(value, base);
        return [
          {
            kind: 'reverseTaskCompletion',
            id: action.id,
            occurrenceId: action.occurrenceId,
            completedOn: action.completedOn,
            value: action.previous,
            previous: completed,
            baseRevision: action.baseRevision,
          },
        ];
      }
      case 'reverseTaskCompletion': {
        const value = this.capabilities(action.id, base);
        value.task = action.value;
        // Other occurrences or work may remain; only the server can clear history.
        this.updateCapabilities(value, base);
        return [
          {
            kind: 'completeTask',
            id: action.id,
            occurrenceId: ulid(),
            completedOn: action.completedOn,
            previous: action.value,
            baseRevision: action.baseRevision,
          },
        ];
      }
      case 'startWork':
      case 'stopWork':
      case 'workNote':
      case 'workState': {
        const old = action.session;
        const value =
          action.kind === 'startWork'
            ? old
            : action.kind === 'workNote'
              ? { ...old, note: action.note }
              : action.kind === 'stopWork'
                ? { ...old, ended_at: action.endedAt, note: action.note }
                : { ...old, ended_at: action.endedAt, reversed: action.reversed };
        const capability = this.capabilities(action.id, base);
        if (!value.reversed) capability.history = true;
        this.updateCapabilities(capability, base);
        if (!base) this.work.set(old.id, value);
        if (action.kind === 'workNote') return [{ ...action, session: value, note: old.note }];
        const inverse: Action[] = [
          {
            kind: 'workState',
            id: action.id,
            session: value,
            endedAt: old.ended_at,
            reversed: action.kind === 'startWork' ? true : old.reversed,
            baseRevision: action.baseRevision,
          },
        ];
        if (action.kind === 'stopWork' && old.note !== action.note)
          inverse.push({
            kind: 'workNote',
            id: action.id,
            session: value,
            note: old.note,
            baseRevision: action.baseRevision,
          });
        return inverse;
      }
      case 'split': {
        const inverse = this.apply({ kind: 'text', id: action.id, text: action.left }, base);
        return [...this.apply({ kind: 'insert', block: action.block, after: action.id }, base), ...inverse];
      }
      case 'merge': {
        const inverse = this.apply({ kind: 'text', id: action.destinationId, text: action.text }, base);
        let after = index.children(action.destinationId).at(-1) ?? null;
        for (const id of [...index.children(action.id)]) {
          inverse.unshift(...this.apply({ kind: 'move', id, parentId: action.destinationId, after }, base));
          after = id;
        }
        inverse.unshift(...this.apply({ kind: 'delete', id: action.id }, base));
        return inverse;
      }
      case 'settleSyncCopy': {
        this.changed(action.id, { kept_copy: action.settled ? null : action.copy }, base);
        return [{ ...action, settled: !action.settled }];
      }
      case 'text': {
        const old = this.snapshot(action.id, base).text;
        action.expectedText ??= old;
        this.changed(action.id, { text: action.text }, base);
        return [
          { kind: 'text', id: action.id, text: old, expectedText: action.text, baseRevision: action.baseRevision },
        ];
      }
      case 'heading': {
        const old = this.snapshot(action.id, base).heading;
        this.changed(action.id, { heading: action.heading }, base);
        return [{ kind: 'heading', id: action.id, heading: old }];
      }
      case 'archive': {
        if (!base && action.archived) this.guardHide(action.id);
        const old = this.snapshot(action.id, base).archived;
        this.changed(action.id, { archived: action.archived }, base);
        return [{ kind: 'archive', id: action.id, archived: old }];
      }
      case 'fieldKind':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldKind', id: action.id, value: action.previous, previous: action.value }];
      case 'fieldHide':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldHide', id: action.id, value: action.previous, previous: action.value }];
      case 'fieldRole':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldRole', id: action.id, value: action.previous, previous: action.value }];
      case 'fieldCountsAs':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldCountsAs', id: action.id, value: action.previous, previous: action.value }];
      case 'fieldTargets':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldTargets', id: action.id, targets: action.previous, previous: action.targets }];
      case 'subjectCriteria':
        this.changed(action.id, {}, base);
        return [{ kind: 'subjectCriteria', id: action.id, fields: action.previous, previous: action.fields }];
      case 'typePresentation':
        this.changed(action.id, {}, base);
        return [{ kind: 'typePresentation', id: action.id, value: action.previous, previous: action.value }];
      case 'addType':
      case 'removeType': {
        this.snapshot(action.id, base);
        const previous = base
          ? (this.baseManualTypes.get(action.id) ?? [])
          : this.cells.get(action.id)!.state.manual_types;
        const key = titleKey(action.title);
        const old = previous.find(title => titleKey(title) === key);
        const titles =
          action.kind === 'addType'
            ? old === undefined
              ? [...previous, action.title]
              : [...previous]
            : previous.filter(title => titleKey(title) !== key);
        if (base) this.baseManualTypes.set(action.id, titles);
        else this.cells.get(action.id)!.set({ manual_types: titles, pending: true });
        return old === undefined
          ? action.kind === 'addType'
            ? [{ kind: 'removeType', id: action.id, title: action.title }]
            : []
          : action.kind === 'removeType'
            ? [{ kind: 'addType', id: action.id, title: old }]
            : [];
      }
      case 'insert': {
        const block = { ...action.block };
        if (block.parent_id && index.indexOf(block.id) >= 0) {
          if (!base) this.put({ ...(this.baseBlocks.get(block.id) ?? block), text: block.text }, true);
          return [{ kind: 'delete', id: block.id }];
        }
        if (base) this.baseBlocks.set(block.id, block);
        else this.put(block, true);
        if (block.parent_id) {
          const depth = block.parent_id === this.pageId ? 0 : index.depth(block.parent_id) + 1;
          const at = action.after
            ? index.subtreeEnd(index.indexOf(action.after))
            : block.parent_id === this.pageId
              ? 0
              : index.indexOf(block.parent_id) + 1;
          index.splice(at, 0, [{ id: block.id, parentId: block.parent_id, depth }]);
        }
        return [{ kind: 'delete', id: block.id }];
      }
      case 'delete': {
        if (!base) this.guardHide(action.id);
        const at = index.indexOf(action.id);
        const rows =
          action.id === this.pageId
            ? index.slice(0, index.size())
            : at < 0
              ? []
              : index.slice(at, index.subtreeEnd(at));
        const after = at < 0 ? null : index.previousSibling(action.id);
        const snapshots: Snapshot[] = rows.map(row => ({
          row,
          block: this.snapshot(row.id, base),
          manual_types: [
            ...(base ? (this.baseManualTypes.get(row.id) ?? []) : this.cells.get(row.id)!.state.manual_types),
          ],
          capabilities: this.capabilities(row.id, base),
        }));
        if (action.id === this.pageId)
          snapshots.unshift({
            row: null,
            block: this.snapshot(action.id, base),
            manual_types: [],
            capabilities: this.capabilities(action.id, base),
          });
        if (at >= 0) index.splice(at, rows.length, []);
        else if (action.id === this.pageId) index.replace([]);
        if (!base)
          for (const snapshot of snapshots) {
            this.cells.delete(snapshot.block.id);
            this.conflicts.delete(snapshot.block.id);
            this.investigationIds.delete(snapshot.block.id);
            this.presenceChanged(snapshot.block.id);
            this.host.publish(null, snapshot.block.id);
          }
        if (!base) this.conflictVersion[1](value => value + 1);
        if (!base && action.id === this.pageId) this.host.updateRoot(null, this.pageId);
        return [{ kind: 'restore', id: action.id, snapshots, after }];
      }
      case 'restore': {
        const depths = new Map<string, number>();
        const rows = action.snapshots.flatMap(snapshot => {
          if (!snapshot.row) return [];
          const parent = snapshot.row.parentId;
          const depth = parent === this.pageId ? 0 : (depths.get(parent) ?? index.depth(parent)) + 1;
          depths.set(snapshot.block.id, depth);
          snapshot.row = { ...snapshot.row, depth };
          return index.indexOf(snapshot.block.id) < 0 ? [{ ...snapshot.row }] : [];
        });
        for (const { block, manual_types, capabilities } of action.snapshots) {
          if (base) {
            this.baseBlocks.set(block.id, { ...block });
            this.baseManualTypes.set(block.id, manual_types);
            this.baseCapabilities.set(block.id, capabilities ?? emptyCapabilities(block.id));
          } else this.put(block, true, manual_types, capabilities ?? emptyCapabilities(block.id));
          if (!base && block.kind !== 'block') this.host.updateRoot(block);
        }
        if (rows.length) {
          const parent = rows[0]!.parentId;
          const at =
            action.after && index.indexOf(action.after) >= 0
              ? index.subtreeEnd(index.indexOf(action.after))
              : parent === this.pageId
                ? 0
                : index.indexOf(parent) + 1;
          index.splice(at, 0, rows);
        }
        if (!base && action.id === this.pageId) {
          this.setStatus('ready');
        }
        return [{ kind: 'delete', id: action.id }];
      }
      case 'move': {
        if (index.indexOf(action.id) < 0) throw new Error('The atom to move no longer exists.');
        if (!base)
          for (
            let ancestor: string | null = action.parentId;
            ancestor;
            ancestor = this.block(ancestor)?.parentId ?? null
          )
            if (this.block(ancestor)?.archived) {
              this.guardHide(action.id);
              break;
            }
        const inverse: Action = {
          kind: 'move',
          id: action.id,
          parentId: index.parentOf(action.id),
          after: index.previousSibling(action.id),
        };
        const after = action.after && index.parentOf(action.after) === action.parentId ? action.after : null;
        if (inverse.parentId === action.parentId && inverse.after === after) return [];
        index.move(action.id, action.parentId, after);
        this.changed(action.id, { parent_id: action.parentId }, base);
        return [inverse];
      }
    }
  }
  merge(view: PageView, detectConflicts = true) {
    if (this.closed) return;
    this.host.cachePage(view);
    const conflicts = new Map<string, BlockState['conflict']>();
    const pendingText = this.pendingText();
    const pending = this.host.commands(this.pageId);
    const latestText = new Map<string, string>();
    const originalText = new Map<string, string>();
    const sentText = new Map<string, Set<string>>();
    for (const command of pending) {
      for (const action of command.actions) {
        if (action.kind === 'text') {
          latestText.set(action.id, action.text);
          if (command.frozen) {
            const versions = sentText.get(action.id) ?? new Set<string>();
            versions.add(action.text);
            sentText.set(action.id, versions);
          }
        }
        if (action.kind === 'insert' || action.kind === 'split') {
          latestText.set(action.block.id, action.block.text);
          if (!originalText.has(action.block.id)) originalText.set(action.block.id, action.block.text);
        }
        if (action.kind === 'split') latestText.set(action.id, action.left);
        if (action.kind === 'merge') latestText.set(action.destinationId, action.text);
      }
      for (const action of command.inverse)
        if (action.kind === 'text' && !originalText.has(action.id)) originalText.set(action.id, action.text);
    }
    for (const incoming of [view.root, ...view.rows.map(row => row.block)]) {
      const local = this.block(incoming.id);
      const old = this.baseBlocks.get(incoming.id);
      const expected = originalText.get(incoming.id) ?? old?.text;
      const localText = local?.text ?? latestText.get(incoming.id);
      // A reload can read an earlier own write before its delayed receipt. Replay its frozen request
      // before the continuation; the intermediate server text is not another author's conflicting edit.
      const ownWrite = sentText.get(incoming.id)?.has(incoming.text);
      if (local?.conflict && !ownWrite) conflicts.set(incoming.id, local.conflict);
      if (
        detectConflicts &&
        !ownWrite &&
        pendingText.has(incoming.id) &&
        expected !== undefined &&
        expected !== incoming.text &&
        localText !== incoming.text
      ) {
        conflicts.set(incoming.id, { remoteText: incoming.text, remoteRevision: incoming.revision });
      }
    }
    batch(() => {
      this.baseBlocks.clear();
      this.baseManualTypes.clear();
      this.baseCapabilities.clear();
      for (const value of view.capabilities ?? []) this.baseCapabilities.set(value.block_id, structuredClone(value));
      for (const row of view.rows) this.baseManualTypes.set(row.block.id, row.manual_types);
      this.baseManualTypes.set(view.root.id, view.root_manual_types ?? []);
      for (const block of [view.root, ...view.rows.map(row => row.block)]) this.baseBlocks.set(block.id, { ...block });
      const rows = view.rows.map(({ block, depth }) => ({ id: block.id, parentId: block.parent_id!, depth }));
      this.baseOutline.replace(rows);
      for (const id of this.cells.keys())
        if (!this.baseBlocks.has(id)) {
          this.cells.delete(id);
          this.presenceChanged(id);
        }
      for (const block of this.baseBlocks.values())
        this.put(block, false, this.baseManualTypes.get(block.id) ?? [], this.capabilities(block.id, true));
      this.outline.replace(rows);
      for (const command of this.host.commands(this.pageId)) {
        for (const action of command.actions) {
          try {
            this.apply(action);
          } catch (error) {
            command.failed = `A structural change could not be applied: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
      this.conflicts.clear();
      for (const [id, conflict] of conflicts) {
        this.cells.get(id)?.set('conflict', conflict);
        if (conflict && this.cells.has(id)) this.conflicts.add(id);
      }
      for (const command of this.host.commands(this.pageId)) {
        command.resolutions = command.resolutions?.filter(choice => {
          const cell = this.cells.get(choice.id);
          if (!cell || (cell.state.conflict?.remoteRevision ?? cell.state.revision) > choice.remoteRevision) {
            if (cell) cell.set('text', choice.localText);
            this.resolving.delete(choice.id);
            return false;
          }
          const remote = this.baseBlocks.get(choice.id);
          if (remote && choice.localText !== remote.text) {
            cell.set('conflict', { remoteText: remote.text, remoteRevision: remote.revision });
            this.conflicts.add(choice.id);
          }
          const following = this.host.commands(this.pageId).slice(this.host.commands(this.pageId).indexOf(command) + 1);
          if (!following.some(item => item.actions.some(action => action.kind === 'text' && action.id === choice.id)))
            cell.set('text', choice.localText);
          this.resolving.add(choice.id);
          return true;
        });
      }
      // put() wrote every saved cell above; only local commands, conflicts and resolutions can differ from it.
      this.refreshPending(new Set([...this.pendingIds(), ...this.conflicts, ...this.resolving]));
      this.conflictVersion[1](value => value + 1);
      this.setStatus('ready');
    });
    for (const target of view.targets) this.host.publish(target);
    this.host.cachePage(view);
  }
  pendingText() {
    const ids = new Set<string>();
    for (const command of this.host.commands(this.pageId))
      for (const action of command.actions) {
        if (action.kind === 'text') ids.add(action.id);
        else if (action.kind === 'split') {
          ids.add(action.id);
          ids.add(action.block.id);
        } else if (action.kind === 'merge') ids.add(action.destinationId);
        else if (action.kind === 'insert') ids.add(action.block.id);
      }
    return ids;
  }
  hasConflict() {
    this.conflictVersion[0]();
    return this.conflicts.size > 0;
  }
  receive(block: Block) {
    if (this.reloadLog) this.reloadLog.blocks.push({ ...block });
    const previous = this.baseBlocks.get(block.id);
    const cell = this.cells.get(block.id);
    if (!previous && !cell) {
      return;
    }
    if (previous && block.revision <= previous.revision) {
      if (cell) this.host.publish(this.snapshot(block.id));
      return;
    }
    this.baseBlocks.set(block.id, { ...block });
    if (!cell) return;
    const commands = this.host.commands(this.pageId);
    const pending = commands.some(command =>
      command.actions.some(action =>
        action.kind === 'insert'
          ? action.block.id === block.id
          : action.kind === 'split'
            ? action.id === block.id || action.block.id === block.id
            : action.kind === 'merge'
              ? action.id === block.id || action.destinationId === block.id
              : action.id === block.id,
      ),
    );
    let previousText = previous?.text;
    if (previousText === undefined)
      for (const command of commands) {
        const inserted = command.actions.find(
          action => (action.kind === 'insert' || action.kind === 'split') && action.block.id === block.id,
        );
        if (inserted?.kind === 'insert' || inserted?.kind === 'split') {
          previousText = inserted.block.text;
          break;
        }
      }
    const ownWrite = commands.some(
      command =>
        command.frozen &&
        command.actions.some(action => action.kind === 'text' && action.id === block.id && action.text === block.text),
    );
    if (
      !ownWrite &&
      this.pendingText().has(block.id) &&
      previousText !== block.text &&
      cell.state.text !== block.text
    ) {
      cell.set('conflict', { remoteText: block.text, remoteRevision: block.revision });
      this.conflicts.add(block.id);
      this.resolving.delete(block.id);
      cell.set('revision', block.revision);
    } else if (!pending) this.put(block);
    else cell.set('revision', block.revision);
    this.host.publish(this.snapshot(block.id));
    this.conflictVersion[1](value => value + 1);
  }
  private rebasePendingRewrites(rewrites: readonly TextRewrite[]) {
    if (!rewrites.length) return;
    type TextPair = { before: string; after: string };
    const texts = new Map<string, TextPair>();
    for (const block of this.baseBlocks.values()) texts.set(block.id, { before: block.text, after: block.text });
    for (const rewrite of rewrites) texts.set(rewrite.id, { before: rewrite.before, after: rewrite.after });
    const rewriteText = (text: string, pair?: TextPair) =>
      pair ? (rebaseText(pair.before, pair.after, text) ?? text) : text;
    const caret = (value: HistoryCaret | null, state: ReadonlyMap<string, TextPair>): HistoryCaret | null => {
      if (!value) return null;
      const pair = state.get(value.id);
      return {
        ...value,
        offset: pair ? mapTextOffset(pair.before, pair.after, value.offset) : value.offset,
        ...(value.range
          ? { range: { anchor: caret(value.range.anchor, state)!, head: caret(value.range.head, state)! } }
          : {}),
      };
    };
    // Walk authored actions in order: a split transfers the right-hand rewrite to
    // its new ID, and a merge transfers both rewrites to the surviving ID.
    const actions = (values: Action[], state: Map<string, TextPair>, expected?: ReadonlyMap<string, TextPair>) => {
      for (const action of values) {
        if (action.kind === 'text') {
          const before = action.text,
            pair = state.get(action.id);
          action.text = rewriteText(before, pair);
          if (action.expectedText !== undefined)
            action.expectedText = rewriteText(action.expectedText, expected?.get(action.id) ?? pair);
          state.set(action.id, { before, after: action.text });
        } else if (action.kind === 'split') {
          const before = action.left + action.right,
            after = rewriteText(before, state.get(action.id));
          const at = mapTextOffset(before, after, action.left.length);
          const left = action.left,
            right = action.right;
          action.left = after.slice(0, at);
          action.right = after.slice(at);
          action.block = { ...action.block, text: action.right };
          state.set(action.id, { before: left, after: action.left });
          state.set(action.block.id, { before: right, after: action.right });
        } else if (action.kind === 'merge') {
          const destination = state.get(action.destinationId),
            source = state.get(action.id);
          const pair =
            destination && source
              ? { before: destination.before + source.before, after: destination.after + source.after }
              : undefined;
          const before = action.text;
          action.text = rewriteText(before, pair);
          state.set(action.destinationId, { before, after: action.text });
        } else if (action.kind === 'insert') {
          const before = action.block.text,
            after = rewriteText(before, state.get(action.block.id));
          action.block = { ...action.block, text: after };
          state.set(action.block.id, { before, after });
        } else if (action.kind === 'restore') {
          action.snapshots = action.snapshots.map(snapshot => {
            const before = snapshot.block.text,
              after = rewriteText(before, state.get(snapshot.block.id));
            state.set(snapshot.block.id, { before, after });
            return { ...snapshot, block: { ...snapshot.block, text: after } };
          });
        }
        // Keep deleted text available for a later restore and its history.
      }
    };
    const histories = new Map<HistoryEntry, { before: Map<string, TextPair>; after: Map<string, TextPair> }>();
    for (const pending of this.host.commands(this.pageId)) {
      if (pending.frozen) continue; // Uncertain requests must remain byte-identical.
      const before = new Map(texts);
      pending.before = caret(pending.before, before);
      actions(pending.actions, texts);
      pending.after = caret(pending.after, texts);
      actions(pending.inverse, new Map(before), texts);
      const entry = this.historyCommands.get(pending.id)?.entry;
      if (entry) {
        const history = histories.get(entry);
        if (history) history.after = new Map(texts);
        else histories.set(entry, { before, after: new Map(texts) });
      }
    }
    for (const [entry, state] of histories) {
      const before = entry.applied ? state.before : state.after,
        after = entry.applied ? state.after : state.before;
      entry.before = caret(entry.before, before);
      entry.after = caret(entry.after, after);
      actions(entry.forward, new Map(before));
      actions(entry.inverse, new Map(before), after);
    }
    for (const [id, pair] of texts) {
      if (pair.before === pair.after) continue;
      const cell = this.cells.get(id);
      if (cell?.state.text === pair.before) {
        cell.set('text', pair.after);
        this.host.publish(this.snapshot(id));
      }
    }
  }
  acknowledged(
    command: Command,
    revisions: Map<string, number>,
    rewrites: readonly TextRewrite[],
    receipt?: Committed,
  ) {
    if (this.reloadLog)
      this.reloadLog.acknowledged.push({
        command,
        revisions: new Map(revisions),
        rewrites: [...rewrites],
        receipt,
      });
    const previousRevisions = new Map([...revisions.keys()].map(id => [id, this.baseBlocks.get(id)?.revision ?? 0]));
    const sentRevisions = new Map<string, number>();
    const sent: Batch | undefined = command.frozen ? JSON.parse(command.frozen) : undefined;
    for (const operation of sent?.operations ?? [])
      if (
        'id' in operation &&
        'base_revision' in operation &&
        typeof operation.base_revision === 'number' &&
        !sentRevisions.has(operation.id)
      )
        sentRevisions.set(operation.id, operation.base_revision);
    batch(() => {
      for (const action of command.actions) {
        const id = action.kind === 'insert' ? action.block.id : action.id;
        const acknowledgedRevision = revisions.get(id);
        if (action.kind === 'split') {
          if ((this.baseBlocks.get(id)?.revision ?? 0) <= (acknowledgedRevision ?? 0))
            this.apply({ kind: 'text', id, text: action.left }, true);
          const saved = this.baseBlocks.get(action.block.id);
          const block = saved && saved.revision > (revisions.get(saved.id) ?? 0) ? saved : action.block;
          this.apply({ kind: 'insert', block, after: action.id }, true);
          continue;
        }
        if (acknowledgedRevision !== undefined && (this.baseBlocks.get(id)?.revision ?? 0) > acknowledgedRevision) {
          if (action.kind === 'insert' && this.baseOutline.indexOf(id) < 0)
            this.apply({ ...action, block: this.snapshot(id, true) }, true);
          continue;
        }
        if (action.kind === 'delete' && !this.baseBlocks.has(id)) continue;
        if (action.kind === 'text' && action.baseRevision !== undefined && !this.baseBlocks.has(id)) continue;
        if (action.kind === 'merge') {
          const destination = this.baseBlocks.get(action.destinationId);
          this.apply(
            destination && destination.revision > (revisions.get(destination.id) ?? 0)
              ? { ...action, text: destination.text }
              : action,
            true,
          );
        } else this.apply(action, true);
      }
      // Normalization is the final accepted text, not an edit to replay before the authored actions.
      for (const rewrite of rewrites) {
        const block = this.baseBlocks.get(rewrite.id);
        if (block && block.revision <= rewrite.revision)
          this.baseBlocks.set(rewrite.id, { ...block, text: rewrite.after, revision: rewrite.revision });
      }
      this.rebasePendingRewrites(rewrites);
      for (const [id, revision] of revisions) {
        const block = this.baseBlocks.get(id);
        if (block && block.revision <= revision) block.revision = revision;
        const cell = this.cells.get(id);
        if (cell && cell.state.revision <= revision) cell.set('revision', revision);
      }
      const capabilityRows = receipt?.capabilities ?? [];
      const allActions = [
        ...this.host
          .commands(this.pageId)
          .filter(item => !item.frozen)
          .flatMap(item => [...item.actions, ...item.inverse]),
        ...[...this.undoStack, ...this.redoStack].flatMap(entry => [...entry.forward, ...entry.inverse]),
      ];
      for (const action of allActions)
        if (action.kind === 'cardTemplate' && revisions.has(action.id)) {
          action.baseRevision = revisions.get(action.id)!;
        }
      for (const action of allActions)
        if (isCapabilityAction(action)) {
          const revision = revisions.get(action.id);
          if (
            revision !== undefined &&
            (previousRevisions.get(action.id) ?? 0) <= revision &&
            (action.baseRevision === previousRevisions.get(action.id) ||
              action.baseRevision === sentRevisions.get(action.id))
          )
            action.baseRevision = revision;
          if (
            action.kind === 'reverseTaskCompletion' &&
            command.actions.some(sent => sent.kind === 'completeTask' && sent.occurrenceId === action.occurrenceId)
          ) {
            const task = capabilityRows.find(value => value.block_id === action.id)?.task;
            if (task) action.previous = structuredClone(task);
          }
          if ('session' in action) {
            const session = receipt?.work_sessions?.find(value => value.id === action.session.id);
            if (session) action.session = { ...action.session, revision: session.revision };
          }
        }
      for (const session of receipt?.work_sessions ?? []) this.work.set(session.id, session);
      this.receiveCapabilities(capabilityRows);
      const touched = new Set(revisions.keys());
      for (const action of command.actions) {
        touched.add(action.kind === 'insert' ? action.block.id : action.id);
        if (action.kind === 'split') touched.add(action.block.id);
        if (action.kind === 'merge') touched.add(action.destinationId);
      }
      this.refreshPending(touched);
      if (command.actions.some(action => action.kind === 'delete' && action.id === this.pageId)) this.markMissing();
      if (command.actions.some(action => action.kind === 'restore' && action.id === this.pageId)) {
        this.retainHistoryOnDelete = false;
        this.setStatus('ready');
      }
      this.recordPrunedPages(command, receipt?.pruned_pages ?? []);
    });
  }
  private recordPrunedPages(command: Command, pages: NonNullable<Committed['pruned_pages']>) {
    const restored = new Set(command.actions.filter(action => action.kind === 'restoreTag').map(action => action.id));
    if (restored.size) {
      for (const entry of new Set([
        ...this.undoStack,
        ...this.redoStack,
        ...[...this.historyCommands.values()].map(history => history.entry),
      ])) {
        entry.forward = entry.forward.filter(action => action.kind !== 'restoreTag' || !restored.has(action.id));
        entry.inverse = entry.inverse.filter(action => action.kind !== 'restoreTag' || !restored.has(action.id));
      }
      for (const pending of this.host.commands(this.pageId))
        if (!pending.frozen) {
          pending.actions = pending.actions.filter(action => action.kind !== 'restoreTag' || !restored.has(action.id));
        }
    }
    const history = this.historyCommands.get(command.id);
    if (!history || !pages.length) return;
    const retain = (actions: Action[]) => {
      // Restore the entire pruning effect, including tags used by generated titles.
      for (const page of pages)
        if (!actions.some(action => action.kind === 'restoreTag' && action.id === page.id)) {
          actions.unshift({ kind: 'restoreTag', id: page.id, deletionId: page.deletion_id, revision: page.revision });
        }
    };
    retain(history.undo ? history.entry.forward : history.entry.inverse);
    // Redo may already be queued while the undo receipt was in flight.
    for (const pending of this.host.commands(this.pageId)) {
      const queued = this.historyCommands.get(pending.id);
      if (!pending.frozen && queued?.entry === history.entry && queued.undo !== history.undo) retain(pending.actions);
    }
  }
  private rememberHistory(command: Command, entry: HistoryEntry, undo: boolean, travel = false) {
    entry.commandId = command.id;
    entry.commands.add(command.id);
    this.historyCommands.set(command.id, { entry, undo, travel });
  }
  private pruneHistory(entry: HistoryEntry) {
    if (entry.retained || this.host.commands(this.pageId).some(command => entry.commands.has(command.id))) return;
    for (const id of entry.commands) this.historyCommands.delete(id);
    for (const id of entry.rewrites?.keys() ?? []) {
      const entries = this.guardHistories.get(id);
      entries?.delete(entry);
      if (!entries?.size) this.guardHistories.delete(id);
    }
  }
  private syncHistoryCommands(entries: ReadonlySet<HistoryEntry>): Command[] {
    const changed: Command[] = [];
    for (const command of this.host.commands(this.pageId)) {
      const history = this.historyCommands.get(command.id);
      if (!history || !history.travel || !entries.has(history.entry) || command.frozen) continue;
      const actions = history.undo ? history.entry.inverse : history.entry.forward;
      for (const action of command.actions)
        if (action.kind === 'text' && action.baseRevision !== undefined) {
          const pair = history.entry.rewrites?.get(action.id);
          if (pair) {
            const desired = history.undo ? pair.before : pair.after;
            action.text = desired.text;
            action.expectedText = desired.expectedText;
            action.baseRevision = desired.baseRevision;
          }
        }
      const present = new Set(command.actions.map(action => (action.kind === 'insert' ? action.block.id : action.id)));
      for (const action of actions)
        if (action.kind === 'text' && action.baseRevision !== undefined && !present.has(action.id))
          command.actions.push({ ...action });
      changed.push(command);
    }
    return changed;
  }
  recordRewrites(command: Command, rewrites: readonly TextRewrite[]): Command[] {
    const history = this.historyCommands.get(command.id);
    if (!history) return [];
    const { entry, undo } = history;
    let copied = false;
    for (const rewrite of rewrites) {
      const authored = command.actions.some(
        action =>
          (action.kind === 'text' && action.id === rewrite.id) ||
          ((action.kind === 'insert' || action.kind === 'split') && action.block.id === rewrite.id) ||
          (action.kind === 'split' && action.id === rewrite.id) ||
          (action.kind === 'merge' && action.destinationId === rewrite.id),
      );
      if (authored) {
        // A normalized authored edit is still one undo step back to its original inverse.
        for (const action of undo ? entry.inverse : entry.forward) {
          if (action.kind === 'text' && action.id === rewrite.id && action.text === rewrite.before)
            action.text = rewrite.after;
          if (
            (action.kind === 'insert' || action.kind === 'split') &&
            action.block.id === rewrite.id &&
            action.block.text === rewrite.before
          )
            action.block = { ...action.block, text: rewrite.after };
          if (action.kind === 'split' && action.id === rewrite.id && action.left === rewrite.before)
            action.left = rewrite.after;
          if (action.kind === 'merge' && action.destinationId === rewrite.id && action.text === rewrite.before)
            action.text = rewrite.after;
        }
        for (const action of undo ? entry.forward : entry.inverse) {
          if (action.kind === 'text' && action.id === rewrite.id && action.expectedText === rewrite.before)
            action.expectedText = rewrite.after;
        }
        // A coalesced history still queued behind this receipt was already mapped
        // with its full pending actions, not just this acknowledged prefix.
        if (
          !this.host
            .commands(this.pageId)
            .some(pending => !pending.frozen && this.historyCommands.get(pending.id)?.entry === entry)
        ) {
          const caret = undo ? entry.before : entry.after;
          for (const bound of [caret, caret?.range?.anchor, caret?.range?.head])
            if (bound?.id === rewrite.id) {
              bound.offset = mapTextOffset(rewrite.before, rewrite.after, bound.offset);
            }
        }
        continue;
      }
      entry.rewrites ??= new Map();
      let pair = entry.rewrites.get(rewrite.id);
      if (!pair) {
        if (!copied) {
          entry.inverse = [...entry.inverse];
          entry.forward = [...entry.forward];
          copied = true;
        }
        pair = {
          before: {
            kind: 'text',
            id: rewrite.id,
            text: undo ? rewrite.after : rewrite.before,
            baseRevision: rewrite.revision,
          },
          after: {
            kind: 'text',
            id: rewrite.id,
            text: undo ? rewrite.before : rewrite.after,
            baseRevision: rewrite.revision,
          },
        };
        entry.rewrites.set(rewrite.id, pair);
        entry.inverse.push(pair.before);
        entry.forward.push(pair.after);
        let guards = this.guardHistories.get(rewrite.id);
        if (!guards) {
          guards = new Set();
          this.guardHistories.set(rewrite.id, guards);
        }
        guards.add(entry);
      } else if (!undo) pair.after.text = rewrite.after;
      pair.before.baseRevision = rewrite.revision;
      pair.after.baseRevision = rewrite.revision;
      pair.before.expectedText = pair.after.text;
      pair.after.expectedText = pair.before.text;
    }
    const changed = rewrites.length ? this.syncHistoryCommands(new Set([entry])) : [];
    this.pruneHistory(entry);
    return changed;
  }
  /** Canonicalize the accepted value and its history together; later authored edits remain in order. */
  resolveRelationPick(command: Command, action: Extract<Action, { kind: 'text' }>, text: string) {
    const before = action.text;
    action.text = text;
    delete action.relationPick;
    const entry = this.historyCommands.get(command.id)?.entry;
    for (const change of [...command.inverse, ...(entry?.inverse ?? [])]) {
      if (change.kind === 'text' && change.id === action.id && change.expectedText === before)
        change.expectedText = text;
    }
    for (const change of entry?.forward ?? [])
      if (change.kind === 'text' && change.id === action.id && change.text === before) {
        change.text = text;
        delete change.relationPick;
      }
    this.refreshPending(new Set([action.id]));
  }
  refreshGuardVersions(blocks: readonly Block[], revisions: ReadonlyMap<string, number>): Command[] {
    let changed: Set<HistoryEntry> | undefined;
    for (const block of blocks)
      for (const entry of this.guardHistories.get(block.id) ?? []) {
        if (revisions.get(block.id) !== block.revision) continue;
        const pair = entry.rewrites!.get(block.id)!;
        const expected = entry.applied ? pair.after.text : pair.before.text;
        if (block.text !== expected || pair.before.baseRevision === block.revision) continue;
        pair.before.baseRevision = block.revision;
        pair.after.baseRevision = block.revision;
        (changed ??= new Set()).add(entry);
      }
    return changed ? this.syncHistoryCommands(changed) : [];
  }
  private pendingIds() {
    const pending = new Set<string>();
    for (const command of this.host.commands(this.pageId))
      for (const action of command.actions) {
        pending.add(action.kind === 'insert' ? action.block.id : action.id);
        if (action.kind === 'split') pending.add(action.block.id);
        if (action.kind === 'merge') pending.add(action.destinationId);
        if (action.kind === 'restore') for (const snapshot of action.snapshots) pending.add(snapshot.block.id);
      }
    return pending;
  }
  refreshPending(touched?: Set<string>) {
    const pending = this.pendingIds();
    for (const id of touched ?? this.cells.keys()) {
      const cell = this.cells.get(id);
      if (!cell) continue;
      cell.set('pending', pending.has(id));
      if (
        !pending.has(id) &&
        !this.resolving.has(id) &&
        cell.state.conflict &&
        cell.state.text === this.baseBlocks.get(id)?.text
      ) {
        cell.set('conflict', null);
        this.conflicts.delete(id);
        this.conflictVersion[1](value => value + 1);
      }
      const saved = this.baseBlocks.get(id);
      if (saved && !pending.has(id) && !cell.state.conflict && !this.resolving.has(id)) {
        const value = this.capabilities(id, true);
        this.markArchived(id, saved.archived);
        cell.set({
          text: saved.text,
          heading: saved.heading,
          archived: saved.archived,
          parentId: saved.parent_id,
          manual_types: this.baseManualTypes.get(id) ?? [],
          task: value.task,
          project: value.project,
          position: value.position ?? null,
          relation: value.relation ?? null,
          spread: value.spread ?? false,
          source: value.source ?? null,
          citations: value.citations ?? [],
          history: value.history,
          mergeProtected: value.merge_protected,
          reviewedCards: value.reviewed_cards,
          loggedWorkMs: value.logged_work_ms ?? 0,
          templateCards: value.template_cards ?? 0,
        });
      }
      this.host.publish(this.snapshot(id));
    }
  }
  view(): PageView {
    return {
      root: this.snapshot(this.pageId, true),
      root_manual_types: this.baseManualTypes.get(this.pageId) ?? [],
      rows: this.baseOutline.slice(0, this.baseOutline.size()).map(row => ({
        block: this.snapshot(row.id, true),
        depth: row.depth,
        manual_types: this.baseManualTypes.get(row.id) ?? [],
      })),
      targets: [],
      capabilities: [...this.baseCapabilities.values()],
    };
  }
  /** Shared by page-local history and acknowledged, cross-page source commands. */
  sourceDetailsActions(edit: SourceDetailsEdit): Action[] {
    if (this.status() !== 'ready') throw new Error('This atom is not ready.');
    const actions: Action[] = [];
    const text = (id: string, value: string) => {
      if (this.snapshot(id).text !== value) actions.push({ kind: 'text', id, text: value });
    };
    const insert = (parentId: string, after: string | null, value: string) => {
      const id = ulid();
      actions.push({
        kind: 'insert',
        after,
        block: {
          id,
          kind: 'block',
          parent_id: parentId,
          page_id: this.pageId,
          text: value,
          heading: null,
          archived: false,
          kept_copy: null,
          revision: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });
      return id;
    };
    if (edit.title !== undefined) {
      const title = edit.title.trim();
      if (!title) throw new Error('A title is required.');
      if (!this.host.titleAvailable(title, this.pageId)) throw new Error('An atom with this title already exists.');
      text(this.pageId, title);
    }
    let after = this.outline.children(this.pageId).at(-1) ?? null;
    for (const field of edit.fields) {
      for (const id of field.entries) {
        if (this.block(id)?.parentId !== this.pageId || this.isArchived(id))
          throw new Error('The field changed. Refresh before saving.');
      }
      const current = field.entries.flatMap(id => this.outline.children(id)).filter(id => !this.isArchived(id));
      let entry = field.entries[0];
      if (!entry && field.values.length) {
        entry = insert(this.pageId, after, `[[${field.id}]]`);
        after = entry;
      }
      let childAfter = entry ? (this.outline.children(entry).at(-1) ?? null) : null;
      for (let index = 0; index < Math.max(current.length, field.values.length); index++) {
        const id = current[index],
          value = field.values[index];
        // Retain empty authored overrides so reingest cannot refill cleared values.
        if (id) text(id, value ?? '');
        else if (entry && value !== undefined) childAfter = insert(entry, childAfter, value);
      }
    }
    if (edit.source !== undefined) {
      const previous = sourceState(this.root()?.source);
      const value = sourceState(edit.source);
      if (!sameState(previous, value))
        actions.push({
          kind: 'source',
          id: this.pageId,
          value,
          previous,
          baseRevision: this.snapshot(this.pageId).revision,
        });
    }
    if (edit.tags !== undefined) {
      const previous = this.root()?.manual_types ?? [];
      for (const title of edit.tags)
        if (!title || title.trim() !== title || /[[\]\r\n]/.test(title)) throw new Error('Invalid tag title.');
      // Replace in order: undo must recover the original spellings and ordering.
      if (!sameState(previous, edit.tags)) {
        for (const title of previous) actions.push({ kind: 'removeType', id: this.pageId, title });
        for (const title of edit.tags) actions.push({ kind: 'addType', id: this.pageId, title });
      }
    }
    return actions;
  }
  /** Capture inverses without applying optimistic state to any selected page. */
  sourceActionsInverse(actions: readonly Action[]): Action[] {
    const inverse: Action[] = [];
    const inserted = new Set(actions.flatMap(action => (action.kind === 'insert' ? [action.block.id] : [])));
    for (const action of actions) {
      switch (action.kind) {
        case 'text':
          inverse.unshift({
            kind: 'text',
            id: action.id,
            text: this.snapshot(action.id).text,
            expectedText: action.text,
          });
          break;
        case 'source':
          inverse.unshift({ ...action, value: action.previous, previous: action.value });
          break;
        case 'addType':
          inverse.unshift({ kind: 'removeType', id: action.id, title: action.title });
          break;
        case 'removeType':
          inverse.unshift({ kind: 'addType', id: action.id, title: action.title });
          break;
        case 'insert':
          if (!inserted.has(action.block.parent_id!)) inverse.unshift({ kind: 'delete', id: action.block.id });
          break;
        case 'delete': {
          this.guardHide(action.id);
          const at = this.outline.indexOf(action.id);
          if (at < 0) throw new Error('The field no longer exists.');
          const snapshots = this.outline.slice(at, this.outline.subtreeEnd(at)).map(row => ({
            row: { ...row },
            block: this.snapshot(row.id),
            manual_types: [...this.block(row.id)!.manual_types],
            capabilities: this.capabilities(row.id),
          }));
          inverse.unshift({
            kind: 'restore',
            id: action.id,
            snapshots,
            after: this.outline.previousSibling(action.id),
          });
          break;
        }
        case 'restore':
          inverse.unshift({ kind: 'delete', id: action.id });
          break;
        default:
          throw new Error('Unsupported source action.');
      }
    }
    // add_type appends; reverse inversion would otherwise reverse the original tag order.
    const tags = inverse.filter(action => action.kind === 'addType');
    let index = tags.length;
    return inverse.map(action => (action.kind === 'addType' ? tags[--index]! : action));
  }
  /** Compare only affected values, not revisions changed by intervening undo steps. */
  sourceActionsState(actions: readonly Action[]): string {
    return JSON.stringify(
      actions.map(action => {
        if (action.kind === 'insert') return this.outline.children(action.block.parent_id!);
        if (action.kind === 'restore') return null;
        if (action.kind === 'source') return sourceState(this.root()?.source);
        if (action.kind === 'addType' || action.kind === 'removeType') return this.block(action.id)?.manual_types;
        if (action.kind === 'text') return this.block(action.id)?.text;
        if (action.kind === 'delete') {
          const at = this.outline.indexOf(action.id);
          return at < 0
            ? null
            : this.outline.slice(at, this.outline.subtreeEnd(at)).map(row => {
                const block = this.block(row.id)!;
                return [
                  row.id,
                  row.parentId,
                  block.text,
                  block.archived,
                  block.heading,
                  block.manual_types,
                  this.capabilities(row.id),
                ];
              });
        }
        throw new Error('Unsupported source action.');
      }),
    );
  }
  beginTextCommit(write: (edit: PageDocument['edit']) => EditResult): PendingTextCommit {
    const group: { entry?: HistoryEntry } = {};
    let finished = false;
    const apply = (edit: Edit, before?: HistoryCaret | null) => {
      if (finished || (group.entry && (!group.entry.applied || !group.entry.retained)))
        return { ok: false, reason: 'This cell commit is no longer active.' } as const;
      const previous = this.textCommit;
      this.textCommit = group;
      try {
        return this.edit(edit, before);
      } finally {
        this.textCommit = previous;
      }
    };
    const result = write(apply);
    const id = result.ok ? result.caret?.id : undefined;
    let expected = id ? this.block(id)?.text : undefined;
    return {
      result,
      replace: text => {
        if (!id || this.block(id)?.text !== expected)
          return { ok: false, reason: 'The cell changed elsewhere before its reference lookup finished.' };
        const result = apply({ kind: 'text', id, text });
        if (result.ok) expected = text;
        return result;
      },
      finish: () => {
        finished = true;
      },
    };
  }
  private internals(): DocumentInternals {
    return {
      pageId: this.pageId,
      outline: this.outline,
      host: this.host,
      work: this.work,
      investigationIds: this.investigationIds,
      block: id => this.block(id),
      root: () => this.root(),
      snapshot: (id, base) => this.snapshot(id, base),
      capabilities: (id, base) => this.capabilities(id, base),
      guardHide: id => this.guardHide(id),
      guardMerge: id => this.guardMerge(id),
      sourceDetailsActions: edit => this.sourceDetailsActions(edit),
    };
  }
  edit(edit: Edit, caretBefore: HistoryCaret | null = null): EditResult {
    if (this.status() !== 'ready') return { ok: false, reason: 'This atom is not ready.' };
    const doc = this.internals();
    const session = new EditSession(doc, caretBefore);
    try {
      switch (edit.kind) {
        case 'cardHeld':
          editCardHeld(doc, session, edit);
          break;
        case 'cardTemplate':
          editCardTemplate(doc, session, edit);
          break;
        case 'keptCopy':
          editKeptCopy(doc, session, edit);
          break;
        case 'sourceDetails':
          editSourceDetails(doc, session, edit);
          break;
        case 'source':
          editSource(doc, session, edit);
          break;
        case 'mergeHighlights':
          editMergeHighlights(doc, session, edit);
          break;
        case 'cite':
        case 'highlight':
          editCite(doc, session, edit);
          break;
        case 'uncite':
          editUncite(doc, session, edit);
          break;
        case 'citationTriage':
          editCitationTriage(doc, session, edit);
          break;
        case 'highlightColor':
          editHighlightColor(doc, session, edit);
          break;
        case 'position':
          editPosition(doc, session, edit);
          break;
        case 'relation':
          editRelation(doc, session, edit);
          break;
        case 'addRelation':
          editAddRelation(doc, session, edit);
          break;
        case 'spread':
          editSpread(doc, session, edit);
          break;
        case 'writeAssessment':
        case 'addBranchQuestion':
          editQuestionChild(doc, session, edit);
          break;
        case 'question':
          editQuestion(doc, session, edit);
          break;
        case 'quote':
          editQuote(doc, session, edit);
          break;
        case 'assessment':
          editAssessment(doc, session, edit);
          break;
        case 'task':
        case 'planTask':
        case 'project':
        case 'completeTask':
        case 'startWork':
        case 'stopWork':
        case 'workNote':
          editTaskWork(doc, session, edit);
          break;
        case 'positionLinks':
          editPositionLinks(doc, session, edit);
          break;
        case 'text':
          editText(doc, session, edit);
          break;
        case 'heading':
          editHeading(doc, session, edit);
          break;
        case 'archive':
          editArchive(doc, session, edit);
          break;
        case 'addField':
          editAddField(doc, session, edit);
          break;
        case 'fieldEntry':
          editFieldEntry(doc, session, edit);
          break;
        case 'addReading':
          editAddReading(doc, session, edit);
          break;
        case 'addFieldEntries':
          editAddFieldEntries(doc, session, edit);
          break;
        case 'taskProject':
          editTaskProject(doc, session, edit);
          break;
        case 'fieldKind':
          editFieldKind(doc, session, edit);
          break;
        case 'fieldHide':
          editFieldHide(doc, session, edit);
          break;
        case 'fieldRole':
          editFieldRole(doc, session, edit);
          break;
        case 'fieldCountsAs':
          editFieldCountsAs(doc, session, edit);
          break;
        case 'fieldTargets':
          editFieldTargets(doc, session, edit);
          break;
        case 'subjectCriteria':
          editSubjectCriteria(doc, session, edit);
          break;
        case 'typePresentation':
          editTypePresentation(doc, session, edit);
          break;
        case 'addType':
        case 'removeType':
          editManualType(doc, session, edit);
          break;
        case 'insert':
          editInsert(doc, session, edit);
          break;
        case 'image':
          editImage(doc, session, edit);
          break;
        case 'occlusion':
          editOcclusion(doc, session, edit);
          break;
        case 'insertImages':
        case 'placeImages':
          editImages(doc, session, edit);
          break;
        case 'split':
          editSplit(doc, session, edit);
          break;
        case 'merge':
          editMerge(doc, session, edit);
          break;
        case 'delete':
          editDelete(doc, session, edit);
          break;
        case 'moveTo':
          editMoveTo(doc, session, edit);
          break;
        case 'indent':
          editIndent(doc, session, edit);
          break;
        case 'outdent':
          editOutdent(doc, session, edit);
          break;
        case 'move':
          editMove(doc, session, edit);
          break;
        case 'deleteRange':
          editDeleteRange(doc, session, edit);
          break;
        case 'replaceRange':
          editReplaceRange(doc, session, edit);
          break;
        case 'paste':
          editPaste(doc, session, edit);
          break;
        case 'pasteRows':
          editPasteRows(doc, session, edit);
          break;
        case 'pasteBlocks':
          editPasteBlocks(doc, session, edit);
          break;
        default: {
          const unexpected: never = edit;
          return unexpected;
        }
      }
      const { actions, created, caret } = session;

      if (!actions.length) return { ok: true, caret, created };
      const inverse: Action[] = [];
      batch(() => {
        for (const action of actions) {
          const undo = this.apply(action);
          if (edit.kind !== 'highlight' || action.kind !== 'cite') inverse.unshift(...undo);
        }
      });
      const beforeRange =
        edit.kind === 'replaceRange'
          ? (edit.selectionBefore ?? edit.range)
          : edit.kind === 'pasteBlocks' || edit.kind === 'pasteRows'
            ? edit.range
            : null;
      const before: HistoryCaret | null = beforeRange
        ? {
            ...(caretBefore ?? beforeRange.head),
            range: { anchor: { ...beforeRange.anchor }, head: { ...beforeRange.head } },
          }
        : caretBefore;
      const selection = caretBefore?.selection;
      const treeMove =
        edit.kind === 'indent' || edit.kind === 'outdent' || edit.kind === 'move' || edit.kind === 'moveTo';
      const after: HistoryCaret | null =
        caret && treeMove && selection ? { ...caret, selection: { ...selection } } : caret;
      const last = this.textCommit?.entry ?? this.undoStack.at(-1);
      const typing =
        edit.kind === 'text' && edit.heading === undefined
          ? { id: edit.id, group: edit.group }
          : edit.kind === 'replaceRange' && edit.mode === 'text' && edit.text && caret
            ? { id: caret.id }
            : undefined;
      const textGroup =
        !!this.textCommit?.entry ||
        (!this.textCommit &&
          edit.kind === 'text' &&
          !edit.relationPick &&
          typing &&
          last?.typing?.id === typing.id &&
          last.typing.group === typing.group &&
          Date.now() - this.lastTextEditAt < 1000);
      const command = this.host.enqueue(this, actions, inverse, before, after, !!textGroup);
      let entry: HistoryEntry;
      if (last && (last.commandId === command.id || textGroup)) {
        entry = last;
        const tail = entry.forward.at(-1);
        if (edit.kind === 'text' && tail?.kind === 'text' && tail.id === edit.id) {
          tail.text = edit.text;
          if (edit.relationPick) tail.relationPick = edit.relationPick;
          else delete tail.relationPick;
        } else entry.forward.push(...actions);
        if (edit.kind === 'text')
          for (const action of entry.inverse) {
            if (action.kind === 'text' && action.id === edit.id) {
              action.expectedText = edit.text;
              break;
            }
          }
        entry.after = after;
        entry.typing = typing;
      } else {
        entry = {
          forward: actions,
          inverse,
          before,
          after,
          commandId: command.id,
          commands: new Set(),
          applied: true,
          retained: true,
          typing,
        };
        this.undoStack.push(entry);
      }
      if (this.textCommit) this.textCommit.entry = entry;
      this.rememberHistory(command, entry, false);
      this.lastTextEditAt = typing ? Date.now() : 0;
      const discarded = this.redoStack;
      this.redoStack = [];
      for (const entry of discarded) {
        entry.retained = false;
        this.pruneHistory(entry);
      }
      this.historyVersion[1](value => value + 1);
      return { ok: true, caret, created };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  rename(title: string): EditResult {
    if (this.root()?.kind !== 'page') return { ok: false, reason: 'Journal dates cannot be renamed.' };
    if (!title.trim()) return { ok: false, reason: 'A title is required.' };
    if (!this.host.titleAvailable(title.trim(), this.pageId))
      return { ok: false, reason: 'An atom with this title already exists.' };
    return this.edit({ kind: 'text', id: this.pageId, text: title.trim() });
  }
  addType(blockId: string, title: string): EditResult {
    return this.edit({ kind: 'addType', id: blockId, title });
  }
  removeType(blockId: string, title: string): EditResult {
    return this.edit({ kind: 'removeType', id: blockId, title });
  }
  rememberChange(change: DocumentChange | Promise<DocumentChange>): DocumentChange {
    const entry: HistoryEntry = {
      forward: [],
      inverse: [],
      before: null,
      after: null,
      commandId: '',
      commands: new Set(),
      applied: true,
      retained: true,
    };
    const ready = Promise.resolve(change);
    void ready.catch(() => {
      this.undoStack = this.undoStack.filter(item => item !== entry);
      this.redoStack = this.redoStack.filter(item => item !== entry);
      entry.retained = false;
      this.pruneHistory(entry);
      this.historyVersion[1](value => value + 1);
    });
    const travel = (undo: boolean): Promise<void> => {
      if (this.historyPending) return this.historyPending.then(() => travel(undo));
      const from = undo ? this.undoStack : this.redoStack;
      const to = undo ? this.redoStack : this.undoStack;
      if (!from.includes(entry)) return Promise.resolve();
      const pending = ready
        .then(change => (undo ? change.undo() : change.redo()))
        .then(() => {
          from.splice(from.indexOf(entry), 1);
          entry.applied = !undo;
          to.push(entry);
        })
        .catch(error => {
          this.historyNotice[1](error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          this.historyPending = null;
          this.historyVersion[1](value => value + 1);
        });
      this.historyPending = pending;
      this.historyVersion[1](value => value + 1);
      return pending;
    };
    entry.external = { undo: () => travel(true), redo: () => travel(false) };
    for (const discarded of this.redoStack) {
      discarded.retained = false;
      this.pruneHistory(discarded);
    }
    this.redoStack = [];
    this.undoStack.push(entry);
    this.lastTextEditAt = 0;
    this.historyVersion[1](value => value + 1);
    return entry.external;
  }
  private travel(undo: boolean): HistoryCaret | null {
    if (this.historyPending) {
      const resume = () => {
        this.travel(undo);
      };
      void this.historyPending.then(resume, resume);
      return null;
    }
    this.lastTextEditAt = 0;
    const from = undo ? this.undoStack : this.redoStack;
    const to = undo ? this.redoStack : this.undoStack;
    this.historyNotice[1]('');
    const external = from.at(-1)?.external;
    if (external) {
      void (undo ? external.undo() : external.redo()).catch(() => {});
      return null;
    }
    const entry = from.pop();
    if (!entry) return null;
    const actions = (undo ? entry.inverse : entry.forward).map<Action>(action => {
      if (
        !undo &&
        (action.kind === 'fieldKind' ||
          action.kind === 'fieldHide' ||
          action.kind === 'fieldRole' ||
          action.kind === 'fieldCountsAs' ||
          action.kind === 'fieldTargets' ||
          action.kind === 'subjectCriteria' ||
          action.kind === 'typePresentation')
      )
        return { ...action, baseRevision: undefined };
      return { ...action };
    });
    // Check all text patches before applying any part of the transaction.
    const texts = new Map<string, string>();
    for (const action of actions) {
      if (action.kind === 'restore')
        for (const snapshot of action.snapshots) texts.set(snapshot.block.id, snapshot.block.text);
      else if (action.kind === 'insert' || action.kind === 'split') texts.set(action.block.id, action.block.text);
      if (action.kind !== 'text') continue;
      const current = texts.get(action.id) ?? this.cells.get(action.id)?.state.text;
      if (current === undefined || action.expectedText === undefined) continue;
      const patched = rebaseText(action.expectedText, action.text, current);
      if (patched === null) {
        entry.retained = false;
        this.pruneHistory(entry);
        this.historyNotice[1]('Changed elsewhere; nothing to undo here');
        this.historyVersion[1](value => value + 1);
        return null;
      }
      action.expectedText = current;
      action.text = patched;
      texts.set(action.id, patched);
    }
    try {
      const inverse: Action[] = [];
      batch(() => {
        for (const action of actions) {
          if (action.kind === 'text' && action.baseRevision !== undefined && !this.cells.has(action.id)) {
            // Cross-page spelling guards are applied by the server, not this document.
            // Retain their opposite guard when replacing history with actual inverses.
            const pair = entry.rewrites?.get(action.id);
            const opposite = undo ? pair?.after : pair?.before;
            if (opposite) inverse.unshift(opposite);
            continue;
          }
          inverse.unshift(...this.apply(action));
        }
      });
      const command = this.host.enqueue(
        this,
        actions,
        inverse,
        undo ? entry.after : entry.before,
        undo ? entry.before : entry.after,
        false,
      );
      // Redo replays the inverse of what undo actually applied. Inserts therefore
      // become restores even when their original acknowledgement is still in flight.
      // Keep spelling-rewrite guard identities used by later acknowledgements.
      for (const action of actions) {
        if (action.kind !== 'text' || action.baseRevision === undefined) continue;
        const pair = entry.rewrites?.get(action.id);
        const guard = undo ? pair?.before : pair?.after;
        if (guard) {
          guard.text = action.text;
          guard.expectedText = action.expectedText;
        }
      }
      for (let index = 0; index < inverse.length; index++) {
        const action = inverse[index]!;
        if (action.kind !== 'text' || action.baseRevision === undefined) continue;
        const pair = entry.rewrites?.get(action.id);
        const guard = undo ? pair?.after : pair?.before;
        if (guard) {
          guard.text = action.text;
          guard.expectedText = action.expectedText;
          inverse[index] = guard;
        }
      }
      if (undo) entry.forward = inverse;
      else entry.inverse = inverse;
      entry.applied = !undo;
      this.rememberHistory(command, entry, undo, true);
      to.push(entry);
      this.historyVersion[1](value => value + 1);
      return undo ? entry.before : entry.after;
    } catch {
      from.push(entry);
      return null;
    }
  }
  undo() {
    return this.travel(true);
  }
  redo() {
    return this.travel(false);
  }
  resolveConflict(id: string, keep: 'mine' | 'theirs') {
    const cell = this.cells.get(id);
    if (!cell?.state.conflict) return;
    const text = keep === 'mine' ? cell.state.text : cell.state.conflict.remoteText;
    this.resolving.add(id);
    // Update existing rejected/unsent text in place; no frozen request is altered.
    let found = false;
    const choice = {
      id,
      text,
      localText: cell.state.text,
      remoteRevision: cell.state.conflict.remoteRevision,
      deferred: false,
    };
    for (const command of this.host.commands(this.pageId)) {
      if (!command.actions.some(action => action.kind === 'text' && action.id === id)) continue;
      found = true;
      command.resolutions = [
        ...(command.resolutions ?? []).filter(item => item.id !== id),
        { ...choice, deferred: Boolean(command.frozen) },
      ];
      if (!command.frozen)
        for (const action of command.actions) if (action.kind === 'text' && action.id === id) action.text = text;
      command.failed = undefined;
    }
    if (!found) {
      const command = this.host.enqueue(
        this,
        [{ kind: 'text', id, text }],
        [{ kind: 'text', id, text: cell.state.text }],
        null,
        null,
        false,
      );
      command.resolutions = [choice];
    }
    cell.set('pending', true);
    this.host.publish(this.snapshot(id));
    this.host.retry();
  }
  confirmResolution(id: string, text: string) {
    if (!this.pendingText().has(id)) this.cells.get(id)?.set('text', text);
    this.conflictResolved(id);
    if (this.cells.has(id)) this.host.publish(this.snapshot(id));
  }
  forgetRejected(commandId: string) {
    const entry = this.historyCommands.get(commandId)?.entry;
    this.undoStack = this.undoStack.filter(item => item !== entry && item.commandId !== commandId);
    this.redoStack = this.redoStack.filter(item => item !== entry && item.commandId !== commandId);
    if (entry) {
      entry.retained = false;
      this.pruneHistory(entry);
    }
    this.historyVersion[1](value => value + 1);
  }
  conflictResolved(id: string) {
    this.cells.get(id)?.set('conflict', null);
    this.resolving.delete(id);
    this.conflicts.delete(id);
    this.conflictVersion[1](value => value + 1);
  }
  localText() {
    return [...this.pendingText()].map(id => this.block(id)?.text ?? '').join('\n');
  }
}
