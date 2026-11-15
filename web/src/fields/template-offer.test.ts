import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { ulid } from 'ulid';
import { createWorkshopClient } from '../document/index';
import type { Workshop } from '../document/index';
import { startService } from '../testing/service';
import { addTemplateField } from './commands';
import { templateOffer } from './template-offer';

test('a field is offered to a tag on its second use, once, and adding it undoes and redoes', async () => {
  const service = await startService({ name: 'template-offer' });
  const { baseUrl, api } = service;
  const workshops: Workshop[] = [];
  const client = async () => {
    const info = await api.workshop();
    const workshop = createWorkshopClient({
      baseUrl,
      workshopId: info.id,
      sessionId: ulid(),
      databaseName: `template-offer-${ulid()}`,
    });
    workshops.push(workshop);
    await workshop.ready;
    return workshop;
  };
  try {
    const workshop = await client();
    const fields = await api.fields();
    const proposition = ulid();
    const book = ulid();
    const strength = ulid();
    const [a, b, entryA, entryB, valueA, valueB] = [ulid(), ulid(), ulid(), ulid(), ulid(), ulid()];
    const owner = (id: string, text: string) => ({ id, text, manual_types: [] });
    await workshop.commit([
      { op: 'create_page', id: proposition, title: 'Proposition' },
      { op: 'create_page', id: book, title: 'Structure' },
      { op: 'insert', id: strength, parent_id: fields.page_id, after: null, text: 'strength', heading: null },
      {
        op: 'insert',
        id: a,
        parent_id: book,
        after: null,
        text: 'Normal science is puzzle-solving #proposition',
        heading: null,
      },
      { op: 'insert', id: b, parent_id: book, after: a, text: 'Anomalies accumulate #proposition', heading: null },
      { op: 'insert', id: entryA, parent_id: a, after: null, text: `[[${strength}]]`, heading: null },
      { op: 'insert', id: valueA, parent_id: entryA, after: null, text: 'high', heading: null },
    ]);
    // One use may be a one-off.
    expect(
      await templateOffer(workshop, owner(a, 'Normal science is puzzle-solving #proposition'), strength),
    ).toBeNull();
    await workshop.commit([
      { op: 'insert', id: entryB, parent_id: b, after: null, text: `[[${strength}]]`, heading: null },
      { op: 'insert', id: valueB, parent_id: entryB, after: null, text: 'low', heading: null },
    ]);
    const offer = await templateOffer(workshop, owner(b, 'Anomalies accumulate #proposition'), strength);
    expect(offer?.type.page.id).toBe(proposition);
    // Asked once per window, whatever the answer.
    expect(
      await templateOffer(workshop, owner(a, 'Normal science is puzzle-solving #proposition'), strength),
    ).toBeNull();

    const change = await addTemplateField(workshop, offer!.type, strength);
    expect((await api.type(proposition)).fields).toEqual([strength]);
    await change.undo();
    expect((await api.type(proposition)).fields).toEqual([]);
    await change.redo();
    expect((await api.type(proposition)).fields).toEqual([strength]);
    // A field already in the template is never offered, even in a new window.
    expect(await templateOffer(await client(), owner(b, 'Anomalies accumulate #proposition'), strength)).toBeNull();
  } finally {
    for (const workshop of workshops) await workshop.dispose();
    await service.stop();
  }
}, 60000);
