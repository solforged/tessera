import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from '../document/index';
import type { Notebook } from '../document/index';
import { changeFieldKind, renameField, setFieldTargets } from './commands';

test('template rows rename, relink and change a young field in place, each with one undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-field-edits-'));
  const root = resolve(import.meta.dir, '../../..');
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port!; listener.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', String(port), '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let notebook: Notebook | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await api.notebook(); break; }
      catch { if (Date.now() > deadline) throw new Error('Service did not start.'); await Bun.sleep(20); }
    }
    const info = await api.notebook();
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `field-edits-${ulid()}` });
    await notebook.ready;
    const fields = await api.fields();
    const strength = ulid(); const mood = ulid(); const person = ulid();
    await notebook.commit([
      { op: 'create_page', id: person, title: 'Person' },
      { op: 'insert', id: strength, parent_id: fields.page_id, after: null, text: 'strength', heading: null },
      { op: 'insert', id: mood, parent_id: fields.page_id, after: strength, text: 'mood', heading: null },
    ]);
    const definition = async (id: string) => (await api.fields()).fields.find(field => field.id === id)!;

    const renamed = await renameField(notebook, await definition(strength), 'force');
    expect((await definition(strength)).name).toBe('force');
    await renamed.undo();
    expect((await definition(strength)).name).toBe('strength');
    await renamed.redo();
    expect((await definition(strength)).name).toBe('force');
    await expect(renameField(notebook, await definition(strength), 'MOOD')).rejects.toThrow('A field named MOOD already exists.');

    // A field with no values reads under any kind, so the change applies without review.
    const detail = await api.fieldDetail(strength, 'instance');
    expect(detail.problems_total).toBe(0);
    const kind = await changeFieldKind(notebook, detail, {});
    expect((await definition(strength)).kind).toBe('instance');
    await kind.undo();
    expect((await definition(strength)).kind).toBe('text');
    await kind.redo();
    // Only the latest change offers Undo, so each is undone before the next is made.
    const linked = await setFieldTargets(notebook, await definition(strength), [person]);
    expect((await definition(strength)).targets).toEqual([person]);
    await linked.undo();
    expect((await definition(strength)).targets).toEqual([]);
  } finally {
    await notebook?.dispose();
    process.kill();
    await process.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
