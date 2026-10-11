import type { NotebookClient } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { isStableReference } from './BlockText';
import { foldName, resolveName } from './names';

export type TitleTargets = Map<string, { id: string; alias: boolean }>;

/** Hand-typed `[[Title]]` names in `text`, trimmed and deduplicated. */
export function typedTitles(text: string): string[] {
  if (!text.includes('[[')) return [];
  return [...new Set(textTokens(text).flatMap(token => token.kind === 'reference' && !isStableReference(token) && token.id!.trim() ? [token.id!.trim()] : []))];
}

/**
 * A hand-typed name links only when one page owns it; ambiguous names wait for a choice. An unknown name creates
 * its page, except a date, which names a journal and stays as typed when that day has none.
 */
export async function titleTargets(notebook: NotebookClient, titles: readonly string[]): Promise<TitleTargets> {
  const targets: TitleTargets = new Map();
  for (const title of titles) {
    const key = foldName(title);
    const matches = await resolveName(notebook, title);
    if (matches.length > 1) continue;
    if (matches.length === 1) { targets.set(key, { id: matches[0]!.page.id, alias: matches[0]!.alias !== null }); continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(title);
    const target = date ? (await notebook.api.complete(title, 20)).find(block => block.kind === 'journal' && block.text === title)?.id : await notebook.createPage(title);
    if (target) targets.set(key, { id: target, alias: false });
  }
  return targets;
}

/** Rewrites resolved names as stable references, keeping a name reached through an alias as the label. */
export function withLinkedTitles(text: string, targets: TitleTargets): string {
  return textTokens(text).map(token => {
    const target = token.kind === 'reference' && !isStableReference(token) ? targets.get(foldName(token.id!)) : undefined;
    const alias = token.alias ?? (target?.alias ? token.id!.trim() : undefined);
    return target ? `[[${target.id}${alias !== undefined ? `|${alias}` : ''}]]` : text.slice(token.start, token.end);
  }).join('');
}
