import { describe, expect, test } from 'bun:test';
import type { BlockKind, FieldDefinition, QueryRow } from '../api/types';
import { cardFields, registerMembers, retainCell, rowSources, sourceDefinition } from './register';

function row(id: string, kind: BlockKind, values: Record<string, string[]> = {}): QueryRow {
  const block = { id, kind, parent_id: kind === 'block' ? 'page' : null, page_id: kind === 'block' ? 'page' : id, text: id, heading: null, archived: false, revision: 0, created_at: 0, updated_at: 0 } as const;
  return { block: { block, page: { ...block, id: block.page_id, kind: 'page' } }, values: Object.fromEntries(Object.entries(values).map(([field, texts]) => [field, texts.map((text, index) => ({ id: `${field}-${index}`, text, reading: { ok: true, value: text, target: null } }))])) };
}
const fields: FieldDefinition[] = [
  { id: 'title', name: 'Subtitle', kind: 'text', revision: 0, options: [], targets: [] },
  { id: 'area', name: 'Area', kind: 'choice', revision: 0, options: [], targets: [] },
  { id: 'source', name: 'Source', kind: 'text', revision: 0, options: [], targets: [] },
  { id: 'author', name: 'Author', kind: 'instance', revision: 0, options: [], targets: [] },
  { id: 'url', name: 'URL', kind: 'url', revision: 0, options: [], targets: [] },
];

describe('table register presentation', () => {
  test('orders notes before tagged blocks, retaining query order, values and journal members', () => {
    const rows = [row('tagged', 'block', { title: ['Block field value'] }), row('first', 'page'), row('another-tag', 'block'), row('day', 'journal')] as const;
    const members = registerMembers(rows);
    expect(members.rows).toEqual([rows[1], rows[3], rows[0], rows[2]]);
    expect(members.rows[2]).toBe(rows[0]);
    expect(members.rows[2]!.values.title![0]!.text).toBe('Block field value');
    expect(members.taggedGroup).toEqual({ rowId: 'tagged', count: 2 });
    expect(rows.map(member => member.block.block.id)).toEqual(['tagged', 'first', 'another-tag', 'day']);
  });
  test('single-kind and empty registers never introduce a tagged-block divider', () => {
    for (const rows of [[], [row('first', 'page'), row('day', 'journal')], [row('tagged', 'block'), row('another-tag', 'block')]]) {
      expect(registerMembers(rows)).toEqual({ rows, taggedGroup: null });
    }
  });
  test('derives refs from Source before a URL field and preserves repeated authored destinations', () => {
    const source = sourceDefinition(['url', 'source'], fields);
    expect(source?.id).toBe('source');
    const sources = rowSources(row('note', 'page', { source: ['[First](https://example.org/a)', '[Second](https://example.org/a)'], url: ['https://other.org/'] }), source);
    expect(sources.map(value => value.label)).toEqual(['First', 'Second']);
    expect(sourceDefinition(['author'], fields)).toBeUndefined();
    expect(rowSources(row('note', 'page'), source)).toEqual([]);
  });
  test('cards prioritise choice and source, respecting hidden and empty fields', () => {
    const note = row('note', 'page', { title: ['Subtitle'], area: ['Architecture'], source: ['https://example.org'], author: ['[[author]]'] });
    const source = sourceDefinition(['source'], fields);
    expect(cardFields(note, ['title', 'area', 'source', 'author'], fields, source).map(field => field.id)).toEqual(['area', 'source']);
    expect(cardFields(note, ['title', 'area', 'author'], fields, source).map(field => field.id)).toEqual(['area', 'author']);
    expect(cardFields(note, ['title'], fields, source).map(field => field.id)).toEqual(['title']);
    expect(cardFields(row('empty', 'page', { area: [' '] }), ['area'], fields, source)).toEqual([]);
    expect(cardFields(row('choice-only', 'page', { area: ['[[topic]]'], title: ['Subtitle'] }), ['area', 'title'], fields, undefined).map(field => field.id)).toEqual(['area', 'title']);
  });
});

describe('table cell ownership', () => {
  test('keeps the edited entity and field through sorting in either direction', () => {
    const rows = [row('Ibn', 'page'), row('Spengler', 'page'), row('Toynbee', 'page'), row('Polybius', 'page')];
    const cell = { rowId: 'Polybius', fieldId: 'lived' };
    expect(retainCell(cell, [rows[3]!, ...rows.slice(0, 3)], ['gloss', 'lived'])).toBe(cell);
    expect(retainCell(cell, rows, ['lived', 'gloss'])).toBe(cell);
  });
  test('retains a tagged block cell across mixed-member grouping and sorting', () => {
    const tagged = row('tagged', 'block', { title: ['Field value'] });
    const note = row('note', 'page');
    const cell = { rowId: 'tagged', fieldId: 'title' };
    expect(retainCell(cell, registerMembers([tagged, note]).rows, ['title'])).toBe(cell);
    expect(retainCell(cell, registerMembers([note, tagged]).rows, ['title'])).toBe(cell);
  });
  test('uses the title when the field is hidden and a surviving entity when the row leaves', () => {
    const cell = { rowId: 'Polybius', fieldId: 'lived' };
    expect(retainCell(cell, [row('Polybius', 'page')], ['gloss'])).toEqual({ rowId: 'Polybius', fieldId: null });
    expect(retainCell(cell, [row('Ibn', 'page')], ['lived'])).toEqual({ rowId: 'Ibn', fieldId: 'lived' });
    expect(retainCell(cell, [], ['lived'])).toEqual({ rowId: null, fieldId: 'lived' });
  });
});
