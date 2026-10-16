import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import type { Operation } from '../api/types';
import type { Edit, PageDocument } from './contract';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { outlineDrop } from '../outline/drag';
import { selectionRoots } from '../outline/visibility';

const port = Bun.env.TESSERA_STRUCTURE_TEST_PORT ?? '4350';
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
const clients: Notebook[] = [];
let process: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebookId: string;
// Real service startup and document loading cannot be driven by fake timers.
const eventually = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await Bun.sleep(10); }
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-outline-structure-tests-'));
  const root = resolve(import.meta.dir, '../../..');
  process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', port, '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const deadline = Date.now() + 5000;
  const expectedPath = await realpath(directory);
  while (true) {
    try {
      const info = await api.notebook();
      if (await realpath(info.path) !== expectedPath) throw new Error('The test port belongs to another notebook.');
      notebookId = info.id;
      break;
    } catch { if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(process.stderr).text()}`); await Bun.sleep(20); }
  }
});
afterAll(async () => {
  for (const instance of clients) await instance.dispose();
  process?.kill();
  if (process) await process.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const instance = createNotebookClient({ baseUrl, sessionId: ulid(), notebookId, databaseName: 'tessera-outline-structure-tests' });
  clients.push(instance);
  await instance.ready;
  const blocks = [['A', 'page'], ['A1', 'A'], ['A2', 'A'], ['A2a', 'A2'], ['A3', 'A'], ['B', 'page'], ['B1', 'B'], ['C', 'page'], ['D', 'page']];
  const ids: Record<string, string> = { page: ulid() };
  for (const [name] of blocks) ids[name!] = ulid();
  const operations: Operation[] = [{ op: 'create_page', id: ids.page!, title: `Structure ${ids.page}` }];
  const previous: Record<string, string> = {};
  for (const [name, parent] of blocks) {
    const id = ids[name!]!;
    operations.push({ op: 'insert', id, parent_id: ids[parent!]!, after: previous[parent!] ?? null, text: name!, heading: null });
    previous[parent!] = id;
  }
  await api.submit({ actor: { kind: 'person' }, operations });
  const doc = instance.open(ids.page!);
  await eventually(() => doc.status() === 'ready', 'Structure page did not open.');
  return { doc, instance, ids };
}
const tree = (doc: PageDocument) => Array.from({ length: doc.outline.size() }, (_, index) => {
  const id = doc.outline.idAt(index);
  return { id, parentId: doc.outline.parentOf(id), depth: doc.outline.depth(id) };
});

describe('outline structural boundaries', () => {
  test.each([
    { kind: 'indent', ids: ['A1'] },
    { kind: 'indent', ids: ['A1', 'A2', 'A2a'] },
    { kind: 'outdent', ids: ['B'] },
    { kind: 'move', ids: ['A1'], direction: 'up' },
    { kind: 'move', ids: ['A3'], direction: 'down' },
  ] satisfies Edit[])('boundary $kind is a silent no-op without history', async edit => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    expect(doc.edit({ ...edit, ids: edit.ids.map(id => ids[id]!) }).ok).toBe(true);
    expect(tree(doc)).toEqual(before);
    expect(instance.queuedChanges()).toBe(0);
    expect(doc.canUndo()).toBe(false);
  });

  test.each([
    { kind: 'indent', ids: ['B'], zoomRoot: 'B' },
    { kind: 'outdent', ids: ['B'], zoomRoot: 'B' },
    { kind: 'move', ids: ['B'], direction: 'up', zoomRoot: 'B' },
    { kind: 'move', ids: ['B'], direction: 'down', zoomRoot: 'B' },
    { kind: 'outdent', ids: ['A1', 'A2', 'A2a'], zoomRoot: 'A' },
    { kind: 'indent', ids: ['C'], zoomRoot: 'A' },
  ] satisfies Edit[])('zoom bounds $kind without changing hidden structure', async edit => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    expect(doc.edit({ ...edit, ids: edit.ids.map(id => ids[id]!), zoomRoot: ids[edit.zoomRoot]! }).ok).toBe(true);
    expect(tree(doc)).toEqual(before);
    expect(instance.queuedChanges()).toBe(0);
    expect(doc.canUndo()).toBe(false);
  });

  test('zoomed nested outdent keeps following siblings and round-trips exact structure', async () => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    expect(doc.edit({ kind: 'outdent', ids: [ids.A2a!], zoomRoot: ids.A! }).ok).toBe(true);
    expect(doc.outline.children(ids.A!)).toEqual([ids.A1!, ids.A2!, ids.A2a!, ids.A3!]);
    const after = tree(doc);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(after);
    doc.undo();
    expect(tree(doc)).toEqual(before);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(before);
    doc.redo();
    expect(tree(doc)).toEqual(after);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(after);
  });

  test('mixed-depth outdent lifts each selected root from its own parent', async () => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    expect(doc.edit({ kind: 'outdent', ids: [ids.A2a!, ids.A3!] }).ok).toBe(true);
    expect(doc.outline.parentOf(ids.A2a!)).toBe(ids.A!);
    expect(doc.outline.parentOf(ids.A3!)).toBe(ids.page!);
    const after = tree(doc);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(after);
    doc.undo();
    await instance.flush();
    expect(tree(doc)).toEqual(before);
    doc.redo();
    await instance.flush();
    expect(tree(doc)).toEqual(after);
  });

  test('mixed-parent move is a no-op without a failed command or history', async () => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    for (const direction of ['up', 'down'] as const) expect(doc.edit({ kind: 'move', ids: [ids.A2a!, ids.A3!], direction }).ok).toBe(true);
    expect(tree(doc)).toEqual(before);
    expect(instance.queuedChanges()).toBe(0);
    expect(doc.canUndo()).toBe(false);
  });

  test('a child drop moves selected roots with their subtrees in one undo step', async () => {
    const { doc, instance, ids } = await fixture();
    const before = tree(doc);
    const moved = selectionRoots(doc, [ids.B!, ids.B1!, ids.C!]);
    const destination = outlineDrop(doc.outline, ids.page!, moved, ids.A!, 1, false);
    expect(destination).toMatchObject({ parentId: ids.A!, after: null, depth: 1, edge: 'child' });
    if (!destination) throw new Error('The child drop was rejected.');
    expect(doc.edit({ kind: 'moveTo', ids: moved, parentId: destination.parentId, after: destination.after }).ok).toBe(true);
    expect(doc.outline.children(ids.A!)).toEqual([ids.B!, ids.C!, ids.A1!, ids.A2!, ids.A3!]);
    expect(doc.outline.children(ids.B!)).toEqual([ids.B1!]);
    expect(doc.block(ids.B!)?.text).toBe('B');
    expect(doc.block(ids.B1!)?.text).toBe('B1');
    const after = tree(doc);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(after);
    doc.undo();
    expect(tree(doc)).toEqual(before);
    expect(doc.canUndo()).toBe(false);
    await instance.flush();
    expect((await api.page(ids.page!)).rows.map(row => ({ id: row.block.id, parentId: row.block.parent_id, depth: row.depth }))).toEqual(before);
    doc.redo();
    expect(tree(doc)).toEqual(after);
  });

  test('drop targets reject moved descendants and stay within the zoom boundary', async () => {
    const { doc, ids } = await fixture();
    const before = tree(doc);
    expect(outlineDrop(doc.outline, ids.page!, [ids.A!], ids.A!, 0, true)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.A!], ids.A2a!, 2, false)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.A2!], ids.A2a!, 1, true)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.A2a!], ids.B!, 0, false, ids.A!)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.B!], ids.A1!, 1, true, ids.A!)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.A!], ids.A1!, 1, false, ids.A!)).toBeNull();
    expect(outlineDrop(doc.outline, ids.page!, [ids.A2a!], ids.A3!, 0, false, ids.A!))
      .toMatchObject({ parentId: ids.A!, after: ids.A3!, depth: 1, edge: 'after' });
    expect(outlineDrop(doc.outline, ids.page!, [ids.C!], ids.B!, 0, true))
      .toMatchObject({ parentId: ids.page!, after: ids.A!, depth: 0, edge: 'before' });
    expect(tree(doc)).toEqual(before);
    expect(doc.canUndo()).toBe(false);
  });
});
