import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { extractedResets, shortSourceTitle, sourceFieldName, valueLabel } from './source';

describe('source outline metadata', () => {
  test('recognizes reference and inline field entries without treating prose as metadata', () => {
    const fields = new Map<string, FieldDefinition>([['publisher', { id: 'publisher', name: 'Publisher', kind: 'text', revision: 1, options: [] }]]);
    expect(sourceFieldName('[[publisher|Imprint]]', fields)).toBe('Publisher');
    expect(sourceFieldName('Publisher:: Authored press', fields)).toBe('Publisher');
    expect(sourceFieldName('A paragraph about [[publisher]]', fields)).toBeUndefined();
  });

  test('uses author reference labels and short source titles', () => {
    expect(valueLabel('[[person|Ada Reader]], [[other|Bea Writer]]', () => () => undefined)).toBe('Ada Reader, Bea Writer');
    expect(shortSourceTitle('Evidence: A longer subtitle')).toBe('Evidence');
    expect(shortSourceTitle('a'.repeat(50))).toBe(`${'a'.repeat(40)}…`);
    expect(shortSourceTitle('The Unreasonable Effectiveness of Recurrent Neural Networks')).toBe('The Unreasonable Effectiveness of…');
  });

  test('resets only differing values in matching extracted lists', () => {
    const values = [{ id: 'one', text: 'Authored' }, { id: 'two', text: 'Second' }];
    expect(extractedResets(values.slice(0, 1), ['Original'])).toEqual([{ id: 'one', text: 'Original' }]);
    expect(extractedResets(values, ['First', 'Second'])).toEqual([{ id: 'one', text: 'First' }]);
    expect(extractedResets(values, ['Only one'])).toEqual([]);
    expect(extractedResets(values, undefined)).toEqual([]);
    expect(extractedResets([], [])).toEqual([]);
  });
});
