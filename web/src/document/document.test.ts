import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import type { Batch, ChangeEvent, FieldKind, Occlusion, Operation, SourceState, TaskState } from '../api/types';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import type { EditResult, NewCitation, PageDocument } from './contract';
import type { Document } from './page-document';
import { boundaryDeletion } from './outline-mechanics';
import { currentReading, questionStatus } from './types';
import { emptyMetadata, fillMissingSourceDetails, saveDetails, saveSourceField, sourceEntries, sourceFieldValue, sourceMetadata } from '../library/details';
import type { SourceCreator, SourceField } from '../library/details';
import { sourceReadingOrder } from '../library/source-order';
import { clipboardText, parseBlockClipboard } from './clipboard';
import { linkMentionEdit } from './link-mention';
import { positionRelations, readingPassages } from '../outline/perspectives';
import { addArrival, embedTarget } from '../outline/streams';
import { isReadingSubject, readingDisagreementRows, readingRegister } from '../outline/read-register';
import { changeRevisit } from '../review/revisits';
import { TaskSourceHistory } from '../tasks/source-history';
import { plainText } from '../outline/names';

const port = Bun.env.TESSERA_TEST_PORT ?? '4330';
const baseUrl = `http://127.0.0.1:${port}`;
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
  process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--workshop', directory, 'serve', '--port', port, '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
  test('revisit actions undo and redo after the acted-on page closes', async () => {
    const instance = await client();
    const { id, doc } = await page(instance);
    await changeRevisit(instance, id, 'later', '2026-10-12');
    const beforeLater = (await api.capabilities(id)).note;
    const later = (await changeRevisit(instance, id, 'later', '2099-01-01'))!;
    doc.release();
    await later.undo();
    expect((await api.capabilities(id)).note).toEqual(beforeLater);
    await later.redo();
    expect((await api.capabilities(id)).note?.revisit_on).toBe('2099-01-01');
    expect(await api.revisitEvents(id)).toEqual([]);

    const beforeResolve = (await api.capabilities(id)).note;
    const resolve = (await changeRevisit(instance, id, 'resolve', null))!;
    await resolve.undo();
    expect((await api.capabilities(id)).note).toEqual(beforeResolve);
    await resolve.redo();
    expect((await api.capabilities(id)).note).toMatchObject({ resolved_at: expect.any(Number), revisit_on: null });
    const beforeReopen = (await api.capabilities(id)).note;
    const reopen = (await changeRevisit(instance, id, 'reopen', null))!;
    await reopen.undo();
    expect((await api.capabilities(id)).note).toEqual(beforeReopen);
    await reopen.redo();
    expect((await api.capabilities(id)).note).toBeNull();
    expect(await api.revisitEvents(id)).toEqual([]);

    const question = await page(instance);
    success(question.doc.edit({ kind: 'question', id: question.id, value: { unsettled: false, parked: false, review_on: '2026-10-12', accepted: null } }));
    await instance.flush();
    question.doc.release();
    for (const action of ['revisited', 'keep_recurrent'] as const) {
      const before = await api.capabilities(question.id);
      const change = (await changeRevisit(instance, question.id, action, '2099-01-01'))!;
      const event = (await api.revisitEvents(question.id))[0]!;
      await change.undo();
      const restored = await api.capabilities(question.id);
      expect(restored.question).toEqual(before.question);
      expect(restored.note).toEqual(before.note);
      expect(await api.revisitEvents(question.id)).toEqual([]);
      await change.redo();
      const redone = await api.capabilities(question.id);
      expect(redone.question?.state).toMatchObject({ unsettled: action === 'keep_recurrent', review_on: '2099-01-01', accepted: null });
      const events = await api.revisitEvents(question.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.id).not.toBe(event.id);
      expect(events[0]?.next_on).toBe('2099-01-01');
      await change.undo();
      expect(await api.revisitEvents(question.id)).toEqual([]);
    }
  });

  test('revisit redo cannot overwrite a newer date after undo', async () => {
    const instance = await client();
    const { id, doc } = await page(instance);
    const change = (await changeRevisit(instance, id, 'later', '2099-01-01'))!;
    await change.undo();
    await changeRevisit(instance, id, 'later', '2099-02-01');
    await expect(change.redo()).rejects.toThrow();
    expect((await api.capabilities(id)).note?.revisit_on).toBe('2099-02-01');
    doc.release();
  });

  test('explicit position link choices are separate undo steps from typing and each other', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Original prose');
    success(doc.edit({ kind: 'text', id: first, text: 'Authored prose' }));
    success(doc.edit({ kind: 'positionLinks', id: first, text: '[[holder]] Authored prose' }));
    success(doc.edit({ kind: 'positionLinks', id: first, text: '[[holder]] [[subject]] Authored prose' }));
    doc.undo();
    expect(doc.block(first)?.text).toBe('[[holder]] Authored prose');
    doc.undo();
    expect(doc.block(first)?.text).toBe('Authored prose');
    await instance.flush();
    doc.release();
  });

  test('integrating a journal subtree keeps identity, a live return reference and atomic undo/redo', async () => {
    const instance = await client();
    const journalId = await instance.journal('2026-10-12');
    const journal = instance.open(journalId);
    await eventually(() => journal.status() === 'ready', 'Journal did not load.');
    const moved = success(journal.edit({ kind: 'insert', parentId: journalId, after: journal.outline.children(journalId).at(-1) ?? null, text: 'A journal thought' })).created[0]!;
    const child = success(journal.edit({ kind: 'insert', parentId: moved, after: null, text: 'Its evidence' })).created[0]!;
    await instance.flush();
    const destination = await page(instance, 'Existing concept text');
    const change = await instance.integrateBlock(moved, destination.id);
    expect(journal.block(moved)).toBeUndefined();
    expect(destination.doc.block(moved)?.parentId).toBe(destination.id);
    expect(destination.doc.block(child)?.parentId).toBe(moved);
    const reference = journal.outline.children(journalId).find(id => journal.block(id)?.text === `[[${moved}]]`)!;
    expect(reference).toBeDefined();
    const edit = destination.doc.edit({ kind: 'text', id: moved, text: 'Revised integrated thought' });
    expect(edit.ok).toBe(true);
    await instance.flush();
    expect(instance.lookup(moved)()?.text).toBe('Revised integrated thought');
    await change.undo();
    expect(journal.block(moved)?.text).toBe('Revised integrated thought');
    expect(journal.block(child)?.parentId).toBe(moved);
    expect(journal.block(reference)).toBeUndefined();
    await change.redo();
    expect(destination.doc.block(moved)?.parentId).toBe(destination.id);
    expect(journal.block(reference)?.text).toBe(`[[${moved}]]`);
    await (journal as Document).reload(false); await (destination.doc as Document).reload(false);
    expect(destination.doc.block(child)?.parentId).toBe(moved);
    expect(journal.block(reference)?.text).toBe(`[[${moved}]]`);
    await change.undo();
    journal.release(); destination.doc.release();
  });

  test('integration rejects descendants and never overwrites an edited return reference', async () => {
    const instance = await client();
    const journalId = await instance.journal('2026-10-13');
    const doc = instance.open(journalId);
    await eventually(() => doc.status() === 'ready', 'Journal did not load.');
    const moved = success(doc.edit({ kind: 'insert', parentId: journalId, after: null, text: 'Thought' })).created[0]!;
    const child = success(doc.edit({ kind: 'insert', parentId: moved, after: null, text: 'Child' })).created[0]!;
    await instance.flush();
    await expect(instance.integrateBlock(moved, child)).rejects.toThrow('own subtree');
    const destination = await page(instance);
    const change = await instance.integrateBlock(moved, destination.id);
    const reference = doc.outline.children(journalId).find(id => doc.block(id)?.text === `[[${moved}]]`)!;
    success(doc.edit({ kind: 'text', id: reference, text: 'An authored replacement' }));
    await instance.flush();
    await expect(change.undo()).rejects.toThrow('reference changed');
    expect(doc.block(reference)?.text).toBe('An authored replacement');
    expect(destination.doc.block(child)?.parentId).toBe(moved);
    doc.release(); destination.doc.release();
  });

  test('a journal block becomes a project page with its children, a link back, and atomic undo/redo', async () => {
    const instance = await client();
    const journalId = await instance.journal('2026-10-14');
    const journal = instance.open(journalId);
    await eventually(() => journal.status() === 'ready', 'Journal did not load.');
    const title = `Build the shed ${++serial}`;
    const row = success(journal.edit({ kind: 'insert', parentId: journalId, after: journal.outline.children(journalId).at(-1) ?? null, text: title })).created[0]!;
    const first = success(journal.edit({ kind: 'insert', parentId: row, after: null, text: 'Buy timber' })).created[0]!;
    const second = success(journal.edit({ kind: 'insert', parentId: row, after: first, text: 'Pour the base' })).created[0]!;
    await instance.flush();
    const { pageId, change } = await instance.promoteToProject(row, title);
    const projectIds = async () => (await api.projects()).map(project => project.block_id);
    expect(await projectIds()).toContain(pageId);
    expect((await api.block(pageId)).text).toBe(title);
    expect((await api.page(pageId)).rows.filter(entry => entry.depth === 0).map(entry => entry.block.id)).toEqual([first, second]);
    expect(journal.block(row)?.text).toBe(`[[${pageId}]]`);
    await change.undo();
    expect(journal.block(row)?.text).toBe(title);
    expect(journal.outline.children(row)).toEqual([first, second]);
    expect(await projectIds()).not.toContain(pageId);
    expect(await instance.pageByTitle(title, false)).toBeNull();
    await change.redo();
    expect(await projectIds()).toContain(pageId);
    expect((await api.page(pageId)).rows.filter(entry => entry.depth === 0).map(entry => entry.block.id)).toEqual([first, second]);
    expect(journal.block(row)?.text).toBe(`[[${pageId}]]`);
    journal.release();
  });

  test('promoting reuses an existing page of that title and keeps its writing first', async () => {
    const instance = await client();
    const existing = await page(instance, 'Earlier notes');
    const title = (await api.block(existing.id)).text;
    const journalId = await instance.journal('2026-10-15');
    const journal = instance.open(journalId);
    await eventually(() => journal.status() === 'ready', 'Journal did not load.');
    const row = success(journal.edit({ kind: 'insert', parentId: journalId, after: null, text: title })).created[0]!;
    const child = success(journal.edit({ kind: 'insert', parentId: row, after: null, text: 'A new task' })).created[0]!;
    await instance.flush();
    const { pageId, change } = await instance.promoteToProject(row, title);
    expect(pageId).toBe(existing.id);
    expect((await api.page(pageId)).rows.filter(entry => entry.depth === 0).map(entry => entry.block.id)).toEqual([existing.first, child]);
    expect((await api.projects()).map(project => project.block_id)).toContain(pageId);
    await change.undo();
    expect((await api.projects()).map(project => project.block_id)).not.toContain(pageId);
    expect((await api.block(pageId)).text).toBe(title);
    expect(journal.outline.children(row)).toEqual([child]);
    journal.release(); existing.doc.release();
  });

  test('acknowledged notebook creation publishes canonical roots before opening', async () => {
    const instance = await client();
    const id = ulid(), typeId = ulid(), title = `Cache type ${++serial}`;
    await instance.commit([
      { op: 'create_page', id: typeId, title },
      { op: 'create_page', id, title: `Cache member ${++serial}` },
      { op: 'add_type', id, base_revision: 1, title },
    ], 'Create typed page');
    const canonical = await api.block(id);
    expect(instance.roots().find(root => root.id === id)).toEqual(canonical);
    expect(instance.roots().find(root => root.id === typeId)).toEqual(await api.block(typeId));
    const doc = instance.open(id);
    await eventually(() => doc.status() === 'ready', 'typed page did not open');
    expect(instance.roots().find(root => root.id === id)?.id).toBe(doc.root()?.id);
    doc.release();
  });

  test('spread capability and ordinary column subtrees share undo and redo', async () => {
    const instance = await client();
    const notes = [ulid(), ulid(), ulid()];
    const spread = ulid(), refs = [ulid(), ulid(), ulid()], commentary = ulid();
    await instance.commit([
      ...notes.map((id, i) => ({ op: 'create_page' as const, id, title: `Spread ${++serial} note ${i}` })),
      { op: 'create_page', id: spread, title: `Spread ${++serial}` },
      { op: 'set_spread', id: spread, base_revision: 1, spread: true },
      ...notes.map((id, i) => ({ op: 'insert' as const, id: refs[i]!, parent_id: spread, after: refs[i - 1] ?? null, text: `[[${id}]]`, heading: null })),
      { op: 'insert', id: commentary, parent_id: refs[0]!, after: null, text: 'Column commentary', heading: null },
    ]);
    const doc = instance.open(spread);
    await eventually(() => doc.status() === 'ready', 'spread did not load');
    expect(doc.root()?.spread).toBe(true);
    success(doc.edit({ kind: 'moveTo', ids: [refs[1]!], parentId: spread, after: null }));
    await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual([notes[1]!, notes[0]!, notes[2]!]);
    doc.undo(); await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual(notes);
    success(doc.edit({ kind: 'delete', ids: [refs[0]!] }));
    await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual(notes.slice(1));
    expect(doc.block(commentary)).toBeUndefined();
    doc.undo(); await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual(notes);
    expect(doc.block(commentary)?.text).toBe('Column commentary');
    success(doc.edit({ kind: 'moveTo', ids: [refs[1]!], parentId: spread, after: null }));
    await instance.flush();
    success(doc.edit({ kind: 'delete', ids: [refs[0]!] }));
    await instance.flush();
    success(doc.edit({ kind: 'moveTo', ids: [refs[2]!], parentId: spread, after: null }));
    await instance.flush();
    doc.undo(); await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual([notes[1]!, notes[2]!]);
    doc.undo(); await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual([notes[1]!, notes[0]!, notes[2]!]);
    expect(doc.block(commentary)?.text).toBe('Column commentary');
    doc.undo(); await instance.flush();
    expect((await api.savedSpread(spread)).note_ids).toEqual(notes);
    success(doc.edit({ kind: 'spread', id: spread, value: false }));
    await instance.flush();
    expect((await api.capabilities(spread)).spread).toBe(false);
    doc.undo(); await instance.flush();
    expect((await api.capabilities(spread)).spread).toBe(true);
    doc.redo(); await instance.flush();
    expect((await api.capabilities(spread)).spread).toBe(false);
    doc.release();
  });

  test('all accepted quick captures survive reload before delivery and keep their plans', async () => {
    const session = `capture-recovery-${++serial}`;
    const instance = await client(session);
    const marker = `Capture recovery ${++serial}`;
    const task: TaskState = { status: 'todo', scheduled: instance.todayDate(), scheduled_time: '10:00', deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Browser offline'); }, { preconnect: actualFetch.preconnect });
    try {
      await Promise.all(Array.from({ length: 10 }, (_, index) => instance.appendCapture(`${marker} ${index + 1}`, task)));
      expect(instance.queuedChanges()).toBe(10);
      expect(instance.unsavedText()).toContain(`${marker} 10`);
      await instance.dispose();
      globalThis.fetch = actualFetch;
      const recovered = await client(session);
      await recovered.flush();
      const journal = await api.journal(task.scheduled!);
      const view = await api.page(journal.id);
      const captures = view.rows.filter(row => row.block.text.startsWith(marker));
      expect(captures.map(row => row.block.text)).toEqual(Array.from({ length: 10 }, (_, index) => `${marker} ${index + 1}`));
      expect(captures.every(row => view.capabilities?.find(value => value.block_id === row.block.id)?.task?.scheduled_time === '10:00')).toBe(true);
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('under-page question captures survive reload and reuse only the empty tail', async () => {
    const session = `capture-under-${++serial}`;
    const instance = await client(session);
    const pageId = await instance.createPage(`Capture destination ${serial}`);
    await instance.flush();
    const first = ulid(), empty = (await api.page(pageId)).rows.at(-1)!.block.id;
    await instance.commit([{ op: 'insert', id: first, parent_id: pageId, after: null, text: 'Keep the first line', heading: null }]);
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new TypeError('Browser offline'); }, { preconnect: actualFetch.preconnect });
    try {
      await instance.appendCapture('Where does this belong?', null, [], { targetPageId: pageId, question: true });
      await instance.dispose();
      globalThis.fetch = actualFetch;
      const recovered = await client(session);
      await recovered.flush();
      const page = await api.page(pageId);
      expect(page.rows.find(row => row.block.id === empty)?.block.text).toBe('Where does this belong?');
      expect(page.capabilities?.find(value => value.block_id === empty)?.question?.state).toMatchObject({ unsettled: false, parked: false, accepted: null, review_on: null });
      expect(page.rows.find(row => row.block.id === first)?.block.text).toBe('Keep the first line');
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('capture receipt opens the acknowledged row and undo restores a reused empty block', async () => {
    const instance = await client();
    const pageId = await instance.createPage(`Capture receipt ${++serial}`);
    await instance.flush();
    const empty = (await api.page(pageId)).rows.at(-1)!.block.id;
    const receipt = await instance.appendCapture('A question?', null, [], { targetPageId: pageId, question: true });
    await instance.flush();
    const result = await receipt.delivered;
    expect(result?.pageId).toBe(pageId);
    expect(result?.blockId).toBe(empty);
    await result!.undo();
    expect((await api.block(empty)).text).toBe('');
    expect((await api.capabilities(empty)).question).toBeNull();
  });

  test('capture retry keeps its frozen identity after a lost acknowledgement without duplicating text', async () => {
    const session = `capture-ack-${++serial}`;
    const instance = await client(session);
    const title = `Capture target ${++serial}`;
    const text = `Capture once [[${title}]]`;
    let lost = false;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== `${baseUrl}/api/batches` || init?.method !== 'POST' || !String(init.body).includes('Add to today')) return actualFetch(input, init);
      if (!lost) { lost = true; await actualFetch(input, init); }
      throw new TypeError('Lost capture acknowledgement');
    }, { preconnect: actualFetch.preconnect });
    try {
      await instance.appendCapture(text, null);
      await instance.flush();
      expect(lost).toBe(true);
      await instance.dispose();
      globalThis.fetch = actualFetch;
      const recovered = await client(session);
      await recovered.flush();
      const target = await api.pageByTitle(title);
      const view = await api.page((await api.journal(recovered.todayDate())).id);
      expect(view.rows.filter(row => row.block.text === `Capture once [[${target.id}|${title}]]`)).toHaveLength(1);
      expect(recovered.queuedChanges()).toBe(0);
    } finally { globalThis.fetch = actualFetch; }
  });

  test('two windows deliver one shared capture with an identical idempotent request', async () => {
    const first = await client();
    const text = `Two-window capture ${++serial}`;
    const gate = Promise.withResolvers<void>();
    const bodies: string[] = [];
    const receipts: boolean[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== `${baseUrl}/api/batches` || init?.method !== 'POST' || !String(init.body).includes('Add to today')) return actualFetch(input, init);
      bodies.push(String(init.body));
      if (bodies.length === 1) await gate.promise;
      const response = await actualFetch(input, init);
      receipts.push((await response.clone().json()).replayed);
      return response;
    }, { preconnect: actualFetch.preconnect });
    let delivery: Promise<void> | undefined;
    try {
      await first.appendCapture(text, null);
      delivery = first.flush();
      await eventually(() => bodies.length === 1, 'First capture did not reach delivery');
      const second = await client();
      await second.flush();
      gate.resolve();
      await delivery;
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(receipts.sort()).toEqual([false, true]);
      const view = await api.page((await api.journal(first.todayDate())).id);
      expect(view.rows.filter(row => row.block.text === text)).toHaveLength(1);
      expect(first.queuedChanges()).toBe(0);
      expect(second.queuedChanges()).toBe(0);
    } finally { gate.resolve(); await delivery; globalThis.fetch = actualFetch; }
  });

  test('linking a mention uses source-page undo and redo after release', async () => {
    const instance = await client();
    const target = await instance.createPage(`Mention target ${++serial}`);
    const text = 'A MENTION here, then another mention.';
    const { id, doc, first } = await page(instance, text);
    const edit = linkMentionEdit(first, doc.block(first)!.text, target, 'mention');
    expect(edit).not.toBeNull();
    success(doc.edit(edit!));
    await doc.flush();
    expect((await api.block(first)).text).toBe(`A [[${target}|MENTION]] here, then another mention.`);
    doc.release();
    const source = instance.open(id);
    source.undo(); await source.flush();
    expect((await api.block(first)).text).toBe(text);
    source.redo(); await source.flush();
    expect((await api.block(first)).text).toBe(`A [[${target}|MENTION]] here, then another mention.`);
    source.release();
  });
  test('card holds undo and redo after definition edits without changing source revisions', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Front <> Back');
    const original = await api.sourceCards(first);
    const sourceRevision = doc.block(first)!.revision;
    success(doc.edit({ kind: 'cardHeld', cards: original, held: true }));
    await doc.flush();
    expect((await api.sourceCards(first)).every(card => card.held)).toBe(true);
    expect(doc.block(first)!.revision).toBe(sourceRevision);
    doc.undo(); await doc.flush();
    expect((await api.sourceCards(first)).every(card => !card.held)).toBe(true);
    doc.redo(); await doc.flush();
    expect((await api.sourceCards(first)).every(card => card.held)).toBe(true);
    success(doc.edit({ kind: 'text', id: first, text: 'Front <> Changed answer' }));
    await doc.flush();
    expect((await api.sourceCards(first)).every(card => card.held)).toBe(true);
    doc.undo(); await doc.flush();
    doc.undo(); await doc.flush();
    const undone = await api.sourceCards(first);
    expect(undone.every(card => !card.held)).toBe(true);
    expect(undone.map(card => card.schedule)).toEqual(original.map(card => card.schedule));
    doc.redo(); await doc.flush();
    expect((await api.sourceCards(first)).every(card => card.held)).toBe(true);
    const held = (await api.sourceCards(first))[0]!;
    await instance.commit([{ op: 'reset_card', id: held.id, base_revision: held.revision, event_id: ulid(), session_id: null, reviewed_at: Date.now() }]);
    expect((await api.sourceCards(first)).every(card => card.held)).toBe(true);
    doc.undo(); await doc.flush();
    expect((await api.sourceCards(first)).every(card => !card.held)).toBe(true);
    doc.release();
  });

  test('quote capture commits text and frozen subtree together and update undo restores its previous snapshot', async () => {
    const instance = await client();
    const source = await page(instance, 'Parent');
    const child = success(source.doc.edit({ kind: 'insert', parentId: source.first, after: null, text: 'Nested source' })).created[0]!;
    const grandchild = success(source.doc.edit({ kind: 'insert', parentId: child, after: null, text: 'Frozen child' })).created[0]!;
    success(source.doc.edit({ kind: 'heading', id: child, level: 2 }));
    await instance.flush();
    const target = await page(instance, '((Nested))');
    const snapshot = await api.quoteSnapshot(child);
    const text = `((${child}))`;
    success(target.doc.edit({ kind: 'quote', id: target.first, text, value: snapshot }));
    expect(target.doc.block(target.first)?.text).toBe(text);
    expect(target.doc.block(target.first)?.quote).toEqual(snapshot);
    expect(instance.commands(target.id).at(-1)?.actions.map(action => action.kind)).toEqual(['text', 'quote']);
    await instance.flush();
    expect((await api.capabilities(target.first)).quote).toEqual(snapshot);
    expect((await api.page(target.id)).capabilities?.find(value => value.block_id === target.first)?.quote).toEqual(snapshot);
    target.doc.undo(); await instance.flush();
    expect(target.doc.block(target.first)?.text).toBe('((Nested))');
    expect((await api.capabilities(target.first)).quote).toBeNull();
    target.doc.redo(); await instance.flush();
    expect(target.doc.block(target.first)?.quote).toEqual(snapshot);
    const otherWindow = await client();
    const shared = otherWindow.open(target.id);
    await eventually(() => shared.status() === 'ready', shared.statusMessage());
    expect(shared.block(target.first)?.quote).toEqual(snapshot);
    success(source.doc.edit({ kind: 'text', id: grandchild, text: 'Changed child' }));
    await instance.flush();
    expect(target.doc.block(target.first)?.quote?.rows.map(row => [row.depth, row.text, row.heading])).toEqual([[0, 'Nested source', 2], [1, 'Frozen child', null]]);
    expect((await api.quoteStatus(target.id))[0]).toMatchObject({ block_id: target.first, source_live: true, changed: true });
    const updated = await api.quoteSnapshot(child);
    success(target.doc.edit({ kind: 'quote', id: target.first, value: updated }));
    await instance.flush();
    await eventually(() => shared.block(target.first)?.quote?.captured_at === updated.captured_at, 'Updated quote did not arrive');
    expect(target.doc.block(target.first)?.quote?.rows[1]?.text).toBe('Changed child');
    target.doc.undo(); await instance.flush();
    expect((await api.capabilities(target.first)).quote).toEqual(snapshot);
    await eventually(() => shared.block(target.first)?.quote?.captured_at === snapshot.captured_at, 'Quote undo did not arrive');
    target.doc.redo(); await instance.flush();
    expect((await api.capabilities(target.first)).quote).toEqual(updated);
    success(source.doc.edit({ kind: 'delete', ids: [child] }));
    await instance.flush();
    expect((await api.quoteStatus(target.id))[0]).toMatchObject({ source_live: false, changed: true });
    expect((await api.capabilities(target.first)).quote).toEqual(updated);
    source.doc.release(); target.doc.release(); shared.release();
  });

  test('card template no-op saves do not enqueue empty batches and Apply travels through history', async () => {
    const instance = await client();
    const { id, doc } = await page(instance);
    const templateId = ulid();
    const value = { type_id: id, name: 'Recognition', front: 'Front', back: 'Back', applied: false, new_per_day: 2 };
    success(doc.edit({ kind: 'cardTemplate', id: templateId, previous: null, value }));
    await instance.flush();
    const previous = (await api.cardTemplates(id))[0]!;
    const bodies: Batch[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'cardTemplate', id: templateId, previous, value }));
      await instance.flush();
      expect(bodies).toHaveLength(0);
      success(doc.edit({ kind: 'cardTemplate', id: templateId, previous, value: { ...value, applied: true } }));
      await instance.flush();
      expect(bodies[0]!.operations.map(operation => operation.op)).toEqual(['set_card_template_applied']);
      expect((await api.cardTemplates(id))[0]!.applied).toBe(true);
      doc.undo();
      await instance.flush();
      expect((await api.cardTemplates(id))[0]!.applied).toBe(false);
      doc.redo();
      await instance.flush();
      expect((await api.cardTemplates(id))[0]!.applied).toBe(true);
      expect(bodies).toHaveLength(3);
      success(doc.edit({ kind: 'cardTemplate', id: templateId, previous: (await api.cardTemplates(id))[0]!, value: null }));
      await instance.flush();
      expect(await api.cardTemplates(id)).toHaveLength(0);
      doc.undo();
      await instance.flush();
      expect((await api.cardTemplates(id))[0]!.id).toBe(templateId);
      expect((await api.cardTemplates(id))[0]!.applied).toBe(true);
      doc.redo();
      await instance.flush();
      expect(await api.cardTemplates(id)).toHaveLength(0);
    } finally { globalThis.fetch = actualFetch; doc.release(); }
  });

  test('kept-copy choices each save in one batch and undo restores both versions', async () => {
    for (const choice of ['use', 'discard', 'both'] as const) {
      const instance = await client();
      const { id, doc, first } = await page(instance, 'Base wording');
      const base = await api.block(first);
      const headers = { 'Content-Type': 'application/json', 'x-tessera-schema': String((await api.notebook()).schema_version) };
      const clone = await actualFetch(`${baseUrl}/api/sync/clone`, { method: 'POST', headers });
      expect(clone.ok).toBe(true);
      const ticket = JSON.parse(clone.headers.get('x-tessera-clone')!) as { device_id: string };
      await clone.arrayBuffer();
      success(doc.edit({ kind: 'text', id: first, text: 'Notebook wording' }));
      await instance.flush();
      const push = await actualFetch(`${baseUrl}/api/sync/push`, {
        method: 'POST', headers,
        body: JSON.stringify({ device: ticket.device_id, changes: [{
          stamp: { id: ulid(), origin: ticket.device_id, at: Date.now() },
          batch: { actor: { kind: 'person' }, operations: [{ op: 'edit_text', id: first, base_revision: base.revision, text: 'Phone wording' }] },
          bases: { [first]: base.text },
        }] }),
      });
      expect(push.ok).toBe(true);
      const copy = (await api.page(id)).rows.find(row => row.block.kept_copy)!.block;
      await eventually(() => !!doc.block(copy.id)?.keptCopy, 'kept copy did not stream into the open page');
      const bodies: Batch[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
        return actualFetch(input, init);
      }) as typeof fetch;
      try {
        success(doc.edit({ kind: 'keptCopy', id: copy.id, choice }));
        await instance.flush();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]!.operations.map(operation => operation.op)).toEqual(choice === 'use' ? ['edit_text', 'delete'] : choice === 'discard' ? ['delete'] : ['settle_sync_copy']);
        expect((await api.block(first)).text).toBe(choice === 'use' ? 'Phone wording' : 'Notebook wording');
        if (choice === 'both') {
          expect(doc.block(copy.id)?.keptCopy).toBeNull();
          expect((await api.block(copy.id)).kept_copy).toBeNull();
        } else expect((await api.page(id)).rows.some(row => row.block.id === copy.id)).toBe(false);
        doc.undo();
        await instance.flush();
        expect(bodies).toHaveLength(2);
        expect((await api.block(first)).text).toBe('Notebook wording');
        expect((await api.block(copy.id)).text).toBe('Phone wording');
        expect((await api.block(copy.id)).kept_copy).toEqual(copy.kept_copy);
        expect(doc.block(copy.id)?.keptCopy).toEqual(copy.kept_copy);
        doc.redo();
        await instance.flush();
        expect(bodies).toHaveLength(3);
        if (choice === 'both') {
          success(doc.edit({ kind: 'text', id: copy.id, text: 'Ordinary editable text' }));
          await instance.flush();
          expect((await api.block(copy.id)).text).toBe('Ordinary editable text');
          doc.undo();
          await instance.flush();
          doc.undo();
          await instance.flush();
          const otherPage = ulid();
          await api.submit({ actor: { kind: 'person' }, operations: [
            { op: 'create_page', id: otherPage, title: `Moved original ${++serial}` },
            { op: 'move', id: first, base_revision: (await api.block(first)).revision, parent_id: otherPage, after: null },
          ] });
          await (doc as Document).reload();
          expect(doc.block(first)).toBeUndefined();
          const queued = instance.queuedChanges();
          expect(doc.edit({ kind: 'keptCopy', id: copy.id, choice: 'use' })).toEqual({ ok: false, reason: 'The original is not on this atom. Both versions are unchanged.' });
          expect(instance.queuedChanges()).toBe(queued);
          expect((await api.block(first)).text).toBe('Notebook wording');
          expect((await api.block(copy.id)).text).toBe('Phone wording');
          expect(doc.block(copy.id)?.keptCopy).toEqual(copy.kept_copy);
        }
      } finally { globalThis.fetch = actualFetch; doc.release(); }
    }
  });

  test('own tag saves remove provisional pages from live and recovery caches', async () => {
    for (const viaNotebook of [false, true]) {
      const instance = await client();
      const { doc, first } = await page(instance);
      const tag = `provisional${++serial}`;
      success(doc.edit({ kind: 'text', id: first, text: `#${tag}` }));
      await instance.flush();
      const target = await api.pageByTitle(tag);
      expect(target).not.toBeNull();
      const lookup = instance.lookup(target!.id);
      await eventually(() => lookup()?.id === target!.id, 'type lookup did not load');
      expect(instance.roots().some(root => root.id === target!.id)).toBe(true);
      const requested: string[] = [];
      const readBlock = instance.api.block;
      instance.api.block = id => { requested.push(id); return readBlock(id); };
      if (viaNotebook) {
        await instance.commit([{ op: 'edit_text', id: first, base_revision: (await api.block(first)).revision, text: '' }]);
      } else {
        success(doc.edit({ kind: 'text', id: first, text: '' }));
        await instance.flush();
      }
      instance.api.block = readBlock;
      expect(requested).not.toContain(target!.id);
      await expect(api.pageByTitle(tag)).rejects.toMatchObject({ status: 404 });
      expect((await api.complete(tag)).some(block => block.id === target!.id)).toBe(false);
      expect(lookup()).toBeNull();
      expect(instance.roots().some(root => root.id === target!.id)).toBe(false);
      doc.release();
    }
  });

  test('a tag stays editable across an idle pause until the word is finished', async () => {
    const instance = await client();
    const { doc, first } = await page(instance);
    const saved = (await api.block(first)).text;
    const tag = `held${++serial}`;
    for (let end = 2; end <= tag.length + 1; end++) {
      success(doc.edit({ kind: 'text', id: first, text: `#${tag.slice(0, end - 1)}` }));
      doc.holdTag(first, true);
    }
    // This real-service/outbox integration crosses the former 3 s idle deadline on the platform clock.
    await Bun.sleep(3500);
    expect((await api.block(first)).text).toBe(saved);
    await expect(api.pageByTitle(tag)).rejects.toMatchObject({ status: 404 });
    expect(doc.saveState()).not.toBe('saved');
    const completed = `${tag}continuation`;
    success(doc.edit({ kind: 'text', id: first, text: `#${completed} ` }));
    doc.holdTag(first, false);
    await eventually(() => doc.saveState() === 'saved', 'the finished tag did not save');
    const target = await api.pageByTitle(completed);
    await expect(api.pageByTitle(tag)).rejects.toMatchObject({ status: 404 });
    expect((await api.block(first)).text).toBe(`#[[${target.id}|${completed}]] `);
    expect(doc.block(first)?.text).toBe(`#[[${target.id}|${completed}]] `);
    doc.release();
  });

  test('a hand-typed tag receipt updates the open document and preserves the redo caret', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    const title = `CaretTag${++serial}`, text = `read #${title}`;
    const before = { id: first, offset: 4 };
    success(doc.edit({ kind: 'text', id: first, text, caret: text.length, group: 91 }, before));
    await instance.flush();
    const target = await api.pageByTitle(title);
    const canonical = `read #[[${target.id}|${title}]]`;
    expect(doc.block(first)?.text).toBe(canonical);
    expect((await api.block(first)).text).toBe(canonical);
    expect(doc.undo()).toEqual(before);
    await instance.flush();
    expect(doc.block(first)?.text).toBe('base');
    await expect(api.pageByTitle(title)).rejects.toMatchObject({ status: 404 });
    expect(doc.redo()).toEqual({ id: first, offset: canonical.length });
    await instance.flush();
    expect(doc.block(first)?.text).toBe(canonical);
    expect((await api.pageByTitle(title)).id).toBe(target.id);
    expect((await api.members(target.id)).map(row => row.block.id)).toContain(first);
    doc.undo(); await doc.flush();
    doc.redo(); await doc.flush();
    expect((await api.pageByTitle(title)).id).toBe(target.id);
    expect((await api.members(target.id)).map(row => row.block.id)).toContain(first);
    doc.release();
  });

  test('queued splits rebase both halves, continuations and history bounds through tag receipts', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance, 'base');
    const a = `SplitLeft${++serial}`, b = `SplitRight${++serial}`;
    const text = `QA #${a} middle #${b} tail`, offset = text.indexOf(' middle');
    const before = { id: first, offset, range: { anchor: { id: first, offset: 0 }, head: { id: first, offset: text.length } } };
    const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const submit = instance.api.submitFrozen;
    const requests: Batch[] = [];
    instance.api.submitFrozen = async frozen => {
      requests.push(JSON.parse(frozen));
      const ack = await submit(frozen);
      if (requests.length === 1) { received.resolve(); await release.promise; }
      return ack;
    };
    try {
      success(doc.edit({ kind: 'text', id: first, text }));
      const saving = instance.flush();
      await received.promise;
      const right = success(doc.edit({ kind: 'split', id: first, offset }, before)).created[0]!;
      release.resolve();
      await saving;
      const leftText = `QA #[[${(await api.pageByTitle(a)).id}|${a}]]`;
      const rightText = ` middle #[[${(await api.pageByTitle(b)).id}|${b}]] tail`;
      const split = requests.flatMap(batch => batch.operations).find(operation => operation.op === 'split');
      expect(split).toMatchObject({ id: first, new_id: right, left: leftText, right: rightText });
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual([leftText, rightText]);
      expect(doc.block(right)?.text).toBe(rightText);
      expect(doc.undo()).toEqual({ id: first, offset: leftText.length, range: { anchor: { id: first, offset: 0 }, head: { id: first, offset: leftText.length + rightText.length } } });
      await instance.flush();
      expect((await api.block(first)).text).toBe(leftText + rightText);
      doc.redo();
      await instance.flush();
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual([leftText, rightText]);
      expect(instance.queuedChanges()).toBe(0);
    } finally { release.resolve(); instance.api.submitFrozen = submit; doc.release(); }
  });

  test('queued merges retain both normalized texts and their separate undo snapshots', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance, 'destination');
    const source = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'source' })).created[0]!;
    await instance.flush();
    const a = `MergeLeft${++serial}`, b = `MergeRight${++serial}`;
    const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const submit = instance.api.submitFrozen;
    let held = false;
    instance.api.submitFrozen = async frozen => {
      const ack = await submit(frozen);
      if (!held) { held = true; received.resolve(); await release.promise; }
      return ack;
    };
    try {
      success(doc.edit({ kind: 'text', id: first, text: `Left #${a}` }));
      const saving = instance.flush();
      await received.promise;
      success(doc.edit({ kind: 'text', id: source, text: ` Right #${b}` }));
      success(doc.edit({ kind: 'merge', sourceId: source, destinationId: first }, { id: source, offset: 0 }));
      release.resolve();
      await saving;
      const leftText = `Left #[[${(await api.pageByTitle(a)).id}|${a}]]`;
      const rightText = ` Right #[[${(await api.pageByTitle(b)).id}|${b}]]`;
      expect(doc.block(first)?.text).toBe(leftText + rightText);
      expect((await api.block(first)).text).toBe(leftText + rightText);
      doc.undo();
      await instance.flush();
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual([leftText, rightText]);
      expect(instance.queuedChanges()).toBe(0);
    } finally { release.resolve(); instance.api.submitFrozen = submit; doc.release(); }
  });

  test('a queued restore rebases its deleted snapshot through the preceding tag receipt', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    const title = `RestoreTag${++serial}`, text = `Kept #${title}`;
    await instance.createPage(title); // Exercise snapshots independently of provisional-tag page undo.
    const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const submit = instance.api.submitFrozen;
    let held = false;
    instance.api.submitFrozen = async frozen => {
      const ack = await submit(frozen);
      if (!held) { held = true; received.resolve(); await release.promise; }
      return ack;
    };
    try {
      success(doc.edit({ kind: 'text', id: first, text }));
      const saving = instance.flush();
      await received.promise;
      success(doc.edit({ kind: 'delete', ids: [first] }));
      doc.undo();
      release.resolve();
      await saving;
      const canonical = `Kept #[[${(await api.pageByTitle(title)).id}|${title}]]`;
      expect(doc.block(first)?.text).toBe(canonical);
      expect((await api.block(first)).text).toBe(canonical);
      expect(instance.queuedChanges()).toBe(0);
    } finally { release.resolve(); instance.api.submitFrozen = submit; doc.release(); }
  });

  test('outbox replay rebases pending splits after replaying a lost tag rewrite receipt', async () => {
    const session = `rewrite-replay-${++serial}`, instance = await client(session);
    const { id, doc, first } = await page(instance, 'base');
    const title = `ReplayTag${++serial}`, text = `QA #${title} `;
    const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const requests: string[] = [];
    let lose = true;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') {
        requests.push(String(init.body));
        if (lose) { lose = false; received.resolve(); await release.promise; throw new TypeError('Lost tag receipt'); }
      }
      return response;
    }, { preconnect: actualFetch.preconnect });
    try {
      success(doc.edit({ kind: 'text', id: first, text }));
      const saving = instance.flush();
      await received.promise;
      const right = success(doc.edit({ kind: 'split', id: first, offset: text.length })).created[0]!;
      success(doc.edit({ kind: 'text', id: right, text: 'next row' }));
      const third = success(doc.edit({ kind: 'split', id: right, offset: 8 })).created[0]!;
      success(doc.edit({ kind: 'text', id: third, text: 'third row' }));
      release.resolve();
      await saving;
      await instance.dispose();
      const recovered = await client(session), reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'tag rewrite outbox did not reopen');
      await recovered.flush();
      const canonical = `QA #[[${(await api.pageByTitle(title)).id}|${title}]] `;
      expect(requests[1]).toBe(requests[0]);
      expect((JSON.parse(requests[2]!) as Batch).operations).toContainEqual(expect.objectContaining({ op: 'split', id: first, left: canonical, right: '' }));
      expect((await api.page(id)).rows.map(row => row.block.text)).toEqual([canonical, 'next row', 'third row']);
      expect(ids(reopened)).toEqual([first, right, third]);
      expect(recovered.queuedChanges()).toBe(0);
      reopened.release();
    } finally { release.resolve(); globalThis.fetch = actualFetch; }
  });

  test('tag redo queued before its undo receipt restores the pruned target', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'base');
    const title = `QueuedTag${++serial}`;
    success(doc.edit({ kind: 'text', id: first, text: `read #${title}`, group: 92 }));
    await doc.flush();
    const target = await api.pageByTitle(title);
    const canonical = doc.block(first)!.text;
    const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input).endsWith('/api/batches') && init?.body
        && (JSON.parse(String(init.body)) as Batch).operations.some(operation => operation.op === 'edit_text' && operation.id === first && operation.text === 'base')) {
        reached.resolve();
        await gate.promise;
      }
      return response;
    }) as typeof fetch;
    try {
      doc.undo();
      const saving = doc.flush();
      await reached.promise;
      doc.redo();
      gate.resolve();
      await saving;
      await doc.flush();
      expect((await api.pageByTitle(title)).id).toBe(target.id);
      expect((await api.block(first)).text).toBe(canonical);
      expect((await api.members(target.id)).map(row => row.block.id)).toContain(first);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; doc.release(); }
  });

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
    expect(doc.saveState()).toBe('saved');
    expect((await api.fields()).fields.find(field => field.id === id)).toMatchObject({ id, name, kind: 'number' });
    expect((await api.page(fields.page_id)).rows.find(row => row.block.id === id)?.block.text).toBe(name);
    doc.release();
  });

  test('adding a reading keeps attribution and its Gist together through undo and reload', async () => {
    const instance = await client();
    const fields = await api.fields();
    const gist = fields.fields.find(field => field.name === 'Gist')?.id;
    const register = instance.open(fields.page_id);
    await eventually(() => register.status() === 'ready', register.statusMessage());
    const gistId = gist ?? success(register.edit({ kind: 'addField', name: 'Gist', value: 'text' })).created[0]!;
    await instance.flush();
    const holder = await instance.createPage(`Reading holder ${++serial}`);
    const { id, doc, first } = await page(instance, 'Opening');
    const result = success(doc.edit({ kind: 'addReading', parentId: id, after: first, holderId: holder, gistFieldId: gistId }));
    const reading = result.created[0]!, entry = result.created[1]!, value = result.created[2]!;
    expect(result.caret).toEqual({ id: value, offset: 0 });
    expect(doc.outline.children(reading)).toEqual([entry]);
    expect(doc.outline.children(entry)).toEqual([value]);
    await instance.flush();
    expect((await api.positions({ subject: id })).rows.map(row => [row.block.block.id, row.holder_id])).toEqual([[reading, holder]]);
    const reopened = (await client()).open(id);
    await eventually(() => reopened.status() === 'ready', reopened.statusMessage());
    expect(reopened.block(reading)?.position?.holder_id).toBe(holder);
    expect(reopened.block(value)?.text).toBe('');
    doc.undo(); await instance.flush();
    expect((await api.positions({ subject: id })).rows).toEqual([]);
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first]);
    doc.redo(); await instance.flush();
    expect((await api.positions({ subject: id })).rows[0]?.holder_id).toBe(holder);
    reopened.release(); register.release(); doc.release();
  });

  test('Read projects stable field identities while a new reading is filled character by character', async () => {
    const instance = await client();
    const fields = await api.fields();
    const definitions = instance.open(fields.page_id);
    await eventually(() => definitions.status() === 'ready', definitions.statusMessage());
    const summary = success(definitions.edit({ kind: 'addField', name: `Auto-entry summary ${++serial}`, value: 'text', role: 'standfirst' })).created[0]!;
    const prose = success(definitions.edit({ kind: 'addField', name: `Auto-entry prose ${++serial}`, value: 'text', role: 'prose' })).created[0]!;
    const fact = success(definitions.edit({ kind: 'addField', name: `Auto-entry fact ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const byId = new Map((await api.fields()).fields.map(field => [field.id, field]));
    const holder = await instance.createPage(`Auto-entry holder ${++serial}`);
    const { id, doc, first } = await page(instance, 'Opening');
    const added = success(doc.edit({ kind: 'addReading', parentId: id, after: first, holderId: holder, gistFieldId: summary }));
    const reading = added.created[0]!, entry = added.created[1]!, value = added.created[2]!;
    const extra = success(doc.edit({ kind: 'addFieldEntries', parentId: reading, after: entry, entries: [{ fieldId: prose, value: '' }, { fieldId: fact, value: '' }] }));
    const proseValue = extra.created[1]!, factValue = extra.created[3]!;
    await instance.flush();
    const project = () => readingRegister(doc, fieldId => byId.get(fieldId), []);
    const initial = project();
    expect(initial.slips[0]?.gist).toEqual([{ name: byId.get(summary)!.name, entryId: entry }]);
    for (const [valueId, text] of [[value, 'Rq auto-entry gist'], [proseValue, 'Authored prose'], [factValue, 'A fact']] as const) {
      for (let offset = 0; offset < text.length; offset++) {
        success(doc.edit({ kind: 'text', id: valueId, text: text.slice(0, offset + 1), caret: offset + 1 }, { id: valueId, offset }));
        await instance.flush();
        expect(project()).toEqual(initial);
        expect((await api.block(valueId)).text).toBe(text.slice(0, offset + 1));
      }
      doc.undo(); await instance.flush();
      expect((await api.block(valueId)).text).toBe('');
      expect(project()).toEqual(initial);
      doc.redo(); await instance.flush();
      expect((await api.block(valueId)).text).toBe(text);
    }
    const reopened = (await client()).open(id);
    await eventually(() => reopened.status() === 'ready', reopened.statusMessage());
    expect(reopened.block(value)?.text).toBe('Rq auto-entry gist');
    expect(reopened.block(proseValue)?.text).toBe('Authored prose');
    expect(reopened.block(factValue)?.text).toBe('A fact');
    reopened.release(); definitions.release(); doc.release();
  });

  test('Read groups only criterion questions and keeps unscoped questions in their authored place', async () => {
    const instance = await client();
    const fields = await api.fields();
    const definitions = instance.open(fields.page_id);
    await eventually(() => definitions.status() === 'ready', definitions.statusMessage());
    const criterion = success(definitions.edit({ kind: 'addField', name: `Reading criterion ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const holder = await instance.createPage(`Projection holder ${++serial}`);
    const { id, doc, first } = await page(instance, 'An authored opening');
    const reading = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: `[[${holder}]]` })).created[0]!;
    success(doc.edit({ kind: 'position', id: reading, value: true }));
    success(doc.edit({ kind: 'addFieldEntries', parentId: reading, after: null, entries: [{ fieldId: criterion, value: 'A fact' }] }));
    const heading = success(doc.edit({ kind: 'insert', parentId: id, after: reading, text: 'Authored questions' })).created[0]!;
    success(doc.edit({ kind: 'heading', id: heading, level: 2 }));
    const scoped = success(doc.edit({ kind: 'insert', parentId: heading, after: null, text: `What divides them? [[${criterion}]] [[${holder}]]` })).created[0]!;
    const unscoped = success(doc.edit({ kind: 'insert', parentId: heading, after: scoped, text: 'Shape and holder names are only words here.' })).created[0]!;
    for (const question of [scoped, unscoped]) success(doc.edit({ kind: 'question', id: question, value: { unsettled: false, parked: false, accepted: null, review_on: null } }));
    await instance.flush();
    const result = await api.positions({ subject: id });
    const project = () => readingRegister(doc, fieldId => fieldId === criterion ? { id: criterion, name: 'Reading criterion', kind: 'text', revision: 1, options: [], targets: [] } : undefined, result.questions);
    const projected = project();
    const [criterionEntry] = doc.outline.children(reading);
    expect(projected.disagreements).toEqual([{ criterion, questions: [{ id: scoped, holders: [holder] }], answers: [{ slipId: reading, entryId: criterionEntry! }] }]);
    expect(projected.remaining).toContain(unscoped);
    expect(projected.remaining).toContain(heading);
    success(doc.edit({ kind: 'delete', ids: [unscoped] }));
    expect(project().remaining).not.toContain(heading);
    expect(projected.slips[0]?.facts).toEqual([]);

    // Your answer follows theirs as editable rows: a draft until one is accepted, earlier ones only when unfolded.
    const earlier = success(doc.edit({ kind: 'writeAssessment', parentId: scoped, assessedOn: '2026-09-14' })).created[0]!;
    await doc.flush();
    const group = () => project().disagreements[0]!;
    expect(readingDisagreementRows(doc, group(), new Set()).at(-1)).toBe(earlier);
    const current = success(doc.edit({ kind: 'writeAssessment', parentId: scoped, assessedOn: '2026-10-13' })).created[0]!;
    await doc.flush();
    success(doc.edit({ kind: 'question', id: scoped, value: currentReading(doc.block(scoped)!.question!.state, current, '2026-10-13') }));
    await doc.flush();
    const folded = readingDisagreementRows(doc, group(), new Set());
    expect(folded).toContain(current);
    expect(folded).not.toContain(earlier);
    expect(readingDisagreementRows(doc, group(), new Set([`${scoped}:earlier`])).slice(-2)).toEqual([current, earlier]);
    definitions.release(); doc.release();
  });

  test('source Read omits catalog fields while retaining ordinary field labels and values', async () => {
    const instance = await client();
    const { doc, id, first, fieldsDoc } = await metadataSource(instance);
    await saveSourceField([doc], instance, 'publisher', 'A catalog publisher');
    await saveSourceField([doc], instance, 'published', '1992');
    const annotation = success(fieldsDoc.edit({ kind: 'addField', name: `Reading annotation ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const added = success(doc.edit({ kind: 'addFieldEntries', parentId: id, after: first, entries: [{ fieldId: annotation, value: 'An authored annotation' }] }));
    const empty = success(doc.edit({ kind: 'insert', parentId: id, after: added.created[0]!, text: `[[${annotation}]]` })).created[0]!;
    const fields = (await api.fields()).fields;
    const publisher = fields.find(field => field.name === 'publisher')!.id;
    const nested = success(doc.edit({ kind: 'addFieldEntries', parentId: first, after: null, entries: [{ fieldId: publisher, value: 'A nested note, not catalog data' }] }));
    const shorthand = success(doc.edit({ kind: 'insert', parentId: id, after: empty, text: 'Publisher:: An explicit catalog shorthand' })).created[0]!;
    await instance.flush();
    const projected = readingRegister(doc, fieldId => fields.find(field => field.id === fieldId), []);
    const rows = [...projected.opening, ...projected.remaining];
    expect(rows).toContain(first);
    for (const fieldId of [publisher, fields.find(field => field.name === 'published')!.id]) {
      const entry = doc.outline.children(id).find(block => doc.block(block)?.text === `[[${fieldId}]]`)!;
      expect(rows).not.toContain(entry);
      for (const value of doc.outline.children(entry)) expect(rows).not.toContain(value);
    }
    expect(rows).not.toContain(shorthand);
    expect(rows).toContain(empty);
    for (const block of [...added.created, ...nested.created]) expect(rows).toContain(block);
    expect(isReadingSubject(doc)).toBe(false);
    fieldsDoc.release(); doc.release();
  });

  test('reading controls follow authored subjects instead of holders or ordinary links', async () => {
    const instance = await client();
    const holder = await page(instance, 'A holder page');
    const subject = await page(instance, `An ordinary link to [[${holder.id}]]`);
    expect(isReadingSubject(holder.doc)).toBe(false);
    expect(isReadingSubject(subject.doc)).toBe(false);
    const position = success(subject.doc.edit({ kind: 'insert', parentId: subject.id, after: subject.first, text: `[[${holder.id}]]` })).created[0]!;
    success(subject.doc.edit({ kind: 'position', id: position, value: true }));
    expect(isReadingSubject(subject.doc)).toBe(true);
    expect(isReadingSubject(holder.doc)).toBe(false);
    success(subject.doc.edit({ kind: 'archive', id: position, archived: true }));
    expect(isReadingSubject(subject.doc)).toBe(false);
    subject.doc.undo();
    expect(isReadingSubject(subject.doc)).toBe(true);
    const question = success(holder.doc.edit({ kind: 'insert', parentId: holder.id, after: holder.first, text: 'An inline question' })).created[0]!;
    success(holder.doc.edit({ kind: 'question', id: question, value: { unsettled: false, parked: false, accepted: null, review_on: null } }));
    const nested = success(holder.doc.edit({ kind: 'insert', parentId: question, after: null, text: `[[${subject.id}]]` })).created[0]!;
    success(holder.doc.edit({ kind: 'position', id: nested, value: true }));
    expect(isReadingSubject(holder.doc)).toBe(true);
    const emptyQuestion = await page(instance, 'A question with no readings');
    success(emptyQuestion.doc.edit({ kind: 'question', id: emptyQuestion.id, value: { unsettled: false, parked: false, accepted: null, review_on: null } }));
    expect(isReadingSubject(emptyQuestion.doc)).toBe(true);
    holder.doc.release(); subject.doc.release(); emptyQuestion.doc.release();
  });

  test('adding field entries with their values is one undo step and persists', async () => {
    const instance = await client();
    const fields = await api.fields();
    const register = instance.open(fields.page_id);
    await eventually(() => register.status() === 'ready', register.statusMessage());
    const status = success(register.edit({ kind: 'addField', name: `Sheet status ${++serial}`, value: 'text' })).created[0]!;
    const read = success(register.edit({ kind: 'addField', name: `Sheet read ${++serial}`, value: 'checkbox' })).created[0]!;
    await instance.flush();
    const { id, doc, first } = await page(instance, 'A book');
    const note = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'a note' })).created[0]!;
    await instance.flush();
    const shape = async () => (await api.page(id)).rows.filter(row => row.block.id !== first).map(row => [row.block.parent_id === first ? 'child' : 'value', row.block.text]);

    const result = success(doc.edit({ kind: 'addFieldEntries', parentId: first, after: null, entries: [{ fieldId: status, value: 'Reading' }, { fieldId: read, value: 'yes' }] }));
    expect(result.caret).toEqual({ id: doc.outline.children(doc.outline.children(first)[0]!)[0]!, offset: 'Reading'.length });
    await instance.flush();
    const added = [['child', `[[${status}]]`], ['value', 'Reading'], ['child', `[[${read}]]`], ['value', 'yes'], ['child', 'a note']];
    expect(await shape()).toEqual(added);

    doc.undo();
    expect(doc.outline.children(first)).toEqual([note]);
    await instance.flush();
    expect(await shape()).toEqual([['child', 'a note']]);
    doc.redo();
    await instance.flush();
    expect(await shape()).toEqual(added);
    expect(doc.edit({ kind: 'addFieldEntries', parentId: first, after: 'not-a-sibling', entries: [{ fieldId: status, value: '' }] }).ok).toBe(false);
    register.release();
    doc.release();
  });

  test('quoted criterion values create their snapshot and missing structure in one undo step', async () => {
    const instance = await client();
    const source = await page(instance, 'Frozen criterion evidence');
    const snapshot = await api.quoteSnapshot(source.first);
    const text = `((${source.first}))`;
    const fields = await api.fields();
    const register = instance.open(fields.page_id);
    await eventually(() => register.status() === 'ready', register.statusMessage());
    const field = success(register.edit({ kind: 'addField', name: `Quoted criterion ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const target = await page(instance, 'A reading');
    const added = success(target.doc.edit({ kind: 'addFieldEntries', parentId: target.first, after: null, entries: [{ fieldId: field, value: text, quote: snapshot }] }));
    const [entry, value] = added.created;
    expect(target.doc.block(value!)?.text).toBe(text);
    expect(target.doc.block(value!)?.quote).toEqual(snapshot);
    await instance.flush();
    expect((await api.capabilities(value!)).quote).toEqual(snapshot);
    target.doc.undo();
    expect(target.doc.outline.children(target.first)).toEqual([]);
    await instance.flush();
    target.doc.redo();
    await instance.flush();
    expect((await api.capabilities(value!)).quote).toEqual(snapshot);
    const second = success(target.doc.edit({ kind: 'insert', parentId: entry!, after: value!, text, quote: snapshot })).created[0]!;
    await instance.flush();
    expect((await api.capabilities(second)).quote).toEqual(snapshot);
    target.doc.undo();
    expect(target.doc.outline.children(entry!)).toEqual([value!]);
    await instance.flush();
    target.doc.redo();
    await instance.flush();
    const otherWindow = await client();
    const shared = otherWindow.open(target.id);
    await eventually(() => shared.status() === 'ready', shared.statusMessage());
    expect(shared.block(second)?.quote).toEqual(snapshot);
    expect(target.doc.edit({ kind: 'insert', parentId: entry!, after: second, text: 'A different token', quote: snapshot }).ok).toBe(false);
    expect(target.doc.outline.children(entry!)).toEqual([value!, second]);
    source.doc.release(); register.release(); target.doc.release(); shared.release();
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

  test('field hide edits persist, undo and redo through the document outbox', async () => {
    const instance = await client();
    const fields = await api.fields();
    const doc = instance.open(fields.page_id);
    await eventually(() => doc.status() === 'ready', doc.statusMessage());
    const id = success(doc.edit({ kind: 'insert', parentId: fields.page_id, after: null, text: `Hide test ${++serial}` })).created[0]!;
    await instance.flush();
    const definition = (await api.fields()).fields.find(field => field.id === id)!;
    success(doc.edit({ kind: 'fieldHide', definition: { ...definition, hide: undefined }, value: 'never' }));
    expect(doc.block(id)?.pending).toBe(false);
    success(doc.edit({ kind: 'fieldHide', definition, value: 'when_empty' }));
    expect(doc.edit({ kind: 'fieldHide', definition, value: 'always' }).ok).toBe(false);
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.hide).toBe('when_empty');
    expect(doc.block(id)?.revision).toBe(definition.revision + 1);
    doc.undo();
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.hide).toBe('never');
    doc.redo();
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.hide).toBe('when_empty');
    expect(doc.block(id)?.revision).toBe(definition.revision + 3);
    const stale = doc.edit({ kind: 'fieldHide', definition, value: 'always' });
    expect(stale.ok).toBe(false);
    expect((await api.fields()).fields.find(field => field.id === id)?.hide).toBe('when_empty');
    doc.release();
  });

  test('field roles persist with one undo and reject a stale definition', async () => {
    const instance = await client();
    const fields = await api.fields();
    const doc = instance.open(fields.page_id);
    await eventually(() => doc.status() === 'ready', doc.statusMessage());
    const id = success(doc.edit({ kind: 'addField', name: `Summary ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const definition = (await api.fields()).fields.find(field => field.id === id)!;
    success(doc.edit({ kind: 'fieldRole', definition, value: 'standfirst' }));
    await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.role).toBe('standfirst');
    expect(doc.edit({ kind: 'fieldRole', definition, value: 'prose' }).ok).toBe(false);
    doc.undo(); await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.role).toBe('attribute');
    doc.redo(); await instance.flush();
    expect((await api.fields()).fields.find(field => field.id === id)?.role).toBe('standfirst');
    doc.release();
  });

  test('a field counts as a creator with one undo, and a built-in field keeps what the core says', async () => {
    const instance = await client();
    const fields = await api.fields();
    const doc = instance.open(fields.page_id);
    await eventually(() => doc.status() === 'ready', doc.statusMessage());
    const id = success(doc.edit({ kind: 'addField', name: `Director ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const read = async () => (await api.fields()).fields.find(field => field.id === id)?.counts_as ?? null;
    const definition = (await api.fields()).fields.find(field => field.id === id)!;
    success(doc.edit({ kind: 'fieldCountsAs', definition, value: 'creator' }));
    await instance.flush();
    expect(await read()).toBe('creator');
    doc.undo(); await instance.flush();
    expect(await read()).toBeNull();
    doc.redo(); await instance.flush();
    expect(await read()).toBe('creator');
    const current = (await api.fields()).fields.find(field => field.id === id)!;
    const refused = doc.edit({ kind: 'fieldCountsAs', definition: { ...current, built_in: true }, value: null });
    expect(refused.ok ? '' : refused.reason).toContain('is built in and counts as creator.');
    doc.release();
  });

  test('new tag and manual type pages receive starting templates after creation is acknowledged', async () => {
    for (const scenario of [
      { title: 'Pérsón', manual: false, fields: ['aliases', 'lived', 'affiliated with'] },
      { title: 'Gróup', manual: true, fields: ['aliases', 'active'] },
    ]) {
      const instance = await client();
      const { id, doc, first } = await page(instance, 'Reading');
      const startingTemplate = instance.api.startingTemplate;
      const acknowledged: string[] = [];
      instance.api.startingTemplate = async typeId => {
        // Reading the page here proves the hook did not run on a merely optimistic id.
        acknowledged.push((await api.block(typeId)).text);
        return startingTemplate(typeId);
      };
      try {
        success(scenario.manual
          ? doc.addType(first, scenario.title)
          : doc.edit({ kind: 'text', id: first, text: `#${scenario.title}` }));
        await instance.flush();
        const target = await api.pageByTitle(scenario.title);
        const type = await api.type(target.id);
        const fields = new Map((await api.fields()).fields.map(field => [field.id, field.name]));
        expect(type.fields.map(field => fields.get(field))).toEqual(scenario.fields);
        expect(acknowledged).toEqual([scenario.title]);
        const row = (await api.page(id)).rows.find(row => row.block.id === first)!;
        if (scenario.manual) expect(row.manual_types).toEqual([scenario.title]);
        else expect(row.block.text).toBe(`#[[${target.id}|${scenario.title}]]`);
      } finally {
        instance.api.startingTemplate = startingTemplate;
        doc.release();
      }
    }
  });

  test('ordinary page creation and adding an existing empty type do not apply a starting template', async () => {
    const instance = await client();
    const title = 'Cóncept';
    const target = await instance.createPage(title);
    await instance.flush();
    expect((await api.type(target)).fields).toEqual([]);
    const { doc, first } = await page(instance, 'Reading');
    success(doc.addType(first, title));
    await instance.flush();
    expect((await api.type(target)).fields).toEqual([]);
    success(doc.edit({ kind: 'text', id: first, text: `#${title}` }));
    await instance.flush();
    expect((await api.type(target)).fields).toEqual([]);
    doc.release();
  });

  test('a starting-template failure does not reject or replay the acknowledged type creation', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance, 'Reading');
    const title = 'Cöncept';
    const startingTemplate = instance.api.startingTemplate;
    let calls = 0;
    instance.api.startingTemplate = async () => {
      calls++;
      throw new Error('Starting template unavailable');
    };
    try {
      success(doc.addType(first, title));
      await instance.flush();
      expect(calls).toBe(1);
      expect((await api.page(id)).rows.find(row => row.block.id === first)?.manual_types).toEqual([title]);
      expect((await api.type((await api.pageByTitle(title)).id)).fields).toEqual([]);
      expect(instance.message()).toContain('Starting template unavailable');
      await instance.flush();
      expect(calls).toBe(1);
      expect(instance.commands(id)).toHaveLength(0);
    } finally {
      instance.api.startingTemplate = startingTemplate;
      doc.release();
    }
  });

  test('removing a page type keeps its written rows and can be undone', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance, 'Written field value');
    success(doc.addType(id, 'Concept'));
    await instance.flush();
    const before = (await api.page(id)).rows;
    success(doc.removeType(id, 'Concept'));
    await instance.flush();
    expect((await api.page(id)).root_manual_types).toEqual([]);
    expect((await api.page(id)).rows).toEqual(before);
    expect(doc.block(first)?.text).toBe('Written field value');
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).root_manual_types).toEqual(['Concept']);
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

  test('cancelled missing journal lookup does not create a journal', async () => {
    const instance = await client();
    const date = '2098-10-12';
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lookup = new Promise<void>(resolve => { arrived = resolve; });
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith(`/api/journal/${date}`)) return actualFetch(input, init);
      // Let a response already in flight arrive after cancellation.
      const response = await actualFetch(input, { ...init, signal: undefined });
      arrived();
      await held;
      return response;
    }, { preconnect: actualFetch.preconnect });
    try {
      const controller = new AbortController();
      const pending = instance.journal(date, controller.signal);
      await lookup;
      controller.abort();
      release();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(instance.roots().some(root => root.kind === 'journal' && root.text === date)).toBe(false);
      expect(instance.queuedChanges()).toBe(0);
      await instance.flush();
      await expect(api.journal(date)).rejects.toMatchObject({ status: 404 });
    } finally { release(); globalThis.fetch = actualFetch; }
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
  test('view deletion confirmation defaults on and supports setting undo and redo', async () => {
    const first = await client();
    const second = await client();
    expect(first.confirmViewDelete()).toBe(true);
    await first.setSetting('confirm_view_delete', 'false');
    await eventually(() => !second.confirmViewDelete(), 'remote view confirmation preference did not arrive');
    await first.undoSetting();
    expect(first.confirmViewDelete()).toBe(true);
    await first.redoSetting();
    expect(first.confirmViewDelete()).toBe(false);
    const reopened = await client();
    expect(reopened.confirmViewDelete()).toBe(false);
    await first.setSetting('confirm_view_delete', 'true');
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

  test('continuous typing after a cross-block replacement undoes and redoes the whole gesture', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'alpha one');
    const middle = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'beta two' })).created[0]!;
    const last = success(doc.edit({ kind: 'insert', parentId: id, after: middle, text: 'gamma three' })).created[0]!;
    await instance.flush();
    const range = { anchor: { id: first, offset: 2 }, head: { id: last, offset: 2 } };
    success(doc.edit({ kind: 'replaceRange', range, between: [middle], text: 'R', mode: 'text' }, range.head));
    for (const word of ['RE', 'REP', 'REPLACED']) {
      success(doc.edit({ kind: 'text', id: first, text: `al${word}mma three` }));
      await instance.flush();
    }
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.text)).toEqual(['alpha one', 'beta two', 'gamma three']);
    doc.redo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.text)).toEqual(['alREPLACEDmma three']);
    doc.release();
  });

  test('a pending cell keeps its field creation and later normalization in one undo entry across other edits', async () => {
    const instance = await client();
    const fields = await api.fields(), register = instance.open(fields.page_id);
    await eventually(() => register.status() === 'ready', register.statusMessage());
    const field = success(register.edit({ kind: 'addField', name: `Pending cell ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const { id, doc, first } = await page(instance, 'owner');
    const pending = doc.beginTextCommit(edit => edit({ kind: 'addFieldEntries', parentId: first, after: null, entries: [{ fieldId: field, value: '[[Title]]' }] }));
    const value = success(pending.result).caret!.id;
    success(pending.replace('[[Title]] accepted'));
    await instance.flush();
    success(doc.edit({ kind: 'text', id: first, text: 'unrelated edit' }));
    await instance.flush();
    success(pending.replace(`[[${id}|Title]] accepted`));
    pending.finish();
    await instance.flush();
    expect((await api.block(value)).text).toBe(`[[${id}|Title]] accepted`);
    doc.undo();
    await instance.flush();
    expect((await api.block(first)).text).toBe('owner');
    expect(doc.block(value)?.text).toBe(`[[${id}|Title]] accepted`);
    doc.undo();
    await instance.flush();
    expect(doc.outline.children(first)).toEqual([]);
    doc.redo();
    await instance.flush();
    expect(doc.block(value)?.text).toBe(`[[${id}|Title]] accepted`);
    expect(pending.replace('too late').ok).toBe(false);
    doc.release(); register.release();
  });

  test('pending text normalization refuses to overwrite a later edit to its value', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'saved');
    const pending = doc.beginTextCommit(edit => edit({ kind: 'text', id: first, text: '[[Title]]' }));
    success(pending.result);
    success(doc.edit({ kind: 'text', id: first, text: 'changed elsewhere' }));
    expect(pending.replace('resolved').ok).toBe(false);
    expect(doc.block(first)?.text).toBe('changed elsewhere');
    pending.finish(); doc.release();
  });

  test('distinct Vim command groups never coalesce even before either command saves', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'LineOne\nLineTwo\nLineThree');
    success(doc.edit({ kind: 'text', id: first, text: 'LineTwo\nLineThree', group: 1 }));
    success(doc.edit({ kind: 'text', id: first, text: 'LineThree', group: 2 }));
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.text)).toEqual(['LineTwo\nLineThree']);
    doc.undo();
    await instance.flush();
    expect((await api.page(id)).rows.map(row => row.block.text)).toEqual(['LineOne\nLineTwo\nLineThree']);
    doc.release();
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

  test('block clipboard capture includes every descendant of selected roots, not just visible rows', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Parent');
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Child' })).created[0]!;
    const grandchild = success(doc.edit({ kind: 'insert', parentId: child, after: null, text: 'Grandchild' })).created[0]!;
    const next = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Next' })).created[0]!;
    await instance.flush();
    const content = doc.clipboard([first, next], true);
    expect(content.blocks.map(item => item.block.id)).toEqual([first, child, grandchild, next]);
    expect(clipboardText(content)).toBe('Parent\n  Child\n    Grandchild\nNext');
    expect(doc.clipboard([first, child, grandchild]).blocks.map(item => item.block.id)).toEqual([first, child, grandchild]);
    const single = doc.clipboard([next], true);
    expect(single.blocks.map(item => item.block.id)).toEqual([next]);
    success(doc.edit({ kind: 'delete', ids: [first, next] }));
    expect([first, child, grandchild, next].every(id => !doc.block(id))).toBe(true);
    expect(content.blocks.map(item => item.block.text)).toEqual(['Parent', 'Child', 'Grandchild', 'Next']);
  });

  test('cut subtrees paste with their original ids before the deletion has acknowledged', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Parent');
    const child = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Child' })).created[0]!;
    const next = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Next' })).created[0]!;
    const destination = success(doc.edit({ kind: 'insert', parentId: id, after: next })).created[0]!;
    await instance.flush();
    const content = doc.clipboard([first, next], true);
    success(doc.edit({ kind: 'delete', ids: [first, next] }));
    const at = { id: destination, offset: 0 };
    const ready = await doc.prepareClipboard(content);
    success(doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: ready }, at));
    expect(ids(doc)).toEqual([first, child, next]);
    expect(doc.outline.parentOf(child)).toBe(first);
    await instance.flush();
    expect((await api.page(id)).rows.map(row => ({ id: row.block.id, depth: row.depth }))).toEqual([{ id: first, depth: 0 }, { id: child, depth: 1 }, { id: next, depth: 0 }]);
    doc.release();
  });

  test('structured copy paste keeps hierarchy, multiline card sources and tasks at destination depth', async () => {
    const instance = await client();
    const source = await page(instance, 'Parent');
    const card = success(source.doc.edit({ kind: 'insert', parentId: source.first, after: null, text: 'Front >>>\nFirst answer\nSecond answer' })).created[0]!;
    const nested = success(source.doc.edit({ kind: 'insert', parentId: card, after: null, text: 'Nested' })).created[0]!;
    const other = success(source.doc.edit({ kind: 'insert', parentId: source.first, after: card, text: 'Other child' })).created[0]!;
    success(source.doc.edit({ kind: 'task', id: source.first, value: { ...todo, scheduled: '2026-10-12', priority: 'high' } }));
    await instance.flush();
    const content = parseBlockClipboard(JSON.stringify(source.doc.clipboard([source.first, card, nested, other])))!;
    for (const depth of [0, 1]) {
      const destination = await page(instance, depth ? 'Destination' : '');
      const target = depth ? success(destination.doc.edit({ kind: 'insert', parentId: destination.first, after: null })).created[0]! : destination.first;
      await instance.flush();
      const at = { id: target, offset: 0 };
      const result = success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content }, at));
      const pasted = result.created;
      expect(pasted).toHaveLength(4);
      expect(pasted.some(id => content.blocks.some(item => item.block.id === id))).toBe(false);
      expect(pasted.map(id => destination.doc.outline.depth(id))).toEqual([depth, depth + 1, depth + 2, depth + 1]);
      expect(destination.doc.outline.parentOf(pasted[1]!)).toBe(pasted[0]!);
      expect(destination.doc.outline.parentOf(pasted[2]!)).toBe(pasted[1]!);
      expect(destination.doc.block(pasted[0]!)?.task).toEqual(source.doc.block(source.first)?.task);
      expect(destination.doc.block(pasted[1]!)?.text).toBe('Front >>>\nFirst answer\nSecond answer');
      await instance.flush();
      expect((await api.page(destination.id)).rows.filter(row => pasted.includes(row.block.id)).map(row => row.depth)).toEqual([depth, depth + 1, depth + 2, depth + 1]);
      expect(await api.sourceCards(pasted[1]!)).toHaveLength((await api.sourceCards(card)).length);
      destination.doc.undo();
      await instance.flush();
      expect(destination.doc.block(target)?.text).toBe('');
      expect(pasted.every(id => !destination.doc.block(id))).toBe(true);
      destination.doc.redo();
      await instance.flush();
      expect(pasted.map(id => destination.doc.outline.depth(id))).toEqual([depth, depth + 1, depth + 2, depth + 1]);
      destination.doc.release();
    }
    source.doc.release();
  });

  test('cut paste restores and moves original task, work and card identities across pages and windows', async () => {
    const instance = await client();
    const otherWindow = await client();
    const source = await page(instance, 'Scheduled work');
    const card = success(source.doc.edit({ kind: 'insert', parentId: source.first, after: null, text: 'Front >> Back' })).created[0]!;
    const task = { ...todo, scheduled: '2026-10-12', scheduled_time: '17:30', priority: 'high' as const };
    success(source.doc.edit({ kind: 'task', id: source.first, value: task }));
    await instance.flush();
    success(source.doc.edit({ kind: 'startWork', id: source.first, startedAt: 1000 }));
    await instance.flush();
    const session = (await api.workSessions(source.first))[0]!;
    success(source.doc.edit({ kind: 'stopWork', id: source.first, session, endedAt: 2000, note: 'Original work history' }));
    await instance.flush();
    const work = await api.workSessions(source.first);
    const cards = await api.sourceCards(card);
    const content = parseBlockClipboard(JSON.stringify(source.doc.clipboard([source.first], true)))!;
    success(source.doc.edit({ kind: 'delete', ids: [source.first] }));
    await instance.flush();
    const destination = await page(otherWindow, '');
    const ready = await destination.doc.prepareClipboard(content);
    expect(ready.cut).toBe(true);
    const at = { id: destination.first, offset: 0 };
    success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: ready }, at));
    expect(ids(destination.doc)).toEqual([source.first, card]);
    expect(destination.doc.block(source.first)?.task).toEqual(task);
    expect(destination.doc.outline.parentOf(card)).toBe(source.first);
    await otherWindow.flush();
    const rows = (await api.page(destination.id)).rows;
    expect(rows.map(row => ({ id: row.block.id, depth: row.depth }))).toEqual([{ id: source.first, depth: 0 }, { id: card, depth: 1 }]);
    expect((await api.block(source.first)).page_id).toBe(destination.id);
    expect(await api.workSessions(source.first)).toEqual(work);
    expect((await api.sourceCards(card)).map(item => item.id)).toEqual(cards.map(item => item.id));
    expect((await api.capabilities(source.first)).task).toEqual(task);
    expect((await source.doc.prepareClipboard(content)).cut).toBe(false);
    source.doc.release();
    destination.doc.release();
  });

  test('cross-page multi-root cut paste undo and redo preserve the original identities', async () => {
    const instance = await client();
    const source = await page(instance, 'Parent');
    const child = success(source.doc.edit({ kind: 'insert', parentId: source.first, after: null, text: 'Child' })).created[0]!;
    const sibling = success(source.doc.edit({ kind: 'insert', parentId: source.id, after: source.first, text: 'Sibling' })).created[0]!;
    success(source.doc.edit({ kind: 'insert', parentId: source.id, after: sibling, text: 'Tail' }));
    await instance.flush();
    const content = source.doc.clipboard([source.first, sibling], true);
    success(source.doc.edit({ kind: 'delete', ids: [source.first, sibling] }));
    const destination = await page(instance, 'Destination');
    const ready = await destination.doc.prepareClipboard(content);
    const at = { id: destination.first, offset: 'Destination'.length };
    success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: ready }, at));
    await instance.flush();
    const moved = [destination.first, source.first, child, sibling];
    expect((await api.page(destination.id)).rows.map(row => row.block.id)).toEqual(moved);
    destination.doc.undo();
    await instance.flush();
    expect((await api.page(destination.id)).rows.map(row => row.block.id)).toEqual([destination.first]);
    destination.doc.redo();
    await instance.flush();
    expect((await api.page(destination.id)).rows.map(row => row.block.id)).toEqual(moved);
    expect((await api.page(source.id)).rows.map(row => row.block.text)).toEqual(['Tail']);
    source.doc.release();
    destination.doc.release();
  });

  test('copying a completed task makes a distinct task without borrowing its work history', async () => {
    const instance = await client();
    const source = await page(instance, 'Finished work');
    success(source.doc.edit({ kind: 'task', id: source.first, value: todo }));
    success(source.doc.edit({ kind: 'completeTask', id: source.first, completedOn: '2026-10-12' }));
    await instance.flush();
    const destination = await page(instance, '');
    const at = { id: destination.first, offset: 0 };
    const result = success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: source.doc.clipboard([source.first]) }));
    const copied = result.created[0]!;
    expect(copied).not.toBe(source.first);
    expect(destination.doc.block(copied)?.task).toEqual(source.doc.block(source.first)?.task);
    await instance.flush();
    expect((await api.capabilities(copied)).task).toEqual(source.doc.block(source.first)?.task ?? null);
    expect(await api.workSessions(copied)).toEqual([]);
    expect((await api.taskOccurrences(copied))[0]?.id).not.toBe((await api.taskOccurrences(source.first))[0]?.id);
    source.doc.release();
    destination.doc.release();
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

  test('opening an empty page writes nothing and deleting authored final content remains one undo step', async () => {
    const instance = await client();
    const id = ulid();
    await api.submit({ actor: { kind: 'agent', name: 'empty type page' }, operations: [{ op: 'create_page', id, title: `Empty tag page ${++serial}` }] });
    const doc = instance.open(id);
    const shared = instance.open(id);
    await eventually(() => doc.status() === 'ready', 'empty page did not load');
    expect(shared).toBe(doc);
    expect(ids(doc)).toEqual([]);
    await instance.flush();
    expect((await api.page(id)).rows).toEqual([]);
    expect(doc.canUndo()).toBe(false);
    const first = success(doc.edit({ kind: 'insert', parentId: id, after: null, text: 'Final content' })).created[0]!;
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

  test('undo queued before a tag rename acknowledgement keeps member text unchanged', async () => {
    const instance = await client();
    const number = ++serial;
    const before = `#rACE${number} / #[[Race${number}]]`;
    const source = await page(instance, before);
    const root = await api.pageByTitle(`Race${number}`);
    const canonical = (await api.block(source.first)).text;
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
      expect((await api.block(source.first)).text).toBe(canonical);
      expect(source.doc.block(source.first)?.text).toBe(canonical);
      expect(instance.queuedChanges()).toBe(0);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; }
  });

  test('tag page rename updates live labels without changing member text or membership', async () => {
    const instance = await client();
    const number = ++serial;
    const title = `Tag${number}`;
    const before = `#tAG${number} / #[[${title}]] / [[${title}]]`;
    const source = await page(instance, before);
    const other = await page(instance, `#TAG${number}`);
    const root = await api.pageByTitle(title);
    const canonical = (await api.block(source.first)).text;
    const otherCanonical = (await api.block(other.first)).text;
    const tagged = instance.open(root.id);
    await eventually(() => tagged.status() === 'ready', 'tag page did not load');
    await instance.flush();
    const renamed = `Renamed Tag ${number}`;
    success(tagged.rename(renamed));
    await instance.flush();
    expect(source.doc.block(source.first)?.text).toBe(canonical);
    expect(instance.lookup(other.first)()?.text).toBe(otherCanonical);
    expect(plainText(canonical, id => instance.lookup(id))).toContain(`#${renamed}`);
    tagged.undo();
    await instance.flush();
    expect((await api.block(root.id)).text).toBe(root.text);
    expect((await api.block(source.first)).text).toBe(canonical);
    expect((await api.block(other.first)).text).toBe(otherCanonical);
    expect((await api.members(root.id)).map(row => row.block.id).sort()).toEqual([source.first, other.first].sort());
    tagged.redo();
    await instance.flush();
    expect((await api.block(source.first)).text).toBe(canonical);
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
    expect(doc.block(first)?.text).toBe(`#[[${id}|ReceiptBook]]`);
    success(doc.edit({ kind: 'text', id: first, text: `${doc.block(first)!.text} .` }));
    await instance.flush();
    expect((await api.block(first)).text).toBe(`#[[${id}|ReceiptFilm]] .`);
    expect((await api.pageByTitle('ReceiptFilm')).id).toBe(id);
    await expect(api.pageByTitle('ReceiptBook')).rejects.toHaveProperty('status', 404);
    doc.undo();
    await instance.flush();
    doc.undo();
    await instance.flush();
    expect((await api.block(id)).text).toBe('ReceiptBook');
    expect((await api.block(first)).text).toBe(`#[[${id}|ReceiptFilm]]`);
    expect(plainText(doc.block(first)!.text, id => instance.lookup(id))).toBe('#ReceiptBook');
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

  test('reload recovers accepted pending cell text and suffixes through the ordinary outbox', async () => {
    const session = `pending-cell-${++serial}`, instance = await client(session);
    const { id, doc, first } = await page(instance, 'saved');
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new TypeError('Offline'); }, { preconnect: actualFetch.preconnect });
    try {
      const pending = doc.beginTextCommit(edit => edit({ kind: 'replaceRange', range: { anchor: { id: first, offset: 0 }, head: { id: first, offset: 5 } }, between: [], mode: 'text', text: '[[Title]]' }));
      success(pending.result);
      success(pending.replace('[[Title]] visible before reload'));
      await instance.flush();
      await instance.dispose();
      const recovered = await client(session), reopened = recovered.open(id);
      await eventually(() => reopened.status() === 'ready', 'pending cell did not recover');
      expect(reopened.block(first)?.text).toBe('[[Title]] visible before reload');
      globalThis.fetch = actualFetch;
      recovered.retry();
      await recovered.flush();
      expect((await api.block(first)).text).toBe('[[Title]] visible before reload');
      reopened.release();
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

  test('a structural-only 409 rebases pending text and drains unrelated edits', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Parent');
    const child = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Child' })).created[0]!;
    const third = success(doc.edit({ kind: 'insert', parentId: id, after: child, text: 'Third' })).created[0]!;
    await instance.flush();
    const current = await api.block(child);
    const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const statuses: number[] = [];
    let intercept = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const isClientBatch = String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes('"kind":"client"');
      if (isClientBatch && intercept) { intercept = false; reached.resolve(); await gate.promise; }
      const response = await actualFetch(input, init);
      if (isClientBatch) statuses.push(response.status);
      return response;
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'text', id: child, text: 'Child pending' }));
      const saving = instance.flush();
      await reached.promise;
      await api.submit({ actor: { kind: 'person' }, operations: [{ op: 'move', id: child, base_revision: current.revision, parent_id: first, after: null }] });
      success(doc.edit({ kind: 'text', id: third, text: 'Third saved' }));
      gate.resolve();
      await saving;
      expect(statuses[0]).toBe(409);
      expect((await api.block(child))).toMatchObject({ parent_id: first, text: 'Child pending' });
      expect((await api.block(third)).text).toBe('Third saved');
      expect(doc.block(child)?.conflict).toBeNull();
      expect(instance.saveState()).toBe('saved');
      expect(instance.queuedChanges()).toBe(0);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; doc.release(); }
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

  test('redo restores field blocks while the original insert acknowledgement is in flight', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Before the field');
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const batches: Batch[] = [];
    let intercept = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await actualFetch(input, init);
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') {
        batches.push(JSON.parse(String(init.body)));
        if (intercept) { intercept = false; reached.resolve(); await gate.promise; }
      }
      return response;
    }) as typeof fetch;
    try {
      const entry = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: '[[field-definition]]' })).created[0]!;
      const saving = instance.flush();
      await reached.promise;
      expect((await api.block(entry)).text).toBe('[[field-definition]]');
      const value = success(doc.edit({ kind: 'insert', parentId: entry, after: null, text: '' })).created[0]!;
      doc.undo();
      doc.undo();
      doc.redo();
      doc.redo();
      expect(ids(doc)).toEqual([first, entry, value]);
      expect(doc.outline.depth(value)).toBe(1);
      gate.resolve();
      await saving;
      await instance.flush();
      expect(doc.saveState()).toBe('saved');
      const view = await api.page(id);
      expect(view.rows.map(row => [row.block.id, row.depth])).toEqual([[first, 0], [entry, 0], [value, 1]]);
      const operations = batches.flatMap(batch => batch.operations);
      expect(operations.filter(operation => operation.op === 'insert' && operation.id === entry)).toHaveLength(1);
      expect(operations.filter(operation => operation.op === 'insert' && operation.id === value)).toHaveLength(1);
      expect(operations.filter(operation => operation.op === 'restore').map(operation => operation.id)).toEqual([entry, value]);
    } finally { gate.resolve(); globalThis.fetch = actualFetch; }
  });

  test('first field value undo remains ordered before submit and before acknowledgement', async () => {
    const instance = await client();
    const fields = await api.fields();
    const definitions = instance.open(fields.page_id);
    await eventually(() => definitions.status() === 'ready', definitions.statusMessage());
    const fieldId = success(definitions.edit({ kind: 'addField', name: `Embedded value race ${++serial}`, value: 'text' })).created[0]!;
    await instance.flush();
    const field = (await api.fields()).fields.find(field => field.id === fieldId)!;
    for (const timing of ['before submit', 'before acknowledgement'] as const) {
      const { id, doc, first } = await page(instance, 'The unchanged page opening');
      const text = `First embedded value ${++serial}`;
      const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      let intercept = true;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (intercept && String(input) === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes(text)) {
          intercept = false;
          if (timing === 'before submit') { reached.resolve(); await gate.promise; }
          const response = await actualFetch(input, init);
          if (timing === 'before acknowledgement') { reached.resolve(); await gate.promise; }
          return response;
        }
        return actualFetch(input, init);
      }) as typeof fetch;
      try {
        const written = success(doc.edit({ kind: 'addFieldEntries', parentId: id, after: doc.outline.children(id).at(-1) ?? null, entries: [{ fieldId: field.id, value: text }] }));
        const saving = doc.flush();
        await reached.promise;
        doc.undo();
        expect(ids(doc)).toEqual([first]);
        gate.resolve();
        await saving;
        await doc.flush();
        expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first]);
        expect(doc.saveState()).toBe('saved');
        doc.redo(); await doc.flush();
        const restored = await api.page(id);
        expect(restored.rows.map(row => row.block.id)).toEqual([first, ...written.created]);
        expect(restored.rows.at(-1)?.block.text).toBe(text);
        doc.undo(); await doc.flush();
        await (doc as Document).reload(false);
        expect(ids(doc)).toEqual([first]);
      } finally { gate.resolve(); globalThis.fetch = actualFetch; doc.release(); }
    }
    definitions.release();
  });

  test('coalesced text undo and redo preserve another window’s non-overlapping words', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Alpha / Omega');
    success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Another row' }));
    await instance.flush();
    success(doc.edit({ kind: 'text', id: first, text: 'M Alpha / Omega', caret: 2 }, { id: first, offset: 0 }));
    success(doc.edit({ kind: 'text', id: first, text: 'My Alpha / Omega', caret: 3 }, { id: first, offset: 2 }));
    await instance.flush();
    await api.submit({ actor: { kind: 'agent', name: 'other-window text' }, operations: [
      { op: 'edit_text', id: first, base_revision: (await api.block(first)).revision, text: 'My Alpha / Elsewhere' },
    ] });
    await eventually(() => doc.block(first)?.text === 'My Alpha / Elsewhere', 'remote wording did not arrive');
    expect(doc.undo()).toEqual({ id: first, offset: 0 });
    expect(doc.block(first)?.text).toBe('Alpha / Elsewhere');
    expect(doc.historyMessage()).toBe('');
    await instance.flush();
    expect(doc.redo()).toEqual({ id: first, offset: 3 });
    expect(doc.block(first)?.text).toBe('My Alpha / Elsewhere');
    await instance.flush();
    expect((await api.block(first)).text).toBe('My Alpha / Elsewhere');
  });

  test('text history skips an overlapping remote edit without overwriting it', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Original');
    success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Another row' }));
    await instance.flush();
    success(doc.edit({ kind: 'text', id: first, text: 'Mine', caret: 4 }, { id: first, offset: 0 }));
    await instance.flush();
    await api.submit({ actor: { kind: 'agent', name: 'overlapping text' }, operations: [
      { op: 'edit_text', id: first, base_revision: (await api.block(first)).revision, text: 'Theirs' },
    ] });
    await eventually(() => doc.block(first)?.text === 'Theirs', 'remote wording did not arrive');
    expect(doc.undo()).toBeNull();
    expect(doc.historyMessage()).toBe('Changed elsewhere; nothing to undo here');
    expect(doc.canRedo()).toBe(false);
    expect(doc.block(first)?.text).toBe('Theirs');
    await instance.flush();
    expect((await api.block(first)).text).toBe('Theirs');
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

  test.each([0, -1])('sync reloads changed text with revision delta %s', async delta => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'phone text');
    const view = await api.page(id);
    const block = view.rows.find(row => row.block.id === first)!.block;
    const changed = { ...block, text: 'hub text', revision: block.revision + delta };
    const pulled = { ...view, rows: view.rows.map(row => row.block.id === first ? { ...row, block: changed } : row) };
    const seq = (await api.changeHead()) + 1;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/pages/${id}`) return Response.json(pulled);
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      const event: ChangeEvent = { seq, actor: { kind: 'client', name: 'sync' }, reason: null, created_at: Date.now(),
        blocks: [changed], removed: [], restructured_pages: [id], views: [], settings: [] };
      await instance['change'](event);
      expect(doc.block(first)?.text).toBe('hub text');
      expect(doc.block(first)?.revision).toBe(changed.revision);
      expect(instance.lookup(first)()?.text).toBe('hub text');
    } finally {
      globalThis.fetch = actualFetch;
      await instance.dispose();
    }
  });

  test('page deletion undo restores the original root and descendant IDs', async () => {
    const instance = await client();
    const { doc, id, first } = await page(instance, 'keep this ID');
    await instance.deletePage(id);
    expect(instance.roots().some(root => root.id === id)).toBe(false);
    expect(doc.status()).toBe('missing');
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);
    await instance.restorePage(id);
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first]);
    expect(doc.status()).toBe('ready');
    expect(doc.block(first)?.text).toBe('keep this ID');
  });

  test('created-page undo retains later edit redo through deletion and restoration', async () => {
    const instance = await client();
    const { doc, id, first } = await page(instance, 'keep this child');
    const original = doc.block(id)!.text;
    const renamed = `${original} renamed`;
    success(doc.edit({ kind: 'text', id, text: renamed }));
    await doc.flush();
    doc.undo();
    await doc.flush();
    expect(doc.block(id)?.text).toBe(original);
    expect(doc.canRedo()).toBe(true);
    await instance.deletePage(id, { retainHistory: true });
    expect(doc.status()).toBe('missing');
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);
    await instance.restorePage(id);
    expect(doc.canRedo()).toBe(true);
    doc.redo();
    await doc.flush();
    expect((await api.page(id)).root.text).toBe(renamed);
    expect((await api.page(id)).rows.map(row => row.block.id)).toEqual([first]);
    expect(doc.block(first)?.text).toBe('keep this child');
    doc.release();
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

  test('canonical spelling and Unicode case variants cannot create or rename a duplicate page', async () => {
    const instance = await client();
    const { doc } = await page(instance);
    for (const [written, equivalent] of [['café', 'cafe\u0301'], ['ΟΣ', 'οσ'], ['Straße', 'STRASSE']]) {
      const suffix = ` ${++serial}`;
      const title = written! + suffix, duplicate = equivalent! + suffix;
      const id = await instance.createPage(title);
      expect(instance.titleAvailable(duplicate, '')).toBe(false);
      expect(instance.titleAvailable(duplicate, id)).toBe(true);
      await expect(instance.createPage(duplicate)).rejects.toThrow('already taken');
      const before = doc.root()?.text;
      expect(doc.rename(duplicate).ok).toBe(false);
      expect(doc.root()?.text).toBe(before);
      await instance.flush();
      expect((await api.pageByTitle(duplicate)).id).toBe(id);
      expect((await api.page(id)).root.text).toBe(title);
    }
  });

  test('tagged page names match locally and on the server and refuse duplicate names', async () => {
    const instance = await client();
    const name = `Lab ${++serial}`;
    const id = await instance.createPage(`${name} #project`);
    expect(await instance.pageByTitle(name, false)).toBe(id);
    expect(instance.titleAvailable(name, '')).toBe(false);
    await expect(instance.createPage(`${name} #person`)).rejects.toThrow('already taken');
    await instance.flush();
    expect((await api.pageByTitle(name)).id).toBe(id);
    expect((await api.block(id)).text).toContain(`${name} #[[`);
    expect(await instance.pageByTitle(`${name} #[[project]]`, false)).toBe(id);
    expect(instance.titleAvailable(`${name} #person`, id)).toBe(true);
    const { doc } = await page(instance);
    expect(doc.rename(name).ok).toBe(false);
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
      // Recovery shows and copies the words, not the action payload with its block IDs.
      for (const text of [instance.rejectedText(), instance.unsavedText()]) expect(text).not.toContain(first);
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

  test('Backspace removes a project before merging, deletes an empty one, and undo restores it', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Journal day');
    success(doc.edit({ kind: 'text', id: first, text: 'Notes' }));
    const build = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Build Tessera' })).created[0]!;
    const project = { outcome: 'Ship it', deadline: null, status: 'active' as const };
    success(doc.edit({ kind: 'project', id: build, value: project }));
    await doc.flush();
    expect(doc.edit({ kind: 'merge', sourceId: build, destinationId: first }).ok).toBe(false);
    const remove = boundaryDeletion(doc, build, 'backward', first);
    expect(remove).toEqual({ kind: 'project', id: build, value: null });
    success(doc.edit(remove!, { id: build, offset: 0 }));
    expect(boundaryDeletion(doc, build, 'backward', first)).toEqual({ kind: 'merge', sourceId: build, destinationId: first });
    doc.undo();
    await doc.flush();
    expect(doc.block(build)?.project).toEqual(project);
    success(doc.edit({ kind: 'text', id: build, text: '' }));
    const drop = boundaryDeletion(doc, build, 'backward', first);
    expect(drop).toEqual({ kind: 'delete', ids: [build] });
    success(doc.edit(drop!, { id: build, offset: 0 }));
    expect(doc.block(build)).toBeUndefined();
    await doc.flush();
    doc.undo();
    await doc.flush();
    expect(doc.block(build)?.project).toEqual(project);
    expect((await api.capabilities(build)).project).toEqual(project);
  });

  test('Backspace drops a relation, perspective, assessment or question one at a time, and undo restores acceptance', async () => {
    const instance = await client();
    const holder = await instance.createPage(`Backspace holder ${++serial}`);
    const target = await instance.createPage(`Backspace target ${++serial}`);
    const { doc, first, id } = await page(instance, `[[${holder}]]`);
    success(doc.edit({ kind: 'position', id: first, value: true }));
    const note = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'A plain note' })).created[0]!;
    const edge = success(doc.edit({ kind: 'insert', parentId: first, after: note, text: `Disputes [[${target}]]` })).created[0]!;
    await doc.flush();
    success(doc.edit({ kind: 'relation', id: edge, value: 'disputes' }));
    const question = success(doc.edit({ kind: 'insert', parentId: id, after: first, text: 'Why?' })).created[0]!;
    success(doc.edit({ kind: 'question', id: question, value: { unsettled: false, parked: false, accepted: null, review_on: null } }));
    await doc.flush();
    const answer = success(doc.edit({ kind: 'writeAssessment', parentId: question, assessedOn: '2026-10-13' })).created[0]!;
    success(doc.edit({ kind: 'text', id: answer, text: 'Because' }));
    await doc.flush();
    success(doc.edit({ kind: 'question', id: question, value: currentReading(doc.block(question)!.question!.state, answer, '2026-10-13') }));
    await doc.flush();

    expect(boundaryDeletion(doc, edge, 'backward', note)).toEqual({ kind: 'relation', id: edge, value: null });
    expect(boundaryDeletion(doc, first, 'backward')).toEqual({ kind: 'position', id: first, value: false });
    expect(boundaryDeletion(doc, question, 'backward', edge)).toEqual({ kind: 'question', id: question, value: null });
    const drop = boundaryDeletion(doc, answer, 'backward', question);
    expect(drop).toEqual({ kind: 'assessment', id: answer, value: null });
    success(doc.edit(drop!, { id: answer, offset: 0 }));
    expect(doc.block(question)?.question?.state.accepted).toBeNull();
    expect(boundaryDeletion(doc, answer, 'backward', question)).toEqual({ kind: 'outdent', ids: [answer] });
    await doc.flush();
    doc.undo(); await doc.flush();
    expect(doc.block(answer)?.assessment).not.toBeNull();
    expect((await api.capabilities(question)).question?.state.accepted).toBe(answer);
    doc.release();
  });

  test('Shift+Tab takes an empty continued todo out of its list only below a plain line', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Reader');
    const jitter = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Fix jitter' })).created[0]!;
    success(doc.edit({ kind: 'task', id: jitter, value: todo }));
    const next = success(doc.edit({ kind: 'split', id: jitter, offset: 'Fix jitter'.length })).created[0]!;
    expect(doc.block(next)?.task).toEqual(todo);
    await doc.flush();
    const at = { id: next, offset: 0 };
    success(doc.edit({ kind: 'outdent', ids: [next] }, at));
    expect(doc.outline.parentOf(next)).toBe(doc.outline.parentOf(first));
    expect(doc.block(next)?.task).toBeNull();
    await doc.flush();
    expect(doc.undo()).toEqual(at);
    expect(doc.outline.parentOf(next)).toBe(first);
    expect(doc.block(next)?.task).toEqual(todo);
    await doc.flush();
    // Below a task the outdented line stays in that task list, and written text keeps its task.
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    success(doc.edit({ kind: 'outdent', ids: [next] }, at));
    expect(doc.block(next)?.task).toEqual(todo);
    success(doc.edit({ kind: 'indent', ids: [next] }, at));
    success(doc.edit({ kind: 'task', id: first, value: null }));
    success(doc.edit({ kind: 'text', id: next, text: 'Sync' }));
    success(doc.edit({ kind: 'outdent', ids: [next] }, at));
    expect(doc.block(next)?.task).toEqual(todo);
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

  test.each([null, 'fixed', 'after_completion'] as const)('Agenda history queues immediate Undo of a %s completion before source work settles', async mode => {
    const instance = await client();
    const { doc, id, first } = await page(instance, 'Complete from Agenda');
    const planned: TaskState = { ...todo, scheduled: '2026-10-01', repeater: mode ? { mode, every: 1, unit: 'day' } : null };
    success(doc.edit({ kind: 'task', id: first, value: planned }));
    await doc.flush();
    const source = { block: await api.block(first), page: await api.block(id) };
    const row = { source, task: planned, project_id: null, section_id: null, section_text: null };
    const history = new TaskSourceHistory(instance);
    const work = Promise.withResolvers<void>();
    const completing = history.edit(row, async sourceDoc => {
      await work.promise;
      success(sourceDoc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-15' }));
    });
    doc.release();
    const undoing = history.undo();
    work.resolve();
    await Promise.all([completing, undoing]);
    expect((await api.capabilities(first)).task).toEqual(planned);
    expect((await api.taskOccurrences(first)).every(event => event.reversed)).toBe(true);
    await history.undo(true);
    expect((await api.taskOccurrences(first)).filter(event => !event.reversed)).toHaveLength(1);
    expect((await api.capabilities(first)).task?.scheduled).toBe(mode === 'after_completion' ? '2026-10-16' : mode === 'fixed' ? '2026-10-02' : '2026-10-01');
    history.dispose();
  });

  test('removing a tagged Done task records behavior and restores its full state on undo', async () => {
    const instance = await client();
    const { doc, first, id } = await page(instance, 'Undo lamp #task ');
    success(doc.addType(first, 'Task'));
    const planned = { ...todo, scheduled: '2026-10-17', scheduled_time: '09:30', deadline: '2026-10-19' };
    success(doc.edit({ kind: 'task', id: first, value: planned }));
    await doc.flush();
    success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-18' }));
    await doc.flush();
    const before = structuredClone(doc.block(first)!.task), text = doc.block(first)!.text;
    const occurrences = await api.taskOccurrences(first);
    const bodies: Batch[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/batches') && init?.body) bodies.push(JSON.parse(String(init.body)) as Batch);
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      success(doc.edit({ kind: 'task', id: first, value: null }));
      await doc.flush();
      expect(bodies[0]!.operations.some(operation => operation.op === 'set_task' && operation.task === null)).toBe(true);
      expect(bodies[0]!.operations.some(operation => operation.op === 'edit_text')).toBe(false);
      expect(doc.block(first)?.text).toBe('Undo lamp ');
      expect(doc.block(first)?.task).toBeNull();
      expect(doc.block(first)?.manual_types).toEqual([]);
      doc.undo(); await doc.flush();
      expect((await api.capabilities(first)).task).toEqual(before);
      expect((await api.block(first)).text).toBe(text);
      expect(doc.block(first)?.task).toEqual(before);
      expect(doc.block(first)?.text).toBe(text);
      expect(doc.block(first)?.manual_types).toEqual(['Task']);
      expect(await api.taskOccurrences(first)).toEqual(occurrences);
      doc.redo(); await doc.flush();
      expect((await api.capabilities(first)).task).toBeNull();
      await (doc as Document).reload(false);
      expect(doc.block(first)?.text).toBe('Undo lamp ');
      expect(doc.block(first)?.task).toBeNull();
      expect((await api.page(id)).rows.find(row => row.block.id === first)?.manual_types).toEqual([]);
      expect(await api.taskOccurrences(first)).toEqual(occurrences);
    } finally { globalThis.fetch = actualFetch; doc.release(); }
  });

  test('redo after a flush during undo receipt persistence keeps its text guard current', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Flush lamp #task ');
    success(doc.addType(first, 'Task'));
    success(doc.edit({ kind: 'task', id: first, value: todo }));
    await instance.flush();
    success(doc.edit({ kind: 'completeTask', id: first, completedOn: '2026-10-18' }));
    await instance.flush();
    success(doc.edit({ kind: 'task', id: first, value: null }));
    await instance.flush();
    const document = doc as Document;
    const applied = Promise.withResolvers<void>();
    const acknowledged = document.acknowledged;
    document.acknowledged = function (...args) {
      acknowledged.apply(this, args);
      applied.resolve();
    };
    try {
      doc.undo();
      const saving = doc.flush();
      await applied.promise;
      // A second flush touches waiters after optimistic replay retires the undo,
      // while IndexedDB is still storing its receipt. Redo must already use its revision.
      await doc.flush();
      await saving;
      doc.redo();
      await doc.flush();
      expect(doc.saveState()).toBe('saved');
      expect((await api.block(first)).text).toBe('Flush lamp ');
      expect((await api.capabilities(first)).task).toBeNull();
    } finally { document.acknowledged = acknowledged; doc.release(); }
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
    await instance.flush();
    await instance.commit([{ op: 'add_type', id: holder, base_revision: (await api.block(holder)).revision, title: 'Person' }]);
    const { doc, first, id } = await page(instance, `[[${holder}]]`);
    expect(doc.edit({ kind: 'position', id, value: true }).ok).toBe(false);
    success(doc.edit({ kind: 'position', id: first, value: true }));
    expect(doc.block(first)?.position).toEqual({ holder_id: null, subject_id: id });
    await doc.flush();
    expect(doc.block(first)?.position).toEqual({ holder_id: holder, subject_id: id });
    expect((await api.capabilities(first)).position).toEqual({ holder_id: holder, subject_id: id });
    expect((await api.positions({ holder, subject: id })).rows[0]?.block.block.id).toBe(first);
    doc.undo();
    await doc.flush();
    expect(doc.block(first)?.position).toBeNull();
    expect((await api.capabilities(first)).position).toBeNull();
    doc.redo();
    await doc.flush();
    expect(doc.block(first)?.position).toEqual({ holder_id: holder, subject_id: id });
    success(doc.edit({ kind: 'text', id: first, text: 'Unattributed' }));
    await doc.flush();
    // Losing its holder keeps the perspective and reports a problem to fix.
    expect(doc.block(first)?.position).toMatchObject({ holder_id: null, subject_id: id });
    expect(doc.block(first)?.position?.problem).toBeTruthy();
    expect((await api.positions({ holder })).rows).toEqual([]);
    doc.release();
  });

  test('relation kinds undo without rewriting reasoning and incompatible capabilities are refused', async () => {
    const instance = await client();
    const holder = await instance.createPage(`Relation holder ${++serial}`);
    const target = await instance.createPage(`Relation target ${++serial}`);
    const { doc, first } = await page(instance, `[[${holder}]]`);
    success(doc.edit({ kind: 'position', id: first, value: true }));
    const text = `Disputes [[${target}]] for an authored reason.`;
    const edge = success(doc.edit({ kind: 'insert', parentId: first, after: null, text })).created[0]!;
    await doc.flush();
    success(doc.edit({ kind: 'relation', id: edge, value: 'disputes' }));
    await doc.flush();
    const [row] = await api.relations({ kind: 'disputes', source_holder: holder, target });
    expect(row?.block.block.id).toBe(edge);
    expect(row?.source.block.block.id).toBe(first);
    expect(row?.source.holder_id).toBe(holder);
    expect(row?.target?.block.block.id).toBe(target);
    doc.undo(); await doc.flush();
    expect(doc.block(edge)?.relation).toBeNull();
    expect((await api.relations({ target })).length).toBe(0);
    expect(doc.block(edge)?.text).toBe(text);
    doc.redo(); await doc.flush();
    expect(doc.block(edge)?.relation?.kind).toBe('disputes');
    success(doc.edit({ kind: 'relation', id: edge, value: 'answers' }));
    await doc.flush();
    expect(doc.block(edge)?.relation?.problem).toBeTruthy();
    expect(doc.block(edge)?.text).toBe(text);
    expect(doc.edit({ kind: 'position', id: edge, value: true }).ok).toBe(false);
    expect(doc.edit({ kind: 'question', id: edge, value: { unsettled: false, parked: false, accepted: null, review_on: null } }).ok).toBe(false);
    success(doc.edit({ kind: 'relation', id: edge, value: null }));
    await doc.flush();
    expect(doc.block(edge)?.text).toBe(text);
    doc.undo(); await doc.flush();
    expect((await api.capabilities(edge)).relation?.kind).toBe('answers');
    expect(doc.edit({ kind: 'relation', id: first, value: 'supports' }).ok).toBe(false);
    const question = success(doc.edit({ kind: 'insert', parentId: doc.pageId, after: first, text: 'Question' })).created[0]!;
    success(doc.edit({ kind: 'question', id: question, value: { unsettled: false, parked: false, accepted: null, review_on: null } }));
    expect(doc.edit({ kind: 'relation', id: question, value: 'answers' }).ok).toBe(false);
    await doc.flush();
    doc.release();
  });

  test('adding a last child relation and removing its slash token is one undoable authored action', async () => {
    const instance = await client();
    const target = await instance.createPage(`Added relation target ${++serial}`);
    const { doc, first, id } = await page(instance, 'A reading /add relation');
    success(doc.edit({ kind: 'position', id: first, value: true }));
    const existing = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Existing prose' })).created[0]!;
    await doc.flush();
    const edge = success(doc.edit({ kind: 'addRelation', parentId: first, value: 'supports', targetId: target, sourceText: 'A reading' })).created[0]!;
    expect(doc.outline.children(first)).toEqual([existing, edge]);
    expect(doc.block(edge)?.relation?.kind).toBe('supports');
    await doc.flush();
    expect(doc.block(first)?.text).toBe('A reading');
    expect((await api.relations({ source: first }))[0]?.target?.block.block.id).toBe(target);
    doc.undo(); await doc.flush();
    expect(doc.outline.children(first)).toEqual([existing]);
    expect(doc.block(first)?.text).toBe('A reading /add relation');
    expect((await api.relations({ source: first })).length).toBe(0);
    expect((await api.page(id)).rows.some(row => row.block.id === edge)).toBe(false);
    doc.redo(); await doc.flush();
    expect(doc.block(first)?.text).toBe('A reading');
    expect(doc.outline.children(first)).toEqual([existing, edge]);
    expect((await api.capabilities(edge)).relation?.kind).toBe('supports');
    const other = await client();
    const reloaded = other.open(id);
    await eventually(() => reloaded.status() === 'ready', 'Relation document did not reload');
    expect(reloaded.block(edge)?.text).toBe(`[[${target}]]`);
    expect(reloaded.block(edge)?.relation?.source_id).toBe(first);
    reloaded.release(); doc.release();
  });

  test('reading prose excludes edge subtrees but never infers edges from words', async () => {
    const instance = await client();
    const target = await instance.createPage(`Reading edge target ${++serial}`);
    const { doc, first } = await page(instance, 'Position');
    success(doc.edit({ kind: 'position', id: first, value: true }));
    const prose = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Disputes are part of ordinary prose.' })).created[0]!;
    const edge = success(doc.edit({ kind: 'addRelation', parentId: first, value: 'qualifies', targetId: target })).created[0]!;
    success(doc.edit({ kind: 'insert', parentId: edge, after: null, text: 'Evidence belongs to the edge, not the reading.' }));
    const ending = success(doc.edit({ kind: 'insert', parentId: first, after: edge, text: 'The reading continues.' })).created[0]!;
    const nested = success(doc.edit({ kind: 'insert', parentId: first, after: ending, text: 'Nested position' })).created[0]!;
    success(doc.edit({ kind: 'position', id: nested, value: true }));
    success(doc.edit({ kind: 'addRelation', parentId: nested, value: 'supports', targetId: target }));
    await doc.flush();
    expect(readingPassages(doc, first, undefined, () => undefined).map(row => row.id)).toEqual([prose, ending]);
    expect(positionRelations(doc, first).map(row => row.id)).toEqual([edge]);
    success(doc.edit({ kind: 'archive', id: edge, archived: true }));
    expect(positionRelations(doc, first)).toEqual([]);
    await doc.flush();
    doc.undo(); await doc.flush();
    expect(positionRelations(doc, first).map(row => row.id)).toEqual([edge]);
    success(doc.edit({ kind: 'relation', id: edge, value: null }));
    expect(readingPassages(doc, first, undefined, () => undefined).map(row => row.id)).toContain(edge);
    await doc.flush();
    doc.release();
  });

  test('subject criteria undo restores derivation and redo restores order', async () => {
    const instance = await client();
    const { id, doc } = await page(instance);
    const fieldsPage = (await api.fields()).page_id;
    const fields = [ulid(), ulid()];
    await instance.commit(fields.map((id, index) => ({ op: 'insert', id, parent_id: fieldsPage, after: null, text: `Criterion ${serial}-${index}`, heading: null })));
    const revision = doc.root()!.revision;
    success(doc.edit({ kind: 'subjectCriteria', id, fields, previous: [], revision }));
    await doc.flush();
    expect((await api.positions({ subject: id })).criteria).toEqual({ explicit: true, fields });
    doc.undo(); await doc.flush();
    expect((await api.positions({ subject: id })).criteria).toEqual({ explicit: false, fields: [] });
    doc.redo(); await doc.flush();
    expect((await api.positions({ subject: id })).criteria).toEqual({ explicit: true, fields });
    expect(doc.root()!.revision).toBe(revision + 3);
    expect(doc.edit({ kind: 'subjectCriteria', id, fields: [], previous: fields, revision }).ok).toBe(false);
    doc.release();
  });

  test('current answer copies stored history into a durable authored state', () => {
    const decision = new Proxy({ assessment_id: 'first', status: 'current' as const, on: '2026-10-12' }, {});
    const next = currentReading({ unsettled: true, parked: false, accepted: 'first', review_on: null, reading_history: [decision] }, 'second', '2026-10-19');
    const stored = structuredClone(next);
    expect(stored.reading_history?.map(event => event.status)).toEqual(['current', 'superseded', 'current']);
    expect(stored.reading_history?.[1]?.on).toBe('2026-10-19');
    expect(decision.status).toBe('current');
  });

  test('assessment capture and branch capture each undo as one authored change', async () => {
    const instance = await client();
    const { doc, first } = await page(instance, 'Research program');
    success(doc.edit({ kind: 'question', id: first, value: { unsettled: false, parked: false, review_on: null, accepted: null } }));
    await doc.flush();
    const assessment = success(doc.edit({ kind: 'writeAssessment', parentId: first, assessedOn: '2026-10-12' })).created[0]!;
    await doc.flush();
    expect(doc.block(assessment)?.assessment?.state.assessed_on).toBe('2026-10-12');
    doc.undo(); await doc.flush();
    expect(doc.block(assessment)).toBeUndefined();
    doc.redo(); await doc.flush();
    expect(doc.block(assessment)?.assessment?.question_id).toBe(first);
    const branch = success(doc.edit({ kind: 'addBranchQuestion', parentId: first })).created[0]!;
    await doc.flush();
    expect(doc.block(branch)?.question?.parent_id).toBe(first);
    doc.undo(); await doc.flush();
    expect(doc.block(branch)).toBeUndefined();
    doc.redo(); await doc.flush();
    expect(doc.block(branch)?.question?.parent_id).toBe(first);
    const question = doc.block(first)!.question!.state;
    success(doc.edit({ kind: 'question', id: first, value: currentReading(question, assessment, '2026-10-12') }));
    await doc.flush();
    success(doc.edit({ kind: 'assessment', id: assessment, value: null }));
    await doc.flush();
    expect(doc.block(first)?.question?.state.accepted).toBeNull();
    doc.undo(); await doc.flush();
    expect(doc.block(first)?.question?.state.accepted).toBe(assessment);
    success(doc.edit({ kind: 'question', id: first, value: null }));
    await doc.flush();
    doc.undo(); await doc.flush();
    expect(doc.block(first)?.question?.state.accepted).toBe(assessment);
    expect((await api.questions({ state: 'answered', include_inline: true })).some(row => row.block.block.id === first)).toBe(true);
    expect((await api.questions({ state: 'active' })).some(row => row.block.block.id === first)).toBe(false);
    expect((await api.questions({ include_inline: false })).some(row => row.block.block.id === first)).toBe(false);
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
    const answer = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Current answer' })).created[0]!;
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

  test('parent question edits undo and redo and survive parent removal', async () => {
    const instance = await client();
    const { id, doc, first } = await page(instance, 'Branch question');
    const value = { unsettled: false, parked: false, review_on: null, accepted: null };
    success(doc.edit({ kind: 'question', id, value }));
    success(doc.edit({ kind: 'question', id: first, value }));
    await doc.flush();
    expect(doc.block(first)?.question?.parent_id).toBe(id);
    expect(doc.block(first)?.question?.parent_explicit).toBe(false);
    const other = await page(instance, 'Parent question');
    success(other.doc.edit({ kind: 'question', id: other.id, value }));
    await other.doc.flush();
    success(doc.edit({ kind: 'question', id: first, value: { ...value, parent: other.id } }));
    await doc.flush();
    expect(doc.block(first)?.question?.parent_id).toBe(other.id);
    expect(doc.block(first)?.question?.parent_explicit).toBe(true);
    doc.undo(); await doc.flush();
    expect(doc.block(first)?.question?.parent_id).toBe(id);
    doc.redo(); await doc.flush();
    expect((await api.questions({ parent: other.id })).map(row => row.block.block.id)).toEqual([first]);
    const revision = doc.block(first)!.revision;
    success(other.doc.edit({ kind: 'question', id: other.id, value: null }));
    await other.doc.flush();
    expect(doc.block(first)?.question?.parent_id).toBe(id);
    expect(doc.block(first)?.question?.state.parent).toBe(other.id);
    expect(doc.block(first)?.revision).toBe(revision);
    other.doc.undo(); await other.doc.flush();
    expect(doc.block(first)?.question?.parent_id).toBe(other.id);
    doc.release(); other.doc.release();
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
      expect(doc.block(sibling)?.task).toEqual(todo);
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
      success(doc.edit({ kind: 'task', id: sibling, value: null }));
      success(doc.edit({ kind: 'merge', sourceId: sibling, destinationId: source }));
      await doc.flush();
      expect(bodies.some(batch => batch.operations.some(operation => operation.op === 'merge'))).toBe(true);
    } finally { globalThis.fetch = actualFetch; }
  });
});

async function sourcePage(instance: Notebook) {
  const title = `Evidence source ${++serial}`;
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: Number(Bun.env.TESSERA_FIXTURE_TEST_PORT ?? 0), fetch: () => new Response(
    `<!doctype html><html><head><title>${title}</title><meta name="author" content="Ada Reader"><meta property="article:published_time" content="2024-06-01"></head><body><article><h1>${title}</h1><p>Frozen evidence stays attached to the passage. A reader can rewrite a highlight without changing what the source said, and return to the exact passage later.</p></article></body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  try {
    const job = await api.queueUrl(`http://127.0.0.1:${fixture.port}/source/${serial}`);
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

async function metadataSource(instance: Notebook) {
  const result = await page(instance);
  success(result.doc.edit({ kind: 'source', id: result.id, value: { format: 'record', state: 'inbox', origin: null, match_key: null, citation_key: null } }));
  await result.doc.flush();
  const fieldsDoc = instance.open((await api.fields()).page_id);
  await eventually(() => fieldsDoc.status() === 'ready', 'Fields document did not load');
  return { ...result, fieldsDoc };
}

describe('library inspector metadata commands', () => {
  test('every ordinary field uses its named definition and intended kind', async () => {
    const instance = await client();
    const { doc, fieldsDoc } = await metadataSource(instance);
    const cases: [SourceField, string, FieldKind, string][] = [
      ['subtitle', 'subtitle', 'text', 'A subtitle'], ['firstPublished', 'first published', 'date', '1846'],
      ['originalLanguage', 'original language', 'text', 'de'], ['published', 'published', 'date', '2024-02-29'],
      ['publisher', 'publisher', 'text', 'Example press'], ['edition', 'edition', 'text', 'Second'],
      ['series', 'series', 'text', 'Collected works'], ['number', 'number', 'number', '2'],
      ['pages', 'pages', 'number', '320'], ['language', 'language', 'text', 'en'],
      ['url', 'url', 'url', 'https://example.test/source'], ['site', 'site', 'text', 'Example'],
      ['description', 'description', 'text', 'First paragraph.\n\nSecond paragraph.'],
      ['cover', 'cover', 'text', `/api/library/covers/${'c'.repeat(64)}`],
      ['siglum', 'siglum', 'text', 'AbCd'], ['started', 'started', 'date', '2026-10'],
      ['finished', 'finished', 'date', '2026-10-11'],
    ];
    for (const [field, label, kind, value] of cases) {
      await saveSourceField([doc], instance, field, value);
      const definitions = (await api.fields()).fields;
      expect(definitions.find(item => item.name === label)?.kind).toBe(kind);
      expect(sourceFieldValue(doc, instance, definitions, field)).toBe(value);
    }
    const title = `${doc.root()!.text} renamed`;
    await saveSourceField([doc], instance, 'title', title);
    await saveSourceField([doc], instance, 'state', 'reading');
    await saveSourceField([doc], instance, 'citationKey', `source${++serial}`);
    expect(doc.root()?.text).toBe(title);
    expect(doc.root()?.source?.state).toBe('reading');
    expect(doc.root()?.source?.citation_key).toBe(`source${serial}`);
    for (const field of ['firstPublished', 'published', 'started', 'finished', 'siglum', 'pages', 'number'] as const) {
      await saveSourceField([doc], instance, field, '');
      expect(sourceFieldValue(doc, instance, (await api.fields()).fields, field)).toBe('');
    }
    expect(doc.root()?.source?.siglum_authored).toBe(false);
    fieldsDoc.release(); doc.release();
  }, 30000);

  test('ordered creator references retain roles and every identifier survives editing', async () => {
    const instance = await client();
    const { doc, fieldsDoc } = await metadataSource(instance);
    const first = await instance.createPage(`First creator ${++serial}`);
    const second = await instance.createPage(`Second creator ${++serial}`);
    const creators: SourceCreator[] = [
      { id: second, name: instance.lookup(second)()!.text, role: 'author' },
      { id: first, name: instance.lookup(first)()!.text, role: 'author' },
      { id: second, name: instance.lookup(second)()!.text, role: 'translator' },
      { id: null, name: `New Editor ${++serial}`, role: 'editor' },
    ];
    const changed = await saveSourceField([doc], instance, 'creators', creators);
    const definitions = (await api.fields()).fields;
    const found = sourceFieldValue(doc, instance, definitions, 'creators') as SourceCreator[];
    expect(found.filter(item => item.role === 'author').map(item => item.id)).toEqual([second, first]);
    expect(found.find(item => item.role === 'translator')?.id).toBe(second);
    expect(found.find(item => item.role === 'editor')?.id).not.toBeNull();
    expect(found.find(item => item.role === 'editor')?.name).toBe(creators[3]!.name);
    await changed.undo();
    expect(sourceFieldValue(doc, instance, definitions, 'creators')).toEqual([]);
    await changed.redo();
    expect(sourceFieldValue(doc, instance, definitions, 'creators')).toEqual(found);
    const identifiers = ['isbn:9780262033848', 'doi:10.1000/example', 'arxiv:2301.00001'];
    await saveSourceField([doc], instance, 'identifiers', identifiers);
    expect(sourceFieldValue(doc, instance, (await api.fields()).fields, 'identifiers')).toEqual(identifiers);
    expect(sourceMetadata(doc, instance, (await api.fields()).fields).identifiers).toEqual(identifiers);
    fieldsDoc.release(); doc.release();
  }, 30000);

  test('one batch and one undo restore distinct, empty and absent values with exact block identities', async () => {
    const instance = await client();
    const sources = await Promise.all([metadataSource(instance), metadataSource(instance), metadataSource(instance)]);
    const docs = sources.map(source => source.doc);
    await saveSourceField([docs[0]!], instance, 'edition', 'First');
    await saveSourceField([docs[1]!], instance, 'edition', 'Cleared');
    await saveSourceField([docs[1]!], instance, 'edition', '');
    const before = docs.map(doc => ids(doc).map(id => [id, doc.block(id)!.text]));
    const bodies: Batch[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${baseUrl}/api/batches` && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      return actualFetch(input, init);
    }) as typeof fetch;
    try {
      const change = await saveSourceField(docs, instance, 'edition', 'Shared');
      expect(bodies).toHaveLength(1);
      const after = docs.map(doc => ids(doc).map(id => [id, doc.block(id)!.text]));
      const definitions = (await api.fields()).fields;
      expect(docs.map(doc => sourceFieldValue(doc, instance, definitions, 'edition'))).toEqual(['Shared', 'Shared', 'Shared']);
      await change.undo();
      expect(bodies).toHaveLength(2);
      expect(docs.map(doc => ids(doc).map(id => [id, doc.block(id)!.text]))).toEqual(before);
      expect(sourceEntries(docs[2]!, definitions).has('edition')).toBe(false);
      await change.redo();
      expect(bodies).toHaveLength(3);
      expect(docs.map(doc => ids(doc).map(id => [id, doc.block(id)!.text]))).toEqual(after);
      // Later history travel increments revisions but does not invalidate earlier value guards.
      const later = await saveSourceField(docs, instance, 'edition', 'Later');
      await later.undo();
      await change.undo();
      expect(docs.map(doc => ids(doc).map(id => [id, doc.block(id)!.text]))).toEqual(before);
    } finally {
      globalThis.fetch = actualFetch;
      for (const source of sources) { source.fieldsDoc.release(); source.doc.release(); }
    }
  }, 30000);

  test('tags persist on page roots and their change reopens released documents for undo', async () => {
    const instance = await client();
    const { id, doc, fieldsDoc } = await metadataSource(instance);
    await saveSourceField([doc], instance, 'tags', ['Earlier', 'Original spelling']);
    const change = await saveSourceField([doc], instance, 'tags', ['History', 'To read']);
    expect((await api.page(id)).root_manual_types).toEqual(['History', 'To read']);
    fieldsDoc.release(); doc.release();
    for (let index = 0; index < 5; index++) { const other = await page(instance); other.doc.release(); }
    await change.undo();
    expect((await api.page(id)).root_manual_types).toEqual(['Earlier', 'Original spelling']);
    await change.redo();
    const reader = await client();
    const reopened = reader.open(id);
    await eventually(() => reopened.status() === 'ready', 'Tagged source did not reopen');
    expect(sourceFieldValue(reopened, reader, [], 'tags')).toEqual(['History', 'To read']);
    reopened.release();
  }, 30000);

  test('clearing snapshot-backed fields creates an authored blank and undo restores absence', async () => {
    const instance = await client();
    const { doc, fieldsDoc } = await metadataSource(instance);
    for (const field of ['url', 'site', 'description', 'cover'] as const) {
      const change = await saveSourceField([doc], instance, field, '');
      const definitions = (await api.fields()).fields;
      expect(sourceEntries(doc, definitions).has(field)).toBe(true);
      expect(sourceFieldValue(doc, instance, definitions, field)).toBe('');
      await change.undo();
      expect(sourceEntries(doc, definitions).has(field)).toBe(false);
    }
    fieldsDoc.release(); doc.release();
  });

  test('a citation collision names its owner, rolls back the entire batch and leaves unrelated saves working', async () => {
    const session = `metadata-rejection-${++serial}`;
    const instance = await client(session);
    const a = await metadataSource(instance), b = await metadataSource(instance);
    const key = `taken${++serial}`;
    await saveSourceField([a.doc], instance, 'citationKey', key);
    await expect(saveSourceField([b.doc], instance, 'citationKey', key.toUpperCase())).rejects.toThrow(a.doc.root()!.text);
    expect((await api.source(b.id)).source.citation_key).toBeNull();
    await expect(saveSourceField([a.doc, b.doc], instance, 'citationKey', `batch${++serial}`)).rejects.toThrow(a.doc.root()!.text);
    expect((await api.source(a.id)).source.citation_key).toBe(key);
    expect((await api.source(b.id)).source.citation_key).toBeNull();
    expect(instance.rejectedText()).toBe('');
    expect(instance.queuedChanges()).toBe(0);
    expect(instance.saveState()).toBe('saved');
    const recovered = await client(session);
    expect(recovered.rejectedText()).toBe('');
    expect(recovered.saveState()).toBe('saved');
    await saveSourceField([b.doc], instance, 'state', 'finished');
    expect((await api.source(b.id)).source.state).toBe('finished');
    a.fieldsDoc.release(); b.fieldsDoc.release(); a.doc.release(); b.doc.release();
  }, 30000);

  test('a stale selected source rejects all selected edits but not the next unrelated save', async () => {
    const instance = await client();
    const a = await metadataSource(instance), b = await metadataSource(instance);
    await saveSourceField([a.doc, b.doc], instance, 'publisher', 'Before');
    const definitions = (await api.fields()).fields;
    const entry = sourceEntries(b.doc, definitions).get('publisher')![0]!;
    const valueId = b.doc.outline.children(entry)[0]!;
    let intercept = true;
    const submit = instance.api.submitFrozen;
    instance.api.submitFrozen = async body => {
      const batch = JSON.parse(body) as Batch;
      if (intercept && batch.operations.some(op => op.op === 'edit_text' && op.id === valueId)) {
        intercept = false;
        const current = await api.block(valueId);
        await api.submit({ actor: { kind: 'person' }, operations: [{ op: 'edit_text', id: valueId, base_revision: current.revision, text: 'Remote' }] });
      }
      return submit(body);
    };
    try {
      await expect(saveSourceField([a.doc, b.doc], instance, 'publisher', 'Rejected')).rejects.toThrow();
      expect(sourceMetadata(a.doc, instance, definitions).publisher).toBe('Before');
      expect((await api.block(valueId)).text).toBe('Remote');
      await saveSourceField([a.doc], instance, 'state', 'reading');
      expect((await api.source(a.id)).source.state).toBe('reading');
    } finally {
      instance.api.submitFrozen = submit;
      a.fieldsDoc.release(); b.fieldsDoc.release(); a.doc.release(); b.doc.release();
    }
  }, 30000);

  test('fill missing commits the selection together and preserves existing details', async () => {
    const instance = await client();
    const a = await metadataSource(instance), b = await metadataSource(instance);
    await saveSourceField([a.doc, b.doc], instance, 'identifiers', ['doi:10.1000/example']);
    await saveSourceField([a.doc], instance, 'publisher', 'Authored');
    const lookup = instance.api.lookup;
    instance.api.lookup = async () => ({ metadata: { ...emptyMetadata(), title: 'Lookup title', publisher: 'Fetched', subtitle: 'Fetched subtitle' }, provider: 'test', cover_url: null });
    try {
      const change = await fillMissingSourceDetails([a.doc, b.doc], instance);
      const definitions = (await api.fields()).fields;
      expect(sourceMetadata(a.doc, instance, definitions).publisher).toBe('Authored');
      expect(sourceMetadata(b.doc, instance, definitions).publisher).toBe('Fetched');
      expect(sourceMetadata(a.doc, instance, definitions).subtitle).toBe('Fetched subtitle');
      await change.undo();
      expect(sourceMetadata(a.doc, instance, definitions).publisher).toBe('Authored');
      expect(sourceEntries(b.doc, definitions).has('publisher')).toBe(false);
      expect(sourceEntries(a.doc, definitions).has('subtitle')).toBe(false);
    } finally {
      instance.api.lookup = lookup;
      a.fieldsDoc.release(); b.fieldsDoc.release(); a.doc.release(); b.doc.release();
    }
  }, 30000);
});

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
      await eventually(() => recovered.connection() === 'live', 'Source recovery stream did not reconnect');
      await recovered.flush();
      expect(reopened.block(blockId)?.citations).toEqual((await api.capabilities(blockId)).citations);
      const sent = bodies.filter(body => body.operations.some(op => op.op === 'cite' && op.citation_id === nextCitation.id));
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every(body => body.operations.map(op => op.op).join(',') === 'insert,cite')).toBe(true);
      expect(new Set(sent.map(body => JSON.stringify(body))).size).toBe(1);
      expect((await api.source(id)).source.state).toBe('reading');
    } finally { globalThis.fetch = actualFetch; }
  });
});

test('an acknowledged draft insert refreshes its outline before resolving, including read-failure recovery', async () => {
  const instance = await client();
  const { id, doc } = await page(instance, 'Existing note');
  const before = [...doc.outline.children(id)];
  const inserted = ulid();
  const failedRead = Promise.withResolvers<void>();
  const bodies: string[] = [];
  let accepted = false, blockReads = true, resolved = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${baseUrl}/api/pages/${id}` && accepted && blockReads) {
      failedRead.resolve();
      throw new TypeError('Snapshot unavailable after accepted insert');
    }
    const response = await actualFetch(input, init);
    if (url === `${baseUrl}/api/batches` && init?.method === 'POST' && String(init.body).includes(inserted)) {
      bodies.push(String(init.body));
      accepted = response.ok;
    }
    return response;
  }) as typeof fetch;
  try {
    const pending = instance.commit([{
      op: 'insert', id: inserted, parent_id: id, after: before.at(-1) ?? null,
      text: 'Draft question>>Retained answer', heading: null,
    }], 'Create card', [id]).then(result => { resolved = true; return result; });
    await failedRead.promise;
    await instance.flush();
    expect(resolved).toBe(false);
    expect((await api.block(inserted)).text).toBe('Draft question>>Retained answer');
    blockReads = false;
    instance.retry();
    await pending;
    expect(doc.outline.children(id)).toEqual([...before, inserted]);
    expect(doc.block(inserted)?.text).toBe('Draft question>>Retained answer');
    expect((await api.page(id)).rows.filter(row => row.block.id === inserted)).toHaveLength(1);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bodies).size).toBe(1);
  } finally { globalThis.fetch = actualFetch; }
});

test('plain imported creator names stay plain when editing catalogue metadata', async () => {
  const instance = await client();
  const metadata = { ...emptyMetadata(), title: `Long byline ${++serial}`,
    creators: Array.from({ length: 38 }, (_, index) => ({ name: `Author Family${index}`, role: 'author' as const, create_page: false })) };
  const plan = await api.planRecord(metadata);
  await instance.commit(plan.operations, 'Import long byline');
  const doc = instance.open(plan.source_id);
  await eventually(() => doc.status() === 'ready', doc.statusMessage());
  let fields = (await api.fields()).fields;
  expect(sourceFieldValue(doc, instance, fields, 'creators')).toEqual(metadata.creators.map(creator => ({ id: null, name: creator.name, role: creator.role })));
  await saveDetails(doc, instance, { ...sourceMetadata(doc, instance, fields), publisher: 'New publisher' });
  fields = (await api.fields()).fields;
  const creators = sourceFieldValue(doc, instance, fields, 'creators') as SourceCreator[];
  await saveSourceField([doc], instance, 'creators', creators.map((creator, index) => index === 0 ? { ...creator, role: 'editor' as const } : creator));
  expect((await api.kindNotes('person')).notes.some(note => note.title.startsWith('Author Family'))).toBe(false);
  expect((sourceFieldValue(doc, instance, fields, 'creators') as SourceCreator[]).every(creator => creator.id === null)).toBe(true);
  doc.release();
});

test('removing an accepted answer and question undo restores both invariants', async () => {
  const instance = await client();
  const { doc, first } = await page(instance, 'Question');
  const question = { unsettled: false, parked: false, review_on: null, accepted: null };
  success(doc.edit({ kind: 'question', id: first, value: question }));
  await doc.flush();
  const answer = success(doc.edit({ kind: 'insert', parentId: first, after: null, text: 'Dated answer' })).created[0]!;
  await doc.flush();
  success(doc.edit({ kind: 'assessment', id: answer, value: { assessed_on: instance.todayDate(), aporia: false } }));
  await doc.flush();
  success(doc.edit({ kind: 'question', id: first, value: { ...question, accepted: answer } }));
  await doc.flush();
  success(doc.edit({ kind: 'assessment', id: answer, value: null }));
  expect(doc.block(first)?.question?.state.accepted).toBeNull();
  await doc.flush();
  expect((await api.capabilities(first)).question?.state.accepted).toBeNull();
  success(doc.edit({ kind: 'question', id: first, value: null }));
  await doc.flush();
  doc.undo();
  await doc.flush();
  expect((await api.capabilities(first)).question?.status).toBe('open');
  doc.undo();
  await doc.flush();
  expect((await api.capabilities(first)).question?.state.accepted).toBe(answer);
  expect((await api.capabilities(answer)).assessment?.accepted).toBe(true);
  doc.redo();
  await doc.flush();
  expect((await api.capabilities(first)).question?.state.accepted).toBeNull();
  expect((await api.capabilities(answer)).assessment).toBeNull();
  doc.release();
});

test('adding a stream arrival is one outline edit and undo restores exclusion', async () => {
  const instance = await client();
  const { doc } = await page(instance, 'Existing outline');
  const journal = await instance.journal(instance.todayDate());
  const anchor = ulid(), child = ulid();
  await instance.commit([
    { op: 'insert', id: anchor, parent_id: journal, after: null, text: `Notes for [[${doc.pageId}]]`, heading: null },
    { op: 'insert', id: child, parent_id: anchor, after: null, text: 'Live arrival', heading: null },
  ]);
  expect((await api.streamArrivals(doc.pageId)).map(row => row.block.id)).toContain(child);
  const before = ids(doc);
  const added = success(addArrival(doc, child)).created[0]!;
  expect(ids(doc)).toEqual([...before, added]);
  expect(embedTarget(doc.block(added)!.text)).toBe(child);
  await doc.flush();
  expect((await api.streamArrivals(doc.pageId)).map(row => row.block.id)).not.toContain(child);
  doc.undo();
  expect(ids(doc)).toEqual(before);
  await doc.flush();
  expect((await api.streamArrivals(doc.pageId)).map(row => row.block.id)).toContain(child);
  doc.redo();
  await doc.flush();
  expect((await api.streamArrivals(doc.pageId)).map(row => row.block.id)).not.toContain(child);
  expect((await api.block(child)).parent_id).toBe(anchor);
  doc.release();
});

test('images insert, place, remove and clipboard round trip in single undo steps', async () => {
  const instance = await client();
  const { doc, first, id } = await page(instance, '');
  const image = await api.uploadImage(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))], { type: 'application/octet-stream' }));
  const placed = success(doc.edit({ kind: 'placeImages', targetId: first, images: [image, image] })).created;
  expect(placed).toHaveLength(1);
  expect(doc.block(first)?.image).toEqual(image);
  await instance.flush();
  doc.undo(); await instance.flush();
  expect(doc.block(first)?.image).toBeNull();
  expect(ids(doc)).toEqual([first]);
  doc.redo(); await instance.flush();
  expect(doc.block(first)?.image).toEqual(image);
  success(doc.edit({ kind: 'image', id: first, image: null }));
  await instance.flush();
  expect(doc.block(first)?.image).toBeNull();
  doc.undo(); await instance.flush();
  expect(doc.block(first)?.image).toEqual(image);
  const inserted = success(doc.edit({ kind: 'insertImages', parentId: id, after: placed[0]!, images: [image, image] })).created;
  expect(inserted).toHaveLength(2);
  await instance.flush();
  doc.undo(); await instance.flush();
  expect(inserted.every(id => !doc.block(id))).toBe(true);
  doc.redo(); await instance.flush();
  expect(inserted.every(id => doc.block(id)?.image?.sha256 === image.sha256)).toBe(true);
  const content = parseBlockClipboard(JSON.stringify(doc.clipboard([first])))!;
  expect(clipboardText(content)).toBe('Image');
  for (const sameNotebook of [true, false]) {
    const destination = await page(instance, '');
    const at = { id: destination.first, offset: 0 };
    const pasted = success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: { ...content, scope: sameNotebook ? content.scope : 'other-notebook' } })).created[0]!;
    await instance.flush();
    expect(destination.doc.block(pasted)?.image).toEqual(sameNotebook ? image : null);
    destination.doc.undo(); await instance.flush();
    expect(destination.doc.block(destination.first)).toBeDefined();
  }
  success(doc.edit({ kind: 'text', id: first, text: 'Caption' }));
  await instance.flush();
  const split = success(doc.edit({ kind: 'split', id: first, offset: 0 })).created[0]!;
  expect(doc.block(first)?.text).toBe('Caption');
  expect(doc.outline.children(id).indexOf(split)).toBe(doc.outline.children(id).indexOf(first) + 1);
  expect(doc.block(split)?.image).toBeNull();
  await instance.flush();
  doc.undo(); await instance.flush();
  expect(doc.edit({ kind: 'merge', sourceId: first, destinationId: placed[0]! }).ok).toBe(false);
  doc.release();
});

test('image mask edits undo atomically and clipboard keeps masks only with same-notebook images', async () => {
  const instance = await client();
  const { doc, first } = await page(instance, 'Diagram');
  const image = await api.uploadImage(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))]));
  success(doc.edit({ kind: 'image', id: first, image })); await doc.flush();
  const occlusion: Occlusion = { mode: 'hide_all', groups: [{ id: 'group', hint: 'Hint', answer: 'Answer' }], masks: [{ id: 'mask', group: 'group', shape: 'ellipse', x: .1, y: .2, w: .3, h: .4 }] };
  success(doc.edit({ kind: 'occlusion', id: first, occlusion })); await doc.flush();
  expect(doc.block(first)?.occlusion).toEqual(occlusion);
  expect((await api.sourceCards(first)).filter(card => card.active)).toHaveLength(1);
  doc.undo(); await doc.flush();
  expect(doc.block(first)?.occlusion).toBeNull();
  expect(doc.block(first)?.image).toEqual(image);
  expect((await api.sourceCards(first)).filter(card => card.active)).toHaveLength(0);
  doc.redo(); await doc.flush();
  expect(doc.block(first)?.occlusion).toEqual(occlusion);
  const content = parseBlockClipboard(JSON.stringify(doc.clipboard([first])))!;
  for (const sameNotebook of [true, false]) {
    const destination = await page(instance, '');
    const at = { id: destination.first, offset: 0 };
    const pasted = success(destination.doc.edit({ kind: 'pasteBlocks', range: { anchor: at, head: at }, between: [], content: { ...content, scope: sameNotebook ? content.scope : 'other-notebook' } })).created[0]!;
    await destination.doc.flush();
    expect(destination.doc.block(pasted)?.occlusion).toEqual(sameNotebook ? occlusion : null);
    expect((await api.sourceCards(pasted)).filter(card => card.active)).toHaveLength(sameNotebook ? 1 : 0);
    destination.doc.release();
  }
  success(doc.edit({ kind: 'image', id: first, image: null })); await doc.flush();
  expect(doc.block(first)?.occlusion).toEqual(occlusion);
  expect((await api.sourceCards(first)).filter(card => card.active)).toHaveLength(0);
  doc.undo(); await doc.flush();
  expect((await api.sourceCards(first)).filter(card => card.active)).toHaveLength(1);
  doc.release();
});
