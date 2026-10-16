import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { PageView, Block, BlockCapabilities } from '../api/types';
import type { Action, Command, NotebookCommand, Ticket } from './types';
import { OutlineIndex } from './outline-index';
import { titleKey } from './title-key';

interface NotebookRecord { key: string; roots: Block[] }
interface PagePatch { sequence: number; actions: Action[]; revisions: Map<string, number> }
interface PageRecord { key: string; view?: PageView; patch?: PagePatch; cursor?: number }
interface CommandRecord { key: string; command: Command }
interface TicketRecord { key: string; ticket: Ticket }
interface BlockRecord { key: string; block: Block }
interface CapabilityRecord { key: string; value: BlockCapabilities; sequence: number }
interface OutboxSchema extends DBSchema {
  notebooks: { key: string; value: NotebookRecord };
  pages: { key: string; value: PageRecord };
  commands: { key: string; value: CommandRecord };
  tickets: { key: string; value: TicketRecord };
  blocks: { key: string; value: BlockRecord };
  capabilities: { key: string; value: CapabilityRecord };
}

/** Writes are serialized off the input path; a frozen request waits for its write. */
export class Outbox {
  private db: Promise<IDBPDatabase<OutboxSchema>>;
  private writes: Promise<void> = Promise.resolve();
  private lockReady?: Promise<void>;
  private lockTask?: Promise<void>;
  private releaseLock?: () => void;
  constructor(private notebookId: string, private sessionId: string, private failed: (error: unknown) => void, private database = 'tessera-outbox-v1', private intake: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage, private locks: Pick<LockManager, 'request'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks) {
    this.db = Promise.resolve().then(() => openDB<OutboxSchema>(database, 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('notebooks', { keyPath: 'key' });
          db.createObjectStore('pages', { keyPath: 'key' });
          db.createObjectStore('commands', { keyPath: 'key' });
          db.createObjectStore('tickets', { keyPath: 'key' });
        }
        if (oldVersion < 2) db.createObjectStore('blocks', { keyPath: 'key' });
        if (oldVersion < 3) db.createObjectStore('capabilities', { keyPath: 'key' });
      },
      blocking: () => { void this.db.then(db => db.close()); },
    }));
    void this.db.catch(failed);
  }
  private enqueue(run: (db: IDBPDatabase<OutboxSchema>) => Promise<unknown>) {
    const write = this.writes.then(() => this.db).then(run).then(() => undefined);
    this.writes = write.catch(this.failed);
    return write;
  }
  put(command: Command) {
    // Snapshot now, before a later keystroke can mutate the queued command.
    const value = structuredClone(command);
    return this.enqueue(async db => {
      await db.put('commands', { key: this.commandKey(value), command: value });
      if (value.kind === 'notebook' && value.capture) this.intake?.removeItem(`tessera-outbox:${this.notebookId}:capture:${value.id}`);
    });
  }
  /** A tiny synchronous intake lets a submitted line clear without waiting for an IndexedDB transaction. */
  accept(command: NotebookCommand): Promise<void> {
    if (!this.intake) return this.put(command);
    this.intake.setItem(`tessera-outbox:${this.notebookId}:capture:${command.id}`, JSON.stringify(command));
    return Promise.resolve();
  }
  private commandKey(command: Command) {
    return `${this.notebookId}:${command.kind === 'notebook' && command.capture ? 'capture' : this.sessionId}:${command.id}`;
  }
  /** Two windows must use the first frozen capture request, including its generated block IDs. */
  freezeCapture(command: NotebookCommand): Promise<NotebookCommand | undefined> {
    const value = structuredClone(command);
    let chosen: NotebookCommand | undefined = value;
    return this.enqueue(async db => {
      const tx = db.transaction('commands', 'readwrite');
      const key = this.commandKey(value);
      const stored = await tx.store.get(key);
      if (stored?.command.kind === 'notebook' && stored.command.frozen) chosen = stored.command;
      else if (!stored && !this.intake?.getItem(`tessera-outbox:${this.notebookId}:capture:${value.id}`)) chosen = undefined;
      else await tx.store.put({ key, command: value });
      await tx.done;
      this.intake?.removeItem(`tessera-outbox:${this.notebookId}:capture:${value.id}`);
    }).then(() => chosen);
  }
  create(command: Command, view: PageView, roots: readonly Block[]) {
    const value = structuredClone(command);
    return this.enqueue(async db => {
      const tx = db.transaction(['commands', 'pages', 'notebooks'], 'readwrite');
      void tx.objectStore('commands').put({ key: `${this.notebookId}:${this.sessionId}:${value.id}`, command: value });
      void tx.objectStore('pages').put({ key: `${this.notebookId}:${view.root.id}`, view });
      void tx.objectStore('notebooks').put({ key: this.notebookId, roots: [...roots] });
      await tx.done;
    });
  }
  remove(id: string) {
    return this.enqueue(async db => {
      const tx = db.transaction('commands', 'readwrite');
      void tx.store.delete(`${this.notebookId}:${this.sessionId}:${id}`);
      void tx.store.delete(`${this.notebookId}:capture:${id}`);
      await tx.done;
      this.intake?.removeItem(`tessera-outbox:${this.notebookId}:capture:${id}`);
    });
  }
  private pagePrefix(id: string) { return `${this.notebookId}:${id}:`; }
  private patchRange(id: string, sequence?: number) {
    const prefix = this.pagePrefix(id);
    return IDBKeyRange.bound(prefix, sequence === undefined ? `${prefix}\uffff` : `${prefix}${String(sequence).padStart(16, '0')}\uffff`);
  }
  page(view: PageView, sequence = 0, cursor?: number) {
    return this.enqueue(async db => {
      const tx = db.transaction('pages', 'readwrite');
      void tx.store.put({ key: `${this.notebookId}:${view.root.id}`, view, cursor });
      for (const key of await tx.store.getAllKeys(this.patchRange(view.root.id, sequence))) void tx.store.delete(key);
      await tx.done;
    });
  }
  roots(roots: Block[]) { return this.enqueue(db => db.put('notebooks', { key: this.notebookId, roots })); }
  capabilities(values: readonly BlockCapabilities[], sequence: number) {
    if (!values.length) return Promise.resolve();
    const copies = structuredClone(values);
    return this.enqueue(async db => {
      const tx = db.transaction('capabilities', 'readwrite');
      for (const value of copies) {
        const key = `${this.notebookId}:${value.block_id}`;
        const old = await tx.store.get(key);
        if (!old || old.sequence <= sequence) void tx.store.put({ key, value, sequence });
      }
      await tx.done;
    });
  }
  ticket(id: string, ticket: Ticket) { return this.enqueue(db => db.put('tickets', { key: `${this.notebookId}:${id}`, ticket })); }
  async getTicket(id: string): Promise<Ticket | undefined> {
    await this.writes;
    return (await (await this.db).get('tickets', `${this.notebookId}:${id}`))?.ticket;
  }
  acknowledge(command: Command, blocks: Block[], sequence: number, revisions: Map<string, number>, view?: PageView, deletedIds?: readonly string[]) {
    const actions = command.actions.filter(action => ['insert', 'delete', 'restore', 'move', 'split', 'merge', 'addType', 'removeType'].includes(action.kind));
    return this.enqueue(async db => {
      const tx = db.transaction(['commands', 'blocks', 'pages'], 'readwrite');
      const pages = tx.objectStore('pages');
      for (const block of blocks) void tx.objectStore('blocks').put({ key: `${this.notebookId}:${block.id}`, block });
      if (view) {
        const key = `${this.notebookId}:${view.root.id}`;
        // A receipt may skip other writers' events. Keep the snapshot's older replay floor.
        const cursor = (await pages.get(key))?.cursor;
        void pages.put({ key, view, cursor });
        for (const key of await pages.getAllKeys(this.patchRange(view.root.id, sequence))) void pages.delete(key);
      } else if (actions.length && command.pageId && !deletedIds?.includes(command.pageId)) {
        void pages.put({ key: `${this.pagePrefix(command.pageId)}${String(sequence).padStart(16, '0')}:${command.id}`, patch: { sequence, actions, revisions } });
      }
      for (const id of deletedIds ?? []) {
        void tx.objectStore('blocks').delete(`${this.notebookId}:${id}`);
        void pages.delete(`${this.notebookId}:${id}`);
        for (const key of await pages.getAllKeys(this.patchRange(id))) void pages.delete(key);
      }
      void tx.objectStore('commands').delete(this.commandKey(command));
      await tx.done;
    });
  }
  private lockName(sessionId: string) { return `tessera-outbox:${this.database}:${this.notebookId}:${sessionId}`; }
  /** A suspended but still-open window keeps its ownership; only a closed owner can be adopted. */
  private ownSession() {
    if (!this.locks) return Promise.resolve();
    return this.lockReady ??= new Promise<void>((resolve, reject) => {
      const released = new Promise<void>(done => { this.releaseLock = done; });
      this.lockTask = this.locks!.request(this.lockName(this.sessionId), async () => {
        resolve();
        await released;
      });
      void this.lockTask.catch(reject);
    });
  }
  private async recoverClosedWindows(db: IDBPDatabase<OutboxSchema>) {
    if (!this.locks) return;
    const prefix = `${this.notebookId}:`;
    const owners = new Set((await db.getAllKeys('commands')).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length, key.lastIndexOf(':'))));
    for (const owner of owners) {
      if (owner === this.sessionId || owner === 'capture') continue;
      await this.locks.request(this.lockName(owner), { ifAvailable: true }, async lock => {
        if (!lock) return;
        // Re-read under one transaction: another recovering window may have moved
        // these commands since the owner list was read. Preserve frozen requests.
        const tx = db.transaction('commands', 'readwrite');
        const from = `${prefix}${owner}:`;
        for (const row of await tx.store.getAll(IDBKeyRange.bound(from, `${from}\uffff`))) {
          void tx.store.put({ key: this.commandKey(row.command), command: row.command });
          void tx.store.delete(row.key);
        }
        await tx.done;
      });
    }
  }
  async load() {
    try {
      const db = await this.db;
      await this.ownSession();
      await this.recoverClosedWindows(db);
      const prefix = `${this.notebookId}:${this.sessionId}:`;
      const commands = new Map((await db.getAll('commands')).filter(row => row.key.startsWith(prefix) || row.key.startsWith(`${this.notebookId}:capture:`)).map(row => [row.command.id, row.command]));
      const intakePrefix = `tessera-outbox:${this.notebookId}:capture:`;
      if (this.intake) for (let index = 0; index < this.intake.length; index++) {
        const key = this.intake.key(index);
        if (!key?.startsWith(intakePrefix)) continue;
        const command: NotebookCommand = JSON.parse(this.intake.getItem(key)!);
        if (!commands.has(command.id)) commands.set(command.id, command);
      }
      const tickets = (await db.getAll('tickets')).filter(row => row.key.startsWith(`${this.notebookId}:`));
      const roots = (await db.get('notebooks', this.notebookId))?.roots ?? [];
      return { commands: [...commands.values()].sort((a, b) => a.order - b.order), roots, tickets };
    } catch (error) { this.failed(error); return { commands: [], roots: [], tickets: [] }; }
  }
  async cachedPage(id: string) {
    try {
      const db = await this.db;
      const record = await db.get('pages', `${this.notebookId}:${id}`);
      const view = record?.view;
      if (!view) return undefined;
      const blocks = new Map([view.root, ...view.rows.map(row => row.block)].map(block => [block.id, block]));
      const manualTypes = new Map(view.rows.map(row => [row.block.id, row.manual_types]));
      manualTypes.set(view.root.id, view.root_manual_types ?? []);
      const capabilities = new Map((view.capabilities ?? []).map(value => [value.block_id, value]));
      const snapshotRevisions = new Map<string, number>();
      for (const block of blocks.values()) snapshotRevisions.set(block.id, block.revision);
      const index = new OutlineIndex(id);
      index.replace(view.rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id!, depth: row.depth })));
      const changes = await db.getAll('pages', this.patchRange(id));
      for (const change of changes) for (const action of change.patch?.actions ?? []) {
        const blockId = action.kind === 'insert' ? action.block.id : action.id;
        const revision = change.patch!.revisions.get(blockId) ?? blocks.get(blockId)?.revision ?? 0;
        if (action.kind === 'split' ? index.indexOf(action.block.id) >= 0 : (snapshotRevisions.get(blockId) ?? -1) >= revision) continue;
        switch (action.kind) {
          case 'settleSyncCopy':
            blocks.set(blockId, { ...blocks.get(blockId)!, kept_copy: action.settled ? null : action.copy, revision });
            break;
          case 'split': {
            const original = blocks.get(action.id)!;
            blocks.set(action.id, { ...original, text: action.left, revision });
            blocks.set(action.block.id, { ...action.block, revision: change.patch!.revisions.get(action.block.id) ?? 1 });
            if (index.indexOf(action.block.id) < 0) index.splice(index.subtreeEnd(index.indexOf(action.id)), 0, [{ id: action.block.id, parentId: original.parent_id!, depth: index.depth(action.id) }]);
            break;
          }
          case 'merge': {
            const source = blocks.get(action.id);
            const destination = blocks.get(action.destinationId);
            if (!source || !destination) break;
            blocks.set(destination.id, { ...destination, text: destination.text + source.text, revision: change.patch!.revisions.get(destination.id) ?? destination.revision });
            let after = index.children(destination.id).at(-1) ?? null;
            for (const child of [...index.children(source.id)]) { index.move(child, destination.id, after); after = child; }
            const at = index.indexOf(source.id);
            if (at >= 0) index.splice(at, 1, []);
            blocks.delete(source.id);
            break;
          }
          case 'insert': {
            if (action.block.parent_id && index.indexOf(blockId) < 0) {
              const parentId = action.block.parent_id;
              const at = action.after && index.indexOf(action.after) >= 0 ? index.subtreeEnd(index.indexOf(action.after)) : parentId === id ? 0 : index.indexOf(parentId) + 1;
              index.splice(at, 0, [{ id: blockId, parentId, depth: parentId === id ? 0 : index.depth(parentId) + 1 }]);
            }
            blocks.set(blockId, { ...action.block, revision });
            break;
          }
          case 'addType':
          case 'removeType': {
            const previous = manualTypes.get(blockId) ?? [];
            const key = titleKey(action.title);
            manualTypes.set(blockId, action.kind === 'addType'
              ? previous.some(title => titleKey(title) === key) ? previous : [...previous, action.title]
              : previous.filter(title => titleKey(title) !== key));
            break;
          }
          case 'move':
            if (index.indexOf(blockId) >= 0) {
              index.move(blockId, action.parentId, action.after && index.indexOf(action.after) >= 0 ? action.after : null);
              blocks.set(blockId, { ...blocks.get(blockId)!, parent_id: action.parentId, revision });
            }
            break;
          case 'delete': {
            if (blockId === id) return undefined;
            const at = index.indexOf(blockId);
            if (at >= 0) {
              const end = index.subtreeEnd(at);
              for (const row of index.slice(at, end)) blocks.delete(row.id);
              index.splice(at, end - at, []);
            }
            break;
          }
          case 'restore': {
            const rows = action.snapshots.flatMap(snapshot => snapshot.row && index.indexOf(snapshot.block.id) < 0 ? [{ ...snapshot.row }] : []);
            for (const snapshot of action.snapshots) {
              blocks.set(snapshot.block.id, { ...snapshot.block, revision: change.patch!.revisions.get(snapshot.block.id) ?? snapshot.block.revision });
              manualTypes.set(snapshot.block.id, snapshot.manual_types);
              if (snapshot.capabilities) capabilities.set(snapshot.block.id, snapshot.capabilities);
            }
            if (rows.length) {
              const parentId = rows[0]!.parentId;
              const at = action.after && index.indexOf(action.after) >= 0 ? index.subtreeEnd(index.indexOf(action.after)) : parentId === id ? 0 : index.indexOf(parentId) + 1;
              const depth = parentId === id ? 0 : index.depth(parentId) + 1;
              const delta = depth - rows[0]!.depth;
              index.splice(at, 0, rows.map(row => ({ ...row, depth: row.depth + delta })));
            }
            break;
          }
        }
      }
      const patches = new Map((await db.getAll('blocks')).filter(row => row.key.startsWith(`${this.notebookId}:`) && row.block.page_id === id).map(row => [row.block.id, row.block]));
      const latest = (block: Block) => { const patch = patches.get(block.id); return patch && patch.revision >= block.revision ? patch : block; };
      view.root = latest(blocks.get(id)!);
      view.root_manual_types = manualTypes.get(id) ?? [];
      view.rows = index.slice(0, index.size()).map(row => ({ block: latest(blocks.get(row.id)!), depth: row.depth, manual_types: manualTypes.get(row.id) ?? [] }));
      for (const row of await db.getAll('capabilities')) if (row.key.startsWith(`${this.notebookId}:`) && blocks.has(row.value.block_id)) capabilities.set(row.value.block_id, row.value);
      view.capabilities = [...capabilities.values()].filter(value => blocks.has(value.block_id));
      return { view, cursor: record?.cursor };
    }
    catch (error) { this.failed(error); return undefined; }
  }
  /** A reset invalidates sequence-ordered patches, but never pending commands or recovery snapshots. */
  resetJournal() {
    return this.enqueue(async db => {
      const tx = db.transaction(['pages', 'blocks', 'capabilities'], 'readwrite');
      const range = IDBKeyRange.bound(`${this.notebookId}:`, `${this.notebookId}:\uffff`);
      for (const row of await tx.objectStore('pages').getAll(range)) {
        if (row.view) void tx.objectStore('pages').put({ key: row.key, view: row.view });
        else void tx.objectStore('pages').delete(row.key);
      }
      for (const store of ['blocks', 'capabilities'] as const) {
        for (const key of await tx.objectStore(store).getAllKeys(range)) void tx.objectStore(store).delete(key);
      }
      await tx.done;
    });
  }
  async settled() { await this.writes; }
  /**
   * The newest acknowledged change cached for a page, after pending writes land. The notebook committed it before
   * anything read now, so a snapshot fetched afterwards already includes it, even before this window has heard of it.
   */
  async storedSequence(id: string) {
    await this.settled();
    try {
      const prefix = this.pagePrefix(id);
      const newest = (await (await this.db).getAllKeys('pages', this.patchRange(id))).at(-1);
      return newest ? Number(newest.slice(prefix.length, prefix.length + 16)) : 0;
    } catch { return 0; }
  }
  async close() {
    await this.settled();
    try { (await this.db).close(); } catch { /* Already reported by failed. */ }
    this.releaseLock?.();
    await this.lockTask;
  }
}
