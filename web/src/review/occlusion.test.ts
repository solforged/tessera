import { expect, test } from 'bun:test';
import type { Occlusion } from '../api/types';
import { cardKindLabel, groupLetter, occlusionCards, occlusionSides, occlusionSubject } from './card-text';
import { prepareOcclusionDraft } from './occlusion-draft';

const image = { sha256: 'a'.repeat(64), media_type: 'image/png', width: 800, height: 600 };
const state: Occlusion = { mode: 'hide_one', groups: [{ id: 'second', answer: 'Answer', hint: 'Hint' }, { id: 'first' }], masks: [
  { id: 'a', group: 'second', shape: 'rect', x: .1, y: .2, w: .3, h: .4 },
  { id: 'b', group: 'first', shape: 'ellipse', x: .6, y: .2, w: .3, h: .4 },
] };

test('occlusion labels use group order, not identifiers, and subjects never expose JSON', () => {
  const cards = occlusionCards(image, state);
  expect(cardKindLabel(cards[0]!, cards)).toBe('OCCLUSION 1');
  expect(cardKindLabel(cards[1]!, cards)).toBe('OCCLUSION 2');
  expect(cardKindLabel(cards[1]!, [cards[1]!])).toBe('OCCLUSION');
  expect(occlusionSubject({ ...cards[0]!, occlusion_index: 0 })).toBe('Answer');
  expect(occlusionSubject({ ...cards[1]!, occlusion_index: 1 })).toBe('Mask B');
  expect(groupLetter(26)).toBe('AA'); expect(groupLetter(99)).toBe('CV');
});

test('occlusion figures ignore malformed retained sides and preserve crops and other masks', () => {
  const cards = occlusionCards(image, { ...state, mode: 'hide_all', groups: [{ ...state.groups[0]!, area: { x: .1, y: .2, w: .4, h: .4 } }, state.groups[1]!] });
  const sides = occlusionSides(cards[0]!);
  expect(sides?.front.area).toEqual({ x: .1, y: .2, w: .4, h: .4 });
  expect(sides?.front.tested).toHaveLength(1); expect(sides?.front.covered).toHaveLength(1);
  expect(sides?.back.answer).toBe('Answer');
  for (const front of ['', 'null', '{}', '{', JSON.stringify({ ...sides!.front, tested: [null] }), JSON.stringify({ ...sides!.front, area: { x: 0, y: 0, w: 2, h: 1 } })]) {
    expect(occlusionSides({ front, back: '{}' })).toBeNull();
  }
  expect(occlusionSides({ ...cards[0]!, back: 'null' })).toBeNull();
  expect(occlusionCards(null, state)).toEqual([]);
});

test('invalid editor drafts stay local and can be corrected without poisoning the save queue', () => {
  const draft = structuredClone(state);
  draft.groups[0]!.hint = 'x'.repeat(201);
  expect(() => prepareOcclusionDraft(draft)).toThrow('These masks are not valid: a hint or answer is longer than 200 characters.');
  draft.groups[0]!.hint = `  ${'𐐀'.repeat(200)}  `;
  draft.groups[0]!.answer = '  ';
  const saved = prepareOcclusionDraft(draft)!;
  expect(saved.groups[0]!.hint).toBe('𐐀'.repeat(200));
  expect(saved.groups[0]!.answer).toBeUndefined();
  expect(draft.groups[0]!.answer).toBe('  ');
  expect(prepareOcclusionDraft({ ...draft, masks: [] })).toBeNull();
  draft.groups = Array.from({ length: 101 }, (_, i) => ({ id: `g${i}` }));
  expect(() => prepareOcclusionDraft(draft)).toThrow('These masks are not valid: there are more than 100 groups or 300 masks.');
  const outside = structuredClone(state);
  outside.masks[0]!.w = 1;
  expect(() => prepareOcclusionDraft(outside)).toThrow('These masks are not valid: a mask lies outside the image or is too small.');
});
