import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from '../document/index';
import type { Notebook } from '../document/index';
import type { PageDocument } from '../document/contract';
import { ensureField, isFreshField } from './source-fields';

// Bun loads Solid's server build, so effects cannot signal real document I/O readiness here.
async function ready(doc: PageDocument) {
  const deadline = Date.now() + 5000;
  while (doc.status() === 'loading') {
    if (Date.now() > deadline) throw new Error('Document did not load.');
    await Bun.sleep(10);
  }
  expect(doc.status()).toBe('ready');
}

test('ensureField returns the definition the service created, which for a built-in name is the core’s', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-ensure-field-test-'));
  const root = resolve(import.meta.dir, '../../..');
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port!; listener.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--workshop', directory, 'serve', '--port', String(port), '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let notebook: Notebook | undefined;
  try {
    // A real subprocess's HTTP listener cannot be advanced with fake timers.
    const deadline = Date.now() + 10000;
    while (true) {
      try { await api.notebook(); break; }
      catch { if (Date.now() > deadline) throw new Error('Service did not start.'); await Bun.sleep(20); }
    }
    const info = await api.notebook();
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `ensure-field-${ulid()}` });
    await notebook.ready;
    const person = ulid(), group = ulid();
    await notebook.commit([{ op: 'create_page', id: person, title: 'Person' }, { op: 'create_page', id: group, title: 'Group' }]);
    const fieldsDoc = notebook.open((await api.fields()).page_id);
    try {
      await ready(fieldsDoc);
      // What typing `Gloss:: …` asks for: the typed name, a text kind and the default role.
      const gloss = await ensureField(notebook, 'Gloss', 'text', 'attribute');
      expect(gloss).toMatchObject({ name: 'gloss', kind: 'text', role: 'standfirst', built_in: true });
      // The open Fields register reads the lowercase name the receipt carried.
      expect(fieldsDoc.block(gloss.id)?.text).toBe('gloss');

      // A built-in field's kind is the core's, so it never waits for a first value to guess one.
      const author = await ensureField(notebook, 'Author', 'text', 'attribute', true);
      expect(author).toMatchObject({ name: 'author', kind: 'instance', targets: [person, group], counts_as: 'creator', built_in: true });
      expect(isFreshField(notebook, author.id)).toBe(false);
      expect((await ensureField(notebook, 'Published', 'number')).kind).toBe('date');
      const form = await ensureField(notebook, 'Form');
      expect(form.kind).toBe('choice');
      expect(form.options.map(option => option.text)).toEqual(['book', 'chapter', 'article', 'paper', 'report', 'post', 'thread', 'video', 'web page']);

      // A name of the workshop's own keeps what was asked for.
      const mood = await ensureField(notebook, 'Mood', 'number', 'attribute', true);
      expect(mood).toMatchObject({ name: 'Mood', kind: 'number' });
      expect(mood.built_in).toBeFalsy();
      expect(isFreshField(notebook, mood.id)).toBe(true);
      expect((await ensureField(notebook, 'mood')).id).toBe(mood.id);
    } finally { fieldsDoc.release(); }
  } finally {
    await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true });
  }
}, 30000);
