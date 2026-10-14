import { expect, test } from 'bun:test';
import { fieldKinds, fieldNameProblem, kindLabels } from './kinds';

test('field labels cover the ordered kind contract', () => {
  expect(Object.keys(kindLabels)).toEqual([...fieldKinds]);
});

test('creation and rename refuse another definition with the same name', () => {
  const fields = [{ id: 'gloss', name: 'Gloss' }, { id: 'gist', name: 'Gist' }];
  expect(fieldNameProblem('Gloss', fields)).toBe('A field named Gloss already exists.');
  expect(fieldNameProblem(' gloss ', fields, 'gist')).toBe('A field named gloss already exists.');
  expect(fieldNameProblem('Gloss', fields, 'gloss')).toBeNull();
  expect(fieldNameProblem('New field', fields, 'gist')).toBeNull();
  expect(fieldNameProblem('Name::', fields, 'gist')).toBe('Field names cannot contain [ ] # : ` or \\.');
});
