import { batch, createSignal } from 'solid-js';
import type { Signal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Batch, Block, BlockCapabilities, Committed, PageView, TextRewrite, WorkSession } from '../api/types';
import type { BlockState, Caret, Edit, EditResult, HistoryCaret, PageDocument, SaveState, TextRange } from './contract';
import { OutlineIndex } from './outline-index';
import type { Action, Command, HistoryEntry, PageCommand, Snapshot } from './types';
import { emptyCapabilities, isCapabilityAction, questionStatus, sameState, sourceState } from './types';
import { parseCardText } from '../review/card-text';
import { textTokens } from './text-tokens';

export interface DocumentHost {
  ready: Promise<void>;
  commands(pageId: string): PageCommand[];
  loadPage(id: string): Promise<PageView>;
  cachePage(view: PageView): void;
  enqueue(doc: Document, actions: Action[], inverse: Action[], before: Caret | null, after: Caret | null, coalesce: boolean): PageCommand;
  flushPage(pageId: string): Promise<void>;
  runningWork(): WorkSession | undefined;
  state(pageId?: string): SaveState;
  message(pageId?: string): string;
  publish(block: Block | null, id?: string): void;
  updateRoot(block: Block | null, id?: string): void;
  release(doc: Document): void;
  retry(): void;
  titleAvailable(title: string, exceptId: string): boolean;
}
type MutableBlockState = { -readonly [K in keyof BlockState]: BlockState[K] } & { history: boolean };
interface Cell { state: MutableBlockState; set: SetStoreFunction<MutableBlockState> }
const stateOf = (block: Block): BlockState => ({ id: block.id, kind: block.kind, parentId: block.parent_id, pageId: block.page_id, text: block.text, heading: block.heading, archived: block.archived, manual_types: [], task: null, project: null, position: null, question: null, assessment: null, mergeProtected: false, reviewedCards: false, source: null, citations: [], revision: block.revision, pending: false, conflict: null });
/** The reference or tag holding `offset` strictly inside it, where Enter must not cut. */
const splitToken = (text: string, offset: number) =>
  textTokens(text).find(token => (token.kind === 'reference' || token.kind === 'tag') && offset > token.start && offset < token.end);

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
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historyCommands = new Map<string, { entry: HistoryEntry; undo: boolean; travel: boolean }>();
  private guardHistories = new Map<string, Set<HistoryEntry>>();
  private historyVersion = createSignal(0);
  private resolving = new Set<string>();
  private conflicts = new Set<string>();
  private lastTextEditAt = 0;
  private closed = false;
  private syncGeneration = 0;
  holds = 0;
  status = this.loadStatus[0];
  statusMessage = this.loadMessage[0];
  constructor(readonly pageId: string, private host: DocumentHost) {
    this.outline = new OutlineIndex(pageId);
    this.baseOutline = new OutlineIndex(pageId);
    void host.ready.then(() => { if (this.status() === 'loading') return this.reload(); }).catch(error => this.fail(error));
  }
  root() { return this.block(this.pageId); }
  block(id: string) {
    let presence = this.presence.get(id);
    if (!presence) { presence = createSignal(0); this.presence.set(id, presence); }
    presence[0]();
    return this.cells.get(id)?.state;
  }
  private presenceChanged(id: string) { this.presence.get(id)?.[1](value => value + 1); }
  isArchived(id: string) { return this.archived.has(id); }
  private markArchived(id: string, archived: boolean) {
    if (this.archived.has(id) === archived) return;
    if (archived) this.archived.add(id); else this.archived.delete(id);
    this.archiveChange[1](value => value + 1);
  }
  needsRefresh(blocks: readonly Block[], removed: readonly string[]) {
    if (this.status() !== 'ready') return true;
    return blocks.some(block => block.page_id === this.pageId && (this.baseBlocks.get(block.id)?.revision ?? -1) < block.revision)
      || removed.some(id => this.cells.has(id));
  }
  saveState() { return this.host.state(this.pageId); }
  saveMessage() { return this.host.message(this.pageId); }
  flush() { return this.host.flushPage(this.pageId); }
  canUndo() { this.historyVersion[0](); return this.undoStack.length > 0; }
  canRedo() { this.historyVersion[0](); return this.redoStack.length > 0; }
  release() { this.host.release(this); }
  async reload(conflicts = true) {
    try {
      while (!this.closed) {
        const generation = this.syncGeneration;
        const view = await this.host.loadPage(this.pageId);
        if (this.closed) return;
        if (generation !== this.syncGeneration) continue;
        this.merge(view, conflicts);
        return;
      }
    } catch (error) {
      if (!this.closed && (this.status() !== 'ready' || error instanceof ApiError && error.status === 404)) this.fail(error);
    }
  }
  close() { this.closed = true; }
  markMissing(message = 'This page has been deleted.') {
    this.syncGeneration++;
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
      this.undoStack = [];
      this.redoStack = [];
      this.historyCommands.clear();
      this.guardHistories.clear();
      this.historyVersion[1](value => value + 1);
      for (const id of ids) this.presenceChanged(id);
      this.host.publish(null, this.pageId);
      this.host.updateRoot(null, this.pageId);
      this.loadStatus[1]('missing');
      this.loadMessage[1](message);
    });
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ApiError && error.status === 404) this.markMissing(message);
    else { this.loadStatus[1]('error'); this.loadMessage[1](message); }
  }
  isResolving(id: string) { return this.resolving.has(id); }
  private put(block: Block, pending = false, manual_types = this.cells.get(block.id)?.state.manual_types ?? this.baseManualTypes.get(block.id) ?? [], capability = this.capabilities(block.id)) {
    const cell = this.cells.get(block.id);
    const sidecar = { task: capability.task, project: capability.project, position: capability.position ?? null, question: capability.question ?? null, assessment: capability.assessment ?? null, source: capability.source ?? null, citations: capability.citations ?? [], history: capability.history, mergeProtected: capability.merge_protected, reviewedCards: capability.reviewed_cards };
    this.trackInvestigation(capability);
    this.markArchived(block.id, block.archived);
    if (cell) cell.set({ ...stateOf(block), ...sidecar, manual_types, pending, conflict: cell.state.conflict });
    else {
      const [state, set] = createStore<MutableBlockState>({ ...stateOf(block), ...sidecar, manual_types, pending });
      this.cells.set(block.id, { state, set });
      this.presenceChanged(block.id);
    }
    this.host.publish(block);
  }
  snapshot(id: string, base = false): Block {
    if (base) {
      const block = this.baseBlocks.get(id);
      if (!block) throw new Error('The block no longer exists.');
      return { ...block };
    }
    const state = this.cells.get(id)?.state;
    if (!state) throw new Error('The block no longer exists.');
    const saved = this.baseBlocks.get(id);
    return { id, kind: state.kind, parent_id: state.parentId, page_id: state.pageId, text: state.text, heading: state.heading, archived: state.archived, revision: state.revision, created_at: saved?.created_at ?? Date.now(), updated_at: saved?.updated_at ?? Date.now() };
  }
  private changed(id: string, patch: Partial<Block>, base: boolean) {
    const block = { ...this.snapshot(id, base), ...patch };
    if (base) this.baseBlocks.set(id, block);
    else { this.put(block, true); if (block.kind !== 'block') this.host.updateRoot(block); }
  }
  capabilities(id: string, base = false): BlockCapabilities {
    const cell = !base && this.cells.get(id)?.state;
    const value = cell ? { block_id: id, task: cell.task, project: cell.project, position: cell.position, question: cell.question, assessment: cell.assessment, source: cell.source, citations: cell.citations, history: cell.history, merge_protected: cell.mergeProtected, reviewed_cards: cell.reviewedCards } : this.baseCapabilities.get(id);
    // Most blocks have no capabilities; a fresh empty value needs no defensive copy.
    return value ? JSON.parse(JSON.stringify(value)) as BlockCapabilities : emptyCapabilities(id);
  }
  private trackInvestigation(value: BlockCapabilities) {
    if (value.question || value.assessment) this.investigationIds.add(value.block_id);
    else this.investigationIds.delete(value.block_id);
  }
  private updateCapabilities(value: BlockCapabilities, base: boolean) {
    value.merge_protected = value.task !== null || value.project !== null || Boolean(value.position || value.question || value.assessment) || value.history || value.reviewed_cards;
    if (!base) this.trackInvestigation(value);
    if (base) this.baseCapabilities.set(value.block_id, value);
    else this.cells.get(value.block_id)?.set({ task: value.task, project: value.project, position: value.position ?? null, question: value.question ?? null, assessment: value.assessment ?? null, source: value.source ?? null, citations: value.citations ?? [], history: value.history, mergeProtected: value.merge_protected, reviewedCards: value.reviewed_cards, pending: true });
  }
  private guardMerge(id: string) {
    const value = this.capabilities(id);
    if (value.merge_protected) throw new Error(value.history
      ? 'This task has completion or work history; delete it or keep it separate.'
      : 'Cannot merge away an active task, project, perspective, question, answer, or reviewed card.');
  }
  receiveCapabilities(values: readonly BlockCapabilities[]) {
    const received = new Set<string>();
    for (const value of values) {
      if (!this.baseBlocks.has(value.block_id) && !this.cells.has(value.block_id)) continue;
      this.baseCapabilities.set(value.block_id, structuredClone(value));
      this.syncGeneration++;
      this.cells.get(value.block_id)?.set({ task: value.task, project: value.project, position: value.position ?? null, question: value.question ?? null, assessment: value.assessment ?? null, source: value.source ?? null, citations: value.citations ?? [], history: value.history, mergeProtected: value.merge_protected, reviewedCards: value.reviewed_cards });
      this.trackInvestigation(value);
      received.add(value.block_id);
    }
    for (const command of this.host.commands(this.pageId)) for (const action of command.actions) {
      if (isCapabilityAction(action) && (received.has(action.id) || action.kind === 'question' || action.kind === 'assessment')) this.apply(action);
    }
    if (received.size && this.investigationIds.size) this.refreshInvestigations(false);
  }
  private guardHide(id: string) {
    const known = this.host.runningWork();
    const pendingSessions = new Set<string>();
    for (const command of this.host.commands(this.pageId)) for (const action of command.actions) if (isCapabilityAction(action) && 'session' in action) pendingSessions.add(action.session.id);
    const active = [...this.work.values()].find(session => pendingSessions.has(session.id) && !session.reversed && session.ended_at === null)
      ?? (known && !pendingSessions.has(known.id) ? known : undefined);
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
    const parent = (id: string) => base ? this.baseBlocks.get(id)?.parent_id : this.cells.get(id)?.state.parentId;
    const visible = (id: string) => {
      for (let current: string | null | undefined = id; current; current = parent(current)) {
        const block = base ? this.baseBlocks.get(current) : this.cells.get(current)?.state;
        if (!block || block.archived) return false;
      }
      return true;
    };
    for (const value of values) if (value.assessment) {
      let questionId: string | null = null;
      for (let id = parent(value.block_id); id; id = parent(id)) {
        if (byId.get(id)?.question) { questionId = id; break; }
      }
      value.assessment.question_id = questionId;
      value.assessment.accepted = visible(value.block_id) && questionId !== null
        && byId.get(questionId)?.question?.state.accepted === value.block_id;
    }
    for (const value of values) {
      if (value.question) {
        const answer = value.question.state.accepted ? byId.get(value.question.state.accepted)?.assessment : null;
        value.question.status = questionStatus(value.question.state, Boolean(answer?.accepted && answer.question_id === value.block_id));
      }
      const current = this.cells.get(value.block_id)?.state;
      if (base || !sameState(current?.question, value.question) || !sameState(current?.assessment, value.assessment)) this.updateCapabilities(value, base);
    }
  }
  /** Applies only touched blocks/subtrees; inverse size follows the edit, not the page. */
  apply(action: Action, base = false): Action[] {
    const inverse = this.applyAction(action, base);
    if (['question', 'assessment', 'move', 'archive', 'delete', 'restore', 'merge'].includes(action.kind)) this.refreshInvestigations(base);
    return inverse;
  }
  private applyAction(action: Action, base = false): Action[] {
    const index = base ? this.baseOutline : this.outline;
    switch (action.kind) {
      case 'task':
      case 'project': {
        const value = this.capabilities(action.id, base);
        const previous = value[action.kind];
        if (action.kind === 'task') value.task = action.value;
        else value.project = action.value;
        this.updateCapabilities(value, base);
        return [action.kind === 'task'
          ? { ...action, value: previous as typeof action.value, previous: action.value, restore: previous?.status === 'done' && action.value !== null && action.value.status !== 'done' }
          : { ...action, value: previous as typeof action.value, previous: action.value }];
      }
      case 'position': {
        const value = this.capabilities(action.id, base);
        const previous = !!value.position;
        value.position = action.value ? { holder_id: null, subject_id: this.pageId } : null;
        this.updateCapabilities(value, base);
        return [{ ...action, value: previous, previous: action.value }];
      }
      case 'question': {
        const value = this.capabilities(action.id, base);
        const previous = value.question?.state ?? null;
        value.question = action.value ? { state: action.value, status: questionStatus(action.value, false) } : null;
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
        value.source = action.value ? {
          block_id: action.id, added_at: Date.now(), state_changed_at: Date.now(), last_read_at: null, current_snapshot_id: null,
          siglum: '?', siglum_basis: '?', siglum_authored: false,
          ...value.source, ...action.value,
        } : null;
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
        const completed = action.previous.repeater ? action.previous : { ...action.previous, status: 'done' as const, completed_on: action.completedOn };
        value.task = completed; value.history = true;
        this.updateCapabilities(value, base);
        return [{ kind: 'reverseTaskCompletion', id: action.id, occurrenceId: action.occurrenceId, completedOn: action.completedOn, value: action.previous, previous: completed, baseRevision: action.baseRevision }];
      }
      case 'reverseTaskCompletion': {
        const value = this.capabilities(action.id, base);
        value.task = action.value;
        // Other occurrences or work may remain; only the server can clear history.
        this.updateCapabilities(value, base);
        return [{ kind: 'completeTask', id: action.id, occurrenceId: ulid(), completedOn: action.completedOn, previous: action.value, baseRevision: action.baseRevision }];
      }
      case 'startWork':
      case 'stopWork':
      case 'workNote':
      case 'workState': {
        const old = action.session;
        const value = action.kind === 'startWork' ? old : action.kind === 'workNote' ? { ...old, note: action.note }
          : action.kind === 'stopWork' ? { ...old, ended_at: action.endedAt, note: action.note }
          : { ...old, ended_at: action.endedAt, reversed: action.reversed };
        const capability = this.capabilities(action.id, base);
        if (!value.reversed) capability.history = true;
        this.updateCapabilities(capability, base);
        if (!base) this.work.set(old.id, value);
        if (action.kind === 'workNote') return [{ ...action, session: value, note: old.note }];
        const inverse: Action[] = [{ kind: 'workState', id: action.id, session: value, endedAt: old.ended_at, reversed: action.kind === 'startWork' ? true : old.reversed, baseRevision: action.baseRevision }];
        if (action.kind === 'stopWork' && old.note !== action.note) inverse.push({ kind: 'workNote', id: action.id, session: value, note: old.note, baseRevision: action.baseRevision });
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
      case 'text': {
        const old = this.snapshot(action.id, base).text;
        this.changed(action.id, { text: action.text }, base);
        return [{ kind: 'text', id: action.id, text: old }];
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
      case 'addType':
      case 'removeType': {
        this.snapshot(action.id, base);
        const previous = base ? this.baseManualTypes.get(action.id) ?? [] : this.cells.get(action.id)!.state.manual_types;
        const key = action.title.toLowerCase();
        const old = previous.find(title => title.toLowerCase() === key);
        const titles = action.kind === 'addType'
          ? old === undefined ? [...previous, action.title] : [...previous]
          : previous.filter(title => title.toLowerCase() !== key);
        if (base) this.baseManualTypes.set(action.id, titles);
        else this.cells.get(action.id)!.set({ manual_types: titles, pending: true });
        return old === undefined
          ? action.kind === 'addType' ? [{ kind: 'removeType', id: action.id, title: action.title }] : []
          : action.kind === 'removeType' ? [{ kind: 'addType', id: action.id, title: old }] : [];
      }
      case 'insert': {
        const block = { ...action.block };
        if (block.parent_id && index.indexOf(block.id) >= 0) {
          if (!base) this.put({ ...(this.baseBlocks.get(block.id) ?? block), text: block.text }, true);
          return [{ kind: 'delete', id: block.id }];
        }
        if (base) this.baseBlocks.set(block.id, block); else this.put(block, true);
        if (block.parent_id) {
          const depth = block.parent_id === this.pageId ? 0 : index.depth(block.parent_id) + 1;
          const at = action.after ? index.subtreeEnd(index.indexOf(action.after)) : block.parent_id === this.pageId ? 0 : index.indexOf(block.parent_id) + 1;
          index.splice(at, 0, [{ id: block.id, parentId: block.parent_id, depth }]);
        }
        return [{ kind: 'delete', id: block.id }];
      }
      case 'delete': {
        if (!base) this.guardHide(action.id);
        const at = index.indexOf(action.id);
        const rows = action.id === this.pageId ? index.slice(0, index.size()) : at < 0 ? [] : index.slice(at, index.subtreeEnd(at));
        const after = at < 0 ? null : index.previousSibling(action.id);
        const snapshots: Snapshot[] = rows.map(row => ({ row, block: this.snapshot(row.id, base), manual_types: [...(base ? this.baseManualTypes.get(row.id) ?? [] : this.cells.get(row.id)!.state.manual_types)], capabilities: this.capabilities(row.id, base) }));
        if (action.id === this.pageId) snapshots.unshift({ row: null, block: this.snapshot(action.id, base), manual_types: [], capabilities: this.capabilities(action.id, base) });
        if (at >= 0) index.splice(at, rows.length, []);
        else if (action.id === this.pageId) index.replace([]);
        if (!base) for (const snapshot of snapshots) {
          this.cells.delete(snapshot.block.id); this.conflicts.delete(snapshot.block.id);
          this.investigationIds.delete(snapshot.block.id);
          this.presenceChanged(snapshot.block.id); this.host.publish(null, snapshot.block.id);
        }
        if (!base) this.conflictVersion[1](value => value + 1);
        if (!base && action.id === this.pageId) this.host.updateRoot(null, this.pageId);
        return [{ kind: 'restore', id: action.id, snapshots, after }];
      }
      case 'restore': {
        const rows = action.snapshots.flatMap(snapshot => snapshot.row && index.indexOf(snapshot.block.id) < 0 ? [{ ...snapshot.row }] : []);
        for (const { block, manual_types, capabilities } of action.snapshots) {
          if (base) { this.baseBlocks.set(block.id, { ...block }); this.baseManualTypes.set(block.id, manual_types); this.baseCapabilities.set(block.id, capabilities ?? emptyCapabilities(block.id)); }
          else this.put(block, true, manual_types, capabilities ?? emptyCapabilities(block.id));
          if (!base && block.kind !== 'block') this.host.updateRoot(block);
        }
        if (rows.length) {
          const parent = rows[0]!.parentId;
          const at = action.after && index.indexOf(action.after) >= 0 ? index.subtreeEnd(index.indexOf(action.after)) : parent === this.pageId ? 0 : index.indexOf(parent) + 1;
          index.splice(at, 0, rows);
        }
        if (!base && action.id === this.pageId) { this.loadStatus[1]('ready'); this.loadMessage[1](''); }
        return [{ kind: 'delete', id: action.id }];
      }
      case 'move': {
        if (index.indexOf(action.id) < 0) throw new Error('The block to move no longer exists.');
        if (!base) for (let ancestor: string | null = action.parentId; ancestor; ancestor = this.block(ancestor)?.parentId ?? null) if (this.block(ancestor)?.archived) { this.guardHide(action.id); break; }
        const inverse: Action = { kind: 'move', id: action.id, parentId: index.parentOf(action.id), after: index.previousSibling(action.id) };
        const after = action.after && index.parentOf(action.after) === action.parentId ? action.after : null;
        index.move(action.id, action.parentId, after);
        this.changed(action.id, { parent_id: action.parentId }, base);
        return [inverse];
      }
    }
  }
  merge(view: PageView, detectConflicts = true) {
    if (this.closed) return;
    this.syncGeneration++;
    this.host.cachePage(view);
    const conflicts = new Map<string, BlockState['conflict']>();
    const pendingText = this.pendingText();
    const pending = this.host.commands(this.pageId);
    const latestText = new Map<string, string>();
    const originalText = new Map<string, string>();
    for (const command of pending) {
      for (const action of command.actions) {
        if (action.kind === 'text') latestText.set(action.id, action.text);
        if (action.kind === 'insert' || action.kind === 'split') { latestText.set(action.block.id, action.block.text); if (!originalText.has(action.block.id)) originalText.set(action.block.id, action.block.text); }
        if (action.kind === 'split') latestText.set(action.id, action.left);
        if (action.kind === 'merge') latestText.set(action.destinationId, action.text);
      }
      for (const action of command.inverse) if (action.kind === 'text' && !originalText.has(action.id)) originalText.set(action.id, action.text);
    }
    for (const incoming of [view.root, ...view.rows.map(row => row.block)]) {
      const local = this.block(incoming.id);
      const old = this.baseBlocks.get(incoming.id);
      const expected = originalText.get(incoming.id) ?? old?.text;
      const localText = local?.text ?? latestText.get(incoming.id);
      if (local?.conflict) conflicts.set(incoming.id, local.conflict);
      if (detectConflicts && pendingText.has(incoming.id) && expected !== undefined && expected !== incoming.text && localText !== incoming.text) {
        conflicts.set(incoming.id, { remoteText: incoming.text, remoteRevision: incoming.revision });
      }
    }
    batch(() => {
      this.baseBlocks.clear();
      this.baseManualTypes.clear();
      this.baseCapabilities.clear();
      for (const value of view.capabilities ?? []) this.baseCapabilities.set(value.block_id, structuredClone(value));
      for (const row of view.rows) this.baseManualTypes.set(row.block.id, row.manual_types);
      for (const block of [view.root, ...view.rows.map(row => row.block)]) this.baseBlocks.set(block.id, { ...block });
      const rows = view.rows.map(({ block, depth }) => ({ id: block.id, parentId: block.parent_id!, depth }));
      this.baseOutline.replace(rows);
      for (const id of this.cells.keys()) if (!this.baseBlocks.has(id)) { this.cells.delete(id); this.presenceChanged(id); }
      for (const block of this.baseBlocks.values()) this.put(block, false, this.baseManualTypes.get(block.id) ?? [], this.capabilities(block.id, true));
      this.outline.replace(rows);
      for (const command of this.host.commands(this.pageId)) {
        for (const action of command.actions) {
          try { this.apply(action); }
          catch (error) { command.failed = `A structural change could not be applied: ${error instanceof Error ? error.message : String(error)}`; }
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
          if (!following.some(item => item.actions.some(action => action.kind === 'text' && action.id === choice.id))) cell.set('text', choice.localText);
          this.resolving.add(choice.id);
          return true;
        });
      }
      // put() wrote every saved cell above; only local commands, conflicts and resolutions can differ from it.
      this.refreshPending(new Set([...this.pendingIds(), ...this.conflicts, ...this.resolving]));
      this.conflictVersion[1](value => value + 1);
      if (!this.outline.size() && this.root() && this.root()!.revision > 0) {
        const block: Block = { id: ulid(), kind: 'block', parent_id: this.pageId, page_id: this.pageId, text: '', heading: null, archived: false, revision: 0, created_at: Date.now(), updated_at: Date.now() };
        const action: Action = { kind: 'insert', block, after: null };
        const inverse = this.apply(action);
        this.host.enqueue(this, [action], inverse, null, { id: block.id, offset: 0 }, false);
      }
      this.loadStatus[1]('ready');
      this.loadMessage[1]('');
    });
    for (const target of view.targets) this.host.publish(target);
    this.host.cachePage(view);
  }
  pendingText() {
    const ids = new Set<string>();
    for (const command of this.host.commands(this.pageId)) for (const action of command.actions) {
      if (action.kind === 'text') ids.add(action.id);
      else if (action.kind === 'split') { ids.add(action.id); ids.add(action.block.id); }
      else if (action.kind === 'merge') ids.add(action.destinationId);
      else if (action.kind === 'insert') ids.add(action.block.id);
    }
    return ids;
  }
  hasConflict() { this.conflictVersion[0](); return this.conflicts.size > 0; }
  receive(block: Block) {
    const previous = this.baseBlocks.get(block.id);
    const cell = this.cells.get(block.id);
    if (!previous && !cell) return;
    if (previous && block.revision <= previous.revision) {
      if (cell) this.host.publish(this.snapshot(block.id));
      return;
    }
    this.baseBlocks.set(block.id, { ...block });
    this.syncGeneration++;
    if (!cell) return;
    const commands = this.host.commands(this.pageId);
    const pending = commands.some(command => command.actions.some(action => action.kind === 'insert' ? action.block.id === block.id : action.kind === 'split' ? action.id === block.id || action.block.id === block.id : action.kind === 'merge' ? action.id === block.id || action.destinationId === block.id : action.id === block.id));
    let previousText = previous?.text;
    if (previousText === undefined) for (const command of commands) {
      const inserted = command.actions.find(action => (action.kind === 'insert' || action.kind === 'split') && action.block.id === block.id);
      if (inserted?.kind === 'insert' || inserted?.kind === 'split') { previousText = inserted.block.text; break; }
    }
    if (this.pendingText().has(block.id) && previousText !== block.text && cell.state.text !== block.text) {
      cell.set('conflict', { remoteText: block.text, remoteRevision: block.revision });
      this.conflicts.add(block.id);
      this.resolving.delete(block.id);
      cell.set('revision', block.revision);
    } else if (!pending) this.put(block);
    else cell.set('revision', block.revision);
    this.host.publish(this.snapshot(block.id));
    this.conflictVersion[1](value => value + 1);
  }
  acknowledged(command: Command, revisions: Map<string, number>, rewrites: readonly TextRewrite[], receipt?: Committed) {
    const previousRevisions = new Map([...revisions.keys()].map(id => [id, this.baseBlocks.get(id)?.revision ?? 0]));
    const sentRevisions = new Map<string, number>();
    const sent: Batch | undefined = command.frozen ? JSON.parse(command.frozen) : undefined;
    for (const operation of sent?.operations ?? []) if ('id' in operation && 'base_revision' in operation && typeof operation.base_revision === 'number' && !sentRevisions.has(operation.id)) sentRevisions.set(operation.id, operation.base_revision);
    batch(() => {
      this.syncGeneration++;
      for (const rewrite of rewrites) {
        const block = this.baseBlocks.get(rewrite.id);
        if (block && block.revision <= rewrite.revision) this.receive({ ...block, text: rewrite.after, revision: rewrite.revision });
      }
      for (const action of command.actions) {
        const id = action.kind === 'insert' ? action.block.id : action.id;
        const acknowledgedRevision = revisions.get(id);
        if (action.kind === 'split') {
          if ((this.baseBlocks.get(id)?.revision ?? 0) <= (acknowledgedRevision ?? 0)) this.apply({ kind: 'text', id, text: action.left }, true);
          const saved = this.baseBlocks.get(action.block.id);
          const block = saved && saved.revision > (revisions.get(saved.id) ?? 0) ? saved : action.block;
          this.apply({ kind: 'insert', block, after: action.id }, true);
          continue;
        }
        if (acknowledgedRevision !== undefined && (this.baseBlocks.get(id)?.revision ?? 0) > acknowledgedRevision) {
          if (action.kind === 'insert' && this.baseOutline.indexOf(id) < 0) this.apply({ ...action, block: this.snapshot(id, true) }, true);
          continue;
        }
        if (action.kind === 'delete' && !this.baseBlocks.has(id)) continue;
        if (action.kind === 'text' && action.baseRevision !== undefined && !this.baseBlocks.has(id)) continue;
        if (action.kind === 'merge') {
          const destination = this.baseBlocks.get(action.destinationId);
          this.apply(destination && destination.revision > (revisions.get(destination.id) ?? 0) ? { ...action, text: destination.text } : action, true);
        } else this.apply(action, true);
      }
      for (const [id, revision] of revisions) {
        const block = this.baseBlocks.get(id);
        if (block && block.revision <= revision) block.revision = revision;
        const cell = this.cells.get(id);
        if (cell && cell.state.revision <= revision) cell.set('revision', revision);
      }
      const capabilityRows = receipt?.capabilities ?? [];
      const allActions = [
        ...this.host.commands(this.pageId).filter(item => !item.frozen).flatMap(item => [...item.actions, ...item.inverse]),
        ...[...this.undoStack, ...this.redoStack].flatMap(entry => [...entry.forward, ...entry.inverse]),
      ];
      for (const action of allActions) if (isCapabilityAction(action)) {
        const revision = revisions.get(action.id);
        if (revision !== undefined && (previousRevisions.get(action.id) ?? 0) <= revision
          && (action.baseRevision === previousRevisions.get(action.id) || action.baseRevision === sentRevisions.get(action.id))) action.baseRevision = revision;
        if (action.kind === 'reverseTaskCompletion' && command.actions.some(sent => sent.kind === 'completeTask' && sent.occurrenceId === action.occurrenceId)) {
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
      if (command.actions.some(action => action.kind === 'restore' && action.id === this.pageId)) { this.loadStatus[1]('ready'); this.loadMessage[1](''); }
    });
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
      for (const action of command.actions) if (action.kind === 'text' && action.baseRevision !== undefined) {
        const pair = history.entry.rewrites?.get(action.id);
        if (pair) { const desired = history.undo ? pair.before : pair.after; action.text = desired.text; action.baseRevision = desired.baseRevision; }
      }
      const present = new Set(command.actions.map(action => action.kind === 'insert' ? action.block.id : action.id));
      for (const action of actions) if (action.kind === 'text' && action.baseRevision !== undefined && !present.has(action.id)) command.actions.push({ ...action });
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
      entry.rewrites ??= new Map();
      let pair = entry.rewrites.get(rewrite.id);
      if (!pair) {
        if (!copied) { entry.inverse = [...entry.inverse]; entry.forward = [...entry.forward]; copied = true; }
        pair = {
          before: { kind: 'text', id: rewrite.id, text: undo ? rewrite.after : rewrite.before, baseRevision: rewrite.revision },
          after: { kind: 'text', id: rewrite.id, text: undo ? rewrite.before : rewrite.after, baseRevision: rewrite.revision },
        };
        entry.rewrites.set(rewrite.id, pair);
        entry.inverse.push(pair.before);
        entry.forward.push(pair.after);
        let guards = this.guardHistories.get(rewrite.id);
        if (!guards) { guards = new Set(); this.guardHistories.set(rewrite.id, guards); }
        guards.add(entry);
      } else if (!undo) pair.after.text = rewrite.after;
      pair.before.baseRevision = rewrite.revision;
      pair.after.baseRevision = rewrite.revision;
    }
    const changed = rewrites.length ? this.syncHistoryCommands(new Set([entry])) : [];
    this.pruneHistory(entry);
    return changed;
  }
  refreshGuardVersions(blocks: readonly Block[], revisions: ReadonlyMap<string, number>): Command[] {
    let changed: Set<HistoryEntry> | undefined;
    for (const block of blocks) for (const entry of this.guardHistories.get(block.id) ?? []) {
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
    for (const command of this.host.commands(this.pageId)) for (const action of command.actions) {
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
      if (!pending.has(id) && !this.resolving.has(id) && cell.state.conflict && cell.state.text === this.baseBlocks.get(id)?.text) {
        cell.set('conflict', null); this.conflicts.delete(id); this.conflictVersion[1](value => value + 1);
      }
      const saved = this.baseBlocks.get(id);
      if (saved && !pending.has(id) && !cell.state.conflict && !this.resolving.has(id)) {
        const value = this.capabilities(id, true);
        this.markArchived(id, saved.archived);
        cell.set({ text: saved.text, heading: saved.heading, archived: saved.archived, parentId: saved.parent_id, manual_types: this.baseManualTypes.get(id) ?? [], task: value.task, project: value.project, position: value.position ?? null, source: value.source ?? null, citations: value.citations ?? [], history: value.history, mergeProtected: value.merge_protected, reviewedCards: value.reviewed_cards });
      }
      this.host.publish(this.snapshot(id));
    }
  }
  view(): PageView {
    return { root: this.snapshot(this.pageId, true), rows: this.baseOutline.slice(0, this.baseOutline.size()).map(row => ({ block: this.snapshot(row.id, true), depth: row.depth, manual_types: this.baseManualTypes.get(row.id) ?? [] })), targets: [], capabilities: [...this.baseCapabilities.values()] };
  }
  edit(edit: Edit, caretBefore: Caret | null = null): EditResult {
    if (this.status() !== 'ready') return { ok: false, reason: 'This page is not ready.' };
    const actions: Action[] = [];
    let caret: Caret | null = caretBefore;
    const created: string[] = [];
    const insert = (parentId: string, after: string | null, text: string, heading: 1 | 2 | 3 | null = null) => {
      if (!this.block(parentId) && !created.includes(parentId)) throw new Error('The parent no longer exists.');
      const id = ulid();
      created.push(id);
      actions.push({ kind: 'insert', after, block: { id, kind: 'block', parent_id: parentId, page_id: this.pageId, text, heading, archived: false, revision: 0, created_at: Date.now(), updated_at: Date.now() } });
      return id;
    };
    const selected = (ids: string[], zoomRoot?: string | null) => {
      const set = new Set(ids);
      if (zoomRoot) {
        const start = this.outline.indexOf(zoomRoot);
        if (start < 0) return [];
        const end = this.outline.subtreeEnd(start);
        if (ids.some(id => { const at = this.outline.indexOf(id); return at <= start || at >= end; })) return [];
      }
      return ids.filter(id => {
        if (this.outline.indexOf(id) < 0) throw new Error('A selected block no longer exists.');
        let parent = this.outline.parentOf(id);
        while (parent !== this.pageId) { if (set.has(parent)) return false; parent = this.outline.parentOf(parent); }
        return true;
      }).sort((a, b) => this.outline.indexOf(a) - this.outline.indexOf(b));
    };
    const move = (ids: string[], parentId: string, after: string | null) => {
      for (const id of ids) {
        let parent = parentId;
        while (parent !== this.pageId) { if (parent === id) throw new Error('A block cannot move into its own subtree.'); if (!this.block(parent)) throw new Error('The destination no longer exists.'); parent = this.outline.parentOf(parent); }
        if (after && !ids.includes(after) && this.outline.parentOf(after) !== parentId) throw new Error('The destination sibling no longer exists.');
        for (let ancestor: string | null = parentId; ancestor; ancestor = this.block(ancestor)?.parentId ?? null) if (this.block(ancestor)?.archived) { this.guardHide(id); break; }
        actions.push({ kind: 'move', id, parentId, after });
        after = id;
      }
    };
    const setText = (block: Block, text: string) => {
      if (block.text !== text) actions.push({ kind: 'text', id: block.id, text });
    };
    const guardSplit = (block: Block, prefix: string, suffix: string) => {
      if (!parseCardText(block.text).cards.length || !suffix && prefix === block.text) return;
      if (prefix || this.block(block.id)?.reviewedCards) throw new Error('This split would divide or move a card. Keep its source in one block.');
    };
    const split = (block: Block, prefix: string, suffix: string, zoomRoot?: string | null) => {
      if (block.heading !== null && !prefix && !suffix) {
        setText(block, '');
        actions.push({ kind: 'heading', id: block.id, heading: null });
        caret = { id: block.id, offset: 0 };
        return;
      }
      guardSplit(block, prefix, suffix);
      setText(block, prefix + suffix);
      const child = zoomRoot === block.id || !suffix && this.outline.children(block.id).length > 0;
      const id = insert(block.parent_id!, block.id, suffix, block.heading);
      const insertion = actions.pop() as Extract<Action, { kind: 'insert' }>;
      actions.push({ kind: 'split', id: block.id, block: insertion.block, left: prefix, right: suffix });
      if (child) actions.push({ kind: 'move', id, parentId: block.id, after: null });
      if (!suffix && block.heading !== null) actions.push({ kind: 'heading', id, heading: null });
      caret = { id, offset: 0 };
    };
    const paste = (block: Block, prefix: string, suffix: string, text: string, zoomRoot?: string | null) => {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) {
        setText(block, prefix + lines[0]! + suffix);
        caret = { id: block.id, offset: prefix.length + lines[0]!.length };
        return;
      }
      guardSplit(block, prefix, suffix);
      setText(block, prefix + suffix);
      const rightId = ulid();
      created.push(rightId);
      const right: Block = { ...block, id: rightId, text: suffix, revision: 0, heading: block.heading };
      actions.push({ kind: 'split', id: block.id, block: right, left: prefix, right: suffix });
      setText({ ...block, text: prefix }, prefix + lines[0]!);
      const zoom = zoomRoot === block.id;
      const stack = [{ width: 0, id: block.id, parentId: zoom ? block.id : block.parent_id! }];
      let zoomAfter: string | null = null;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const whitespace = /^\s*/.exec(line)![0];
        let width = 0;
        for (const char of whitespace) width += char === '\t' ? 2 : 1;
        while (stack.length > 1 && width < stack.at(-1)!.width) stack.pop();
        const previous = stack.at(-1)!;
        const nested = width > previous.width;
        const parentId = nested ? previous.id : previous.parentId;
        const after = zoom && parentId === block.id ? zoomAfter : nested ? null : previous.id;
        const body = line.slice(whitespace.length) + (i === lines.length - 1 ? suffix : '');
        let id: string;
        if (i === 1) {
          id = rightId;
          if (parentId !== block.parent_id || after !== block.id) actions.push({ kind: 'move', id, parentId, after });
          setText(right, body);
          if (right.heading !== null) actions.push({ kind: 'heading', id, heading: null });
        } else id = insert(parentId, after, body);
        if (zoom && parentId === block.id) zoomAfter = id;
        if (!nested) stack.pop();
        stack.push({ width, id, parentId });
        caret = { id, offset: line.length - whitespace.length };
      }
    };
    const replace = (range: TextRange, visible: string[], text: string, mode: 'text' | 'paste' | 'split', zoomRoot?: string | null) => {
      let { anchor: start, head: end } = range;
      if (this.outline.indexOf(start.id) < 0 || this.outline.indexOf(end.id) < 0) throw new Error('A selected block no longer exists.');
      if (this.outline.indexOf(start.id) > this.outline.indexOf(end.id) || start.id === end.id && start.offset > end.offset) [start, end] = [end, start];
      const first = this.snapshot(start.id);
      const last = this.snapshot(end.id);
      let startOffset = Math.max(0, Math.min(start.offset, first.text.length));
      let endOffset = Math.max(0, Math.min(end.offset, last.text.length));
      if (mode === 'split' && start.id === end.id && startOffset === endOffset) startOffset = endOffset = splitToken(first.text, startOffset)?.end ?? startOffset;
      else if (mode === 'split') {
        startOffset = splitToken(first.text, startOffset)?.start ?? startOffset;
        endOffset = splitToken(last.text, endOffset)?.end ?? endOffset;
      }
      if (mode === 'text' && !text && (start.id !== end.id || startOffset !== endOffset)) {
        for (const token of textTokens(first.text)) if (token.kind === 'reference' && startOffset > token.start && startOffset < token.end) startOffset = token.start;
        for (const token of textTokens(last.text)) if (token.kind === 'reference' && endOffset > token.start && endOffset < token.end) endOffset = token.end;
      }
      const between = this.outline.slice(this.outline.indexOf(start.id) + 1, this.outline.indexOf(end.id)).map(row => row.id);
      if (between.length !== visible.length || between.some((id, i) => id !== visible[i])) throw new Error('Expand hidden blocks before deleting this text range.');
      if (start.id !== end.id) this.guardMerge(end.id);
      const multiline = mode === 'split' || mode === 'paste' && /[\r\n]/.test(text);
      if (multiline && (parseCardText(first.text).cards.length || start.id !== end.id && parseCardText(last.text).cards.length)
        && !(start.id === end.id && startOffset === endOffset && endOffset === first.text.length)) {
        throw new Error('Replace this card in place before splitting its source.');
      }
      const deleted = start.id === end.id ? [] : selected([...between, end.id]);
      const removed = new Set([...between, end.id]);
      const preserved: string[] = [];
      for (const id of deleted) {
        const at = this.outline.indexOf(id);
        for (const row of this.outline.slice(at, this.outline.subtreeEnd(at))) {
          if (!removed.has(row.id) && removed.has(row.parentId)) preserved.push(row.id);
        }
      }
      const prefix = first.text.slice(0, startOffset);
      const suffix = last.text.slice(endOffset);
      if (preserved.length) {
        let after: string | null = this.outline.children(first.id).at(-1) ?? null;
        if (this.outline.indexOf(end.id) < this.outline.subtreeEnd(this.outline.indexOf(first.id))) {
          after = end.id;
          while (this.outline.parentOf(after) !== first.id) after = this.outline.parentOf(after);
        }
        move(preserved, first.id, after);
      }
      if (start.id !== end.id) actions.push({ kind: 'merge', id: end.id, destinationId: first.id, text: first.text + last.text });
      for (const id of deleted) if (id !== end.id) { this.guardHide(id); actions.push({ kind: 'delete', id }); }
      const merged = start.id === end.id ? first : { ...first, text: first.text + last.text };
      if (mode === 'split') split(merged, prefix + text, suffix, zoomRoot);
      else if (mode === 'paste') paste(merged, prefix, suffix, text, zoomRoot);
      else { setText(merged, prefix + text + suffix); caret = { id: first.id, offset: prefix.length + text.length }; }
    };
    try {
      switch (edit.kind) {
        case 'sourceDetails': {
          if (edit.title !== undefined) {
            const title = edit.title.trim();
            if (!title) throw new Error('A title is required.');
            if (!this.host.titleAvailable(title, this.pageId)) throw new Error('A page with this title already exists.');
            setText(this.snapshot(this.pageId), title);
          }
          let after = this.outline.children(this.pageId).at(-1) ?? null;
          for (const field of edit.fields) {
            const current = field.entries.flatMap(id => this.outline.children(id)).filter(id => !this.isArchived(id));
            let entry = field.entries[0];
            if (!entry && field.values.length) {
              entry = insert(this.pageId, after, `[[${field.id}]]`);
              after = entry;
            }
            let childAfter = entry ? this.outline.children(entry).at(-1) ?? null : null;
            for (let index = 0; index < Math.max(current.length, field.values.length); index++) {
              const id = current[index], text = field.values[index];
              if (id && text !== undefined) setText(this.snapshot(id), text);
              // Keep an empty authored override: reingest must not refill a deliberately cleared field.
              else if (id) setText(this.snapshot(id), '');
              else if (entry && text !== undefined) childAfter = insert(entry, childAfter, text);
            }
          }
          break;
        }
        case 'source': {
          const previous = sourceState(this.capabilities(edit.id).source);
          const value = sourceState(edit.value);
          if (!sameState(previous, value)) actions.push({ kind: 'source', id: edit.id, value, previous, baseRevision: this.snapshot(edit.id).revision });
          break;
        }
        case 'mergeHighlights': {
          for (const merge of edit.merges) {
            const id = merge.citation.block_id;
            const previous = this.capabilities(id).citations?.find(citation => citation.id === merge.citation.id);
            if (!previous) throw new Error('Citation not found.');
            const baseRevision = this.snapshot(id).revision;
            if (!sameState(previous.start, merge.citation.start) || !sameState(previous.end, merge.citation.end)) {
              actions.push({ kind: 'citationRange', id, citation: { ...merge.citation, color: previous.color }, previous, baseRevision });
              const block = this.snapshot(id);
              // Authored notes or card syntax stay intact; only a verbatim quote follows its evidence.
              if (block.text === previous.quote) setText(block, merge.citation.quote);
            }
            if (previous.color !== merge.citation.color) actions.push({ kind: 'highlightColor', id, citationId: previous.id, color: merge.citation.color, previous: previous.color, baseRevision });
            for (const citationId of merge.removeCitationIds ?? []) actions.push({ kind: 'uncite', id, citationId, baseRevision });
            let after = this.outline.children(id).at(-1) ?? null;
            const removedIds = [...merge.removeIds].sort((a, b) => this.outline.indexOf(b) - this.outline.indexOf(a));
            for (const removed of removedIds) {
              if (removed === id || !this.block(removed)) throw new Error('Highlight no longer exists.');
              this.guardHide(removed);
              // Hoist a survivor nested under a highlight that is being absorbed.
              let ancestor = this.block(id)?.parentId;
              while (ancestor && ancestor !== removed) ancestor = this.block(ancestor)?.parentId;
              if (ancestor === removed) actions.push({ kind: 'move', id, parentId: this.outline.parentOf(removed), after: removed });
              const children = this.outline.children(removed).filter(child => child !== id && !merge.removeIds.includes(child));
              for (const child of children) {
                actions.push({ kind: 'move', id: child, parentId: id, after });
                after = child;
              }
              actions.push({ kind: 'delete', id: removed });
            }
            caret = { id, offset: this.block(id)?.text.length ?? 0 };
            if (edit.note) caret = { id: insert(id, null, ''), offset: 0 };
          }
          break;
        }
        case 'cite':
        case 'highlight': {
          const id = edit.kind === 'highlight'
            ? insert(edit.parentId, edit.after === undefined ? this.outline.children(edit.parentId).at(-1) ?? null : edit.after, edit.text)
            : edit.id;
          const citation = edit.citation;
          actions.push({ kind: 'cite', id, baseRevision: edit.kind === 'highlight' ? 0 : this.snapshot(id).revision,
            citation: { id: citation.id, block_id: id, source_id: citation.sourceId, snapshot_id: citation.snapshotId,
              start: { ...citation.start }, end: { ...citation.end }, quote: citation.quote, locator: citation.locator, ordinal: citation.ordinal, triage: null, color: edit.kind === 'highlight' ? edit.color ?? null : null } });
          if (edit.kind === 'highlight') caret = edit.note ? { id: insert(id, null, ''), offset: 0 } : { id, offset: edit.text.length };
          break;
        }
        case 'uncite': {
          const baseRevision = this.snapshot(edit.id).revision;
          for (const citationId of new Set(edit.citationIds)) {
            if (this.block(edit.id)!.citations.some(citation => citation.id === citationId)) actions.push({ kind: 'uncite', id: edit.id, citationId, baseRevision });
          }
          break;
        }
        case 'citationTriage': {
          const citation = this.capabilities(edit.id).citations?.find(item => item.id === edit.citationId);
          if (!citation) throw new Error('Citation not found.');
          if (citation.triage !== edit.triage) actions.push({ kind: 'citationTriage', id: edit.id, citationId: edit.citationId, triage: edit.triage, previous: citation.triage, baseRevision: this.snapshot(edit.id).revision });
          break;
        }
        case 'highlightColor': {
          const citation = this.capabilities(edit.id).citations?.find(item => item.id === edit.citationId);
          if (!citation) throw new Error('Citation not found.');
          if (citation.color !== edit.color) actions.push({ kind: 'highlightColor', id: edit.id, citationId: edit.citationId, color: edit.color, previous: citation.color, baseRevision: this.snapshot(edit.id).revision });
          break;
        }
        case 'position': {
          const block = this.snapshot(edit.id);
          if (block.kind !== 'block') throw new Error('Only ordinary blocks can be perspectives.');
          const previous = !!this.capabilities(edit.id).position;
          if (previous !== edit.value) actions.push({ kind: 'position', id: edit.id, value: edit.value, previous, baseRevision: block.revision });
          break;
        }
        case 'question': {
          const previous = this.capabilities(edit.id).question?.state ?? null;
          if (edit.value && this.block(edit.id)?.assessment) throw new Error('A block cannot be both a question and an answer.');
          if ((previous?.parked || edit.value?.parked) && (previous?.accepted ?? null) !== (edit.value?.accepted ?? null)) throw new Error('Resume the question before accepting an answer.');
          if (!sameState(previous, edit.value)) actions.push({ ...edit, value: structuredClone(edit.value), previous, baseRevision: this.snapshot(edit.id).revision });
          break;
        }
        case 'assessment': {
          const previous = this.capabilities(edit.id).assessment?.state ?? null;
          if (edit.value) {
            if (this.block(edit.id)?.question) throw new Error('A block cannot be both a question and an answer.');
            let owner = this.block(edit.id)?.parentId;
            while (owner && !this.block(owner)?.question) owner = this.block(owner)?.parentId;
            if (!owner) throw new Error('Put the answer under a question first.');
            if (!previous && this.block(owner)?.question?.state.parked) throw new Error('Resume the question before answering it.');
          }
          if (!sameState(previous, edit.value)) actions.push({ ...edit, value: structuredClone(edit.value), previous, baseRevision: this.snapshot(edit.id).revision });
          break;
        }
        case 'task':
        case 'planTask':
        case 'project':
        case 'completeTask':
        case 'startWork':
        case 'stopWork':
        case 'workNote': {
          const block = this.snapshot(edit.id);
          const state = this.capabilities(edit.id);
          if (this.host.commands(this.pageId).some(command => command.actions.some(action => action.kind === 'completeTask' && action.id === edit.id && action.previous.repeater))) throw new Error('Wait for the recurring completion before changing this task.');
          const baseRevision = block.revision;
          if (edit.kind === 'task' || edit.kind === 'planTask') {
            const value = edit.value === null ? null : JSON.parse(JSON.stringify(edit.value));
            if (value?.status === 'done' && state.task?.status !== 'done') throw new Error('Complete the task to record its occurrence.');
            if (!state.task && value && value.status !== 'todo') throw new Error('A new task starts Todo.');
            if (!sameState(state.task, value)) actions.push({ kind: 'task', id: edit.id, value, previous: state.task, baseRevision });
            if (edit.kind === 'planTask') { setText(block, edit.text); caret = { id: edit.id, offset: edit.text.length }; }
          } else if (edit.kind === 'project') {
            const value = edit.value === null ? null : JSON.parse(JSON.stringify(edit.value));
            if (!sameState(state.project, value)) actions.push({ kind: 'project', id: edit.id, value, previous: state.project, baseRevision });
          } else if (edit.kind === 'completeTask') {
            let task = state.task;
            if (task?.status === 'done' && !task.repeater) break;
            if (!task) {
              task = { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };
              actions.push({ kind: 'task', id: edit.id, value: task, previous: null, baseRevision });
            }
            if (edit.stopWork) {
              if (edit.stopWork.block_id !== edit.id || edit.stopWork.ended_at !== null || edit.stopWork.reversed) throw new Error('Refresh the running work session before completing.');
              const known = this.work.get(edit.stopWork.id);
              if (known && known.revision >= edit.stopWork.revision && !sameState(known, edit.stopWork)) throw new Error('The work session changed. Refresh before completing.');
              actions.push({ kind: 'stopWork', id: edit.id, session: { ...edit.stopWork }, endedAt: Date.now(), note: edit.stopWork.note, baseRevision });
            }
            actions.push({ kind: 'completeTask', id: edit.id, occurrenceId: ulid(), completedOn: edit.completedOn, previous: task, baseRevision });
          } else if (edit.kind === 'startWork') {
            const active = this.host.runningWork();
            if (active) throw new Error('Stop the running work session before starting another.');
            actions.push({ kind: 'startWork', id: edit.id, session: { id: ulid(), block_id: edit.id, started_at: edit.startedAt, ended_at: null, note: '', reversed: false, revision: 0 }, baseRevision });
          } else {
            if (edit.session.block_id !== edit.id) throw new Error('The work session belongs to another task.');
            const session = { ...edit.session };
            const known = this.work.get(session.id);
            if (known && known.revision >= session.revision && !sameState(known, session)) throw new Error('The work session changed. Refresh before editing it.');
            if (edit.kind === 'stopWork') actions.push({ kind: 'stopWork', id: edit.id, session, endedAt: edit.endedAt, note: edit.note, baseRevision });
            else if (session.note !== edit.note) actions.push({ kind: 'workNote', id: edit.id, session, note: edit.note, baseRevision });
          }
          break;
        }
        case 'text':
          if (this.snapshot(edit.id).text !== edit.text) actions.push({ kind: 'text', id: edit.id, text: edit.text });
          if (edit.heading !== undefined && this.snapshot(edit.id).heading !== edit.heading) actions.push({ kind: 'heading', id: edit.id, heading: edit.heading });
          break;
        case 'heading': actions.push({ kind: 'heading', id: edit.id, heading: edit.level }); break;
        case 'archive':
          if (edit.archived) this.guardHide(edit.id);
          actions.push({ kind: 'archive', id: edit.id, archived: edit.archived });
          break;
        case 'addField': {
          const root = this.root();
          if (root?.kind !== 'page' || root.text.toLowerCase() !== 'fields') throw new Error('Field definitions belong on the Fields page.');
          if (!edit.name.trim()) throw new Error('A field needs a name.');
          const id = insert(this.pageId, this.outline.children(this.pageId).at(-1) ?? null, edit.name);
          if (edit.value !== 'text') actions.push({ kind: 'fieldKind', id, value: edit.value, previous: 'text' });
          caret = { id, offset: 0 };
          break;
        }
        case 'addFieldEntries': {
          if (!edit.entries.length) throw new Error('Choose a field.');
          if (edit.after && this.outline.parentOf(edit.after) !== edit.parentId) throw new Error('The destination sibling no longer exists.');
          let after = edit.after;
          let first: Caret | undefined;
          for (const entry of edit.entries) {
            after = insert(edit.parentId, after, `[[${entry.fieldId}]]`);
            const value = insert(after, null, entry.value);
            first ??= { id: value, offset: entry.value.length };
          }
          caret = first!;
          break;
        }
        case 'fieldKind': {
          const definition = edit.definition;
          if (this.snapshot(definition.id).revision !== definition.revision || this.block(definition.id)?.pending) throw new Error('The field changed. Refresh before changing its kind.');
          if (definition.kind !== edit.value) actions.push({ kind: 'fieldKind', id: definition.id, value: edit.value, previous: definition.kind, baseRevision: definition.revision });
          break;
        }
        case 'addType':
        case 'removeType': {
          const block = this.block(edit.id);
          if (!block) throw new Error('The block no longer exists.');
          if (!edit.title || edit.title.trim() !== edit.title || /[\[\]\r\n]/.test(edit.title)) throw new Error('Invalid type title.');
          const exists = block.manual_types.some(title => title.toLowerCase() === edit.title.toLowerCase());
          if (edit.kind === 'addType' && exists) break;
          if (edit.kind === 'removeType' && !exists) throw new Error('From the text. Edit the #tag there to remove it.');
          actions.push({ kind: edit.kind, id: edit.id, title: edit.title });
          break;
        }
        case 'insert': caret = { id: insert(edit.parentId, edit.after, edit.text ?? ''), offset: 0 }; break;
        case 'split': {
          const old = this.snapshot(edit.id);
          if (old.kind !== 'block') throw new Error('Only outline blocks can split.');
          const at = Math.max(0, Math.min(edit.offset, old.text.length));
          const offset = splitToken(old.text, at)?.end ?? at;
          split(old, old.text.slice(0, offset), old.text.slice(offset), edit.zoomRoot);
          break;
        }
        case 'merge': {
          const source = this.snapshot(edit.sourceId);
          const destination = this.snapshot(edit.destinationId);
          if (source.kind !== 'block') throw new Error('A page cannot merge into a block.');
          let parent = destination.id;
          while (parent !== this.pageId) { if (parent === source.id) throw new Error('Cannot merge into a descendant.'); parent = this.outline.parentOf(parent); }
          for (let ancestor: string | null = destination.id; ancestor; ancestor = this.block(ancestor)?.parentId ?? null) if (this.block(ancestor)?.archived) { this.guardHide(source.id); break; }
          this.guardMerge(source.id);
          actions.push({ kind: 'merge', id: source.id, destinationId: destination.id, text: destination.text + source.text });
          caret = { id: destination.id, offset: destination.text.length };
          break;
        }
        case 'delete': {
          const roots = selected(edit.ids);
          let removed = 0;
          for (const id of roots) { this.guardHide(id); actions.push({ kind: 'delete', id }); const at = this.outline.indexOf(id); removed += this.outline.subtreeEnd(at) - at; }
          caret = removed && removed === this.outline.size() ? { id: insert(this.pageId, null, ''), offset: 0 } : null;
          break;
        }
        case 'moveTo': move(selected(edit.ids), edit.parentId, edit.after); break;
        case 'indent': {
          const ids = selected(edit.ids, edit.zoomRoot);
          if (!ids.length) break;
          const parent = this.outline.previousSibling(ids[0]!);
          if (!parent) break;
          move(ids, parent, this.outline.children(parent).at(-1) ?? null);
          break;
        }
        case 'outdent': {
          const ids = selected(edit.ids, edit.zoomRoot);
          if (!ids.length) break;
          const parent = this.outline.parentOf(ids[0]!);
          if (parent === this.pageId || parent === edit.zoomRoot) break;
          move(ids, this.outline.parentOf(parent), parent);
          break;
        }
        case 'move': {
          const ids = selected(edit.ids, edit.zoomRoot);
          if (!ids.length) break;
          const parent = this.outline.parentOf(ids[0]!);
          if (ids.some(id => this.outline.parentOf(id) !== parent)) throw new Error('Move selection must contain siblings.');
          const siblings = this.outline.children(parent);
          const first = siblings.indexOf(ids[0]!);
          const last = siblings.indexOf(ids.at(-1)!);
          if (edit.direction === 'up') {
            if (first <= 0) break;
            move(ids, parent, siblings[first - 2] ?? null);
          } else {
            if (last + 1 >= siblings.length) break;
            move(ids, parent, siblings[last + 1]!);
          }
          break;
        }
        case 'deleteRange':
          replace(edit.range, edit.between, '', 'text');
          break;
        case 'replaceRange':
          replace(edit.range, edit.between, edit.text, edit.mode, edit.zoomRoot);
          break;
        case 'paste': {
          const block = this.snapshot(edit.at.id);
          paste(block, block.text.slice(0, edit.at.offset), block.text.slice(edit.at.offset), edit.text);
          break;
        }
      }
      if (!actions.length) return { ok: true, caret, created };
      const inverse: Action[] = [];
      batch(() => { for (const action of actions) {
        const undo = this.apply(action);
        if (edit.kind !== 'highlight' || action.kind !== 'cite') inverse.unshift(...undo);
      } });
      const beforeRange = edit.kind === 'replaceRange' ? edit.selectionBefore ?? edit.range : null;
      const before: HistoryCaret | null = beforeRange ? { ...(caretBefore ?? beforeRange.head), range: { anchor: { ...beforeRange.anchor }, head: { ...beforeRange.head } } } : caretBefore;
      const command = this.host.enqueue(this, actions, inverse, before, caret, edit.kind === 'text' && edit.heading === undefined);
      const last = this.undoStack.at(-1);
      const textGroup = edit.kind === 'text' && edit.heading === undefined && last?.forward.length === 1 && last.forward[0]!.kind === 'text' && last.forward[0]!.id === edit.id && Date.now() - this.lastTextEditAt < 1000;
      let entry: HistoryEntry;
      if (last && (last.commandId === command.id || textGroup)) { entry = last; entry.forward = [...command.actions]; entry.after = caret; }
      else { entry = { forward: actions, inverse, before, after: caret, commandId: command.id, commands: new Set(), applied: true, retained: true }; this.undoStack.push(entry); }
      this.rememberHistory(command, entry, false);
      this.lastTextEditAt = edit.kind === 'text' && edit.heading === undefined ? Date.now() : 0;
      const discarded = this.redoStack;
      this.redoStack = [];
      for (const entry of discarded) { entry.retained = false; this.pruneHistory(entry); }
      this.historyVersion[1](value => value + 1);
      return { ok: true, caret, created };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  rename(title: string): EditResult {
    if (this.root()?.kind !== 'page') return { ok: false, reason: 'Journal dates cannot be renamed.' };
    if (!title.trim()) return { ok: false, reason: 'A page needs a title.' };
    if (!this.host.titleAvailable(title.trim(), this.pageId)) return { ok: false, reason: 'A page with this title already exists.' };
    return this.edit({ kind: 'text', id: this.pageId, text: title.trim() });
  }
  addType(blockId: string, title: string): EditResult {
    return this.edit({ kind: 'addType', id: blockId, title });
  }
  removeType(blockId: string, title: string): EditResult {
    return this.edit({ kind: 'removeType', id: blockId, title });
  }
  private travel(undo: boolean): HistoryCaret | null {
    this.lastTextEditAt = 0;
    const from = undo ? this.undoStack : this.redoStack;
    const to = undo ? this.redoStack : this.undoStack;
    const entry = from.pop();
    if (!entry) return null;
    const actions = (undo ? entry.inverse : entry.forward).flatMap<Action>(action => {
      if (!undo && action.kind === 'fieldKind') return [{ ...action, baseRevision: undefined }];
      if (!undo && (action.kind === 'insert' || action.kind === 'split') && this.baseBlocks.has(action.block.id)) {
        const restored: Action = { kind: 'restore', id: action.block.id, snapshots: [{ block: action.block, manual_types: this.baseManualTypes.get(action.block.id) ?? [], capabilities: this.capabilities(action.block.id, true), row: { id: action.block.id, parentId: action.block.parent_id!, depth: action.block.parent_id === this.pageId ? 0 : this.outline.depth(action.block.parent_id!) + 1 } }], after: action.kind === 'split' ? action.id : action.after };
        return action.kind === 'split' ? [{ kind: 'text', id: action.id, text: action.left }, restored] : [restored];
      }
      return [{ ...action }];
    });
    try {
      const inverse: Action[] = [];
      batch(() => { for (const action of actions) {
        if (action.kind === 'text' && action.baseRevision !== undefined && !this.cells.has(action.id)) continue;
        inverse.unshift(...this.apply(action));
      } });
      const command = this.host.enqueue(this, actions, inverse, undo ? entry.after : entry.before, undo ? entry.before : entry.after, false);
      // A highlight's delete inverse restores its citations with the block;
      // replaying the original insert + cite would cite already-active evidence.
      if (actions.some(isCapabilityAction) || entry.forward.some(action => action.kind === 'cite')) {
        if (undo) entry.forward = inverse;
        else entry.inverse = inverse;
      }
      entry.applied = !undo;
      this.rememberHistory(command, entry, undo, true);
      to.push(entry);
      this.historyVersion[1](value => value + 1);
      return undo ? entry.before : entry.after;
    } catch { from.push(entry); return null; }
  }
  undo() { return this.travel(true); }
  redo() { return this.travel(false); }
  resolveConflict(id: string, keep: 'mine' | 'theirs') {
    const cell = this.cells.get(id);
    if (!cell?.state.conflict) return;
    const text = keep === 'mine' ? cell.state.text : cell.state.conflict.remoteText;
    this.resolving.add(id);
    // Update existing rejected/unsent text in place; no frozen request is altered.
    let found = false;
    const choice = { id, text, localText: cell.state.text, remoteRevision: cell.state.conflict.remoteRevision, deferred: false };
    for (const command of this.host.commands(this.pageId)) {
      if (!command.actions.some(action => action.kind === 'text' && action.id === id)) continue;
      found = true;
      command.resolutions = [...(command.resolutions ?? []).filter(item => item.id !== id), { ...choice, deferred: Boolean(command.frozen) }];
      if (!command.frozen) for (const action of command.actions) if (action.kind === 'text' && action.id === id) action.text = text;
      command.failed = undefined;
    }
    if (!found) {
      const command = this.host.enqueue(this, [{ kind: 'text', id, text }], [{ kind: 'text', id, text: cell.state.text }], null, null, false);
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
    if (entry) { entry.retained = false; this.pruneHistory(entry); }
    this.historyVersion[1](value => value + 1);
  }
  conflictResolved(id: string) { this.cells.get(id)?.set('conflict', null); this.resolving.delete(id); this.conflicts.delete(id); this.conflictVersion[1](value => value + 1); }
  localText() { return [...this.pendingText()].map(id => this.block(id)?.text ?? '').join('\n'); }
}
