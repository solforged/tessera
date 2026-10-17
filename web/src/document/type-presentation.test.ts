import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApi } from '../api/client';
import { createNotebookClient, type Notebook } from './index';
import { autoPlural } from '../fields/presentation';
import { noteKindIcon } from '../notes/kinds';

test('automatic plurals and unknown glyph fallback', () => {
  for (const [title, plural] of [['Book', 'Books'], ['BOOK', 'BOOKS'], ['Story', 'Stories'], ['Boy', 'Boys'], ['Class', 'Classes'], ['Bus', 'Buses'], ['Box', 'Boxes'], ['Quartz', 'Quartzes'], ['Church', 'Churches'], ['Wish', 'Wishes'], ['Thesis', 'Theses'], ['THESIS', 'THESES'], ['Books', 'Books'], ['Stories', 'Stories'], ['本', '本'], ['Книга', 'Книга'], ['Café', 'Cafés'], ['CAFÉ', 'CAFÉS'], ['', '']]) {
    expect(autoPlural(title!)).toBe(plural!);
  }
  expect(noteKindIcon({ key: 'type:test', icon: 'book' })).toBe('book');
  expect(noteKindIcon({ key: 'person', icon: 'future-glyph' })).toBe('tag');
  expect(noteKindIcon({ key: 'type:test', icon: 'constructor' })).toBe('tag');
});

test('type presentation persists through document undo, redo and reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-presentation-test-'));
  const root = resolve(import.meta.dir, '../../..');
  const port = Bun.env.TESSERA_PRESENTATION_TEST_PORT ?? '4462';
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const process = Bun.spawn([Bun.env.TESSERA_TEST_BINARY ?? join(root, 'target/debug/tessera'), '--workshop', directory, 'serve', '--port', port], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let client: Notebook | undefined;
  try {
    const expectedPath = await realpath(directory);
    // Real service startup and streamed document hydration are integration boundaries, not timer behavior.
    const deadline = Date.now() + 5000;
    let notebookId: string;
    while (true) {
      try {
        const info = await api.notebook();
        if (await realpath(info.path) !== expectedPath) throw new Error('Test port belongs to another notebook');
        notebookId = info.id; break;
      } catch (reason) { if (Date.now() > deadline) throw reason; await Bun.sleep(20); }
    }
    client = createNotebookClient({ baseUrl, sessionId: 'presentation-test', notebookId, databaseName: 'tessera-presentation-test' });
    await client.ready;
    const id = await client.createPage('Book');
    const member = await client.createPage('A book');
    const doc = client.open(id);
    const memberDoc = client.open(member);
    while (doc.status() === 'loading' || memberDoc.status() === 'loading') {
      if (Date.now() > deadline) throw new Error('Documents did not load');
      await Bun.sleep(10);
    }
    expect(doc.status()).toBe('ready');
    expect(memberDoc.addType(member, 'Book').ok).toBe(true);
    await client.flush();
    expect((await api.noteKinds(member))[0]?.plural).toBe('Books');
    const current = await api.type(id);
    const edit = { kind: 'typePresentation' as const, id, revision: current.page.revision, previous: { plural: current.plural, icon: current.icon }, value: { plural: 'Volumes', icon: 'shelf' } };
    expect(doc.edit(edit).ok).toBe(true);
    await client.flush();
    expect(await api.type(id)).toMatchObject({ plural: 'Volumes', icon: 'shelf' });
    expect((await api.noteKinds(member))[0]).toMatchObject({ plural: 'Volumes', icon: 'shelf' });
    doc.undo(); await client.flush();
    expect(await api.type(id)).toMatchObject({ plural: null, icon: null });
    expect((await api.noteKinds(member))[0]).toMatchObject({ plural: 'Books', icon: 'book' });
    doc.redo(); await client.flush();
    expect(await api.type(id)).toMatchObject({ plural: 'Volumes', icon: 'shelf' });
    expect(doc.edit(edit).ok).toBe(false);
    const updated = await api.type(id);
    expect(doc.edit({ ...edit, revision: updated.page.revision, previous: edit.value, value: { plural: null, icon: null } }).ok).toBe(true);
    await client.flush();
    expect((await api.noteKinds(member))[0]).toMatchObject({ plural: 'Books', icon: 'book' });
    doc.undo(); await client.flush();
    expect(await api.type(id)).toMatchObject({ plural: 'Volumes', icon: 'shelf' });
    memberDoc.release(); doc.release();
  } finally {
    await client?.dispose(); process.kill(); await process.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
