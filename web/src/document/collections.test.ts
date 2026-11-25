import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { freePort, startService, type WorkshopService } from '../testing/service';
import { emptyMetadata } from '../library/details';
import { createWorkshopClient } from '../workflows/workshop';
import type { Workshop } from '../workflows/workshop';
import {
  changeCollectionMembers,
  collectionPages,
  createCollection,
  deleteCollection,
  renameCollection,
  sourceCollections,
} from './collections';

const port = freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
let service: WorkshopService | undefined;
let workshop: Workshop;

beforeAll(async () => {
  service = await startService({ name: 'collection-tests', port });
  workshop = createWorkshopClient({
    baseUrl,
    sessionId: ulid(),
    workshopId: service.workshopId,
    databaseName: `collections-${ulid()}`,
  });
  await workshop.ready;
}, 60000);
afterAll(async () => {
  await workshop?.dispose();
  await service?.stop();
});

test('undoing first-use creation restores fields and templates but retains the system tag page', async () => {
  const fields = await api.fields();
  const created = await createCollection(workshop, 'Undo first use');
  const tag = (await api.roots()).find(page => page.text === 'Collection')!;
  expect((await api.capabilities(tag.id)).built_in_tag).toBe(true);
  await created.change.undo();
  expect((await api.block(tag.id)).text).toBe('Collection');
  expect(await collectionPages(api)).toHaveLength(0);
  expect((await api.fields()).fields.map(field => field.id)).toEqual(fields.fields.map(field => field.id));
  expect((await api.roots()).filter(page => page.text === 'Book' || page.text === 'Article')).toHaveLength(0);
});

test('collections use one commit, extend templates, backlink, filter, undo and clear membership on deletion', async () => {
  const sources: string[] = [];
  for (const title of ['Collection source A', 'Collection source B', 'Unfiled source']) {
    const plan = await api.planRecord({ ...emptyMetadata(), title });
    await workshop.commit(plan.operations, 'Add source');
    sources.push(plan.source_id);
  }
  // A title-only record files no metadata, so the Book type is made here as an import would make it.
  const bookId = ulid();
  await workshop.commit([{ op: 'create_page', id: bookId, title: 'Book' }], 'Add Book type');
  const template = (await api.type(bookId)).fields;
  const before = await api.changeHead();
  const created = await createCollection(workshop, 'First collection');
  expect(await api.changeHead()).toBe(before + 1);
  const register = await api.fields();
  const field = register.fields.find(field => field.name === 'collections')!;
  expect(field.kind).toBe('instance');
  expect(field.targets).toEqual([(await api.roots()).find(page => page.text === 'Collection')!.id]);
  const book = await api.type(bookId);
  expect(book.fields).toEqual([...template, field.id]);
  expect((await api.roots()).some(page => page.text === 'Article')).toBe(false);
  expect((await collectionPages(api)).map(page => page.id)).toEqual([created.id]);

  const head = await api.changeHead();
  const added = await changeCollectionMembers(workshop, created.id, sources.slice(0, 2), true);
  expect(await api.changeHead()).toBe(head + 1);
  expect(added).not.toBeNull();
  expect(
    (await api.library({ collection_id: created.id, sort: 'title', direction: 'asc' })).rows.map(row => row.page.id),
  ).toEqual(sources.slice(0, 2));
  expect(new Set((await api.backlinks(created.id)).map(link => link.page.id))).toEqual(new Set(sources.slice(0, 2)));
  expect(await sourceCollections(api, sources[0]!)).toEqual([created.id]);
  expect(await changeCollectionMembers(workshop, created.id, sources.slice(0, 2), true)).toBeNull();
  expect(await api.changeHead()).toBe(head + 1);

  const removed = await changeCollectionMembers(workshop, created.id, [sources[0]!], false);
  expect((await api.library({ collection_id: created.id })).total).toBe(1);
  await removed!.undo();
  expect((await api.library({ collection_id: created.id })).total).toBe(2);
  const renamed = await renameCollection(workshop, await api.block(created.id), 'Renamed collection');
  expect((await api.block(created.id)).text).toBe('Renamed collection');
  await renamed!.undo();
  expect((await api.block(created.id)).text).toBe('First collection');

  const deleteHead = await api.changeHead();
  const deleted = await deleteCollection(workshop, await api.block(created.id));
  expect(await api.changeHead()).toBe(deleteHead + 1);
  expect(await collectionPages(api)).toHaveLength(0);
  expect((await api.library({})).total).toBe(3);
  for (const id of sources) expect(await sourceCollections(api, id)).toEqual([]);
  await deleted.undo();
  expect((await api.library({ collection_id: created.id })).total).toBe(2);
  expect(new Set((await api.backlinks(created.id)).map(link => link.page.id))).toEqual(new Set(sources.slice(0, 2)));

  const next = await createCollection(workshop, 'Second collection', [sources[2]!]);
  expect((await api.fields()).fields.filter(field => field.name === 'collections')).toHaveLength(1);
  expect((await api.type(book.page.id)).fields).toEqual(book.fields);
  expect((await api.library({ collection_id: next.id })).total).toBe(1);
  await next.change.undo();
  expect((await api.library({})).total).toBe(3);
  expect(await sourceCollections(api, sources[2]!)).toEqual([]);
});

test('deletion also clears archived membership values and undo restores them', async () => {
  const plan = await api.planRecord({ ...emptyMetadata(), title: 'Archived collection source' });
  await workshop.commit(plan.operations);
  const collection = await createCollection(workshop, 'Archived collection', [plan.source_id]);
  const value = (await api.collectionValues(collection.id))[0]!;
  await workshop.commit([{ op: 'set_archived', id: value.id, base_revision: value.revision, archived: true }]);
  expect((await api.library({ collection_id: collection.id })).total).toBe(0);
  const deleted = await deleteCollection(workshop, await api.block(collection.id));
  expect((await api.block(value.id)).text).toBe('');
  expect((await api.block(value.id)).archived).toBe(true);
  await deleted.undo();
  expect((await api.block(value.id)).text).toBe(`[[${collection.id}]]`);
  expect((await api.block(value.id)).archived).toBe(true);
});

test('undo refuses to overwrite a later membership value edit', async () => {
  const plan = await api.planRecord({ ...emptyMetadata(), title: 'Edited collection source' });
  await workshop.commit(plan.operations);
  const collection = await createCollection(workshop, 'Conflict collection', [plan.source_id]);
  const removed = await changeCollectionMembers(workshop, collection.id, [plan.source_id], false);
  const page = await api.page(plan.source_id);
  const value = page.rows.find(row => row.depth === 1 && row.block.text === '')!.block;
  await api.submit({
    actor: { kind: 'person' },
    operations: [{ op: 'edit_text', id: value.id, base_revision: value.revision, text: 'Later edit' }],
  });
  await expect(removed!.undo()).rejects.toThrow();
  expect((await api.block(value.id)).text).toBe('Later edit');
});
