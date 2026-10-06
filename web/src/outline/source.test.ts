import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import type { PageDocument } from '../document/contract';
import { extractedResets, formatSourceValue, shortSourceTitle, sourceFieldName, sourceSummary, valueLabel } from './source';

describe('source outline metadata', () => {
  test('recognizes reference and inline field entries without treating prose as metadata', () => {
    const fields = new Map<string, FieldDefinition>([['publisher', { id: 'publisher', name: 'Publisher', kind: 'text', revision: 1, options: [] }]]);
    expect(sourceFieldName('[[publisher|Imprint]]', fields)).toBe('Publisher');
    expect(sourceFieldName('Publisher:: Authored press', fields)).toBe('Publisher');
    expect(sourceFieldName('A paragraph about [[publisher]]', fields)).toBeUndefined();
  });

  test('formats source language and identifiers without changing other values', () => {
    expect(formatSourceValue('Language', 'en-US')).toBe('American English');
    expect(formatSourceValue('Language', 'en')).toBe('English');
    expect(formatSourceValue('Language', 'not a tag')).toBe('not a tag');
    expect(formatSourceValue('Identifier', 'isbn:9780385340762')).toBe('ISBN 9780385340762');
    expect(formatSourceValue('Identifier', 'doi:10.1000/example')).toBe('DOI 10.1000/example');
    expect(formatSourceValue('Identifier', 'urn:example')).toBe('urn:example');
    expect(formatSourceValue('Title', 'en')).toBe('en');
  });

  test('uses author reference labels and short source titles', () => {
    expect(valueLabel('[[person|Ada Reader]], [[other|Bea Writer]]', () => () => undefined)).toBe('Ada Reader, Bea Writer');
    expect(shortSourceTitle('Evidence: A longer subtitle')).toBe('Evidence');
    expect(shortSourceTitle('a'.repeat(50))).toBe(`${'a'.repeat(40)}…`);
    expect(shortSourceTitle('The Unreasonable Effectiveness of Recurrent Neural Networks')).toBe('The Unreasonable Effectiveness of…');
  });

  test('source summaries preserve author and year and link Site to an active URL field', () => {
    const blocks: Record<string, { text: string; archived: boolean }> = {
      author: { text: 'Author:: Ada Reader', archived: false },
      published: { text: 'Published:: 2026-10-06', archived: false },
      publisher: { text: 'Publisher:: Example press', archived: false },
      site: { text: 'Site:: Example site', archived: false },
      url: { text: '[[url-field]]', archived: false },
      value: { text: 'https://example.org/article', archived: false },
    };
    const doc = {
      pageId: 'source',
      outline: { children: (id: string) => id === 'source' ? ['author', 'published', 'publisher', 'site', 'url'] : id === 'url' ? ['value'] : [] },
      block: (id: string) => blocks[id],
    } as unknown as PageDocument;
    const definitions = new Map<string, FieldDefinition>([['url-field', { id: 'url-field', name: 'URL', kind: 'url', revision: 1, options: [] }]]);
    expect(sourceSummary(doc, definitions, () => () => undefined)).toEqual([
      { text: 'Ada Reader' }, { text: '2026' }, { text: 'Example press' }, { text: 'Example site', url: 'https://example.org/article' },
    ]);
    blocks.value!.archived = true;
    expect(sourceSummary(doc, definitions, () => () => undefined).at(-1)).toEqual({ text: 'Example site', url: undefined });
    blocks.value!.archived = false;
    blocks.value!.text = 'javascript:alert(1)';
    expect(sourceSummary(doc, definitions, () => () => undefined).at(-1)?.url).toBeUndefined();
  });

  test('resets only differing values in matching extracted lists', () => {
    const values = [{ id: 'one', text: 'Authored' }, { id: 'two', text: 'Second' }];
    expect(extractedResets(values.slice(0, 1), ['Original'])).toEqual({ set: [{ id: 'one', text: 'Original' }], insert: [] });
    expect(extractedResets(values, ['First', 'Second'])).toEqual({ set: [{ id: 'one', text: 'First' }], insert: [] });
  });

  test('shorter extracted lists leave authored extras alone', () => {
    expect(extractedResets([{ id: 'one', text: 'Authored' }, { id: 'two', text: 'Extra' }], ['First']))
      .toEqual({ set: [{ id: 'one', text: 'First' }], insert: [] });
  });

  test('longer extracted lists insert missing positions after existing values', () => {
    expect(extractedResets([{ id: 'one', text: 'First' }], ['First', 'Second', 'Third']))
      .toEqual({ set: [], insert: ['Second', 'Third'] });
    expect(extractedResets([], ['First'])).toEqual({ set: [], insert: ['First'] });
  });

  test('empty or unavailable extracted lists leave authored values alone', () => {
    const values = [{ id: 'one', text: 'Authored' }];
    expect(extractedResets(values, [])).toEqual({ set: [], insert: [] });
    expect(extractedResets(values, undefined)).toEqual({ set: [], insert: [] });
    expect(extractedResets([], [])).toEqual({ set: [], insert: [] });
  });
});
