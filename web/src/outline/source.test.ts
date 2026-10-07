import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { extractedResets, formatSourceValue, shortSourceTitle, sourceFieldName, valueLabel } from './source';

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
