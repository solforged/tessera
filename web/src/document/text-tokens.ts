export interface Token { start: number; end: number; kind: 'text' | 'reference' | 'tag' | 'url'; value: string; id?: string; alias?: string }
export function textTokens(text: string): Token[] {
  const result: Token[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(?<![\p{L}\p{N}_])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))|(https?:\/\/[^\s<>"']+)/gu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
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
    result.push(match[1] !== undefined
      ? { start, end, kind: 'reference', value, id: match[1], alias: match[2] }
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
