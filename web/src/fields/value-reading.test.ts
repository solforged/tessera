import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { fieldValueProblem, guessFieldKind } from './value-reading';

const field = (kind: FieldDefinition['kind']): FieldDefinition => ({ id: 'field', name: 'Field', kind, revision: 1, options: [{ id: 'option', text: 'Option' }], targets: [] });

describe('outline field reading problems', () => {
  test('marks invalid numbers without accepting JavaScript-only number spellings', () => {
    for (const text of ['four', '1e3', '+1', '.5', '1.', '0xff', 'NaN', 'Infinity', '9'.repeat(400)]) expect(fieldValueProblem(field('number'), text)).toBe('not a number');
    for (const text of ['0', '-12', ' 004.5 ', '-0.5']) expect(fieldValueProblem(field('number'), text)).toBeUndefined();
  });
  test('accepts partial dates and valid calendar days, not picker shorthand', () => {
    for (const text of ['1', '2026', '2026-10', '2024-02-29']) expect(fieldValueProblem(field('date'), text)).toBeUndefined();
    for (const text of ['0000', '2026-13', '2026-02-29', 'tomorrow', 'not a date']) expect(fieldValueProblem(field('date'), text)).toBe('not a date');
  });
  test('uses existing checkbox readings and definition options', () => {
    expect(fieldValueProblem(field('checkbox'), 'maybe')).toBe('not a checkbox');
    expect(fieldValueProblem(field('checkbox'), '[x]')).toBeUndefined();
    expect(fieldValueProblem(field('choice'), 'Option')).toBe('not an option');
    expect(fieldValueProblem(field('choice'), '[[other]]')).toBe('not an option');
    expect(fieldValueProblem(field('choice'), '[[option]]')).toBeUndefined();
  });
  test('marks malformed URLs and references, leaving unresolved constraints and empty slots alone', () => {
    expect(fieldValueProblem(field('url'), 'https://')).toBe('not a URL');
    expect(fieldValueProblem(field('url'), 'https://example.org/a')).toBeUndefined();
    expect(fieldValueProblem(field('instance'), 'Person')).toBe('not a reference');
    for (const kind of ['date', 'instance'] as const) expect(fieldValueProblem(field(kind), '[[unresolved]]')).toBeUndefined();
    for (const kind of ['number', 'date', 'choice', 'checkbox'] as const) expect(fieldValueProblem(field(kind), '  ')).toBeUndefined();
  });
});

describe('first-value kind guesses', () => {
  const id = '01M4W27DSHYJGWZF9VHNQBM1A0';
  test('read references, dates, numbers and addresses, and leave the rest as text', () => {
    expect(guessFieldKind(`[[${id}]]`)).toBe('instance');
    expect(guessFieldKind(`[[${id}|Anomalies]]`)).toBe('instance');
    expect(guessFieldKind(`[[${id}]]`, () => 'journal')).toBe('date');
    expect(guessFieldKind('2026-10-14')).toBe('date');
    expect(guessFieldKind('2026-02-30')).toBeNull();
    for (const text of ['4', '-0.5', '1970']) expect(guessFieldKind(text)).toBe('number');
    expect(guessFieldKind('https://example.com/a')).toBe('url');
    for (const text of ['calm', '4 stars', 'yes', '[[A title]]', `see [[${id}]]`, 'c. 1340s']) expect(guessFieldKind(text)).toBeNull();
  });
});
