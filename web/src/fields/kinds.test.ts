import { expect, test } from 'bun:test';
import { fieldKinds, kindLabels, partialDatePlaceholder } from './kinds';

test('field labels cover the ordered kind contract', () => {
  expect(Object.keys(kindLabels)).toEqual([...fieldKinds]);
});

test('date prompts show every accepted precision', () => {
  expect(partialDatePlaceholder).toBe('Year (1–9999), YYYY-MM or YYYY-MM-DD');
});
