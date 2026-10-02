import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import type { EditResult, PageDocument } from './contract';
import type { Document } from './page-document';

const baseUrl = 'http://127.0.0.1:4330';
const api = createApi(baseUrl);
const clients: Notebook[] = [];
const actualFetch = globalThis.fetch;
let process: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebookId: string;
let serial = 0;
const eventually = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await Bun.sleep(10); }
};
// These are real-process/stream integration boundaries, not debounce timing tests.
const success = (result: EditResult) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
async function client(sessionId = `document-test-${++serial}`) {
  const instance = createNotebookClient({ baseUrl, sessionId, notebookId, databaseName: 'tessera-document-tests' });
  clients.push(instance);
  await instance.ready;
  return instance;
}
async function page(instance: Notebook, text = 'left right') {
  const id = await instance.createPage(`Document test ${++serial}`);
  const doc = instance.open(id);
  await eventually(() => doc.status() === 'ready', doc.statusMessage());
  const first = doc.outline.idAt(0);
  success(doc.edit({ kind: 'text', id: first, text }));
  await instance.flush();
  return { id, doc, first };
}
function ids(doc: PageDocument) { return Array.from({ length: doc.outline.size() }, (_, i) => doc.outline.idAt(i)); }

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-Document-tests-'));
  const root = resolve(import.meta.dir, '../../..');
  process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', '4330'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const deadline = Date.now() + 5000;
  const expectedPath = await realpath(directory);
  while (true) {
    try {
      const info = await api.notebook();
      if (await realpath(info.path) !== expectedPath) throw new Error('The test port belongs to another notebook.');
      notebookId = info.id;
      break;
    }
    catch { if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(process.stderr).text()}`); await Bun.sleep(20); }
  }
});
afterAll(async () => {
  globalThis.fetch = actualFetch;
  for (const instance of clients) await instance.dispose();
  process?.kill();
  if (process) await process.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('real notebook operations and recovery', () => {
  test('offline page creation accepts durable IDs, publishes a provisional root, and reopens it after reload', async () => {
    const session = `offline-create-${++serial}`;
    const instance = await client(session);
    await eventually(() => instance.connection() === 'live', 'creation stream did not connect');
    const title = `Offline planning ${++serial}`;
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Browser offline'); }, { preconnect: actualFetch.preconnect });
    try {
      const id = await instance.createPage(title);
      const doc = instance.open(id);
      expect(instance.roots().find(root => root.id === id)?.text).toBe(title);
      expect(instance.lookup(id)()?.text).toBe(title);
      expect(doc.status()).toBe('ready');
      const child = doc.outline.idAt(0);
      expect(doc.block(child)?.text).toBe('');
      expect(instance.queuedChanges()).toBe(2);
      const serverRoots = await actualFetch(`${baseUrl}/api/roots`).then(response => response.json()) as { id: string }[];
      expect(serverRoots.some(root => root.id === id)).toBe(false);
      await instance.dispose();
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'provisional page did not reopen');
      expect(recovered.roots().find(root => root.id === id)?.text).toBe(title);
      expect(ids(reopened)).toEqual([child]);
      success(reopened.edit({ kind: 'text', id: child, text: 'Offline authored planning' }));
      globalThis.fetch = actualFetch;
      recovered.retry();
      await recovered.flush();
      expect((await api.page(id)).rows.map(row => ({ id: row.block.id, text: row.block.text }))).toEqual([{ id: child, text: 'Offline authored planning' }]);
      expect((await api.roots()).filter(root => root.text === title).map(root => root.id)).toEqual([id]);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('a successful retry acknowledgement clears Offline when the existing change stream stayed open', async () => {
    const instance = await client();
    const { doc, first } = await page(instance);
    await eventually(() => instance.connection() === 'live', 'retry stream did not connect');
    let lose = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (lose && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) { lose = false; throw new TypeError('Lost acknowledgement with live stream'); }
      return response;
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'Reconnect once' }));
      await instance.flush();
      expect(instance.connection()).toBe('offline');
      instance.retry();
      await instance.flush();
      expect(instance.queuedChanges()).toBe(0);
      expect(instance.connection()).toBe('live');
      expect(instance.saveState()).toBe('saved');
      expect(doc.block(first)?.text).toBe('Reconnect once');
      expect((await api.block(first)).text).toBe('Reconnect once');
    } finally { globalThis.fetch = actualFetch; }
  });

  test('Retry reconciles a stale Offline state even when there is no queued work', async () => {
    const instance = await client();
    const { doc, id, first } = await page(instance);
    await eventually(() => instance.connection() === 'live', 'empty retry stream did not connect');
    let failRoots = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failRoots && String(input) === `${baseUrl}/api/roots`) throw new TypeError('Root refresh interrupted');
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id, text: `Reconnected title ${++serial}` }));
      await instance.flush();
      expect(instance.queuedChanges()).toBe(0);
      expect(instance.connection()).toBe('offline');
      failRoots = false;
      instance.retry();
      await eventually(() => instance.connection() === 'live', 'empty Retry never reconciled the open stream');
      expect(instance.saveState()).toBe('saved');
      expect(doc.block(first)?.text).toBe('left right');
    } finally { globalThis.fetch = actualFetch; }
  });

  test('Retry settles a previously unreachable unknown reference only after the service confirms it missing', async () => {
    const instance = await client();
    await eventually(() => instance.connection() === 'live', 'reference stream did not connect');
    const missing = ulid();
    const attempted = Promise.withResolvers<void>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/blocks/${missing}`) { attempted.resolve(); throw new TypeError('Reference lookup interrupted'); }
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      const reference = instance.lookup(missing);
      await attempted.promise;
      await instance.flush();
      expect(reference()).toBeUndefined();
      globalThis.fetch = actualFetch;
      instance.retry();
      await eventually(() => reference() === null, 'reconnection left the reference permanently unknown');
    } finally { globalThis.fetch = actualFetch; }
  }, 10000);

  test('range replacement, typing, cut, and both newline modes are each one saved undo transaction', async () => {
    const cases = [
      { mode: 'paste', text: 'REPLACEMENT', expected: ['aREPLACEMENTi'], offset: 12 },
      { mode: 'text', text: 'X', expected: ['aXi'], offset: 2 },
      { mode: 'text', text: '', expected: ['ai'], offset: 1 },
      { mode: 'text', text: '\n', expected: ['a\ni'], offset: 2 },
      { mode: 'split', text: '', expected: ['a', 'i'], offset: 0 },
    ] as const;
    for (const scenario of cases) {
      const instance = await client();
      const { doc, first, id } = await page(instance, 'abc');
      const middle = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'def' })).created[0]!;
      const last = success(doc.edit({ kind: 'insert', parentId: id, after: middle, text: 'ghi' })).created[0]!;
      await instance.flush();
      const range = { anchor: { id: last, offset: 2 }, head: { id: first, offset: 1 } };
      const replacement = success(doc.edit({ kind: 'replaceRange', range, between: [middle], text: scenario.text, mode: scenario.mode }, range.head));
      expect(ids(doc).map(id => doc.block(id)?.text)).toEqual([...scenario.expected]);
      expect(ids(doc)[0]).toBe(first);
      expect(replacement.caret).toEqual({ id: ids(doc).at(-1)!, offset: scenario.offset });
      const replacedIds = ids(doc);
      await instance.flush();
      expect(doc.undo()).toEqual({ ...range.head, range });
      await instance.flush();
      expect((await api.page(id)).rows.map(row => ({ id: row.block.id, text: row.block.text }))).toEqual([{ id: first, text: 'abc' }, { id: middle, text: 'def' }, { id: last, text: 'ghi' }]);
      doc.redo();
      await instance.flush();
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual(replacedIds);
      expect(ids(doc).map(id => doc.block(id)?.text)).toEqual([...scenario.expected]);
    }
  });

  test('single-block multiline replacement preserves suffix and indentation in one undo step', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'abc');
    const range = { anchor: { id: first, offset: 1 }, head: { id: first, offset: 2 } };
    const result = success(doc.edit({ kind: 'replaceRange', range, between: [], text: 'x\ny\n  nested', mode: 'paste' }, range.head));
    expect(ids(doc).map(id => ({ text: doc.block(id)?.text, depth: doc.outline.depth(id) }))).toEqual([{ text: 'ax', depth: 0 }, { text: 'y', depth: 0 }, { text: 'nestedc', depth: 1 }]);
    expect(result.caret).toEqual({ id: ids(doc).at(-1)!, offset: 6 });
    await instance.flush();
    expect(doc.undo()).toEqual({ ...range.head, range });
    await instance.flush();
    expect((await api.page(id)).rows.map(row => ({ id: row.block.id, text: row.block.text }))).toEqual([{ id: first, text: 'abc' }]);
    doc.redo();
    await instance.flush();
    expect(ids(doc).map(id => doc.block(id)?.text)).toEqual(['ax', 'y', 'nestedc']);
  });

  test('range replacement refuses hidden interiors before changing text, structure, or undo history', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'first');
    const hidden = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'hidden' })).created[0]!;
    const last = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'last' })).created[0]!;
    await instance.flush();
    const result = doc.edit({ kind: 'replaceRange', range: { anchor: { id: first, offset: 2 }, head: { id: last, offset: 2 } }, between: [], text: 'unsafe', mode: 'paste' });
    expect(result.ok).toBe(false);
    expect(ids(doc).map(id => ({ id, text: doc.block(id)?.text }))).toEqual([{ id: first, text: 'first' }, { id: hidden, text: 'hidden' }, { id: last, text: 'last' }]);
    expect(instance.queuedChanges()).toBe(0);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, hidden]);
  });

  test('replacement preserves descendants after an endpoint nested inside a deleted ancestor', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'abc');
    const middle = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'middle' })).created[0]!;
    const last = success(doc.edit({ kind: 'insert', parentId: middle, after: null, text: 'ghi' })).created[0]!;
    const child = success(doc.edit({ kind: 'insert', parentId: last, after: null, text: 'endpoint child' })).created[0]!;
    const tail = success(doc.edit({ kind: 'insert', parentId: middle, after: last, text: 'unselected tail' })).created[0]!;
    const outside = success(doc.edit({ kind: 'insert', parentId: first, after: middle, text: 'outside selection' })).created[0]!;
    await instance.flush();
    success(doc.edit({ kind: 'replaceRange', range: { anchor: { id: first, offset: 1 }, head: { id: last, offset: 2 } }, between: [middle], text: 'X', mode: 'text' }));
    await instance.flush();
    expect((await api.page(id)).rows.map(row => ({ id: row.block.id, parent: row.block.parent_id, text: row.block.text }))).toEqual([{ id: first, parent: id, text: 'aXi' }, { id: child, parent: first, text: 'endpoint child' }, { id: tail, parent: first, text: 'unselected tail' }, { id: outside, parent: first, text: 'outside selection' }]);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, middle, last, child, tail, outside]);
    expect(doc.outline.parentOf(child)).toBe(last);
    expect(doc.outline.parentOf(tail)).toBe(middle);
  });

  test('heading Enter chooses normal continuation, heading split, clear-empty, and first zoom child', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Heading');
    success(doc.edit({ kind: 'heading', id: first, level: 1 }));
    await instance.flush();
    const next = success(doc.edit({ kind: 'split', id: first, offset: 7 })).created[0]!;
    expect(doc.block(next)?.heading).toBeNull();
    expect(doc.block(first)?.heading).toBe(1);
    await instance.flush();
    doc.undo();
    await instance.flush();
    const inside = success(doc.edit({ kind: 'split', id: first, offset: 3 })).created[0]!;
    expect(doc.block(inside)?.heading).toBe(1);
    await instance.flush();
    doc.undo();
    await instance.flush();
    success(doc.edit({ kind: 'text', id: first, text: '' }));
    const clear = success(doc.edit({ kind: 'split', id: first, offset: 0 }));
    expect(clear.created).toEqual([]);
    expect(doc.block(first)?.heading).toBeNull();
    expect(ids(doc)).toEqual([first]);
    await instance.flush();
    success(doc.edit({ kind: 'text', id: first, text: 'Zoom root' }));
    const child = success(doc.edit({ kind: 'split', id: first, offset: 9, zoomRoot: first })).created[0]!;
    expect(doc.outline.children(first)).toEqual([child]);
    expect(doc.block(child)?.heading).toBeNull();
    await instance.flush();
    expect((await api.block(child)).parent_id).toBe(first);
  });

  test('an empty ready page seeds one shared blank row and deleting final content remains one undo step', async () => {
    const instance = await client();
    const id = ulid();
    await api.submit({ actor: { kind: 'agent', name: 'empty type page' }, operations: [{ op: 'create_page', id, title: `Empty tag page ${++serial}` }] });
    const doc = instance.open(id);
    const shared = instance.open(id);
    await eventually(() => doc.status() === 'ready', 'empty page did not load');
    const first = doc.outline.idAt(0);
    expect(shared).toBe(doc);
    expect(ids(doc).map(id => ({ text: doc.block(id)?.text, parent: doc.block(id)?.parentId }))).toEqual([{ text: '', parent: id }]);
    success(doc.edit({ kind: 'text', id: first, text: 'Final content' }));
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Final child' })).created[0]!;
    await instance.flush();
    const result = success(doc.edit({ kind: 'delete', ids: [first] }, { id: first, offset: 5 }));
    const blank = result.created[0]!;
    expect(result.caret).toEqual({ id: blank, offset: 0 });
    expect(ids(doc)).toEqual([blank]);
    await instance.flush();
    expect((await api.page(id)).rows.map(row => ({ id: row.block.id, text: row.block.text }))).toEqual([{ id: blank, text: '' }]);
    shared.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => ({ id: row.block.id, text: row.block.text }))).toEqual([{ id: first, text: 'Final content' }, { id: child, text: 'Final child' }]);
    shared.redo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([blank]);
  });

  test('offline rename publishes current root metadata so the vacated title can be created locally', async () => {
    const instance = await client();
    const { doc, id } = await page(instance);
    const original = doc.root()!.text;
    const renamed = `Offline renamed page ${++serial}`;
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Offline metadata'); }, { preconnect: actualFetch.preconnect });
    try {
      success(doc.rename(renamed));
      expect(instance.roots().find(root => root.id === id)?.text).toBe(renamed);
      expect(await instance.pageByTitle(renamed, false)).toBe(id);
      const replacement = await instance.createPage(original);
      expect(replacement).not.toBe(id);
      globalThis.fetch = actualFetch;
      instance.retry();
      await instance.flush();
      expect((await api.pageByTitle(renamed)).id).toBe(id);
      expect((await api.pageByTitle(original)).id).toBe(replacement);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('undo queued before a rename acknowledgement restores exact cross-page tag spellings', async () => {
    const instance = await client();
    const number = ++serial;
    const before = `#rACE${number} / #[[Race${number}]]`;
    const source = await page(instance, before);
    const root = await api.pageByTitle(`Race${number}`);
    const tagged = instance.open(root.id);
    await eventually(() => tagged.status() === 'ready', 'race tag page did not load');
    await instance.flush();
    const renamed = `Race renamed ${number}`;
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let hold = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (hold && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes(renamed)) { hold = false; reached.resolve(); await gate.promise; }
      return response;
    }) as typeof fetch;
    try {
      success(tagged.rename(renamed));
      const saving = instance.flush();
      await reached.promise;
      tagged.undo();
      gate.resolve();
      await saving;
      expect((await api.block(root.id)).text).toBe(root.text);
      expect((await api.block(source.first)).text).toBe(before);
      expect(source.doc.block(source.first)?.text).toBe(before);
      expect(instance.queuedChanges()).toBe(0);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; }
  });

  test('tag rename receipts update shared sources and undo restores exact spelling and membership', async () => {
    const instance = await client();
    const number = ++serial;
    const title = `Tag${number}`;
    const before = `#tAG${number} / #[[${title}]] / [[${title}]]`;
    const source = await page(instance, before);
    const other = await page(instance, `#TAG${number}`);
    const root = await api.pageByTitle(title);
    const tagged = instance.open(root.id);
    await eventually(() => tagged.status() === 'ready', 'tag page did not load');
    await instance.flush();
    const renamed = `Renamed Tag ${number}`;
    success(tagged.rename(renamed));
    await instance.flush();
    const after = `#[[${renamed}]] / #[[${renamed}]] / [[${title}]]`;
    expect(source.doc.block(source.first)?.text).toBe(after);
    expect(instance.lookup(other.first)()?.text).toBe(`#[[${renamed}]]`);
    tagged.undo();
    await instance.flush();
    expect((await api.block(root.id)).text).toBe(root.text);
    expect((await api.block(source.first)).text).toBe(before);
    expect((await api.block(other.first)).text).toBe(`#TAG${number}`);
    expect((await api.members(root.id)).map(row => row.block.id).sort()).toEqual([source.first, other.first].sort());
    tagged.redo();
    await instance.flush();
    expect((await api.block(source.first)).text).toBe(after);
  });

  test('equal-text tag receipts guard rename undo against a concurrently edited source', async () => {
    const instance = await client();
    const number = ++serial;
    const original = `GUARD${number}`;
    const source = await page(instance, `#${original}`);
    const root = await api.pageByTitle(original);
    const tagged = instance.open(root.id);
    await eventually(() => tagged.status() === 'ready', 'guard tag did not load');
    const renamed = `Guard${number}`;
    success(tagged.rename(renamed));
    await instance.flush();
    tagged.undo();
    await instance.flush();
    tagged.redo();
    await instance.flush();
    const current = await api.block(source.first);
    await api.submit({ actor: { kind: 'agent', name: 'concurrent guarded source edit' }, operations: [{ op: 'edit_text', id: source.first, base_revision: current.revision, text: `#${original} concurrent` }] });
    tagged.undo();
    await instance.flush();
    expect((await api.block(root.id)).text).toBe(renamed);
    expect((await api.block(source.first)).text).toBe(`#${original} concurrent`);
    expect(instance.saveState()).toBe('error');
  });

  test('ReceiptBook rename updates its own source before the next ordinary edit can recreate the old tag', async () => {
    const instance = await client();
    const id = await instance.createPage('ReceiptBook');
    const doc = instance.open(id);
    const first = doc.outline.idAt(0);
    success(doc.edit({ kind: 'text', id: first, text: '#ReceiptBook' }));
    await instance.flush();
    success(doc.rename('ReceiptFilm'));
    await instance.flush();
    expect(doc.block(first)?.text).toBe('#ReceiptFilm');
    success(doc.edit({ kind: 'text', id: first, text: `${doc.block(first)!.text} .` }));
    await instance.flush();
    expect((await api.block(first)).text).toBe('#ReceiptFilm .');
    expect((await api.pageByTitle('ReceiptFilm')).id).toBe(id);
    await expect(api.pageByTitle('ReceiptBook')).rejects.toHaveProperty('status', 404);
    doc.undo();
    await instance.flush();
    doc.undo();
    await instance.flush();
    expect((await api.block(id)).text).toBe('ReceiptBook');
    expect((await api.block(first)).text).toBe('#ReceiptBook');
  });

  test('split, merge, move and delete preserve identities across saves and shared undo', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance);
    const shared = instance.open(id);
    expect(shared).toBe(doc);
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'child' })).created[0]!;
    await instance.flush();
    const caretBefore = { id: first, offset: 4 };
    const right = success(doc.edit({ kind: 'split', id: first, offset: 4 }, caretBefore)).created[0]!;
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, child, right]);
    expect(doc.outline.parentOf(child)).toBe(first);
    expect(shared.undo()).toEqual(caretBefore);
    await instance.flush();
    expect((await api.block(first)).text).toBe('left right');
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, child]);
    shared.redo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, child, right]);
    success(doc.edit({ kind: 'merge', sourceId: right, destinationId: first }));
    await instance.flush();
    expect((await api.block(first)).text).toBe('left right');
    doc.undo();
    await instance.flush();
    expect((await api.block(right)).text).toBe(' right');
    success(doc.edit({ kind: 'indent', ids: [right] }));
    await instance.flush();
    expect((await api.block(right)).parent_id).toBe(first);
    doc.undo();
    await instance.flush();
    expect((await api.block(right)).parent_id).toBe(id);
    success(doc.edit({ kind: 'delete', ids: [first] }));
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([right]);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, child, right]);
  });

  test('lost acknowledgement resends a byte-identical frozen batch without duplicate blocks', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance);
    const requests: string[] = [];
    let lose = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') {
        requests.push(String(init.body));
        if (lose) { lose = false; throw new TypeError('Connection lost after commit'); }
      }
      return response;
    }) as typeof fetch;
    try {
      const right = success(doc.edit({ kind: 'split', id: first, offset: 4 })).created[0]!;
      await instance.flush();
      expect(instance.queuedChanges()).toBe(2);
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, right]);
      instance.retry();
      await instance.flush();
      expect(requests[1]).toBe(requests[0]);
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, right]);
      expect(instance.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('offline reload replays durable outbox over the cached page and later commits it', async () => {
    const session = `offline-${++serial}`;
    const instance = await client(session);
    const { id, doc, first } = await page(instance, 'saved');
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new TypeError('Offline'); }, { preconnect: actualFetch.preconnect });
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'queued offline' }));
      await instance.flush();
      expect(instance.queuedChanges()).toBe(1);
      await instance.dispose();
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'cached page did not reopen');
      expect(reopened.block(first)?.text).toBe('queued offline');
      expect(recovered.queuedChanges()).toBe(1);
      globalThis.fetch = actualFetch;
      recovered.retry();
      await recovered.flush();
      expect((await api.block(first)).text).toBe('queued offline');
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('acknowledged structural deltas reopen offline and a fresh snapshot cannot resurrect old restores', async () => {
    const session = `structural-cache-${++serial}`;
    const instance = await client(session);
    const { id, doc, first } = await page(instance);
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'durable child' })).created[0]!;
    await instance.flush();
    const right = success(doc.edit({ kind: 'split', id: first, offset: 4 })).created[0]!;
    await instance.flush();
    success(doc.edit({ kind: 'indent', ids: [right] }));
    await instance.flush();
    success(doc.edit({ kind: 'delete', ids: [child] }));
    await instance.flush();
    doc.undo();
    await instance.flush();
    const shape = (document: PageDocument) => ids(document).map(id => ({ id, parent: document.block(id)?.parentId, depth: document.outline.depth(id), text: document.block(id)?.text }));
    const expected = shape(doc);
    await instance.dispose();
    const offline = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new TypeError('Offline'); }, { preconnect: actualFetch.preconnect });
    globalThis.fetch = offline;
    try {
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'acknowledged cached structure did not reopen');
      expect(shape(reopened)).toEqual(expected);
      expect(recovered.queuedChanges()).toBe(0);
      globalThis.fetch = actualFetch;
      const saved = await api.block(child);
      await api.submit({ actor: { kind: 'agent', name: 'delete restored cached child' }, operations: [{ op: 'delete', id: child, base_revision: saved.revision }] });
      recovered.retry();
      await eventually(() => !reopened.block(child), 'remote deletion did not converge');
      await (reopened as Document).reload();
      const latest = shape(reopened);
      await recovered.dispose();
      globalThis.fetch = offline;
      const fresh = await client(session);
      const cached = fresh.open(id);
      await eventually(() => cached.status() === 'ready', 'fresh cached snapshot did not reopen');
      expect(shape(cached)).toEqual(latest);
      expect(cached.block(child)).toBeUndefined();
    } finally { globalThis.fetch = actualFetch; }
  });

  test('remote edit against unsent local text keeps both versions and resolves explicitly', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    await eventually(() => instance.connection() === 'live', 'stream did not connect');
    const base = await api.block(first);
    success(doc.edit({ kind: 'text', id: first, text: 'my version' }));
    await api.submit({ actor: { kind: 'agent', name: 'conflict test' }, operations: [{ op: 'edit_text', id: first, base_revision: base.revision, text: 'notebook version' }] });
    await eventually(() => doc.block(first)?.conflict?.remoteText === 'notebook version', 'remote version was not retained');
    expect(doc.block(first)?.text).toBe('my version');
    expect(doc.saveState()).toBe('conflict');
    doc.resolveConflict(first, 'mine');
    await instance.flush();
    expect((await api.block(first)).text).toBe('my version');
    expect(doc.block(first)?.conflict).toBeNull();
  });

  test('text typed during an in-flight save survives acknowledgement and does not change outline version', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    const version = doc.outline.version();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let intercept = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && intercept) {
        intercept = false;
        reached.resolve();
        await gate.promise;
      }
      return response;
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'first save' }));
      const saving = instance.flush();
      await reached.promise;
      success(doc.edit({ kind: 'text', id: first, text: 'typed while saving' }));
      expect(doc.block(first)?.text).toBe('typed while saving');
      gate.resolve();
      await saving;
      expect(doc.block(first)?.text).toBe('typed while saving');
      expect((await api.block(first)).text).toBe('typed while saving');
      expect(doc.outline.version()).toBe(version);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; }
  });

  test('merging a source with children restores their original parent and order on undo', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'destination');
    const source = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'source' })).created[0]!;
    const a = success(doc.edit({ kind: 'insert', parentId: source, after: null, text: 'a' })).created[0]!;
    const b = success(doc.edit({ kind: 'insert', parentId: source, after: a, text: 'b' })).created[0]!;
    await instance.flush();
    success(doc.edit({ kind: 'merge', sourceId: source, destinationId: first }));
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, a, b]);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, source, a, b]);
    expect((await api.block(a)).parent_id).toBe(source);
    expect((await api.block(b)).parent_id).toBe(source);
  });

  test('multiline paste preserves sibling order and nests indented lines through save and undo', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'suffix');
    const result = success(doc.edit({ kind: 'paste', at: { id: first, offset: 0 }, text: 'a\nb\n  child\nc' }));
    await instance.flush();
    const b = result.created[0]!;
    const child = result.created[1]!;
    const c = result.created[2]!;
    const view = await api.page(id);
    expect(view.rows.map(row => [row.block.id, row.block.text, row.depth])).toEqual([[first, 'a', 0], [b, 'b', 0], [child, 'child', 1], [c, 'csuffix', 0]]);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => [row.block.id, row.block.text])).toEqual([[first, 'suffix']]);
  });

  test('reloading an uncertain committed split replays its frozen outbox without duplicate IDs', async () => {
    const session = `uncertain-reload-${++serial}`;
    const instance = await client(session);
    const { doc, first, id } = await page(instance);
    let lose = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && lose) { lose = false; throw new TypeError('Lost acknowledgement'); }
      return response;
    }) as typeof fetch;
    try {
      const right = success(doc.edit({ kind: 'split', id: first, offset: 4 })).created[0]!;
      await instance.flush();
      await instance.dispose();
      globalThis.fetch = actualFetch;
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'uncertain split did not reopen');
      await recovered.flush();
      expect(ids(reopened)).toEqual([first, right]);
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, right]);
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('clean clients converge on stream text and subtree moves', async () => {
    const firstClient = await client();
    const { doc, first, id } = await page(firstClient, 'before');
    const secondClient = await client();
    const second = secondClient.open(id);
    await eventually(() => second.status() === 'ready' && secondClient.connection() === 'live', 'second document did not connect');
    success(doc.edit({ kind: 'text', id: first, text: 'after' }));
    await firstClient.flush();
    await eventually(() => second.block(first)?.text === 'after', 'clean text did not converge');
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'child' })).created[0]!;
    await firstClient.flush();
    await eventually(() => second.outline.indexOf(child) >= 0, 'insert did not converge');
    success(doc.edit({ kind: 'outdent', ids: [child] }));
    await firstClient.flush();
    await eventually(() => second.outline.parentOf(child) === id, 'subtree move did not converge');
    expect(ids(second)).toEqual(ids(doc));
    expect(secondClient.lookup(first)()?.text).toBe('after');
  });

  test('page deletion undo restores the original root and descendant IDs', async () => {
    const instance = await client();
    const { doc, id, first } = await page(instance, 'keep this ID');
    await instance.deletePage(id);
    expect(instance.roots().some(root => root.id === id)).toBe(false);
    expect(doc.status()).toBe('missing');
    await instance.restorePage(id);
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first]);
    expect(doc.status()).toBe('ready');
    expect(doc.block(first)?.text).toBe('keep this ID');
  });

  test('tag-created pages enter the notebook cache and root list after acknowledgement', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    const tag = `DocumentTag${++serial}`;
    success(doc.edit({ kind: 'text', id: first, text: `member #${tag}` }));
    await instance.flush();
    const target = await api.pageByTitle(tag);
    expect(instance.roots().some(root => root.id === target.id)).toBe(true);
    expect(instance.lookup(target.id)()?.text).toBe(tag);
    expect((await api.members(target.id)).map(row => row.block.id)).toContain(first);
  });

  test('a duplicate rename fails synchronously without changing the live title', async () => {
    const instance = await client();
    const { doc } = await page(instance);
    const taken = `Taken Title ${++serial}`;
    await instance.createPage(taken);
    const before = doc.root()?.text;
    expect(doc.rename(taken.toUpperCase()).ok).toBe(false);
    expect(doc.root()?.text).toBe(before);
  });

  test('an IndexedDB open failure is visible while editing and real-service saving still work', async () => {
    const id = ulid();
    const first = ulid();
    await api.submit({ actor: { kind: 'agent', name: 'existing page before storage failure' }, operations: [{ op: 'create_page', id, title: `Existing storage failure page ${++serial}` }, { op: 'insert', id: first, parent_id: id, after: null, text: 'base', heading: null }] });
    const realIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = new Proxy(realIndexedDB, {
      get(target, key, receiver) {
        if (key === 'open') return () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
        return Reflect.get(target, key, receiver);
      },
    });
    let instance: Notebook | undefined;
    try {
      instance = await client();
      const doc = instance.open(id);
      await eventually(() => doc.status() === 'ready', 'existing page did not load with failed storage');
      const title = `Locally unaccepted page ${++serial}`;
      await expect(instance.createPage(title)).rejects.toThrow('Not saved locally');
      expect(instance.unsavedText()).toContain(title);
      success(doc.edit({ kind: 'text', id: first, text: 'kept in memory' }));
      expect(instance.localPersistence()).toBe('failed');
      expect(instance.saveMessage()).toContain('Not saved locally');
      expect(instance.unsavedText()).toContain('kept in memory');
      await instance.flush();
      expect((await api.block(first)).text).toBe('kept in memory');
    } finally { globalThis.indexedDB = realIndexedDB; await instance?.dispose(); }
  });

  test('Use notebook survives an uncertain uncommitted frozen request and retains both versions until its ack', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    await eventually(() => instance.connection() === 'live', 'change stream did not connect');
    let offline = true;
    const bodies: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) {
        bodies.push(String(init.body));
        if (offline) throw new TypeError('Disconnected before service receipt');
      }
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'my retained version' }));
      await instance.flush();
      const current = await api.block(first);
      await api.submit({ actor: { kind: 'agent', name: 'frozen conflict' }, operations: [{ op: 'edit_text', id: first, base_revision: current.revision, text: 'notebook chosen version' }] });
      await eventually(() => doc.block(first)?.conflict !== null, 'remote conflict did not arrive');
      doc.resolveConflict(first, 'theirs');
      expect(doc.block(first)?.text).toBe('my retained version');
      expect(doc.block(first)?.conflict?.remoteText).toBe('notebook chosen version');
      offline = false;
      await instance.flush();
      expect(bodies[1]).toBe(bodies[0]);
      expect((await api.block(first)).text).toBe('notebook chosen version');
      expect(doc.block(first)?.text).toBe('notebook chosen version');
      expect(doc.block(first)?.conflict).toBeNull();
      expect(instance.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('a resolution after uncertain committed ack is a new batch, not a mutation of the frozen replay', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    await eventually(() => instance.connection() === 'live', 'change stream did not connect');
    let lose = true;
    const bodies: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) {
        bodies.push(String(init.body));
        if (lose) { lose = false; throw new TypeError('Lost committed acknowledgement'); }
      }
      return response;
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'committed but unacknowledged' }));
      await instance.flush();
      const current = await api.block(first);
      await api.submit({ actor: { kind: 'agent', name: 'post-commit conflict' }, operations: [{ op: 'edit_text', id: first, base_revision: current.revision, text: 'later notebook version' }] });
      await eventually(() => doc.block(first)?.conflict?.remoteText === 'later notebook version', 'later remote version did not arrive');
      doc.resolveConflict(first, 'theirs');
      await instance.flush();
      expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[2]!).idempotency_key).not.toBe(JSON.parse(bodies[0]!).idempotency_key);
      expect((await api.block(first)).text).toBe('later notebook version');
      expect(doc.block(first)?.text).toBe('later notebook version');
      expect(doc.block(first)?.conflict).toBeNull();
    } finally { globalThis.fetch = actualFetch; }
  });

  test('a deleted target transfers queued text and its split into durable rejected recovery without reapplying', async () => {
    const session = `rejected-${++serial}`;
    const instance = await client(session);
    const { doc, first, id } = await page(instance, 'base');
    let offline = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) throw new TypeError('Disconnected');
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: first, text: 'Local authored text must remain' }));
      await instance.flush();
      success(doc.edit({ kind: 'split', id: first, offset: 5 }));
      const current = await api.block(first);
      await api.submit({ actor: { kind: 'agent', name: 'remote deletion' }, operations: [{ op: 'delete', id: first, base_revision: current.revision }] });
      offline = false;
      instance.retry();
      await instance.flush();
      expect(instance.rejectedText()).toContain('Local authored text must remain');
      expect(instance.unsavedText()).toContain('Local authored text must remain');
      expect(instance.saveState()).toBe('error');
      expect(instance.queuedChanges()).toBe(0);
      await expect(api.block(first)).rejects.toHaveProperty('status', 404);
      await instance.dispose();
      globalThis.fetch = actualFetch;
      const recovered = await client(session);
      expect(recovered.rejectedText()).toContain('Local authored text must remain');
      expect(recovered.saveMessage()).toContain('Local authored text must remain');
      await recovered.flush();
      await expect(api.block(first)).rejects.toHaveProperty('status', 404);
      recovered.dismissRejected();
      await recovered.flush();
      expect(recovered.rejectedText()).toBe('');
      expect(recovered.saveState()).toBe('saved');
    } finally { globalThis.fetch = actualFetch; }
  });

  test('a rejected paste retains the authored text of every uncommitted inserted block', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'base');
    const current = await api.block(first);
    let intervene = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (intervene && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) {
        intervene = false;
        await actualFetch(`${baseUrl}/api/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: { kind: 'agent', name: 'paste collision' }, operations: [{ op: 'edit_text', id: first, base_revision: current.revision, text: 'remote text' }] }) });
      }
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'paste', at: { id: first, offset: 0 }, text: 'first authored line\nsecond authored line\n  nested authored line' }));
      await instance.flush();
      expect(instance.rejectedText()).toContain('first authored line');
      expect(instance.rejectedText()).toContain('second authored line');
      expect(instance.rejectedText()).toContain('nested authored line');
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual(['remote text']);
      expect(instance.saveState()).toBe('error');
      instance.dismissRejected();
      await instance.flush();
    } finally { globalThis.fetch = actualFetch; }
  });

  test('an old page response cannot roll back text or an insertion acknowledged while it was in flight', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'old text');
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let intercept = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/pages/${id}` && intercept) { intercept = false; reached.resolve(); await gate.promise; }
      return response;
    }) as typeof fetch;
    try {
      const loading = (doc as Document).reload();
      await reached.promise;
      success(doc.edit({ kind: 'text', id: first, text: 'new acknowledged text' }));
      const created = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'new acknowledged block' })).created[0]!;
      await instance.flush();
      gate.resolve();
      await loading;
      expect(doc.block(first)?.text).toBe('new acknowledged text');
      expect(ids(doc)).toEqual([first, created]);
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, created]);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; }
  });

  test('a remote edit of a newly committed but unacknowledged insertion retains both versions and its outline ID', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance);
    await eventually(() => instance.connection() === 'live', 'change stream did not connect');
    let lose = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (lose && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"')) { lose = false; throw new TypeError('Lost insertion acknowledgement'); }
      return response;
    }) as typeof fetch;
    try {
      const right = success(doc.edit({ kind: 'split', id: first, offset: 4 })).created[0]!;
      await instance.flush();
      const current = await api.block(right);
      await api.submit({ actor: { kind: 'agent', name: 'new insertion edit' }, operations: [{ op: 'edit_text', id: right, base_revision: current.revision, text: 'remote insertion text' }] });
      await eventually(() => doc.block(right)?.conflict?.remoteText === 'remote insertion text', 'new insertion did not retain the remote version');
      expect(doc.block(right)?.text).toBe(' right');
      expect(instance.lookup(right)()?.text).toBe(' right');
      instance.retry();
      await instance.flush();
      expect(ids(doc)).toEqual([first, right]);
      expect(doc.block(right)?.conflict?.remoteText).toBe('remote insertion text');
      doc.resolveConflict(right, 'theirs');
      await instance.flush();
      expect(doc.block(right)?.text).toBe('remote insertion text');
      expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first, right]);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('hidden interior descendants reject range deletion without losing text or IDs', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'first');
    const hidden = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'hidden' })).created[0]!;
    const last = success(doc.edit({ kind: 'insert', parentId: doc.pageId, after: first, text: 'last' })).created[0]!;
    await instance.flush();
    const result = doc.edit({ kind: 'deleteRange', range: { anchor: { id: first, offset: 2 }, head: { id: last, offset: 2 } }, between: [] });
    expect(result.ok).toBe(false);
    expect(ids(doc)).toEqual([first, hidden, last]);
    expect(doc.block(first)?.text).toBe('first');
    expect((await api.block(hidden)).text).toBe('hidden');
  });
});
