import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { ensureField } from '../outline/source-fields';
import type { PageDocument } from './contract';
import { createTaskQuery } from '../tasks/query';
import { newTask } from '../tasks/quick-date';
import { taskProject } from '../projects/task-project';

// Bun loads Solid's server build, so effects cannot signal real document I/O readiness here.
async function ready(doc: PageDocument) {
  const deadline = Date.now() + 5000;
  while (doc.status() === 'loading') {
    if (Date.now() > deadline) throw new Error('Document did not load.');
    await Bun.sleep(10);
  }
  expect(doc.status()).toBe('ready');
}

test('project assignment creates an instance field and adds, replaces, removes, undoes and redoes one field entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-task-project-test-'));
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
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `projects-${ulid()}` });
    await notebook.ready;
    const first = ulid(), second = ulid(), journal = ulid(), task = ulid();
    await notebook.commit([
      { op: 'create_page', id: first, title: 'Tessera Android' }, { op: 'create_page', id: second, title: 'Sync' },
      { op: 'set_project', id: first, base_revision: 1, project: { outcome: '', deadline: null, status: 'active' } },
      { op: 'set_project', id: second, base_revision: 1, project: { outcome: '', deadline: null, status: 'active' } },
      { op: 'create_journal', id: journal, date: '2026-10-12' },
      { op: 'insert', id: task, parent_id: journal, after: null, text: 'Check Fold reader TOC', heading: null },
      { op: 'set_task', id: task, base_revision: 1, task: newTask() },
    ]);
    const fieldsDoc = notebook.open((await api.fields()).page_id);
    await ready(fieldsDoc);
    const field = await ensureField(notebook, 'Project', 'instance');
    expect(field.kind).toBe('instance');
    expect((await api.fields()).fields.filter(value => value.name === 'Project')).toHaveLength(1);
    expect((await ensureField(notebook, 'Project', 'instance')).id).toBe(field.id);
    fieldsDoc.release();
    const doc = notebook.open(journal);
    try {
      await ready(doc);
      const query = createTaskQuery('2026-10-12'); query.filter.project_id = first;
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: first }).ok).toBe(true);
      await doc.flush();
      const entry = doc.outline.children(task)[0]!;
      const value = doc.outline.children(entry)[0]!;
      expect(doc.block(value)?.text).toBe(`[[${first}]]`);
      expect((await api.taskQuery(query)).rows.map(row => row.source.block.id)).toEqual([task]);
      expect(taskProject(doc, task, new Set([field.id]), new Set([first, second]))).toBe(first);
      doc.undo(); await doc.flush();
      expect(doc.outline.children(task)).toHaveLength(0);
      expect((await api.taskQuery(query)).total).toBe(0);
      doc.redo(); await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: second }).ok).toBe(true);
      await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect(doc.outline.children(entry)).toEqual([value]);
      expect(doc.block(value)?.text).toBe(`[[${second}]]`);
      doc.undo(); await doc.flush();
      expect(doc.block(value)?.text).toBe(`[[${first}]]`);
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: null }).ok).toBe(true);
      await doc.flush();
      expect(doc.outline.children(task)).toHaveLength(0);
      doc.undo(); await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect((await api.taskQuery(query)).total).toBe(1);
    } finally { doc.release(); }
  } finally {
    await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true });
  }
}, 30000);
