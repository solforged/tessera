import type { CardKind } from '../api/types';

export interface ParsedCard { key: string; kind: CardKind; front: string; back: string }
export interface CardProblem { message: string; start: number; end: number }
export interface CardParse { cards: ParsedCard[]; problems: CardProblem[] }

interface Cloze { start: number; end: number; id: string; answerStart: number; answerEnd: number; hintStart: number | null }

type CardOperator = '>>' | '<<' | '<>' | '>>>' | '>>1.';
export type CardMark =
  | { kind: 'operator'; start: number; end: number; op: CardOperator }
  | ({ kind: 'cloze'; hintEnd: number | null } & Cloze);

function operator(text: string, at: number): CardOperator | undefined {
  return (['>>1.', '>>>', '>>', '<<', '<>'] as const).find(token => text.startsWith(token, at));
}

function problem(message: string, start: number, end: number): CardProblem { return { message, start, end }; }

// Consume whole escaped syntax tokens. Even runs of backslashes leave the
// following syntax active; unknown escapes keep their backslash in shown text.
function escapeEnd(text: string, at: number): number | null {
  if (text[at] !== '\\') return null;
  const token = ['>>1.', '>>>', '>>', '<<', '<>', '{{', '}}', '::', '[[', ']]'].find(token => text.startsWith(token, at + 1));
  if (token) return at + 1 + token.length;
  if (text[at + 1] !== undefined && '\\`~[]{}<>:'.includes(text[at + 1]!)) return at + 2;
  return null;
}

function runEnd(text: string, at: number, marker: string): number {
  let end = at;
  while (text[end] === marker) end++;
  return end;
}
function linePrefix(text: string, at: number): boolean {
  for (let offset = 0; offset < 4 && offset < at; offset++) {
    const ch = text[at - offset - 1];
    if (ch === '\n') return true;
    if (ch !== ' ' || offset === 3) return false;
  }
  return true;
}

// Preserve code/reference markup verbatim. Unclosed spans shield the remainder
// while the author is typing, rather than deriving accidental cards inside it.
function protectedEnd(text: string, at: number): number | null {
  if (text.startsWith('[[', at)) {
    let cursor = at + 2;
    while (cursor < text.length) {
      const escaped = escapeEnd(text, cursor);
      if (escaped !== null) cursor = escaped;
      else if (text.startsWith(']]', cursor)) return cursor + 2;
      else cursor++;
    }
    return text.length;
  }
  const marker = text[at];
  if (marker !== '`' && marker !== '~') return null;
  const fenceStart = linePrefix(text, at);
  if (marker === '~' && !fenceStart) return null;
  const openingEnd = runEnd(text, at, marker);
  const count = openingEnd - at;
  let openingLineEnd: number | null = null;
  if (count >= 3 && fenceStart) {
    const newline = text.indexOf('\n', openingEnd);
    openingLineEnd = newline < 0 ? text.length : newline;
  }
  // Backtick fence info cannot contain backticks. Same-line triple-backtick
  // spans are inline code, with active syntax after their closing delimiter.
  if (openingLineEnd !== null && (marker === '~' || !text.slice(openingEnd, openingLineEnd).includes('`'))) {
    let line = Math.min(openingLineEnd + 1, text.length);
    while (line < text.length) {
      const next = text.indexOf('\n', line);
      const end = next < 0 ? text.length : next;
      let first = line;
      while (first < end && first - line < 3 && text[first] === ' ') first++;
      const closingEnd = runEnd(text, first, marker);
      if (closingEnd - first >= count && /^[ \t\r]*$/.test(text.slice(closingEnd, end))) return end;
      line = end + 1;
    }
    return text.length;
  }
  if (marker === '~') return null;
  let cursor = openingEnd;
  for (;;) {
    const start = text.indexOf('`', cursor);
    if (start < 0) return text.length;
    cursor = runEnd(text, start, '`');
    if (cursor - start === count) return cursor;
  }
}

// JS trim includes BOM and excludes NEL; Rust uses Unicode White_Space.
function trim(text: string): string { return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''); }

function literal(text: string, start: number, end: number): string {
  const pieces: string[] = [];
  let copied = start;
  let cursor = start;
  while (cursor < end) {
    const escaped = escapeEnd(text, cursor);
    if (escaped !== null) {
      pieces.push(text.slice(copied, cursor), text.slice(cursor + 1, escaped));
      copied = escaped;
      cursor = escaped;
    } else {
      cursor = protectedEnd(text, cursor) ?? cursor + 1;
    }
  }
  pieces.push(text.slice(copied, end));
  return pieces.join('');
}

function cloze(text: string, start: number): { end: number; cloze?: Cloze; problem?: CardProblem } {
  let cursor = start + 2;
  let depth = 1;
  let nested = false;
  let firstSeparator: number | null = null;
  let secondSeparator: number | null = null;
  let extraSeparator = false;
  while (cursor < text.length) {
    const skipped = escapeEnd(text, cursor) ?? protectedEnd(text, cursor);
    if (skipped !== null) {
      cursor = skipped;
    } else if (text.startsWith('{{', cursor)) {
      nested = true;
      depth++;
      cursor += 2;
    } else if (text.startsWith('}}', cursor)) {
      depth--;
      if (depth !== 0) { cursor += 2; continue; }
      const end = cursor + 2;
      const invalid = (message: string) => ({ end, problem: problem(message, start, end) });
      if (nested) return invalid('Clozes cannot be nested.');
      if (firstSeparator === null) return invalid('Use {{c1::answer}} for a cloze.');
      const header = text.slice(start + 2, firstSeparator);
      const digits = header.startsWith('c') ? header.slice(1) : '';
      const id = digits.replace(/^0+/, '');
      if (!id || !/^[0-9]+$/.test(digits)) return invalid('Cloze IDs must be positive numbers.');
      if (extraSeparator) return invalid('A cloze can have only one hint.');
      const answerStart = firstSeparator + 2;
      const answerEnd = secondSeparator ?? cursor;
      const hintStart = secondSeparator === null ? null : secondSeparator + 2;
      if (!trim(text.slice(answerStart, answerEnd))) return invalid('Cloze answers cannot be empty.');
      if (hintStart !== null && !trim(text.slice(hintStart, cursor))) return invalid('Cloze hints cannot be empty.');
      return { end, cloze: { start, end, id, answerStart, answerEnd, hintStart } };
    } else if (depth === 1 && text.startsWith('::', cursor)) {
      if (firstSeparator === null) firstSeparator = cursor;
      else if (secondSeparator === null) secondSeparator = cursor;
      else extraSeparator = true;
      cursor += 2;
    } else cursor++;
  }
  return { end: text.length, problem: problem('Close the cloze with }}.', start, text.length) };
}

interface ClozePiece { id: string; before: string; answer: string; hint: string | null }

function derive(text: string): { parse: CardParse; pieces: ClozePiece[]; suffix: string; marks: CardMark[] } {
  // Cards need an operator or a cloze opener; most blocks have neither, so skip the character walk.
  if (!/>>|<<|<>|\{\{/.test(text)) return { parse: { cards: [], problems: [] }, pieces: [], suffix: text, marks: [] };
  const result: CardParse = { cards: [], problems: [] };
  const operators: number[] = [];
  const clozes: Cloze[] = [];
  let firstCloze: number | null = null;
  let cursor = 0;
  while (cursor < text.length) {
    const skipped = escapeEnd(text, cursor) ?? protectedEnd(text, cursor);
    if (skipped !== null) cursor = skipped;
    else if (text.startsWith('{{', cursor)) {
      firstCloze ??= cursor;
      const parsed = cloze(text, cursor);
      if (parsed.cloze) clozes.push(parsed.cloze);
      if (parsed.problem) result.problems.push(parsed.problem);
      cursor = parsed.end;
    } else {
      const token = operator(text, cursor);
      if (token) operators.push(cursor);
      // Ordinary overlapping operators (<>>) remain ambiguous.
      cursor += token && token.length > 2 ? token.length : 1;
    }
  }
  const none = { parse: result, pieces: [], suffix: '', marks: [] };
  const first = operators[0];
  if (first !== undefined) {
    const last = operators[operators.length - 1]!;
    if (operators.length > 1) result.problems.push(problem('Use only one card operator per block.', first, last + operator(text, last)!.length));
    if (firstCloze !== null) result.problems.push(problem('Do not mix card operators and clozes.', Math.min(first, firstCloze), text.length));
  }
  result.problems.sort((a, b) => a.start - b.start || a.end - b.end);
  if (result.problems.length) return none;
  if (first !== undefined) {
    const op = operator(text, first)!;
    const left = trim(literal(text, 0, first));
    const right = trim(literal(text, first + op.length, text.length));
    if (op === '>>>' || op === '>>1.') {
      if (!left) result.problems.push(problem('The front of a card needs text.', first, first + op.length));
      else if (right) result.problems.push(problem('Child-answer operators must end the block.', first, text.length));
      else {
        const kind = op === '>>>' ? 'multiline' : 'list';
        result.cards.push({ key: kind, kind, front: left, back: '' });
        return { ...none, marks: [{ kind: 'operator', start: first, end: first + op.length, op }] };
      }
      return none;
    }
    if (!left || !right) {
      result.problems.push(problem('Both sides of a card need text.', first, first + 2));
      return none;
    }
    if (op !== '<<') result.cards.push({ key: 'forward', kind: 'forward', front: left, back: right });
    if (op !== '>>') result.cards.push({ key: 'reverse', kind: 'reverse', front: right, back: left });
    return { ...none, marks: [{ kind: 'operator', start: first, end: first + 2, op }] };
  }
  let previous = 0;
  const pieces = clozes.map(cloze => {
    const before = literal(text, previous, cloze.start);
    const answer = literal(text, cloze.answerStart, cloze.answerEnd);
    const hint = cloze.hintStart === null ? null : literal(text, cloze.hintStart, cloze.end - 2);
    previous = cloze.end;
    return { id: cloze.id, before, answer, hint };
  });
  const suffix = literal(text, previous, text.length);
  const back = trim(pieces.map(piece => piece.before + piece.answer).join('') + suffix);
  const seen = new Set<string>();
  for (const group of clozes) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    const front = trim(pieces.map(piece => piece.before + (piece.id === group.id ? piece.hint ?? '[…]' : piece.answer)).join('') + suffix);
    result.cards.push({ key: `cloze:c${group.id}`, kind: 'cloze', front, back });
  }
  return { parse: result, pieces, suffix, marks: clozes.map(cloze => ({ ...cloze, kind: 'cloze', hintEnd: cloze.hintStart === null ? null : cloze.end - 2 })) };
}

/** Offsets are UTF-16 indices for CodeMirror. Invalid explicit syntax produces
 * diagnostics and no cards; keys depend only on direction or authored cloze ID. */
export function parseCardText(text: string): CardParse {
  return derive(text).parse;
}

/** Valid card syntax, using the same shielding and UTF-16 ranges as derivation. */
export function cardMarks(text: string): CardMark[] {
  return derive(text).marks;
}

/** Plain text, or one of this card's gaps with its answer and optional hint. */
export type ClozeSegment = { text: string } | { answer: string; hint: string | null };

/** Lays out one cloze card from its source text, so review can mark the gaps
 * that the derived front and back flatten. Null when the source no longer
 * derives that card. Joining the segments reproduces the derived sides. */
export function clozeSegments(text: string, key: string): ClozeSegment[] | null {
  const { parse, pieces, suffix } = derive(text);
  if (!key.startsWith('cloze:') || !parse.cards.some(card => card.key === key)) return null;
  const id = key.slice('cloze:c'.length);
  const segments: ClozeSegment[] = [];
  let plain = '';
  for (const piece of pieces) {
    plain += piece.before;
    if (piece.id !== id) { plain += piece.answer; continue; }
    if (plain) segments.push({ text: plain });
    plain = '';
    segments.push({ answer: piece.answer, hint: piece.hint });
  }
  plain += suffix;
  if (plain) segments.push({ text: plain });
  // The derived sides are trimmed as a whole; trim the outer plain text to match.
  const head = segments[0];
  if (head && 'text' in head) head.text = head.text.replace(/^\p{White_Space}+/u, '');
  const tail = segments[segments.length - 1];
  if (tail && 'text' in tail) tail.text = tail.text.replace(/\p{White_Space}+$/u, '');
  return segments.filter(segment => !('text' in segment) || segment.text);
}
