import { expect, test } from 'bun:test';
import type { Block } from '../api/types';
import { blockTrail } from './block-trail';

const concept = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const block = (id: string, text: string, over: Partial<Block> = {}): Block => ({ id, text, kind: 'block', parent_id: null, page_id: 'alibi', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0, ...over });
const blocks = new Map([
  ['alibi', block('alibi', `ALiBi #[[${concept}|concept]]`, { kind: 'page' })],
  [concept, block(concept, 'Concept', { kind: 'page', page_id: concept })],
  ['review', block('review', 'Review', { parent_id: 'alibi' })],
  ['formula', block('formula', 'Feed-forward layer formula >> W_2 φ(W_1 x)', { parent_id: 'review' })],
  ['card', block('card', 'Slopes', { parent_id: 'formula' })],
  ['day', block('day', '2026-11-01', { kind: 'journal', page_id: 'day' })],
]);
const lookup = (id: string) => () => blocks.get(id);

test('a card’s source line names its page by the tagless title, as the note header does', () => {
  expect(blockTrail(blocks.get('review')!, lookup)).toBe('ALiBi');
  expect(blockTrail(blocks.get('alibi')!, lookup)).toBe('ALiBi');
  expect(blockTrail(blocks.get('day')!, lookup)).toBe('2026-11-01');
});

test('ancestors in a trail read as a reader sees them, with card operators as arrows', () => {
  const trail = blockTrail(blocks.get('card')!, lookup);
  expect(trail).toStartWith('ALiBi › Review › Feed-forward layer formula');
  expect(trail).toContain('→');
  expect(trail).not.toContain('>>');
  expect(trail).not.toContain('#');
  expect(blockTrail(blocks.get('formula')!, lookup, true)).toBe('ALiBi');
});
