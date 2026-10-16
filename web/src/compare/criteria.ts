import type { NotebookClient } from '../document/contract';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';

/** Keep accepting the live draft while resolving names, including names added during the lookup. */
export async function linkedCriteriaDraft(notebook: NotebookClient, initial: string, latest: () => string): Promise<string> {
  let draft = initial;
  const resolved = new Set<string>(), targets = new Map<string, string>();
  for (;;) {
    const titles = typedTitles(draft).filter(title => !resolved.has(title));
    if (titles.length) {
      for (const [name, id] of await titleTargets(notebook, titles)) targets.set(name, id);
      for (const title of titles) resolved.add(title);
    }
    const current = latest();
    if (current === draft) return withLinkedTitles(draft, targets);
    draft = current;
  }
}

export interface ExactRepeat { number: number; criterion: string; text: string; positions: string[] }

/** Equality is only trimmed authored text, never a claim about agreement. Empty cells do not repeat. */
export function exactRepeats(criteria: readonly string[], positions: readonly string[], text: (position: string, criterion: string) => string): ExactRepeat[] {
  const repeats: ExactRepeat[] = [];
  for (const criterion of criteria) {
    const groups = new Map<string, string[]>();
    for (const position of positions) {
      const value = text(position, criterion).trim();
      if (!value) continue;
      const group = groups.get(value);
      if (group) group.push(position);
      else groups.set(value, [position]);
    }
    for (const [value, ids] of groups) if (ids.length > 1) repeats.push({ number: repeats.length + 1, criterion, text: value, positions: ids });
  }
  return repeats;
}

/** A question names holders, so every reading by each named holder belongs to its lens. */
export function questionReadingIds(rows: readonly { holder_id: string | null; block: { block: { id: string } } }[], holders: readonly string[]): string[] {
  return rows.filter(row => !holders.length || row.holder_id !== null && holders.includes(row.holder_id)).map(row => row.block.block.id);
}
