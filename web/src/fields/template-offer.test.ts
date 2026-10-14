import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from '../document/index';
import type { Notebook } from '../document/index';
import { addTemplateField } from './commands';
import { templateOffer } from './template-offer';

test('a field is offered to a tag on its second use, once, and adding it undoes and redoes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-template-offer-'));
  const root = resolve(import.meta.dir, '../../..');
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port!; listener.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', String(port), '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const notebooks: Notebook[] = [];
  const client = async () => {
    const info = await api.notebook();
    const notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `template-offer-${ulid()}` });
    notebooks.push(notebook);
    await notebook.ready;
    return notebook;
  };
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await api.notebook(); break; }
      catch { if (Date.now() > deadline) throw new Error('Service did not start.'); await Bun.sleep(20); }
    }
    const notebook = await client();
    const fields = await api.fields();
    const proposition = ulid(); const book = ulid(); const strength = ulid();
    const [a, b, entryA, entryB, valueA, valueB] = [ulid(), ulid(), ulid(), ulid(), ulid(), ulid()];
    const owner = (id: string, text: string) => ({ id, text, manual_types: [] });
    await notebook.commit([
      { op: 'create_page', id: proposition, title: 'Proposition' }, { op: 'create_page', id: book, title: 'Structure' },
      { op: 'insert', id: strength, parent_id: fields.page_id, after: null, text: 'strength', heading: null },
      { op: 'insert', id: a, parent_id: book, after: null, text: 'Normal science is puzzle-solving #proposition', heading: null },
      { op: 'insert', id: b, parent_id: book, after: a, text: 'Anomalies accumulate #proposition', heading: null },
      { op: 'insert', id: entryA, parent_id: a, after: null, text: `[[${strength}]]`, heading: null },
      { op: 'insert', id: valueA, parent_id: entryA, after: null, text: 'high', heading: null },
    ]);
    // One use may be a one-off.
    expect(await templateOffer(notebook, owner(a, 'Normal science is puzzle-solving #proposition'), strength)).toBeNull();
    await notebook.commit([
      { op: 'insert', id: entryB, parent_id: b, after: null, text: `[[${strength}]]`, heading: null },
      { op: 'insert', id: valueB, parent_id: entryB, after: null, text: 'low', heading: null },
    ]);
    const offer = await templateOffer(notebook, owner(b, 'Anomalies accumulate #proposition'), strength);
    expect(offer?.type.page.id).toBe(proposition);
    // Asked once per window, whatever the answer.
    expect(await templateOffer(notebook, owner(a, 'Normal science is puzzle-solving #proposition'), strength)).toBeNull();

    const change = await addTemplateField(notebook, offer!.type, strength);
    expect((await api.type(proposition)).fields).toEqual([strength]);
    await change.undo();
    expect((await api.type(proposition)).fields).toEqual([]);
    await change.redo();
    expect((await api.type(proposition)).fields).toEqual([strength]);
    // A field already in the template is never offered, even in a new window.
    expect(await templateOffer(await client(), owner(b, 'Anomalies accumulate #proposition'), strength)).toBeNull();
  } finally {
    for (const notebook of notebooks) await notebook.dispose();
    process.kill();
    await process.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
