import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { ulid } from 'ulid';
import type { Operation } from '../api/types';
import { createWorkshopClient, type Workshop } from '../document';
import { startService } from '../testing/service';
import { blankDraftFields, createPageDraft } from '../create/draft';
import { convertSyntax, syntaxAtom } from './recipe-conversion';

test('syntax conversion and creation use real atomic changes with exact undo and redo', async () => {
  const service = await startService({ name: 'recipe-test' });
  const { baseUrl, api, workshopId } = service;
  let client: Workshop | undefined;
  try {
    client = createWorkshopClient({ baseUrl, sessionId: 'recipe-test', workshopId, databaseName: `recipe-${ulid()}` });
    await client.ready;
    const tag = await client.createPage('Italian word'),
      page = await client.createPage('Kitchen words');
    const ids = [ulid(), ulid(), ulid()];
    const texts = ['il lavello <> the sink', 'misurare >> to measure', 'rubinetto << tap #[[Italian word]]'];
    const seed: Operation[] = ids.flatMap((id, index) => [
      { op: 'insert', id, parent_id: page, after: null, text: texts[index]!, heading: null },
      ...(index === 2 ? [] : [{ op: 'add_type' as const, id, base_revision: 1, title: 'Italian word' }]),
    ]);
    await client.commit(seed);
    const originals = (await Promise.all(ids.map(id => api.sourceCards(id)))).flat();
    const originalText = await Promise.all(ids.map(async id => (await api.block(id)).text));
    const members = await api.members(tag);
    const parsed = members.map(source => syntaxAtom(source)!);
    expect(parsed.every(Boolean)).toBe(true);
    expect(parsed.find(atom => atom.source.block.id === ids[2])!.text).toContain('#[[');
    expect(parsed.find(atom => atom.source.block.id === ids[2])!.back).toBe('tap');
    const doc = client.open(tag);
    // Streamed document hydration uses real process signals, not mocked time.
    const deadline = Date.now() + 10000;
    while (doc.status() === 'loading') {
      if (Date.now() > deadline) throw new Error('Tag did not load');
      await Bun.sleep(10);
    }
    const pending = convertSyntax(client, await api.type(tag), parsed, [], { name: 'Meaning' });
    const remembered = doc.rememberChange(pending);
    await pending;
    await remembered;
    const converted = (await Promise.all(ids.map(id => api.sourceCards(id)))).flat();
    expect(converted).toHaveLength(6);
    for (const old of originals) {
      const card = converted.find(card => card.id === old.id)!;
      expect(card.key.startsWith('tpl:')).toBe(true);
      expect(card.schedule).toEqual(old.schedule);
      expect(card.held).toBe(old.held);
    }
    expect(converted.filter(card => !originals.some(old => old.id === card.id)).every(card => card.held)).toBe(true);
    expect(await api.members(tag)).toHaveLength(3);
    doc.undo();
    await client.flush().catch(error => {
      throw new Error('Conversion undo failed', { cause: error });
    });
    expect(await Promise.all(ids.map(async id => (await api.block(id)).text))).toEqual(originalText);
    expect(await api.cardTemplates(tag)).toHaveLength(0);
    expect((await api.fields()).fields.some(field => field.name === 'Meaning')).toBe(false);
    expect(
      (await Promise.all(ids.map(id => api.sourceCards(id))))
        .flat()
        .map(card => [card.id, card.key, card.held, card.schedule]),
    ).toEqual(originals.map(card => [card.id, card.key, card.held, card.schedule]));
    doc.redo();
    await client.flush().catch(error => {
      throw new Error('Conversion redo failed', { cause: error });
    });
    expect(
      (await Promise.all(ids.map(id => api.sourceCards(id)))).flat().map(card => [card.id, card.key, card.held]),
    ).toEqual(converted.map(card => [card.id, card.key, card.held]));
    const field = (await api.fields()).fields.find(field => field.name === 'Meaning')!;
    const kind = (await api.noteIndex()).kinds.find(kind => kind.type_id === tag)!;
    const fields = blankDraftFields();
    fields.values[field.id] = { text: 'the pantry' };
    const created = await createPageDraft(client, {
      kind: `type:${tag}`,
      noteKind: kind,
      text: 'la dispensa',
      fields,
    }).catch(error => {
      throw new Error('Recipe atom creation failed', { cause: error });
    });
    expect((await api.block(created.pageId)).kind).toBe('journal');
    expect((await api.sourceCards(created.caretId!)).map(card => [card.front, card.back]).sort()).toEqual(
      [
        ['la dispensa', 'the pantry'],
        ['the pantry', 'la dispensa'],
      ].sort(),
    );
    expect((await api.subtree(created.caretId!)).rows.some(row => row.block.text === 'the pantry')).toBe(true);
    doc.release();
  } finally {
    await client?.dispose();
    await service.stop();
  }
}, 60000);
