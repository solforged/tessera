import type { Passage, PassagePoint } from '../api/types';

export interface SentenceRange { start: number; end: number }
export interface SentenceSelection { start: PassagePoint; end: PassagePoint }
export type SelectionUnit = 'sentence' | 'passage';

let segmenter: Intl.Segmenter | undefined;

/** Sentence endpoints use UTF-16 offsets, like passage text and DOM selections. */
export function sentenceRanges(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  const append = (start: number, end: number) => {
    const value = text.slice(start, end), trimmed = value.trim();
    if (trimmed) {
      start += value.length - value.trimStart().length;
      ranges.push({ start, end: start + trimmed.length });
    }
  };
  if (typeof Intl.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'sentence' });
    for (const part of segmenter.segment(text)) append(part.index, part.index + part.segment.length);
  } else {
    let start = 0;
    for (const match of text.matchAll(/[.!?…](?=\s|$)/gu)) {
      const end = match.index + match[0].length;
      append(start, end);
      start = end;
    }
    append(start, text.length);
  }
  return ranges;
}

/** Whitespace between sentences belongs to the following sentence. */
export function sentenceAt(text: string, offset: number): SentenceRange | null {
  if (offset < 0 || offset > text.length) return null;
  const ranges = sentenceRanges(text);
  return ranges.find(range => offset < range.end) ?? ranges.at(-1) ?? null;
}

const CONTEXT_LENGTH = 160;

/** The sentence, or the start of one, that leads into a quotation; long ones keep their end. */
export function leadIn(text: string): string {
  const range = sentenceRanges(text).at(-1);
  if (!range) return '';
  const value = text.slice(range.start, range.end);
  return value.length > CONTEXT_LENGTH ? `…${value.slice(-CONTEXT_LENGTH).replace(/^\S*\s+/u, '')}` : value;
}

/** The rest of the sentence after a quotation, or the next one; long ones keep their start. */
export function followOn(text: string): string {
  const range = sentenceRanges(text)[0];
  if (!range) return '';
  const value = text.slice(range.start, range.end);
  return value.length > CONTEXT_LENGTH ? `${value.slice(0, CONTEXT_LENGTH).replace(/\s+\S*$/u, '')}…` : value;
}

/** Complete the current unit, or add the next nonempty unit at its boundary. */
export function extendSelection(selection: SentenceSelection, passages: readonly Passage[], unit: SelectionUnit = 'sentence'): SentenceSelection {
  const last = passages.findIndex(passage => passage.id === selection.end.passage_id);
  if (last < 0) return selection;
  for (let index = last; index < passages.length; index++) {
    const passage = passages[index]!, ranges = sentenceRanges(passage.text);
    const candidates = unit === 'sentence' ? ranges : ranges.slice(-1);
    const next = candidates.find(range => index > last || range.end > selection.end.offset);
    if (next) return { start: selection.start, end: { passage_id: passage.id, offset: next.end } };
  }
  return selection;
}

/** Keep at least the sentence containing the selection's start. */
export function shrinkSelection(selection: SentenceSelection, passages: readonly Passage[], unit: SelectionUnit = 'sentence'): SentenceSelection {
  const first = passages.findIndex(passage => passage.id === selection.start.passage_id);
  const last = passages.findIndex(passage => passage.id === selection.end.passage_id);
  if (first < 0 || last < first) return selection;
  const minimum = sentenceAt(passages[first]!.text, selection.start.offset);
  if (!minimum) return selection;
  for (let index = last; index >= first; index--) {
    const passage = passages[index]!, ranges = sentenceRanges(passage.text);
    const candidates = unit === 'sentence' ? ranges : ranges.slice(-1);
    for (let at = candidates.length - 1; at >= 0; at--) {
      const end = candidates[at]!.end;
      if (index === last && end >= selection.end.offset) continue;
      if (index === first && end < minimum.end) break;
      return { start: selection.start, end: { passage_id: passage.id, offset: end } };
    }
  }
  return first < last || minimum.end < selection.end.offset
    ? { start: selection.start, end: { passage_id: selection.start.passage_id, offset: minimum.end } }
    : selection;
}
