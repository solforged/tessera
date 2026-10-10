import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import type { Batch, Operation, SourceState, TaskState } from '../api/types';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import type { EditResult, NewCitation, PageDocument } from './contract';
import type { Document } from './page-document';
import { boundaryDeletion } from './outline-mechanics';
import { questionStatus } from './types';
import { saveDetails, sourceMetadata } from '../library/details';
import { sourceReadingOrder } from '../library/source-order';

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
  test('a new field keeps its chosen kind through one undo and redo', async () => {
    const instance = await client();
    const fields = await api.fields();
    const doc = instance.open(fields.page_id);
    await eventually(() => doc.status() === 'ready', doc.statusMessage());
    const name = `New number field ${++serial}`;
    const id = success(doc.edit({ kind: 'addField', name, value: 'number' })).created[0]!;
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)).toMatchObject({ id, name, kind: 'number' });
    expect((await api.page(fields.page_id)).rows.find(row => row.block.id === id)?.block.text).toBe(name);

    doc.undo();
    expect(doc.block(id)).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
    await instance.flush();
    expect((await api.fields()).fields.some(field => field.id === id)).toBe(false);
    expect((await api.page(fields.page_id)).rows.some(row => row.block.id === id)).toBe(false);

    doc.redo();
    expect(doc.block(id)?.text).toBe(name);
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)).toMatchObject({ id, name, kind: 'number' });
    expect((await api.page(fields.page_id)).rows.find(row => row.block.id === id)?.block.text).toBe(name);
    doc.release();
  });

  test('field kind edits persist, undo and redo through the document outbox', async () => {
    const instance = await client();
    const fields = await api.fields();
    const doc = instance.open(fields.page_id);
    await eventually(() => doc.status() === 'ready', doc.statusMessage());
    const id = success(doc.edit({ kind: 'insert', parentId: fields.page_id, after: null, text: `Kind test ${++serial}` })).created[0]!;
    await instance.flush();
    const definition = (await api.fields()).fields.find(field => field.id === id)!;
    success(doc.edit({ kind: 'fieldKind', definition, value: 'number' }));
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.kind).toBe('number');
    doc.undo();
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.kind).toBe('text');
    doc.redo();
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.kind).toBe('number');
    const stale = doc.edit({ kind: 'fieldKind', definition, value: 'date' });
    expect(stale.ok).toBe(false);
    expect((await api.fields()).fields.find(field => field.id === id)?.kind).toBe('number');
    doc.release();
  });

  test('manual types persist through outbox recovery, undo, redo, and remote rename', async () => {
    const session = `manual-types-${++serial}`;
    const instance = await client(session);
    const title = `Manual type ${++serial}`;
    const { id, doc, first } = await page(instance, 'Reading');
    success(doc.addType(first, title));
    expect(doc.block(first)?.manual_types).toEqual([title]);
    await instance.flush();
    expect((await api.page(id)).rows[0]!.manual_types).toEqual([title]);
    doc.undo();
    expect(doc.block(first)?.manual_types).toEqual([]);
    await instance.flush();
    expect((await api.page(id)).rows[0]!.manual_types).toEqual([]);
    doc.redo();
    await instance.flush();
    success(doc.removeType(first, title));
    await instance.flush();
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows[0]!.manual_types).toEqual([title]);
    await instance.dispose();
    const recovered = await client(session);
    const reopened = recovered.open(id);
    await eventually(() => reopened.status() === 'ready', 'manual types page did not reopen');
    expect(reopened.block(first)?.manual_types).toEqual([title]);
    const type = await api.pageByTitle(title);
    await api.submit({ actor: { kind: 'person' }, operations: [{ op: 'edit_text', id: type.id, base_revision: type.revision, text: `${title} renamed` }] });
    await eventually(() => reopened.block(first)?.manual_types[0] === `${title} renamed`, 'remote rename did not refresh manual types');
    success(reopened.removeType(first, `${title} renamed`));
    await recovered.flush();
    expect((await api.page(id)).rows[0]!.manual_types).toEqual([]);
  });

  test('offline manual membership replays once and survives a later text edit', async () => {
    const session = `offline-manual-types-${++serial}`;
    const instance = await client(session);
    const { id, doc, first } = await page(instance, '#Book');
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Browser offline'); }, { preconnect: actualFetch.preconnect });
    try {
      success(doc.addType(first, 'Book'));
      await instance.flush();
      await instance.dispose();
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'offline manual types page did not reopen');
      expect(reopened.block(first)?.manual_types).toEqual(['Book']);
      success(reopened.edit({ kind: 'text', id: first, text: 'Reading' }));
      globalThis.fetch = actualFetch;
      recovered.retry();
      await recovered.flush();
      expect((await api.page(id)).rows[0]!.manual_types).toEqual(['Book']);
      expect((await api.page(id)).rows[0]!.block.text).toBe('Reading');
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('notebook settings share revisions, undo safely, and choose the service journal date', async () => {
    const first = await client();
    const second = await client();
    await eventually(() => first.connection() === 'live' && second.connection() === 'live', 'settings streams did not connect');
    const originalZone = first.settings()!.time_zone;
    await first.setSetting('time_zone', 'Pacific/Kiritimati');
    await eventually(() => second.settings()?.time_zone === 'Pacific/Kiritimati', 'remote time zone did not arrive');
    const todayId = await first.today();
    await first.flush();
    expect((await api.page(todayId)).root.text).toBe((await api.settings()).today);
    await first.setSetting('vim', 'true');
    await eventually(() => second.vim(), 'remote Vim preference did not arrive');
    await first.undoSetting();
    expect(first.vim()).toBe(false);
    await first.undoSetting();
    expect(first.settings()?.time_zone).toBe(originalZone);
    await first.redoSetting();
    expect(first.settings()?.time_zone).toBe('Pacific/Kiritimati');
    await first.redoSetting();
    expect(first.vim()).toBe(true);
    await second.refreshSettings();
    await second.setSetting('vim', 'false');
    await eventually(() => !first.vim(), 'new remote Vim preference did not arrive');
    await expect(first.undoSetting()).rejects.toThrow();
    expect((await api.settings()).settings.find(setting => setting.key === 'vim')?.value).toBe('false');
    await first.setSetting('time_zone', originalZone);
  });
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

  test('both split paths treat a URL as editable plain text', async () => {
    const instance = await client();
    for (const ranged of [false, true]) {
      const text = 'https://example.org/path';
      const { doc, first, id } = await page(instance, text);
      const caret = { id: first, offset: 12 };
      const edit = ranged
        ? { kind: 'replaceRange' as const, range: { anchor: caret, head: caret }, between: [], text: '', mode: 'split' as const }
        : { kind: 'split' as const, id: first, offset: caret.offset };
      success(doc.edit(edit, caret));
      expect(ids(doc).map(id => doc.block(id)?.text)).toEqual([text.slice(0, 12), text.slice(12)]);
      await instance.flush();
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual([text.slice(0, 12), text.slice(12)]);
      doc.undo();
      await instance.flush();
      expect(ids(doc).map(id => doc.block(id)?.text)).toEqual([text]);
      doc.release();
    }
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

  test('an IndexedDB open failure keeps edits visible without sending an unfrozen request', async () => {
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
      expect((await api.block(first)).text).toBe('base');
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

const todo: TaskState = { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };

describe('durable Action and Learning document commands', () => {
  test('Backspace deletes an empty todo even with history and undo restores its task', async () => {
    for (const history of [false, true]) {
      const instance = await client();
      const { doc, first, id } = await page(instance, '');
      success(doc.edit({ kind: 'task', id: first, value: todo }));
      if (history) success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-03' }));
      await doc.flush();
      const task = { ...doc.block(first)!.task! };
      const at = { id: first, offset: 0 };
      const intent = boundaryDeletion(doc, first, 'backward');
      expect(intent).toEqual({ kind: 'delete', ids: [first] });
      const removed = success(doc.edit(intent!, at));
      expect(doc.block(first)).toBeUndefined();
      expect(removed.caret).toEqual({ id: removed.created[0]!, offset: 0 });
      expect(doc.block(removed.created[0]!)?.text).toBe('');
      expect(doc.block(removed.created[0]!)?.task).toBeNull();
      await doc.flush();
      expect(doc.undo()).toEqual(at);
      expect(ids(doc)).toEqual([first]);
      expect(doc.block(first)?.task).toEqual(task);
      expect(doc.block(first)?.mergeProtected).toBe(true);
      await doc.flush();
      expect((await api.page(id)).capabilities).toEqual([await api.capabilities(first)]);
      expect((await api.capabilities(first)).history).toBe(history);
    }
  });

  test('Backspace removes a nonempty todo before merging nested siblings, while forward Delete refuses', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Groceries');
    const milk = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Buy milk' })).created[0]!;
    const eggs = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Buy eggs' })).created[0]!;
    success(doc.edit({ kind: 'task', id: milk, value: todo }));
    success(doc.edit({ kind: 'task', id: eggs, value: todo }));
    success(doc.edit({ kind: 'indent', ids: [eggs] }));
    await doc.flush();
    expect(doc.outline.children(first)).toEqual([milk, eggs]);
    expect(doc.edit(boundaryDeletion(doc, milk, 'forward')!).ok).toBe(false);
    const at = { id: eggs, offset: 0 };
    const remove = boundaryDeletion(doc, eggs, 'backward', milk);
    expect(remove).toEqual({ kind: 'task', id: eggs, value: null });
    expect(success(doc.edit(remove!, at)).caret).toEqual(at);
    expect(doc.block(eggs)?.mergeProtected).toBe(false);
    const merge = boundaryDeletion(doc, eggs, 'backward', milk);
    expect(merge).toEqual({ kind: 'merge', sourceId: eggs, destinationId: milk });
    expect(success(doc.edit(merge!, at)).caret).toEqual({ id: milk, offset: 8 });
    expect(doc.block(milk)?.text).toBe('Buy milkBuy eggs');
    expect(doc.block(milk)?.task).toEqual(todo);
    expect(doc.block(eggs)).toBeUndefined();
    await doc.flush();
    expect(doc.undo()).toEqual(at);
    await doc.flush();
    expect(doc.block(eggs)?.task).toBeNull();
    expect(doc.block(eggs)?.mergeProtected).toBe(false);
    expect(doc.undo()).toEqual(at);
    await doc.flush();
    expect(doc.block(eggs)?.task).toEqual(todo);
    expect(doc.block(eggs)?.mergeProtected).toBe(true);
    success(doc.edit({ kind: 'heading', id: eggs, level: 2 }));
    expect(boundaryDeletion(doc, eggs, 'backward', milk)).toEqual({ kind: 'task', id: eggs, value: null });
    await doc.flush();
  });

  test('completion protects a removed task until undo receives authoritative cleared history', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Destination');
    const source = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Task' })).created[0]!;
    success(doc.edit({ kind: 'task', id: source, value: todo }));
    await doc.flush();
    success(doc.edit({ kind: 'completeTask', id: source, completedOn: '2026-10-03' }));
    expect((doc as Document).capabilities(source).history).toBe(true);
    success(doc.edit({ kind: 'task', id: source, value: null }));
    expect(doc.block(source)?.mergeProtected).toBe(true);
    expect(doc.edit({ kind: 'merge', sourceId: source, destinationId: first })).toEqual({
      ok: false, reason: 'This task has completion or work history; delete it or keep it separate.',
    });
    await doc.flush();
    doc.undo();
    await doc.flush();
    doc.undo();
    expect(doc.block(source)?.task).toEqual(todo);
    expect((doc as Document).capabilities(source).history).toBe(true);
    await doc.flush();
    expect((doc as Document).capabilities(source).history).toBe(false);
    expect(doc.block(source)?.mergeProtected).toBe(true);
    success(doc.edit({ kind: 'task', id: source, value: null }));
    expect(doc.block(source)?.mergeProtected).toBe(false);
    await doc.flush();
    expect((await api.capabilities(source)).merge_protected).toBe(false);
    doc.undo();
    expect(doc.block(source)?.mergeProtected).toBe(true);
    await doc.flush();
  });

  test('recurrence receipts preserve signed dates, share sidecars, and reverse exactly one occurrence', async () => {
    const instance = await client();
    const { doc, id, first } = await page(instance, 'Read the next primary source');
    const shared = instance.open(id);
    const remote = await client();
    const other = remote.open(id);
    await eventually(() => other.status() === 'ready' && remote.connection() === 'live', 'capability subscriber not ready');
    const planned: TaskState = { ...todo, scheduled: '2026-10-10', deadline: '2026-10-05', scheduled_time: '09:00', repeater: { every: 1, unit: 'day', mode: 'fixed' } };
    success(doc.edit({ kind: 'task', id: first, value: planned }));
    await doc.flush();
    success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-11' }));
    expect(doc.block(first)?.task).toEqual(planned);
    await doc.flush();
    expect(shared).toBe(doc);
    expect(shared.block(first)?.task).toEqual({ ...planned, scheduled: '2026-10-11', deadline: '2026-10-06' });
    await eventually(() => other.block(first)?.task?.deadline === '2026-10-06', 'remote recurrence sidecar not reconciled');
    const firstOccurrence = (await api.taskOccurrences(first))[0]!;
    doc.undo();
    await doc.flush();
    expect(doc.block(first)?.task).toEqual(planned);
    expect((await api.taskOccurrences(first)).find(event => event.id === firstOccurrence.id)?.reversed).toBe(true);
    doc.redo();
    await doc.flush();
    const events = await api.taskOccurrences(first);
    expect(events).toHaveLength(2);
    expect(events.filter(event => !event.reversed)).toHaveLength(1);
    expect(events.find(event => !event.reversed)?.id).not.toBe(firstOccurrence.id);
    expect(doc.block(first)?.task?.scheduled).toBe('2026-10-11');
    shared.release(); other.release();
  });

  test('planning is one text/state undo step and reopening undo restores done without new evidence', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Read @tomorrow');
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    await doc.flush();
    const before = { id: first, offset: 14 };
    const planned = { ...todo, scheduled: '2026-10-04', scheduled_time: '14:30' };
    expect(success(doc.edit({ kind: 'planTask', id: first, text: 'Read', value: planned }, before)).caret).toEqual({ id: first, offset: 4 });
    await doc.flush();
    expect(doc.undo()).toEqual(before);
    await doc.flush();
    expect(doc.block(first)?.text).toBe('Read @tomorrow');
    expect(doc.block(first)?.task).toEqual(todo);
    doc.redo();
    await doc.flush();
    expect(doc.block(first)?.text).toBe('Read');
    expect(doc.block(first)?.task).toEqual(planned);
    success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-04' }));
    await doc.flush();
    success(doc.edit({ kind: 'task', id: first, value: planned }));
    await doc.flush();
    expect(doc.block(first)?.task?.status).toBe('todo');
    doc.undo();
    await doc.flush();
    expect(doc.block(first)?.task).toEqual({ ...planned, status: 'done', completed_on: '2026-10-04' });
    expect(await api.taskOccurrences(first)).toHaveLength(1);
    doc.redo();
    await doc.flush();
    expect(doc.block(first)?.task).toEqual(planned);
    expect(await api.taskOccurrences(first)).toHaveLength(1);
  });

  test('work start, stop, note and combined completion undo retain session identity and exact notes', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Translate the inscription');
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    await doc.flush();
    success(doc.edit({ kind: 'startWork', id: first, startedAt: 1000 }));
    expect((doc as Document).capabilities(first).history).toBe(true);
    await doc.flush();
    const initial = (await api.workSessions(first))[0]!;
    expect(doc.edit({ kind: 'archive', id: first, archived: true }).ok).toBe(false);
    expect(doc.edit({ kind: 'delete', ids: [first] }).ok).toBe(false);
    doc.undo();
    await doc.flush();
    expect((await api.workSessions(first))[0]?.reversed).toBe(true);
    expect((doc as Document).capabilities(first).history).toBe(false);
    doc.redo();
    await doc.flush();
    let session = (await api.workSessions(first))[0]!;
    expect(session.id).toBe(initial.id);
    expect(session.reversed).toBe(false);
    success(doc.edit({ kind: 'stopWork', id: first, session, endedAt: 2000, note: 'First pass' }));
    await doc.flush();
    session = (await api.workSessions(first))[0]!;
    success(doc.edit({ kind: 'workNote', id: first, session, note: 'Corrected reading' }));
    expect(doc.edit({ kind: 'workNote', id: first, session, note: 'Stale second note' }).ok).toBe(false);
    await doc.flush();
    doc.undo();
    await doc.flush();
    expect((await api.workSessions(first))[0]?.note).toBe('First pass');
    doc.undo();
    await doc.flush();
    session = (await api.workSessions(first))[0]!;
    expect(session.ended_at).toBeNull();
    expect(session.note).toBe('');
    success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-03', stopWork: session }));
    await doc.flush();
    expect((await api.workSessions(first))[0]?.ended_at).not.toBeNull();
    expect(doc.block(first)?.task?.status).toBe('done');
    doc.undo();
    await doc.flush();
    expect(doc.block(first)?.task?.status).toBe('todo');
    expect((await api.workSessions(first))[0]?.ended_at).toBeNull();
    doc.redo();
    await doc.flush();
    expect((await api.workSessions(first))[0]?.id).toBe(initial.id);
    expect((await api.workSessions(first))[0]?.ended_at).not.toBeNull();
    expect((await api.taskOccurrences(first)).filter(event => !event.reversed)).toHaveLength(1);
  });

  test('stale task snapshots are refused and their rejected metadata survives later writes and reload', async () => {
    const session = `metadata-rejection-${++serial}`;
    const instance = await client(session);
    const { doc, first, id } = await page(instance);
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    await doc.flush();
    const current = await api.block(first);
    let intervene = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (intervene && String(input) === `${baseUrl}/api/batches` && String(init?.body).includes('"set_task"')) {
        intervene = false;
        await actualFetch(`${baseUrl}/api/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: { kind: 'person' }, operations: [{ op: 'set_task', id: first, base_revision: current.revision, task: { ...todo, priority: 'high' } }] }) });
      }
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'task', id: first, value: { ...todo, scheduled: '2026-10-09' } }));
      await expect(doc.flush()).rejects.toThrow();
      await instance.flush();
      expect((await api.capabilities(first)).task?.priority).toBe('high');
      expect((await api.capabilities(first)).task?.scheduled).toBeNull();
      expect(instance.rejectedText()).toContain('2026-10-09');
      success(doc.edit({ kind: 'text', id: first, text: 'A later successful text edit' }));
      await instance.flush();
      expect((await api.block(first)).text).toBe('A later successful text edit');
      expect(instance.saveState()).toBe('error');
      await instance.dispose();
      const recovered = await client(session);
      expect(recovered.rejectedText()).toContain('2026-10-09');
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'rejected page did not reopen');
      expect(reopened.block(first)?.task?.priority).toBe('high');
      recovered.dismissRejected();
    } finally { globalThis.fetch = actualFetch; }
  });

  test('lost completion and queued grade recover in order with frozen IDs and shown evidence', async () => {
    const session = `completion-grade-${++serial}`;
    const instance = await client(session);
    const { doc, first, id } = await page(instance, 'Avestan >> an Old Iranian language');
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    await doc.flush();
    const card = (await api.sourceCards(first))[0]!;
    const eventId = ulid();
    const grade: Operation = { op: 'grade_card', id: card.id, base_revision: card.revision, definition_revision: card.definition_revision, event_id: eventId, session_id: null, grade: 'good', reset: false, shown_front: card.front, shown_back: card.back, reviewed_at: 10000 };
    const requests: string[] = [];
    let lose = true, offline = false, settled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const batch = String(input) === `${baseUrl}/api/batches` && init?.method === 'POST';
      if (batch) requests.push(String(init.body));
      if (offline) throw new TypeError('Offline with uncertain completion');
      const response = await actualFetch(input, init);
      if (batch && lose) { lose = false; offline = true; throw new TypeError('Lost committed completion receipt'); }
      return response;
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-03' }));
      void doc.flush().then(() => { settled = true; });
      await instance.flush();
      expect(settled).toBe(false);
      const completionBytes = requests[0]!;
      void instance.commit([grade]).then(() => { settled = true; });
      grade.shown_back = 'Caller mutation must not reach the outbox';
      await instance.flush();
      expect(instance.queuedChanges()).toBe(2);
      await instance.dispose();
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'offline capabilities did not recover');
      expect(reopened.block(first)?.mergeProtected).toBe(true);
      expect((reopened as Document).capabilities(first).history).toBe(true);
      expect(recovered.commandState()).not.toBe('saved');
      offline = false;
      recovered.retry();
      await recovered.flush();
      expect(requests.filter(body => body.includes('"complete_task"')).every(body => body === completionBytes)).toBe(true);
      expect(await api.taskOccurrences(first)).toHaveLength(1);
      const reviews = await api.cardReviews(card.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.id).toBe(eventId);
      expect(reviews[0]?.shown_back).toBe(card.back);
      expect(recovered.commandState()).toBe('saved');
      expect(reopened.block(first)?.task?.status).toBe('done');
    } finally { globalThis.fetch = actualFetch; }
  });

  test('an uncertain grade retries identical bytes after reload without duplicating review evidence', async () => {
    const session = `uncertain-grade-${++serial}`;
    const instance = await client(session);
    const { doc, first } = await page(instance, 'logos >> word, account');
    const card = (await api.sourceCards(first))[0]!;
    const eventId = ulid();
    const requests: string[] = [];
    let offline = false, acknowledged = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const grade = String(input) === `${baseUrl}/api/batches` && String(init?.body).includes(eventId);
      if (grade) requests.push(String(init!.body));
      if (offline) throw new TypeError('Offline after grading');
      const response = await actualFetch(input, init);
      if (grade) { offline = true; throw new TypeError('Grade committed without acknowledgement'); }
      return response;
    }) as typeof fetch;
    try {
      void instance.commit([{ op: 'grade_card', id: card.id, base_revision: card.revision, definition_revision: card.definition_revision, event_id: eventId, session_id: null, grade: 'hard', reset: false, shown_front: card.front, shown_back: card.back, reviewed_at: 25000 }]).then(() => { acknowledged = true; });
      await instance.flush();
      expect(acknowledged).toBe(false);
      expect(instance.commandState()).toBe('offline');
      await instance.dispose();
      const recovered = await client(session);
      expect(recovered.queuedChanges()).toBe(1);
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `${baseUrl}/api/batches` && String(init?.body).includes(eventId)) requests.push(String(init!.body));
        return actualFetch(input, init);
      }) as typeof fetch;
      recovered.retry();
      await recovered.flush();
      expect(new Set(requests).size).toBe(1);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect((await api.cardReviews(card.id)).map(event => event.id)).toEqual([eventId]);
      expect(recovered.commandState()).toBe('saved');
      expect(recovered.lastChange()?.cards).toContain(card.id);
      doc.release();
    } finally { globalThis.fetch = actualFetch; }
  });

  test('a rejected grade remains visible after a successful page edit and reload', async () => {
    const session = `grade-rejection-${++serial}`;
    const instance = await client(session);
    const { doc, first } = await page(instance, 'ša >> of');
    const card = (await api.sourceCards(first))[0]!;
    success(doc.edit({ kind: 'text', id: first, text: 'ša >> of, which' }));
    await doc.flush();
    const eventId = ulid();
    await expect(instance.commit([{ op: 'grade_card', id: card.id, base_revision: card.revision, definition_revision: card.definition_revision, event_id: eventId, session_id: null, grade: 'easy', reset: false, shown_front: card.front, shown_back: card.back, reviewed_at: 20000 }])).rejects.toThrow();
    expect(instance.commandState()).toBe('error');
    expect(instance.commandMessage()).toContain(eventId);
    success(doc.edit({ kind: 'text', id: first, text: 'ša >> of / which' }));
    await doc.flush();
    expect(instance.commandState()).toBe('error');
    expect(await api.cardReviews(card.id)).toHaveLength(0);
    await instance.dispose();
    const recovered = await client(session);
    expect(recovered.commandState()).toBe('error');
    expect(recovered.commandMessage()).toContain('of');
    expect(recovered.rejectedText()).toContain(eventId);
    recovered.dismissRejected();
  });

  test('make perspective undo and redo round trip through the API', async () => {
    const instance = await client();
    const holder = await instance.createPage(`Perspective holder ${++serial}`);
    const { doc, first, id } = await page(instance, `[[${holder}]]`);
    expect(doc.edit({ kind: 'position', id, value: true }).ok).toBe(false);
    success(doc.edit({ kind: 'position', id: first, value: true }));
    expect(doc.block(first)?.position).toEqual({ holder_id: null, subject_id: id });
    await doc.flush();
    expect(doc.block(first)?.position).toEqual({ holder_id: holder, subject_id: id });
    expect((await api.capabilities(first)).position).toEqual({ holder_id: holder, subject_id: id });
    expect((await api.positions({ holder, subject: id }))[0]?.block.block.id).toBe(first);
    doc.undo();
    await doc.flush();
    expect(doc.block(first)?.position).toBeNull();
    expect((await api.capabilities(first)).position).toBeNull();
    doc.redo();
    await doc.flush();
    expect(doc.block(first)?.position).toEqual({ holder_id: holder, subject_id: id });
    success(doc.edit({ kind: 'text', id: first, text: 'Unattributed' }));
    await doc.flush();
    expect(doc.block(first)?.position).toEqual({ holder_id: null, subject_id: id });
    expect(await api.positions({ holder })).toEqual([]);
    doc.release();
  });

  test('questions and answers accept, undo and redo with optimistic derived status', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'An enduring question');
    const value = { unsettled: false, parked: false, review_on: null, accepted: null };
    success(doc.edit({ kind: 'question', id: first, value }));
    expect(doc.block(first)?.question?.status).toBe('open');
    await doc.flush();
    doc.undo();
    expect(doc.block(first)?.question).toBeNull();
    await doc.flush();
    doc.redo();
    expect(doc.block(first)?.question?.status).toBe('open');
    await doc.flush();
    const answer = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Current reading' })).created[0]!;
    await doc.flush();
    success(doc.edit({ kind: 'assessment', id: answer, value: { assessed_on: instance.todayDate(), aporia: false } }));
    expect(doc.block(answer)?.assessment?.question_id).toBe(first);
    await doc.flush();
    doc.undo();
    expect(doc.block(answer)?.assessment).toBeNull();
    await doc.flush();
    doc.redo();
    expect(doc.block(answer)?.assessment?.question_id).toBe(first);
    await doc.flush();
    const staleAnswer = await api.capabilities(answer);
    success(doc.edit({ kind: 'question', id: first, value: { ...value, accepted: answer } }));
    (doc as Document).receiveCapabilities([staleAnswer]);
    expect(doc.block(first)?.question?.status).toBe('answered');
    expect(doc.block(answer)?.assessment?.accepted).toBe(true);
    await doc.flush();
    expect((await api.capabilities(answer)).assessment?.accepted).toBe(true);
    doc.undo();
    expect(doc.block(first)?.question?.status).toBe('open');
    expect(doc.block(answer)?.assessment?.accepted).toBe(false);
    await doc.flush();
    doc.redo();
    expect(doc.block(first)?.question?.status).toBe('answered');
    await doc.flush();
    success(doc.edit({ kind: 'question', id: first, value: { ...value, accepted: answer, unsettled: true } }));
    expect(doc.block(first)?.question?.status).toBe('unsettled');
    await doc.flush();
    success(doc.edit({ kind: 'archive', id: answer, archived: true }));
    expect(doc.block(answer)?.assessment?.accepted).toBe(false);
    await doc.flush();
    doc.undo();
    expect(doc.block(answer)?.assessment?.accepted).toBe(true);
    await doc.flush();
    const rows = await api.questions({ status: 'unsettled' });
    expect(rows.some(row => row.block.block.id === first && row.block.page.id === id)).toBe(true);
    for (const parked of [false, true]) for (const unsettled of [false, true]) for (const acceptedLive of [false, true]) {
      expect(questionStatus({ ...value, parked, unsettled }, acceptedLive)).toBe(parked ? 'parked' : unsettled ? 'unsettled' : acceptedLive ? 'answered' : 'open');
    }
  });

  test('assessment supersession, moving and deletion refresh the question optimistically', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Question');
    const question = { unsettled: false, parked: false, review_on: null, accepted: null };
    success(doc.edit({ kind: 'question', id: first, value: question }));
    const a = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'First answer' })).created[0]!;
    const b = success(doc.edit({ kind: 'insert', parentId: first, after: a, text: 'Second answer' })).created[0]!;
    await doc.flush();
    for (const answer of [a, b]) {
      success(doc.edit({ kind: 'assessment', id: answer, value: { assessed_on: instance.todayDate(), aporia: false } }));
      await doc.flush();
      success(doc.edit({ kind: 'question', id: first, value: { ...question, accepted: answer } }));
      await doc.flush();
    }
    expect(doc.block(a)?.assessment?.accepted).toBe(false);
    expect(doc.block(b)?.assessment?.accepted).toBe(true);
    success(doc.edit({ kind: 'outdent', ids: [b] }));
    expect(doc.block(first)?.question?.status).toBe('open');
    expect(doc.block(b)?.assessment?.question_id).toBeNull();
    await doc.flush();
    expect((await api.block(b)).parent_id).toBe(id);
    doc.undo();
    expect(doc.block(first)?.question?.status).toBe('answered');
    await doc.flush();
    success(doc.edit({ kind: 'delete', ids: [b] }));
    expect(doc.block(first)?.question?.status).toBe('open');
    await doc.flush();
    doc.undo();
    expect(doc.block(first)?.question?.status).toBe('answered');
    await doc.flush();
  });

  test('structural capability guards protect range endpoints, safe splits and reviewed inactive markup', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Destination');
    const source = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'front >> back' })).created[0]!;
    await doc.flush();
    expect(doc.edit({ kind: 'split', id: source, offset: 3 }).ok).toBe(false);
    expect(doc.edit({ kind: 'paste', at: { id: source, offset: 3 }, text: 'x\ny' }).ok).toBe(false);
    const project = { outcome: 'Read the corpus', deadline: '2026-12-01', status: 'active' as const };
    success(doc.edit({ kind: 'project', id: source, value: project }));
    success(doc.edit({ kind: 'task', id: source, value: todo }));
    await doc.flush();
    success(doc.edit({ kind: 'project', id: source, value: { ...project, status: 'done', outcome: 'Corpus translated' } }));
    await doc.flush();
    expect(doc.block(source)?.task?.status).toBe('todo');
    doc.undo();
    await doc.flush();
    expect(doc.block(source)?.project).toEqual(project);
    doc.redo();
    await doc.flush();
    expect(doc.block(source)?.project?.outcome).toBe('Corpus translated');
    doc.undo();
    await doc.flush();
    const bodies: Batch[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      const sibling = success(doc.edit({ kind: 'split', id: source, offset: 'front >> back'.length })).created[0]!;
      await doc.flush();
      expect(bodies.some(batch => batch.operations.some(operation => operation.op === 'split'))).toBe(true);
      expect(doc.block(source)?.task).toEqual(todo);
      expect(doc.block(source)?.project).toEqual(project);
      expect(doc.block(sibling)?.task).toBeNull();
      expect(doc.block(sibling)?.project).toBeNull();
      const range = { anchor: { id: first, offset: 2 }, head: { id: source, offset: 2 } };
      expect(doc.edit({ kind: 'deleteRange', range, between: [] }).ok).toBe(false);
      expect(doc.edit({ kind: 'replaceRange', range, between: [], text: 'x\ny', mode: 'paste' }).ok).toBe(false);
      success(doc.edit({ kind: 'delete', ids: [source] }));
      await doc.flush();
      doc.undo();
      await doc.flush();
      expect(doc.block(source)?.project).toEqual(project);
      const card = (await api.sourceCards(source))[0]!;
      const reviewer = await client();
      await eventually(() => instance.connection() === 'live', 'review sidecar stream not ready');
      const sourceRevision = doc.block(source)!.revision;
      await reviewer.commit([{ op: 'grade_card', id: card.id, base_revision: card.revision, definition_revision: card.definition_revision, event_id: ulid(), session_id: null, grade: 'good', reset: false, shown_front: card.front, shown_back: card.back, reviewed_at: 30000 }]);
      await eventually(() => doc.block(source)?.reviewedCards === true, 'review-only remote protection did not reach the source');
      expect(doc.block(source)?.revision).toBe(sourceRevision);
      success(doc.edit({ kind: 'text', id: source, text: 'Markup removed' }));
      success(doc.edit({ kind: 'task', id: source, value: null }));
      success(doc.edit({ kind: 'project', id: source, value: null }));
      await doc.flush();
      expect(doc.block(source)?.reviewedCards).toBe(true);
      expect(doc.edit({ kind: 'merge', sourceId: source, destinationId: first }).ok).toBe(false);
      success(doc.edit({ kind: 'merge', sourceId: sibling, destinationId: source }));
      await doc.flush();
      expect(bodies.some(batch => batch.operations.some(operation => operation.op === 'merge'))).toBe(true);
    } finally { globalThis.fetch = actualFetch; }
  });
});

async function sourcePage(instance: Notebook) {
  const title = `Evidence source ${++serial}`;
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(
    `<!doctype html><html><head><title>${title}</title><meta name="author" content="Ada Reader"><meta property="article:published_time" content="2024-06-01"></head><body><article><h1>${title}</h1><p>Frozen evidence stays attached to the passage. A reader can rewrite a highlight without changing what the source said, and return to the exact passage later.</p></article></body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  try {
    const job = await api.queueUrl(`http://127.0.0.1:${fixture.port}/source`);
    const deadline = Date.now() + 10000;
    let result = job;
    while (result.state !== 'done') {
      if (result.state === 'failed' || Date.now() > deadline) throw new Error(result.error ?? 'Source ingestion timed out');
      // The worker runs in the real service process; fake JS timers cannot advance it.
      await Bun.sleep(20);
      result = (await api.ingestJobs()).find(item => item.id === job.id)!;
    }
    const id = result.source_id!;
    const doc = instance.open(id);
    await eventually(() => doc.status() === 'ready', 'Source document did not load');
    await doc.flush();
    const snapshotId = (await api.source(id)).source.current_snapshot_id!;
    const passage = (await api.passages(snapshotId, 0)).passages.find(item => item.kind === 'paragraph')!;
    const citation: NewCitation = { id: ulid(), sourceId: id, snapshotId, start: { passage_id: passage.id, offset: 0 },
      end: { passage_id: passage.id, offset: passage.text.length }, quote: passage.text, locator: passage.locator, ordinal: passage.ordinal };
    return { id, doc, citation };
  } finally { fixture.stop(true); }
}

describe('source and citation document commands', () => {
  test('source details write existing fields in one undo step and fill only missing values', async () => {
    const instance = await client();
    const { id, doc } = await sourcePage(instance);
    // Bun uses Solid's server build, whose effects do not run. Load the shared Fields
    // document before calling the UI adapter; the edits still use the real service.
    const fieldsDoc = instance.open((await api.fields()).page_id);
    await eventually(() => fieldsDoc.status() === 'ready', 'Fields document did not load');
    const before = sourceMetadata(doc, instance, (await api.fields()).fields);
    const changed = { ...before, title: `${before.title} edited`, publisher: 'Authored press', language: 'fr', creators: [{ name: 'Changed Writer', role: 'author' as const }, { name: 'New Editor', role: 'editor' as const }] };
    await saveDetails(doc, instance, changed);
    expect(sourceMetadata(doc, instance, (await api.fields()).fields)).toMatchObject(changed);
    doc.undo(); await doc.flush();
    expect(sourceMetadata(doc, instance, (await api.fields()).fields)).toEqual(before);
    doc.redo(); await doc.flush();
    expect(sourceMetadata(doc, instance, (await api.fields()).fields)).toMatchObject(changed);
    const cover = `/api/library/covers/${'a'.repeat(64)}`;
    expect(await saveDetails(doc, instance, { ...changed, publisher: 'Fetched publisher', language: 'en', subtitle: 'Missing subtitle', cover }, true)).toBe(2);
    const filled = sourceMetadata(doc, instance, (await api.fields()).fields);
    expect(filled.publisher).toBe('Authored press');
    expect(filled.language).toBe('fr');
    expect(filled.subtitle).toBe('Missing subtitle');
    expect(filled.cover).toBe(cover);
    expect(await saveDetails(doc, instance, { ...filled, cover: `/api/library/covers/${'b'.repeat(64)}` }, true)).toBe(0);
    expect(sourceMetadata(doc, instance, (await api.fields()).fields).cover).toBe(cover);
    expect((await api.library({ text: changed.title })).rows.find(row => row.page.id === id)?.creators).toEqual(['Changed Writer']);
    fieldsDoc.release();
  });

  test('source reading order preserves notes and global counts include citations filed elsewhere', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const later = success(doc.edit({ kind: 'highlight', parentId: id, text: 'Later', citation: { ...citation, id: ulid(), start: { ...citation.start, offset: 10 } } })).created[0]!;
    const note = success(doc.edit({ kind: 'insert', parentId: later, after: null, text: 'A note under the later highlight' })).created[0]!;
    const earlier = success(doc.edit({ kind: 'highlight', parentId: id, text: 'Earlier', citation })).created[0]!;
    await doc.flush();
    const definitions = new Map((await api.fields()).fields.map(field => [field.id, field]));
    const order = sourceReadingOrder(doc, ids(doc), definitions);
    expect(order.indexOf(earlier)).toBeLessThan(order.indexOf(later));
    expect(order[order.indexOf(later) + 1]).toBe(note);
    const elsewhere = await page(instance);
    success(elsewhere.doc.edit({ kind: 'highlight', parentId: elsewhere.id, text: 'Filed elsewhere', citation: { ...citation, id: ulid() } }));
    await elsewhere.doc.flush();
    expect((await api.highlights({ source_id: id })).total).toBe(3);
    expect((await api.library({ text: doc.root()!.text })).rows[0]?.highlights).toBe(3);
  });

  test('source creation, removal and state changes invert, reconcile and reach remote documents', async () => {
    const instance = await client();
    const { id, doc } = await page(instance);
    const value: SourceState = { format: 'article', state: 'inbox', origin: 'https://example.test/evidence', match_key: null, citation_key: `evidence${++serial}` };
    success(doc.edit({ kind: 'source', id, value }));
    expect(doc.root()?.source).toMatchObject(value);
    expect(instance.commands(id).at(-1)?.inverse).toMatchObject([{ kind: 'source', id, value: null, previous: value }]);
    await doc.flush();
    expect(doc.root()?.source).toEqual((await api.source(id)).source);
    doc.undo();
    expect(doc.root()?.source).toBeNull();
    await doc.flush();
    doc.redo();
    await doc.flush();
    expect(doc.root()?.source).toMatchObject(value);
    const remote = await client();
    const shared = remote.open(id);
    await eventually(() => shared.status() === 'ready' && remote.connection() === 'live', 'Source observer not ready');
    success(doc.edit({ kind: 'source', id, value: { ...value, state: 'finished' } }));
    expect(doc.root()?.source?.state).toBe('finished');
    await doc.flush();
    await eventually(() => shared.root()?.source?.state === 'finished', 'Source sidecar did not arrive');
    doc.undo();
    await doc.flush();
    expect(doc.root()?.source?.state).toBe('inbox');
    doc.redo();
    await doc.flush();
    expect(doc.root()?.source?.state).toBe('finished');
  });

  test('cite preserves optimistic evidence, reconciles frozen quotes and round trips through uncite', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const blockId = success(doc.edit({ kind: 'insert', parentId: id, after: null, text: 'A paraphrase' })).created[0]!;
    await doc.flush();
    success(doc.edit({ kind: 'cite', id: blockId, citation: { ...citation, quote: 'Optimistic quote' } }));
    expect(doc.block(blockId)?.citations[0]).toMatchObject({ id: citation.id, block_id: blockId, source_id: id, snapshot_id: citation.snapshotId, start: citation.start, end: citation.end, quote: 'Optimistic quote', locator: citation.locator });
    expect(instance.commands(id).at(-1)?.inverse).toMatchObject([{ kind: 'uncite', id: blockId, citationId: citation.id }]);
    await doc.flush();
    expect(doc.block(blockId)?.citations[0]?.quote).toBe(citation.quote);
    doc.undo();
    expect(doc.block(blockId)?.citations).toEqual([]);
    await doc.flush();
    doc.redo();
    await doc.flush();
    expect(doc.block(blockId)?.citations).toEqual((await api.capabilities(blockId)).citations);
    expect(doc.block(blockId)?.citations[0]?.id).toBe(citation.id);
    const remote = await client();
    const shared = remote.open(id);
    await eventually(() => shared.status() === 'ready' && remote.connection() === 'live', 'Citation observer not ready');
    success(doc.edit({ kind: 'uncite', id: blockId, citationIds: [citation.id] }));
    expect(doc.block(blockId)?.citations).toEqual([]);
    expect(instance.commands(id).at(-1)?.inverse).toMatchObject([{ kind: 'cite', id: blockId, citation: { id: citation.id, start: citation.start, end: citation.end, quote: citation.quote } }]);
    await doc.flush();
    await eventually(() => shared.block(blockId)?.citations.length === 0, 'Uncite sidecar did not arrive');
    doc.undo();
    expect(doc.block(blockId)?.citations[0]?.quote).toBe(citation.quote);
    await doc.flush();
    doc.redo();
    await doc.flush();
    expect(doc.block(blockId)?.citations).toEqual([]);
  });

  test('citation triage reconciles remotely, undoes to null, redoes and survives highlight deletion', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const blockId = success(doc.edit({ kind: 'highlight', parentId: id, text: citation.quote, citation })).created[0]!;
    await doc.flush();
    const remote = await client(), shared = remote.open(id);
    await eventually(() => shared.status() === 'ready' && remote.connection() === 'live', 'Triage observer not ready');
    success(doc.edit({ kind: 'citationTriage', id: blockId, citationId: citation.id, triage: 'processed' }));
    expect(doc.block(blockId)?.citations[0]?.triage).toBe('processed');
    expect(instance.commands(id).at(-1)?.inverse).toMatchObject([{ kind: 'citationTriage', id: blockId, citationId: citation.id, triage: null, previous: 'processed' }]);
    await doc.flush();
    await eventually(() => shared.block(blockId)?.citations[0]?.triage === 'processed', 'Remote triage did not arrive');
    expect((await api.highlights({ source_id: id, unprocessed: true })).rows).toHaveLength(0);
    doc.undo();
    expect(doc.block(blockId)?.citations[0]?.triage).toBeNull();
    await doc.flush();
    expect((await api.highlights({ source_id: id, unprocessed: true })).rows).toHaveLength(1);
    doc.redo();
    await doc.flush();
    success(doc.edit({ kind: 'insert', parentId: blockId, after: null, text: 'A note' }));
    await doc.flush();
    success(doc.edit({ kind: 'citationTriage', id: blockId, citationId: citation.id, triage: 'unprocessed' }));
    await doc.flush();
    expect((await api.highlights({ source_id: id, unprocessed: true })).rows[0]?.triage).toBe('unprocessed');
    success(doc.edit({ kind: 'delete', ids: [blockId] }));
    await doc.flush();
    expect((await api.highlights({ source_id: id })).rows).toHaveLength(0);
    doc.undo();
    await doc.flush();
    expect(doc.block(blockId)?.citations[0]?.triage).toBe('unprocessed');
    expect((await api.highlights({ source_id: id, unprocessed: true })).rows).toHaveLength(1);
    shared.release();
  });

  test('highlight colours reconcile remotely, undo, redo, clear and survive text and uncite edits', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const blockId = success(doc.edit({ kind: 'highlight', parentId: id, text: citation.quote, citation, color: 'green' })).created[0]!;
    expect(doc.block(blockId)?.citations[0]?.color).toBe('green');
    await doc.flush();
    const remote = await client(), shared = remote.open(id);
    await eventually(() => shared.status() === 'ready' && remote.connection() === 'live', 'Colour observer not ready');
    success(doc.edit({ kind: 'highlightColor', id: blockId, citationId: citation.id, color: 'blue' }));
    expect(instance.commands(id).at(-1)?.inverse).toMatchObject([{ kind: 'highlightColor', id: blockId, citationId: citation.id, color: 'green', previous: 'blue' }]);
    await doc.flush();
    await eventually(() => shared.block(blockId)?.citations[0]?.color === 'blue', 'Remote colour did not arrive');
    doc.undo();
    expect(doc.block(blockId)?.citations[0]?.color).toBe('green');
    await doc.flush();
    expect((await api.highlights({ source_id: id, colors: ['green'] })).total).toBe(1);
    doc.redo();
    await doc.flush();
    success(doc.edit({ kind: 'highlightColor', id: blockId, citationId: citation.id, color: null }));
    await doc.flush();
    expect(doc.block(blockId)?.citations[0]?.color).toBeNull();
    doc.undo();
    await doc.flush();
    expect(doc.block(blockId)?.citations[0]?.color).toBe('blue');
    success(doc.edit({ kind: 'text', id: blockId, text: `${citation.quote} #key` }));
    await doc.flush();
    const tagged = (await api.highlights({ source_id: id, colors: ['blue'], tags: ['key'] })).rows[0]!;
    expect(tagged.tags).toEqual(['key']);
    expect(tagged.color).toBe('blue');
    expect(tagged.citation.quote).toBe(citation.quote);
    success(doc.edit({ kind: 'uncite', id: blockId, citationIds: [citation.id] }));
    await doc.flush();
    doc.undo();
    await doc.flush();
    expect((await api.capabilities(blockId)).citations?.[0]?.color).toBe('blue');
    shared.release();
  });

  test('multiple citations are removed and restored in one undo step in creation order', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const blockId = success(doc.edit({ kind: 'highlight', parentId: id, text: citation.quote, citation })).created[0]!;
    const second = { ...citation, id: ulid() };
    success(doc.edit({ kind: 'cite', id: blockId, citation: second }));
    await doc.flush();
    success(doc.edit({ kind: 'uncite', id: blockId, citationIds: [citation.id, second.id] }));
    expect(doc.block(blockId)?.citations).toEqual([]);
    await doc.flush();
    doc.undo();
    expect(doc.block(blockId)?.citations.map(item => item.id)).toEqual([citation.id, second.id]);
    await doc.flush();
    expect(doc.block(blockId)?.citations.map(item => item.id)).toEqual([citation.id, second.id]);
    doc.redo();
    await doc.flush();
    expect(doc.block(blockId)?.citations).toEqual([]);
  });

  test('merging evidence preserves survivor state, moves notes, and undoes the whole union', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const make = (start: number, end: number, color: 'green' | null = null) => success(doc.edit({
      kind: 'highlight', parentId: id, text: citation.quote.slice(start, end), color,
      citation: { ...citation, id: ulid(), start: { ...citation.start, offset: start }, end: { ...citation.end, offset: end }, quote: citation.quote.slice(start, end) },
    })).created[0]!;
    const first = make(0, 20, 'green'), second = make(10, 40);
    const ownNote = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Keep this note' })).created[0]!;
    const moved = success(doc.edit({ kind: 'insert', parentId: second, after: null, text: 'Move this note' })).created[0]!;
    await doc.flush();
    const prior = doc.block(first)!.citations[0]!;
    success(doc.edit({ kind: 'citationTriage', id: first, citationId: prior.id, triage: 'processed' }));
    await doc.flush();
    const before = doc.block(first)!.citations[0]!;
    success(doc.edit({ kind: 'mergeHighlights', merges: [{ citation: { ...before, end: { ...before.end, offset: 40 }, quote: citation.quote.slice(0, 40) }, removeIds: [second] }] }));
    await doc.flush();
    expect(doc.block(second)).toBeUndefined();
    expect(doc.outline.children(first)).toEqual([ownNote, moved]);
    expect(doc.block(first)!.citations[0]).toMatchObject({ id: prior.id, color: 'green', triage: 'processed', end: { offset: 40 } });
    doc.undo();
    await doc.flush();
    expect(doc.block(first)!.citations[0]).toEqual(before);
    expect(doc.outline.children(first)).toEqual([ownNote]);
    expect(doc.outline.children(second)).toEqual([moved]);
    doc.redo();
    await doc.flush();
    expect(doc.block(second)).toBeUndefined();
    expect((await api.capabilities(first)).citations![0]!.end.offset).toBe(40);
    doc.release();
  });

  test('highlight inserts then cites in one command at the root or requested sibling and undoes by deletion', async () => {
    const instance = await client();
    const { id, doc, citation } = await sourcePage(instance);
    const before = [...doc.outline.children(id)];
    const result = success(doc.edit({ kind: 'highlight', parentId: id, text: citation.quote, citation }));
    const blockId = result.created[0]!;
    expect(result.created).toHaveLength(1);
    expect(doc.outline.children(id)).toEqual([...before, blockId]);
    expect(doc.block(blockId)?.citations[0]?.id).toBe(citation.id);
    const command = instance.commands(id).at(-1)!;
    expect(command.actions.map(action => action.kind)).toEqual(['insert', 'cite']);
    expect(command.inverse).toEqual([{ kind: 'delete', id: blockId }]);
    await doc.flush();
    expect(JSON.parse(command.frozen!).operations.map((operation: Operation) => operation.op)).toEqual(['insert', 'cite']);
    expect(doc.block(blockId)?.citations).toEqual((await api.capabilities(blockId)).citations);
    doc.undo();
    expect(doc.block(blockId)).toBeUndefined();
    await doc.flush();
    doc.redo();
    expect(doc.block(blockId)?.citations[0]?.id).toBe(citation.id);
    await doc.flush();
    expect(doc.block(blockId)?.citations).toHaveLength(1);
    const nested = success(doc.edit({ kind: 'highlight', parentId: blockId, after: null, text: citation.quote, citation: { ...citation, id: ulid() } })).created[0]!;
    const sibling = success(doc.edit({ kind: 'highlight', parentId: blockId, after: nested, text: citation.quote, citation: { ...citation, id: ulid() } })).created[0]!;
    expect(doc.outline.children(blockId)).toEqual([nested, sibling]);
    await doc.flush();
  });

  test('offline recovery retains source and citation sidecars and replays insert before cite', async () => {
    const session = `offline-source-${++serial}`;
    const instance = await client(session);
    const { id, doc, citation } = await sourcePage(instance);
    const existing = success(doc.edit({ kind: 'highlight', parentId: id, text: citation.quote, citation })).created[0]!;
    await doc.flush();
    let offline = true;
    const bodies: Batch[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      if (offline) throw new TypeError('Offline for source recovery');
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      const nextCitation = { ...citation, id: ulid() };
      const blockId = success(doc.edit({ kind: 'highlight', parentId: id, text: nextCitation.quote, citation: nextCitation })).created[0]!;
      success(doc.edit({ kind: 'source', id, value: { ...doc.root()!.source!, state: 'reading' } }));
      await instance.flush();
      await instance.dispose();
      const recovered = await client(session);
      const reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'Source cache did not recover');
      expect(reopened.root()?.source?.state).toBe('reading');
      expect(reopened.root()?.source?.current_snapshot_id).toBe(citation.snapshotId);
      expect(reopened.block(existing)?.citations[0]?.id).toBe(citation.id);
      expect(reopened.block(blockId)?.citations[0]?.id).toBe(nextCitation.id);
      offline = false;
      recovered.retry();
      await recovered.flush();
      expect(reopened.saveState()).toBe('saved');
      expect(reopened.block(blockId)?.citations).toEqual((await api.capabilities(blockId)).citations);
      const sent = bodies.filter(body => body.operations.some(op => op.op === 'cite' && op.citation_id === nextCitation.id));
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every(body => body.operations.map(op => op.op).join(',') === 'insert,cite')).toBe(true);
      expect(new Set(sent.map(body => JSON.stringify(body))).size).toBe(1);
      expect((await api.source(id)).source.state).toBe('reading');
    } finally { globalThis.fetch = actualFetch; }
  });
});
