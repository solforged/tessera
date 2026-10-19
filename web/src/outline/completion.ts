import type { Block, QuoteState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { insideProtectedSyntax } from '../tasks/quick-date';
import { titleKey } from '../document/title-key';
import { mapTextOffset } from '../document/text-patch';

export interface CapturedQuoteCompletion { text: string; quote: QuoteState }

/** Whole-block quote choices share their frozen payload and authored token across projections. */
export async function captureQuoteCompletion(notebook: NotebookClient, target: string): Promise<CapturedQuoteCompletion> {
  const quote = await notebook.api.quoteSnapshot(target);
  return { text: `((${target}))`, quote };
}

/**
 * A leading input rule belongs to the edit that completes it: the block's text lacked the prefix before, and the
 * caret now stands at or past its end. Typing that arrives in one chunk (buffered while the caret moved to a new
 * block, or inserted whole) fires it as keystrokes would; a prefix that was already there does not.
 */
function completedPrefix(pattern: RegExp, previous: string, text: string, caret: number): RegExpExecArray | null {
  const match = pattern.exec(text);
  return match && caret >= match[0].length && !pattern.test(previous) ? match : null;
}

/** `# `, `## ` or `### ` typed at the start of a block makes it a heading; the caret keeps its place in the rest. */
export function headingPrefix(previous: string, text: string, caret: number): { text: string; heading: 1 | 2 | 3; caret: number } | null {
  const prefix = completedPrefix(/^(#{1,3}) /, previous, text, caret);
  return prefix ? { text: text.slice(prefix[0].length), heading: prefix[1]!.length as 1 | 2 | 3, caret: caret - prefix[0].length } : null;
}

/** `[] ` or `[ ] ` typed at the start of a block makes it a task; the caret keeps its place in the rest. */
export function taskPrefixInput(previous: string, text: string, caret: number): { text: string; caret: number } | null {
  const prefix = completedPrefix(/^\[ ?\] /, previous, text, caret);
  return prefix ? { text: text.slice(prefix[0].length), caret: caret - prefix[0].length } : null;
}

/** Only unmodified Enter or Tab accepts a completion; editing chords retain their own meaning. */
export function completionPickKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
}

export interface CompletionToken { id: string; from: number; query: string }
/**
 * Typing engages a completion's token. A caret that only lands in a token (a click, End, undo) offers its picker
 * without engaging it, and the token stays engaged while the caret moves within it unchanged.
 */
export function engagedToken(previous: CompletionToken | null, next: CompletionToken | null, typed: boolean): CompletionToken | null {
  if (!next) return null;
  if (typed) return next;
  return previous && previous.id === next.id && previous.from === next.from && previous.query === next.query ? previous : null;
}

/** An offered completion leaves every key but Escape to the editor, so Enter still splits and Tab still indents. */
export function completionTakesKey(event: Pick<KeyboardEvent, 'key'>, engaged: boolean): boolean {
  return engaged || event.key === 'Escape';
}

/** Completion-owned boundaries follow saved-text rewrites without changing the query or chosen row. */
export function mapCompletionRange<T extends { from: number; to?: number }>(before: string, after: string, token: T): T {
  return { ...token, from: mapTextOffset(before, after, token.from),
    ...token.to === undefined ? {} : { to: mapTextOffset(before, after, token.to) } };
}

/** ISO date references name existing journals, never newly created ordinary pages. */
export function isJournalReference(query: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(query.trim());
}

export interface ReferenceCompletion { from: number; to: number; query: string; blocks: boolean }
/** Find the active opening pair only in authored prose, outside code and references. */
export function referenceCompletionAt(text: string, caret: number): ReferenceCompletion | null {
  const prefix = text.slice(0, caret);
  const page = prefix.lastIndexOf('[['), block = prefix.lastIndexOf('((');
  const blocks = block > page, from = Math.max(page, block);
  const typed = prefix.slice(from + 2);
  if (from < 0 || typed.includes(blocks ? ')' : ']') || !blocks && typed.includes('|') || typed.includes('\n') || !blocks && prefix[from - 1] === '#' || insideProtectedSyntax(text, from)) return null;
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
  const query = text.slice(from + 2, closed ? end : caret);
  return { from, to: closed ? end + 2 : caret, query: blocks ? query : query.split('|', 1)[0]! };
}

/** Completing the target never discards an authored label or locator. */
export function completedReference(text: string, from: number, to: number, id: string): string {
  const inner = text.slice(from + 2, to).replace(/\]\]$/, '');
  const separator = inner.indexOf('|');
  return `[[${id}${separator < 0 ? '' : inner.slice(separator)}]]`;
}

/** `|` finishes the target and leaves the caret in the label, before the paired closer. */
export function referenceAliasInput(text: string, from: number, caret: number, target?: string): { from: number; to: number; insert: string; caret: number } {
  const range = openReferenceRange(text, from, caret, false);
  // An accepted ID already fixes the target; search hits for its mentions must not retarget it.
  const reference = completedReference(text, range.from, range.to, /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(range.query) ? range.query : target ?? range.query);
  const separator = reference.indexOf('|');
  const insert = separator < 0 ? `${reference.slice(0, -2)}|]]` : reference;
  return { from: range.from, to: range.to, insert, caret: range.from + insert.indexOf('|') + 1 };
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
      titles.set(titleKey(block.text), block);
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
  const key = titleKey(query.trim());
  if (!key) return null;
  const index = rootIndex(notebook.roots());
  const candidate = index.titles.get(key);
  if (!candidate) return null;
  const block = liveRoot(notebook, candidate.id, index);
  return block?.kind === 'page' && titleKey(block.text) === key ? block : null;
}

