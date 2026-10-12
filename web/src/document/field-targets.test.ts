import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { createInstance, instancePages } from '../fields/instances';

// This integration test waits for a real service and document I/O, which fake timers cannot drive.
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Document did not become ready.'); await Bun.sleep(10); }
}

test('target edits undo and redo, while instance choices follow actual page membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-targets-test-'));
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
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `targets-${ulid()}` });
    await notebook.ready;
    const fields = await api.fields();
    const person = ulid(); const group = ulid(); const field = ulid();
    await notebook.commit([
      { op: 'create_page', id: person, title: 'Person' }, { op: 'create_page', id: group, title: 'Group' },
      { op: 'insert', id: field, parent_id: fields.page_id, after: null, text: 'Related', heading: null },
      { op: 'set_field_kind', id: field, base_revision: 1, kind: 'instance' },
    ]);
    const doc = notebook.open(fields.page_id);
    try {
      await eventually(() => doc.status() === 'ready');
      const definition = (await api.fields()).fields.find(value => value.id === field)!;
      expect(doc.edit({ kind: 'fieldTargets', definition, targets: [person, group] }).ok).toBe(true);
      await doc.flush();
      expect((await api.fieldDetail(field)).field.targets).toEqual([person, group]);
      doc.undo(); await doc.flush();
      expect((await api.fieldDetail(field)).field.targets).toEqual([]);
      doc.redo(); await doc.flush();
      expect((await api.fieldDetail(field)).field.targets).toEqual([person, group]);
      const human = await createInstance(notebook, 'New person', 'Person');
      const organization = await createInstance(notebook, 'New group', 'Group');
      await createInstance(notebook, 'A concept', 'Concept');
      expect((await instancePages(notebook, [person, group])).map(page => page.id).sort()).toEqual([human.id, organization.id].sort());
      expect((await instancePages(notebook, [person])).map(page => page.id)).toEqual([human.id]);
    } finally { doc.release(); }
  } finally {
    await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true });
  }
}, 20000);
