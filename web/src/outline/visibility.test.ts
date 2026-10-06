import { describe, expect, test } from 'bun:test';
import { initialRow } from './visibility';

describe('initial outline row', () => {
  const rows = new Map([
    ['field', { text: '[[definition]]', archived: false }],
    ['alias', { text: ' [[other|Author]] ', archived: false }],
    ['archived', { text: 'Old prose', archived: true }],
    ['prose', { text: 'A note about [[reference]]', archived: false }],
    ['empty', { text: '', archived: false }],
  ]);
  test('chooses visible non-field prose and skips archived rows', () => {
    expect(initialRow(['field', 'alias', 'archived', 'prose'], id => rows.get(id))).toBe('prose');
    expect(initialRow(['field', 'empty', 'prose'], id => rows.get(id))).toBe('empty');
  });
  test('falls back to the first visible row when all are field entries or archived', () => {
    expect(initialRow(['alias', 'field'], id => rows.get(id))).toBe('alias');
    expect(initialRow(['archived', 'field'], id => rows.get(id))).toBe('archived');
  });
  test('does not choose hidden rows and tolerates an empty outline', () => {
    expect(initialRow(['field'], id => rows.get(id))).toBe('field');
    expect(initialRow([], id => rows.get(id))).toBeNull();
  });
});
