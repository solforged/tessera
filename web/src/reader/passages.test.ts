import { describe, expect, test } from 'bun:test';
import type { Citation, Passage } from '../api/types';
import { citationRange, passageSegments, selectedPassages } from './passages';

const passages: Passage[] = ['First 😀 passage', 'Middle marked text', 'Final passage'].map((text, ordinal) => ({
  id: `p${ordinal}`, ordinal, text, kind: 'paragraph', level: null, locator: `chapter#${ordinal}`, anchor: null, resource: null, marks: [], start: 0,
}));
const citation: Citation = { id: 'c1', block_id: 'block', source_id: 'source', snapshot_id: 'snapshot', start: { passage_id: 'p0', offset: 6 }, end: { passage_id: 'p2', offset: 5 }, quote: '😀 passage\n\nMiddle marked text\n\nFinal', locator: 'chapter#0', ordinal: 0 };

describe('reader selection', () => {
  test('normalizes backwards cross-passage selections and UTF-16 offsets', () => {
    expect(selectedPassages(citation.end, citation.start, [...passages].reverse())).toEqual({ start: citation.start, end: citation.end, first: 0, last: 2, quote: citation.quote, locator: citation.locator });
  });
  test('slices both offsets in a single passage', () => {
    expect(selectedPassages({ passage_id: 'p0', offset: 8 }, { passage_id: 'p0', offset: 6 }, passages)?.quote).toBe('😀');
  });
  test('retains paragraph separators even at passage boundaries', () => {
    expect(selectedPassages({ passage_id: 'p0', offset: passages[0]!.text.length }, { passage_id: 'p1', offset: 0 }, passages)?.quote).toBe('\n\n');
  });
  test('rejects collapsed, missing, invalid and incomplete selections', () => {
    expect(selectedPassages(citation.start, citation.start, passages)).toBeNull();
    expect(selectedPassages(citation.start, { passage_id: 'missing', offset: 0 }, passages)).toBeNull();
    expect(selectedPassages(citation.start, { passage_id: 'p0', offset: 500 }, passages)).toBeNull();
    expect(selectedPassages(citation.start, citation.end, [passages[0]!, passages[2]!])).toBeNull();
  });
});

describe('reader highlight ranges', () => {
  const ordinals = new Map(passages.map(passage => [passage.id, passage.ordinal]));
  test('clips multi-passage endpoints and covers the middle', () => {
    expect(passages.map(passage => { const range = citationRange(passage, citation, ordinals)!; return [range.start, range.end]; })).toEqual([[6, 16], [0, 18], [0, 5]]);
    expect(citationRange(passages[0]!, citation, new Map())).toBeNull();
    expect(citationRange({ ...passages[0]!, ordinal: 3 }, citation, ordinals)).toBeNull();
  });
  test('does not duplicate text when mark and tint ranges cross', () => {
    const passage: Passage = { ...passages[0]!, marks: [{ start: 0, end: 8, kind: { kind: 'strong' } }, { start: 7, end: 12, kind: { kind: 'emphasis' } }] };
    const segments = passageSegments(passage, [citationRange(passage, citation, ordinals)!], citation.id);
    expect(segments.map(segment => segment.text).join('')).toBe(passage.text);
    expect(segments.map(segment => [segment.start, segment.end])).toEqual([[0, 6], [6, 7], [7, 8], [8, 12], [12, 16]]);
    expect(segments[2]!.marks.map(mark => mark.kind.kind)).toEqual(['strong', 'emphasis']);
    expect(segments.filter(segment => segment.flash).map(segment => segment.text).join('')).toBe('😀 passage');
  });
  test('keeps overlapping citation identities and ignores empty ranges', () => {
    const other = { ...citation, id: 'c2', start: { passage_id: 'p0', offset: 8 }, end: { passage_id: 'p0', offset: 12 } };
    const ranges = [citationRange(passages[0]!, citation, ordinals)!, citationRange(passages[0]!, other, ordinals)!];
    expect(passageSegments(passages[0]!, ranges, null).find(segment => segment.start === 8)?.citations.map(value => value.id)).toEqual(['c1', 'c2']);
    expect(citationRange(passages[0]!, { ...citation, end: citation.start }, ordinals)).toBeNull();
  });
});
