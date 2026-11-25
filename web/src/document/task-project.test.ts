import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { ulid } from 'ulid';
import { createWorkshopClient } from '../workflows/workshop';
import type { Workshop } from '../workflows/workshop';
import { startService } from '../testing/service';
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
  const service = await startService({ name: 'task-project-test' });
  const { baseUrl, api } = service;
  let workshop: Workshop | undefined;
  try {
    workshop = createWorkshopClient({
      baseUrl,
      workshopId: service.workshopId,
      sessionId: ulid(),
      databaseName: `projects-${ulid()}`,
    });
    await workshop.ready;
    const first = ulid(),
      second = ulid(),
      journal = ulid(),
      task = ulid();
    await workshop.commit([
      { op: 'create_page', id: first, title: 'Tessera Android' },
      { op: 'create_page', id: second, title: 'Sync' },
      { op: 'set_project', id: first, base_revision: 1, project: { outcome: '', deadline: null, status: 'active' } },
      { op: 'set_project', id: second, base_revision: 1, project: { outcome: '', deadline: null, status: 'active' } },
      { op: 'create_journal', id: journal, date: '2026-10-12' },
      { op: 'insert', id: task, parent_id: journal, after: null, text: 'Check Fold reader TOC', heading: null },
      { op: 'set_task', id: task, base_revision: 1, task: newTask('todo') },
    ]);
    const fieldsDoc = workshop.open((await api.fields()).page_id);
    await ready(fieldsDoc);
    const field = await ensureField(workshop, 'Project', 'instance');
    expect(field.kind).toBe('instance');
    expect((await api.fields()).fields.filter(value => value.name.toLowerCase() === 'project')).toHaveLength(1);
    expect((await ensureField(workshop, 'Project', 'instance')).id).toBe(field.id);
    fieldsDoc.release();
    const doc = workshop.open(journal);
    try {
      await ready(doc);
      const query = createTaskQuery('2026-10-12');
      query.filter.project_id = first;
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: first }).ok).toBe(true);
      await doc.flush();
      const entry = doc.outline.children(task)[0]!;
      const value = doc.outline.children(entry)[0]!;
      expect(doc.block(value)?.text).toBe(`[[${first}]]`);
      expect((await api.taskQuery(query)).rows.map(row => row.source.block.id)).toEqual([task]);
      expect(taskProject(doc, task, new Set([field.id]), new Set([first, second]))).toBe(first);
      doc.undo();
      await doc.flush();
      expect(doc.outline.children(task)).toHaveLength(0);
      expect((await api.taskQuery(query)).total).toBe(0);
      doc.redo();
      await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: second }).ok).toBe(true);
      await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect(doc.outline.children(entry)).toEqual([value]);
      expect(doc.block(value)?.text).toBe(`[[${second}]]`);
      doc.undo();
      await doc.flush();
      expect(doc.block(value)?.text).toBe(`[[${first}]]`);
      expect(doc.edit({ kind: 'taskProject', id: task, fieldId: field.id, projectId: null }).ok).toBe(true);
      await doc.flush();
      expect(doc.outline.children(task)).toHaveLength(0);
      doc.undo();
      await doc.flush();
      expect(doc.outline.children(task)).toEqual([entry]);
      expect((await api.taskQuery(query)).total).toBe(1);
    } finally {
      doc.release();
    }
  } finally {
    await workshop?.dispose();
    await service.stop();
  }
}, 60000);
