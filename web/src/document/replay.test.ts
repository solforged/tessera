import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { openDB } from 'idb';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { Outbox } from './outbox';

const port = Bun.env.TESSERA_REPLAY_TEST_PORT ?? '4541';
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
const actualFetch = globalThis.fetch;
const clients: Notebook[] = [];
const pageId = ulid(), blockId = ulid();
let service: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebookId: string;

// These cross real service and WebSocket boundaries; bounded condition polling is not a debounce assertion.
async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}
function client(databaseName = `replay-${ulid()}`) {
  const instance = createNotebookClient({ baseUrl, notebookId, databaseName, sessionId: databaseName });
  clients.push(instance);
  return instance;
}
async function edit(text: string) {
  return api.submit({ actor: { kind: 'agent', name: 'replay regression' }, operations: [
    { op: 'edit_text', id: blockId, base_revision: (await api.block(blockId)).revision, text },
  ] });
}
function recordHistory() {
  const after: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/changes') after.push(Number(url.searchParams.get('after')));
    return actualFetch(input, init);
  }) as typeof fetch;
  return after;
}
async function cachePage(database: string) {
  const instance = client(database);
  await instance.ready;
  const doc = instance.open(pageId);
  await eventually(() => doc.status() === 'ready' && instance.connection() === 'live', 'initial page did not load');
  await instance.dispose();
  const outbox = new Outbox(notebookId, database, error => { throw error; }, database);
  try {
    const cached = (await outbox.cachedPage(pageId))!;
    expect(cached.cursor).toBeGreaterThan(0);
    return cached;
  } finally { await outbox.close(); }
}
async function offlineRestore(database: string) {
  globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Offline restart'); }, { preconnect: actualFetch.preconnect });
  const instance = client(database);
  await instance.ready;
  const doc = instance.open(pageId);
  await eventually(() => doc.status() === 'ready', 'cached page did not restore');
  return { instance, doc };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-replay-tests-'));
  const root = resolve(import.meta.dir, '../../..');
  service = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', port], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const expectedPath = await realpath(directory);
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const info = await api.notebook();
      if (await realpath(info.path) !== expectedPath) throw new Error('Test port belongs to another notebook');
      notebookId = info.id;
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(service.stderr).text()}`);
      await Bun.sleep(20);
    }
  }
  await api.submit({ actor: { kind: 'person' }, operations: [
    { op: 'create_page', id: pageId, title: 'Replay regression' },
    { op: 'insert', id: blockId, parent_id: pageId, after: null, text: 'Original', heading: null },
  ] });
  for (let index = 0; index < 520; index++) await edit(`Prior event ${index}`);
}, 20000);

afterEach(async () => {
  globalThis.fetch = actualFetch;
  for (const instance of clients.splice(0)) await instance.dispose();
});
afterAll(async () => {
  service?.kill();
  if (service) await service.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('a fresh window starts at the editor head and receives edits after its snapshot', async () => {
  const head = await api.changeHead();
  expect(head).toBeGreaterThan(500);
  const history: number[] = [], streams: number[] = [];
  const gate = Promise.withResolvers<void>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/changes') {
      history.push(Number(url.searchParams.get('after')));
      await gate.promise;
    }
    return actualFetch(input, init);
  }) as typeof fetch;
  const instance = client();
  const stream = instance.api.stream;
  instance.api.stream = after => { streams.push(after); return stream(after); };
  try {
    await instance.ready;
    const doc = instance.open(pageId);
    await eventually(() => doc.status() === 'ready', 'fresh snapshot did not load');
    const committed = await edit('After the snapshot, before catch-up');
    gate.resolve();
    await eventually(() => instance.connection() === 'live' && doc.block(blockId)?.text === 'After the snapshot, before catch-up', 'snapshot race edit did not arrive');
    expect(history).toEqual([head]);
    expect(streams).toEqual([committed.seq]);
    await edit('After subscribing');
    await eventually(() => doc.block(blockId)?.text === 'After subscribing', 'live edit did not arrive');
    expect(doc.block(blockId)?.conflict).toBeNull();
  } finally { gate.resolve(); }
});

test('an offline restart resumes the cursor stored atomically with its cached page', async () => {
  const database = `replay-cache-${ulid()}`;
  const cached = await cachePage(database);
  await edit('Written while the window was closed');
  const { instance, doc } = await offlineRestore(database);
  expect(doc.block(blockId)?.text).toBe(cached.view.rows[0]!.block.text);
  const history = recordHistory();
  instance.retry();
  await eventually(() => instance.connection() === 'live' && doc.block(blockId)?.text === 'Written while the window was closed', 'cached restart missed the closed-window edit');
  expect(history).toEqual([cached.cursor!]);
  expect(doc.block(blockId)?.conflict).toBeNull();
});

test('an offline restart restores pending text and structure and reconnects without another reload', async () => {
  const database = `replay-drafts-${ulid()}`, online = client(database);
  await online.ready;
  const id = await online.createPage(`Offline drafts ${ulid()}`);
  const original = online.open(id);
  await eventually(() => original.status() === 'ready', 'online page did not load');
  const first = original.outline.idAt(0);
  expect(original.edit({ kind: 'text', id: first, text: 'Base' }).ok).toBe(true);
  await online.flush();
  globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Offline drafts'); }, { preconnect: actualFetch.preconnect });
  expect(original.edit({ kind: 'text', id: first, text: 'Base pending' }).ok).toBe(true);
  const split = original.edit({ kind: 'split', id: first, offset: 'Base pending'.length });
  if (!split.ok) throw new Error(split.reason);
  const child = split.created[0]!;
  expect(original.edit({ kind: 'text', id: child, text: 'Child pending' }).ok).toBe(true);
  expect(original.edit({ kind: 'indent', ids: [child] }).ok).toBe(true);
  await online.flush();
  await online.dispose();
  const recovered = client(database);
  await recovered.ready;
  const restored = recovered.open(id);
  await eventually(() => restored.status() === 'ready', 'offline drafts did not hydrate');
  expect(restored.block(first)?.text).toBe('Base pending');
  expect(restored.block(child)?.text).toBe('Child pending');
  expect(restored.outline.parentOf(child)).toBe(first);
  expect(restored.outline.depth(child)).toBe(1);
  expect(restored.edit({ kind: 'text', id: child, text: 'Edited after offline reload' }).ok).toBe(true);
  await recovered.flush();
  globalThis.fetch = actualFetch;
  await eventually(() => recovered.connection() === 'live' && recovered.saveState() === 'saved', 'reconnected drafts did not save');
  expect((await api.page(id)).rows.map(row => [row.block.id, row.block.text, row.depth])).toEqual([
    [first, 'Base pending', 0], [child, 'Edited after offline reload', 1],
  ]);
  expect(restored.status()).toBe('ready');
  expect(recovered.queuedChanges()).toBe(0);
});

for (const kind of ['ahead', 'unknown', 'large gap'] as const) {
  test(`a ${kind} cache cursor reloads snapshots and never replays from zero`, async () => {
    const database = `replay-reset-${ulid()}`;
    await cachePage(database);
    const head = await api.changeHead();
    const db = await openDB(database);
    const key = `${notebookId}:${pageId}`;
    const record = await db.get('pages', key);
    record.cursor = kind === 'ahead' ? head + 1000 : kind === 'unknown' ? undefined : head - 501;
    await db.put('pages', record);
    db.close();
    await edit(`Fresh snapshot for ${kind}`);
    const currentHead = await api.changeHead();
    const { instance, doc } = await offlineRestore(database);
    const history = recordHistory();
    let pageReads = 0;
    const readPage = instance.api.page;
    instance.api.page = (id, signal) => { pageReads++; return readPage(id, signal); };
    instance.retry();
    await eventually(() => instance.connection() === 'live' && doc.block(blockId)?.text === `Fresh snapshot for ${kind}`, 'invalid cursor did not reload');
    expect(pageReads).toBeGreaterThan(0);
    expect(history).toEqual([currentHead]);
    expect(history).not.toContain(0);
    await edit(`Still live after ${kind}`);
    await eventually(() => doc.block(blockId)?.text === `Still live after ${kind}`, 'reset recovery lost the live stream');
  });
}

test('a text event during initial hydration retries the held snapshot', async () => {
  const instance = client();
  await instance.ready;
  await eventually(() => instance.connection() === 'live', 'stream did not open');
  const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await actualFetch(input, init);
    if (!held && new URL(String(input)).pathname === `/api/pages/${pageId}`) {
      held = true;
      fetched.resolve();
      await release.promise;
    }
    return response;
  }) as typeof fetch;
  try {
    const doc = instance.open(pageId);
    await fetched.promise;
    const committed = await edit('Arrived during hydration');
    await eventually(() => instance.changeSequence() >= committed.seq, 'held-snapshot event did not arrive');
    release.resolve();
    await eventually(() => doc.status() === 'ready' && doc.block(blockId)?.text === 'Arrived during hydration', 'hydration discarded a concurrent event');
  } finally { release.resolve(); }
});
