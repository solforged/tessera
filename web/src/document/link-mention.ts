import type { Edit } from './contract';
import { textTokens } from './text-tokens';
import { protectedEnd } from '../review/card-text';

/** Link the first whole-word spelling outside references, tags, URLs and code. */
export function linkMentionEdit(id: string, text: string, pageId: string, term: string): Edit | null {
  if (!term) return null;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  const protectedTokens = textTokens(text).filter(token => token.kind !== 'text');
  for (let cursor = 0; cursor < text.length;) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    const end = protectedEnd(text, cursor);
    if (end !== null) {
      protectedTokens.push({ start: cursor, end, kind: 'text', value: '' });
      cursor = end;
    } else cursor++;
  }
  for (const match of text.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    if (protectedTokens.some(token => token.start < end && token.end > start)) continue;
    return {
      kind: 'replaceRange', mode: 'text', between: [],
      range: { anchor: { id, offset: start }, head: { id, offset: end } },
      text: `[[${pageId}|${match[0]}]]`,
    };
  }
  return null;
}
