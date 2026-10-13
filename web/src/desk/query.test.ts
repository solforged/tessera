import { expect, test } from 'bun:test';
import type { Block, PageView, QueryRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { attributeDefinitions } from '../table/attributes';
import { copyQuery, queriesEqual, queryFieldIds, remapQueryField, removeQueryField } from '../table/query';
import { columnQuery, deskConditionLabel, deskQuery, initialSelection, linkedQuery, positionLocators, updateColumn } from './query';

test('desk edits and linking preserve the other columns and copy nested recipes', () => {
  const query = deskQuery('question');
  const next = updateColumn(query, 1, { ...columnQuery(query, 1), text: 'Aristotle', filters: [...columnQuery(query, 1).filters, { field: 'gist', op: 'set', value: null }] });
  expect(next.filters).toEqual(query.filters);
  expect(next.desk!.sources).toEqual(query.desk!.sources);
  expect(initialSelection(next).question).toBe('question');
  const moved = linkedQuery(next.desk!.positions, '@question', 'branch');
  expect(moved.filters).toEqual([{ field: '@question', op: 'is', value: 'branch' }, { field: 'gist', op: 'set', value: null }]);
  const copied = copyQuery(next);
  expect(queriesEqual(copied, next)).toBe(true);
  copied.desk!.positions.filters[0]!.value = 'other';
  expect(next.desk!.positions.filters[0]!.value).toBe('question');
  expect(queriesEqual(copied, next)).toBe(false);
  expect(queriesEqual(next, { ...next, layout: 'table' })).toBe(false);
  expect(queryFieldIds(next)).toEqual(['gist']);
  expect(remapQueryField(next, 'gist', 'summary').desk!.positions.filters[1]!.field).toBe('summary');
  expect(removeQueryField(next, 'gist').desk!.positions.filters).toEqual(query.desk!.positions.filters);
});

test('restored cited-in labels resolve reference titles before and after position rows load', () => {
  const positionId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const holderId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
  const position = { id: positionId, text: `[[${holderId}]]` } as Block;
  const holder = { id: holderId, text: 'Sylvia Scribner' } as Block;
  const cached = {
    cache: new Map([[positionId, position], [holderId, holder]]),
    lookup(id: string) {
      const block = this.cache.get(id);
      return () => block;
    },
  };
  const notebook = cached as unknown as NotebookClient;
  const condition = { field: '@cited_in', op: 'is' as const, value: positionId };
  const fields = attributeDefinitions('sources');
  expect(deskConditionLabel(condition, fields, notebook, [])).toBe('Cited in is Sylvia Scribner');
  const row = { block: { block: position }, attributes: {} } as QueryRow;
  expect(deskConditionLabel(condition, fields, notebook, [row])).toBe('Cited in is Sylvia Scribner');
  holder.text = 'Scribner';
  expect(deskConditionLabel(condition, fields, notebook, [])).toBe('Cited in is Scribner');
});

test('locators include only the selected position subtree and exclude archived branches', () => {
  const block = (id: string, parent_id: string | null, text: string, archived = false) => ({ id, parent_id, text, archived }) as Block;
  const source = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const blocks = [block('position', 'page', ''), block('work', 'position', `[[${source}||p. 12]] [[${source}||p. 12]]`), block('hidden', 'position', '', true), block('hidden-value', 'hidden', `[[${source}||p. 99]]`), block('sibling', 'page', `[[${source}||p. 88]]`)];
  const page = { root: block('page', null, ''), rows: blocks.map(block => ({ block, depth: 1, manual_types: [] })), targets: [], capabilities: [] } satisfies PageView;
  expect(positionLocators(page, 'position').get(source)).toEqual(['p. 12']);
});
