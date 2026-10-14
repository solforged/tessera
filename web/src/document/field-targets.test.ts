import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import { createNotebookClient } from './index';
import type { Notebook } from './index';
import { createInstance, instancePages, relationCandidates, relationMembers } from '../fields/instances';
import { changeFieldKind } from '../fields/commands';
import { SOURCE_TARGET, sourceOperation } from '../fields/targets';

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

      // Block members are offered by label, the owner's page first and the owner left out, with no page creation.
      const proposition = ulid(); const book = ulid(); const other = ulid(); const a = ulid(); const b = ulid(); const c = ulid();
      await notebook.commit([
        { op: 'create_page', id: proposition, title: 'Proposition' }, { op: 'create_page', id: book, title: 'Structure' }, { op: 'create_page', id: other, title: 'Elsewhere' },
        { op: 'insert', id: a, parent_id: book, after: null, text: 'Normal science is puzzle-solving #proposition', heading: null },
        { op: 'insert', id: b, parent_id: book, after: a, text: 'Anomalies accumulate #proposition', heading: null },
        { op: 'insert', id: c, parent_id: other, after: null, text: 'A claim from elsewhere #proposition', heading: null },
      ]);
      const members = await relationMembers(notebook, [proposition]);
      expect(members.pages).toEqual([]);
      const offered = await relationCandidates(notebook, members, true, '', { id: a, page: book });
      expect(offered.rows.map(row => [row.label, row.here])).toEqual([['Anomalies accumulate', true], ['A claim from elsewhere', false]]);
      expect(offered.canCreate).toBe(false);
      expect((await relationCandidates(notebook, members, true, 'elsewhere', { id: a, page: book })).rows.map(row => row.block.id)).toEqual([c]);

      // A page created by the interpretation map joins the field's only target type.
      const mentor = ulid(); const entry = ulid(); const value = ulid();
      await notebook.commit([
        { op: 'insert', id: mentor, parent_id: fields.page_id, after: field, text: 'Mentor', heading: null },
        { op: 'set_field_kind', id: mentor, base_revision: 1, kind: 'instance' },
        { op: 'set_field_targets', id: mentor, base_revision: 2, targets: [person] },
        { op: 'insert', id: entry, parent_id: other, after: c, text: `[[${mentor}]]`, heading: null },
        { op: 'insert', id: value, parent_id: entry, after: null, text: 'Ada', heading: null },
      ]);
      const mapped = await changeFieldKind(notebook, await api.fieldDetail(mentor, 'instance'), { Ada: { mode: 'create', value: 'Ada' } });
      expect((await api.fieldDetail(mentor)).problems_total).toBe(0);
      await mapped.undo();
      expect((await api.fieldDetail(mentor)).problems_total).toBe(1);
      await mapped.redo();
      expect((await api.fieldDetail(mentor)).problems_total).toBe(0);
    } finally { doc.release(); }
  } finally {
    await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test('work becomes a relation to Sources, and its review makes created pages sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-source-targets-test-'));
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
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `source-targets-${ulid()}` });
    await notebook.ready;
    const fields = await api.fields();
    const book = ulid(); const plain = ulid(); const work = ulid(); const owner = ulid();
    const [linked, linkedValue, written, writtenValue] = [ulid(), ulid(), ulid(), ulid()];
    await notebook.commit([
      { op: 'create_page', id: book, title: 'The Structure of Scientific Revolutions' }, sourceOperation(book, 1),
      { op: 'create_page', id: plain, title: 'Kuhn' }, { op: 'create_page', id: owner, title: 'Paradigms' },
      { op: 'insert', id: work, parent_id: fields.page_id, after: null, text: 'work', heading: null },
      { op: 'insert', id: linked, parent_id: owner, after: null, text: `[[${work}]]`, heading: null },
      { op: 'insert', id: linkedValue, parent_id: linked, after: null, text: `[[${book}||p. 12]]`, heading: null },
      { op: 'insert', id: written, parent_id: owner, after: linked, text: `[[${work}]]`, heading: null },
      { op: 'insert', id: writtenValue, parent_id: written, after: null, text: 'Kuhn 1962', heading: null },
    ]);
    expect((await relationMembers(notebook, [SOURCE_TARGET])).pages.map(page => page.id)).toEqual([book]);

    // The preview reads values against Sources: the linked source maps across, the plain text needs one.
    const preview = await api.fieldDetail(work, 'instance');
    expect(preview.field.targets).toEqual([SOURCE_TARGET]);
    expect(preview.problems_total).toBe(1);
    const change = await changeFieldKind(notebook, preview, { 'Kuhn 1962': { mode: 'create', value: 'Kuhn 1962' } });
    const after = await api.fieldDetail(work);
    expect([after.field.kind, after.field.targets, after.problems_total]).toEqual(['instance', [SOURCE_TARGET], 0]);
    await change.undo();
    expect((await api.fieldDetail(work)).field.kind).toBe('text');
    await change.redo();
    expect((await api.fieldDetail(work)).problems_total).toBe(0);
    expect((await relationMembers(notebook, [SOURCE_TARGET])).pages.map(page => page.text).sort()).toEqual(['Kuhn 1962', 'The Structure of Scientific Revolutions']);

    // The picker's Create source makes one too.
    const created = await createInstance(notebook, 'Against Method', undefined, true);
    expect((await relationMembers(notebook, [SOURCE_TARGET])).pages.map(page => page.id)).toContain(created.id);
  } finally {
    await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true });
  }
}, 20000);
