import type { Edit } from './contract';
import { textTokens } from './text-tokens';

/** Link the first whole-word spelling outside references and tags, preserving its authored case. */
export function linkMentionEdit(id: string, text: string, pageId: string, term: string): Edit | null {
  if (!term) return null;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  const protectedTokens = textTokens(text).filter(token => token.kind === 'reference' || token.kind === 'tag');
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
