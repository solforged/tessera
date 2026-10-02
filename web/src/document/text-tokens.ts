export interface Token { start: number; end: number; kind: 'text' | 'reference' | 'tag'; value: string; id?: string; alias?: string }
export function textTokens(text: string): Token[] {
  const result: Token[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(?<![\p{L}\p{N}_])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))/gu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > offset) result.push({ start: offset, end: start, kind: 'text', value: text.slice(offset, start) });
    const end = start + match[0].length;
    result.push(match[1] !== undefined
      ? { start, end, kind: 'reference', value: match[0], id: match[1], alias: match[2] }
      : { start, end, kind: 'tag', value: match[3] ?? match[4] ?? '' });
    offset = end;
  }
  if (offset < text.length) result.push({ start: offset, end: text.length, kind: 'text', value: text.slice(offset) });
  return result;
}
