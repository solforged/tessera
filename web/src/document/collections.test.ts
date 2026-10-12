import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { emptyMetadata } from '../library/details';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { changeCollectionMembers, collectionPages, createCollection, deleteCollection, renameCollection, sourceCollections } from './collections';

const port = Bun.env.TESSERA_COLLECTION_TEST_PORT ?? '4784';
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
let process: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebook: Notebook;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-collection-tests-'));
  const root = resolve(import.meta.dir, '../../..');
  process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', port], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const expectedPath = await realpath(directory);
  // A subprocess's real HTTP listener cannot be advanced by fake timers.
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      const info = await api.notebook();
      if (await realpath(info.path) !== expectedPath) throw new Error('The test port belongs to another notebook.');
      notebook = createNotebookClient({ baseUrl, sessionId: ulid(), notebookId: info.id, databaseName: `collections-${ulid()}` });
      await notebook.ready;
      break;
    } catch { if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(process.stderr).text()}`); await Bun.sleep(20); }
  }
});
afterAll(async () => {
  await notebook?.dispose();
  process?.kill();
  if (process) await process.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('undoing first-use creation restores the field register and templates', async () => {
  const fields = await api.fields();
  const created = await createCollection(notebook, 'Undo first use');
  await created.change.undo();
  expect(await collectionPages(api)).toHaveLength(0);
  expect((await api.fields()).fields.map(field => field.id)).toEqual(fields.fields.map(field => field.id));
  expect((await api.roots()).filter(page => page.text === 'Book' || page.text === 'Article')).toHaveLength(0);
});

test('collections use one commit, extend templates, backlink, filter, undo and clear membership on deletion', async () => {
  const sources: string[] = [];
  for (const title of ['Collection source A', 'Collection source B', 'Unfiled source']) {
    const plan = await api.planRecord({ ...emptyMetadata(), title });
    await notebook.commit(plan.operations, 'Add source');
    sources.push(plan.source_id);
  }
  // A title-only record files no metadata, so the Book type is made here as an import would make it.
  const bookId = ulid();
  await notebook.commit([{ op: 'create_page', id: bookId, title: 'Book' }], 'Add Book type');
  const template = (await api.type(bookId)).fields;
  const before = await api.changeHead();
  const created = await createCollection(notebook, 'First collection');
  expect(await api.changeHead()).toBe(before + 1);
  const register = await api.fields();
  const field = register.fields.find(field => field.name === 'Collections')!;
  expect(field.kind).toBe('instance');
  expect(field.targets).toEqual([(await api.roots()).find(page => page.text === 'Collection')!.id]);
  const book = await api.type(bookId);
  expect(book.fields).toEqual([...template, field.id]);
  expect((await api.roots()).some(page => page.text === 'Article')).toBe(false);
  expect((await collectionPages(api)).map(page => page.id)).toEqual([created.id]);

  const head = await api.changeHead();
  const added = await changeCollectionMembers(notebook, created.id, sources.slice(0, 2), true);
  expect(await api.changeHead()).toBe(head + 1);
  expect(added).not.toBeNull();
  expect((await api.library({ collection_id: created.id, sort: 'title', direction: 'asc' })).rows.map(row => row.page.id)).toEqual(sources.slice(0, 2));
  expect(new Set((await api.backlinks(created.id)).map(link => link.page.id))).toEqual(new Set(sources.slice(0, 2)));
  expect(await sourceCollections(api, sources[0]!)).toEqual([created.id]);
  expect(await changeCollectionMembers(notebook, created.id, sources.slice(0, 2), true)).toBeNull();
  expect(await api.changeHead()).toBe(head + 1);

  const removed = await changeCollectionMembers(notebook, created.id, [sources[0]!], false);
  expect((await api.library({ collection_id: created.id })).total).toBe(1);
  await removed!.undo();
  expect((await api.library({ collection_id: created.id })).total).toBe(2);
  const renamed = await renameCollection(notebook, await api.block(created.id), 'Renamed collection');
  expect((await api.block(created.id)).text).toBe('Renamed collection');
  await renamed!.undo();
  expect((await api.block(created.id)).text).toBe('First collection');

  const deleteHead = await api.changeHead();
  const deleted = await deleteCollection(notebook, await api.block(created.id));
  expect(await api.changeHead()).toBe(deleteHead + 1);
  expect(await collectionPages(api)).toHaveLength(0);
  expect((await api.library({})).total).toBe(3);
  for (const id of sources) expect(await sourceCollections(api, id)).toEqual([]);
  await deleted.undo();
  expect((await api.library({ collection_id: created.id })).total).toBe(2);
  expect(new Set((await api.backlinks(created.id)).map(link => link.page.id))).toEqual(new Set(sources.slice(0, 2)));

  const next = await createCollection(notebook, 'Second collection', [sources[2]!]);
  expect((await api.fields()).fields.filter(field => field.name === 'Collections')).toHaveLength(1);
  expect((await api.type(book.page.id)).fields).toEqual(book.fields);
  expect((await api.library({ collection_id: next.id })).total).toBe(1);
  await next.change.undo();
  expect((await api.library({})).total).toBe(3);
  expect(await sourceCollections(api, sources[2]!)).toEqual([]);
});

test('deletion also clears archived membership values and undo restores them', async () => {
  const plan = await api.planRecord({ ...emptyMetadata(), title: 'Archived collection source' });
  await notebook.commit(plan.operations);
  const collection = await createCollection(notebook, 'Archived collection', [plan.source_id]);
  const value = (await api.collectionValues(collection.id))[0]!;
  await notebook.commit([{ op: 'set_archived', id: value.id, base_revision: value.revision, archived: true }]);
  expect((await api.library({ collection_id: collection.id })).total).toBe(0);
  const deleted = await deleteCollection(notebook, await api.block(collection.id));
  expect((await api.block(value.id)).text).toBe('');
  expect((await api.block(value.id)).archived).toBe(true);
  await deleted.undo();
  expect((await api.block(value.id)).text).toBe(`[[${collection.id}]]`);
  expect((await api.block(value.id)).archived).toBe(true);
});

test('undo refuses to overwrite a later membership value edit', async () => {
  const plan = await api.planRecord({ ...emptyMetadata(), title: 'Edited collection source' });
  await notebook.commit(plan.operations);
  const collection = await createCollection(notebook, 'Conflict collection', [plan.source_id]);
  const removed = await changeCollectionMembers(notebook, collection.id, [plan.source_id], false);
  const page = await api.page(plan.source_id);
  const value = page.rows.find(row => row.depth === 1 && row.block.text === '')!.block;
  await api.submit({ actor: { kind: 'person' }, operations: [{ op: 'edit_text', id: value.id, base_revision: value.revision, text: 'Later edit' }] });
  await expect(removed!.undo()).rejects.toThrow();
  expect((await api.block(value.id)).text).toBe('Later edit');
});
