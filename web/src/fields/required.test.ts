import { expect, test } from 'bun:test';
import type { Block, Type } from '../api/types';
import { missingFilter, requiredIds, requiredReason } from './required';

const type = (text: string, plural: string | null = null): Type => ({ page: { id: 'T', text } as Block, fields: ['A'], members: 3, card_templates: 0, plural, icon: null, required: [{ field_id: 'A', missing: 2 }] });

test('a required field gives its reason in the type’s plural and lists members without a value', () => {
  expect(requiredReason(type('book'), 'author')).toBe('Books require author.');
  expect(requiredReason(type('Thesis'), 'author')).toBe('Theses require author.');
  expect(requiredReason(type('book', 'monographs'), 'author')).toBe('Monographs require author.');
  expect([...requiredIds(type('book'))]).toEqual(['A']);
  // A service from before required fields sends none.
  expect(requiredIds({ ...type('book'), required: undefined } as unknown as Type).size).toBe(0);
  expect(missingFilter('A')).toEqual({ field: 'A', op: 'empty', value: null });
});
