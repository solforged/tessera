import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import type { EditResult, PageDocument } from './contract';
import { boundaryDeletion } from './outline-mechanics';
import { editingDepth, inlineFieldValues, selectionIds, selectionRoots, survivingZoomPath, visibleIds } from '../outline/visibility';
import { newTask } from '../tasks/quick-date';
import { markdownPasteRows } from './clipboard';

const port = Bun.env.TESSERA_MECHANICS_TEST_PORT ?? '43862';
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
const clients: Notebook[] = [];
let service: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebookId: string;
let serial = 0;
// Real service startup and document hydration cross process/stream boundaries;
// bounded condition polling is not a debounce or timer-behavior assertion.
const success = (result: EditResult) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Document did not become ready'); await Bun.sleep(10); }
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-outline-mechanics-'));
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
    } catch { if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(service.stderr).text()}`); await Bun.sleep(20); }
  }
});
afterAll(async () => {
  for (const client of clients) await client.dispose();
  service?.kill();
  if (service) await service.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(text = 'Alpha') {
  const client = createNotebookClient({ baseUrl, notebookId, sessionId: `mechanics-${++serial}`, databaseName: 'tessera-outline-mechanics-tests' });
  clients.push(client);
  await client.ready;
  const pageId = await client.createPage(`Mechanics ${serial}`);
  const doc = client.open(pageId);
  await eventually(() => doc.status() === 'ready');
  const first = doc.outline.idAt(0);
  success(doc.edit({ kind: 'text', id: first, text }));
  await client.flush();
  return { client, doc, first, pageId };
}
const insert = (doc: PageDocument, parentId: string, after: string | null, text: string) => success(doc.edit({ kind: 'insert', parentId, after, text })).created[0]!;
const snapshot = (doc: PageDocument) => Array.from({ length: doc.outline.size() }, (_, i) => {
  const id = doc.outline.idAt(i);
  return { id, text: doc.block(id)!.text, parent: doc.outline.parentOf(id) };
});

test('nested paste redo restores preorder and depths before any reload', async () => {
  const { client, doc, first } = await fixture('');
  const at = { id: first, offset: 0 };
  const pasted = success(doc.edit({ kind: 'paste', at, text: 'A\n  B\n    C\nD' }, at));
  const expected = [[first, 'A', 0], [pasted.created[0]!, 'B', 1], [pasted.created[1]!, 'C', 2], [pasted.created[2]!, 'D', 0]];
  const shape = () => Array.from({ length: doc.outline.size() }, (_, index) => {
    const id = doc.outline.idAt(index);
    return [id, doc.block(id)!.text, doc.outline.depth(id)];
  });
  await client.flush();
  for (let count = 0; count < 2; count++) {
    expect(doc.undo()).toEqual(at);
    expect(doc.outline.children(first)).toEqual([]);
    await client.flush();
    expect(doc.redo()).toEqual(pasted.caret);
    expect(shape()).toEqual(expected);
    expect(visibleIds(doc, first, new Set(), false)).toEqual([first, pasted.created[0]!, pasted.created[1]!]);
    await client.flush();
    expect(shape()).toEqual(expected);
  }
});

test('row replacement undo restores persisted identities before and after paste acknowledgment', async () => {
  for (const settlePaste of [false, true]) {
    const { client, doc, first, pageId } = await fixture('Alpha');
    const hidden = insert(doc, first, null, 'Folded child');
    const beta = insert(doc, pageId, first, 'Beta');
    success(doc.edit({ kind: 'task', id: beta, value: newTask() }));
    const gamma = insert(doc, pageId, beta, 'Gamma');
    await client.flush();
    const range = { anchor: { id: first, offset: 0 }, head: { id: beta, offset: 4 } };
    const pasted = success(doc.edit({ kind: 'pasteRows', range, between: [], replaceRoots: [first, beta], rows: markdownPasteRows('Replacement') }, range.head));
    const replacement = pasted.caret!.id;
    expect(snapshot(doc).map(row => row.text)).toEqual(['Replacement', 'Gamma']);
    if (settlePaste) await client.flush();
    for (let repeat = 0; repeat < 2; repeat++) {
      doc.undo();
      await client.flush();
      expect(snapshot(doc).map(row => row.id)).toEqual([first, hidden, beta, gamma]);
      expect(doc.block(beta)?.task?.status).toBe('todo');
      expect((await api.page(pageId)).rows.map(row => [row.block.id, row.block.text, row.depth])).toEqual([
        [first, 'Alpha', 0], [hidden, 'Folded child', 1], [beta, 'Beta', 0], [gamma, 'Gamma', 0],
      ]);
      doc.redo();
      await client.flush();
      expect((await api.page(pageId)).rows.map(row => [row.block.id, row.block.text])).toEqual([[replacement, 'Replacement'], [gamma, 'Gamma']]);
      expect(client.queuedChanges()).toBe(0);
    }
  }
});

test('Markdown paste persists native headings and nested open and completed tasks atomically', async () => {
  const { client, doc, first, pageId } = await fixture('');
  const at = { id: first, offset: 0 };
  success(doc.edit({ kind: 'paste', at, text: '## Heading\n- Bullet\n  - [ ] Todo\n- [x] Finished' }, at));
  const shape = () => Array.from({ length: doc.outline.size() }, (_, i) => {
    const id = doc.outline.idAt(i), block = doc.block(id)!;
    return [block.text, doc.outline.depth(id), block.heading, block.task?.status ?? null];
  });
  const expected = [['Heading', 0, 2, null], ['Bullet', 0, null, null], ['Todo', 1, null, 'todo'], ['Finished', 0, null, 'done']];
  expect(shape()).toEqual(expected);
  await client.flush();
  const saved = await api.page(pageId);
  expect(saved.rows.map(row => [row.block.text, row.depth, row.block.heading])).toEqual(expected.map(row => row.slice(0, 3)));
  doc.undo();
  await client.flush();
  expect(snapshot(doc).map(row => row.text)).toEqual(['']);
  doc.redo();
  await client.flush();
  expect(shape()).toEqual(expected);
  expect(client.queuedChanges()).toBe(0);
});

test('structured row replacement keeps copied native metadata and never reparses authored markers', async () => {
  const source = await fixture('# Literal');
  const child = insert(source.doc, source.first, null, '- Literal child');
  success(source.doc.edit({ kind: 'heading', id: source.first, level: 2 }));
  success(source.doc.edit({ kind: 'task', id: child, value: newTask() }));
  await source.client.flush();
  const content = source.doc.clipboard([source.first]);
  const { client, doc, first, pageId } = await fixture('Alpha');
  const beta = insert(doc, pageId, first, 'Beta');
  const gamma = insert(doc, pageId, beta, 'Gamma');
  await client.flush();
  const range = { anchor: { id: first, offset: 0 }, head: { id: beta, offset: 4 } };
  const result = success(doc.edit({ kind: 'pasteBlocks', range, between: [], replaceRoots: [first, beta], content }, range.head));
  expect(snapshot(doc).map(row => row.text)).toEqual(['# Literal', '- Literal child', 'Gamma']);
  expect(result.created).toHaveLength(2);
  expect(doc.block(result.created[0]!)?.heading).toBe(2);
  expect(doc.block(result.created[1]!)?.task?.status).toBe('todo');
  expect(doc.outline.depth(result.created[1]!)).toBe(1);
  expect(result.created).not.toContain(source.first);
  await client.flush();
  doc.undo();
  await client.flush();
  expect(snapshot(doc).map(row => row.id)).toEqual([first, beta, gamma]);
});

test('replacement undo restores rows that were previously cut and pasted with their identities', async () => {
  const { client, doc, first, pageId } = await fixture('Alpha');
  const beta = insert(doc, pageId, first, 'Beta');
  const gamma = insert(doc, pageId, beta, 'Gamma');
  const delta = insert(doc, pageId, gamma, 'Delta');
  await client.flush();
  const content = doc.clipboard([first, beta], true);
  success(doc.edit({ kind: 'delete', ids: [first, beta] }));
  await client.flush();
  const ready = await doc.prepareClipboard(content);
  const at = { id: delta, offset: 0 };
  success(doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: ready }, at));
  await client.flush();
  expect(snapshot(doc).map(row => row.id)).toEqual([gamma, first, beta, delta]);
  const range = { anchor: { id: first, offset: 0 }, head: { id: beta, offset: 4 } };
  const pasted = success(doc.edit({ kind: 'pasteRows', range, between: [], replaceRoots: [first, beta], rows: markdownPasteRows('Replacement') }, range.head));
  await client.flush();
  doc.undo();
  await client.flush();
  expect((await api.page(pageId)).rows.map(row => [row.block.id, row.block.text])).toEqual([
    [gamma, 'Gamma'], [first, 'Alpha'], [beta, 'Beta'], [delta, 'Delta'],
  ]);
  doc.redo();
  await client.flush();
  expect((await api.page(pageId)).rows.map(row => [row.block.id, row.block.text])).toEqual([
    [gamma, 'Gamma'], [pasted.caret!.id, 'Replacement'], [delta, 'Delta'],
  ]);
});

test('typing redo restores the caret after the inserted character', async () => {
  const { client, doc, first, pageId } = await fixture('BB');
  insert(doc, pageId, first, 'Another row');
  await client.flush();
  const before = { id: first, offset: 2 };
  success(doc.edit({ kind: 'text', id: first, text: 'BBy', caret: 3 }, before));
  await client.flush();
  expect(doc.undo()).toEqual(before);
  expect(doc.block(first)?.text).toBe('BB');
  await client.flush();
  const after = doc.redo();
  expect(after).toEqual({ id: first, offset: 3 });
  expect(doc.block(first)?.text).toBe('BBy');
  success(doc.edit({ kind: 'text', id: first, text: `${doc.block(first)!.text.slice(0, after!.offset)}Z${doc.block(first)!.text.slice(after!.offset)}`, caret: 4 }, after));
  await client.flush();
  expect(doc.block(first)?.text).toBe('BByZ');
});

test('field shorthand conversion restores the original block in one undo step', async () => {
  for (const value of ['', '  literal value']) {
    const prefix = 'UndoVerify:: ';
    const original = `${prefix}${value}`;
    const { client, doc, first } = await fixture(original);
    const at = { id: first, offset: original.length };
    const converted = success(doc.edit({ kind: 'fieldEntry', id: first, fieldId: 'field-definition', from: prefix.length }, at));
    const child = converted.created[0]!;
    expect(doc.block(first)?.text).toBe('[[field-definition]]');
    expect(doc.block(child)?.text).toBe(value);
    expect(converted.caret).toEqual({ id: child, offset: value.length });
    await client.flush();
    expect(doc.undo()).toEqual(at);
    expect(doc.block(first)?.text).toBe(original);
    expect(doc.outline.children(first)).toEqual([]);
    await client.flush();
    expect(doc.redo()).toEqual(converted.caret);
    expect(doc.outline.children(first)).toEqual([child]);
    expect(doc.block(child)?.text).toBe(value);
    await client.flush();
  }
});

test('tree move history preserves the row selection anchor and head', async () => {
  const { client, doc, first, pageId } = await fixture('A');
  const b = insert(doc, pageId, first, 'B');
  const c = insert(doc, pageId, b, 'C');
  insert(doc, pageId, c, 'D');
  await client.flush();
  const at = { id: c, offset: 0, selection: { anchor: b, head: c } };
  success(doc.edit({ kind: 'indent', ids: [b, c] }, at));
  expect(doc.outline.children(first)).toEqual([b, c]);
  await client.flush();
  expect(doc.undo()).toEqual(at);
  expect(doc.outline.depth(b)).toBe(0);
  expect(doc.outline.depth(c)).toBe(0);
  await client.flush();
  expect(doc.redo()).toEqual(at);
  expect(doc.outline.children(first)).toEqual([b, c]);
  await client.flush();
});

test('Enter after a parent inserts its first child and restores exact caret through history', async () => {
  const { client, doc, first, pageId } = await fixture();
  const child = insert(doc, first, null, 'existing child');
  const sibling = insert(doc, pageId, first, 'next sibling');
  await client.flush();
  const before = snapshot(doc);
  const at = { id: first, offset: 5 };
  const range = { anchor: at, head: at };
  const result = success(doc.edit({ kind: 'replaceRange', range, between: [], text: '', mode: 'split' }, at));
  expect(doc.outline.children(first)).toEqual([result.created[0]!, child]);
  expect(doc.outline.children(pageId)).toEqual([first, sibling]);
  expect(result.caret).toEqual({ id: result.created[0]!, offset: 0 });
  await client.flush();
  expect(doc.undo()).toEqual({ ...at, range });
  expect(snapshot(doc)).toEqual(before);
  await client.flush();
  expect(doc.redo()).toEqual(result.caret);
  await client.flush();
  expect((await api.page(pageId)).rows.map(row => row.block.id)).toEqual([first, result.created[0]!, child, sibling]);
});

test('Enter at the start of a parent keeps its text and children on the original identity', async () => {
  for (const ranged of [false, true]) {
    const { client, doc, first, pageId } = await fixture('Parent');
    const beforeParent = insert(doc, pageId, null, 'Before');
    const child = insert(doc, first, null, 'Child');
    const sibling = insert(doc, pageId, first, 'After');
    await client.flush();
    const before = snapshot(doc);
    const at = { id: first, offset: 0 };
    const range = { anchor: at, head: at };
    const result = success(doc.edit(ranged
      ? { kind: 'replaceRange', range, between: [], text: '', mode: 'split' }
      : { kind: 'split', id: first, offset: 0 }, at));
    const empty = result.created[0]!;
    expect(doc.outline.children(pageId)).toEqual([beforeParent, empty, first, sibling]);
    expect(doc.block(empty)?.text).toBe('');
    expect(doc.block(first)?.text).toBe('Parent');
    expect(doc.outline.children(first)).toEqual([child]);
    expect(result.caret).toEqual(at);
    await client.flush();
    expect(doc.undo()).toEqual(ranged ? { ...at, range } : at);
    expect(snapshot(doc)).toEqual(before);
    await client.flush();
    expect(doc.redo()).toEqual(at);
    await client.flush();
    expect((await api.block(first)).text).toBe('Parent');
    expect((await api.block(child)).parent_id).toBe(first);
  }
});

test('Enter at the start of a zoomed task preserves its plan and inserts a plain first child', async () => {
  const { client, doc, first, pageId } = await fixture('Return the library books');
  const task = { ...newTask(), scheduled: '2026-10-12', scheduled_time: '17:30', priority: 'high' as const };
  success(doc.edit({ kind: 'task', id: first, value: task }));
  const child = insert(doc, first, null, 'Existing plan');
  const hidden = insert(doc, pageId, first, 'Outside the zoom');
  await client.flush();
  const before = snapshot(doc);
  const at = { id: first, offset: 0 };
  const range = { anchor: at, head: at };
  const result = success(doc.edit({ kind: 'replaceRange', range, between: [], text: '', mode: 'split', zoomRoot: first }, at));
  const empty = result.created[0]!;
  expect(doc.outline.children(first)).toEqual([empty, child]);
  expect(doc.outline.children(pageId)).toEqual([first, hidden]);
  expect(doc.block(first)?.text).toBe('Return the library books');
  expect(doc.block(first)?.task).toEqual(task);
  expect(doc.block(empty)?.text).toBe('');
  expect(doc.block(empty)?.task).toBeNull();
  expect(result.caret).toEqual(at);
  await client.flush();
  expect(doc.undo()).toEqual({ ...at, range });
  expect(snapshot(doc)).toEqual(before);
  expect(doc.block(first)?.task).toEqual(task);
  await client.flush();
  expect(doc.redo()).toEqual(at);
  await client.flush();
  expect((await api.capabilities(first)).task).toEqual(task);
  expect((await api.block(child)).parent_id).toBe(first);
});

test('Enter at the start of an unreviewed card inserts above without changing its card identity', async () => {
  for (const ranged of [false, true]) {
    const { client, doc, first, pageId } = await fixture('Front >> Back');
    const card = (await api.sourceCards(first))[0]!;
    expect(card.schedule.last_reviewed_at).toBeNull();
    const before = snapshot(doc);
    const at = { id: first, offset: 0 };
    const range = { anchor: at, head: at };
    const result = success(doc.edit(ranged
      ? { kind: 'replaceRange', range, between: [], text: '', mode: 'split' }
      : { kind: 'split', id: first, offset: 0 }, at));
    expect(doc.outline.children(pageId)).toEqual([result.created[0]!, first]);
    expect(doc.block(first)?.text).toBe('Front >> Back');
    expect(doc.block(result.created[0]!)?.text).toBe('');
    expect(result.caret).toEqual(at);
    await client.flush();
    expect((await api.sourceCards(first)).map(value => value.id)).toEqual([card.id]);
    expect(doc.undo()).toEqual(ranged ? { ...at, range } : at);
    expect(snapshot(doc)).toEqual(before);
    await client.flush();
    expect(doc.redo()).toEqual(at);
    await client.flush();
    expect((await api.sourceCards(first)).map(value => value.id)).toEqual([card.id]);
  }
});

test('Enter on child-answer cards makes their first child in one undo step', async () => {
  for (const operator of ['>>>', '>>1.']) {
    const { client, doc, first, pageId } = await fixture(`The six forms ${operator}`);
    const at = { id: first, offset: doc.block(first)!.text.length };
    const result = success(doc.edit({ kind: 'split', id: first, offset: at.offset }, at));
    expect(doc.outline.children(first)).toEqual(result.created);
    expect(doc.outline.children(pageId)).toEqual([first]);
    expect(result.caret).toEqual({ id: result.created[0]!, offset: 0 });
    await client.flush();
    expect(doc.undo()).toEqual(at);
    expect(doc.outline.children(first)).toEqual([]);
    await client.flush();
    doc.redo();
    await client.flush();
    expect((await api.page(pageId)).rows.map(row => row.depth)).toEqual([0, 1]);
  }
});

test('Enter continues tasks without planning facts and empty tasks leave the list', async () => {
  for (const offset of [3, 5]) {
    const { client, doc, first } = await fixture('Draft');
    const task = { ...newTask(), scheduled: '2026-10-12', priority: 'high' as const };
    success(doc.edit({ kind: 'task', id: first, value: task }));
    await client.flush();
    const at = { id: first, offset };
    const result = success(doc.edit({ kind: 'replaceRange', range: { anchor: at, head: at }, between: [], text: '', mode: 'split' }, at));
    const right = result.created[0]!;
    expect(doc.block(right)?.task).toEqual(newTask());
    expect(doc.block(first)?.task).toEqual(task);
    await client.flush();
    doc.undo();
    expect(doc.block(first)?.text).toBe('Draft');
    expect(doc.block(right)).toBeUndefined();
    await client.flush();
    doc.redo();
    await client.flush();
    expect(doc.block(right)?.task).toEqual(newTask());
    if (offset === 5) {
      const empty = { id: right, offset: 0 };
      const exit = success(doc.edit({ kind: 'split', id: right, offset: 0 }, empty));
      expect(exit.created).toEqual([]);
      expect(exit.caret).toEqual(empty);
      expect(doc.block(right)?.task).toBeNull();
      await client.flush();
      doc.undo();
      expect(doc.block(right)?.task).toEqual(newTask());
      await client.flush();
    }
  }
});

test('Enter on empty tasks only exits childless todos and otherwise preserves the original task', async () => {
  for (const status of ['doing', 'waiting', 'done', 'cancelled', 'todo'] as const) {
    for (const withChild of [false, true]) {
      if (status === 'todo' && !withChild) continue;
      const { client, doc, first, pageId } = await fixture('');
      const planned = { ...newTask(), scheduled: '2026-10-12', priority: 'high' as const };
      success(doc.edit({ kind: 'task', id: first, value: planned }));
      if (status === 'done') success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-11' }));
      else if (status !== 'todo') success(doc.edit({ kind: 'task', id: first, value: { ...planned, status } }));
      const child = withChild ? insert(doc, first, null, 'Existing child') : null;
      await client.flush();
      const task = { ...doc.block(first)!.task! };
      const before = snapshot(doc);
      const at = { id: first, offset: 0 };
      const range = { anchor: at, head: at };
      const result = success(doc.edit({ kind: 'replaceRange', range, between: [], text: '', mode: 'split' }, at));
      const fresh = result.created[0]!;
      expect(result.created).toHaveLength(1);
      expect(doc.block(first)?.task).toEqual(task);
      expect(doc.block(first)?.text).toBe('');
      expect(doc.block(fresh)?.task).toEqual(newTask());
      expect(doc.block(fresh)?.text).toBe('');
      expect(doc.outline.children(first)).toEqual(child ? [fresh, child] : []);
      expect(doc.outline.children(pageId)).toEqual(child ? [first] : [first, fresh]);
      expect(result.caret).toEqual({ id: fresh, offset: 0 });
      await client.flush();
      expect((await api.capabilities(first)).task).toEqual(task);
      expect((await api.capabilities(first)).history).toBe(status === 'done');
      expect(doc.undo()).toEqual({ ...at, range });
      expect(snapshot(doc)).toEqual(before);
      expect(doc.block(first)?.task).toEqual(task);
      await client.flush();
      expect(doc.redo()).toEqual(result.caret);
      await client.flush();
      expect(doc.block(fresh)?.task).toEqual(newTask());
    }
  }
});

test('Enter after a finished task starts a fresh todo and does not copy other capabilities', async () => {
  const { client, doc, first } = await fixture('Finished');
  success(doc.edit({ kind: 'task', id: first, value: newTask() }));
  await client.flush();
  success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-11' }));
  await client.flush();
  const right = success(doc.edit({ kind: 'split', id: first, offset: 8 })).created[0]!;
  expect(doc.block(first)?.task?.status).toBe('done');
  expect(doc.block(right)?.task).toEqual(newTask());
  expect(doc.block(right)?.project).toBeNull();
  expect(doc.block(right)?.question).toBeNull();
  await client.flush();
});

test('Enter inside a reference or tag splits after it, and a range touching one takes it whole', async () => {
  for (const token of ['[[01ARZ3NDEKTSV4RRFFQ69G5FAV|label]]', '[[Stoicism]]', '#token']) {
    const text = `before ${token} after`;
    const { client, doc, first } = await fixture(text);
    const at = { id: first, offset: 'before '.length + 3 };
    const caret = success(doc.edit({ kind: 'replaceRange', range: { anchor: at, head: at }, between: [], text: '', mode: 'split' }, at));
    expect([doc.block(first)?.text, doc.block(caret.created[0]!)?.text]).toEqual([`before ${token}`, ' after']);
    expect(caret.caret).toEqual({ id: caret.created[0]!, offset: 0 });
    await client.flush();
    doc.undo();
    expect(doc.block(first)?.text).toBe(text);
    const direct = success(doc.edit({ kind: 'split', id: first, offset: at.offset }, at)).created[0]!;
    expect([doc.block(first)?.text, doc.block(direct)?.text]).toEqual([`before ${token}`, ' after']);
    await client.flush();
    doc.undo();
    const range = { anchor: { id: first, offset: 3 }, head: at };
    const ranged = success(doc.edit({ kind: 'replaceRange', range, between: [], text: '', mode: 'split' }, at)).created[0]!;
    expect([doc.block(first)?.text, doc.block(ranged)?.text]).toEqual(['bef', ' after']);
  }
});

test('reference deletion consumes the whole token and undo restores the selected boundary', async () => {
  const text = 'before [[01ARZ3NDEKTSV4RRFFQ69G5FAV|label]] after';
  const { client, doc, first } = await fixture(text);
  const end = text.indexOf(']]') + 2;
  for (const [from, to] of [[end - 1, end], [7, 8], [15, 16]]) {
    const range = { anchor: { id: first, offset: from! }, head: { id: first, offset: to! } };
    const result = success(doc.edit({ kind: 'replaceRange', range, between: [], text: '', mode: 'text' }, range.head));
    expect(doc.block(first)?.text).toBe('before  after');
    expect(result.caret).toEqual({ id: first, offset: 7 });
    await client.flush();
    expect(doc.undo()).toEqual({ ...range.head, range });
    expect(doc.block(first)?.text).toBe(text);
    await client.flush();
    expect(doc.redo()).toEqual(result.caret);
    await client.flush();
    doc.undo();
    await client.flush();
  }
});

test('Backspace merges nested siblings and preserves source children through saved undo', async () => {
  const { client, doc, first } = await fixture();
  const left = insert(doc, first, null, 'left');
  const right = insert(doc, first, left, 'right');
  const child1 = insert(doc, right, null, 'one');
  const child2 = insert(doc, right, child1, 'two');
  await client.flush();
  const before = snapshot(doc);
  const at = { id: right, offset: 0 };
  const result = success(doc.edit(boundaryDeletion(doc, right, 'backward', left)!, at));
  expect(doc.block(left)?.text).toBe('leftright');
  expect(doc.block(right)).toBeUndefined();
  expect(doc.outline.children(left)).toEqual([child1, child2]);
  expect(result.caret).toEqual({ id: left, offset: 4 });
  await client.flush();
  expect(doc.undo()).toEqual(at);
  expect(snapshot(doc)).toEqual(before);
  await client.flush();
  expect(doc.redo()).toEqual(result.caret);
  await client.flush();
  expect((await api.block(child2)).parent_id).toBe(left);
});

test('Backspace merges into the visible descendant but never a folded hidden row', async () => {
  const { client, doc, first, pageId } = await fixture();
  const child = insert(doc, first, null, 'child');
  const grandchild = insert(doc, child, null, 'last');
  const source = insert(doc, pageId, first, 'source');
  await client.flush();
  const before = snapshot(doc);
  const at = { id: source, offset: 0 };
  success(doc.edit(boundaryDeletion(doc, source, 'backward', grandchild)!, at));
  expect(doc.block(first)?.text).toBe('Alpha');
  expect(doc.block(grandchild)?.text).toBe('lastsource');
  await client.flush();
  expect(doc.undo()).toEqual(at);
  expect(snapshot(doc)).toEqual(before);
  success(doc.edit(boundaryDeletion(doc, source, 'backward', first)!, at));
  expect(doc.block(first)?.text).toBe('Alphasource');
  expect(doc.block(grandchild)?.text).toBe('last');
  await client.flush();
});

test('Delete at row end joins the next sibling and appends its children in order', async () => {
  const { client, doc, first, pageId } = await fixture();
  const original = insert(doc, first, null, 'original');
  const source = insert(doc, pageId, first, 'source');
  const child1 = insert(doc, source, null, 'one');
  const child2 = insert(doc, source, child1, 'two');
  await client.flush();
  const before = snapshot(doc);
  const at = { id: first, offset: 5 };
  const intent = boundaryDeletion(doc, first, 'forward');
  expect(intent).not.toBeNull();
  const result = success(doc.edit(intent!, at));
  expect(doc.block(first)?.text).toBe('Alphasource');
  expect(doc.outline.children(first)).toEqual([original, child1, child2]);
  expect(result.caret).toEqual(at);
  await client.flush();
  expect(doc.undo()).toEqual(at);
  expect(snapshot(doc)).toEqual(before);
  await client.flush();
  expect(doc.redo()).toEqual(at);
  await client.flush();
  expect((await api.page(pageId)).rows.map(row => row.block.id)).toEqual([first, original, child1, child2]);
});

test('Delete at the zoomed root end cannot merge a sibling outside its subtree', async () => {
  const { client, doc, first, pageId } = await fixture('First');
  const child = insert(doc, first, null, 'Child');
  const nextChild = insert(doc, first, child, 'Next child');
  const hidden = insert(doc, pageId, first, 'Hidden');
  await client.flush();
  const before = snapshot(doc);
  const history = { undo: doc.canUndo(), redo: doc.canRedo() };
  const intent = boundaryDeletion(doc, first, 'forward', null, undefined, first);
  if (intent) success(doc.edit(intent, { id: first, offset: 5 }));
  expect(intent).toBeNull();
  expect(snapshot(doc)).toEqual(before);
  expect({ undo: doc.canUndo(), redo: doc.canRedo() }).toEqual(history);
  expect(boundaryDeletion(doc, child, 'forward', first, undefined, first)).toEqual({ kind: 'merge', sourceId: nextChild, destinationId: child });
  expect(boundaryDeletion(doc, first, 'forward')).toEqual({ kind: 'merge', sourceId: hidden, destinationId: first });
  await client.flush();
  expect((await api.block(first)).text).toBe('First');
  expect((await api.block(hidden)).text).toBe('Hidden');
});

test('undo of expanded token deletion restores the original collapsed caret', async () => {
  const text = 'before [[01ARZ3NDEKTSV4RRFFQ69G5FAV|label]] after';
  const { client, doc, first } = await fixture(text);
  const at = { id: first, offset: text.indexOf(']]') + 2 };
  const selectionBefore = { anchor: at, head: at };
  const range = { anchor: { id: first, offset: 7 }, head: at };
  const result = success(doc.edit({ kind: 'replaceRange', range, selectionBefore, between: [], text: '', mode: 'text' }, at));
  await client.flush();
  expect(doc.undo()).toEqual({ ...at, range: selectionBefore });
  expect(doc.block(first)?.text).toBe(text);
  await client.flush();
  expect(doc.redo()).toEqual(result.caret);
  expect(doc.block(first)?.text).toBe('before  after');
});

async function fieldFixture() {
  const fixtureState = await fixture('Before the field');
  const { client, doc, first, pageId } = fixtureState;
  const entry = insert(doc, pageId, first, '[[field-definition]]');
  const value = insert(doc, entry, null, 'Architecture');
  const after = insert(doc, pageId, entry, 'After the field');
  await client.flush();
  const definitions = new Map([['field-definition', { name: 'Area' }]]);
  const rows = (retained: string | null = null, archived = false, folds: ReadonlySet<string> = new Set(), zoom: string | null = null) => {
    const visible = visibleIds(doc, zoom, folds, archived);
    const inline = new Set(visible.filter(id => {
      const values = id === retained ? null : inlineFieldValues(doc, id, definitions);
      return !!values?.some(value => visible.includes(value)) && values.every(value => visible.includes(value) || doc.isArchived(value));
    }));
    return visibleIds(doc, zoom, folds, archived, inline);
  };
  return { ...fixtureState, entry, value, after, rows };
}

test('inline field arrows cross directly between the value and the row before the entry', async () => {
  const { first, value, after, rows } = await fieldFixture();
  const visible = rows();
  expect(visible).toEqual([first, value, after]);
  expect(visible[visible.indexOf(value) - 1]).toBe(first);
  expect(visible[visible.indexOf(first) + 1]).toBe(value);
});

test('Backspace at the start of an inline field value is a silent no-op without history', async () => {
  const { doc, first, entry, value } = await fieldFixture();
  const before = snapshot(doc);
  const history = { undo: doc.canUndo(), redo: doc.canRedo() };
  const intent = boundaryDeletion(doc, value, 'backward', first, new Set([entry]));
  if (intent) success(doc.edit(intent, { id: value, offset: 0 }));
  expect(intent).toBeNull();
  expect(snapshot(doc)).toEqual(before);
  expect({ undo: doc.canUndo(), redo: doc.canRedo() }).toEqual(history);
  expect(doc.block(entry)?.text).toBe('[[field-definition]]');
});

test('Enter at the inline value end creates a second value that lines up under the first', async () => {
  const { doc, first, entry, value, after, rows } = await fieldFixture();
  expect(rows()).toEqual([first, value, after]);
  const at = { id: value, offset: doc.block(value)!.text.length };
  const result = success(doc.edit({ kind: 'replaceRange', range: { anchor: at, head: at }, between: [], text: '', mode: 'split' }, at));
  expect(doc.outline.children(entry)).toEqual([value, result.created[0]!]);
  expect(rows()).toEqual([first, value, result.created[0]!, after]);
});

test('Enter on an empty field value exits after the entry in one undo step, even for its sole value', async () => {
  for (const sole of [false, true]) {
    const { client, doc, first, pageId, entry, value, after, rows } = await fieldFixture();
    const empty = sole ? value : insert(doc, entry, value, '');
    if (sole) success(doc.edit({ kind: 'text', id: value, text: '' }));
    await client.flush();
    const before = snapshot(doc);
    const at = { id: empty, offset: 0 };
    const range = { anchor: at, head: at };
    const result = success(doc.edit(sole
      ? { kind: 'split', id: empty, offset: 0, fieldEntry: entry }
      : { kind: 'replaceRange', range, between: [], text: '', mode: 'split', fieldEntry: entry }, at));
    const next = result.created[0]!;
    expect(doc.block(empty)).toBeUndefined();
    expect(doc.outline.children(entry)).toEqual(sole ? [] : [value]);
    expect(doc.outline.children(pageId)).toEqual([first, entry, next, after]);
    expect(doc.block(next)?.text).toBe('');
    expect(doc.block(next)?.task).toBeNull();
    expect(result.caret).toEqual({ id: next, offset: 0 });
    expect(rows()).toEqual([first, sole ? entry : value, next, after]);
    await client.flush();
    expect(doc.undo()).toEqual(sole ? at : { ...at, range });
    expect(snapshot(doc)).toEqual(before);
    await client.flush();
    expect(doc.redo()).toEqual(result.caret);
    await client.flush();
    expect((await api.block(next)).parent_id).toBe(pageId);
    expect((await api.page(pageId)).rows.some(row => row.block.id === empty)).toBe(false);
  }
});

test('empty field Enter preserves child notes and stays inside a field-entry or value zoom', async () => {
  for (const mode of ['children', 'entry zoom', 'value zoom'] as const) {
    const { client, doc, pageId, entry, value, after } = await fieldFixture();
    success(doc.edit({ kind: 'text', id: value, text: '' }));
    const child = mode === 'children' ? insert(doc, value, null, 'Value note') : null;
    await client.flush();
    const before = snapshot(doc);
    const at = { id: value, offset: 0 };
    const zoomRoot = mode === 'entry zoom' ? entry : mode === 'value zoom' ? value : null;
    const result = success(doc.edit({ kind: 'split', id: value, offset: 0, fieldEntry: entry, zoomRoot }, at));
    const empty = result.created[0]!;
    expect(doc.block(value)?.text).toBe('');
    expect(doc.outline.children(entry)).toEqual(mode === 'entry zoom' ? [value, empty] : [value]);
    expect(doc.outline.children(value)).toEqual(child ? [empty, child] : mode === 'value zoom' ? [empty] : []);
    expect(doc.outline.parentOf(after)).toBe(pageId);
    expect(result.caret).toEqual({ id: empty, offset: 0 });
    await client.flush();
    expect(doc.undo()).toEqual(at);
    expect(snapshot(doc)).toEqual(before);
    await client.flush();
  }
});

test('Backspace at the start of a later inline value merges it into the value above', async () => {
  const { doc, first, entry, value } = await fieldFixture();
  const second = success(doc.edit({ kind: 'insert', parentId: entry, after: value, text: 'Design' })).created[0]!;
  const intent = boundaryDeletion(doc, second, 'backward', value, new Set([entry]));
  expect(intent).toEqual({ kind: 'merge', sourceId: second, destinationId: value });
  expect(boundaryDeletion(doc, value, 'backward', first, new Set([entry]))).toBeNull();
});

test('deleting an inline value leaves its empty field entry visible', async () => {
  const { doc, first, entry, value, after, rows } = await fieldFixture();
  expect(rows()).toEqual([first, value, after]);
  success(doc.edit({ kind: 'delete', ids: [value] }, { id: value, offset: 0 }));
  expect(doc.block(entry)?.text).toBe('[[field-definition]]');
  expect(rows()).toEqual([first, entry, after]);
});

test('multi-select across an inline field includes only its value, never the hidden entry', async () => {
  const { doc, first, value, after, rows } = await fieldFixture();
  const selected = selectionIds(rows(), { anchor: { id: first, offset: 0 }, head: { id: after, offset: 5 } });
  expect(selected).toEqual([first, value, after]);
  expect(selectionRoots(doc, selected)).toEqual([first, value, after]);
});

test('undo and redo restore inline field rows across split and deletion', async () => {
  const { client, doc, first, entry, value, after, rows } = await fieldFixture();
  expect(rows()).toEqual([first, value, after]);
  const at = { id: value, offset: doc.block(value)!.text.length };
  const result = success(doc.edit({ kind: 'split', id: value, offset: at.offset }, at));
  await client.flush();
  expect(rows()).toEqual([first, value, result.created[0]!, after]);
  expect(doc.undo()).toEqual(at);
  expect(rows()).toEqual([first, value, after]);
  expect(doc.redo()).toEqual(result.caret);
  expect(rows()).toEqual([first, value, result.created[0]!, after]);
  doc.undo();
  success(doc.edit({ kind: 'delete', ids: [value] }, at));
  await client.flush();
  expect(rows()).toEqual([first, entry, after]);
  doc.undo();
  expect(rows()).toEqual([first, value, after]);
  doc.redo();
  expect(rows()).toEqual([first, entry, after]);
});

test('inline field eligibility retains edited or selected entries and hidden values', async () => {
  const { doc, first, entry, value, after, rows } = await fieldFixture();
  expect(rows(entry)).toEqual([first, entry, value, after]);
  expect(rows(value)).toEqual([first, value, after]);
  expect(rows(null, false, new Set([entry]))).toEqual([first, entry, after]);
  success(doc.edit({ kind: 'archive', id: value, archived: true }));
  expect(rows()).toEqual([first, entry, after]);
  expect(rows(null, true)).toEqual([first, value, after]);
  doc.undo();
  expect(rows()).toEqual([first, value, after]);
  expect(rows(null, false, new Set(), value)).toEqual([value]);
});

test('unknown fields and values with children keep the original two-level outline', async () => {
  const { doc, first, entry, value, after, rows } = await fieldFixture();
  success(doc.edit({ kind: 'text', id: entry, text: '[[unknown-definition]]' }));
  expect(rows()).toEqual([first, entry, value, after]);
  doc.undo();
  const note = insert(doc, value, null, 'Value note');
  expect(rows()).toEqual([first, entry, value, note, after]);
  expect(rows(null, false, new Set([value]))).toEqual([first, entry, value, after]);
});

test('depth stops show the gloss, the opening, then headings and positions, and folds still apply', async () => {
  const { doc, first: gloss, pageId } = await fixture('[[gloss-definition]]');
  const glossValue = insert(doc, gloss, null, 'What this is');
  const intro = insert(doc, pageId, gloss, 'Opening paragraph');
  const introChild = insert(doc, intro, null, 'Opening detail');
  const perspectives = insert(doc, pageId, intro, 'Perspectives');
  const position = insert(doc, perspectives, null, 'Plato');
  const gist = insert(doc, position, null, '[[gist-definition]]');
  const gistValue = insert(doc, gist, null, 'A line of decline');
  insert(doc, position, gist, 'His reading');
  insert(doc, perspectives, position, 'A plain note under the heading');
  const section = insert(doc, pageId, perspectives, 'Where they disagree');
  const subsection = insert(doc, section, null, 'Is it a circle?');
  insert(doc, subsection, null, 'Detail under a subheading');
  insert(doc, pageId, section, 'Top-level text after the sections');
  for (const [id, level] of [[perspectives, 2], [section, 2], [subsection, 3]] as const) success(doc.edit({ kind: 'heading', id, level }));
  const filter = (stop: 'gloss' | 'opening' | 'perspectives' | 'full') => ({ stop, gloss, position: (id: string) => id === position, gist: (id: string) => id === gist });
  const rows = (stop: Parameters<typeof filter>[0], folds: ReadonlySet<string> = new Set(), zoom: string | null = null) => visibleIds(doc, zoom, folds, false, undefined, filter(stop));
  expect(rows('gloss')).toEqual([gloss, glossValue]);
  expect(rows('opening')).toEqual([gloss, glossValue, intro, introChild]);
  expect(rows('opening', new Set([intro]))).toEqual([gloss, glossValue, intro]);
  expect(rows('perspectives')).toEqual([gloss, glossValue, intro, introChild, perspectives, position, gist, gistValue, section, subsection]);
  expect(rows('perspectives', new Set([position]))).toEqual([gloss, glossValue, intro, introChild, perspectives, position, section, subsection]);
  expect(rows('full').length).toBe(doc.outline.size());
  expect(rows('gloss', new Set(), section)).toEqual([section, subsection, doc.outline.children(subsection)[0]!]);
});

test('editing an inserted sibling at Perspectives depth reveals its own caret target', async () => {
  const { doc, first: heading } = await fixture('Perspectives');
  success(doc.edit({ kind: 'heading', id: heading, level: 2 }));
  const position = insert(doc, heading, null, 'Plato');
  const filter = { stop: 'perspectives' as const, gloss: null, position: (id: string) => id === position, gist: () => false };
  const folds = new Set<string>();
  expect(editingDepth(doc, position, null, folds, false, filter)).toBe('perspectives');
  const inserted = success(doc.edit({ kind: 'insert', parentId: heading, after: position }));
  expect(inserted.caret?.id).toBe(inserted.created[0]);
  const id = inserted.caret!.id;
  expect(visibleIds(doc, null, folds, false, undefined, filter)).not.toContain(id);
  const stop = editingDepth(doc, id, null, folds, false, filter);
  expect(stop).toBe('full');
  expect(visibleIds(doc, null, folds, false, undefined, { ...filter, stop })).toEqual([heading, position, id]);
  expect(editingDepth(doc, id, heading, folds, false, filter)).toBe('perspectives');
});

test('deleted zoom targets resolve to the closest surviving ancestor and restore page depth at the root', async () => {
  const { doc, first, pageId } = await fixture();
  const parent = insert(doc, first, null, 'Parent');
  const target = insert(doc, parent, null, 'Zoom target');
  const sibling = insert(doc, first, parent, 'Sibling');
  const other = insert(doc, pageId, first, 'Other section');
  success(doc.edit({ kind: 'heading', id: other, level: 2 }));
  const path = survivingZoomPath(doc, target);
  expect(path).toEqual([first, parent, target]);
  success(doc.edit({ kind: 'delete', ids: [target] }));
  const parentPath = survivingZoomPath(doc, target, path);
  expect(parentPath).toEqual([first, parent]);
  expect(visibleIds(doc, parentPath.at(-1)!, new Set(), false)).toEqual([parent]);
  success(doc.edit({ kind: 'delete', ids: [parent] }));
  const ancestorPath = survivingZoomPath(doc, parent, parentPath);
  expect(ancestorPath).toEqual([first]);
  expect(visibleIds(doc, ancestorPath.at(-1)!, new Set(), false)).toEqual([first, sibling]);
  success(doc.edit({ kind: 'delete', ids: [first] }));
  expect(survivingZoomPath(doc, first, ancestorPath)).toEqual([]);
  const depth = { stop: 'gloss' as const, gloss: null, position: () => false, gist: () => false };
  expect(visibleIds(doc, target, new Set(), false, undefined, depth)).toEqual([]);
});
