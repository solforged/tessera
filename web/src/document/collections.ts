import { ulid } from 'ulid';
import type { ApiClient } from '../api/client';
import type { Block, Committed, FieldKind, Fields, Operation, PageView } from '../api/types';
import type { NotebookClient } from './contract';
import { fieldEntryId } from '../table/query';

export interface CollectionChange { undo(): Promise<void> }
type Inverse = (receipt: Committed) => Operation;
interface Plan { operations: Operation[]; inverse: Inverse[] }
const plan = (): Plan => ({ operations: [], inverse: [] });
const revision = (receipt: Committed, id: string) => {
  const value = receipt.revisions.find(value => value.id === id);
  if (!value) throw new Error('The collection change has no revision receipt.');
  return value.revision;
};
function inserted(plan: Plan, operation: Extract<Operation, { op: 'insert' | 'create_page' }>, undo = true) {
  plan.operations.push(operation);
  if (undo) plan.inverse.unshift(receipt => ({ op: 'delete', id: operation.id, base_revision: revision(receipt, operation.id) }));
}
function text(plan: Plan, block: Block, value: string) {
  if (block.text === value) return;
  plan.operations.push({ op: 'edit_text', id: block.id, base_revision: block.revision, text: value });
  plan.inverse.unshift(receipt => ({ op: 'edit_text', id: block.id, base_revision: revision(receipt, block.id), text: block.text }));
}
async function commit(notebook: NotebookClient, plan: Plan, reason: string): Promise<CollectionChange | null> {
  if (!plan.operations.length) return null;
  const receipt = await notebook.commit(plan.operations, reason);
  const inverse = plan.inverse.map(make => make(receipt));
  return { undo: async () => { await notebook.commit(inverse, `Undo ${reason.toLocaleLowerCase()}`); } };
}

/** Pages, not a separate membership store. Empty collections still appear here. */
export async function collectionPages(api: ApiClient, signal?: AbortSignal): Promise<Block[]> {
  const type = (await api.roots(signal)).find(page => page.text.toLocaleLowerCase() === 'collection');
  if (!type) return [];
  const result = await api.query({ type: type.id, text: null, filters: [], sort: [{ by: 'title', field: null, direction: 'asc' }], limit: null }, signal);
  return result.rows.flatMap(row => row.block.block.kind === 'page' ? [row.block.block] : []);
}

/** The only Collections field bootstrap: an Instance field linking to the Collection type, on the Book and Article templates. */
async function ensureCollectionsField(notebook: NotebookClient, pending: Plan, register: Fields): Promise<string> {
  const existing = register.fields.find(field => field.name.toLocaleLowerCase() === 'collections');
  const id = existing?.id ?? ulid();
  let fieldRevision = existing?.revision ?? 1;
  if (!existing) {
    inserted(pending, { op: 'insert', id, parent_id: register.page_id, after: null, text: 'Collections', heading: null });
    pending.operations.push({ op: 'set_field_kind', id, base_revision: 1, kind: 'instance' });
    fieldRevision = 2;
  } else if (existing.kind !== 'instance') {
    pending.operations.push({ op: 'set_field_kind', id, base_revision: existing.revision, kind: 'instance' });
    // A non-instance field has no targets, so the targets inverse below always runs first and bumps the revision once.
    pending.inverse.unshift(receipt => ({ op: 'set_field_kind', id, base_revision: revision(receipt, id) + 1, kind: existing.kind }));
    fieldRevision += 1;
  }
  const roots = await notebook.api.roots();
  const find = (title: string) => roots.find(page => page.kind === 'page' && page.text.toLocaleLowerCase() === title);
  let collectionType = find('collection')?.id;
  if (!collectionType) {
    collectionType = ulid();
    inserted(pending, { op: 'create_page', id: collectionType, title: 'Collection' });
  }
  const previousTargets = existing?.targets ?? [];
  if (!previousTargets.includes(collectionType)) {
    pending.operations.push({ op: 'set_field_targets', id, base_revision: fieldRevision, targets: [...previousTargets, collectionType] });
    if (existing) pending.inverse.unshift(receipt => ({ op: 'set_field_targets', id, base_revision: revision(receipt, id), targets: previousTargets }));
  }
  // Library types that exist gain the field; ones not imported yet get it when the next collection is made after them.
  for (const name of ['book', 'article']) {
    const root = find(name);
    if (!root) continue;
    const previous = (await notebook.api.type(root.id)).fields;
    if (previous.includes(id)) continue;
    pending.operations.push({ op: 'set_type_fields', type_id: root.id, base_revision: root.revision, fields: [...previous, id] });
    pending.inverse.unshift(receipt => ({ op: 'set_type_fields', type_id: root.id, base_revision: revision(receipt, root.id), fields: previous }));
  }
  return id;
}

function entries(page: PageView, field: string, includeArchived = false) {
  return page.rows.filter(row => row.block.parent_id === page.root.id && (includeArchived || !row.block.archived) && fieldEntryId(row.block.text) === field).map(row => row.block);
}
function values(page: PageView, field: string, includeArchived = false) {
  const parents = new Set(entries(page, field, includeArchived).map(entry => entry.id));
  return page.rows.filter(row => row.block.parent_id && parents.has(row.block.parent_id) && (includeArchived || !row.block.archived)).map(row => row.block);
}
export async function sourceCollections(api: ApiClient, sourceId: string, signal?: AbortSignal): Promise<string[]> {
  const [register, page] = await Promise.all([api.fields(signal), api.page(sourceId, signal)]);
  const field = register.fields.find(field => field.name.toLocaleLowerCase() === 'collections' && field.kind === 'instance');
  return field ? [...new Set(values(page, field.id).flatMap(value => { const id = fieldEntryId(value.text); return id ? [id] : []; }))] : [];
}
async function membership(notebook: NotebookClient, pending: Plan, field: string, collection: string, ids: readonly string[], add: boolean) {
  const pages = await Promise.all([...new Set(ids)].map(id => notebook.api.page(id)));
  for (const page of pages) {
    const current = values(page, field, !add).filter(value => fieldEntryId(value.text) === collection);
    if (!add) { for (const value of current) text(pending, value, ''); continue; }
    if (current.length) continue;
    let entry = entries(page, field)[0]?.id;
    const createdEntry = !entry;
    if (!entry) {
      entry = ulid();
      inserted(pending, { op: 'insert', id: entry, parent_id: page.root.id, after: null, text: `[[${field}]]`, heading: null });
    }
    inserted(pending, { op: 'insert', id: ulid(), parent_id: entry, after: null, text: `[[${collection}]]`, heading: null }, !createdEntry);
  }
}

export async function createCollection(notebook: NotebookClient, name: string, sourceIds: readonly string[] = []): Promise<{ id: string; change: CollectionChange }> {
  const pending = plan();
  const field = await ensureCollectionsField(notebook, pending, await notebook.api.fields());
  const id = ulid();
  inserted(pending, { op: 'create_page', id, title: name.trim() });
  pending.operations.push({ op: 'add_type', id, base_revision: 1, title: 'Collection' });
  await membership(notebook, pending, field, id, sourceIds, true);
  return { id, change: (await commit(notebook, pending, 'Create collection'))! };
}
export async function changeCollectionMembers(notebook: NotebookClient, collection: string, sourceIds: readonly string[], add: boolean): Promise<CollectionChange | null> {
  const pending = plan();
  const field = (await notebook.api.fields()).fields.find(field => field.name.toLocaleLowerCase() === 'collections' && field.kind === 'instance');
  if (!field) throw new Error('The Collections Instance field is missing.');
  await membership(notebook, pending, field.id, collection, sourceIds, add);
  return commit(notebook, pending, add ? 'Add to collection' : 'Remove from collection');
}
export async function renameCollection(notebook: NotebookClient, collection: Block, name: string): Promise<CollectionChange | null> {
  const pending = plan();
  text(pending, collection, name.trim());
  return commit(notebook, pending, 'Rename collection');
}
export async function deleteCollection(notebook: NotebookClient, collection: Block): Promise<CollectionChange> {
  const pending = plan();
  for (const value of await notebook.api.collectionValues(collection.id)) text(pending, value, '');
  pending.operations.push({ op: 'delete', id: collection.id, base_revision: collection.revision });
  pending.inverse.unshift(receipt => ({ op: 'restore', id: collection.id, deletion_id: receipt.deletions[0]!, revision: revision(receipt, collection.id) }));
  return (await commit(notebook, pending, 'Delete collection'))!;
}
