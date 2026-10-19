import type { CardKind, CardUnit, ImageRef, Occlusion, OcclusionMask, Rect } from '../api/types';

export interface ParsedCard { key: string; kind: CardKind; front: string; back: string }
export interface CardProblem { message: string; start: number; end: number }
export interface CardParse { cards: ParsedCard[]; problems: CardProblem[] }

interface Cloze { start: number; end: number; id: string; answerStart: number; answerEnd: number; hintStart: number | null }

export type CardOperator = '>>' | '<<' | '<>' | '>>>' | '>>1.' | ';;';
/** How an operator reads wherever authored text is shown rather than edited. */
export const cardOperators: Record<CardOperator, { label: string; text: string }> = { '>>': { label: 'then', text: '→' }, '<<': { label: 'from', text: '←' }, '<>': { label: 'both ways', text: '↔' }, '>>>': { label: 'child answer', text: '↓' }, '>>1.': { label: 'list answer', text: '↓1.' }, ';;': { label: 'descriptor', text: '›' } };
export type CardMark =
  | { kind: 'operator'; start: number; end: number; op: CardOperator }
  | ({ kind: 'cloze'; hintEnd: number | null } & Cloze);

function operator(text: string, at: number): CardOperator | undefined {
  return (['>>1.', '>>>', '>>', '<<', '<>', ';;'] as const).find(token => text.startsWith(token, at));
}

function problem(message: string, start: number, end: number): CardProblem { return { message, start, end }; }

// Consume whole escaped syntax tokens. Even runs of backslashes leave the
// following syntax active; unknown escapes keep their backslash in shown text.
function escapeEnd(text: string, at: number): number | null {
  if (text[at] !== '\\') return null;
  const token = ['>>1.', '>>>', '>>', '<<', '<>', ';;', '{{', '}}', '::', '[[', ']]'].find(token => text.startsWith(token, at + 1));
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
export function protectedEnd(text: string, at: number): number | null {
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
  if (!/>>|<<|<>|;;|\{\{/.test(text)) return { parse: { cards: [], problems: [] }, pieces: [], suffix: text, marks: [] };
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
    if (operators.length > 1) result.problems.push(problem('Use only one card operator per atom.', first, last + operator(text, last)!.length));
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
      else if (right) result.problems.push(problem('Child-answer operators must end the atom.', first, text.length));
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
    if (op === ';;') result.cards.push({ key: 'descriptor', kind: 'descriptor', front: left, back: right });
    else {
      if (op !== '<<') result.cards.push({ key: 'forward', kind: 'forward', front: left, back: right });
      if (op !== '>>') result.cards.push({ key: 'reverse', kind: 'reverse', front: right, back: left });
    }
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

/** Compose one forward card without letting either field add another card operator. */
export function forwardCardText(front: string, back: string): string {
  const text = `${front.trim()} >> ${back.trim()}`;
  const parsed = parseCardText(text);
  if (parsed.problems.length) throw new Error(parsed.problems[0]!.message);
  const marks = cardMarks(text);
  if (parsed.cards.length !== 1 || parsed.cards[0]!.kind !== 'forward' || marks.length !== 1 || marks[0]!.start !== front.trim().length + 1) {
    throw new Error('Write one question and answer. Keep card operators inside code or escape them with a backslash.');
  }
  return text;
}

/** Valid card syntax, using the same shielding and UTF-16 ranges as derivation. */
export function cardMarks(text: string): CardMark[] {
  return derive(text).marks;
}

/** The text a child descriptor names as its subject: the authored left side of
 * an operator, the full answer of a cloze, otherwise the whole literal text. */
export function cardSubject(text: string): string {
  const card = parseCardText(text).cards[0];
  if (!card) return trim(literal(text, 0, text.length));
  return card.kind === 'reverse' || card.kind === 'cloze' ? card.back : card.front;
}

const kindLabels: Record<CardKind, string> = { forward: 'Forward', reverse: 'Reverse', cloze: 'Cloze', multiline: 'Multi-line', list: 'List', descriptor: 'Descriptor', occlusion: 'OCCLUSION' };

/** A card's kind as review and the outline name it. A cloze carries its number
 * only when its block makes several clozes. */
export function cardKindLabel(card: { kind: CardKind; key: string; occlusion_index?: number }, siblings: readonly { kind: CardKind; key?: string }[]): string {
  if (card.kind === 'occlusion') {
    const groups = siblings.filter(sibling => sibling.kind === 'occlusion');
    const index = card.occlusion_index ?? groups.findIndex(group => group.key === card.key);
    return groups.length > 1 ? `OCCLUSION ${index + 1}` : 'OCCLUSION';
  }
  if (card.kind !== 'cloze' || siblings.filter(sibling => sibling.kind === 'cloze').length < 2) return kindLabels[card.kind];
  return `Cloze ${card.key.slice('cloze:c'.length)}`;
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

export type CardMask = Pick<OcclusionMask, 'shape' | 'x' | 'y' | 'w' | 'h'>;
export interface OcclusionFront { image: ImageRef; mode: Occlusion['mode']; area?: Rect; tested: CardMask[]; hint?: string; covered: CardMask[] }
export interface OcclusionSides { front: OcclusionFront; back: { answer?: string } }
const validRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Rect;
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.w >= .005 && rect.h >= .005 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1;
};
/** Stored evidence can outlive client versions; malformed sides never escape into prose or throw. */
export function occlusionSides(card: { front: string; back: string }): OcclusionSides | null {
  try {
    const front = JSON.parse(card.front) as OcclusionFront, back = JSON.parse(card.back) as OcclusionSides['back'];
    const masks = (value: unknown): value is CardMask[] => Array.isArray(value) && value.every(mask => validRect(mask) && 'shape' in mask && (mask.shape === 'rect' || mask.shape === 'ellipse'));
    if (!front || !back || typeof back !== 'object' || !front.image || !/^[a-f0-9]{64}$/.test(front.image.sha256) || typeof front.image.media_type !== 'string'
      || !Number.isFinite(front.image.width) || front.image.width <= 0 || !Number.isFinite(front.image.height) || front.image.height <= 0
      || !['hide_one', 'hide_all'].includes(front.mode) || !masks(front.tested) || !masks(front.covered)
      || front.area !== undefined && !validRect(front.area) || front.hint !== undefined && typeof front.hint !== 'string'
      || back.answer !== undefined && typeof back.answer !== 'string') return null;
    return { front, back };
  } catch { return null; }
}
export function groupLetter(index: number): string {
  let result = '';
  do { result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26) - 1; } while (index >= 0);
  return result;
}
export function occlusionSubject(card: Pick<CardUnit, 'front' | 'back' | 'occlusion_index'>): string {
  return occlusionSides(card)?.back.answer ?? `Mask ${groupLetter(card.occlusion_index ?? 0)}`;
}
export function occlusionCards(image: ImageRef | null | undefined, state: Occlusion | null | undefined): ParsedCard[] {
  if (!image || !state) return [];
  const geometry = ({ shape, x, y, w, h }: OcclusionMask): CardMask => ({ shape, x, y, w, h });
  return state.groups.map(group => ({ key: `occlusion:${group.id}`, kind: 'occlusion', front: JSON.stringify({
    image, mode: state.mode, ...(group.area ? { area: group.area } : {}), tested: state.masks.filter(mask => mask.group === group.id).map(geometry),
    ...(group.hint ? { hint: group.hint } : {}), covered: state.mode === 'hide_all' ? state.masks.filter(mask => mask.group !== group.id).map(geometry) : [],
  }), back: JSON.stringify(group.answer ? { answer: group.answer } : {}) }));
}
