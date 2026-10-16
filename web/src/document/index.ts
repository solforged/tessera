import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { ApiError, CHANGE_CONNECTING, CHANGE_OPEN, bindNotebook, createApi } from '../api/client';
import type { Batch, Block, BlockCapabilities, ChangeEvent, Committed, Operation, PageView, SettingsView, TaskState, WorkSession } from '../api/types';
import type { ApiClient, ChangeSocket } from '../api/client';
import { startingTemplateFor } from '../fields/templates';
import { captureOperations } from '../capture/append';
import type { BlockClipboard, Caret, DocumentChange, NotebookClient, PageDocument, SaveState, SourceDetailsEdit } from './contract';
import { Document } from './page-document';
import type { DocumentHost } from './page-document';
import { Outbox } from './outbox';
import type { Action, Command, Compiled, NotebookCommand, PageCommand, Ticket } from './types';
import { emptyCapabilities, isCapabilityAction, questionState, questionStatus, sameState, sourceState } from './types';
import { SubtreeCache } from './subtrees';
import { titleKey } from './title-key';
export type { NotebookClient, PageDocument, BlockState, Caret, Edit, EditResult, SaveState } from './contract';

export interface NotebookOptions {
  baseUrl?: string;
  /** A test or embedding may supply its own persistent window identity. */
  sessionId?: string;
  notebookId?: string;
  databaseName?: string;
  coalesceMs?: number;
}

type SettingEdit = { key: 'time_zone' | 'vim' | 'confirm_view_delete'; before: string; after: string; revision: number };
type SourceCommandPart = { pageId: string; actions: Action[]; expected?: string; stale?: boolean };

/** Back and forward between a few pages reopens them without a reload; each warm page keeps its rows in memory. */
const WARM_DOCUMENTS = 3;
/** Beyond one history page, fresh snapshots cost less than replaying full-block events. */
const MAX_CATCH_UP = 500;
/** How long a tag being typed waits for its next keystroke before it saves anyway. */
const TAG_IDLE = 3000;
/** One single-flight operation queue for every document in this window. */
export class Notebook implements NotebookClient, DocumentHost {
  readonly ready: Promise<void>;
  readonly api: ApiClient;
  readonly roots: Accessor<readonly Block[]>;
  private setRoots;
  private docs = new Map<string, Document>();
  /** Released documents kept loaded, oldest first, so returning to a page does not refetch and rebuild it. */
  private warm: string[] = [];
  private cache = new Map<string, [Accessor<Block | null | undefined>, (value: Block | null | undefined) => Block | null | undefined]>();
  private failedLookups = new Set<string>();
  private subtreeCache: SubtreeCache;
  private queue: Command[] = [];
  private tickets = new Map<string, Ticket>();
  private notebookId = '';
  private deletedPages = new Map<string, Action>();
  private rejected = new Map<string, Command>();
  private outbox?: Outbox;
  private snapshotSequence = new WeakMap<PageView, number>();
  private snapshotCursor = new WeakMap<PageView, number>();
  private recoveryPages = new Map<string, number | undefined>();
  private cachedViews = new WeakSet<PageView>();
  private connectionSignal = createSignal<'connecting' | 'live' | 'offline'>('connecting');
  private storageSignal = createSignal<'ready' | 'failed'>('ready');
  private revision = createSignal(0);
  private observedSequence = createSignal(0);
  changeSequence = this.observedSequence[0];
  private observedChange = createSignal<ChangeEvent | null>(null);
  lastChange = this.observedChange[0];
  private failure = '';
  private persistenceFailure = '';
  private sending = false;
  private activeCommand?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private socket?: ChangeSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private initialized = false;
  private seq = 0;
  private cursorSeeded = false;
  private reloadRequired = false;
  private reconnectDelay = 500;
  private streamWork = Promise.resolve();
  private firstQueuedAt = 0;
  /** The trailing text save held while its block's caret is inside an unfinished `#tag`, until `until` at the latest. */
  private draftTag: { commandId: string; blockId: string; until: number } | null = null;
  private order = Date.now() * 1000;
  private sessionId: string;
  private actorName: string;
  private persisted = new Set<string>();
  private generations = new Map<string, number>();
  private commandWaiters = new Map<string, { resolve(value: Committed): void; reject(error: Error): void }>();
  private sourceChangeQueue: Promise<unknown> = Promise.resolve();
  private pageWaiters = new Set<{ pageId: string; ids: Set<string>; resolve(): void; reject(error: Error): void }>();
  // A signal, so rows showing the running clock follow starts and stops from any window.
  private workSignal = createSignal<WorkSession | undefined>();
  private get activeWork() { return this.workSignal[0](); }
  private set activeWork(value: WorkSession | undefined) { this.workSignal[1](() => value); }
  private workSequence = 0;
  private capabilitySequence = new Map<string, number>();
  runningWork() { return this.activeWork; }
  connection = this.connectionSignal[0];
  localPersistence = this.storageSignal[0];
  private settingsSignal = createSignal<SettingsView>();
  settings = this.settingsSignal[0];
  private cachedVim = createSignal(false);
  private settingBusy = createSignal(false);
  settingsBusy = this.settingBusy[0];
  private settingError = createSignal('');
  private settingUndo: SettingEdit[] = [];
  private settingRedo: SettingEdit[] = [];
  vim = () => this.settings()?.settings.find(setting => setting.key === 'vim')?.value === 'true' || (!this.settings() && this.cachedVim[0]());
  confirmViewDelete = () => this.settings()?.settings.find(setting => setting.key === 'confirm_view_delete')?.value !== 'false';
  settingsMessage = () => this.settingError[0]() ? `Couldn’t save · ${this.settingError[0]()}` : this.settingsBusy() ? 'Saving…' : this.connection() === 'offline' ? 'Offline' : 'Saved';
  canUndoSetting = () => { this.revision[0](); return !this.settingsBusy() && this.settingUndo.length > 0; };
  canRedoSetting = () => { this.revision[0](); return !this.settingsBusy() && this.settingRedo.length > 0; };
  constructor(private options: NotebookOptions = {}) {
    this.api = createApi(options.baseUrl);
    this.subtreeCache = new SubtreeCache(this.api, block => this.publish(block, block.id, false, true));
    const roots = createSignal<readonly Block[]>([]);
    this.roots = roots[0];
    this.setRoots = roots[1];
    // Each document lifetime owns a distinct outbox. Closed windows' drafts are
    // recovered under a Web Lock, rather than depending on restored sessionStorage.
    this.sessionId = options.sessionId ?? ulid();
    this.actorName = `tessera-web:${this.sessionId}`;
    this.ready = this.initialize().then(() => { this.initialized = true; this.touch(); });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.online);
      window.addEventListener('beforeunload', this.beforeUnload);
    }
  }
  private online = () => { this.retry(); };
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.queue.some(command => !this.persisted.has(command.id)) || this.persistenceFailure && this.queue.length) {
      event.preventDefault(); event.returnValue = '';
    }
  };
  private touch() {
    this.revision[1](value => value + 1);
    for (const waiter of this.pageWaiters) {
      const rejected = [...this.rejected.values()].find(command => waiter.ids.has(command.id));
      const pending = this.queue.filter(command => waiter.ids.has(command.id));
      const failure = rejected?.rejection?.message ?? pending.find(command => command.failed)?.failed
        ?? (pending.length && this.persistenceFailure ? this.persistenceFailure : pending.length && this.docs.get(waiter.pageId)?.hasConflict() ? 'Conflict · Both versions kept' : undefined);
      if (failure) { this.pageWaiters.delete(waiter); waiter.reject(new Error(failure)); }
      else if (!pending.length) { this.pageWaiters.delete(waiter); waiter.resolve(); }
    }
  }
  private storageFailed = (error: unknown) => {
    this.storageSignal[1]('failed');
    this.persistenceFailure = `Not saved locally · Keep this tab open. ${error instanceof Error ? error.message : String(error)}`;
    this.touch();
  };
  private async initialize() {
    const key = `tessera:notebook:${this.options.baseUrl ?? ''}`;
    let notebookId = this.options.notebookId;
    try {
      const info = await this.api.notebook();
      notebookId = info.id;
      try { sessionStorage.setItem(key, info.id); } catch { /* IndexedDB, not session storage, owns drafts. */ }
    } catch (error) {
      this.connectionSignal[1]('offline');
      try { notebookId ??= sessionStorage.getItem(key) ?? undefined; } catch { /* No remembered notebook. */ }
      if (!notebookId) { this.failure = error instanceof Error ? error.message : String(error); this.touch(); return; }
    }
    this.notebookId = notebookId;
    bindNotebook(this.options.baseUrl ?? '', notebookId);
    try { this.cachedVim[1](JSON.parse(localStorage.getItem(`tessera.navigation.${notebookId}`) ?? '{}').vim === true); } catch { /* Optional offline preference. */ }
    // Establish the replay floor before fetching any state a window can show.
    try { await this.seedCursor(); } catch { this.connectionSignal[1]('offline'); }
    try { await this.refreshSettings(); } catch { /* Offline dates and Vim use device/cache fallbacks. */ }
    try { this.activeWork = await this.api.activeWorkSession() ?? undefined; } catch { /* The service still guards unknown clocks. */ }
    this.outbox = new Outbox(notebookId, this.sessionId, this.storageFailed, this.options.databaseName);
    const stored = await this.outbox.load();
    this.queue = stored.commands.filter(command => !command.rejection);
    for (const command of stored.commands) if (command.rejection) this.rejected.set(command.id, command);
    for (const command of this.queue) this.persisted.add(command.id);
    for (const row of stored.tickets) this.tickets.set(row.key.slice(notebookId.length + 1), row.ticket);
    this.setRoots(stored.roots);
    this.order = Math.max(this.order, ...this.queue.map(command => command.order));
    for (const root of stored.roots) this.publish(root);
    try { await this.refreshRoots(); } catch { this.connectionSignal[1]('offline'); }
    // Loading recovered documents is chained after ready, avoiding a constructor cycle.
    queueMicrotask(() => {
      for (const command of this.queue) if (command.kind !== 'notebook' && !this.docs.has(command.pageId)) this.open(command.pageId).release();
      void this.connect();
      this.schedule(0);
    });
    this.touch();
  }
  open(pageId: string): PageDocument {
    let doc = this.docs.get(pageId);
    if (!doc) { doc = new Document(pageId, this); this.docs.set(pageId, doc); }
    const warm = this.warm.indexOf(pageId);
    if (warm >= 0) this.warm.splice(warm, 1);
    doc.holds++;
    return doc;
  }
  canRestore(ids: readonly string[]) {
    return ids.every(id => this.cache.get(id)?.[0]() === null && (this.tickets.has(id)
      || this.queue.some(command => command.actions.some(action => action.kind === 'delete' && action.id === id))));
  }
  clipboardScope() { return this.notebookId; }
  async prepareClipboard(content: BlockClipboard): Promise<BlockClipboard> {
    if (!content.cut || content.scope !== this.notebookId) return { ...content, cut: false };
    const roots = content.blocks.filter(item => item.depth === 0).map(item => item.block.id);
    if (roots.every(id => this.cache.get(id)?.[0]() === null
      && this.queue.some(command => command.actions.some(action => action.kind === 'delete' && action.id === id)))) return content;
    let consumed = false;
    for (const id of roots) {
      const ticket = await this.outbox?.getTicket(id);
      if (!ticket) throw new Error('The cut has not finished saving yet. Try pasting again.');
      try { await this.api.block(id); consumed = true; }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        this.tickets.set(id, ticket);
        this.publish(null, id);
      }
    }
    return consumed ? { ...content, cut: false } : content;
  }
  release(doc: Document) {
    doc.holds = Math.max(0, doc.holds - 1);
    this.closeUnused(doc);
  }
  /** Unheld documents without queued commands, conflicts or a pending page restore can close. */
  private closable(doc: Document) {
    return this.docs.get(doc.pageId) === doc && !doc.holds && !this.queue.some(command => command.pageId === doc.pageId) && !doc.hasConflict() && !this.deletedPages.has(doc.pageId);
  }
  private closeUnused(doc: Document) {
    if (!this.closable(doc)) return;
    if (doc.status() !== 'ready') { this.close(doc); return; }
    // A loaded document keeps following the change stream while warm.
    if (!this.warm.includes(doc.pageId)) this.warm.push(doc.pageId);
    while (this.warm.length > WARM_DOCUMENTS) {
      const oldest = this.docs.get(this.warm.shift()!);
      if (oldest && this.closable(oldest)) this.close(oldest);
    }
  }
  private close(doc: Document) {
    doc.close();
    this.docs.delete(doc.pageId);
    this.recoveryPages.delete(doc.pageId);
    const warm = this.warm.indexOf(doc.pageId);
    if (warm >= 0) this.warm.splice(warm, 1);
  }
  commands(pageId: string): PageCommand[] { this.revision[0](); return this.queue.filter((command): command is PageCommand => command.kind !== 'notebook' && command.pageId === pageId); }
  async loadPage(id: string) {
    try {
      if (!this.cursorSeeded) await this.seedCursor();
      const cursor = this.seq;
      // Receipts can be ahead of the replay floor, but are already in the following snapshot.
      const sequence = Math.max(this.changeSequence(), await this.outbox?.storedSequence(id) ?? 0);
      const view = await this.api.page(id);
      this.recoveryPages.delete(id);
      this.snapshotSequence.set(view, sequence);
      this.snapshotCursor.set(view, cursor);
      return view;
    } catch (error) {
      const provisional = this.queue.some(command => command.pageId === id && command.actions.some(action => action.kind === 'insert' && action.block.id === id));
      if (!(error instanceof ApiError) || error.uncertain || error.status === 404 && provisional) {
        const cached = await this.outbox?.cachedPage(id);
        if (cached) {
          this.cachedViews.add(cached.view);
          if (!provisional) {
            this.recoveryPages.set(id, cached.cursor);
            this.connectionSignal[1]('offline');
            this.scheduleReconnect();
          }
          if (provisional) this.recoveryPages.delete(id);
          return cached.view;
        }
      }
      if (error instanceof ApiError && !error.uncertain) this.recoveryPages.delete(id);
      else this.recoveryPages.set(id, undefined);
      throw error;
    }
  }
  /** Writes a loaded view to recovery storage once; a merge offers the same view more than once. */
  cachePage(view: PageView) {
    if (this.cachedViews.has(view)) return;
    this.cachedViews.add(view);
    const capabilities = new Map((view.capabilities ?? []).map(value => [value.block_id, value]));
    void this.outbox?.capabilities([view.root, ...view.rows.map(row => row.block)].map(block => capabilities.get(block.id) ?? emptyCapabilities(block.id)), this.snapshotSequence.get(view) ?? 0).catch(() => undefined);
    void this.outbox?.page(view, this.snapshotSequence.get(view) ?? 0, this.snapshotCursor.get(view)).catch(() => undefined);
  }
  publish(block: Block | null, id = block?.id, force = false, fromSubtree = false) {
    if (!id) return;
    if (block && block.kind !== 'block') {
      const doc = this.docs.get(id);
      const root = doc?.root();
      if (root?.pending && block.revision <= root.revision) block = doc!.snapshot(id);
    }
    if (!fromSubtree) this.subtreeCache.changed(block, id);
    const entry = this.cache.get(id);
    // A read started before a local edit/deletion must not replace that publication.
    if (fromSubtree) {
      const current = entry?.[0]();
      if (current === null || current && block && current.revision >= block.revision) return;
    }
    if (entry) {
      const current = entry[0]();
      if (force || !block || !current || block.revision >= current.revision) entry[1](block);
    }
    else this.cache.set(id, createSignal<Block | null | undefined>(block));
  }
  /** A save removed this page on the notebook's side, as when the last tag naming an untouched tag page goes. */
  private receiveRemoval(id: string) {
    this.publish(null, id);
    this.updateRoot(null, id);
    this.docs.get(id)?.markMissing('This page was removed because nothing uses it any more.');
  }
  updateRoot(block: Block | null, id = block?.id) {
    if (!id) return;
    const current = this.roots();
    const at = current.findIndex(root => root.id === id);
    if (!block && at < 0 || block && at >= 0 && current[at]!.text === block.text && current[at]!.archived === block.archived && current[at]!.revision === block.revision) return;
    const roots = [...current];
    if (block) { if (at < 0) roots.push(block); else roots[at] = block; }
    else roots.splice(at, 1);
    this.setRoots(roots);
    void this.outbox?.roots(roots).catch(() => undefined);
  }
  lookup(id: string): Accessor<Block | null | undefined> {
    let entry = this.cache.get(id);
    if (!entry) {
      entry = createSignal<Block | null | undefined>(undefined);
      this.cache.set(id, entry);
      this.loadLookup(id);
    }
    return entry[0];
  }
  private loadLookup(id: string) {
    void this.ready.then(() => { if (!this.closed) return this.api.block(id); }).then(block => {
      if (!this.closed && block && this.cache.get(id)?.[0]() === undefined) this.publish(block);
    }).catch(error => {
      if (this.closed || this.cache.get(id)?.[0]() !== undefined) return;
      if (error instanceof ApiError && error.status === 404) this.publish(null, id);
      else this.failedLookups.add(id);
    });
  }
  watchSubtree(id: string) { return this.subtreeCache.watch(id); }
  private retryLookups() {
    for (const id of this.failedLookups) {
      this.failedLookups.delete(id);
      if (this.cache.get(id)?.[0]() === undefined) this.loadLookup(id);
    }
  }
  enqueue(doc: Document, actions: Action[], inverse: Action[], before: Caret | null, after: Caret | null, coalesce: boolean): PageCommand {
    const previous = this.queue.at(-1);
    let command: PageCommand;
    if (coalesce && previous && previous.kind !== 'notebook' && !previous.frozen && previous.pageId === doc.pageId && actions.length === 1 && actions[0]!.kind === 'text' && previous.actions.length === 1 && previous.actions[0]!.kind === 'text' && previous.actions[0]!.id === actions[0]!.id) {
      const expectedText = previous.actions[0]!.expectedText;
      previous.actions = structuredClone(actions);
      if (previous.actions[0]!.kind === 'text') previous.actions[0]!.expectedText = expectedText;
      for (const action of previous.inverse) if (action.kind === 'text') action.expectedText = actions[0]!.text;
      previous.after = after;
      previous.failed = undefined;
      this.persisted.delete(previous.id);
      command = previous;
    } else {
      command = { id: ulid(), order: ++this.order, pageId: doc.pageId, actions: structuredClone(actions), inverse: structuredClone(inverse), before, after };
      this.queue.push(command);
    }
    if (this.draftTag && this.draftTag.commandId !== command.id) this.draftTag = null;
    this.generations.set(command.id, (this.generations.get(command.id) ?? 0) + 1);
    this.failure = '';
    this.touch();
    queueMicrotask(() => { void this.persist(command); });
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    this.schedule(coalesce ? this.coalesceDelay() : 0);
    return command;
  }
  /** Typing coalesces for 150–300 ms, and never past a second after the first unsent edit. */
  private coalesceDelay() {
    return Math.min(Math.max(150, Math.min(300, this.options.coalesceMs ?? 200)), Math.max(0, 1000 - (Date.now() - this.firstQueuedAt)));
  }
  /**
   * Holds or releases `blockId`'s trailing text save while its caret is `typing` a tag. A saved `#phil` files the
   * block under a new type page, so `#p`, `#ph` and `#phi` stay unsaved until a space, Enter, a choice, the caret
   * leaving, or `TAG_IDLE` without a keystroke finishes the word.
   */
  holdTag(pageId: string, blockId: string, typing: boolean) {
    const draft = this.draftTag;
    if (draft && (!typing || draft.blockId !== blockId)) {
      this.draftTag = null;
      this.schedule(this.coalesceDelay());
    }
    if (!typing) return;
    const last = this.queue.at(-1);
    const action = last?.kind !== 'notebook' ? last?.actions[0] : undefined;
    if (!last || last.kind === 'notebook' || last.frozen || last.pageId !== pageId || last.actions.length !== 1 || action?.kind !== 'text' || action.id !== blockId) return;
    this.draftTag = { commandId: last.id, blockId, until: Date.now() + TAG_IDLE };
  }
  async appendCapture(text: string, task: TaskState | null, picked: readonly [string, string][] = []): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error('The notebook is closed.');
    if (!this.outbox) throw new Error('Recovery storage has not opened.');
    const command: NotebookCommand = {
      kind: 'notebook', id: ulid(), order: ++this.order, pageId: null,
      capture: structuredClone({ date: this.todayDate(), text, task, picked: [...picked] }),
      operations: [], reason: 'Add to today', actions: [], inverse: [], before: null, after: null,
    };
    this.queue.push(command);
    try {
      await this.outbox.accept(command);
      this.persisted.add(command.id);
      this.touch();
      this.schedule(0);
    } catch (reason) {
      this.queue = this.queue.filter(value => value !== command);
      this.touch();
      throw reason;
    }
  }
  async commit(operations: readonly Operation[], reason?: string, refreshPages?: readonly string[]): Promise<Committed> {
    return this.commitOperations(operations, reason, refreshPages);
  }
  async queueCreatedValueText(valueId: string, pageId: string, text: string): Promise<void> {
    if (this.closed || !this.outbox) throw new Error('Recovery storage has not opened.');
    const tail = this.queue.at(-1);
    let command: NotebookCommand;
    if (tail?.kind === 'notebook' && tail.createdValueText?.id === valueId && !tail.frozen) {
      command = tail;
      (command.operations[0] as Extract<Operation, { op: 'edit_text' }>).text = text;
    } else {
      const previous = [...this.queue].reverse().find((item): item is NotebookCommand => item.kind === 'notebook' && item.createdValueText?.id === valueId);
      const operation = previous?.operations[0] as Extract<Operation, { op: 'edit_text' }> | undefined;
      const saved = this.docs.get(pageId)?.baseBlocks.get(valueId);
      const before = operation?.text ?? saved?.text ?? '';
      const revision = operation ? operation.base_revision + Number(operation.text !== previous!.createdValueText!.before) : saved?.revision ?? 1;
      command = {
        kind: 'notebook', id: ulid(), order: ++this.order, pageId: null,
        createdValueText: { id: valueId, pageId, before },
        operations: [{ op: 'edit_text', id: valueId, base_revision: revision, text }],
        reason: 'Fill new field', refreshPages: [pageId], actions: [], inverse: [], before: null, after: null,
      };
      this.queue.push(command);
    }
    const waiter = this.commandWaiters.get(command.id) ?? Promise.withResolvers<Committed>();
    this.commandWaiters.set(command.id, waiter);
    this.persisted.delete(command.id);
    this.touch();
    await this.outbox.accept(command);
    await this.persist(command);
    this.schedule(0);
    await waiter.promise;
  }
  private async commitOperations(operations: readonly Operation[], reason?: string, refreshPages?: readonly string[], retainRejection = true): Promise<Committed> {
    const id = ulid();
    const frozen = JSON.stringify({ actor: { kind: 'client', name: this.actorName }, idempotency_key: id, reason, operations });
    const snapshot: Batch = JSON.parse(frozen);
    if (!this.initialized) await this.ready;
    if (this.closed) throw new Error('The notebook is closed.');
    if (!snapshot.operations.length) throw new Error('A command needs an operation.');
    const command: NotebookCommand = { kind: 'notebook', id, order: ++this.order, pageId: null, operations: snapshot.operations, reason, refreshPages: refreshPages ? [...refreshPages] : undefined, actions: [], inverse: [], before: null, after: null, frozen };
    const waiter = Promise.withResolvers<Committed>();
    this.commandWaiters.set(id, waiter);
    this.queue.push(command);
    this.touch();
    try {
      void this.outbox!.accept(command).then(() => this.persist(command)).then(() => this.schedule(0)).catch(error => this.storageFailed(error));
    } catch (error) { this.storageFailed(error); }
    return waiter.promise.catch(async (error: unknown) => {
      // These awaited field transactions never adopted optimistic document state.
      // Keep their failed draft in the editor, not as a stale shared recovery command.
      if (!retainRejection && this.rejected.has(id)) {
        await this.outbox?.remove(id);
        this.rejected.delete(id);
        if (this.failure === (error instanceof Error ? error.message : String(error))) this.failure = '';
        this.touch();
      }
      throw error;
    });
  }
  private serializeSourceChange<T>(work: () => Promise<T>): Promise<T> {
    const result = this.sourceChangeQueue.then(work, work);
    this.sourceChangeQueue = result.catch(() => undefined);
    return result;
  }
  async editSourceDetails(edits: readonly { pageId: string; edit: SourceDetailsEdit }[]): Promise<DocumentChange> {
    let next = await this.serializeSourceChange(async () => {
      const docs = edits.map(({ pageId }) => this.open(pageId) as Document);
      try {
        await Promise.all(docs.map(async doc => {
          if (doc.status() === 'loading') await doc.reload(false);
          await doc.flush();
        }));
        const parts = edits.map(({ pageId, edit }, index) => {
          const doc = docs[index]!;
          const actions = doc.sourceDetailsActions(edit);
          return { pageId, actions, expected: doc.sourceActionsState(actions) };
        });
        return await this.commitSourceActions(parts);
      } finally { for (const doc of docs) doc.release(); }
    });
    let applied = true;
    const travel = (undo: boolean) => this.serializeSourceChange(async () => {
      if (applied !== undo) return;
      next = await this.commitSourceActions(next);
      applied = !undo;
    });
    return { undo: () => travel(true), redo: () => travel(false) };
  }
  async integrateBlock(id: string, destinationId: string): Promise<DocumentChange> {
    return this.serializeSourceChange(async () => {
      const source = await this.api.block(id), destination = await this.api.block(destinationId);
      const pages = [...new Set([source.page_id, destination.page_id])];
      const docs = pages.map(pageId => this.open(pageId) as Document);
      try {
        await Promise.all(docs.map(async doc => {
          if (doc.status() === 'loading') await doc.reload(false);
          await doc.flush();
        }));
        const sourceDoc = docs[pages.indexOf(source.page_id)]!;
        const destinationDoc = docs[pages.indexOf(destination.page_id)]!;
        if (sourceDoc.root()?.kind !== 'journal' || source.kind !== 'block') throw new Error('Integrate a block from a journal day.');
        const block = await this.api.block(id);
        if (!block.parent_id || block.page_id !== source.page_id) throw new Error('The block moved while choosing its destination.');
        const parentId = block.parent_id;
        const siblings = sourceDoc.outline.children(parentId);
        const after = siblings[siblings.indexOf(id) - 1] ?? null;
        let ancestor: string | null = destinationId;
        while (ancestor) {
          if (ancestor === id) throw new Error('A block cannot move into its own subtree.');
          ancestor = destinationDoc.block(ancestor)?.parentId ?? null;
        }
        const referenceId = ulid();
        const referenceText = `[[${id}]]`;
        let applied = false, deletionId: string | undefined, referenceRevision = 0;
        const travel = async (forward: boolean) => {
          if (applied === forward) return;
          const opened = pages.map(pageId => this.open(pageId) as Document);
          try {
            await Promise.all(opened.map(async doc => { if (doc.status() === 'loading') await doc.reload(false); await doc.flush(); }));
            const current = await this.api.block(id);
            if (current.parent_id !== (forward ? parentId : destinationId)) throw new Error('The block moved since this change. Its current place was kept.');
            const operations: Operation[] = [];
            if (forward) {
              const dest = opened[pages.indexOf(destination.page_id)]!;
              const last = dest.outline.children(destinationId).filter(child => child !== id).at(-1) ?? null;
              operations.push({ op: 'move', id, base_revision: current.revision, parent_id: destinationId, after: last });
              operations.push(deletionId
                ? { op: 'restore', id: referenceId, deletion_id: deletionId, revision: referenceRevision }
                : { op: 'insert', id: referenceId, parent_id: parentId, after, text: referenceText, heading: null });
            } else {
              const reference = await this.api.block(referenceId);
              if (reference.revision !== referenceRevision || reference.text !== referenceText || reference.parent_id !== parentId) throw new Error('The journal reference changed. Its current text was kept.');
              operations.push({ op: 'delete', id: referenceId, base_revision: reference.revision });
              operations.push({ op: 'move', id, base_revision: current.revision, parent_id: parentId, after });
            }
            const receipt = await this.commitOperations(operations, forward ? 'Integrate journal block' : 'Undo integration', pages, false);
            referenceRevision = receipt.revisions.find(value => value.id === referenceId)!.revision;
            if (!forward) deletionId = receipt.deletions[0];
            applied = forward;
          } finally { for (const doc of opened) doc.release(); }
        };
        await travel(true);
        return {
          undo: () => this.serializeSourceChange(() => travel(false)),
          redo: () => this.serializeSourceChange(() => travel(true)),
        };
      } finally { for (const doc of docs) doc.release(); }
    });
  }
  async moveBlocks(ids: readonly string[], destinationId: string): Promise<DocumentChange> {
    return this.serializeSourceChange(async () => {
      if (!ids.length) throw new Error('Select blocks to move.');
      const first = await this.api.block(ids[0]!);
      if (first.page_id === destinationId) throw new Error('Choose another page.');
      const pages = [first.page_id, destinationId];
      const opened = pages.map(pageId => this.open(pageId) as Document);
      try {
        await Promise.all(opened.map(async doc => { if (doc.status() === 'loading') await doc.reload(false); await doc.flush(); }));
        const source = await this.api.page(first.page_id);
        const destination = await this.api.block(destinationId);
        if (destination.kind !== 'page') throw new Error('Choose a titled page.');
        const selected = new Set(ids);
        const blocks = new Map(source.rows.map(row => [row.block.id, row.block]));
        const predecessors = new Map<string, string | null>();
        const previous = new Map<string, string>();
        for (const { block } of source.rows) {
          predecessors.set(block.id, previous.get(block.parent_id!) ?? null);
          previous.set(block.parent_id!, block.id);
        }
        if (ids.some(id => !blocks.has(id))) throw new Error('A selected block moved or was deleted.');
        const roots = source.rows.filter(({ block }) => {
          if (!selected.has(block.id)) return false;
          for (let parent = block.parent_id; parent && parent !== source.root.id; parent = blocks.get(parent)?.parent_id ?? null) if (selected.has(parent)) return false;
          return true;
        }).map(({ block }) => ({ id: block.id, parentId: block.parent_id!, after: predecessors.get(block.id)! }));
        let applied = false;
        const travel = async (forward: boolean) => {
          if (applied === forward) return;
          const docs = pages.map(pageId => this.open(pageId) as Document);
          try {
            // This transaction can itself be the page's pending external history entry.
            await Promise.all(docs.map(async doc => { if (doc.status() === 'loading') await doc.reload(false); await this.flushPage(doc.pageId); }));
            const current = await Promise.all(roots.map(root => this.api.block(root.id)));
            if (current.some((block, index) => block.parent_id !== (forward ? roots[index]!.parentId : destinationId)
              || block.page_id !== (forward ? first.page_id : destinationId))) throw new Error('A block moved since this change. Its current place was kept.');
            const target = forward ? await this.api.page(destinationId) : null;
            let after = target?.rows.filter(row => row.depth === 0).at(-1)?.block.id ?? null;
            const operations: Operation[] = roots.map((root, index) => {
              const operation: Operation = { op: 'move', id: root.id, base_revision: current[index]!.revision, parent_id: forward ? destinationId : root.parentId, after: forward ? after : root.after };
              after = root.id;
              return operation;
            });
            await this.commitOperations(operations, forward ? 'Move blocks to page' : 'Undo move to page', pages, false);
            applied = forward;
          } finally { for (const doc of docs) doc.release(); }
        };
        await travel(true);
        return {
          undo: () => this.serializeSourceChange(() => travel(false)),
          redo: () => this.serializeSourceChange(() => travel(true)),
        };
      } finally { for (const doc of opened) doc.release(); }
    });
  }
  async promoteToProject(id: string, title: string): Promise<{ pageId: string; change: DocumentChange }> {
    return this.serializeSourceChange(async () => {
      const name = title.trim();
      if (!name) throw new Error('Name the project before making it one.');
      const source = await this.api.block(id);
      const journal = this.open(source.page_id) as Document;
      try {
        if (journal.status() === 'loading') await journal.reload(false);
        await journal.flush();
        if (journal.root()?.kind !== 'journal' || source.kind !== 'block') throw new Error('Promote a block from a journal day.');
        const row = await this.api.block(id);
        if (row.page_id !== source.page_id) throw new Error('The block moved while making it a project.');
        const children = [...journal.outline.children(id)];
        const found = await this.pageByTitle(name, false);
        const existing = found ? await this.api.block(found) : null;
        if (existing && existing.kind !== 'page') throw new Error(`“${name}” names a journal day.`);
        const pageId = existing?.id ?? ulid();
        const wasProject = !!existing && (await this.api.projects()).some(project => project.block_id === pageId);
        const originalText = row.text;
        const linkText = `[[${pageId}]]`;
        const pages = [source.page_id, pageId];
        const created = !existing;
        let applied = false, deletionId: string | undefined, pageRevision = 0;
        const travel = async (forward: boolean) => {
          if (applied === forward) return;
          const operations: Operation[] = [];
          const current = await this.api.block(id);
          if (forward) {
            if (current.text !== originalText) throw new Error('The journal block changed since this change. Its current text was kept.');
            if (created) operations.push(deletionId
              ? { op: 'restore', id: pageId, deletion_id: deletionId, revision: pageRevision }
              : { op: 'create_page', id: pageId, title: name });
            if (!wasProject && !deletionId) operations.push({ op: 'set_project', id: pageId, base_revision: created ? 1 : (await this.api.block(pageId)).revision, project: { status: 'active', outcome: '', deadline: null } });
            if (originalText !== linkText) operations.push({ op: 'edit_text', id, base_revision: current.revision, text: linkText });
            // A page this change made holds only the moved rows; an existing one keeps its own writing first.
            let after = created ? null : (await this.api.page(pageId)).rows.filter(row => row.depth === 0 && !children.includes(row.block.id)).at(-1)?.block.id ?? null;
            for (const child of children) {
              const block = await this.api.block(child);
              if (block.parent_id !== id) throw new Error('The project row’s children changed. Their current place was kept.');
              operations.push({ op: 'move', id: child, base_revision: block.revision, parent_id: pageId, after });
              after = child;
            }
          } else {
            if (current.text !== linkText && originalText !== linkText) throw new Error('The journal link changed. Its current text was kept.');
            let after: string | null = null;
            for (const child of children) {
              const block = await this.api.block(child);
              if (block.parent_id !== pageId) throw new Error('The project page changed since this change. Its current outline was kept.');
              operations.push({ op: 'move', id: child, base_revision: block.revision, parent_id: id, after });
              after = child;
            }
            if (originalText !== linkText) operations.push({ op: 'edit_text', id, base_revision: current.revision, text: originalText });
            const page = await this.api.page(pageId);
            if (created) {
              if (page.rows.some(row => !children.includes(row.block.id) && row.depth === 0)) throw new Error('The project page has new writing. It was kept.');
              operations.push({ op: 'delete', id: pageId, base_revision: page.root.revision });
            } else if (!wasProject) operations.push({ op: 'set_project', id: pageId, base_revision: page.root.revision, project: null });
          }
          const receipt = await this.commitOperations(operations, forward ? 'Make project page' : 'Undo project page', pages, false);
          pageRevision = receipt.revisions.find(value => value.id === pageId)?.revision ?? pageRevision;
          if (!forward && created) deletionId = receipt.deletions[0];
          applied = forward;
        };
        await travel(true);
        return {
          pageId,
          change: {
            undo: () => this.serializeSourceChange(() => travel(false)),
            redo: () => this.serializeSourceChange(() => travel(true)),
          },
        };
      } finally { journal.release(); }
    });
  }
  private async commitSourceActions(parts: readonly SourceCommandPart[]): Promise<SourceCommandPart[]> {
    const docs = parts.map(part => this.open(part.pageId) as Document);
    try {
      await Promise.all(docs.map(async doc => {
        if (doc.status() === 'loading') await doc.reload(false);
        await doc.flush();
        if (doc.status() !== 'ready') throw new Error(doc.statusMessage() || 'This page is not ready.');
      }));
      const operations: Operation[] = [];
      const inverse: SourceCommandPart[] = parts.map((part, index) => {
        const doc = docs[index]!;
        if (part.stale || part.expected !== undefined && doc.sourceActionsState(part.actions) !== part.expected) throw new Error('The field changed since this edit. Its current value was kept.');
        const actions = part.actions.map(action => action.kind === 'source' ? { ...action, baseRevision: doc.root()!.revision } : action);
        const inverse = doc.sourceActionsInverse(actions);
        const command: PageCommand = { id: '', order: 0, pageId: part.pageId, actions, inverse, before: null, after: null };
        operations.push(...this.compile(command, doc).batch.operations);
        return { pageId: part.pageId, actions: inverse, expected: '' };
      });
      const ack = operations.length ? await this.commitOperations(operations, undefined, parts.map(part => part.pageId), false) : undefined;
      for (let index = 0; index < inverse.length; index++) {
        const doc = docs[index]!;
        const part = inverse[index]!;
        part.expected = doc.sourceActionsState(part.actions);
        // A page refresh may already contain edits newer than this receipt. Never
        // bless those values as this command's own values for a subsequent undo.
        part.stale = ack?.revisions.some(({ id, revision }) => {
          const block = doc.block(id);
          return block !== undefined && (block.pending || block.revision > revision);
        });
      }
      return inverse;
    } finally { for (const doc of docs) doc.release(); }
  }
  commandState(): SaveState {
    this.revision[0]();
    if (!this.initialized) return 'queued';
    const commands = this.queue.filter(command => command.kind === 'notebook');
    if (!commands.length && [...this.rejected.values()].some(command => command.kind === 'notebook')) return 'error';
    if (commands.some(command => !this.persisted.has(command.id))) return 'queued';
    if (!commands.length) return 'saved';
    if (this.connection() === 'offline') return 'offline';
    return commands.some(command => command.id === this.activeCommand) ? 'saving' : 'queued';
  }
  commandMessage() {
    const state = this.commandState();
    const rejected = [...this.rejected.values()].filter((command): command is NotebookCommand => command.kind === 'notebook');
    if (rejected.length) return rejected.map(command => [command.rejection!.message, rejectionText(command)].filter(Boolean).join('\n')).join('\n\n');
    if (this.queue.some(command => command.kind === 'notebook') && this.persistenceFailure) return this.persistenceFailure;
    if (state === 'error') return this.persistenceFailure || this.queue.find(command => command.kind === 'notebook' && command.failed)?.failed || 'Command failed.';
    return state === 'saved' ? 'Saved' : state === 'offline' ? 'Offline · Command kept for retry' : 'Saving…';
  }
  async flushPage(pageId: string) {
    await this.ready;
    this.draftTag = null;
    const waiter = Promise.withResolvers<void>();
    this.pageWaiters.add({ pageId, ids: new Set(this.commands(pageId).map(command => command.id)), resolve: waiter.resolve, reject: waiter.reject });
    this.touch();
    this.schedule(0);
    return waiter.promise;
  }
  private async persist(command: Command) {
    const generation = (this.generations.get(command.id) ?? 0) + 1;
    this.generations.set(command.id, generation);
    this.persisted.delete(command.id);
    try {
      if (!this.outbox) throw new Error('Recovery storage has not opened.');
      await this.outbox.put(command);
      if (this.queue.includes(command) && this.generations.get(command.id) === generation) this.persisted.add(command.id);
      this.touch();
    } catch (error) { if (!this.outbox) this.storageFailed(error); }
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, delay);
  }
  private compile(command: Command, doc: Document): Compiled {
    const operations: Operation[] = [];
    const working = new Map<string, Block>();
    const capabilities = new Map<string, BlockCapabilities>();
    const work = new Map<string, WorkSession>();
    const initialRevisions = new Map<string, number>();
    const deleted: string[] = [];
    const restoredPositions = new Map<string, { parentId: string; after: string | null }>();
    const current = (id: string) => {
      let block = working.get(id);
      if (!block) {
        const cached = this.cache.get(id)?.[0]();
        const saved = doc.baseBlocks.get(id) ?? (cached && this.docs.get(cached.page_id)?.baseBlocks.get(id)) ?? cached;
        if (!saved) throw new Error('The block no longer exists.');
        block = { ...saved };
        working.set(id, block);
        initialRevisions.set(id, saved.revision);
      }
      return block;
    };
    for (const action of command.actions) {
      switch (action.kind) {
        case 'cardHeld':
          operations.push({ op: 'set_card_held', id: action.id, base_revision: action.baseRevision, held: action.value });
          break;
        case 'cardTemplate': {
          const { id, value, previous } = action;
          let revision = action.baseRevision;
          if (!value) {
            operations.push({ op: 'delete_card_template', id, base_revision: revision });
          } else {
            const { type_id, name, front, back, new_per_day, applied } = value;
            if (!previous) {
              operations.push({ op: 'create_card_template', id, type_id, name, front, back, new_per_day });
              revision = 1;
            } else if (name !== previous.name || front !== previous.front || back !== previous.back || new_per_day !== previous.new_per_day) {
              operations.push({ op: 'update_card_template', id, base_revision: revision++, name, front, back, new_per_day });
            }
            if (applied !== (previous?.applied ?? false)) operations.push({ op: 'set_card_template_applied', id, base_revision: revision, applied });
          }
          break;
        }
        case 'settleSyncCopy': {
          const block = current(action.id);
          operations.push({ op: 'settle_sync_copy', id: action.id, settled: action.settled });
          if (Boolean(block.kept_copy) === action.settled) block.revision++;
          block.kept_copy = action.settled ? null : action.copy;
          break;
        }
        case 'task':
        case 'project':
        case 'position':
        case 'relation':
        case 'spread':
        case 'question':
        case 'quote':
        case 'assessment':
        case 'source':
        case 'cite':
        case 'uncite':
        case 'citationTriage':
        case 'highlightColor':
        case 'citationRange':
        case 'completeTask':
        case 'reverseTaskCompletion':
        case 'startWork':
        case 'stopWork':
        case 'workNote':
        case 'workState': {
          const block = current(action.id);
          if (action.baseRevision !== initialRevisions.get(action.id)) throw new Error('The capability source changed. Rejected command kept; refresh before applying it again.');
          let value = capabilities.get(action.id);
          if (!value) { value = doc.capabilities(action.id, true); capabilities.set(action.id, value); }
          let changed = true;
          if (action.kind === 'task') {
            if (!sameState(value.task, action.previous)) throw new Error('Task metadata changed. Rejected command kept.');
            if (action.restore && action.value && action.previous) operations.push({ op: 'restore_task_state', id: action.id, base_revision: block.revision, expected: action.previous, task: action.value });
            else operations.push({ op: 'set_task', id: action.id, base_revision: block.revision, task: action.value });
            changed = !sameState(value.task, action.value); value.task = action.value;
          } else if (action.kind === 'project') {
            if (!sameState(value.project, action.previous)) throw new Error('Project metadata changed. Rejected command kept.');
            operations.push({ op: 'set_project', id: action.id, base_revision: block.revision, project: action.value });
            changed = !sameState(value.project, action.value); value.project = action.value;
          } else if (action.kind === 'position') {
            if (!!value.position !== action.previous) throw new Error('Perspective metadata changed. Rejected command kept.');
            operations.push({ op: 'set_position', id: action.id, base_revision: block.revision, position: action.value });
            changed = !!value.position !== action.value;
            value.position = action.value ? { holder_id: null, subject_id: block.page_id } : null;
          } else if (action.kind === 'relation') {
            if ((value.relation?.kind ?? null) !== action.previous) throw new Error('Argument changed. Rejected command kept.');
            operations.push({ op: 'set_relation', id: action.id, base_revision: block.revision, relation: action.value });
            changed = (value.relation?.kind ?? null) !== action.value;
            value.relation = action.value ? { kind: action.value, source_id: block.page_id, target_id: null, problem: null } : null;
          } else if (action.kind === 'spread') {
            if (!!value.spread !== action.previous) throw new Error('Spread changed. Rejected command kept.');
            operations.push({ op: 'set_spread', id: action.id, base_revision: block.revision, spread: action.value });
            changed = !!value.spread !== action.value;
            value.spread = action.value;
          } else if (action.kind === 'question') {
            if (!sameState(questionState(value.question?.state), questionState(action.previous))) throw new Error('Question changed. Rejected command kept.');
            operations.push({ op: 'set_question', id: action.id, base_revision: block.revision, question: action.value });
            changed = !sameState(value.question?.state ?? null, action.value);
            value.question = action.value ? { state: action.value, status: questionStatus(action.value, false), parent_id: value.question?.parent_id ?? null, parent_explicit: value.question?.parent_explicit ?? false } : null;
          } else if (action.kind === 'quote') {
            if (!sameState(value.quote ?? null, action.previous)) throw new Error('Quote changed. Rejected command kept.');
            operations.push({ op: 'set_quote', id: action.id, base_revision: block.revision, quote: action.value });
            changed = !sameState(value.quote ?? null, action.value);
            value.quote = action.value;
          } else if (action.kind === 'assessment') {
            if (!sameState(value.assessment?.state ?? null, action.previous)) throw new Error('Answer changed. Rejected command kept.');
            operations.push({ op: 'set_assessment', id: action.id, base_revision: block.revision, assessment: action.value });
            changed = !sameState(value.assessment?.state ?? null, action.value);
            value.assessment = action.value ? { state: action.value, question_id: null, accepted: false } : null;
          } else if (action.kind === 'source') {
            if (!sameState(sourceState(value.source), action.previous)) throw new Error('Source metadata changed. Rejected command kept.');
            operations.push({ op: 'set_source', id: action.id, base_revision: block.revision, source: action.value });
            changed = !sameState(sourceState(value.source), action.value);
            value.source = action.value ? { block_id: action.id, added_at: 0, state_changed_at: 0, last_read_at: null, current_snapshot_id: null, siglum: '?', siglum_basis: '?', siglum_authored: false, siglum_disambiguation: null, ...value.source, ...action.value } : null;
          } else if (action.kind === 'cite') {
            const citation = action.citation;
            operations.push({ op: 'cite', id: action.id, base_revision: block.revision, citation_id: citation.id, snapshot_id: citation.snapshot_id, start: citation.start, end: citation.end, color: citation.color });
            changed = !(value.citations ?? []).some(item => item.id === citation.id);
            if (changed) value.citations = [...value.citations ?? [], citation];
          } else if (action.kind === 'uncite') {
            operations.push({ op: 'uncite', id: action.id, base_revision: block.revision, citation_id: action.citationId });
            changed = (value.citations ?? []).some(item => item.id === action.citationId);
            value.citations = (value.citations ?? []).filter(item => item.id !== action.citationId);
          } else if (action.kind === 'citationTriage') {
            const citation = value.citations?.find(item => item.id === action.citationId);
            if (!citation || citation.triage !== action.previous) throw new Error('Citation triage changed. Rejected command kept.');
            operations.push({ op: 'set_citation_triage', id: action.citationId, base_revision: block.revision, triage: action.triage });
            changed = citation.triage !== action.triage;
            citation.triage = action.triage;
          } else if (action.kind === 'highlightColor') {
            const citation = value.citations?.find(item => item.id === action.citationId);
            if (!citation || citation.color !== action.previous) throw new Error('Highlight colour changed. Rejected command kept.');
            operations.push({ op: 'set_citation_color', id: action.citationId, base_revision: block.revision, color: action.color });
            changed = citation.color !== action.color;
            citation.color = action.color;
          } else if (action.kind === 'citationRange') {
            const citation = value.citations?.find(item => item.id === action.citation.id);
            if (!citation || !sameState(citation.start, action.previous.start) || !sameState(citation.end, action.previous.end)) throw new Error('Citation range changed. Rejected command kept.');
            operations.push({ op: 'set_citation_range', id: citation.id, base_revision: block.revision, start: action.citation.start, end: action.citation.end });
            changed = !sameState(citation.start, action.citation.start) || !sameState(citation.end, action.citation.end);
            Object.assign(citation, action.citation);
          } else if (action.kind === 'completeTask') {
            if (!sameState(value.task, action.previous)) throw new Error('Task metadata changed before completion. Rejected command kept.');
            operations.push({ op: 'complete_task', id: action.id, base_revision: block.revision, occurrence_id: action.occurrenceId, completed_on: action.completedOn });
            changed = value.task?.status !== 'done' || Boolean(value.task.repeater);
          } else if (action.kind === 'reverseTaskCompletion') {
            if (!sameState(value.task, action.previous)) throw new Error('Task changed after completion. Its exact undo cannot overwrite newer metadata.');
            operations.push({ op: 'reverse_task_completion', id: action.id, base_revision: block.revision, occurrence_id: action.occurrenceId });
            value.task = action.value;
          } else {
            const session = work.get(action.session.id) ?? { ...action.session };
            if (action.kind === 'startWork') {
              operations.push({ op: 'start_work', id: action.id, base_revision: block.revision, session_id: session.id, started_at: session.started_at, note: session.note });
              session.revision = 1;
            } else if (action.kind === 'stopWork') {
              operations.push({ op: 'stop_work', id: action.id, base_revision: block.revision, session_id: session.id, session_revision: session.revision, ended_at: action.endedAt, note: action.note });
              session.ended_at = action.endedAt; session.note = action.note; session.revision++;
            } else if (action.kind === 'workNote') {
              operations.push({ op: 'edit_work_note', id: action.id, base_revision: block.revision, session_id: session.id, session_revision: session.revision, note: action.note });
              changed = session.note !== action.note; session.note = action.note; if (changed) session.revision++;
            } else {
              operations.push({ op: 'set_work_session_state', id: action.id, base_revision: block.revision, session_id: session.id, session_revision: session.revision, ended_at: action.endedAt, reversed: action.reversed });
              changed = session.ended_at !== action.endedAt || session.reversed !== action.reversed;
              session.ended_at = action.endedAt; session.reversed = action.reversed; if (changed) session.revision++;
            }
            work.set(session.id, session);
          }
          if (changed) block.revision++;
          break;
        }
        case 'split': {
          const block = current(action.id);
          operations.push({ op: 'split', id: action.id, base_revision: block.revision, new_id: action.block.id, left: action.left, right: action.right });
          if (block.text !== action.left) block.revision++;
          block.text = action.left;
          working.set(action.block.id, { ...action.block, revision: 1 });
          initialRevisions.set(action.block.id, 0);
          break;
        }
        case 'merge': {
          restoredPositions.delete(action.id);
          const source = current(action.id);
          const destination = current(action.destinationId);
          operations.push({ op: 'merge', source_id: action.id, source_revision: source.revision, destination_id: destination.id, destination_revision: destination.revision });
          if (source.text) destination.revision++;
          destination.text += source.text;
          for (const child of doc.baseOutline.children(source.id)) {
            const block = current(child);
            if (block.parent_id === source.id) { block.parent_id = destination.id; block.revision++; }
          }
          source.revision++; deleted.push(source.id);
          break;
        }
        case 'insert': {
          const block = { ...action.block, revision: 1 };
          if (block.kind === 'page') operations.push({ op: 'create_page', id: block.id, title: block.text });
          else if (block.kind === 'journal') operations.push({ op: 'create_journal', id: block.id, date: block.text });
          else operations.push({ op: 'insert', id: block.id, parent_id: block.parent_id!, after: action.after, text: block.text, heading: block.heading });
          working.set(block.id, block);
          initialRevisions.set(block.id, 0);
          break;
        }
        case 'text': {
          const block = current(action.id);
          operations.push({ op: 'edit_text', id: block.id, base_revision: action.baseRevision ?? block.revision, text: action.text });
          if (block.text !== action.text) block.revision++;
          block.text = action.text;
          break;
        }
        case 'heading': {
          const block = current(action.id);
          operations.push({ op: 'set_heading', id: block.id, base_revision: block.revision, heading: action.heading });
          if (block.heading !== action.heading) block.revision++;
          block.heading = action.heading;
          break;
        }
        case 'archive': {
          const block = current(action.id);
          operations.push({ op: 'set_archived', id: block.id, base_revision: block.revision, archived: action.archived });
          if (block.archived !== action.archived) block.revision++;
          block.archived = action.archived;
          break;
        }
        case 'fieldKind': {
          const block = current(action.id);
          operations.push({ op: 'set_field_kind', id: block.id, base_revision: action.baseRevision ?? block.revision, kind: action.value });
          if (action.value !== action.previous) block.revision++;
          break;
        }
        case 'fieldHide': {
          const block = current(action.id);
          operations.push({ op: 'set_field_hide', id: block.id, base_revision: action.baseRevision ?? block.revision, hide: action.value });
          if (action.value !== action.previous) block.revision++;
          break;
        }
        case 'fieldRole': {
          const block = current(action.id);
          operations.push({ op: 'set_field_role', id: block.id, base_revision: action.baseRevision ?? block.revision, role: action.value });
          if (action.value !== action.previous) block.revision++;
          break;
        }
        case 'fieldCountsAs': {
          const block = current(action.id);
          operations.push({ op: 'set_field_counts_as', id: block.id, base_revision: action.baseRevision ?? block.revision, counts_as: action.value });
          if (action.value !== action.previous) block.revision++;
          break;
        }
        case 'fieldTargets': {
          const block = current(action.id);
          operations.push({ op: 'set_field_targets', id: block.id, base_revision: action.baseRevision ?? block.revision, targets: action.targets });
          block.revision++;
          break;
        }
        case 'subjectCriteria': {
          const block = current(action.id);
          operations.push({ op: 'set_subject_criteria', subject_id: block.id, base_revision: action.baseRevision ?? block.revision, fields: action.fields });
          block.revision++;
          break;
        }
        case 'typePresentation': {
          const block = current(action.id);
          operations.push({ op: 'set_type_presentation', type_id: block.id, base_revision: action.baseRevision ?? block.revision, ...action.value });
          block.revision++;
          break;
        }
        case 'addType':
        case 'removeType': {
          const block = current(action.id);
          operations.push({ op: action.kind === 'addType' ? 'add_type' : 'remove_type', id: block.id, base_revision: block.revision, title: action.title });
          block.revision++;
          break;
        }
        case 'move': {
          restoredPositions.delete(action.id);
          const block = current(action.id);
          const after = action.after && current(action.after).parent_id === action.parentId ? action.after : null;
          operations.push({ op: 'move', id: block.id, base_revision: block.revision, parent_id: action.parentId, after });
          block.revision++;
          block.parent_id = action.parentId;
          break;
        }
        case 'delete': {
          restoredPositions.delete(action.id);
          const block = current(action.id);
          operations.push({ op: 'delete', id: block.id, base_revision: block.revision });
          deleted.push(block.id);
          block.revision++;
          const at = doc.baseOutline.indexOf(block.id);
          const descendants = block.id === doc.pageId ? doc.baseOutline.slice(0, doc.baseOutline.size()) : at >= 0 ? doc.baseOutline.slice(at + 1, doc.baseOutline.subtreeEnd(at)) : [];
          for (const row of descendants) current(row.id).revision++;
          break;
        }
        case 'restore': {
          const ticket = this.tickets.get(action.id);
          if (!ticket) throw new Error('Waiting for the deletion acknowledgement before restoring.');
          operations.push({ op: 'restore', id: action.id, deletion_id: ticket.deletionId, revision: ticket.revision });
          for (const snapshot of action.snapshots) {
            const saved = doc.baseBlocks.get(snapshot.block.id);
            working.set(snapshot.block.id, { ...snapshot.block, revision: (this.tickets.get(snapshot.block.id)?.revision ?? saved?.revision ?? snapshot.block.revision) + 1 });
            initialRevisions.set(snapshot.block.id, saved?.revision ?? snapshot.block.revision);
            capabilities.set(snapshot.block.id, snapshot.capabilities ?? emptyCapabilities(snapshot.block.id));
          }
          const block = current(action.id);
          if (block.parent_id) restoredPositions.set(block.id, { parentId: block.parent_id, after: action.after });
          break;
        }
      }
    }
    // Restored tombstones may have lost their gap to later moves. Reapply the
    // captured position last: a no-op move does not increment the core revision.
    for (const [id, position] of restoredPositions) {
      const block = current(id);
      const after = position.after && current(position.after).parent_id === position.parentId ? position.after : null;
      operations.push({ op: 'move', id, base_revision: block.revision, parent_id: position.parentId, after });
    }
    return { batch: { actor: { kind: 'client', name: this.actorName }, idempotency_key: command.id, operations }, deleted };
  }
  private async reject(command: Command, doc: Document | undefined, message: string) {
    const texts = new Map<string, string>();
    if (command.kind === 'notebook' && command.capture) texts.set(command.id, command.capture.text);
    for (const action of command.actions) {
      if (action.kind === 'text') texts.set(action.id, doc?.block(action.id)?.text ?? action.text);
      if (action.kind === 'insert' || action.kind === 'split') texts.set(action.block.id, doc?.block(action.block.id)?.text ?? action.block.text);
    }
    const frozen: { operations: Operation[] } | undefined = command.frozen ? JSON.parse(command.frozen) : undefined;
    command.rejection = { text: [...texts.values()].filter(Boolean).join('\n'), message,
      operations: frozen?.operations ?? (command.kind === 'notebook' ? command.operations : undefined),
      actions: structuredClone(command.actions) };
    this.rejected.set(command.id, command);
    await this.outbox?.put(command).catch(() => undefined);
    this.commandWaiters.get(command.id)?.reject(new Error(message));
    this.commandWaiters.delete(command.id);
    this.queue = this.queue.filter(item => item !== command);
    this.persisted.delete(command.id);
    this.generations.delete(command.id);
    doc?.forgetRejected(command.id);
    if (doc) { await doc.reload(false); this.closeUnused(doc); }
    this.touch();
  }
  private async sendNotebook(command: NotebookCommand): Promise<boolean> {
    let acknowledged = false;
    try {
      if (command.capture) {
        if (!command.frozen) {
          const prepared = await captureOperations(this, command.capture);
          command.operations = prepared.operations;
          command.refreshPages = [prepared.pageId];
          command.frozen = JSON.stringify({ actor: { kind: 'client', name: this.actorName }, idempotency_key: command.id, reason: command.reason, operations: command.operations });
        }
        const frozen = await this.outbox!.freezeCapture(command);
        if (!frozen) {
          // Another window already delivered this intake while its lookups were in flight.
          this.queue.shift(); this.persisted.delete(command.id); this.touch();
          return true;
        }
        command.frozen = frozen.frozen;
        command.operations = frozen.operations;
        command.refreshPages = frozen.refreshPages;
      }
      if (!command.frozen) {
        command.frozen = JSON.stringify({ actor: { kind: 'client', name: this.actorName }, idempotency_key: command.id, reason: command.reason, operations: command.operations });
        await this.persist(command);
      }
      if (!this.persisted.has(command.id)) await this.persist(command);
      if (!this.persisted.has(command.id)) return false;
      this.activeCommand = command.id; this.touch();
      const ack = await this.api.submitFrozen(command.frozen!);
      acknowledged = true;
      if (this.closed) return false;
      ack.capabilities = this.acceptCapabilities(ack.capabilities ?? [], ack.seq);
      if (ack.seq < this.workSequence) ack.work_sessions = [];
      this.serviceReached();
      const deletions = command.operations.filter(operation => operation.op === 'delete');
      for (let index = 0; index < deletions.length; index++) {
        const id = deletions[index]!.id;
        const deletionId = ack.deletions[index];
        const revision = ack.revisions.find(value => value.id === id)?.revision;
        if (deletionId && revision !== undefined) {
          const ticket = { deletionId, revision };
          this.tickets.set(id, ticket);
          await this.outbox?.ticket(id, ticket);
        }
      }
      const merges = command.operations.filter(operation => operation.op === 'merge_page');
      const removed = [...(ack.removed ?? [])];
      const removedIds = new Set(removed);
      for (const id of removed) this.receiveRemoval(id);
      const blocks = await Promise.all(ack.revisions.map(async value => {
        if (removedIds.has(value.id)) return undefined;
        try { return await this.api.block(value.id); }
        catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            removed.push(value.id);
            this.receiveRemoval(value.id);
            return undefined;
          }
          throw error;
        }
      }));
      for (const block of blocks) if (block) {
        this.publish(block);
        if (block.kind !== 'block') this.updateRoot(block);
        if (!merges.length) this.docs.get(block.page_id)?.receive(block);
      }
      if (merges.length) {
        const removed = new Set(merges.map(operation => operation.source_id));
        for (const id of removed) {
          this.publish(null, id);
          this.updateRoot(null, id);
          this.docs.get(id)?.markMissing('This page was merged into another page.');
        }
        // Own change-stream events are skipped. Reload here, including after an
        // outbox replay, so moved rows and rewritten manual memberships arrive.
        await Promise.all([...this.docs.values()].filter(doc => !removed.has(doc.pageId)).map(async doc => {
          try {
            const view = await this.api.page(doc.pageId);
            this.snapshotSequence.set(view, ack.seq);
            doc.merge(view, true);
          }
          catch (error) {
            if (error instanceof ApiError && error.status === 404) doc.markMissing(error.message);
            else throw error;
          }
        }));
        await this.refreshRoots();
      }
      this.receiveReceipt(ack);
      await Promise.all((command.refreshPages ?? []).map(async pageId => {
        try {
          const view = await this.api.page(pageId);
          this.snapshotSequence.set(view, ack.seq);
          const doc = this.docs.get(pageId);
          if (doc) doc.merge(view, true);
          else this.cachePage(view);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          removed.push(pageId);
          this.receiveRemoval(pageId);
        }
      }));
      await this.outbox?.capabilities(ack.capabilities ?? [], ack.seq);
      await this.outbox?.acknowledge(command, blocks.filter((block): block is Block => Boolean(block)), ack.seq, new Map(ack.revisions.map(value => [value.id, value.revision])), undefined,
        removed);
      this.queue.shift(); this.persisted.delete(command.id);
      this.commandWaiters.get(command.id)?.resolve(ack); this.commandWaiters.delete(command.id);
      this.activeCommand = undefined; this.touch();
      return true;
    } catch (error) {
      this.activeCommand = undefined;
      if (!acknowledged && error instanceof ApiError && !error.uncertain) { await this.reject(command, undefined, error.message); return true; }
      this.connectionSignal[1]('offline'); this.scheduleReconnect(); this.touch();
      return false;
    }
  }
  private receiveReceipt(ack: Committed) {
    for (const doc of this.docs.values()) {
      doc.receiveCapabilities(ack.capabilities ?? []);
      doc.receiveCardRevisions(ack.cards ?? []);
    }
    for (const session of ack.work_sessions ?? []) {
      if (!session.reversed && session.ended_at === null) this.activeWork = session;
      else if (this.activeWork?.id === session.id) this.activeWork = undefined;
    }
    if (ack.work_sessions?.length) this.workSequence = Math.max(this.workSequence, ack.seq);
    // Like a change event, but only with the changed blocks this window holds; `pages` names every touched page.
    const removed = new Set(ack.removed ?? []);
    const blocks = [...new Set([...ack.revisions, ...ack.text_rewrites].map(value => value.id))].flatMap(id => {
      if (removed.has(id)) return [];
      for (const doc of this.docs.values()) { const block = doc.baseBlocks.get(id); if (block) return [block]; }
      const block = this.cache.get(id)?.[0]();
      return block ? [block] : [];
    });
    this.observedChange[1]({ seq: ack.seq, actor: { kind: 'client', name: this.actorName }, reason: null, created_at: Date.now(), blocks, removed: [...removed], restructured_pages: [], pages: ack.pages,
      capabilities: ack.capabilities ?? [], cards: (ack.cards ?? []).map(value => value.id), work_sessions: (ack.work_sessions ?? []).map(value => value.id),
      review_sessions: (ack.review_sessions ?? []).map(value => value.id), decks: (ack.decks ?? []).map(value => value.id), task_views: (ack.task_views ?? []).map(value => value.id), library_views: (ack.library_views ?? []).map(value => value.id) });
    this.observedSequence[1](seq => Math.max(seq, ack.seq));
  }
  private acceptCapabilities(values: readonly BlockCapabilities[], sequence: number) {
    return values.filter(value => {
      if ((this.capabilitySequence.get(value.block_id) ?? -1) > sequence) return false;
      this.capabilitySequence.set(value.block_id, sequence);
      return true;
    });
  }
  private async drain() {
    await this.ready;
    if (this.sending || this.closed || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const command = this.queue[0]!;
        const draft = this.draftTag;
        if (draft?.commandId === command.id) {
          const wait = draft.until - Date.now();
          if (this.queue.length === 1 && wait > 0) { this.schedule(wait); break; }
          this.draftTag = null;
        }
        if (command.kind === 'notebook') { if (await this.sendNotebook(command)) continue; break; }
        const doc = this.docs.get(command.pageId) ?? this.open(command.pageId) as Document;
        if (doc.status() === 'loading') { await doc.reload(false); }
        if (doc.status() === 'missing' && !command.frozen) { await this.reject(command, doc, doc.statusMessage()); continue; }
        if (doc.status() !== 'ready' && !command.frozen) { this.failure = doc.statusMessage(); this.touch(); break; }
        if (!command.frozen && command.failed?.startsWith('A structural change could not be applied:')) { await this.reject(command, doc, command.failed); continue; }
        if (!command.frozen && (command.failed || command.actions.some(action => action.kind === 'text' && doc.block(action.id)?.conflict && !doc.isResolving(action.id)))) break;
        try {
          if (!command.frozen) {
            const compiled = this.compile(command, doc);
            command.frozen = JSON.stringify(compiled.batch);
            command.deleted = compiled.deleted;
            await this.persist(command);
          } else if (!this.persisted.has(command.id)) {
            await this.persist(command);
          }
          // A recovered frozen request is already durable. Retrying it must not
          // temporarily remove its edits from the locally queued count.
          if (!this.persisted.has(command.id)) break;
          this.activeCommand = command.id;
          this.touch();
          const ack = await this.api.submitFrozen(command.frozen);
          if (this.closed) break;
          ack.capabilities = this.acceptCapabilities(ack.capabilities ?? [], ack.seq);
          if (ack.seq < this.workSequence) ack.work_sessions = [];
          this.serviceReached();
          this.observedSequence[1](seq => Math.max(seq, ack.seq));
          const revisions = new Map(ack.revisions.map(revision => [revision.id, revision.revision]));
          for (const rewrite of ack.text_rewrites) revisions.set(rewrite.id, rewrite.revision);
          for (let i = 0; i < (command.deleted?.length ?? 0); i++) {
            const id = command.deleted![i]!;
            const deletionId = ack.deletions[i];
            const revision = revisions.get(id);
            if (deletionId && revision !== undefined) {
              const ticket = { deletionId, revision };
              this.tickets.set(id, ticket);
              void this.outbox?.ticket(id, ticket).catch(() => undefined);
            }
          }
          // Remove from optimistic replay only after acknowledgement; the durable
          // record remains until its receipt and structural patch have been stored.
          this.queue.shift();
          this.persisted.delete(command.id);
          this.generations.delete(command.id);
          doc.acknowledged(command, revisions, ack.text_rewrites, ack);
          this.receiveReceipt(ack);
          await this.outbox?.capabilities(ack.capabilities ?? [], ack.seq).catch(() => undefined);
          for (const pending of this.commands(doc.pageId)) if (!pending.frozen) await this.persist(pending);
          const historyChanges = new Set(doc.recordRewrites(command, ack.text_rewrites));
          const choices = command.resolutions?.filter(choice => doc.isResolving(choice.id)) ?? [];
          for (const choice of choices) if (!choice.deferred) doc.confirmResolution(choice.id, choice.text);
          const deferred = choices.filter(choice => choice.deferred);
          if (deferred.length) {
            const actions: Action[] = deferred.map(choice => ({ kind: 'text', id: choice.id, text: choice.text }));
            const inverse: Action[] = deferred.map(choice => ({ kind: 'text', id: choice.id, text: doc.snapshot(choice.id, true).text }));
            const next = this.enqueue(doc, actions, inverse, null, null, false);
            next.resolutions = deferred.map(choice => ({ ...choice, deferred: false }));
            next.order = command.order + 0.5;
            this.queue.splice(this.queue.indexOf(next), 1);
            this.queue.unshift(next);
            doc.refreshPending(new Set(deferred.map(choice => choice.id)));
          } else {
            for (const action of command.actions) if (action.kind === 'text' && doc.isResolving(action.id)) doc.conflictResolved(action.id);
          }
          const fullPage = command.actions.some(action => action.kind === 'insert' && action.block.kind !== 'block' || action.kind === 'restore' && action.id === doc.pageId);
          const blocks: Block[] = [];
          const removedIds = new Set(ack.removed ?? []);
          if (command.actions.some(action => action.kind === 'delete' && action.id === doc.pageId)) removedIds.add(doc.pageId);
          const removed = [...removedIds];
          for (const id of removed) this.receiveRemoval(id);
          let extraRoots = false;
          for (const id of revisions.keys()) {
            if (removedIds.has(id)) continue;
            const saved = doc.baseBlocks.get(id);
            const block = saved ? { ...saved } : await this.api.block(id).catch(error => {
              if (error instanceof ApiError && error.status === 404) {
                removed.push(id);
                this.receiveRemoval(id);
              }
              return undefined;
            });
            if (!block) continue;
            blocks.push(block);
            if (!saved) {
              this.publish(block);
              this.docs.get(block.page_id)?.receive(block);
              extraRoots ||= block.kind !== 'block';
            }
          }
          for (const document of this.docs.values()) for (const changed of document.refreshGuardVersions(blocks, revisions)) historyChanges.add(changed);
          for (const changed of historyChanges) {
            this.generations.set(changed.id, (this.generations.get(changed.id) ?? 0) + 1);
            await this.persist(changed);
          }
          await this.outbox?.acknowledge(command, blocks, ack.seq, revisions, fullPage && doc.root() ? doc.view() : undefined, removed).catch(() => undefined);
          this.failure = '';
          this.activeCommand = undefined;
          this.touch();
          if (extraRoots || command.actions.some(action => action.kind === 'insert' && action.block.kind !== 'block' || action.kind === 'delete' && action.id === doc.pageId || action.kind === 'restore' && action.id === doc.pageId || action.kind === 'text' && action.id === doc.pageId)) await this.refreshRoots().catch(() => this.connectionSignal[1]('offline'));
          if (command.actions.some(action => action.kind === 'text' && action.id === doc.pageId)) {
            const pages = new Set(blocks.filter(block => block.id !== doc.pageId).map(block => block.page_id));
            for (const page of pages) await this.docs.get(page)?.reload(false);
          }
          // Derived type pages alone appear as new roots in a text/Add type receipt.
          // Ordinary page creation and references to existing empty type pages do not seed templates.
          for (const block of blocks) {
            if (block.kind !== 'page' || revisions.get(block.id) !== 1 || !startingTemplateFor(block.text)
              || command.actions.some(action => action.kind === 'insert' && action.block.id === block.id)) continue;
            try {
              const template = await this.api.startingTemplate(block.id);
              if (template) this.receiveReceipt(template);
            } catch (error) {
              // The original edit is already acknowledged; never reject or replay it for this failure.
              this.failure = error instanceof Error ? error.message : String(error);
            }
          }
          this.closeUnused(doc);
        } catch (error) {
          this.activeCommand = undefined;
          if (error instanceof ApiError && error.uncertain) {
            this.connectionSignal[1]('offline');
            this.failure = '';
            this.scheduleReconnect();
          } else if (error instanceof ApiError && error.status === 409) {
            if (command.actions.some(isCapabilityAction)) { await this.reject(command, doc, `The source changed. ${error.message}`); continue; }
            // This request definitively wrote nothing; only now may its frozen revision be retired.
            command.frozen = undefined;
            await doc.reload(true);
            const structural = doc.status() === 'missing' || command.actions.some(action => {
              if (action.kind === 'text' || action.kind === 'heading' || action.kind === 'archive') return !doc.block(action.id);
              return true;
            });
            if (structural) {
              await this.reject(command, doc, 'A structural change could not be applied because the notebook changed. Rejected text is kept for copying; the operation was not reapplied.');
              continue;
            } else {
              const choices = command.resolutions?.filter(choice => doc.isResolving(choice.id)) ?? [];
              if (choices.length) {
                for (const action of command.actions) if (action.kind === 'text') {
                  const choice = choices.find(item => item.id === action.id);
                  if (choice) action.text = choice.text;
                }
                command.resolutions = choices.map(choice => ({ ...choice, deferred: false }));
                command.failed = undefined;
                await this.persist(command);
                continue;
              }
              if (doc.status() === 'ready' && !command.actions.some(action => action.kind === 'text' && doc.block(action.id)?.conflict && !doc.isResolving(action.id))) {
                for (const action of command.actions) if (action.kind === 'text' && action.baseRevision !== undefined) action.baseRevision = doc.baseBlocks.get(action.id)!.revision;
                command.failed = undefined;
                await this.persist(command);
                continue;
              }
              command.failed = 'Conflict · Both versions kept';
              await this.persist(command);
            }
          } else {
            this.failure = error instanceof Error ? error.message : String(error);
            command.failed = this.failure;
            if (error instanceof ApiError) {
              if (command.actions.some(isCapabilityAction)) { await this.reject(command, doc, this.failure); continue; }
              command.frozen = undefined;
              if (command.actions.some(action => action.kind === 'insert' || action.kind === 'move' || action.kind === 'delete' || action.kind === 'restore' || action.kind === 'split' || action.kind === 'merge')) {
                await this.reject(command, doc, this.failure);
                continue;
              } else await this.persist(command);
            } else if (command.actions.some(isCapabilityAction)) { await this.reject(command, doc, this.failure); continue; }
            else await this.persist(command);
          }
          this.touch();
          break;
        }
      }
    } finally { this.sending = false; if (!this.queue.length) this.firstQueuedAt = 0; this.touch(); }
  }
  state(pageId?: string): SaveState {
    this.revision[0]();
    const commands = pageId ? this.queue.filter(command => command.pageId === pageId) : this.queue;
    const docs = pageId ? [this.docs.get(pageId)] : [...this.docs.values()];
    if ([...this.rejected.values()].some(command => !pageId || command.pageId === pageId)) return 'error';
    if (docs.some(doc => doc?.hasConflict())) return 'conflict';
    if ((this.persistenceFailure && commands.length) || this.failure || commands.some(command => command.failed)) return 'error';
    if (commands.some(command => !this.persisted.has(command.id))) return 'queued';
    if (this.connection() === 'offline') return 'offline';
    if (commands.some(command => command.id === this.activeCommand)) return 'saving';
    return commands.length ? 'queued' : 'saved';
  }
  saveState() { return this.state(); }
  message(pageId?: string) {
    const state = this.state(pageId);
    if (this.persistenceFailure && (pageId ? this.commands(pageId).length : this.queue.length)) return this.persistenceFailure;
    const rejected = [...this.rejected.values()].filter(command => !pageId || command.pageId === pageId);
    if (rejected.length) return `Couldn’t apply a change · Rejected data kept. ${rejected.map(command => command.rejection?.message).join(' ')}\n${rejected.map(rejectionText).filter(Boolean).join('\n\n')}`;
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (state === 'error') return `Couldn’t save · Local changes kept. ${this.failure || this.queue.find(command => command.failed)?.failed || ''}`;
    if (state === 'offline') { const n = this.queuedChanges(); return n ? `Offline · ${n} changes queued locally` : 'Offline · All changes saved'; }
    return state === 'saved' ? 'Saved' : 'Saving…';
  }
  saveMessage() { return this.message(); }
  queuedChanges() { this.revision[0](); return this.queue.filter(command => this.persisted.has(command.id)).reduce((count, command) => count + (command.kind === 'notebook' ? command.operations.length || (command.capture ? 1 : 0) : command.actions.length), 0); }
  unsavedText() {
    // A notebook command shows its words; one without words, like a capability change, keeps its payload as the record.
    const operations = this.queue.flatMap(command => command.kind === 'notebook' ? [command.capture?.text || authoredText(command.operations).join('\n') || (command.frozen ?? JSON.stringify(command.operations))] : command.actions.some(isCapabilityAction) ? [command.frozen ?? JSON.stringify(command.actions)] : []);
    return [...this.docs.values()].map(doc => doc.localText()).concat(operations, this.rejectedText()).filter(Boolean).join('\n\n');
  }
  rejectedText() { this.revision[0](); return [...this.rejected.values()].map(command => rejectionText(command) || command.rejection?.message || '').filter(Boolean).join('\n\n'); }
  dismissRejected() {
    for (const id of this.rejected.keys()) void this.outbox?.remove(id).catch(() => undefined);
    this.rejected.clear();
    this.failure = '';
    this.touch();
  }
  conflictedPages(): readonly string[] {
    this.revision[0]();
    return [...this.docs.values()].filter(doc => doc.hasConflict()).map(doc => doc.pageId);
  }
  titleAvailable(title: string, exceptId: string) {
    const key = titleKey(title);
    return !this.roots().some(root => root.kind === 'page' && root.id !== exceptId && titleKey(root.text) === key);
  }
  retry() {
    this.failure = '';
    for (const command of this.queue) {
      const doc = command.pageId ? this.docs.get(command.pageId) : undefined;
      if (!command.actions.some(action => action.kind === 'text' && doc?.block(action.id)?.conflict && !doc.isResolving(action.id))) command.failed = undefined;
      void this.persist(command);
    }
    this.touch();
    this.schedule(0);
    void this.connect();
  }
  private async refreshRoots() {
    const roots = await this.api.roots();
    const pending = new Map<string, Block | null>();
    for (const command of this.queue) for (const action of command.actions) {
      const id = action.kind === 'insert' ? action.block.id : action.id;
      if (id !== command.pageId) continue;
      if (action.kind === 'insert' && action.block.kind !== 'block') pending.set(id, action.block);
      else if (action.kind === 'delete') pending.set(id, null);
      else if (action.kind === 'restore') pending.set(id, action.snapshots.find(snapshot => snapshot.block.id === id)?.block ?? null);
      else if (action.kind === 'text' || action.kind === 'archive') {
        const root = pending.get(id) ?? this.roots().find(root => root.id === id) ?? roots.find(root => root.id === id);
        if (root) pending.set(id, { ...root, ...(action.kind === 'text' ? { text: action.text } : { archived: action.archived }) });
      }
    }
    for (const [id, value] of pending) {
      const doc = this.docs.get(id);
      const block = doc?.root() ? doc.snapshot(id) : value;
      const at = roots.findIndex(root => root.id === id);
      if (block) { if (at < 0) roots.push(block); else roots[at] = block; }
      else if (at >= 0) roots.splice(at, 1);
    }
    this.setRoots(roots);
    for (const root of roots) this.publish(root);
    void this.outbox?.roots(roots).catch(() => undefined);
  }
  private serviceReached() {
    if (this.closed) return;
    if (this.socket?.readyState === CHANGE_OPEN) {
      const recovered = this.connection() !== 'live';
      this.connectionSignal[1]('live');
      this.reconnectDelay = 500;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
      if (recovered) this.retryLookups();
    } else void this.connect();
  }
  private async seedCursor() {
    const head = await this.api.changeHead();
    if (this.cursorSeeded) return;
    this.seq = head;
    this.cursorSeeded = true;
    this.observedSequence[1](head);
  }
  private async prepareReplay() {
    const head = await this.api.changeHead();
    let after = this.cursorSeeded ? this.seq : head;
    let reset = after > head;
    let reload = this.reloadRequired || (!this.cursorSeeded && !this.recoveryPages.size) || reset;
    for (const cursor of this.recoveryPages.values()) {
      if (cursor === undefined) reload = true;
      else if (cursor > head) { reload = true; reset = true; }
      else after = Math.min(after, cursor);
    }
    reload ||= head - after > MAX_CATCH_UP;
    if (reload || after !== this.seq) {
      // Detach before closing so the old socket cannot append events behind the new floor.
      const socket = this.socket;
      this.socket = undefined;
      socket?.close();
    }
    const recovering = !this.cursorSeeded || this.recoveryPages.size > 0;
    if (reload) {
      this.reloadRequired = true;
      if (reset) await this.outbox?.resetJournal();
      this.seq = head;
      this.cursorSeeded = true;
      this.observedSequence[1](head);
      this.capabilitySequence.clear();
      this.workSequence = 0;
      await this.refreshRoots();
      await this.refreshSettings();
      await this.refreshWork(head);
      for (const doc of this.docs.values()) {
        this.recoveryPages.set(doc.pageId, undefined);
        await doc.reload(true);
      }
    } else {
      this.seq = after;
      this.cursorSeeded = true;
      if (recovering) {
        await this.refreshRoots();
        await this.refreshSettings();
        await this.refreshWork(head);
      }
      // A cache can be opened after this window already consumed its missed events.
      // Refresh it before resuming, including structural changes and sync rebases.
      for (const id of this.recoveryPages.keys()) await this.docs.get(id)?.reload(true);
    }
    if (this.recoveryPages.size) throw new Error('Cached pages still need a server snapshot.');
    this.reloadRequired = false;
  }
  private async connect() {
    await this.ready;
    if (this.closed) return;
    if (this.connecting) return this.connecting;
    const work = this.reconcileConnection();
    this.connecting = work;
    try { await work; }
    finally { if (this.connecting === work) this.connecting = undefined; }
  }
  private async reconcileConnection() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.connectionSignal[1]('connecting');
    try {
      const work = this.streamWork.then(async () => {
        await this.prepareReplay();
        while (!this.closed) {
          const events = await this.api.changes(this.seq);
          await this.catchUp(events);
          if (events.length < MAX_CATCH_UP) break;
        }
      });
      this.streamWork = work.catch(() => undefined);
      await work;
      if (this.closed) return;
      this.retryLookups();
      if (this.socket?.readyState === CHANGE_OPEN) { this.serviceReached(); return; }
      if (this.socket?.readyState === CHANGE_CONNECTING) return;
      const socket = this.api.stream(this.seq);
      this.socket = socket;
      socket.onopen = () => {
        if (this.closed || this.socket !== socket) return;
        this.serviceReached(); this.schedule(0);
      };
      socket.onmessage = message => {
        if (this.closed || this.socket !== socket) return;
        this.streamWork = this.streamWork.then(async () => {
          if (!this.closed && this.socket === socket) await this.change(JSON.parse(String(message.data)) as ChangeEvent);
        }).catch(error => {
          this.failure = `Could not read notebook changes: ${error instanceof Error ? error.message : String(error)}`;
          this.touch();
        });
      };
      socket.onerror = () => { if (this.socket === socket) socket.close(); };
      socket.onclose = () => {
        if (this.closed || this.socket !== socket) return;
        this.socket = undefined;
        this.connectionSignal[1]('offline'); this.scheduleReconnect();
      };
      this.schedule(0);
    } catch { if (!this.closed) { this.connectionSignal[1]('offline'); this.scheduleReconnect(); } }
  }
  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);
  }
  private async reconcile(blocks: readonly Block[], removed: readonly string[], pages: readonly string[], capabilities: readonly BlockCapabilities[] = [], force = false) {
    const structured = new Set(pages);
    for (const block of blocks) {
      this.publish(block, block.id, force);
      if (!structured.has(block.page_id)) this.docs.get(block.page_id)?.receive(block);
    }
    for (const id of removed) this.publish(null, id);
    for (const id of structured) {
      const doc = this.docs.get(id);
      if (doc && (force || doc.needsRefresh(blocks, removed))) await doc.reload(true);
    }
    for (const doc of this.docs.values()) doc.receiveCapabilities(capabilities);
    if (blocks.some(block => block.kind !== 'block') || removed.some(id => this.roots().some(root => root.id === id))) await this.refreshRoots();
  }
  private async catchUp(events: readonly ChangeEvent[]) {
    if (!events.length) return;
    const blocks = new Map<string, Block>();
    const removed = new Set<string>();
    const pages = new Set<string>();
    const capabilities = new Map<string, BlockCapabilities>();
    for (const event of events) {
      if (event.seq <= this.seq || event.actor.kind === 'client' && event.actor.name === this.actorName) continue;
      for (const block of event.blocks) { blocks.set(block.id, block); removed.delete(block.id); }
      for (const id of event.removed) { removed.add(id); blocks.delete(id); }
      for (const id of event.restructured_pages) pages.add(id);
      for (const value of this.acceptCapabilities(event.capabilities ?? [], event.seq)) capabilities.set(value.block_id, value);
    }
    const synced = events.some(event => event.actor.kind === 'client' && event.actor.name === 'sync');
    await this.reconcile([...blocks.values()], [...removed], [...pages], [...capabilities.values()], synced);
    const latest = events.at(-1)!;
    await this.outbox?.capabilities([...capabilities.values()], latest.seq);
    const changed = events.filter(event => event.seq > this.seq);
    // Own events are included: a reader can't tell which of their pages the receipts already reported.
    const touched = new Map<string, Block>();
    for (const event of changed) for (const block of event.blocks) touched.set(block.id, block);
    this.observedChange[1]({ ...latest, capabilities: [...capabilities.values()],
      blocks: [...touched.values()],
      removed: [...new Set(changed.flatMap(event => event.removed))],
      restructured_pages: [...new Set(changed.flatMap(event => event.restructured_pages))],
      pages: changed.every(event => event.pages) ? [...new Set(changed.flatMap(event => event.pages!))] : undefined,
      views: [...new Set(changed.flatMap(event => event.views ?? []))],
      cards: [...new Set(changed.flatMap(event => event.cards ?? []))],
      work_sessions: [...new Set(changed.flatMap(event => event.work_sessions ?? []))],
      review_sessions: [...new Set(changed.flatMap(event => event.review_sessions ?? []))],
      decks: [...new Set(changed.flatMap(event => event.decks ?? []))],
      task_views: [...new Set(changed.flatMap(event => event.task_views ?? []))],
      library_views: [...new Set(changed.flatMap(event => event.library_views ?? []))] });
    if (changed.some(event => event.work_sessions?.length)) await this.refreshWork(latest.seq);
    if (events.some(event => (event.settings ?? []).length)) await this.refreshSettings();
    this.seq = Math.max(this.seq, events.at(-1)!.seq);
    this.observedSequence[1](seq => Math.max(seq, this.seq));
    this.touch();
  }
  private async change(event: ChangeEvent) {
    if (event.seq <= this.seq) return;
    if (event.actor.kind !== 'client' || event.actor.name !== this.actorName) {
      const capabilities = this.acceptCapabilities(event.capabilities ?? [], event.seq);
      await this.reconcile(event.blocks, event.removed, event.restructured_pages, capabilities, event.actor.kind === 'client' && event.actor.name === 'sync');
      await this.outbox?.capabilities(capabilities, event.seq);
      if (event.work_sessions?.length) await this.refreshWork(event.seq);
    }
    if (event.settings?.length) await this.refreshSettings();
    this.seq = event.seq;
    this.observedChange[1]({ ...event, views: event.views ?? [] });
    this.observedSequence[1](seq => Math.max(seq, event.seq));
    this.touch();
  }
  private async refreshWork(sequence: number) {
    const active = await this.api.activeWorkSession();
    if (sequence >= this.workSequence) { this.activeWork = active ?? undefined; this.workSequence = sequence; }
  }
  async refreshSettings() {
    const value = await this.api.settings();
    if (!this.closed) this.settingsSignal[1](value);
  }
  todayDate() {
    const current = this.settings();
    if (current && this.connection() !== 'offline') return current.today;
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  async today(signal?: AbortSignal) {
    await this.ready;
    signal?.throwIfAborted();
    try { await this.refreshSettings(); } catch { this.connectionSignal[1]('offline'); }
    return this.journal(this.todayDate(), signal);
  }
  private async writeSetting(key: SettingEdit['key'], value: string, baseRevision: number | null) {
    const committed = await this.api.submit({
      actor: { kind: 'client', name: this.actorName },
      idempotency_key: ulid(),
      operations: [{ op: 'set_setting', key, base_revision: baseRevision, value }],
    });
    const revision = committed.settings.find(setting => setting.key === key)!.revision;
    // Keep the acknowledged value even if the subsequent calendar refresh fails.
    const previous = this.settings()!;
    this.settingsSignal[1]({ ...previous, settings: [
      ...previous.settings.filter(setting => setting.key !== key),
      { key, value, revision, updated_at: Date.now() },
    ] });
    try { await this.refreshSettings(); } catch { this.connectionSignal[1]('offline'); }
    return revision;
  }
  private async settingAction(action: () => Promise<void>) {
    if (this.settingsBusy()) return;
    this.settingBusy[1](true); this.settingError[1]('');
    try { await this.ready; await action(); }
    catch (error) {
      this.settingError[1](error instanceof Error ? error.message : String(error));
      try { await this.refreshSettings(); } catch { /* Keep the last acknowledged values. */ }
      throw error;
    } finally { this.settingBusy[1](false); this.touch(); }
  }
  async setSetting(key: SettingEdit['key'], value: string) {
    return this.settingAction(async () => {
      if (!this.settings()) await this.refreshSettings();
      const settings = this.settings()!;
      const current = settings.settings.find(setting => setting.key === key);
      const before = current?.value ?? (key === 'vim' ? 'false' : key === 'confirm_view_delete' ? 'true' : settings.time_zone);
      if (current?.value === value) return;
      const revision = await this.writeSetting(key, value, current?.revision ?? null);
      this.settingUndo.push({ key, before, after: value, revision });
      this.settingRedo = [];
    });
  }
  async undoSetting() { return this.travelSetting(this.settingUndo, this.settingRedo, false); }
  async redoSetting() { return this.travelSetting(this.settingRedo, this.settingUndo, true); }
  private async travelSetting(from: SettingEdit[], to: SettingEdit[], redo: boolean) {
    return this.settingAction(async () => {
      const edit = from.at(-1); if (!edit) return;
      const revision = await this.writeSetting(edit.key, redo ? edit.after : edit.before, edit.revision);
      from.pop(); to.push({ ...edit, revision });
      for (let index = from.length - 1; index >= 0; index--) {
        if (from[index]!.key === edit.key) { from[index]!.revision = revision; break; }
      }
    });
  }
  async journal(date: string, signal?: AbortSignal) {
    await this.ready;
    signal?.throwIfAborted();
    const cached = this.roots().find(root => root.kind === 'journal' && root.text === date);
    if (cached) return cached.id;
    try { return (await this.api.journal(date, signal)).id; }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ApiError) || error.status !== 404 && !error.uncertain) throw error;
    }
    signal?.throwIfAborted();
    try { return await this.createRoot('journal', date); }
    catch (error) {
      signal?.throwIfAborted();
      try { return (await this.api.journal(date, signal)).id; } catch { throw error; }
    }
  }
  async createPage(title: string) {
    await this.ready;
    if (!title.trim()) throw new Error('A page needs a title.');
    if (!this.titleAvailable(title.trim(), '')) throw new Error('That page title is already taken.');
    return this.createRoot('page', title.trim());
  }
  async pageByTitle(title: string, create: boolean) {
    await this.ready;
    const cached = this.roots().find(root => root.kind === 'page' && root.text.toLocaleLowerCase() === title.toLocaleLowerCase());
    if (cached) return cached.id;
    try { return (await this.api.pageByTitle(title)).id; }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 404 && !(create && error.uncertain)) throw error; }
    if (!create) return null;
    try { return await this.createPage(title); }
    catch (error) { try { return (await this.api.pageByTitle(title)).id; } catch { throw error; } }
  }
  private async createRoot(kind: 'page' | 'journal', text: string) {
    const id = ulid();
    const doc = this.open(id) as Document;
    const root: Block = { id, kind, parent_id: null, page_id: id, text, heading: null, archived: false, kept_copy: null, revision: 0, created_at: Date.now(), updated_at: Date.now() };
    doc.merge({ root, rows: [], targets: [] }, false);
    const action: Action = { kind: 'insert', block: root, after: null };
    const child: Action = { kind: 'insert', block: { ...root, id: ulid(), kind: 'block', parent_id: id, text: '' }, after: null };
    doc.apply(child);
    const command = this.enqueue(doc, [action, child], [{ kind: 'delete', id }], null, null, false);
    const roots = [...this.roots(), root];
    this.setRoots(roots);
    this.publish(root);
    try {
      if (!this.outbox) throw new Error('Recovery storage has not opened.');
      await this.outbox.create(command, { root, rows: [], targets: [] }, roots);
      if (this.queue.includes(command)) this.persisted.add(command.id);
      this.touch();
      return id;
    } catch (error) {
      if (this.localPersistence() !== 'failed') this.storageFailed(error);
      throw new Error(this.persistenceFailure);
    } finally { doc.release(); }
  }
  async mergePage(from: string, into: string): Promise<void> {
    await Promise.all([this.flushPage(from), this.flushPage(into)]);
    const [source, destination] = await Promise.all([this.api.block(from), this.api.block(into)]);
    await this.commit([{
      op: 'merge_page', source_id: from, source_revision: source.revision,
      destination_id: into, destination_revision: destination.revision,
    }]);
  }
  async deletePage(pageId: string, options?: { retainHistory?: boolean }) {
    await this.ready;
    const doc = this.open(pageId) as Document;
    try {
      if (doc.status() !== 'ready') await doc.reload();
      doc.retainHistoryOnDelete = options?.retainHistory ?? false;
      const action: Action = { kind: 'delete', id: pageId };
      const inverse = doc.apply(action);
      this.deletedPages.set(pageId, inverse[0]!);
      this.enqueue(doc, [action], inverse, null, null, false);
      await this.flush();
    } catch (error) {
      doc.retainHistoryOnDelete = false;
      throw error;
    } finally { doc.release(); }
  }
  async restorePage(pageId: string) {
    const action = this.deletedPages.get(pageId);
    if (!action) {
      const page = (await this.api.deletedPages()).find(page => page.block.id === pageId);
      if (!page) throw new Error('This page deletion is no longer available to restore.');
      await this.commit([{ op: 'restore', id: pageId, deletion_id: page.deletion_id, revision: page.block.revision }]);
      return;
    }
    const doc = this.docs.get(pageId)!;
    const inverse = doc.apply(action);
    this.enqueue(doc, [action], inverse, null, null, false);
    await this.flush();
    this.deletedPages.delete(pageId);
  }
  /** Test/embedding drain point; it never claims failed or offline requests committed. */
  async flush() {
    await this.ready;
    this.draftTag = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    while (this.sending) {
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 5);
      await wait.promise;
    }
    await this.drain();
    await this.outbox?.settled();
  }
  async dispose() {
    this.closed = true;
    this.subtreeCache.dispose();
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.online);
      window.removeEventListener('beforeunload', this.beforeUnload);
    }
    await this.outbox?.close();
  }
}

/** Keys whose strings someone wrote. Everything else in a change (IDs, revisions, structure) stays internal. */
const AUTHORED_KEYS: Record<string, true> = { text: true, title: true, left: true, right: true, name: true, front: true, back: true };
/** The request's actor, an action's earlier value and another device's kept copy are not this change's words. */
const FOREIGN_KEYS: Record<string, true> = { actor: true, previous: true, inverse: true, copy: true };

/** The distinct words written in a change, in order, for recovery after the service refuses it. */
function authoredText(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) authoredText(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FOREIGN_KEYS[key]) continue;
      if (typeof item !== 'string') authoredText(item, into);
      else if (AUTHORED_KEYS[key] && item.trim() && !into.includes(item)) into.push(item);
    }
  }
  return into;
}

/**
 * What a refused change kept for the person: its words, plus the payload only where the change has no words to show.
 * Task, source and work changes carry dates and states rather than prose, so their payload is the only record.
 */
function rejectionText(command: Command): string {
  const rejection = command.rejection;
  if (!rejection) return '';
  const words = rejection.text || authoredText(rejection.operations ?? rejection.actions).join('\n');
  const structured = (rejection.actions ?? []).filter(isCapabilityAction);
  const record = structured.length ? JSON.stringify(structured) : words ? '' : JSON.stringify(rejection.operations ?? rejection.actions ?? []);
  return [words, record].filter(Boolean).join('\n');
}

export function createNotebookClient(options?: NotebookOptions): Notebook { return new Notebook(options); }
