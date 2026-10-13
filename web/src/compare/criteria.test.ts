import { expect, test } from 'bun:test';
import { exactRepeats, questionReadingIds } from './criteria';

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

test('question focus keeps all readings by named holders, not one column per holder', () => {
  const rows = [
    { holder_id: 'polybius', block: { block: { id: 'reading-one' } } },
    { holder_id: 'other', block: { block: { id: 'reading-two' } } },
    { holder_id: 'polybius', block: { block: { id: 'reading-three' } } },
    { holder_id: null, block: { block: { id: 'reading-four' } } },
  ];
  expect(questionReadingIds(rows, ['polybius'])).toEqual(['reading-one', 'reading-three']);
  expect(questionReadingIds(rows, [])).toEqual(rows.map(row => row.block.block.id));
  expect(questionReadingIds(rows, ['missing'])).toEqual([]);
});
