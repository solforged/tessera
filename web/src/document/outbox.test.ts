import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { deleteDB, openDB } from 'idb';
import { ulid } from 'ulid';
import type { Block, BlockCapabilities, PageView, TaskState } from '../api/types';
import { Outbox } from './outbox';
import type { NotebookCommand, PageCommand } from './types';

const task: TaskState = { status: 'todo', scheduled: '2026-10-10', scheduled_time: null, deadline: '2026-10-05', deadline_time: null, warning_days: null, repeater: { every: 1, unit: 'day', mode: 'fixed' }, priority: null, completed_on: null };

test('v2 page records migrate additively and recover frozen page and notebook commands in authored order', async () => {
  const database = `outbox-upgrade-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Sources', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'Read' };
  const view: PageView = { root, rows: [{ block, depth: 0, manual_types: [] }], targets: [] };
  const page: PageCommand = { id: ulid(), order: 1, pageId: root.id, actions: [{ kind: 'text', id: block.id, text: 'Read closely' }], inverse: [{ kind: 'text', id: block.id, text: 'Read' }], before: null, after: null, frozen: '{"legacy":"immutable"}' };
  const legacy = await openDB(database, 2, { upgrade(db) { for (const name of ['notebooks', 'pages', 'commands', 'tickets', 'blocks']) db.createObjectStore(name, { keyPath: 'key' }); } });
  await legacy.put('pages', { key: `notebook:${root.id}`, view });
  await legacy.put('commands', { key: `notebook:window:${page.id}`, command: page });
  legacy.close();
  const errors: unknown[] = [];
  const outbox = new Outbox('notebook', 'window', error => errors.push(error), database);
  try {
    const notebook: NotebookCommand = { kind: 'notebook', id: ulid(), order: 2, pageId: null, actions: [], inverse: [], before: null, after: null, operations: [{ op: 'start_review_session', id: ulid(), deck_id: null, started_at: 1000 }], frozen: '{"new":"immutable"}' };
    const saved = outbox.put(notebook);
    notebook.frozen = 'caller mutation';
    notebook.operations[0] = { op: 'start_review_session', id: ulid(), deck_id: null, started_at: 9000 };
    await saved;
    const recovered = await outbox.load();
    expect(recovered.commands.map(command => command.id)).toEqual([page.id, notebook.id]);
    expect(recovered.commands[0]?.frozen).toBe(page.frozen);
    expect(recovered.commands[1]?.frozen).toBe('{"new":"immutable"}');
    const command = recovered.commands[1]!;
    expect(command.kind).toBe('notebook');
    if (command.kind === 'notebook') expect(command.operations[0]).toHaveProperty('started_at', 1000);
    expect((await outbox.cachedPage(root.id))?.capabilities).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('authoritative sidecars survive text-only patches and older snapshots cannot erase review protection', async () => {
  const database = `outbox-sidecars-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Primary sources', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'Read' };
  const view: PageView = { root, rows: [{ block, depth: 0, manual_types: [] }], targets: [] };
  const capability: BlockCapabilities = { block_id: block.id, task, project: null, history: false, merge_protected: true, reviewed_cards: true };
  const errors: unknown[] = [];
  const outbox = new Outbox('notebook', 'window', error => errors.push(error), database);
  try {
    await outbox.page(view);
    await outbox.capabilities([capability], 10);
    await outbox.capabilities([{ ...capability, task: null, merge_protected: false, reviewed_cards: false }], 9);
    const command: PageCommand = { id: ulid(), order: 1, pageId: root.id, actions: [{ kind: 'text', id: block.id, text: 'Markup removed' }], inverse: [], before: null, after: null };
    await outbox.put(command);
    await outbox.acknowledge(command, [{ ...block, text: 'Markup removed', revision: 2 }], 11, new Map([[block.id, 2]]));
    const recovered = await outbox.cachedPage(root.id);
    expect(recovered?.rows[0]?.block.text).toBe('Markup removed');
    expect(recovered?.capabilities).toEqual([capability]);
    expect((await outbox.load()).commands).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('an end split replays its new sibling and final text even when the source revision did not change', async () => {
  const database = `outbox-end-split-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Sources', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'front >> back' };
  const sibling: Block = { ...block, id: ulid(), text: '', revision: 0 };
  const capability: BlockCapabilities = { block_id: block.id, task, project: null, history: false, merge_protected: true, reviewed_cards: true };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  try {
    await outbox.page({ root, rows: [{ block, depth: 0, manual_types: [] }], targets: [], capabilities: [capability] });
    const command: PageCommand = { id: ulid(), order: 1, pageId: root.id, actions: [{ kind: 'split', id: block.id, block: sibling, left: block.text, right: '' }, { kind: 'text', id: sibling.id, text: 'Next source' }], inverse: [], before: null, after: null };
    await outbox.put(command);
    await outbox.acknowledge(command, [{ ...sibling, text: 'Next source', revision: 2 }], 2, new Map([[sibling.id, 2]]));
    const recovered = await outbox.cachedPage(root.id);
    expect(recovered?.rows.map(row => [row.block.id, row.block.revision])).toEqual([[block.id, 1], [sibling.id, 2]]);
    expect(recovered?.rows[1]?.block.text).toBe('Next source');
    expect(recovered?.capabilities).toEqual([capability]);
  } finally { await outbox.close(); await deleteDB(database); }
});
