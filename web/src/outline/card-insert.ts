import { cardMarks, parseCardText } from '../review/card-text';
import { insideProtectedSyntax } from '../tasks/quick-date';
import { nextClozeNumber } from './slash';

export type InsertCardKind = 'forward' | 'reverse' | 'both' | 'multiline' | 'list' | 'descriptor' | 'cloze';
export interface CardInsertion { text: string; caret: number }

/** Includes unfinished operators, but not literal operators in code, references or cloze answers. */
export function hasCardOperator(text: string): boolean {
  const clozes = cardMarks(text).filter(mark => mark.kind === 'cloze');
  for (const match of text.matchAll(/>>|<<|<>|;;/g)) {
    const at = match.index;
    let escapes = 0;
    for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) escapes++;
    if (escapes % 2 || insideProtectedSyntax(text, at) || clozes.some(mark => at >= mark.start && at < mark.end)) continue;
    return true;
  }
  return false;
}

/** Slash commands pass the whole block after removing their query. */
export function insertCard(text: string, kind: InsertCardKind, at = text.length): CardInsertion {
  if (hasCardOperator(text)) return { text, caret: text.length };
  if (kind === 'cloze') {
    const cloze = `{{c${nextClozeNumber(text)}::}}`;
    return { text: text.slice(0, at) + cloze + text.slice(at), caret: at + cloze.length - 2 };
  }
  // Do not turn an existing cloze card into mixed syntax either.
  if (cardMarks(text).some(mark => mark.kind === 'cloze')) return { text, caret: text.length };
  const operator = { forward: '>> ', reverse: '<< ', both: '<> ', multiline: '>>>', list: '>>1.', descriptor: ';; ' }[kind];
  const front = text.trimEnd();
  const next = `${front} ${operator}`;
  return { text: next, caret: front ? next.length : 0 };
}

/** Wrap one plain-text selection, preserving its surrounding whitespace. */
export function makeCloze(text: string, from: number, to = from): CardInsertion | { reason: string } {
  if (hasCardOperator(text)) return { reason: 'This atom already has a card operator.' };
  const overlaps = (start: number, end: number) => from === to ? from > start && from < end : from < end && to > start;
  if (cardMarks(text).some(mark => mark.kind === 'cloze' && overlaps(mark.start, mark.end))
    || parseCardText(text).problems.some(problem => overlaps(problem.start, problem.end))) {
    return { reason: 'Keep existing clozes outside the selection.' };
  }
  // Test the selected span, not just its endpoints: a selection can enclose an entire code/reference token.
  for (let at = from; at <= to; at++) {
    if (insideProtectedSyntax(text + ' ', at)) return { reason: 'Keep references and code outside the selection.' };
  }
  if (from === to) return insertCard(text, 'cloze', from);
  const selected = text.slice(from, to);
  const answer = selected.trim();
  if (!answer) return { reason: 'Select text for the cloze.' };
  from += selected.length - selected.trimStart().length;
  to = from + answer.length;
  const cloze = `{{c${nextClozeNumber(text)}::${answer}}}`;
  return { text: text.slice(0, from) + cloze + text.slice(to), caret: from + cloze.length };
}
