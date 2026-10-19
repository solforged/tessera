import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { displayPattern, draftPattern, patternParts, storedPattern, usedFields } from './card-patterns';

const fields: FieldDefinition[] = [
  { id: '01K00000000000000000000001', name: 'Lemma', kind: 'text', revision: 1, options: [], targets: [] },
  { id: '01K00000000000000000000002', name: 'Gloss', kind: 'text', revision: 1, options: [], targets: [] },
];

test('atom text stays reserved and previews wait for every referenced side', () => {
  expect(storedPattern('{@text}', fields)).toBe('{@text}');
  expect(displayPattern('{@text}', fields)).toBe('{@text}');
  expect(usedFields('{@text}', `{${fields[0]!.id}}`)).toEqual([fields[0]!.id]);
  expect(draftPattern('{@text}', 'il lavello', {})).toBe('il lavello');
  expect(draftPattern('{@text}', ' ', {})).toBeNull();
  expect(draftPattern(`{@text}: {${fields[0]!.id}}`, 'il lavello', {})).toBeNull();
  expect(draftPattern('\\{literal} {@text}', 'il lavello', {})).toBe('{literal} il lavello');
});
describe('template patterns', () => {
  test('round trips multiple tokens and escaped braces', () => {
    const text = '\\{literal} {Lemma} → {Gloss}';
    const stored = storedPattern(text, fields);
    expect(displayPattern(stored, fields)).toBe(text);
    expect(usedFields(stored, stored)).toEqual(fields.map(field => field.id));
    expect(patternParts('α\\{literal}')).toEqual([{ text: 'α\\{literal}', field: false }]);
  });
  test('keeps identity through a field rename', () => {
    const stored = storedPattern('{Gloss}', fields);
    expect(displayPattern(stored, fields.map(field => ({ ...field, name: field.name === 'Gloss' ? 'Meaning' : field.name })))).toBe('{Meaning}');
    expect(storedPattern(`{${fields[1]!.id}}`, fields)).toBe(stored);
  });
  test('rejects unknown, unclosed and ambiguous references', () => {
    expect(() => storedPattern('{Missing}', fields)).toThrow('Unknown field');
    expect(() => storedPattern('{Gloss', fields)).toThrow('Close the field');
    expect(() => storedPattern('{Gloss}', [...fields, { ...fields[1]!, id: '01K00000000000000000000003' }])).toThrow('Choose one');
  });
});
