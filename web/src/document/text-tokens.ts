export interface Token { start: number; end: number; kind: 'text' | 'reference' | 'tag' | 'url'; value: string; id?: string; alias?: string; locator?: string; targetKind?: 'view' }

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
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(?<![\p{L}\p{N}_])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))|(https?:\/\/[^\s<>"']+)/gu;
  let offset = 0;
  let ignoredUntil = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start < ignoredUntil) continue;
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
      ? { start, end, kind: 'reference', value, id: view?.[1] ?? match[1], ...(view ? { targetKind: 'view' as const } : {}), alias: separator < 0 ? tail : tail!.slice(0, separator), ...(separator < 0 ? {} : { locator: tail!.slice(separator + 1) }) }
      : match[5] !== undefined ? { start, end, kind: 'url', value }
      : { start, end, kind: 'tag', value: match[3] ?? match[4] ?? '' });
    offset = end;
  }
  if (offset < text.length) result.push({ start: offset, end: text.length, kind: 'text', value: text.slice(offset) });
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
