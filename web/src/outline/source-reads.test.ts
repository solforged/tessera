import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import type * as Solid from 'solid-js';
import { ulid } from 'ulid';
import type { ChangeSocket } from '../api/client';
import type { Notebook } from '../document/index';

// Dynamic imports are intentional here: mock Solid's SSR boundary before loading its consumers.
const browserEntry = 'solid-js/dist/solid.js';
const solid = await import(browserEntry) as typeof Solid;
mock.module('solid-js', () => solid);
const { createMemo, createRoot } = await import('solid-js');
const { createApi } = await import('../api/client');
const { emptyMetadata } = await import('../library/details');
const { citedSigla } = await import('../library/sigla');
const { createNotebookClient } = await import('../document/index');
const { createCitationSources, createCitedSources } = await import('./source-reads');
const { textTokens } = await import('../document/text-tokens');

const port = Bun.env.TESSERA_SOURCE_READS_TEST_PORT ?? '4617';
const baseUrl = `http://127.0.0.1:${port}`;
const api = createApi(baseUrl);
const actualFetch = globalThis.fetch;
let service: Subprocess<'ignore', 'pipe', 'pipe'>;
let directory: string;
let notebook: Notebook;
let notebookId: string;
let held: (() => void)[] | undefined;

// These cross real service and WebSocket boundaries; bounded condition polling is not a debounce assertion.
async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-source-reads-tests-'));
  const root = resolve(import.meta.dir, '../../..');
  service = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--workshop', directory, 'serve', '--port', port], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const expectedPath = await realpath(directory);
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      const info = await api.notebook();
      if (await realpath(info.path) !== expectedPath) throw new Error('The test port belongs to another notebook.');
      notebookId = info.id;
      break;
    } catch { if (Date.now() > deadline) throw new Error(`Service did not start: ${await new Response(service.stderr).text()}`); await Bun.sleep(20); }
  }
  notebook = createNotebookClient({ baseUrl, sessionId: ulid(), notebookId, databaseName: `source-reads-${ulid()}` });
  // Holding stream events back keeps this window's own saves from being announced twice.
  const stream = notebook.api.stream;
  notebook.api.stream = after => {
    const socket = stream(after);
    return {
      get readyState() { return socket.readyState; },
      get onopen() { return socket.onopen; }, set onopen(value) { socket.onopen = value; },
      get onerror() { return socket.onerror; }, set onerror(value) { socket.onerror = value; },
      get onclose() { return socket.onclose; }, set onclose(value) { socket.onclose = value; },
      get onmessage() { return socket.onmessage; },
      set onmessage(value) { socket.onmessage = value && (message => held ? held.push(() => value(message)) : value(message)); },
      close: () => socket.close(),
    } as ChangeSocket;
  };
  await notebook.ready;
});
afterAll(async () => {
  globalThis.fetch = actualFetch;
  await notebook?.dispose();
  service?.kill();
  if (service) await service.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('an open concept page rereads a cited source only when that source changes', async () => {
  const plan = await api.planRecord({ ...emptyMetadata(), title: 'The Open Society', creators: [{ name: 'Karl Popper', role: 'author' }] });
  await notebook.commit(plan.operations, 'Add source');
  const source = plan.source_id;
  const concept = ulid(), unrelated = ulid(), arendt = ulid();
  await api.submit({ actor: { kind: 'person' }, operations: [
    { op: 'create_page', id: arendt, title: 'Hannah Arendt' },
    { op: 'add_type', id: arendt, base_revision: 1, title: 'Person' },
    { op: 'create_page', id: concept, title: 'Openness' },
    { op: 'insert', id: unrelated, parent_id: concept, after: null, text: 'An unrelated thought', heading: null },
    { op: 'insert', id: ulid(), parent_id: concept, after: unrelated, text: `As argued in [[${source}|Popper]].`, heading: null },
  ] });

  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const read = /^\/api\/blocks\/([^/]+)\/capabilities$/.exec(url.pathname);
    if (read) reads.push(decodeURIComponent(read[1]!));
    return actualFetch(input, init);
  }) as typeof fetch;

  const conceptDoc = notebook.open(concept);
  const sourceDoc = notebook.open(source);
  await eventually(() => conceptDoc.status() === 'ready' && sourceDoc.status() === 'ready' && notebook.connection() === 'live', 'pages did not load');
  // The page's sigla, wired as the outline pane wires them.
  const { sigla, dispose } = createRoot(dispose => {
    const texts = () => conceptDoc.outline.children(concept).map(id => conceptDoc.block(id)?.text ?? '');
    const referenceSources = createCitationSources(notebook, texts);
    const cited = createMemo(() => [...referenceSources()?.keys() ?? []]);
    const records = createCitedSources(notebook, cited);
    return { sigla: createMemo(() => citedSigla(records())), dispose };
  });
  try {
    await eventually(() => sigla().get(source) === 'POP', 'the cited source had no siglum');
    const before = reads.length;
    expect(reads).toContain(source);

    // An edit in this window, then one from elsewhere, each saved and announced.
    const own = conceptDoc.edit({ kind: 'text', id: unrelated, text: 'An unrelated thought, revised' });
    expect(own.ok).toBe(true);
    await conceptDoc.flush();
    const remote = await api.submit({ actor: { kind: 'agent', name: 'source reads test' }, operations: [
      { op: 'edit_text', id: unrelated, base_revision: (await api.block(unrelated)).revision, text: 'Edited elsewhere' },
    ] });
    await eventually(() => conceptDoc.block(unrelated)?.text === 'Edited elsewhere' && notebook.changeSequence() >= remote.seq, 'the remote edit did not arrive');
    await Bun.sleep(100);
    expect(reads.slice(before)).toEqual([]);

    // Changing the Author on the open source page reaches the concept page's siglum from the save's receipt alone.
    held = [];
    const [author] = sourceDoc.outline.children(source).flatMap(id => sourceDoc.outline.children(id));
    expect(notebook.lookup(textTokens(sourceDoc.block(author!)!.text)[0]!.id!)()?.text).toBe('Karl Popper');
    expect(sourceDoc.edit({ kind: 'text', id: author!, text: `[[${arendt}]]` }).ok).toBe(true);
    await sourceDoc.flush();
    await eventually(() => sigla().get(source) === 'ARE', 'the edited author did not change the siglum');
    expect(reads.slice(before)).toEqual([source]);
    for (const release of held.splice(0)) release();
    held = undefined;

    // So does renaming the linked author, elsewhere.
    await api.submit({ actor: { kind: 'agent', name: 'source reads test' }, operations: [
      { op: 'edit_text', id: arendt, base_revision: (await api.block(arendt)).revision, text: 'Simone Weil' },
    ] });
    await eventually(() => sigla().get(source) === 'WEI', 'the renamed author did not change the siglum');
  } finally { dispose(); }
}, 20000);
