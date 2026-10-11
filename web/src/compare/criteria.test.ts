import { expect, test } from 'bun:test';
import { exactRepeats } from './criteria';

test('only exact trimmed authored cells repeat, with stable row-local groups', () => {
  const values: Record<string, Record<string, string>> = {
    POL: { shape: ' circle ', engine: 'corruption' }, CIC: { shape: 'circle', engine: 'corruption' },
    MAC: { shape: 'circle, rarely completed', engine: 'Corruption' }, PLA: { shape: '', engine: '' },
  };
  expect(exactRepeats(['shape', 'engine'], Object.keys(values), (id, field) => values[id]![field]!)).toEqual([
    { number: 1, criterion: 'shape', text: 'circle', positions: ['POL', 'CIC'] },
    { number: 2, criterion: 'engine', text: 'corruption', positions: ['POL', 'CIC'] },
  ]);
  expect(exactRepeats(['shape'], ['POL', 'MAC'], (id, field) => values[id]![field]!)).toEqual([]);
});

test('blank values do not repeat and internal whitespace remains authored', () => {
  expect(exactRepeats(['field'], ['a', 'b'], () => ' \n ')).toEqual([]);
  expect(exactRepeats(['field'], ['a', 'b'], id => id === 'a' ? 'rise\nand fall' : 'rise and fall')).toEqual([]);
});
