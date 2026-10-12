import { describe, expect, test } from 'bun:test';
import type { BlockKind, FieldDefinition, QueryRow } from '../api/types';
import { cardFields, rowSources, sourceDefinition, splitMembers } from './register';

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
  test('separates tagged blocks without losing order or journal members', () => {
    const rows = [row('first', 'page'), row('tagged', 'block'), row('day', 'journal'), row('another-tag', 'block')] as const;
    expect(splitMembers(rows)).toEqual({ notes: [rows[0], rows[2]], blocks: [rows[1], rows[3]] });
    expect(rows).toHaveLength(4);
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
