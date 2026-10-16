import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { createApi } from '../api/client';
import type { Operation } from '../api/types';
import { createNotebookClient } from '../document/index';
import type { Notebook } from '../document/index';
import { ensureField } from '../outline/source-fields';
import { changeFieldKind, choicePreview, createFieldEntry, createOptionValue, createTemplateField, makeFieldOption, fieldImpact, applyFieldImpact, optionImpact, deleteFieldOptions } from './commands';

// Real subprocess startup and document I/O require the platform clock, not fake timers.
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Document did not become ready.'); await Bun.sleep(10); }
}

test('field conversion, repair and option creation each have a single exact undo and redo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-fields-command-'));
  const root = resolve(import.meta.dir, '../../..');
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port!; listener.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--notebook', directory, 'serve', '--port', String(port), '--sync-port', '0'], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let notebook: Notebook | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (true) { try { await api.notebook(); break; } catch { if (Date.now() > deadline) throw new Error('Service did not start.'); await Bun.sleep(20); } }
    const info = await api.notebook();
    notebook = createNotebookClient({ baseUrl, notebookId: info.id, sessionId: ulid(), databaseName: `field-commands-${ulid()}` });
    await notebook.ready;
    const register = await api.fields();
    const field = ulid(); const blank = ulid();
    const notes = [ulid(), ulid(), ulid()];
    const values = [ulid(), ulid(), ulid()];
    const texts = ['  Dynastic cycle  ', 'DYNASTIC CYCLE', 'Method'];
    const operations: Operation[] = [{ op: 'insert', id: blank, parent_id: register.page_id, after: null, text: '', heading: null }, { op: 'insert', id: field, parent_id: register.page_id, after: blank, text: 'Strand', heading: null }];
    for (const [index, id] of notes.entries()) {
      const entry = ulid();
      operations.push({ op: 'create_page', id, title: `Note ${index}` }, { op: 'insert', id: entry, parent_id: id, after: null, text: `[[${field}]]`, heading: null }, { op: 'insert', id: values[index]!, parent_id: entry, after: null, text: texts[index]!, heading: null });
    }
    await notebook.commit(operations);
    const doc = notebook.open(notes[0]!); const definitions = notebook.open(register.page_id);
    try {
      await eventually(() => doc.status() === 'ready' && definitions.status() === 'ready');
      const preview = await api.fieldDetail(field, 'choice');
      expect(preview.choice_candidates.map(candidate => candidate.text)).toEqual(['Dynastic cycle', 'Method']);
      const mappings = Object.fromEntries(preview.interpretations.map(row => [row.text, { mode: 'option' as const, value: row.text.trim() }]));
      expect(choicePreview(preview, mappings).problems_total).toBe(0);
      expect(choicePreview(preview, mappings).readable).toHaveLength(3);
      expect(choicePreview(preview, {}).problems_total).toBe(3);
      const seq = notebook.changeSequence();
      doc.rememberChange(await changeFieldKind(notebook, preview, mappings));
      expect(notebook.changeSequence()).toBe(seq + 1);
      expect((await api.fieldDetail(field)).problems_total).toBe(0);
      expect((await api.block(values[0]!)).text).toBe((await api.block(values[1]!)).text);
      doc.undo(); await doc.flush();
      expect((await api.fieldDetail(field)).field.kind).toBe('text');
      expect((await api.fieldDetail(field)).field.options).toHaveLength(0);
      expect(await Promise.all(values.map(async id => (await api.block(id)).text))).toEqual(texts);
      doc.redo(); await doc.flush();
      expect((await api.fieldDetail(field)).problems_total).toBe(0);
      doc.undo(); await doc.flush();
      doc.rememberChange(await changeFieldKind(notebook, await api.fieldDetail(field, 'choice'), {}));
      const problem = await api.fieldDetail(field);
      expect(problem.problems_total).toBe(3);
      doc.rememberChange(await makeFieldOption(notebook, problem, texts[0]!));
      expect((await api.fieldDetail(field)).problems_total).toBe(1);
      doc.undo(); await doc.flush();
      expect((await api.fieldDetail(field)).problems_total).toBe(3);
      doc.redo(); await doc.flush();
      expect((await api.fieldDetail(field)).problems_total).toBe(1);

      let pendingValue!: string;
      const creating = createFieldEntry(notebook, doc, await api.fields(), notes[0]!, 'Pending text', 'text', id => { pendingValue = id; });
      const firstInput = notebook.queueCreatedValueText(pendingValue, notes[0]!, 'pending accepted valueX');
      const correctedInput = notebook.queueCreatedValueText(pendingValue, notes[0]!, 'pending accepted value');
      await Promise.all([creating, firstInput, correctedInput]);
      expect((await api.block(pendingValue)).text).toBe('pending accepted value');
      expect((await api.block(pendingValue)).revision).toBe(2);

      const fresh = await createFieldEntry(notebook, doc, await api.fields(), notes[0]!, 'Phase', 'choice');
      expect(fresh.field.id).not.toBe(blank);
      expect((await api.block(blank)).text).toBe('');
      expect(fresh.field.kind).toBe('choice');
      await fresh.change.undo();
      expect((await api.fields()).fields.some(field => field.id === fresh.field.id)).toBe(false);
      await fresh.change.redo();
      expect((await api.fields()).fields.find(field => field.id === fresh.field.id)?.kind).toBe('choice');
      await createOptionValue(notebook, doc, { field: fresh.field, ownerId: notes[0]!, valueId: fresh.value }, 'First option');
      const chosen = await api.fieldDetail(fresh.field.id);
      expect(chosen.problems_total).toBe(0);
      expect(chosen.field.options.map(option => option.text)).toEqual(['First option']);
      expect((await api.block(fresh.value)).text).toBe(`[[${chosen.field.options[0]!.id}]]`);
      doc.undo(); await doc.flush();
      expect((await api.fieldDetail(fresh.field.id)).field.options).toHaveLength(0);
      expect((await api.block(fresh.value)).text).toBe('');
      doc.redo(); await doc.flush();
      expect((await api.fieldDetail(fresh.field.id)).problems_total).toBe(0);
      const optionId = (await api.fieldDetail(fresh.field.id)).field.options[0]!.id;
      const childNote = ulid();
      await notebook.commit([{ op: 'insert', id: childNote, parent_id: fresh.value, after: null, text: 'Keep the classification notes.', heading: null }]);
      const optionDeletion = await optionImpact(notebook, [await api.block(optionId)], (await api.fields()).fields);
      expect(optionDeletion.values.map(value => value.owner)).toEqual([notes[0]!]);
      const deletedOption = await deleteFieldOptions(notebook, optionDeletion);
      expect((await api.block(fresh.value)).text).toBe('First option');
      expect((await api.fieldDetail(fresh.field.id)).problems_total).toBe(1);
      expect((await api.block(childNote)).parent_id).toBe(fresh.value);
      await deletedOption.undo();
      expect((await api.block(fresh.value)).text).toBe(`[[${optionId}]]`);
      expect((await api.fieldDetail(fresh.field.id)).problems_total).toBe(0);
      await deletedOption.redo();
      expect((await api.block(fresh.value)).text).toBe('First option');
      await deletedOption.undo();
      const detachedChoice = await applyFieldImpact(notebook, await fieldImpact(notebook, fresh.field.id), 'detach');
      expect((await api.block(fresh.value)).text).toBe('Phase: First option');
      expect((await api.block(fresh.value)).parent_id).toBe(notes[0]!);
      expect((await api.block(childNote)).parent_id).toBe(fresh.value);
      await detachedChoice.undo();
      expect((await api.block(fresh.value)).text).toBe(`[[${optionId}]]`);
      expect((await api.fieldDetail(fresh.field.id)).problems_total).toBe(0);
      const shorthand = await ensureField(notebook, 'New shorthand field');
      expect(shorthand.id).not.toBe(blank);
      expect((await api.block(blank)).text).toBe('');
      expect((await api.fields()).fields.every(field => field.name.trim())).toBe(true);
      const templateType = ulid();
      await notebook.commit([{ op: 'create_page', id: templateType, title: 'Template proof type' }]);
      const templated = await createTemplateField(notebook, await api.type(templateType), 'Template proof', 'choice');
      const [templateField] = (await api.type(templateType)).fields;
      expect((await api.fields()).fields.find(field => field.id === templateField)).toMatchObject({ name: 'Template proof', kind: 'choice' });
      await templated.undo();
      expect((await api.type(templateType)).fields).toEqual([]);
      expect((await api.fields()).fields.some(field => field.id === templateField)).toBe(false);
      await expect(createTemplateField(notebook, await api.type(templateType), 'phase', 'text')).rejects.toThrow('already exists');
      const survivor = (await createFieldEntry(notebook, doc, await api.fields(), notes[0]!, 'Survivor', 'text')).field;
      await notebook.commit([{ op: 'edit_text', id: values[0]!, base_revision: (await api.block(values[0]!)).revision, text: 'First meaning' }]);
      const typeId = ulid(); const viewId = ulid(); const secondViewId = ulid();
      await notebook.commit([
        { op: 'create_page', id: typeId, title: 'Schema proof type' },
        { op: 'set_type_fields', type_id: typeId, base_revision: 1, fields: [field] },
        { op: 'save_view', id: viewId, base_revision: null, name: 'Field recipe', query: {
          source: 'notes', type: null, text: null, filters: [{ field, op: 'present', value: null }],
          sort: [{ by: 'field', field, direction: 'asc' }], limit: 50,
          columns: [{ key: '@title', width: 240 }, { key: field, width: 317 }],
          group: { key: field, collapsed: ['First meaning', field] }, card: [field],
          note_view: { layout: 'table', grouping: `field:${field}` }, purpose: 'Keep this recipe.',
        } },
        { op: 'save_view', id: secondViewId, base_revision: null, name: 'Another field view', query: {
          source: 'notes', type: null, text: null, filters: [{ field, op: 'set', value: null }], sort: [], limit: null,
        } },
      ]);
      const beforeView = await api.view(viewId); const beforeSecondView = await api.view(secondViewId);
      const beforeMerge = await api.page(notes[0]!);
      const previewMerge = await fieldImpact(notebook, field, survivor.id);
      expect(previewMerge.conflicts).toHaveLength(1);
      expect(previewMerge.views.map(view => view.name).sort()).toEqual(['Another field view', 'Field recipe']);
      const merged = await applyFieldImpact(notebook, previewMerge, 'merge');
      expect((await api.fieldDetail(survivor.id)).entries).toHaveLength(4);
      expect((await api.block(values[0]!)).text).toBe('First meaning');
      const mergedView = await api.view(viewId);
      expect(mergedView.query).toEqual({
        ...beforeView.query,
        filters: [{ field: survivor.id, op: 'present', value: null }],
        sort: [{ by: 'field', field: survivor.id, direction: 'asc' }],
        columns: [{ key: '@title', width: 240 }, { key: survivor.id, width: 317 }],
        group: { key: survivor.id, collapsed: ['First meaning', survivor.id] }, card: [survivor.id],
        note_view: { layout: 'table', grouping: `field:${survivor.id}` },
      });
      expect((await api.view(secondViewId)).query.filters[0]!.field).toBe(survivor.id);
      expect((await api.query(mergedView.query)).total).toBe(3);
      await merged.undo();
      expect((await api.fieldDetail(field)).entries).toHaveLength(3);
      expect((await api.page(notes[0]!)).rows.map(row => [row.block.id, row.block.text, row.block.parent_id])).toEqual(beforeMerge.rows.map(row => [row.block.id, row.block.text, row.block.parent_id]));
      expect((await api.view(viewId)).query).toEqual(beforeView.query);
      expect((await api.view(secondViewId)).query).toEqual(beforeSecondView.query);
      const archived = await applyFieldImpact(notebook, await fieldImpact(notebook, field), 'archive');
      expect((await api.fieldDetail(field)).field.archived).toBe(true);
      expect((await api.fieldDetail(field)).values_total).toBe(3);
      expect((await api.query((await api.view(viewId)).query)).total).toBe(3);
      await archived.undo();
      const detached = await applyFieldImpact(notebook, await fieldImpact(notebook, field), 'detach');
      expect((await api.block(values[0]!)).text).toBe('Strand: First meaning');
      expect((await api.block(values[0]!)).parent_id).toBe(notes[0]!);
      await detached.undo();
      expect((await api.block(values[0]!)).text).toBe('First meaning');
      expect((await api.fieldDetail(field)).entries).toHaveLength(3);
      await applyFieldImpact(notebook, await fieldImpact(notebook, field), 'archive');
      for (const action of ['detach', 'delete'] as const) {
        const before = await api.page(notes[0]!);
        const impact = await fieldImpact(notebook, field);
        expect(impact.templates.map(template => template.page.id)).toEqual([typeId]);
        expect(impact.views).toHaveLength(2);
        const removed = await applyFieldImpact(notebook, impact, action);
        expect((await api.view(viewId)).query.field_names).toEqual({ [field]: 'Strand' });
        await expect(api.query((await api.view(viewId)).query)).rejects.toThrow('Field “Strand” is missing');
        await removed.undo();
        expect((await api.fieldDetail(field)).field.archived).toBe(true);
        expect((await api.type(typeId)).fields).toEqual([field]);
        expect((await api.view(viewId)).query).toEqual(beforeView.query);
        expect((await api.page(notes[0]!)).rows.map(row => [row.block.id, row.block.text, row.block.parent_id])).toEqual(before.rows.map(row => [row.block.id, row.block.text, row.block.parent_id]));
        expect((await api.query((await api.view(viewId)).query)).total).toBe(3);
      }
    } finally { doc.release(); definitions.release(); }
  } finally { await notebook?.dispose(); process.kill(); await process.exited; await rm(directory, { recursive: true, force: true }); }
}, 30000);
