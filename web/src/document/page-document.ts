import { batch, createSignal } from 'solid-js';
import type { Signal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Block, PageView, TextRewrite } from '../api/types';
import type { BlockState, Caret, Edit, EditResult, HistoryCaret, PageDocument, SaveState, TextRange } from './contract';
import { OutlineIndex } from './outline-index';
import type { Action, Command, HistoryEntry, Snapshot } from './types';

export interface DocumentHost {
  ready: Promise<void>;
  commands(pageId: string): Command[];
  loadPage(id: string): Promise<PageView>;
  cachePage(view: PageView): void;
  enqueue(doc: Document, actions: Action[], inverse: Action[], before: Caret | null, after: Caret | null, coalesce: boolean): Command;
  state(pageId?: string): SaveState;
  message(pageId?: string): string;
  publish(block: Block | null, id?: string): void;
  updateRoot(block: Block | null, id?: string): void;
  release(doc: Document): void;
  retry(): void;
  titleAvailable(title: string, exceptId: string): boolean;
}
type MutableBlockState = { -readonly [K in keyof BlockState]: BlockState[K] };
interface Cell { state: MutableBlockState; set: SetStoreFunction<MutableBlockState> }
const stateOf = (block: Block): BlockState => ({ id: block.id, kind: block.kind, parentId: block.parent_id, pageId: block.page_id, text: block.text, heading: block.heading, archived: block.archived, revision: block.revision, pending: false, conflict: null });

export class Document implements PageDocument {
  readonly outline: OutlineIndex;
  readonly baseOutline: OutlineIndex;
  readonly baseBlocks = new Map<string, Block>();
  private cells = new Map<string, Cell>();
  private presence = new Map<string, Signal<number>>();
  private conflictVersion = createSignal(0);
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
  needsRefresh(blocks: readonly Block[], removed: readonly string[]) {
    if (this.status() !== 'ready') return true;
    return blocks.some(block => block.page_id === this.pageId && (this.baseBlocks.get(block.id)?.revision ?? -1) < block.revision)
      || removed.some(id => this.cells.has(id));
  }
  saveState() { return this.host.state(this.pageId); }
  saveMessage() { return this.host.message(this.pageId); }
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
  private fail(error: unknown) {
    this.loadStatus[1](error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
    this.loadMessage[1](error instanceof Error ? error.message : String(error));
  }
  markMissing() {
    this.loadStatus[1]('missing');
    this.loadMessage[1]('This page has been deleted.');
  }
  isResolving(id: string) { return this.resolving.has(id); }
  private put(block: Block, pending = false) {
    const cell = this.cells.get(block.id);
    if (cell) cell.set({ ...stateOf(block), pending, conflict: cell.state.conflict });
    else {
      const [state, set] = createStore<MutableBlockState>({ ...stateOf(block), pending });
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
  /** Applies only touched blocks/subtrees; inverse size follows the edit, not the page. */
  apply(action: Action, base = false): Action[] {
    const index = base ? this.baseOutline : this.outline;
    switch (action.kind) {
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
        const old = this.snapshot(action.id, base).archived;
        this.changed(action.id, { archived: action.archived }, base);
        return [{ kind: 'archive', id: action.id, archived: old }];
      }
      case 'fieldKind':
        this.changed(action.id, {}, base);
        return [{ kind: 'fieldKind', id: action.id, value: action.previous, previous: action.value }];
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
        const at = index.indexOf(action.id);
        const rows = action.id === this.pageId ? index.slice(0, index.size()) : at < 0 ? [] : index.slice(at, index.subtreeEnd(at));
        const after = at < 0 ? null : index.previousSibling(action.id);
        const snapshots: Snapshot[] = rows.map(row => ({ row, block: this.snapshot(row.id, base) }));
        if (action.id === this.pageId) snapshots.unshift({ row: null, block: this.snapshot(action.id, base) });
        if (at >= 0) index.splice(at, rows.length, []);
        else if (action.id === this.pageId) index.replace([]);
        if (!base) for (const snapshot of snapshots) {
          this.cells.delete(snapshot.block.id); this.conflicts.delete(snapshot.block.id);
          this.presenceChanged(snapshot.block.id); this.host.publish(null, snapshot.block.id);
        }
        if (!base) this.conflictVersion[1](value => value + 1);
        if (!base && action.id === this.pageId) this.host.updateRoot(null, this.pageId);
        return [{ kind: 'restore', id: action.id, snapshots, after }];
      }
      case 'restore': {
        const rows = action.snapshots.flatMap(snapshot => snapshot.row && index.indexOf(snapshot.block.id) < 0 ? [{ ...snapshot.row }] : []);
        for (const { block } of action.snapshots) {
          if (base) this.baseBlocks.set(block.id, { ...block }); else this.put(block, true);
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
        if (action.kind === 'insert') { latestText.set(action.block.id, action.block.text); if (!originalText.has(action.block.id)) originalText.set(action.block.id, action.block.text); }
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
      for (const block of [view.root, ...view.rows.map(row => row.block)]) this.baseBlocks.set(block.id, { ...block });
      const rows = view.rows.map(({ block, depth }) => ({ id: block.id, parentId: block.parent_id!, depth }));
      this.baseOutline.replace(rows);
      for (const id of this.cells.keys()) if (!this.baseBlocks.has(id)) { this.cells.delete(id); this.presenceChanged(id); }
      for (const block of this.baseBlocks.values()) this.put(block);
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
      this.refreshPending();
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
    const pending = commands.some(command => command.actions.some(action => action.kind === 'insert' ? action.block.id === block.id : action.id === block.id));
    let previousText = previous?.text;
    if (previousText === undefined) for (const command of commands) {
      const inserted = command.actions.find(action => action.kind === 'insert' && action.block.id === block.id);
      if (inserted?.kind === 'insert') { previousText = inserted.block.text; break; }
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
  acknowledged(command: Command, revisions: Map<string, number>, rewrites: readonly TextRewrite[]) {
    batch(() => {
      this.syncGeneration++;
      for (const rewrite of rewrites) {
        const block = this.baseBlocks.get(rewrite.id);
        if (block && block.revision <= rewrite.revision) this.receive({ ...block, text: rewrite.after, revision: rewrite.revision });
      }
      for (const action of command.actions) {
        const id = action.kind === 'insert' ? action.block.id : action.id;
        const acknowledgedRevision = revisions.get(id);
        if (acknowledgedRevision !== undefined && (this.baseBlocks.get(id)?.revision ?? 0) > acknowledgedRevision) {
          if (action.kind === 'insert' && this.baseOutline.indexOf(id) < 0) this.apply({ ...action, block: this.snapshot(id, true) }, true);
          continue;
        }
        if (action.kind === 'delete' && !this.baseBlocks.has(id)) continue;
        if (action.kind === 'text' && action.baseRevision !== undefined && !this.baseBlocks.has(id)) continue;
        this.apply(action, true);
      }
      for (const [id, revision] of revisions) {
        const block = this.baseBlocks.get(id);
        if (block && block.revision <= revision) block.revision = revision;
        const cell = this.cells.get(id);
        if (cell && cell.state.revision <= revision) cell.set('revision', revision);
      }
      const touched = new Set(revisions.keys());
      for (const action of command.actions) touched.add(action.kind === 'insert' ? action.block.id : action.id);
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
  refreshPending(touched?: Set<string>) {
    const pending = new Set<string>();
    for (const command of this.host.commands(this.pageId)) for (const action of command.actions) {
      pending.add(action.kind === 'insert' ? action.block.id : action.id);
      if (action.kind === 'restore') for (const snapshot of action.snapshots) pending.add(snapshot.block.id);
    }
    for (const id of touched ?? this.cells.keys()) {
      const cell = this.cells.get(id);
      if (!cell) continue;
      cell.set('pending', pending.has(id));
      if (!pending.has(id) && !this.resolving.has(id) && cell.state.conflict && cell.state.text === this.baseBlocks.get(id)?.text) {
        cell.set('conflict', null); this.conflicts.delete(id); this.conflictVersion[1](value => value + 1);
      }
      const saved = this.baseBlocks.get(id);
      if (saved && !pending.has(id) && !cell.state.conflict && !this.resolving.has(id)) cell.set({ text: saved.text, heading: saved.heading, archived: saved.archived, parentId: saved.parent_id });
      this.host.publish(this.snapshot(id));
    }
  }
  view(): PageView {
    return { root: this.snapshot(this.pageId, true), rows: this.baseOutline.slice(0, this.baseOutline.size()).map(row => ({ block: this.snapshot(row.id, true), depth: row.depth })), targets: [] };
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
    const selected = (ids: string[]) => {
      const set = new Set(ids);
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
        actions.push({ kind: 'move', id, parentId, after });
        after = id;
      }
    };
    const setText = (block: Block, text: string) => {
      if (block.text !== text) actions.push({ kind: 'text', id: block.id, text });
    };
    const split = (block: Block, prefix: string, suffix: string, zoomRoot?: string | null) => {
      if (block.heading !== null && !prefix && !suffix) {
        setText(block, '');
        actions.push({ kind: 'heading', id: block.id, heading: null });
        caret = { id: block.id, offset: 0 };
        return;
      }
      setText(block, prefix);
      const zoom = zoomRoot === block.id;
      caret = { id: insert(zoom ? block.id : block.parent_id!, zoom ? null : block.id, suffix, suffix ? block.heading : null), offset: 0 };
    };
    const paste = (block: Block, prefix: string, suffix: string, text: string, zoomRoot?: string | null) => {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) {
        setText(block, prefix + lines[0]! + suffix);
        caret = { id: block.id, offset: prefix.length + lines[0]!.length };
        return;
      }
      setText(block, prefix + lines[0]!);
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
        const id = insert(parentId, after, body);
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
      const startOffset = Math.max(0, Math.min(start.offset, first.text.length));
      const endOffset = Math.max(0, Math.min(end.offset, last.text.length));
      const between = this.outline.slice(this.outline.indexOf(start.id) + 1, this.outline.indexOf(end.id)).map(row => row.id);
      if (between.length !== visible.length || between.some((id, i) => id !== visible[i])) throw new Error('Expand hidden blocks before deleting this text range.');
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
      if (mode === 'split') split(first, prefix + text, suffix, zoomRoot);
      else if (mode === 'paste') paste(first, prefix, suffix, text, zoomRoot);
      else { setText(first, prefix + text + suffix); caret = { id: first.id, offset: prefix.length + text.length }; }
      if (preserved.length) {
        let after: string | null = this.outline.children(first.id).at(-1) ?? null;
        if (this.outline.indexOf(end.id) < this.outline.subtreeEnd(this.outline.indexOf(first.id))) {
          after = end.id;
          while (this.outline.parentOf(after) !== first.id) after = this.outline.parentOf(after);
        }
        move(preserved, first.id, after);
      }
      for (const id of deleted) actions.push({ kind: 'delete', id });
    };
    try {
      switch (edit.kind) {
        case 'text':
          if (this.snapshot(edit.id).text !== edit.text) actions.push({ kind: 'text', id: edit.id, text: edit.text });
          if (edit.heading !== undefined && this.snapshot(edit.id).heading !== edit.heading) actions.push({ kind: 'heading', id: edit.id, heading: edit.heading });
          break;
        case 'heading': actions.push({ kind: 'heading', id: edit.id, heading: edit.level }); break;
        case 'archive': actions.push({ kind: 'archive', id: edit.id, archived: edit.archived }); break;
        case 'fieldKind': {
          const definition = edit.definition;
          if (this.snapshot(definition.id).revision !== definition.revision || this.block(definition.id)?.pending) throw new Error('The field changed. Refresh before changing its kind.');
          if (definition.kind !== edit.value) actions.push({ kind: 'fieldKind', id: definition.id, value: edit.value, previous: definition.kind, baseRevision: definition.revision });
          break;
        }
        case 'insert': caret = { id: insert(edit.parentId, edit.after, edit.text ?? ''), offset: 0 }; break;
        case 'split': {
          const old = this.snapshot(edit.id);
          if (old.kind !== 'block') throw new Error('Only outline blocks can split.');
          const offset = Math.max(0, Math.min(edit.offset, old.text.length));
          split(old, old.text.slice(0, offset), old.text.slice(offset), edit.zoomRoot);
          break;
        }
        case 'merge': {
          const source = this.snapshot(edit.sourceId);
          const destination = this.snapshot(edit.destinationId);
          if (source.kind !== 'block') throw new Error('A page cannot merge into a block.');
          let parent = destination.id;
          while (parent !== this.pageId) { if (parent === source.id) throw new Error('Cannot merge into a descendant.'); parent = this.outline.parentOf(parent); }
          actions.push({ kind: 'text', id: destination.id, text: destination.text + source.text });
          move([...this.outline.children(source.id)], destination.id, this.outline.children(destination.id).at(-1) ?? null);
          actions.push({ kind: 'delete', id: source.id });
          caret = { id: destination.id, offset: destination.text.length };
          break;
        }
        case 'delete': {
          const roots = selected(edit.ids);
          let removed = 0;
          for (const id of roots) { actions.push({ kind: 'delete', id }); const at = this.outline.indexOf(id); removed += this.outline.subtreeEnd(at) - at; }
          caret = removed && removed === this.outline.size() ? { id: insert(this.pageId, null, ''), offset: 0 } : null;
          break;
        }
        case 'moveTo': move(selected(edit.ids), edit.parentId, edit.after); break;
        case 'indent': {
          const ids = selected(edit.ids);
          if (!ids.length) break;
          const parent = this.outline.previousSibling(ids[0]!);
          if (!parent) throw new Error('There is no previous sibling to indent beneath.');
          move(ids, parent, this.outline.children(parent).at(-1) ?? null);
          break;
        }
        case 'outdent': {
          const ids = selected(edit.ids);
          if (!ids.length) break;
          const parent = this.outline.parentOf(ids[0]!);
          if (parent === this.pageId) throw new Error('This block is already at the top level.');
          move(ids, this.outline.parentOf(parent), parent);
          break;
        }
        case 'move': {
          const ids = selected(edit.ids);
          if (!ids.length) break;
          const parent = this.outline.parentOf(ids[0]!);
          if (ids.some(id => this.outline.parentOf(id) !== parent)) throw new Error('Move selection must contain siblings.');
          const siblings = this.outline.children(parent);
          const first = siblings.indexOf(ids[0]!);
          const last = siblings.indexOf(ids.at(-1)!);
          if (edit.direction === 'up') {
            if (first <= 0) throw new Error('Already the first sibling.');
            move(ids, parent, siblings[first - 2] ?? null);
          } else {
            if (last + 1 >= siblings.length) throw new Error('Already the last sibling.');
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
      batch(() => { for (const action of actions) inverse.unshift(...this.apply(action)); });
      const before: HistoryCaret | null = edit.kind === 'replaceRange' ? { ...(caretBefore ?? edit.range.head), range: { anchor: { ...edit.range.anchor }, head: { ...edit.range.head } } } : caretBefore;
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
  private travel(undo: boolean): HistoryCaret | null {
    this.lastTextEditAt = 0;
    const from = undo ? this.undoStack : this.redoStack;
    const to = undo ? this.redoStack : this.undoStack;
    const entry = from.pop();
    if (!entry) return null;
    const actions = undo ? entry.inverse : entry.forward.map(action => action.kind === 'fieldKind' ? { ...action, baseRevision: undefined } : action.kind === 'insert' && this.baseBlocks.has(action.block.id) ? { kind: 'restore' as const, id: action.block.id, snapshots: [{ block: action.block, row: { id: action.block.id, parentId: action.block.parent_id!, depth: action.block.parent_id === this.pageId ? 0 : this.outline.depth(action.block.parent_id!) + 1 } }], after: action.after } : action);
    try {
      const inverse: Action[] = [];
      batch(() => { for (const action of actions) {
        if (action.kind === 'text' && action.baseRevision !== undefined && !this.cells.has(action.id)) continue;
        inverse.unshift(...this.apply(action));
      } });
      const command = this.host.enqueue(this, actions, inverse, undo ? entry.after : entry.before, undo ? entry.before : entry.after, false);
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
