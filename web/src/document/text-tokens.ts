export interface Token { start: number; end: number; kind: 'text' | 'reference' | 'tag' | 'url'; value: string; id?: string; alias?: string; locator?: string; targetKind?: 'view'; labelStart?: number }

export function isStableReference(token: Token): boolean {
  return token.kind === 'reference' && token.targetKind !== 'view' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(token.id ?? '');
}

export function isViewReference(token: Token): boolean {
  return token.kind === 'reference' && token.targetKind === 'view';
}

/** A whole-row canonical ULID, matching the service's quote target spelling. */
export function quoteTarget(text: string): string | null {
  return /^\(\(([0-7][0-9A-HJKMNP-TV-Z]{25})\)\)$/.exec(text.trim())?.[1] ?? null;
}

export function textTokens(text: string): Token[] {
  const result: Token[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(?<![\p{L}\p{M}\p{N}_])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{M}\p{N}_/-]+))|(https?:\/\/[^\s<>"']+)|(`+)|\[([^\[\]\r\n]+)\]\((?=https?:\/\/)/gu;
  let offset = 0;
  let ignoredUntil = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start < ignoredUntil) continue;
    if (match[6]) {
      const marker = match[6];
      let close = start + marker.length;
      for (;;) {
        close = text.indexOf(marker, close);
        if (close < 0) { ignoredUntil = text.length; break; }
        if (text[close - 1] !== '`' && text[close + marker.length] !== '`') { ignoredUntil = close + marker.length; break; }
        close += marker.length;
      }
      continue;
    }
    if (match[0].startsWith('[[') && match[0].includes('[[', 2)) {
      let depth = 1;
      let cursor = start + 2;
      while (cursor < text.length && depth) {
        if (text.startsWith('[[', cursor)) { depth++; cursor += 2; }
        else if (text.startsWith(']]', cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      ignoredUntil = cursor;
      continue;
    }
    if (match[7] !== undefined) {
      const urlStart = start + match[0].length;
      let cursor = urlStart;
      let depth = 0;
      while (cursor < text.length && !/[\s<>"']/.test(text[cursor]!)) {
        if (text[cursor] === '(') depth++;
        if (text[cursor] === ')') { if (!depth) break; depth--; }
        cursor++;
      }
      if (text[cursor] !== ')') continue;
      if (start > offset) result.push({ start: offset, end: start, kind: 'text', value: text.slice(offset, start) });
      result.push({ start, end: cursor + 1, kind: 'url', value: text.slice(urlStart, cursor), alias: match[7], labelStart: start + 1 });
      offset = ignoredUntil = cursor + 1;
      continue;
    }
    if (start > offset) result.push({ start: offset, end: start, kind: 'text', value: text.slice(offset, start) });
    let value = match[0];
    if (match[5] !== undefined) {
      let balance = 0;
      for (const char of value) if (char === '(') balance++; else if (char === ')') balance--;
      while (/[.,;:!?]$/.test(value) || value.endsWith(')') && balance < 0) {
        if (value.endsWith(')')) balance++;
        value = value.slice(0, -1);
      }
    }
    const end = start + value.length;
    const tail = match[2];
    const separator = tail?.lastIndexOf('|') ?? -1;
    const view = match[1]?.match(/^view:([0-7][0-9A-HJKMNP-TV-Z]{25})$/);
    result.push(match[1] !== undefined
      ? /^https?:\/\/[^\s<>"']+$/.test(match[1]) && tail !== undefined
        ? { start, end, kind: 'url', value: match[1], alias: tail, labelStart: start + 2 + match[1].length + 1 }
        : { start, end, kind: 'reference', value, id: view?.[1] ?? match[1], ...(view ? { targetKind: 'view' as const } : {}), alias: separator < 0 ? tail : tail!.slice(0, separator), ...(separator < 0 ? {} : { locator: tail!.slice(separator + 1) }) }
      : match[5] !== undefined ? { start, end, kind: 'url', value }
      : { start, end, kind: 'tag', value: match[3] ?? match[4] ?? '' });
    offset = end;
  }
  if (offset < text.length) result.push({ start: offset, end: text.length, kind: 'text', value: text.slice(offset) });
  return result;
}

export type InlineFormat = 'bold' | 'italic' | 'code';
export interface InlineToken extends Token { formats?: InlineFormat[] }

/** Reading-only presentation; each visible literal retains its authored UTF-16 span. */
export function inlineTokens(text: string): InlineToken[] {
  const tokens = textTokens(text);
  const atomic = new Map(tokens.filter(token => token.kind !== 'text').map(token => [token.start, token]));
  const result: InlineToken[] = [];
  function parse(start: number, end: number, formats: InlineFormat[]) {
    let plainStart = start;
    const flush = (to: number) => {
      if (to > plainStart) result.push({ start: plainStart, end: to, kind: 'text', value: text.slice(plainStart, to), formats });
    };
    for (let cursor = start; cursor < end;) {
      const token = atomic.get(cursor);
      if (token && token.end <= end) {
        flush(cursor);
        result.push({ ...token, formats });
        cursor = plainStart = token.end;
        continue;
      }
      if (text[cursor] === '\\') { cursor += 2; continue; }
      const marker = text[cursor] === '`' ? /^`+/.exec(text.slice(cursor))![0]
        : text.startsWith('***', cursor) ? '***' : text.startsWith('**', cursor) ? '**' : text[cursor] === '*' ? '*' : null;
      if (!marker || /\s/.test(text[cursor + marker.length] ?? ' ')) { cursor++; continue; }
      let close = cursor + marker.length;
      for (;;) {
        close = text.indexOf(marker, close);
        if (close < 0 || close >= end) break;
        const insideToken = tokens.some(token => token.kind !== 'text' && close >= token.start && close < token.end);
        if (!insideToken && text[close - 1] !== '\\' && !/\s/.test(text[close - 1]!)
          && (marker[0] !== '`' || text[close + marker.length] !== '`' && text[close - 1] !== '`')) break;
        close += marker.length;
      }
      if (close < 0 || close >= end || /[\r\n]/.test(text.slice(cursor, close))) { cursor += marker.length; continue; }
      flush(cursor);
      const contentStart = cursor + marker.length;
      if (marker[0] === '`') result.push({ start: contentStart, end: close, kind: 'text', value: text.slice(contentStart, close), formats: [...formats, 'code'] });
      else parse(contentStart, close, [...formats, ...(marker.length >= 2 ? ['bold' as const] : []), ...(marker.length !== 2 ? ['italic' as const] : [])]);
      cursor = plainStart = close + marker.length;
    }
    flush(end);
  }
  parse(0, text.length, []);
  return result;
}

/**
 * The single-line reference that ends at `offset` (deleting backward) or starts there (deleting forward): the
 * one a deletion would step into while it shows as a label. A caret inside a reference, as while its query is
 * typed, edits characters instead.
 */
export function referenceBeside(text: string, offset: number, direction: 'backward' | 'forward'): Token | undefined {
  return textTokens(text).find(token => token.kind === 'reference' && !/[\r\n]/.test(token.value)
    && (direction === 'backward' ? token.end === offset : token.start === offset));
}
