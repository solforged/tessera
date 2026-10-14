import type { Block, NameMatch } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { Token } from '../document/text-tokens';
import { isStableReference, isViewReference, quoteTarget, textTokens } from '../document/text-tokens';
import type { MenuItem } from '../ui/Menu';
import { documentReady } from './source-fields';
import { cardMarks, cardOperators } from '../review/card-text';

/** Names compare as the core folds them: no case, diacritics or apostrophes, and any other run of spaces or punctuation is one space. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}|['’]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
}

interface Resolutions { sequence: number; names: Map<string, Promise<NameMatch[]>> }
const resolutions = new WeakMap<NotebookClient, Resolutions>();

/** Share one request per folded name until an acknowledged local or remote change. */
export function resolveName(notebook: NotebookClient, name: string): Promise<NameMatch[]> {
  const sequence = notebook.changeSequence();
  let cache = resolutions.get(notebook);
  if (!cache || cache.sequence !== sequence) {
    cache = { sequence, names: new Map() };
    resolutions.set(notebook, cache);
  }
  const key = foldName(name);
  const existing = cache.names.get(key);
  if (existing) return existing;
  const request = notebook.api.resolveName(name.trim());
  cache.names.set(key, request);
  const names = cache.names;
  void request.catch(() => { if (names.get(key) === request) names.delete(key); });
  return request;
}

/** Completion and exact identity share the same folding and aliases, within the caller's allowed pages. */
export async function completeNames(notebook: NotebookClient, query: string, pages: readonly Block[]): Promise<{ rows: NameMatch[]; canCreate: boolean }> {
  const title = query.trim();
  const allowed = new Map(pages.filter(page => page.kind === 'page' && !page.archived).map(page => [page.id, page]));
  if (!title) return { rows: [...allowed.values()].map(page => ({ page, alias: null })), canCreate: false };
  const [completed, exact] = await Promise.all([
    notebook.api.complete(title, Math.max(20, notebook.roots().length)),
    resolveName(notebook, title),
  ]);
  const rows = new Map<string, NameMatch>();
  for (const match of [...exact, ...completed.map(page => ({ page, alias: page.alias }))]) {
    const page = allowed.get(match.page.id);
    if (page && !rows.has(page.id)) rows.set(page.id, { page, alias: match.alias });
  }
  return { rows: [...rows.values()], canCreate: !exact.some(match => allowed.has(match.page.id)) };
}

/** A linked identity needs a canonical ID; bracketed names are names, never navigation targets. */
export function referenceValue(text: string): { id: string | null; name: string } {
  const value = text.trim();
  const tokens = textTokens(value);
  const token = tokens.length === 1 && tokens[0]?.kind === 'reference' ? tokens[0] : undefined;
  return token ? { id: isStableReference(token) ? token.id! : null, name: token.alias ?? token.id!.trim() } : { id: null, name: value };
}

/** References to reference-bearing blocks read their live labels, with cycles bounded by target identity. */
export function referenceLabel(token: Token, target: Block | null | undefined, lookup: NotebookClient['lookup'], seen: ReadonlySet<string> = new Set()): string {
  if (isViewReference(token)) return token.alias || 'Saved view';
  if (!isStableReference(token)) return token.value;
  if (target === undefined) return token.alias || 'Loading reference…';
  if (target === null) return `Unresolved ${token.id}`;
  if (token.alias) return token.alias;
  if (seen.has(target.id)) return 'Circular reference';
  return plainText(target.text, lookup, new Set([...seen, target.id])) || 'Empty block';
}

/** The shared live display pipeline used by reference labels, breadcrumbs and field previews. */
export function plainText(text: string, lookup: NotebookClient['lookup'], seen: ReadonlySet<string> = new Set()): string {
  const quoted = quoteTarget(text);
  if (quoted) return `“${referenceLabel({ kind: 'reference', id: quoted, value: '', start: 0, end: 0 }, lookup(quoted)(), lookup, seen)}”`;
  return textTokens(text).map(token => isViewReference(token) ? token.alias || 'Saved view' : isStableReference(token) ? referenceLabel(token, lookup(token.id!)(), lookup, seen) + (token.locator ? `\u2009${token.locator}` : '') : token.kind === 'tag' ? `#${token.value}` : token.value).join('');
}
/** Plain text as a reader sees it: card operators as their arrows and clozes as their answers. Never use it for text that is written back. */
export function readableText(text: string, lookup: NotebookClient['lookup']): string {
  let shown = '', offset = 0;
  for (const mark of cardMarks(text)) {
    shown += text.slice(offset, mark.start) + (mark.kind === 'cloze' ? text.slice(mark.answerStart, mark.answerEnd) : cardOperators[mark.op].text);
    offset = mark.end;
  }
  return plainText(shown + text.slice(offset), lookup);
}
/** Only the selected occurrence changes; a concurrently edited token is never overwritten. */
export function resolvedReferenceText(text: string, token: Token, target: string): string | null {
  const current = textTokens(text).find(value => value.start === token.start && value.end === token.end && value.kind === 'reference' && value.id === token.id && value.alias === token.alias && value.locator === token.locator);
  if (!current) return null;
  return `${text.slice(0, token.start)}[[${target}|${token.alias ?? token.id!.trim()}${token.locator === undefined ? '' : `|${token.locator}`}]]${text.slice(token.end)}`;
}

export async function chooseName(notebook: NotebookClient, blockId: string, token: Token, target?: string): Promise<void> {
  const block = notebook.lookup(blockId)() ?? await notebook.api.block(blockId);
  const doc = notebook.open(block.page_id);
  try {
    await documentReady(doc);
    const current = doc.block(blockId)?.text;
    if (current === undefined || resolvedReferenceText(current, token, '') === null) return;
    const name = token.id!.trim();
    const id = target ?? await notebook.createPage(name);
    const latest = doc.block(blockId)?.text;
    if (latest === undefined) return;
    const text = resolvedReferenceText(latest, token, id);
    if (text === null) return;
    const result = doc.edit({ kind: 'text', id: blockId, text });
    if (!result.ok) throw new Error(result.reason);
    await doc.flush();
    await notebook.api.addAlias(id, name);
  } finally { doc.release(); }
}

export function nameMenuItems(notebook: NotebookClient, blockId: string, token: Token, matches: NameMatch[], onError: (message: string) => void): MenuItem[] {
  const choose = (id?: string) => { void chooseName(notebook, blockId, token, id).catch(error => onError(error instanceof Error ? error.message : String(error))); };
  return [
    ...matches.map(match => ({ label: match.page.text, action: () => choose(match.page.id) })),
    { label: `Create page “${token.id!.trim()}”`, action: () => choose() },
  ];
}
