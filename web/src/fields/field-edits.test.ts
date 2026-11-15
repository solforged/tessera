import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { ulid } from 'ulid';
import { createNotebookClient } from '../document/index';
import type { Notebook } from '../document/index';
import { startService } from '../testing/service';
import { changeFieldKind, renameField, setFieldTargets } from './commands';

test('template rows rename, relink and change a young field in place, each with one undo', async () => {
  const service = await startService({ name: 'field-edits' });
  const { baseUrl, api } = service;
  let notebook: Notebook | undefined;
  try {
    notebook = createNotebookClient({
      baseUrl,
      notebookId: service.workshopId,
      sessionId: ulid(),
      databaseName: `field-edits-${ulid()}`,
    });
    await notebook.ready;
    const fields = await api.fields();
    const strength = ulid();
    const mood = ulid();
    const person = ulid();
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
    await expect(renameField(notebook, await definition(strength), 'MOOD')).rejects.toThrow(
      'A field named MOOD already exists.',
    );

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
    await service.stop();
  }
}, 60000);
