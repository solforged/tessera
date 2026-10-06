import type { Block, BlockInPage } from '../api/types';

export type SearchEntry = { kind: 'hit'; hit: BlockInPage } | { kind: 'more'; page: Block; count: number };

/** Title hits lead, then page groups with prose matches ahead of URL-only matches. */
export function paletteRows(hits: readonly BlockInPage[], query: string, pageId?: string): SearchEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const ranked = hits.map(hit => {
    const text = hit.block.text.toLocaleLowerCase();
    const urlOnly = !!needle && text.includes(needle) && !text.replace(/https?:\/\/[^\s<>"'`]+/g, ' ').includes(needle);
    return { hit, urlOnly };
  }).sort((a, b) => Number(a.urlOnly) - Number(b.urlOnly));
  if (pageId) return ranked.filter(({ hit }) => hit.page.id === pageId && hit.block.id !== pageId).map(({ hit }) => ({ kind: 'hit', hit }));
  const result: SearchEntry[] = [];
  const groups = new Map<string, BlockInPage[]>();
  for (const { hit } of ranked) {
    if (hit.block.id === hit.page.id) { result.push({ kind: 'hit', hit }); continue; }
    const group = groups.get(hit.page.id);
    if (group) group.push(hit); else groups.set(hit.page.id, [hit]);
  }
  for (const group of groups.values()) {
    for (const hit of group.slice(0, 2)) result.push({ kind: 'hit', hit });
    if (group.length > 2) result.push({ kind: 'more', page: group[0]!.page, count: group.length - 2 });
  }
  return result;
}
