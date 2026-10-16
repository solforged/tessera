import { expect, test } from 'bun:test';
import { exactRepeats, linkedCriteriaDraft, questionReadingIds } from './criteria';
import type { NotebookClient } from '../document/contract';

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

test('reference repeats retain authored identity rather than matching their display labels', () => {
  const values: Record<string, string> = { a: '[[option-one|circle]]', b: '[[option-one|circle]]', c: '[[option-two|circle]]' };
  expect(exactRepeats(['shape'], Object.keys(values), id => values[id]!)).toEqual([
    { number: 1, criterion: 'shape', text: '[[option-one|circle]]', positions: ['a', 'b'] },
  ]);
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

test('a cell commit keeps edits and resolves names added while the first lookup is pending', async () => {
  let draft = 'first [[Anacyclosis]]';
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const lookedUp: string[] = [];
  const notebook = { changeSequence: () => 0, api: { resolveName: async (name: string) => {
    lookedUp.push(name);
    if (name === 'Anacyclosis') await pending;
    return [{ page: { id: name === 'Anacyclosis' ? 'cycle' : 'language' } }];
  } } } as unknown as NotebookClient;
  const commit = linkedCriteriaDraft(notebook, draft, () => draft);
  draft += ' accepted [[Linguistic relativity]]';
  release();
  expect(await commit).toBe('first [[cycle|Anacyclosis]] accepted [[language|Linguistic relativity]]');
  expect(lookedUp).toEqual(['Anacyclosis', 'Linguistic relativity']);
});

test('a cell commit preserves deletion of a reference while its name is resolving', async () => {
  let draft = '[[Anacyclosis]]';
  const notebook = { changeSequence: () => 0, api: { resolveName: async () => {
    draft = 'replacement';
    return [{ page: { id: 'cycle' } }];
  } } } as unknown as NotebookClient;
  expect(await linkedCriteriaDraft(notebook, draft, () => draft)).toBe('replacement');
});
