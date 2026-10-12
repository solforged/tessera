import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { choiceRows, hasValueEditor, partialFieldDate } from './value-options';

const options = [{ id: 'seed', text: 'Seedling' }, { id: 'evergreen', text: 'Evergreen' }];
const field = (kind: FieldDefinition['kind']): FieldDefinition => ({ id: 'field', name: 'Field', kind, revision: 1, options, targets: [] });

describe('choice rows', () => {
  test('filters case-insensitively and always retains Clear', () => {
    expect(choiceRows(options, ' EVER ')).toEqual([{ kind: 'option', option: options[1]! }, { kind: 'create', text: 'EVER' }, { kind: 'clear' }]);
  });
  test('does not offer a duplicate or blank option', () => {
    expect(choiceRows(options, 'EVERGREEN')).toEqual([{ kind: 'option', option: options[1]! }, { kind: 'clear' }]);
    expect(choiceRows(options, '  ').filter(row => row.kind === 'create')).toEqual([]);
  });
  test('creates an unmatched option without changing its spelling', () => {
    expect(choiceRows(options, ' Dormant ')).toEqual([{ kind: 'create', text: 'Dormant' }, { kind: 'clear' }]);
  });
});

describe('field dates', () => {
  test('retains valid year and month precision', () => {
    for (const input of ['1', '99', '0001', '2026', '9999', '2026-10']) expect(partialFieldDate(input)).toBe(input);
  });
  test('rejects invalid partial dates', () => {
    for (const input of ['', '0', '0000', '10000', '2026-00', '2026-13', '0000-10', '2026-1', '2026-10-09']) expect(partialFieldDate(input)).toBeNull();
  });
  test('opens a calendar only for readable or empty dates', () => {
    for (const input of ['', '2026', '2026-10', '2026-10-09', 'today']) expect(hasValueEditor(field('date'), input, '2026-10-12')).toBe(true);
    for (const input of ['sometime', '2026-02-30', '2026-10-09 12:30']) expect(hasValueEditor(field('date'), input, '2026-10-12')).toBe(false);
  });
  test('always controls references and leaves plain values inline', () => {
    for (const kind of ['choice', 'instance'] as const) expect(hasValueEditor(field(kind), '[[id]]', '2026-10-12')).toBe(true);
    for (const kind of ['text', 'number', 'url', 'identifier', 'checkbox'] as const) expect(hasValueEditor(field(kind), '', '2026-10-12')).toBe(false);
  });
});
