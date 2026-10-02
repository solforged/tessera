import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { PageView, Block } from '../api/types';
import type { Action, Command, Ticket } from './types';
import { OutlineIndex } from './outline-index';

interface NotebookRecord { key: string; roots: Block[] }
interface PagePatch { sequence: number; actions: Action[]; revisions: Map<string, number> }
interface PageRecord { key: string; view?: PageView; patch?: PagePatch }
interface CommandRecord { key: string; command: Command }
interface TicketRecord { key: string; ticket: Ticket }
interface BlockRecord { key: string; block: Block }
interface OutboxSchema extends DBSchema {
  notebooks: { key: string; value: NotebookRecord };
  pages: { key: string; value: PageRecord };
  commands: { key: string; value: CommandRecord };
  tickets: { key: string; value: TicketRecord };
  blocks: { key: string; value: BlockRecord };
}

/** Writes are serialized off the input path; a frozen request waits for its write. */
export class Outbox {
  private db: Promise<IDBPDatabase<OutboxSchema>>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private notebookId: string, private sessionId: string, private failed: (error: unknown) => void, database = 'tessera-outbox-v1') {
    this.db = Promise.resolve().then(() => openDB<OutboxSchema>(database, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('notebooks', { keyPath: 'key' });
          db.createObjectStore('pages', { keyPath: 'key' });
          db.createObjectStore('commands', { keyPath: 'key' });
          db.createObjectStore('tickets', { keyPath: 'key' });
        }
        if (oldVersion < 2) db.createObjectStore('blocks', { keyPath: 'key' });
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
    return this.enqueue(db => db.put('commands', { key: `${this.notebookId}:${this.sessionId}:${command.id}`, command: value }));
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
  remove(id: string) { return this.enqueue(db => db.delete('commands', `${this.notebookId}:${this.sessionId}:${id}`)); }
  private pagePrefix(id: string) { return `${this.notebookId}:${id}:`; }
  private patchRange(id: string, sequence?: number) {
    const prefix = this.pagePrefix(id);
    return IDBKeyRange.bound(prefix, sequence === undefined ? `${prefix}\uffff` : `${prefix}${String(sequence).padStart(16, '0')}\uffff`);
  }
  page(view: PageView, sequence = 0) {
    return this.enqueue(async db => {
      const tx = db.transaction('pages', 'readwrite');
      void tx.store.put({ key: `${this.notebookId}:${view.root.id}`, view });
      for (const key of await tx.store.getAllKeys(this.patchRange(view.root.id, sequence))) void tx.store.delete(key);
      await tx.done;
    });
  }
  roots(roots: Block[]) { return this.enqueue(db => db.put('notebooks', { key: this.notebookId, roots })); }
  ticket(id: string, ticket: Ticket) { return this.enqueue(db => db.put('tickets', { key: `${this.notebookId}:${id}`, ticket })); }
  acknowledge(command: Command, blocks: Block[], sequence: number, revisions: Map<string, number>, view?: PageView, deletedPage?: string) {
    const actions = command.actions.filter(action => action.kind === 'insert' || action.kind === 'delete' || action.kind === 'restore' || action.kind === 'move');
    return this.enqueue(async db => {
      const tx = db.transaction(['commands', 'blocks', 'pages'], 'readwrite');
      const pages = tx.objectStore('pages');
      for (const block of blocks) void tx.objectStore('blocks').put({ key: `${this.notebookId}:${block.id}`, block });
      if (view) {
        void pages.put({ key: `${this.notebookId}:${view.root.id}`, view });
        for (const key of await pages.getAllKeys(this.patchRange(view.root.id, sequence))) void pages.delete(key);
      } else if (actions.length && !deletedPage) {
        void pages.put({ key: `${this.pagePrefix(command.pageId)}${String(sequence).padStart(16, '0')}:${command.id}`, patch: { sequence, actions, revisions } });
      }
      if (deletedPage) {
        void pages.delete(`${this.notebookId}:${deletedPage}`);
        for (const key of await pages.getAllKeys(this.patchRange(deletedPage))) void pages.delete(key);
      }
      void tx.objectStore('commands').delete(`${this.notebookId}:${this.sessionId}:${command.id}`);
      await tx.done;
    });
  }
  async load() {
    try {
      const db = await this.db;
      const prefix = `${this.notebookId}:${this.sessionId}:`;
      const commands = (await db.getAll('commands')).filter(row => row.key.startsWith(prefix)).map(row => row.command).sort((a, b) => a.order - b.order);
      const tickets = (await db.getAll('tickets')).filter(row => row.key.startsWith(`${this.notebookId}:`));
      const roots = (await db.get('notebooks', this.notebookId))?.roots ?? [];
      return { commands, roots, tickets };
    } catch (error) { this.failed(error); return { commands: [], roots: [], tickets: [] }; }
  }
  async cachedPage(id: string) {
    try {
      const db = await this.db;
      const view = (await db.get('pages', `${this.notebookId}:${id}`))?.view;
      if (!view) return undefined;
      const blocks = new Map([view.root, ...view.rows.map(row => row.block)].map(block => [block.id, block]));
      const manualTypes = new Map(view.rows.map(row => [row.block.id, row.manual_types]));
      const snapshotRevisions = new Map<string, number>();
      for (const block of blocks.values()) snapshotRevisions.set(block.id, block.revision);
      const index = new OutlineIndex(id);
      index.replace(view.rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id!, depth: row.depth })));
      const changes = await db.getAll('pages', this.patchRange(id));
      for (const change of changes) for (const action of change.patch?.actions ?? []) {
        const blockId = action.kind === 'insert' ? action.block.id : action.id;
        const revision = change.patch!.revisions.get(blockId) ?? 0;
        if ((snapshotRevisions.get(blockId) ?? -1) >= revision) continue;
        switch (action.kind) {
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
            const key = action.title.toLowerCase();
            manualTypes.set(blockId, action.kind === 'addType'
              ? previous.some(title => title.toLowerCase() === key) ? previous : [...previous, action.title]
              : previous.filter(title => title.toLowerCase() !== key));
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
      const latest = (block: Block) => { const patch = patches.get(block.id); return patch && patch.revision > block.revision ? patch : block; };
      view.root = latest(blocks.get(id)!);
      view.rows = index.slice(0, index.size()).map(row => ({ block: latest(blocks.get(row.id)!), depth: row.depth, manual_types: manualTypes.get(row.id) ?? [] }));
      return view;
    }
    catch (error) { this.failed(error); return undefined; }
  }
  async settled() { await this.writes; }
  async close() { await this.settled(); try { (await this.db).close(); } catch { /* Already reported by failed. */ } }
}
