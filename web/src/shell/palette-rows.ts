import type { Block, BlockInPage } from '../api/types';

export type SearchHit = BlockInPage & { alias?: string | null };
export type SearchEntry = { kind: 'hit'; hit: SearchHit } | { kind: 'more'; page: Block; count: number };

/** Title hits lead, then prose matches; definition pages follow all content. */
export function paletteRows(hits: readonly SearchHit[], query: string, pageId?: string, definitionPages?: ReadonlySet<string>): SearchEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const ranked = hits.map(hit => {
    const text = hit.block.text.toLocaleLowerCase();
    const urlOnly = !!needle && text.includes(needle) && !text.replace(/https?:\/\/[^\s<>"'`]+/g, ' ').includes(needle);
    return { hit, urlOnly };
  }).sort((a, b) => Number(a.urlOnly) - Number(b.urlOnly));
  if (pageId) return ranked.filter(({ hit }) => hit.page.id === pageId && hit.block.id !== pageId).map(({ hit }) => ({ kind: 'hit', hit }));
  const result: SearchEntry[] = [];
  const groups = new Map<string, SearchHit[]>();
  for (const { hit } of ranked) {
    if (hit.block.id === hit.page.id) { result.push({ kind: 'hit', hit }); continue; }
    const group = groups.get(hit.page.id);
    if (group) group.push(hit); else groups.set(hit.page.id, [hit]);
  }
  for (const group of groups.values()) {
    for (const hit of group.slice(0, 2)) result.push({ kind: 'hit', hit });
    if (group.length > 2) result.push({ kind: 'more', page: group[0]!.page, count: group.length - 2 });
  }
  return definitionPages ? result.sort((a, b) => Number(definitionPages.has(a.kind === 'hit' ? a.hit.page.id : a.page.id)) - Number(definitionPages.has(b.kind === 'hit' ? b.hit.page.id : b.page.id))) : result;
}

/** Preview matches use the same Unicode search terms; source snippets already carry structured matches. */
export function findMatchSegments(text: string, query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.sort((a, b) => b.length - a.length).join('|')})`, 'giu');
  return text.split(pattern).filter(Boolean).map(part => ({ text: part, match: terms.some(term => part.toLocaleLowerCase() === term.toLocaleLowerCase()) }));
}
