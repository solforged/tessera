import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { insideProtectedSyntax } from '../tasks/quick-date';

/** A heading trigger belongs to the space just typed, not to a prefix found later in the text. */
export function headingPrefix(text: string, caret: number): { text: string; heading: 1 | 2 | 3 } | null {
  const prefix = /^(#{1,3}) /.exec(text);
  return prefix && caret === prefix[0].length ? { text: text.slice(prefix[0].length), heading: prefix[1]!.length as 1 | 2 | 3 } : null;
}

/** Only unmodified Enter or Tab accepts a completion; editing chords retain their own meaning. */
export function completionPickKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** ISO date references name existing journals, never newly created ordinary pages. */
export function isJournalReference(query: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(query.trim());
}

/** Find the active opening pair only in authored prose, outside code and references. */
export function referenceCompletionAt(text: string, caret: number): { from: number; to: number; query: string; blocks: boolean } | null {
  const prefix = text.slice(0, caret);
  const page = prefix.lastIndexOf('[['), block = prefix.lastIndexOf('((');
  const blocks = block > page, from = Math.max(page, block);
  const typed = prefix.slice(from + 2);
  if (from < 0 || typed.includes(blocks ? ')' : ']') || typed.includes('\n') || !blocks && prefix[from - 1] === '#' || insideProtectedSyntax(text, from)) return null;
  return { from, to: caret, query: openReferenceRange(text, from, caret, blocks).query, blocks };
}

/**
 * An open `[[` or `((` completion: the text a choice replaces and the query it searches. Both run from the
 * brackets to the caret, and on through the rest of the query and its closing pair when one follows, so a
 * caret moved back into `[[Stoicism]]` still searches `Stoicism` and a choice leaves no tail behind.
 */
export function openReferenceRange(text: string, from: number, caret: number, blocks: boolean): { from: number; to: number; query: string } {
  const stops = blocks ? '()\r\n' : '[]\r\n';
  let end = caret;
  while (end < text.length && !stops.includes(text[end]!)) end++;
  const closed = text.startsWith(blocks ? '))' : ']]', end);
  return { from, to: closed ? end + 2 : caret, query: text.slice(from + 2, closed ? end : caret) };
}

/** A block picker captures only when its query occupies the entire row. */
export function isQuoteCompletion(text: string, from: number, caret: number): boolean {
  if (!text.startsWith('((', from)) return false;
  const range = openReferenceRange(text, from, caret, true);
  return !text.slice(0, range.from).trim() && !text.slice(range.to).trim();
}

/** A soft newline leaves a paired reference after its closer, never inside the query. */
export function referenceNewlineAt(text: string, from: number, caret: number, blocks: boolean): number {
  return openReferenceRange(text, from, caret, blocks).to;
}

interface RootIndex {
  ids: Map<string, Block>;
  titles: Map<string, Block>;
}
const indexes = new WeakMap<readonly Block[], RootIndex>();

function rootIndex(roots: readonly Block[]): RootIndex {
  const existing = indexes.get(roots);
  if (existing) return existing;
  const ids = new Map<string, Block>();
  const titles = new Map<string, Block>();
  for (const block of roots) {
    if (block.kind === 'block' || block.parent_id !== null || ids.has(block.id)) continue;
    ids.set(block.id, block);
    if (block.kind === 'page') {
      titles.set(block.text.toLowerCase(), block);
    }
  }
  const result = { ids, titles };
  indexes.set(roots, result);
  return result;
}

function liveRoot(notebook: NotebookClient, id: string, index: RootIndex): Block | null {
  const cached = notebook.lookup(id)();
  const block = cached === undefined ? index.ids.get(id) : cached;
  return block && block.kind !== 'block' && block.parent_id === null ? block : null;
}

export function cachedExactPage(notebook: NotebookClient, query: string): Block | null {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const index = rootIndex(notebook.roots());
  const candidate = index.titles.get(key);
  if (!candidate) return null;
  const block = liveRoot(notebook, candidate.id, index);
  return block?.kind === 'page' && block.text.toLowerCase() === key ? block : null;
}

