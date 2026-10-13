import { describe, expect, test } from 'bun:test';
import type { BlockKind, FieldDefinition, QueryResult, QueryRow } from '../api/types';
import { cardFields, cellScrollLeft, createGridRows, defaultEntityColumns, registerMembers, retainCell, rowSources, sourceDefinition } from './register';

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
  test('query refreshes retain the row and value identities that own an editor', () => {
    const reconcileRows = createGridRows();
    const first = reconcileRows([{ row: row('position', 'block', { title: ['Before'] }), hidden: false }]);
    const owner = first[0]!.row;
    const value = owner.values.title![0];
    const refreshed = reconcileRows([{ row: row('position', 'block', { title: ['After'] }), hidden: false }]);
    expect(refreshed[0]).toBe(first[0]);
    expect(refreshed[0]!.row).toBe(owner);
    expect(refreshed[0]!.row.values.title![0]!.id).toBe(value!.id);
    expect(refreshed[0]!.row.values.title![0]!.text).toBe('After');
  });
  test('one position in several groups keeps a separate stable occurrence in each', () => {
    const reconcileRows = createGridRows();
    const group = (key: string) => ({ key, title: key, target: null, row_ids: ['position'], count: 1 });
    const first = reconcileRows(['first', 'second'].map(key => ({ row: row('position', 'block'), group: group(key), hidden: false })));
    const refreshed = reconcileRows(['first', 'second'].map(key => ({ row: row('position', 'block'), group: group(key), hidden: key === 'first' })));
    expect(first[0]).not.toBe(first[1]);
    expect(refreshed[0]).toBe(first[0]);
    expect(refreshed[1]).toBe(first[1]);
    expect(refreshed[0]!.hidden).toBe(true);
    reconcileRows([]);
    expect(reconcileRows([{ row: row('position', 'block'), group: group('first'), hidden: false }])[0]).not.toBe(first[0]);
  });
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
  test('new entity columns prioritise attributes and roles, then quarter-filled fields', () => {
    const definitions: FieldDefinition[] = [
      { ...fields[0]!, id: 'summary', name: 'Summary', role: 'standfirst' },
      { ...fields[0]!, id: 'gist', name: 'Gist', role: 'attribute' },
      { ...fields[0]!, id: 'common', name: 'Common' },
      { ...fields[0]!, id: 'empty', name: 'Empty' },
    ];
    const rows = Array.from({ length: 8 }, (_, index) => row(`position-${index}`, 'block', { summary: index === 0 ? ['Summary'] : [], gist: index === 0 ? ['Rare gist'] : [], common: index < 2 ? ['Filled', 'Another value'] : [' '], empty: [] }));
    const result: QueryResult = { fields: definitions, columns: ['gist', 'common', 'summary', 'empty'], rows, total: rows.length };
    expect(defaultEntityColumns('positions', result)).toEqual(['@holder', '@subject', 'summary', 'common']);
    expect(result.columns).toEqual(['gist', 'common', 'summary', 'empty']);
    expect(defaultEntityColumns('questions', { fields: [], columns: [], rows: [], total: 0 })).toEqual(['@state', '@readings', '@last_assessed', '@revisit']);
  });
  test('six-column defaults reserve room for Title and derived Refs', () => {
    const rows = [row('source', 'page', Object.fromEntries(fields.map(field => [field.id, ['Filled']])) )];
    const result: QueryResult = { fields, columns: fields.map(field => field.id), rows, total: 1 };
    const selected = defaultEntityColumns('sources', result);
    expect(selected[0]).toBe('@creator');
    expect(selected.length + 1 + (sourceDefinition(selected, fields) ? 1 : 0)).toBeLessThanOrEqual(6);
    const summaries = Array.from({ length: 8 }, (_, index): FieldDefinition => ({ ...fields[0]!, id: `summary-${index}`, role: 'standfirst' }));
    expect(defaultEntityColumns('positions', { fields: summaries, columns: summaries.map(field => field.id), rows: [], total: 0 })).toHaveLength(5);
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
  test('focused cells stay clear of the sticky title without shifting visible cells', () => {
    expect(cellScrollLeft(35, 205, 493, 0, 984, 240)).toBe(0);
    expect(cellScrollLeft(35, 493, 781, 0, 984, 240)).toBe(35);
    expect(cellScrollLeft(0, 800, 1088, 0, 984, 240)).toBe(104);
    expect(cellScrollLeft(0, 240, 1200, 0, 984, 240)).toBe(0);
  });
});
