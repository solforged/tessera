import { describe, expect, test } from 'bun:test';
import type { Block, PageView } from '../api/types';
import { captureOperations } from '../capture/append';
import type { NotebookClient } from '../document/contract';
import { captureSection, defaultTodayTemplate, findSectionHeading, parseTodayTemplate, readingRowSource, readingRowText, sectionInsertAfter, sectionTarget, writtenSections } from './today-template';

const row = (id: string, text: string, heading: 1 | 2 | 3 | null = null) => ({ id, text, heading });
const target = sectionTarget(defaultTodayTemplate, 'inbox')!;

describe('today template', () => {
  test('falls back to the default for unset or unreadable values', () => {
    expect(parseTodayTemplate(undefined)).toBe(defaultTodayTemplate);
    expect(parseTodayTemplate('not json')).toBe(defaultTodayTemplate);
    expect(writtenSections(defaultTodayTemplate).map(section => section.name)).toEqual(['Inbox', 'Reading']);
    expect(captureSection(defaultTodayTemplate).name).toBe('Inbox');
  });

  test('a section target orders the written sections around Notes', () => {
    expect(target).toEqual({ name: 'Inbox', order: ['Inbox', 'Reading', ''] });
    expect(sectionTarget(defaultTodayTemplate, 'plan')).toBeUndefined();
  });

  test('matches a heading by folded name, never a plain row', () => {
    const roots = [row('a', 'inbox'), row('b', 'Inbox', 2)];
    expect(findSectionHeading(roots, 'Inbox')?.id).toBe('b');
  });

  test('places a missing heading before later sections and before loose Notes rows', () => {
    expect(sectionInsertAfter([], target)).toBeNull();
    expect(sectionInsertAfter([row('n', 'A thought')], target)).toBeNull();
    expect(sectionInsertAfter([row('r', 'Reading', 2), row('n', 'A thought')], target)).toBeNull();
    const reading = sectionTarget(defaultTodayTemplate, 'reading')!;
    expect(sectionInsertAfter([row('i', 'Inbox', 2), row('n', 'A thought')], reading)).toBe('i');
    expect(sectionInsertAfter([row('i', 'Inbox', 2)], reading)).toBe('i');
  });
});

describe('Reading rows', () => {
  const id = '01JB0000000000000000000000';
  test('write the source by short title and position, and read back only a whole reference', () => {
    expect(readingRowText(id, 'Meditations', 'Book IV')).toBe(`[[${id}|Meditations|Book IV]]`);
    expect(readingRowText(id, 'A | B [x]', null)).toBe(`[[${id}|A B x]]`);
    expect(readingRowSource(`[[${id}|Meditations|Book IV]]`)).toBe(id);
    expect(readingRowSource(`See [[${id}]]`)).toBeUndefined();
    expect(readingRowSource('[[Meditations]]')).toBeUndefined();
  });
});

describe('captureOperations into a section', () => {
  const block = (id: string, parent: string | null, text: string, heading: 1 | 2 | 3 | null = null): Block =>
    ({ id, page_id: 'day', parent_id: parent, kind: parent ? 'block' : 'journal', text, heading, archived: false, revision: 1, created_at: 1, updated_at: 1 });
  const notebook = (rows: Block[]) => ({
    api: {
      journal: async () => ({ id: 'day' }),
      page: async () => ({ root: block('day', null, '2026-10-25'), rows: rows.map(value => ({ block: value })) }) as unknown as PageView,
    },
  }) as unknown as NotebookClient;
  const capture = { date: '2026-10-25', text: 'A link to read', task: null, picked: [] as [string, string][], section: target };

  test('writes the missing heading and the line in one batch', async () => {
    const { operations } = await captureOperations(notebook([block('n', 'day', 'A thought'), block('e', 'day', '')]), capture);
    expect(operations).toMatchObject([
      { op: 'insert', parent_id: 'day', after: null, text: 'Inbox', heading: 2 },
      { op: 'insert', after: null, text: 'A link to read', heading: null },
    ]);
    expect((operations[1] as { parent_id: string }).parent_id).toBe((operations[0] as { id: string }).id);
  });

  test('appends as the last child of an existing heading', async () => {
    const { operations } = await captureOperations(notebook([block('i', 'day', 'Inbox', 2), block('c', 'i', 'Earlier'), block('e', 'day', '')]), capture);
    expect(operations).toMatchObject([{ op: 'insert', parent_id: 'i', after: 'c', text: 'A link to read' }]);
  });

  test('files a Reading note under its source, writing the source row the first time', async () => {
    const source = '01JB0000000000000000000000';
    const reading = { ...sectionTarget(defaultTodayTemplate, 'reading')!, under: { id: source, text: readingRowText(source, 'Meditations', 'Book IV') } };
    const first = await captureOperations(notebook([block('r', 'day', 'Reading', 2), block('o', 'r', '[[01JB0000000000000000000001|Other]]')]), { ...capture, section: reading });
    expect(first.operations).toMatchObject([
      { op: 'insert', parent_id: 'r', after: 'o', text: `[[${source}|Meditations|Book IV]]` },
      { op: 'insert', after: null, text: 'A link to read' },
    ]);
    expect((first.operations[1] as { parent_id: string }).parent_id).toBe((first.operations[0] as { id: string }).id);
    const again = await captureOperations(notebook([block('r', 'day', 'Reading', 2), block('s', 'r', `[[${source}|Meditations|Book III]]`), block('n', 's', 'Earlier')]), { ...capture, section: reading });
    expect(again.operations).toMatchObject([{ op: 'insert', parent_id: 's', after: 'n', text: 'A link to read' }]);
  });
});
