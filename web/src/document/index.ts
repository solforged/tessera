import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { ApiError, CHANGE_CONNECTING, CHANGE_OPEN, createApi } from '../api/client';
import type { Batch, Block, BlockCapabilities, ChangeEvent, Committed, Operation, PageView, SettingsView, WorkSession } from '../api/types';
import type { ApiClient, ChangeSocket } from '../api/client';
import type { Caret, NotebookClient, PageDocument, SaveState } from './contract';
import { Document } from './page-document';
import type { DocumentHost } from './page-document';
import { Outbox } from './outbox';
import type { Action, Command, Compiled, NotebookCommand, PageCommand, Ticket } from './types';
import { emptyCapabilities, isCapabilityAction, questionStatus, sameState, sourceState } from './types';
export type { NotebookClient, PageDocument, BlockState, Caret, Edit, EditResult, SaveState } from './contract';

export interface NotebookOptions {
  baseUrl?: string;
  /** A test or embedding may supply its own persistent window identity. */
  sessionId?: string;
  notebookId?: string;
  databaseName?: string;
  coalesceMs?: number;
}

type SettingEdit = { key: 'time_zone' | 'vim'; before: string; after: string; revision: number };

/** Back and forward between a few pages reopens them without a reload; each warm page keeps its rows in memory. */
const WARM_DOCUMENTS = 3;
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
  private queue: Command[] = [];
  private tickets = new Map<string, Ticket>();
  private deletedPages = new Map<string, Action>();
  private rejected = new Map<string, Command>();
  private outbox?: Outbox;
  private snapshotSequence = new WeakMap<PageView, number>();
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
  private reconnectDelay = 500;
  private streamWork = Promise.resolve();
  private firstQueuedAt = 0;
  private order = Date.now() * 1000;
  private sessionId: string;
  private actorName: string;
  private persisted = new Set<string>();
  private generations = new Map<string, number>();
  private commandWaiters = new Map<string, { resolve(value: Committed): void; reject(error: Error): void }>();
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
  settingsMessage = () => this.settingError[0]() ? `Couldn’t save · ${this.settingError[0]()}` : this.settingsBusy() ? 'Saving…' : this.connection() === 'offline' ? 'Offline' : 'Saved';
  canUndoSetting = () => { this.revision[0](); return !this.settingsBusy() && this.settingUndo.length > 0; };
  canRedoSetting = () => { this.revision[0](); return !this.settingsBusy() && this.settingRedo.length > 0; };
  constructor(private options: NotebookOptions = {}) {
    this.api = createApi(options.baseUrl);
    const roots = createSignal<readonly Block[]>([]);
    this.roots = roots[0];
    this.setRoots = roots[1];
    const sessionKey = `tessera:window:${options.baseUrl ?? ''}`;
    let identity = options.sessionId;
    if (!identity) {
      try { identity = sessionStorage.getItem(sessionKey) ?? ulid(); sessionStorage.setItem(sessionKey, identity); }
      catch { identity = ulid(); }
    }
    this.sessionId = identity;
    this.actorName = `tessera-web:${identity}`;
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
      const rejected = [...this.rejected.values()].find(command => command.pageId === waiter.pageId);
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
    try { this.cachedVim[1](JSON.parse(localStorage.getItem(`tessera.navigation.${notebookId}`) ?? '{}').vim === true); } catch { /* Optional offline preference. */ }
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
    const warm = this.warm.indexOf(doc.pageId);
    if (warm >= 0) this.warm.splice(warm, 1);
  }
  commands(pageId: string): PageCommand[] { this.revision[0](); return this.queue.filter((command): command is PageCommand => command.kind !== 'notebook' && command.pageId === pageId); }
  async loadPage(id: string) {
    const sequence = this.changeSequence();
    try {
      const view = await this.api.page(id);
      this.snapshotSequence.set(view, sequence);
      return view;
    } catch (error) {
      const provisional = this.queue.some(command => command.pageId === id && command.actions.some(action => action.kind === 'insert' && action.block.id === id));
      if (!(error instanceof ApiError) || error.uncertain || error.status === 404 && provisional) {
        const cached = await this.outbox?.cachedPage(id);
        if (cached) { this.cachedViews.add(cached); return cached; }
      }
      throw error;
    }
  }
  /** Writes a loaded view to recovery storage once; a merge offers the same view more than once. */
  cachePage(view: PageView) {
    if (this.cachedViews.has(view)) return;
    this.cachedViews.add(view);
    const capabilities = new Map((view.capabilities ?? []).map(value => [value.block_id, value]));
    void this.outbox?.capabilities([view.root, ...view.rows.map(row => row.block)].map(block => capabilities.get(block.id) ?? emptyCapabilities(block.id)), this.snapshotSequence.get(view) ?? 0).catch(() => undefined);
    void this.outbox?.page(view, this.snapshotSequence.get(view) ?? 0).catch(() => undefined);
  }
  publish(block: Block | null, id = block?.id) {
    if (!id) return;
    if (block && block.kind !== 'block') {
      const doc = this.docs.get(id);
      const root = doc?.root();
      if (root?.pending && block.revision <= root.revision) block = doc!.snapshot(id);
    }
    const entry = this.cache.get(id);
    if (entry) {
      const current = entry[0]();
      if (!block || !current || block.revision >= current.revision) entry[1](block);
    }
    else this.cache.set(id, createSignal<Block | null | undefined>(block));
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
      previous.actions = structuredClone(actions);
      previous.after = after;
      previous.failed = undefined;
      this.persisted.delete(previous.id);
      command = previous;
    } else {
      command = { id: ulid(), order: ++this.order, pageId: doc.pageId, actions: structuredClone(actions), inverse: structuredClone(inverse), before, after };
      this.queue.push(command);
    }
    this.generations.set(command.id, (this.generations.get(command.id) ?? 0) + 1);
    this.failure = '';
    this.touch();
    queueMicrotask(() => { void this.persist(command); });
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    this.schedule(coalesce ? Math.min(Math.max(150, Math.min(300, this.options.coalesceMs ?? 200)), Math.max(0, 1000 - (Date.now() - this.firstQueuedAt))) : 0);
    return command;
  }
  async commit(operations: readonly Operation[], reason?: string): Promise<Committed> {
    const id = ulid();
    const frozen = JSON.stringify({ actor: { kind: 'client', name: this.actorName }, idempotency_key: id, reason, operations });
    const snapshot: Batch = JSON.parse(frozen);
    if (!this.initialized) await this.ready;
    if (this.closed) throw new Error('The notebook is closed.');
    if (!snapshot.operations.length) throw new Error('A command needs an operation.');
    const command: NotebookCommand = { kind: 'notebook', id, order: ++this.order, pageId: null, operations: snapshot.operations, reason, actions: [], inverse: [], before: null, after: null, frozen };
    const waiter = Promise.withResolvers<Committed>();
    this.commandWaiters.set(id, waiter);
    this.queue.push(command);
    this.touch();
    void this.persist(command).then(() => this.schedule(0));
    return waiter.promise;
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
    if (rejected.length) return rejected.map(command => `${command.rejection!.message}\n${JSON.stringify(command.rejection!.operations ?? command.operations)}`).join('\n\n');
    if (this.queue.some(command => command.kind === 'notebook') && this.persistenceFailure) return this.persistenceFailure;
    if (state === 'error') return this.persistenceFailure || this.queue.find(command => command.kind === 'notebook' && command.failed)?.failed || 'Command failed.';
    return state === 'saved' ? 'Saved' : state === 'offline' ? 'Offline · Command kept for retry' : 'Saving…';
  }
  async flushPage(pageId: string) {
    await this.ready;
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
        case 'task':
        case 'project':
        case 'position':
        case 'question':
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
          } else if (action.kind === 'question') {
            if (!sameState(value.question?.state ?? null, action.previous)) throw new Error('Question changed. Rejected command kept.');
            operations.push({ op: 'set_question', id: action.id, base_revision: block.revision, question: action.value });
            changed = !sameState(value.question?.state ?? null, action.value);
            value.question = action.value ? { state: action.value, status: questionStatus(action.value, false) } : null;
          } else if (action.kind === 'assessment') {
            if (!sameState(value.assessment?.state ?? null, action.previous)) throw new Error('Answer changed. Rejected command kept.');
            operations.push({ op: 'set_assessment', id: action.id, base_revision: block.revision, assessment: action.value });
            changed = !sameState(value.assessment?.state ?? null, action.value);
            value.assessment = action.value ? { state: action.value, question_id: null, accepted: false } : null;
          } else if (action.kind === 'source') {
            if (!sameState(sourceState(value.source), action.previous)) throw new Error('Source metadata changed. Rejected command kept.');
            operations.push({ op: 'set_source', id: action.id, base_revision: block.revision, source: action.value });
            changed = !sameState(sourceState(value.source), action.value);
            value.source = action.value ? { block_id: action.id, added_at: 0, state_changed_at: 0, last_read_at: null, current_snapshot_id: null, siglum: '?', siglum_basis: '?', siglum_authored: false, ...value.source, ...action.value } : null;
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
        case 'addType':
        case 'removeType': {
          const block = current(action.id);
          operations.push({ op: action.kind === 'addType' ? 'add_type' : 'remove_type', id: block.id, base_revision: block.revision, title: action.title });
          block.revision++;
          break;
        }
        case 'move': {
          const block = current(action.id);
          const after = action.after && current(action.after).parent_id === action.parentId ? action.after : null;
          operations.push({ op: 'move', id: block.id, base_revision: block.revision, parent_id: action.parentId, after });
          block.revision++;
          block.parent_id = action.parentId;
          break;
        }
        case 'delete': {
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
            working.set(snapshot.block.id, { ...snapshot.block, revision: (saved?.revision ?? this.tickets.get(snapshot.block.id)?.revision ?? snapshot.block.revision) + 1 });
            initialRevisions.set(snapshot.block.id, saved?.revision ?? snapshot.block.revision);
            capabilities.set(snapshot.block.id, snapshot.capabilities ?? emptyCapabilities(snapshot.block.id));
          }
          break;
        }
      }
    }
    return { batch: { actor: { kind: 'client', name: this.actorName }, idempotency_key: command.id, operations }, deleted };
  }
  private async reject(command: Command, doc: Document | undefined, message: string) {
    const texts = new Map<string, string>();
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
      await this.persist(command);
      if (!this.persisted.has(command.id)) return false;
      this.activeCommand = command.id; this.touch();
      const ack = await this.api.submitFrozen(command.frozen!);
      acknowledged = true;
      if (this.closed) return false;
      ack.capabilities = this.acceptCapabilities(ack.capabilities ?? [], ack.seq);
      if (ack.seq < this.workSequence) ack.work_sessions = [];
      this.serviceReached();
      const merges = command.operations.filter(operation => operation.op === 'merge_page');
      const blocks = await Promise.all(ack.revisions.map(async value => {
        try { return await this.api.block(value.id); }
        catch (error) {
          if (!merges.length) return undefined;
          if (error instanceof ApiError && error.status === 404) { this.publish(null, value.id); return undefined; }
          throw error;
        }
      }));
      for (const block of blocks) if (block) {
        this.publish(block);
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
      await this.outbox?.capabilities(ack.capabilities ?? [], ack.seq);
      await this.outbox?.acknowledge(command, blocks.filter((block): block is Block => Boolean(block)), ack.seq, new Map(ack.revisions.map(value => [value.id, value.revision])), undefined,
        merges.length ? ack.revisions.filter((_, index) => !blocks[index]).map(value => value.id) : undefined);
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
    for (const doc of this.docs.values()) doc.receiveCapabilities(ack.capabilities ?? []);
    for (const session of ack.work_sessions ?? []) {
      if (!session.reversed && session.ended_at === null) this.activeWork = session;
      else if (this.activeWork?.id === session.id) this.activeWork = undefined;
    }
    if (ack.work_sessions?.length) this.workSequence = Math.max(this.workSequence, ack.seq);
    this.observedChange[1]({ seq: ack.seq, actor: { kind: 'client', name: this.actorName }, reason: null, created_at: Date.now(), blocks: [], removed: [], restructured_pages: [],
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
          }
          // Even an uncertain retry passes through persistence before it can hit the network.
          await this.persist(command);
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
          let extraRoots = false;
          for (const id of revisions.keys()) {
            const saved = doc.baseBlocks.get(id);
            const block = saved ? { ...saved } : await this.api.block(id).catch(() => undefined);
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
          await this.outbox?.acknowledge(command, blocks, ack.seq, revisions, fullPage && doc.root() ? doc.view() : undefined, command.actions.some(action => action.kind === 'delete' && action.id === doc.pageId) ? [doc.pageId] : undefined).catch(() => undefined);
          this.failure = '';
          this.activeCommand = undefined;
          this.touch();
          if (extraRoots || command.actions.some(action => action.kind === 'insert' && action.block.kind !== 'block' || action.kind === 'delete' && action.id === doc.pageId || action.kind === 'restore' && action.id === doc.pageId || action.kind === 'text' && action.id === doc.pageId)) await this.refreshRoots().catch(() => this.connectionSignal[1]('offline'));
          if (command.actions.some(action => action.kind === 'text' && action.id === doc.pageId)) {
            const pages = new Set(blocks.filter(block => block.id !== doc.pageId).map(block => block.page_id));
            for (const page of pages) await this.docs.get(page)?.reload(false);
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
    if (rejected.length) return `Couldn’t apply a change · Rejected data kept. ${rejected.map(command => command.rejection?.message).join(' ')}\n${rejected.map(command => command.rejection?.text || JSON.stringify(command.rejection?.operations ?? command.rejection?.actions)).filter(Boolean).join('\n\n')}`;
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (state === 'error') return `Couldn’t save · Local changes kept. ${this.failure || this.queue.find(command => command.failed)?.failed || ''}`;
    if (state === 'offline') { const n = this.queuedChanges(); return n ? `Offline · ${n} changes queued locally` : 'Offline · All changes saved'; }
    return state === 'saved' ? 'Saved' : 'Saving…';
  }
  saveMessage() { return this.message(); }
  queuedChanges() { this.revision[0](); return this.queue.filter(command => this.persisted.has(command.id)).reduce((count, command) => count + (command.kind === 'notebook' ? command.operations.length : command.actions.length), 0); }
  unsavedText() {
    const operations = this.queue.flatMap(command => command.kind === 'notebook' ? [command.frozen ?? JSON.stringify(command.operations)] : command.actions.some(isCapabilityAction) ? [command.frozen ?? JSON.stringify(command.actions)] : []);
    return [...this.docs.values()].map(doc => doc.localText()).concat(operations, this.rejectedText()).filter(Boolean).join('\n\n');
  }
  rejectedText() { this.revision[0](); return [...this.rejected.values()].map(command => [command.rejection?.text, JSON.stringify(command.rejection?.operations ?? command.rejection?.actions)].filter(Boolean).join('\n')).filter(Boolean).join('\n\n'); }
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
    return !this.roots().some(root => root.kind === 'page' && root.id !== exceptId && root.text.toLowerCase() === title.toLowerCase());
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
      while (!this.closed) {
        const events = await this.api.changes(this.seq);
        const work = this.streamWork.then(() => this.catchUp(events));
        this.streamWork = work.catch(() => undefined);
        await work;
        if (events.length < 500) break;
      }
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
        this.streamWork = this.streamWork.then(async () => { await this.change(JSON.parse(String(message.data)) as ChangeEvent); }).catch(error => {
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
  private async reconcile(blocks: readonly Block[], removed: readonly string[], pages: readonly string[], capabilities: readonly BlockCapabilities[] = []) {
    const structured = new Set(pages);
    for (const block of blocks) {
      this.publish(block);
      if (!structured.has(block.page_id)) this.docs.get(block.page_id)?.receive(block);
    }
    for (const id of removed) this.publish(null, id);
    for (const id of structured) {
      const doc = this.docs.get(id);
      if (doc?.needsRefresh(blocks, removed)) await doc.reload(true);
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
    await this.reconcile([...blocks.values()], [...removed], [...pages], [...capabilities.values()]);
    const latest = events.at(-1)!;
    await this.outbox?.capabilities([...capabilities.values()], latest.seq);
    const changed = events.filter(event => event.seq > this.seq);
    this.observedChange[1]({ ...latest, capabilities: [...capabilities.values()],
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
      await this.reconcile(event.blocks, event.removed, event.restructured_pages, capabilities);
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
  async today() {
    await this.ready;
    try { await this.refreshSettings(); } catch { this.connectionSignal[1]('offline'); }
    return this.journal(this.todayDate());
  }
  private async writeSetting(key: 'time_zone' | 'vim', value: string, baseRevision: number | null) {
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
  async setSetting(key: 'time_zone' | 'vim', value: string) {
    return this.settingAction(async () => {
      if (!this.settings()) await this.refreshSettings();
      const settings = this.settings()!;
      const current = settings.settings.find(setting => setting.key === key);
      const before = current?.value ?? (key === 'vim' ? 'false' : settings.time_zone);
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
  async journal(date: string) {
    await this.ready;
    const cached = this.roots().find(root => root.kind === 'journal' && root.text === date);
    if (cached) return cached.id;
    try { return (await this.api.journal(date)).id; }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 404 && !error.uncertain) throw error; }
    try { return await this.createRoot('journal', date); }
    catch (error) { try { return (await this.api.journal(date)).id; } catch { throw error; } }
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
    const root: Block = { id, kind, parent_id: null, page_id: id, text, heading: null, archived: false, revision: 0, created_at: Date.now(), updated_at: Date.now() };
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
  async deletePage(pageId: string) {
    await this.ready;
    const doc = this.open(pageId) as Document;
    try {
      if (doc.status() !== 'ready') await doc.reload();
      const action: Action = { kind: 'delete', id: pageId };
      const inverse = doc.apply(action);
      this.deletedPages.set(pageId, inverse[0]!);
      this.enqueue(doc, [action], inverse, null, null, false);
      await this.flush();
    } finally { doc.release(); }
  }
  async restorePage(pageId: string) {
    const action = this.deletedPages.get(pageId);
    if (!action) throw new Error('There is no page deletion to undo in this window.');
    const doc = this.docs.get(pageId)!;
    const inverse = doc.apply(action);
    this.enqueue(doc, [action], inverse, null, null, false);
    await this.flush();
    this.deletedPages.delete(pageId);
  }
  /** Test/embedding drain point; it never claims failed or offline requests committed. */
  async flush() {
    await this.ready;
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

export function createNotebookClient(options?: NotebookOptions): Notebook { return new Notebook(options); }
