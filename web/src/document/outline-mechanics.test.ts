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
import { inlineFieldValues, selectionIds, selectionRoots, visibleIds } from '../outline/visibility';

const baseUrl = 'http://127.0.0.1:43862';
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
  service = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', '43862'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
