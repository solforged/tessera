import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { ApiError, createApi } from '../api/client';
import type { Block, ChangeEvent, Operation, PageView } from '../api/types';
import type { ApiClient } from '../api/client';
import type { Caret, NotebookClient, PageDocument, SaveState } from './contract';
import { Document } from './page-document';
import type { DocumentHost } from './page-document';
import { Outbox } from './outbox';
import type { Action, Command, Compiled, Ticket } from './types';
export type { NotebookClient, PageDocument, BlockState, Caret, Edit, EditResult, SaveState } from './contract';

export interface NotebookOptions {
  baseUrl?: string;
  /** A test or embedding may supply its own persistent window identity. */
  sessionId?: string;
  notebookId?: string;
  databaseName?: string;
  coalesceMs?: number;
}

/** One single-flight operation queue for every document in this window. */
export class Notebook implements NotebookClient, DocumentHost {
  readonly ready: Promise<void>;
  readonly api: ApiClient;
  readonly roots: Accessor<readonly Block[]>;
  private setRoots;
  private docs = new Map<string, Document>();
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
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private seq = 0;
  private reconnectDelay = 500;
  private streamWork = Promise.resolve();
  private firstQueuedAt = 0;
  private order = Date.now() * 1000;
  private sessionId: string;
  private actorName: string;
  private persisted = new Set<string>();
  private generations = new Map<string, number>();
  connection = this.connectionSignal[0];
  localPersistence = this.storageSignal[0];
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
    this.ready = this.initialize();
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
  private touch() { this.revision[1](value => value + 1); }
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
      for (const command of this.queue) if (!this.docs.has(command.pageId)) this.open(command.pageId).release();
      void this.connect();
      this.schedule(0);
    });
    this.touch();
  }
  open(pageId: string): PageDocument {
    let doc = this.docs.get(pageId);
    if (!doc) { doc = new Document(pageId, this); this.docs.set(pageId, doc); }
    doc.holds++;
    return doc;
  }
  release(doc: Document) {
    doc.holds = Math.max(0, doc.holds - 1);
    this.closeUnused(doc);
  }
  private closeUnused(doc: Document) {
    if (this.docs.get(doc.pageId) === doc && !doc.holds && !this.queue.some(command => command.pageId === doc.pageId) && !doc.hasConflict() && !this.deletedPages.has(doc.pageId)) {
      doc.close();
      this.docs.delete(doc.pageId);
    }
  }
  commands(pageId: string) { this.revision[0](); return this.queue.filter(command => command.pageId === pageId); }
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
  cachePage(view: PageView) {
    if (!this.cachedViews.has(view)) void this.outbox?.page(view, this.snapshotSequence.get(view) ?? 0).catch(() => undefined);
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
  enqueue(doc: Document, actions: Action[], inverse: Action[], before: Caret | null, after: Caret | null, coalesce: boolean) {
    const previous = this.queue.at(-1);
    let command: Command;
    if (coalesce && previous && !previous.frozen && previous.pageId === doc.pageId && actions.length === 1 && actions[0]!.kind === 'text' && previous.actions.length === 1 && previous.actions[0]!.kind === 'text' && previous.actions[0]!.id === actions[0]!.id) {
      previous.actions = actions;
      previous.after = after;
      previous.failed = undefined;
      this.persisted.delete(previous.id);
      command = previous;
    } else {
      command = { id: ulid(), order: ++this.order, pageId: doc.pageId, actions, inverse, before, after };
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
  private async persist(command: Command) {
    const generation = this.generations.get(command.id);
    try {
      if (!this.outbox) throw new Error('Recovery storage has not opened.');
      await this.outbox.put(command);
      if (this.queue.includes(command) && this.generations.get(command.id) === generation) this.persisted.add(command.id);
      this.touch();
    } catch { /* Outbox reports the precise storage failure and saving continues in memory. */ }
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, delay);
  }
  private compile(command: Command, doc: Document): Compiled {
    const operations: Operation[] = [];
    const working = new Map<string, Block>();
    const deleted: string[] = [];
    const current = (id: string) => {
      let block = working.get(id);
      if (!block) {
        const cached = this.cache.get(id)?.[0]();
        const saved = doc.baseBlocks.get(id) ?? (cached && this.docs.get(cached.page_id)?.baseBlocks.get(id)) ?? cached;
        if (!saved) throw new Error('The block no longer exists.');
        block = { ...saved };
        working.set(id, block);
      }
      return block;
    };
    for (const action of command.actions) {
      switch (action.kind) {
        case 'insert': {
          const block = { ...action.block, revision: 1 };
          if (block.kind === 'page') operations.push({ op: 'create_page', id: block.id, title: block.text });
          else if (block.kind === 'journal') operations.push({ op: 'create_journal', id: block.id, date: block.text });
          else operations.push({ op: 'insert', id: block.id, parent_id: block.parent_id!, after: action.after, text: block.text, heading: block.heading });
          working.set(block.id, block);
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
          }
          break;
        }
      }
    }
    return { batch: { actor: { kind: 'client', name: this.actorName }, idempotency_key: command.id, operations }, deleted };
  }
  private async reject(command: Command, doc: Document, message: string) {
    const texts = new Map<string, string>();
    for (const action of command.actions) {
      if (action.kind === 'text') texts.set(action.id, doc.block(action.id)?.text ?? action.text);
      if (action.kind === 'insert') texts.set(action.block.id, doc.block(action.block.id)?.text ?? action.block.text);
    }
    command.rejection = { text: [...texts.values()].filter(Boolean).join('\n'), message };
    command.frozen = undefined;
    if (command.rejection.text) {
      this.rejected.set(command.id, command);
      await this.outbox?.put(command).catch(() => undefined);
    } else {
      this.failure = message;
      await this.outbox?.remove(command.id).catch(() => undefined);
    }
    this.queue = this.queue.filter(item => item !== command);
    this.persisted.delete(command.id);
    this.generations.delete(command.id);
    doc.forgetRejected(command.id);
    await doc.reload(false);
    this.closeUnused(doc);
    this.touch();
  }
  private async drain() {
    await this.ready;
    if (this.sending || this.closed || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const command = this.queue[0]!;
        const doc = this.docs.get(command.pageId) ?? this.open(command.pageId) as Document;
        if (doc.status() === 'loading') { await doc.reload(false); }
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
          this.activeCommand = command.id;
          this.touch();
          const ack = await this.api.submitFrozen(command.frozen);
          if (this.closed) break;
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
          this.queue.shift();
          this.persisted.delete(command.id);
          this.generations.delete(command.id);
          doc.acknowledged(command, revisions, ack.text_rewrites);
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
          await this.outbox?.acknowledge(command, blocks, ack.seq, revisions, fullPage && doc.root() ? doc.view() : undefined, command.actions.some(action => action.kind === 'delete' && action.id === doc.pageId) ? doc.pageId : undefined).catch(() => undefined);
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
              command.frozen = undefined;
              if (command.actions.some(action => action.kind === 'insert' || action.kind === 'move' || action.kind === 'delete' || action.kind === 'restore')) {
                await this.reject(command, doc, this.failure);
                continue;
              } else await this.persist(command);
            } else await this.persist(command);
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
    if (rejected.length) return `Couldn’t apply a structural change · Rejected text kept. ${rejected.map(command => command.rejection?.message).join(' ')}\n${rejected.map(command => command.rejection?.text).filter(Boolean).join('\n\n')}`;
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (state === 'error') return `Couldn’t save · Local changes kept. ${this.failure || this.queue.find(command => command.failed)?.failed || ''}`;
    if (state === 'offline') { const n = this.queuedChanges(); return n ? `Offline · ${n} changes queued locally` : 'Offline · All changes saved'; }
    return state === 'saved' ? 'Saved' : 'Saving…';
  }
  saveMessage() { return this.message(); }
  queuedChanges() { this.revision[0](); return this.queue.filter(command => this.persisted.has(command.id)).reduce((count, command) => count + command.actions.length, 0); }
  unsavedText() { return [...this.docs.values()].map(doc => doc.localText()).concat(this.rejectedText()).filter(Boolean).join('\n\n'); }
  rejectedText() { this.revision[0](); return [...this.rejected.values()].map(command => command.rejection?.text ?? '').filter(Boolean).join('\n\n'); }
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
      const doc = this.docs.get(command.pageId);
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
    if (this.socket?.readyState === WebSocket.OPEN) {
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
      if (this.socket?.readyState === WebSocket.OPEN) { this.serviceReached(); return; }
      if (this.socket?.readyState === WebSocket.CONNECTING) return;
      const socket = new WebSocket(this.api.streamUrl(this.seq));
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
  private async reconcile(blocks: readonly Block[], removed: readonly string[], pages: readonly string[]) {
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
    if (blocks.some(block => block.kind !== 'block') || removed.some(id => this.roots().some(root => root.id === id))) await this.refreshRoots();
  }
  private async catchUp(events: readonly ChangeEvent[]) {
    if (!events.length) return;
    const blocks = new Map<string, Block>();
    const removed = new Set<string>();
    const pages = new Set<string>();
    for (const event of events) {
      if (event.seq <= this.seq || event.actor.kind === 'client' && event.actor.name === this.actorName) continue;
      for (const block of event.blocks) { blocks.set(block.id, block); removed.delete(block.id); }
      for (const id of event.removed) { removed.add(id); blocks.delete(id); }
      for (const id of event.restructured_pages) pages.add(id);
    }
    await this.reconcile([...blocks.values()], [...removed], [...pages]);
    const views = [...new Set(events.filter(event => event.seq > this.seq).flatMap(event => event.views ?? []))];
    this.observedChange[1]({ ...events.at(-1)!, views });
    this.seq = Math.max(this.seq, events.at(-1)!.seq);
    this.observedSequence[1](seq => Math.max(seq, this.seq));
    this.touch();
  }
  private async change(event: ChangeEvent) {
    if (event.seq <= this.seq) return;
    if (event.actor.kind !== 'client' || event.actor.name !== this.actorName) await this.reconcile(event.blocks, event.removed, event.restructured_pages);
    this.seq = event.seq;
    this.observedChange[1]({ ...event, views: event.views ?? [] });
    this.observedSequence[1](seq => Math.max(seq, event.seq));
    this.touch();
  }
  async today() {
    const date = new Date();
    return this.journal(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
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
  async deletePage(pageId: string) {
    await this.ready;
    const doc = this.open(pageId) as Document;
    if (doc.status() !== 'ready') await doc.reload();
    const action: Action = { kind: 'delete', id: pageId };
    const inverse = doc.apply(action);
    this.deletedPages.set(pageId, inverse[0]!);
    this.enqueue(doc, [action], inverse, null, null, false);
    doc.release();
    await this.flush();
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
