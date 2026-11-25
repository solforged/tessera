import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { ulid } from 'ulid';
import { createWorkshopClient } from '../workflows/workshop';
import type { Workshop } from '../workflows/workshop';
import type { PageDocument } from '../document/contract';
import { startService } from '../testing/service';
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
  const service = await startService({ name: 'ensure-field-test' });
  const { baseUrl, api } = service;
  let workshop: Workshop | undefined;
  try {
    workshop = createWorkshopClient({
      baseUrl,
      workshopId: service.workshopId,
      sessionId: ulid(),
      databaseName: `ensure-field-${ulid()}`,
    });
    await workshop.ready;
    const person = ulid(),
      group = ulid();
    await workshop.commit([
      { op: 'create_page', id: person, title: 'Person' },
      { op: 'create_page', id: group, title: 'Group' },
    ]);
    const fieldsDoc = workshop.open((await api.fields()).page_id);
    try {
      await ready(fieldsDoc);
      // What typing `Gloss:: …` asks for: the typed name, a text kind and the default role.
      const gloss = await ensureField(workshop, 'Gloss', 'text', 'attribute');
      expect(gloss).toMatchObject({ name: 'gloss', kind: 'text', role: 'standfirst', built_in: true });
      // The open Fields register reads the lowercase name the receipt carried.
      expect(fieldsDoc.block(gloss.id)?.text).toBe('gloss');

      // A built-in field's kind is the core's, so it never waits for a first value to guess one.
      const author = await ensureField(workshop, 'Author', 'text', 'attribute', true);
      expect(author).toMatchObject({
        name: 'author',
        kind: 'instance',
        targets: [person, group],
        counts_as: 'creator',
        built_in: true,
      });
      expect(isFreshField(workshop, author.id)).toBe(false);
      expect((await ensureField(workshop, 'Published', 'number')).kind).toBe('date');
      const form = await ensureField(workshop, 'Form');
      expect(form.kind).toBe('choice');
      expect(form.options.map(option => option.text)).toEqual([
        'book',
        'chapter',
        'article',
        'paper',
        'report',
        'post',
        'thread',
        'video',
        'web page',
      ]);

      // A name of the workshop's own keeps what was asked for.
      const mood = await ensureField(workshop, 'Mood', 'number', 'attribute', true);
      expect(mood).toMatchObject({ name: 'Mood', kind: 'number' });
      expect(mood.built_in).toBeFalsy();
      expect(isFreshField(workshop, mood.id)).toBe(true);
      expect((await ensureField(workshop, 'mood')).id).toBe(mood.id);
    } finally {
      fieldsDoc.release();
    }
  } finally {
    await workshop?.dispose();
    await service.stop();
  }
}, 60000);
