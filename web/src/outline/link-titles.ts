import type { NotebookClient } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { insideProtectedSyntax } from '../tasks/quick-date';
import { isStableReference } from './BlockText';
import { foldName, resolveName } from './names';
import { isJournalReference } from './completion';

export type TitleTargets = Map<string, string>;

/** Hand-typed `[[Title]]` names in `text`, trimmed and deduplicated. */
export function typedTitles(text: string): string[] {
  if (!text.includes('[[')) return [];
  return [...new Set(textTokens(text).flatMap(token => token.kind === 'reference' && !isStableReference(token) && !insideProtectedSyntax(text, token.start) && token.id!.trim() ? [token.id!.trim()] : []))];
}

/**
 * A hand-typed name links only when one page owns it; ambiguous names wait for a choice. An unknown name creates
 * its page, except a date, which names a journal and stays as typed when that day has none.
 */
export async function titleTargets(notebook: NotebookClient, titles: readonly string[]): Promise<TitleTargets> {
  const targets: TitleTargets = new Map();
  for (const title of titles) {
    const key = foldName(title);
    if (isJournalReference(title)) {
      const target = (await notebook.api.complete(title, 20)).find(block => block.kind === 'journal' && block.text === title)?.id;
      if (target) targets.set(key, target);
      continue;
    }
    const matches = await resolveName(notebook, title);
    if (matches.length > 1) continue;
    if (matches.length === 1) { targets.set(key, matches[0]!.page.id); continue; }
    targets.set(key, await notebook.createPage(title));
  }
  return targets;
}

/** Rewrites resolved names as stable references, retaining the wording of every hand-typed occurrence. */
export function withLinkedTitles(text: string, targets: TitleTargets): string {
  return textTokens(text).map(token => {
    const target = token.kind === 'reference' && !isStableReference(token) && !insideProtectedSyntax(text, token.start) ? targets.get(foldName(token.id!)) : undefined;
    const label = token.alias ?? token.id?.trim();
    return target ? `[[${target}|${label}]]` : text.slice(token.start, token.end);
  }).join('');
}
