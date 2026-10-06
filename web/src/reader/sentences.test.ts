import { describe, expect, test } from 'bun:test';
import type { Passage } from '../api/types';
import { extendSelection, sentenceAt, sentenceRanges, shrinkSelection } from './sentences';
import type { SentenceSelection } from './sentences';

const passages: Passage[] = ['One sentence. Two sentences! Three sentences?', '  ', '', 'Next 😀 sentence. Last sentence.'].map((text, ordinal) => ({
  id: `p${ordinal}`, ordinal, text, kind: 'paragraph', level: null, locator: `chapter#${ordinal}`, anchor: null, resource: null, marks: [], start: 0,
}));
const first: SentenceSelection = { start: { passage_id: 'p0', offset: 0 }, end: { passage_id: 'p0', offset: 13 } };

describe('reader sentences', () => {
  test('keeps abbreviations inside the sentence when the segmenter does', () => {
    const text = 'We use e.g. this example. Another sentence follows.';
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)];
    expect(segments[0]!.segment).toContain('e.g. this example.');
    expect(sentenceRanges(text).map(range => text.slice(range.start, range.end))).toEqual(segments.map(segment => segment.segment.trim()));
  });
  test('excludes surrounding and trailing whitespace', () => {
    const text = '  First sentence. \n Second sentence!\t ';
    expect(sentenceRanges(text)).toEqual([{ start: 2, end: 17 }, { start: 20, end: 36 }]);
    expect(sentenceRanges(' \n\t ')).toEqual([]);
  });
  test('finds a sentence at UTF-16 offsets and chooses the next sentence in a gap', () => {
    const text = passages[3]!.text;
    expect(sentenceAt(text, 6)).toEqual({ start: 0, end: 17 });
    expect(sentenceAt(text, 17)).toEqual({ start: 18, end: text.length });
    expect(sentenceAt(text, text.length)).toEqual({ start: 18, end: text.length });
    expect(sentenceAt('', 0)).toBeNull();
    expect(sentenceAt(text, -1)).toBeNull();
    expect(sentenceAt(text, text.length + 1)).toBeNull();
  });
  test('falls back to punctuation followed by whitespace or the end', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    try {
      const text = '  One.two! Three? Four… Five. Last  ';
      expect(sentenceRanges(text).map(range => text.slice(range.start, range.end))).toEqual(['One.two!', 'Three?', 'Four…', 'Five.', 'Last']);
    } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
  });
});

describe('reader sentence selection', () => {
  test('extends the end by one sentence without moving the start', () => {
    const second = extendSelection(first, passages);
    expect(second).toEqual({ start: first.start, end: { passage_id: 'p0', offset: 28 } });
    expect(extendSelection(second, passages).end).toEqual({ passage_id: 'p0', offset: passages[0]!.text.length });
  });
  test('extends across a passage boundary to the next first sentence and skips empty passages', () => {
    const selection = { ...first, end: { passage_id: 'p0', offset: passages[0]!.text.length } };
    expect(extendSelection(selection, passages)).toEqual({ start: first.start, end: { passage_id: 'p3', offset: 17 } });
  });
  test('shrinks across passage boundaries and skips empty passages', () => {
    const selection = { ...first, end: { passage_id: 'p3', offset: 17 } };
    expect(shrinkSelection(selection, passages)).toEqual({ start: first.start, end: { passage_id: 'p0', offset: passages[0]!.text.length } });
    expect(shrinkSelection(extendSelection(first, passages), passages)).toEqual(first);
  });
  test('does not shrink below one sentence', () => {
    expect(shrinkSelection(first, passages)).toBe(first);
    const partial = { ...first, start: { passage_id: 'p0', offset: 4 }, end: { passage_id: 'p0', offset: 8 } };
    expect(shrinkSelection(partial, passages)).toBe(partial);
    expect(shrinkSelection(first, passages, 'passage')).toBe(first);
  });
  test('completes a partially selected sentence before extending to the next', () => {
    const partial = { ...first, end: { passage_id: 'p0', offset: 5 } };
    expect(extendSelection(partial, passages)).toEqual(first);
  });
  test('extends and shrinks by whole passages while preserving a minimum sentence', () => {
    const whole = extendSelection(first, passages, 'passage');
    expect(whole.end).toEqual({ passage_id: 'p0', offset: passages[0]!.text.length });
    const next = extendSelection(whole, passages, 'passage');
    expect(next.end).toEqual({ passage_id: 'p3', offset: passages[3]!.text.length });
    expect(shrinkSelection(next, passages, 'passage')).toEqual(whole);
    expect(shrinkSelection(whole, passages, 'passage')).toEqual(first);
  });
  test('does not extend beyond the end of the source', () => {
    const selection = { ...first, end: { passage_id: 'p3', offset: passages[3]!.text.length } };
    expect(extendSelection(selection, passages)).toBe(selection);
    expect(extendSelection(selection, passages, 'passage')).toBe(selection);
  });
  test('keeps the sentence containing a mid-passage start when shrinking a passage', () => {
    const selection = { start: { passage_id: 'p0', offset: 14 }, end: { passage_id: 'p0', offset: passages[0]!.text.length } };
    expect(shrinkSelection(selection, passages, 'passage')).toEqual({ start: selection.start, end: { passage_id: 'p0', offset: 28 } });
  });
  test('leaves missing passage endpoints unchanged', () => {
    const missing = { ...first, end: { passage_id: 'missing', offset: 10 } };
    expect(extendSelection(missing, passages)).toBe(missing);
    expect(shrinkSelection(missing, passages)).toBe(missing);
  });
});
