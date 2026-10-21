// Keep these boundaries aligned with storage::{tag_tokens, inline_code_spans}.
const tagCharacter = /[\p{Alphabetic}\p{N}\p{M}_/-]/u;
const whitespace = /\p{White_Space}+/gu;
const trimWhitespace = /^\p{White_Space}+|\p{White_Space}+$/gu;
const urlStart = /^https?:\/\//i;

/** Matching backtick runs shield tags; backticks inside links and URLs do not open code. */
function* codeSpans(text: string): Generator<[number, number]> {
  let cursor = 0;
  while (cursor < text.length) {
    if (text.startsWith('[[', cursor) && text.indexOf(']]', cursor) >= 0) {
      let depth = 1;
      cursor += 2;
      while (cursor < text.length && depth) {
        if (text.startsWith('[[', cursor)) { depth++; cursor += 2; }
        else if (text.startsWith(']]', cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      continue;
    }
    const rest = text.slice(cursor);
    const labelEnd = rest.indexOf('](');
    if (rest.startsWith('[') && !rest.startsWith('[[') && labelEnd > 1
      && !/[\[\]\r\n]/.test(rest.slice(1, labelEnd)) && urlStart.test(rest.slice(labelEnd + 2))) {
      cursor += labelEnd + 2;
      let depth = 0;
      while (cursor < text.length && !/[\p{White_Space}<>"']/u.test(text[cursor]!)) {
        const character = text[cursor++]!;
        if (character === '(') depth++;
        else if (character === ')') { if (!depth) break; depth--; }
      }
      continue;
    }
    if (urlStart.test(rest)) {
      const end = rest.search(/[\p{White_Space}<>"']/u);
      cursor += end < 0 ? rest.length : end;
      continue;
    }
    if (text[cursor] === '`') {
      const start = cursor;
      while (text[cursor] === '`') cursor++;
      const width = cursor - start;
      let close = cursor;
      while ((close = text.indexOf('`', close)) >= 0) {
        const from = close;
        while (text[close] === '`') close++;
        if (close - from === width) { cursor = close; yield [start, close]; break; }
      }
      continue;
    }
    cursor++;
  }
}

/** Tag spans independent of reference rendering, just as the core derives memberships. */
function* tagSpans(text: string): Generator<[number, number]> {
  const code = codeSpans(text);
  let shield = code.next();
  let cursor = 0;
  while ((cursor = text.indexOf('#', cursor)) >= 0) {
    const start = cursor++;
    let protectedTag = false;
    while (!shield.done && shield.value[0] <= start) {
      const end = shield.value[1];
      shield = code.next();
      if (start < end) { cursor = end; protectedTag = true; break; }
    }
    if (protectedTag || /[\p{Alphabetic}\p{N}\p{M}_/-]$/u.test(text.slice(0, start))) continue;
    if (text.startsWith('[[', cursor)) {
      const end = text.indexOf(']]', cursor + 2);
      if (end < 0) continue;
      const value = text.slice(cursor + 2, end);
      cursor = end + 2;
      const canonical = /^([0-7][0-9A-HJKMNP-TV-Z]{25})\|([\s\S]*)$/.exec(value);
      if (canonical ? !/[\[\]|\r\n]/.test(canonical[2]!)
        : !!value.replace(trimWhitespace, '') && !/[\[\]]/.test(value)) yield [start, cursor];
      continue;
    }
    for (const character of text.slice(cursor)) {
      if (!tagCharacter.test(character)) break;
      cursor += character.length;
    }
    if (cursor > start + 1) yield [start, cursor];
  }
}

/** Page identity drops tags and collapses their surrounding whitespace. Untagged and tag-only titles stay verbatim. */
export function identityName(text: string): string {
  if (!text.includes('#')) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of tagSpans(text)) {
    parts.push(text.slice(cursor, start));
    cursor = end;
  }
  if (!cursor) return text;
  parts.push(text.slice(cursor));
  return parts.join(' ').replace(whitespace, ' ').replace(trimWhitespace, '') || text;
}
