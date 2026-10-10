import { expect, test } from 'bun:test';
import type { HighlightRow } from '../api/types';
import { mergeMembers, overlappingHighlights } from './highlight-merge';

const point = (offset: number, passage_id = 'p') => ({ passage_id, offset });
function row(id: string, start: number, end: number, created_at: number, page = 'source', snapshot = 'snapshot'): HighlightRow {
  const block = { id, kind: 'block' as const, parent_id: page, page_id: page, text: id, heading: null, archived: false, revision: 1, created_at, updated_at: created_at };
  return { block: { block, page: { ...block, id: page, kind: 'page', parent_id: null } }, citation: {
    id, block_id: id, source_id: 'source', snapshot_id: snapshot, start: point(start), end: point(end), ordinal: 0, quote: id, locator: 'chapter', color: null, triage: null,
  }, source_title: 'Source', processed: false, notes: 0, triage: null, color: null, tags: [], created_at };
}
const ordinals = new Map([['p', 0], ['q', 1]]);

test('touching and transitive overlaps form a union, with earliest-created survivor', () => {
  const rows = [row('later', 0, 10, 2), row('first', 10, 20, 1), row('third', 18, 30, 3), row('separate', 40, 50, 4)];
  const groups = overlappingHighlights(rows, ordinals);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.start).toEqual(point(0));
  expect(groups[0]!.end).toEqual(point(30));
  expect(mergeMembers(groups[0]!, 'source', new Set()).survivor?.citation.id).toBe('first');
});

test('selection connects two clusters, but not another snapshot', () => {
  const rows = [row('left', 0, 10, 1), row('right', 20, 30, 2), row('other', 0, 30, 0, 'source', 'old')];
  const groups = overlappingHighlights(rows, ordinals, { snapshot_id: 'snapshot', start: point(10), end: point(20) });
  expect(groups).toHaveLength(1);
  expect(groups[0]!.rows.map(row => row.citation.id)).toEqual(['left', 'right']);
  expect(groups[0]!.start).toEqual(point(0));
  expect(groups[0]!.end).toEqual(point(30));
});

test('referenced secondary and external-page citations remain intact but contribute their range', () => {
  const rows = [row('external', 0, 15, 0, 'elsewhere'), row('first', 10, 20, 1), row('referenced', 15, 30, 2), row('remove', 25, 40, 3)];
  const group = overlappingHighlights(rows, ordinals)[0]!;
  const plan = mergeMembers(group, 'source', new Set(['referenced']));
  expect(plan.survivor?.citation.id).toBe('first');
  expect(plan.kept.map(row => row.citation.id)).toEqual(['external', 'referenced']);
  expect(plan.removed.map(row => row.citation.id)).toEqual(['remove']);
  expect(group.start).toEqual(point(0));
  expect(group.end).toEqual(point(40));
});

test('cross-passage ordering uses ordinals, not passage IDs or offsets alone', () => {
  const first = row('first', 8, 2, 1); first.citation.end = point(2, 'q');
  const second = row('second', 2, 8, 2); second.citation.start = point(2, 'q'); second.citation.end = point(8, 'q');
  const groups = overlappingHighlights([second, first], ordinals);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.start).toEqual(point(8));
  expect(groups[0]!.end).toEqual(point(8, 'q'));
});

test('survivor keeps its colour, or takes the incoming colour when uncoloured', () => {
  const first = row('first', 0, 10, 1), second = row('second', 5, 15, 2);
  const group = overlappingHighlights([first, second], ordinals)[0]!;
  expect(mergeMembers(group, 'source', new Set(), 'blue').color).toBe('blue');
  first.citation.color = 'green';
  expect(mergeMembers(group, 'source', new Set(), 'blue').color).toBe('green');
  first.citation.color = null; second.citation.color = 'purple';
  expect(mergeMembers(group, 'source', new Set()).color).toBe('purple');
});
