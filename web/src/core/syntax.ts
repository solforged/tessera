// Consume whole escaped syntax tokens. Even runs of backslashes leave the
// following syntax active; unknown escapes keep their backslash in shown text.
export function escapeEnd(text: string, at: number): number | null {
  if (text[at] !== '\\') return null;
  const token = ['>>1.', '>>>', '>>', '<<', '<>', ';;', '{{', '}}', '::', '[[', ']]'].find(token =>
    text.startsWith(token, at + 1),
  );
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

/**
 * Preserve code and reference markup verbatim. In `'typing'` mode, unclosed spans shield the remainder while the
 * author is typing; in `'stored'` mode, unclosed inline backticks and references leave later tokens active.
 */
export function protectedEnd(text: string, at: number, purpose: 'typing' | 'stored' = 'typing'): number | null {
  if (text.startsWith('[[', at)) {
    let cursor = at + 2;
    while (cursor < text.length) {
      const escaped = escapeEnd(text, cursor);
      if (escaped !== null) cursor = escaped;
      else if (text.startsWith(']]', cursor)) return cursor + 2;
      else cursor++;
    }
    return purpose === 'typing' ? text.length : null;
  }
  const marker = text[at];
  if (marker !== '`' && marker !== '~') return null;
  const fenceStart = linePrefix(text, at);
  if (marker === '~' && !fenceStart) return null;
  const openingEnd = runEnd(text, at, marker);
  const count = openingEnd - at;
  let openingLineEnd: number | null = null;
  let hasNewline = false;
  if (count >= 3 && fenceStart) {
    const newline = text.indexOf('\n', openingEnd);
    hasNewline = newline >= 0;
    openingLineEnd = hasNewline ? newline : text.length;
  }
  // Backtick fence info cannot contain backticks. Same-line triple-backtick
  // spans are inline code, with active syntax after their closing delimiter.
  if (
    openingLineEnd !== null &&
    (purpose === 'typing' || hasNewline) &&
    (marker === '~' || !text.slice(openingEnd, openingLineEnd).includes('`'))
  ) {
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
    if (start < 0) return purpose === 'typing' ? text.length : null;
    cursor = runEnd(text, start, '`');
    if (cursor - start === count) return cursor;
  }
}

/** Typing guards include open code and reference drafts; stored text shields only matched inline spans and fences. */
export function insideProtectedSyntax(text: string, at: number, purpose: 'typing' | 'stored' = 'typing'): boolean {
  for (let cursor = 0; cursor < at; ) {
    if (text[cursor] === '\\') {
      cursor = escapeEnd(text, cursor) ?? Math.min(text.length, cursor + 2);
      continue;
    }
    const end = protectedEnd(text, cursor, purpose);
    if (end !== null) {
      if (end > at) return true;
      cursor = end;
      continue;
    }
    cursor++;
  }
  return false;
}
