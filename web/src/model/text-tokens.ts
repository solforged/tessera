import { escapeEnd, protectedEnd } from '../core/syntax';

export interface Token {
  start: number;
  end: number;
  kind: 'text' | 'reference' | 'tag' | 'url';
  value: string;
  id?: string;
  alias?: string;
  locator?: string;
  targetKind?: 'view';
  labelStart?: number;
}

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

const tagWordChar = /[\p{L}\p{M}\p{N}_/-]/u;
const urlScheme = /^https?:\/\//i;

function scanReference(text: string, start: number): { end: number; nested: boolean } | null {
  let depth = 1;
  let nested = false;
  let cursor = start + 2;
  while (cursor < text.length && depth > 0) {
    const escaped = escapeEnd(text, cursor);
    if (escaped !== null) {
      cursor = escaped;
    } else if (text.startsWith('[[', cursor)) {
      nested = true;
      depth++;
      cursor += 2;
    } else if (text.startsWith(']]', cursor)) {
      depth--;
      cursor += 2;
    } else {
      cursor++;
    }
  }
  return depth === 0 ? { end: cursor, nested } : null;
}

export function textTokens(text: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  let cursor = 0;
  const flush = (to: number) => {
    if (to > offset) result.push({ start: offset, end: to, kind: 'text', value: text.slice(offset, to) });
  };

  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor = escapeEnd(text, cursor) ?? Math.min(text.length, cursor + 2);
      continue;
    }
    const ch = text[cursor]!;
    if (ch === '`' || ch === '~') {
      const shielded = protectedEnd(text, cursor, 'stored');
      if (shielded !== null) {
        cursor = shielded;
        continue;
      }
      cursor++;
      continue;
    }
    if (text.startsWith('[[', cursor)) {
      const scanned = scanReference(text, cursor);
      if (!scanned) {
        cursor = text.length;
        break;
      }
      if (scanned.nested) {
        cursor = scanned.end;
        continue;
      }
      const start = cursor;
      const end = scanned.end;
      const value = text.slice(start, end);
      const inner = text.slice(start + 2, end - 2);
      const pipe = inner.indexOf('|');
      const head = pipe < 0 ? inner : inner.slice(0, pipe);
      const tail = pipe < 0 ? undefined : inner.slice(pipe + 1);
      if (!head) {
        cursor += 2;
        continue;
      }
      flush(start);
      const separator = tail?.lastIndexOf('|') ?? -1;
      const view = head.match(/^view:([0-7][0-9A-HJKMNP-TV-Z]{25})$/);
      if (/^https?:\/\/[^\s<>"']+$/i.test(head) && tail !== undefined) {
        result.push({ start, end, kind: 'url', value: head, alias: tail, labelStart: start + 2 + head.length + 1 });
      } else {
        result.push({
          start,
          end,
          kind: 'reference',
          value,
          id: view?.[1] ?? head,
          ...(view ? { targetKind: 'view' as const } : {}),
          alias: separator < 0 ? tail : tail!.slice(0, separator),
          ...(separator < 0 ? {} : { locator: tail!.slice(separator + 1) }),
        });
      }
      offset = cursor = end;
      continue;
    }
    if (ch === '[' && !text.startsWith('[[', cursor)) {
      const closeBracket = text.indexOf('](', cursor + 1);
      if (closeBracket > cursor + 1) {
        const caption = text.slice(cursor + 1, closeBracket);
        const urlStart = closeBracket + 2;
        if (!/[[\]\r\n]/.test(caption) && urlScheme.test(text.slice(urlStart))) {
          let urlEnd = urlStart;
          let depth = 0;
          while (urlEnd < text.length && !/[\s<>"']/.test(text[urlEnd]!)) {
            if (text[urlEnd] === '(') depth++;
            if (text[urlEnd] === ')') {
              if (!depth) break;
              depth--;
            }
            urlEnd++;
          }
          if (text[urlEnd] === ')') {
            flush(cursor);
            result.push({
              start: cursor,
              end: urlEnd + 1,
              kind: 'url',
              value: text.slice(urlStart, urlEnd),
              alias: caption,
              labelStart: cursor + 1,
            });
            offset = cursor = urlEnd + 1;
            continue;
          }
        }
      }
    }
    if (ch === '#') {
      const prev = cursor > 0 ? Array.from(text.slice(Math.max(0, cursor - 2), cursor)).at(-1) : undefined;
      if (!prev || !tagWordChar.test(prev)) {
        if (text.startsWith('[[', cursor + 1)) {
          const close = text.indexOf(']]', cursor + 3);
          if (close > cursor + 3) {
            const start = cursor;
            const end = close + 2;
            const value = text.slice(start, end);
            const title = text.slice(cursor + 3, close);
            const canonical = /^([0-7][0-9A-HJKMNP-TV-Z]{25})\|([\s\S]*)$/.exec(title);
            const invalidTag = title.includes('[') || (!!canonical && /[[\]|\r\n]/.test(canonical[2]!));
            flush(start);
            result.push(
              invalidTag
                ? { start, end, kind: 'text', value }
                : {
                    start,
                    end,
                    kind: 'tag',
                    value: canonical?.[2] ?? title.trim(),
                    ...(canonical ? { id: canonical[1], alias: canonical[2] } : {}),
                  },
            );
            offset = cursor = end;
            continue;
          }
        } else {
          let end = cursor + 1;
          for (const char of text.slice(end)) {
            if (!tagWordChar.test(char)) break;
            end += char.length;
          }
          if (end > cursor + 1) {
            const title = text.slice(cursor + 1, end);
            flush(cursor);
            result.push({ start: cursor, end, kind: 'tag', value: title });
            offset = cursor = end;
            continue;
          }
        }
      }
    }
    if ((ch === 'h' || ch === 'H') && urlScheme.test(text.slice(cursor))) {
      const match = /^https?:\/\/[^\s<>"']+/i.exec(text.slice(cursor));
      if (match) {
        let value = match[0];
        let balance = 0;
        for (const char of value)
          if (char === '(') balance++;
          else if (char === ')') balance--;
        while (/[.,;:!?]$/.test(value) || (value.endsWith(')') && balance < 0)) {
          if (value.endsWith(')')) balance++;
          value = value.slice(0, -1);
        }
        const end = cursor + value.length;
        flush(cursor);
        result.push({ start: cursor, end, kind: 'url', value });
        offset = cursor = end;
        continue;
      }
    }
    cursor++;
  }

  flush(text.length);
  return result;
}

export type InlineFormat = 'bold' | 'italic' | 'code';
export interface InlineToken extends Token {
  formats?: InlineFormat[];
}

/** Reading-only presentation; each visible literal retains its authored UTF-16 span. */
export function inlineTokens(text: string): InlineToken[] {
  const tokens = textTokens(text);
  const atomic = new Map(tokens.filter(token => token.kind !== 'text').map(token => [token.start, token]));
  const result: InlineToken[] = [];
  function parse(start: number, end: number, formats: InlineFormat[]) {
    let plainStart = start;
    const flush = (to: number) => {
      if (to > plainStart)
        result.push({ start: plainStart, end: to, kind: 'text', value: text.slice(plainStart, to), formats });
    };
    for (let cursor = start; cursor < end; ) {
      const token = atomic.get(cursor);
      if (token && token.end <= end) {
        flush(cursor);
        result.push({ ...token, formats });
        cursor = plainStart = token.end;
        continue;
      }
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '`' || text[cursor] === '~') {
        const shielded = protectedEnd(text, cursor, 'stored');
        if (shielded !== null && shielded <= end && text.slice(cursor, shielded).includes('\n')) {
          cursor = shielded;
          continue;
        }
      }
      const marker =
        text[cursor] === '`'
          ? /^`+/.exec(text.slice(cursor))![0]
          : text.startsWith('***', cursor)
            ? '***'
            : text.startsWith('**', cursor)
              ? '**'
              : text[cursor] === '*'
                ? '*'
                : null;
      if (!marker || /\s/.test(text[cursor + marker.length] ?? ' ')) {
        cursor++;
        continue;
      }
      let close = cursor + marker.length;
      for (;;) {
        close = text.indexOf(marker, close);
        if (close < 0 || close >= end) break;
        const insideToken = tokens.some(token => token.kind !== 'text' && close >= token.start && close < token.end);
        if (
          !insideToken &&
          text[close - 1] !== '\\' &&
          !/\s/.test(text[close - 1]!) &&
          (marker[0] !== '`' || (text[close + marker.length] !== '`' && text[close - 1] !== '`'))
        )
          break;
        close += marker.length;
      }
      if (close < 0 || close >= end || /[\r\n]/.test(text.slice(cursor, close))) {
        cursor += marker.length;
        continue;
      }
      flush(cursor);
      const contentStart = cursor + marker.length;
      if (marker[0] === '`')
        result.push({
          start: contentStart,
          end: close,
          kind: 'text',
          value: text.slice(contentStart, close),
          formats: [...formats, 'code'],
        });
      else
        parse(contentStart, close, [
          ...formats,
          ...(marker.length >= 2 ? ['bold' as const] : []),
          ...(marker.length !== 2 ? ['italic' as const] : []),
        ]);
      cursor = plainStart = close + marker.length;
    }
    flush(end);
  }
  parse(0, text.length, []);
  return result;
}

/**
 * The single-line reference or bracketed tag (`#[[id|alias]]`, `#[[Title]]`) that ends at `offset` (deleting
 * backward) or starts there (deleting forward): the one a deletion would step into while it shows as a label or
 * pill. A caret inside one, as while its query is typed, edits characters instead, and so does a bare `#word`
 * tag, whose pill shrinks with the word being typed.
 */
export function tokenBeside(text: string, offset: number, direction: 'backward' | 'forward'): Token | undefined {
  return textTokens(text).find(
    token =>
      (token.kind === 'reference' || (token.kind === 'tag' && text.startsWith('#[[', token.start))) &&
      !/[\r\n]/.test(token.value) &&
      (direction === 'backward' ? token.end === offset : token.start === offset),
  );
}
