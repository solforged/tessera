import { parseCardText } from '../review/card-text';
import { matchFieldEntry } from '../table/query';
import { insideProtectedSyntax } from '../tasks/quick-date';

export interface SlashToken { from: number; to: number; query: string }
export interface SlashEntry { id: string; title: string; aliases?: readonly string[] }

/** The active slash token ends at the caret, not necessarily at the end of the block. */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  if (caret <= 0 || caret > text.length || matchFieldEntry(text)) return null;
  const from = text.lastIndexOf('/', caret - 1);
  if (from < 0 || from > 0 && !/\s/.test(text[from - 1]!) || insideProtectedSyntax(text, from)) return null;
  const query = text.slice(from + 1, caret);
  if (query.length > 24 || query !== '' && !/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)* ?$/u.test(query)) return null;
  return { from, to: caret, query };
}

/** Prefer title prefixes, then word prefixes, then substring matches, preserving menu order. */
export function rankSlash<T extends SlashEntry>(entries: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...entries];
  const queryWords = normalized.split(/\s+/);
  const tiers: [T[], T[], T[]] = [[], [], []];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    if (title.startsWith(normalized)) {
      tiers[0].push(entry);
      continue;
    }
    const labels = [title, ...(entry.aliases ?? []).map(alias => alias.toLowerCase())];
    const words = labels.flatMap(label => label.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    if (queryWords.every(queryWord => words.some(word => word.startsWith(queryWord)))) tiers[1].push(entry);
    else if (labels.some(label => label.includes(normalized))) tiers[2].push(entry);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

export function nextClozeNumber(text: string): number {
  let highest = 0;
  for (const card of parseCardText(text).cards) {
    if (card.kind === 'cloze') highest = Math.max(highest, Number(card.key.slice('cloze:c'.length)));
  }
  return highest + 1;
}
