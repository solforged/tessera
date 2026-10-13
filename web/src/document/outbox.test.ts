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
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Sources', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
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
    expect((await outbox.cachedPage(root.id))?.view.capabilities).toEqual([]);
    expect((await outbox.cachedPage(root.id))?.cursor).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('authoritative sidecars survive text-only patches and older snapshots cannot erase review protection', async () => {
  const database = `outbox-sidecars-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Primary sources', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'Read' };
  const view: PageView = { root, rows: [{ block, depth: 0, manual_types: [] }], targets: [] };
  const capability: BlockCapabilities = { block_id: block.id, task, project: null, position: null, question: null, assessment: null, history: false, merge_protected: true, reviewed_cards: true };
  const errors: unknown[] = [];
  const outbox = new Outbox('notebook', 'window', error => errors.push(error), database);
  try {
    await outbox.page(view, 8, 8);
    await outbox.capabilities([capability], 10);
    await outbox.capabilities([{ ...capability, task: null, merge_protected: false, reviewed_cards: false }], 9);
    const command: PageCommand = { id: ulid(), order: 1, pageId: root.id, actions: [{ kind: 'text', id: block.id, text: 'Markup removed' }], inverse: [], before: null, after: null };
    await outbox.put(command);
    await outbox.acknowledge(command, [{ ...block, text: 'Markup removed', revision: 2 }], 11, new Map([[block.id, 2]]));
    const recovered = await outbox.cachedPage(root.id);
    expect(recovered?.view.rows[0]?.block.text).toBe('Markup removed');
    expect(recovered?.view.capabilities).toEqual([capability]);
    expect(recovered?.cursor).toBe(8);
    expect((await outbox.load()).commands).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('kept-copy settlement and undo survive acknowledged offline cache patches', async () => {
  const database = `outbox-kept-copy-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Versions', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const copy = { of: ulid(), origin: ulid(), origin_name: null, mine: true };
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'Phone wording', kept_copy: copy };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  try {
    await outbox.page({ root, rows: [{ block, depth: 0, manual_types: [] }], targets: [] });
    for (const settled of [true, false]) {
      const revision = settled ? 2 : 3;
      const command: PageCommand = { id: ulid(), order: revision, pageId: root.id, actions: [{ kind: 'settleSyncCopy', id: block.id, settled, copy }], inverse: [], before: null, after: null };
      await outbox.put(command);
      await outbox.acknowledge(command, [{ ...block, revision, kept_copy: settled ? null : copy }], revision, new Map([[block.id, revision]]));
      expect((await outbox.cachedPage(root.id))?.view.rows[0]?.block.kept_copy).toEqual(settled ? null : copy);
    }
  } finally { await outbox.close(); await deleteDB(database); }
});

test('an end split replays its new sibling and final text even when the source revision did not change', async () => {
  const database = `outbox-end-split-${ulid()}`;
  const root: Block = { id: ulid(), kind: 'page', parent_id: null, page_id: '', text: 'Sources', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  root.page_id = root.id;
  const block: Block = { ...root, id: ulid(), kind: 'block', parent_id: root.id, text: 'front >> back' };
  const sibling: Block = { ...block, id: ulid(), text: '', revision: 0 };
  const capability: BlockCapabilities = { block_id: block.id, task, project: null, position: null, question: null, assessment: null, history: false, merge_protected: true, reviewed_cards: true };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  try {
    await outbox.page({ root, rows: [{ block, depth: 0, manual_types: [] }], targets: [], capabilities: [capability] });
    const command: PageCommand = { id: ulid(), order: 1, pageId: root.id, actions: [{ kind: 'split', id: block.id, block: sibling, left: block.text, right: '' }, { kind: 'text', id: sibling.id, text: 'Next source' }], inverse: [], before: null, after: null };
    await outbox.put(command);
    await outbox.acknowledge(command, [{ ...sibling, text: 'Next source', revision: 2 }], 2, new Map([[sibling.id, 2]]));
    const recovered = await outbox.cachedPage(root.id);
    expect(recovered?.view.rows.map(row => [row.block.id, row.block.revision])).toEqual([[block.id, 1], [sibling.id, 2]]);
    expect(recovered?.view.rows[1]?.block.text).toBe('Next source');
    expect(recovered?.view.capabilities).toEqual([capability]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('merge acknowledgement removes every tombstone cache and its durable command together', async () => {
  const database = `outbox-merge-${ulid()}`;
  const root = (title: string): Block => {
    const id = ulid();
    return { id, page_id: id, kind: 'page', parent_id: null, text: title, heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  };
  const from = root('Duplicate'), into = root('Survivor');
  const entry: Block = { ...from, id: ulid(), kind: 'block', parent_id: from.id, text: 'Field entry' };
  const command: NotebookCommand = {
    kind: 'notebook', id: ulid(), order: 1, pageId: null, actions: [], inverse: [], before: null, after: null,
    operations: [{ op: 'merge_page', source_id: from.id, source_revision: 1, destination_id: into.id, destination_revision: 1 }],
  };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  try {
    await outbox.page({ root: from, rows: [{ block: entry, depth: 0, manual_types: [] }], targets: [] });
    await outbox.page({ root: into, rows: [], targets: [] });
    await outbox.put(command);
    await outbox.acknowledge(command, [into], 2, new Map([[into.id, 2]]), undefined, [from.id, entry.id]);
    expect(await outbox.cachedPage(from.id)).toBeUndefined();
    expect((await outbox.cachedPage(into.id))?.view.root.id).toBe(into.id);
    expect((await outbox.load()).commands).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('a journal reset invalidates ordered patches without deleting queued commands or recovery pages', async () => {
  const database = `outbox-reset-${ulid()}`;
  const id = ulid();
  const root: Block = { id, page_id: id, kind: 'page', parent_id: null, text: 'Recovery', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  const command: PageCommand = { id: ulid(), order: 1, pageId: id, actions: [{ kind: 'text', id, text: 'Pending local wording' }], inverse: [], before: null, after: null };
  try {
    await outbox.page({ root, rows: [], targets: [] }, 900, 900);
    await outbox.put(command);
    await outbox.resetJournal();
    expect((await outbox.cachedPage(id))?.view.root.text).toBe('Recovery');
    expect((await outbox.cachedPage(id))?.cursor).toBeUndefined();
    expect((await outbox.load()).commands.map(value => value.id)).toEqual([command.id]);
    await outbox.page({ root: { ...root, text: 'Fresh snapshot' }, rows: [], targets: [] }, 3, 3);
    expect((await outbox.cachedPage(id))?.cursor).toBe(3);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('root manual memberships survive cached snapshots and acknowledged page patches', async () => {
  const database = `outbox-root-tags-${ulid()}`;
  const id = ulid();
  const root: Block = { id, page_id: id, kind: 'page', parent_id: null, text: 'Tagged source', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 };
  const outbox = new Outbox('notebook', 'window', error => { throw error; }, database);
  try {
    await outbox.page({ root, root_manual_types: ['History'], rows: [], targets: [] }, 1, 1);
    const command: PageCommand = { id: ulid(), order: 1, pageId: id, actions: [{ kind: 'addType', id, title: 'To read' }], inverse: [{ kind: 'removeType', id, title: 'To read' }], before: null, after: null };
    await outbox.put(command);
    await outbox.acknowledge(command, [{ ...root, revision: 2 }], 2, new Map([[id, 2]]));
    expect((await outbox.cachedPage(id))?.view.root_manual_types).toEqual(['History', 'To read']);
  } finally { await outbox.close(); await deleteDB(database); }
});

test('capture intake survives immediate reload and two windows share one frozen request', async () => {
  const database = `outbox-capture-${ulid()}`;
  const entries = new Map<string, string>();
  const intake = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  const errors: unknown[] = [];
  const first = new Outbox('notebook', 'first-window', error => errors.push(error), database, intake);
  const second = new Outbox('notebook', 'second-window', error => errors.push(error), database, intake);
  const commands: NotebookCommand[] = Array.from({ length: 10 }, (_, index) => ({
    kind: 'notebook', id: ulid(), order: index, pageId: null, operations: [], actions: [], inverse: [], before: null, after: null,
    capture: { date: '2026-10-12', text: `Accepted ${index + 1}`, task, picked: [] },
  }));
  try {
    for (const command of commands) void first.accept(command);
    expect(entries.size).toBe(10);
    expect((await second.load()).commands.map(value => value.id)).toEqual(commands.map(value => value.id));
    const command = commands[0]!;
    const candidates = [{ ...command, frozen: '{"first":"generated IDs"}' }, { ...command, frozen: '{"second":"different IDs"}' }];
    const frozen = await Promise.all([first.freezeCapture(candidates[0]!), second.freezeCapture(candidates[1]!)]);
    expect(frozen[0]?.frozen).toBe(frozen[1]?.frozen);
    expect(entries.size).toBe(9);
    expect((await second.load()).commands.filter(value => value.id === command.id)).toHaveLength(1);
    await first.acknowledge(frozen[0]!, [], 1, new Map());
    expect(await second.freezeCapture(candidates[1]!)).toBeUndefined();
    expect((await second.load()).commands.some(value => value.id === command.id)).toBe(false);
    expect(errors).toEqual([]);
  } finally { await first.close(); await second.close(); await deleteDB(database); }
});

test('a failed synchronous capture intake is not accepted or cleared', async () => {
  const database = `outbox-capture-failed-${ulid()}`;
  const intake = { length: 0, key: () => null, getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('Storage full'); } };
  const outbox = new Outbox('notebook', 'window', () => {}, database, intake);
  const command: NotebookCommand = { kind: 'notebook', id: ulid(), order: 1, pageId: null, operations: [], actions: [], inverse: [], before: null, after: null, capture: { date: '2026-10-12', text: 'Keep these words', task: null, picked: [] } };
  try {
    expect(() => outbox.accept(command)).toThrow('Storage full');
    expect((await outbox.load()).commands).toEqual([]);
  } finally { await outbox.close(); await deleteDB(database); }
});
