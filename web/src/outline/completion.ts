import type { Block } from '../api/types';
import type { Caret, NotebookClient } from '../document/contract';
import { ApiError, api } from '../api/client';
import { isStableReference } from './BlockText';

export interface Completion {
  id: string;
  from: number;
  to: number;
  query: string;
  expression: string;
}

export function completionAt(text: string, caret: Caret): Completion | null {
  if (caret.offset <= 0 || caret.offset > text.length) return null;
  const from = text.lastIndexOf('[[', caret.offset - 1);
  if (from < 0 || caret.offset <= from || text[from - 1] === '#') return null;
  let end = from + 2;
  while (end < text.length && !'[]\r\n'.includes(text[end]!)) end++;
  let to = end;
  if (text[to] === ']') to++;
  const closed = text[to] === ']';
  if (closed) to++;
  if (caret.offset > to) return null;
  const query = text.slice(from + 2, end);
  const expression = text.slice(from, to);
  const alias = query.indexOf('|');
  if (closed && isStableReference({
    kind: 'reference', start: from, end: to, value: expression, id: alias < 0 ? query : query.slice(0, alias),
  })) return null;
  return { id: caret.id, from, to, query, expression };
}

const limit = 20;
interface RootIndex {
  ids: Map<string, Block>;
  titles: Map<string, Block>;
  named: Block[];
  keys: string[];
}
const indexes = new WeakMap<readonly Block[], RootIndex>();

function rootIndex(roots: readonly Block[]): RootIndex {
  const existing = indexes.get(roots);
  if (existing) return existing;
  const ids = new Map<string, Block>();
  const titles = new Map<string, Block>();
  const named: Block[] = [];
  for (const block of roots) {
    if (block.kind === 'block' || block.parent_id !== null || ids.has(block.id)) continue;
    ids.set(block.id, block);
    if (block.kind === 'page') {
      titles.set(block.text.toLowerCase(), block);
      if (!block.archived) named.push(block);
    }
  }
  named.sort((left, right) => left.text.localeCompare(right.text) || left.id.localeCompare(right.id));
  const result = { ids, titles, named, keys: named.map(block => block.text.toLowerCase()).sort() };
  indexes.set(roots, result);
  return result;
}

export function prepareCompletion(notebook: NotebookClient): void {
  rootIndex(notebook.roots());
}

function liveRoot(notebook: NotebookClient, id: string, index: RootIndex): Block | null {
  const cached = notebook.lookup(id)();
  const block = cached === undefined ? index.ids.get(id) : cached;
  return block && block.kind !== 'block' && block.parent_id === null ? block : null;
}

function emptyChoices(notebook: NotebookClient, visited: readonly string[], index: RootIndex): Block[] {
  const rows: Block[] = [];
  const seen = new Set<string>();
  function add(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const block = liveRoot(notebook, id, index);
    if (block && !block.archived) rows.push(block);
  }
  for (const id of visited) {
    add(id);
    if (rows.length === limit) return rows;
  }
  // Only a bounded prefix is needed after the capped visited list, not a notebook scan.
  const end = Math.min(index.named.length, limit + seen.size);
  for (let position = 0; position < end && rows.length < limit; position++) add(index.named[position]!.id);
  return rows;
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

function offlineChoices(notebook: NotebookClient, query: string, exact: Block | null, index: RootIndex): Block[] {
  const rows = exact ? [exact] : [];
  const seen = new Set(rows.map(block => block.id));
  const key = query.toLowerCase();
  let start = 0;
  let end = index.keys.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (index.keys[middle]! < key) start = middle + 1;
    else end = middle;
  }
  // Prefix lookup is logarithmic; only the bounded result window is inspected.
  for (let position = start; position < Math.min(index.keys.length, start + limit) && rows.length < limit; position++) {
    const title = index.keys[position]!;
    if (!title.startsWith(key)) break;
    const candidate = index.titles.get(title)!;
    const block = liveRoot(notebook, candidate.id, index);
    if (block?.kind === 'page' && !block.archived && block.text.toLowerCase().startsWith(key) && !seen.has(block.id)) {
      seen.add(block.id);
      rows.push(block);
    }
  }
  return rows;
}

async function exactPage(query: string): Promise<Block | null> {
  try { return await api.pageByTitle(query); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function completeReferences(
  notebook: NotebookClient,
  query: string,
  visited: readonly string[],
): Promise<{ rows: Block[]; canCreate: boolean }> {
  const index = rootIndex(notebook.roots());
  const title = query.trim();
  if (!title) return { rows: emptyChoices(notebook, visited, index), canCreate: false };
  const cached = cachedExactPage(notebook, title);
  if (notebook.connection() === 'offline') {
    return { rows: offlineChoices(notebook, title, cached, index), canCreate: cached === null };
  }
  const [matches, exact] = await Promise.all([
    api.complete(title, limit),
    cached ? Promise.resolve(cached) : exactPage(title),
  ]);
  const rows = exact ? [exact] : [];
  const seen = new Set(rows.map(block => block.id));
  for (const block of matches) {
    if (seen.has(block.id) || block.archived) continue;
    seen.add(block.id);
    rows.push(block);
    if (rows.length === limit) break;
  }
  return { rows, canCreate: exact === null };
}
