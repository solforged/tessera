import { describe, expect, test } from 'bun:test';
import { linkMentionEdit } from './link-mention';

const page = '01K11111111111111111111111';
function linked(text: string, term: string): string | null {
  const edit = linkMentionEdit('source', text, page, term);
  if (!edit || edit.kind !== 'replaceRange') return null;
  return text.slice(0, edit.range.anchor.offset) + edit.text + text.slice(edit.range.head.offset);
}

describe('linking an unlinked mention', () => {
  test('links the first whole-word occurrence and retains authored case', () => {
    expect(linked('Planets _Planet Planet2 (pLaNeT), Planet.', 'Planet')).toBe(`Planets _Planet Planet2 ([[${page}|pLaNeT]]), Planet.`);
  });
  test('does not link inside references or either tag spelling', () => {
    expect(linked('[[Planet]] [[other|Planet]] #Planet #[[Planet]] Planet', 'Planet')).toBe(`[[Planet]] [[other|Planet]] #Planet #[[Planet]] [[${page}|Planet]]`);
    expect(linked('[[Planet]] #Planet #[[Planet]]', 'Planet')).toBeNull();
  });
  test('recognizes Unicode boundaries and multiword aliases literally', () => {
    expect(linked('Étherx xÉther éTHER', 'Éther')).toBe(`Étherx xÉther [[${page}|éTHER]]`);
    expect(linked('The A+B (C) reading', 'A+B (C)')).toBe(`The [[${page}|A+B (C)]] reading`);
    expect(linked('字Planet字 Planet', 'Planet')).toBe(`字Planet字 [[${page}|Planet]]`);
  });
  test('keeps UTF-16 offsets correct after astral characters', () => {
    const edit = linkMentionEdit('source', '𐐀 Planet', page, 'Planet');
    expect(edit).toMatchObject({ range: { anchor: { id: 'source', offset: 3 }, head: { id: 'source', offset: 9 } } });
  });
  test('does not change absent or empty mentions', () => {
    expect(linked('A quiet block', 'Planet')).toBeNull();
    expect(linked('A quiet block', '')).toBeNull();
  });
});
