import type { Block, NameMatch } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { Token } from '../document/text-tokens';
import { isStableReference, isViewReference, quoteTarget, textTokens } from '../document/text-tokens';
import type { MenuItem } from '../ui/Menu';
import { documentReady } from './source-fields';
import { cardMarks, cardOperators } from '../review/card-text';
import { titleKey } from '../document/title-key';
import { identityName } from '../document/title-name';

/** Names compare as the core folds their identity: ignore tags, case, diacritics and apostrophes; punctuation becomes spaces. */
export function foldName(value: string): string {
  return foldWords(identityName(value));
}

function foldWords(value: string): string {
  return titleKey(value.normalize('NFD').replace(/\p{M}|['’]/gu, '').replace(/[^\p{Alphabetic}\p{N}]+/gu, ' ').trim());
}

const highlightGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Match the same folded words as Find, but mark complete glyphs in the authored string. */
export function foldedHighlights(value: string, query: string): [number, number][] {
  const terms = foldName(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const offsets: [number, number][] = [];
  let gap: [number, number] | undefined;
  for (const { segment, index } of highlightGraphemes.segment(value)) {
    const folded = foldWords(segment);
    if (!folded) {
      if (segment.normalize('NFD').replace(/\p{M}|['’]/gu, '')) gap = [gap?.[0] ?? index, index + segment.length];
      continue;
    }
    if (gap && offsets.length) offsets.push(gap);
    gap = undefined;
    for (let i = 0; i < folded.length; i++) offsets.push([index, index + segment.length]);
  }
  // Fold the whole string for context-sensitive lowercase forms, not each glyph independently.
  const folded = foldWords(value);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      const start = offsets[at], end = offsets[at + term.length - 1];
      if (start && end) ranges.push([start[0], end[1]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
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
export function referenceLabel(token: Token, target: Block | null | undefined, lookup: NotebookClient['lookup'], seen: ReadonlySet<string> = new Set(), unavailableLabel?: string): string {
  if (isViewReference(token)) return token.alias || 'Saved view';
  if (!isStableReference(token)) return token.value;
  if (target == null && unavailableLabel) return unavailableLabel;
  if (target === undefined) return token.alias || 'Loading reference…';
  if (target === null) return token.alias || `Unresolved ${token.id}`;
  if (token.alias) return token.alias;
  if (seen.has(target.id)) return 'Circular reference';
  return targetLabel(target.text, lookup, new Set([...seen, target.id])) || 'Empty atom';
}

/** Tag aliases are a fallback, never an override of the live page title. */
export function tagLabel(token: Pick<Token, 'id' | 'alias' | 'value'>, lookup: NotebookClient['lookup']): string {
  return (token.id ? lookup(token.id)()?.text : undefined) || token.alias || token.value || token.id || '';
}

/** One readable attribution for deleted holders in rows, headings and navigation labels. */
export function deletedHolderLabel(holder: { text: string }): string {
  return `${holder.text || 'Unnamed holder'} · Deleted holder`;
}

/** What a reference or relation calls its target, as the core labels it: the first line, its trailing tags dropped and inner tags read as words. */
export function targetLabel(text: string, lookup: NotebookClient['lookup'], seen: ReadonlySet<string> = new Set()): string {
  if (quoteTarget(text)) return plainText(text, lookup, seen);
  const tokens = textTokens(text.trim().split('\n', 1)[0] ?? '');
  while (tokens.length && (tokens.at(-1)!.kind === 'tag' || (tokens.at(-1)!.kind === 'text' && !tokens.at(-1)!.value.trim()))) tokens.pop();
  return tokens.map(token => token.kind === 'tag' ? tagLabel(token, lookup) : plainToken(token, lookup, seen)).join('').trim();
}

/** Display the identity name, rendering tag-only titles with live tag labels. */
export function displayTitle(text: string, lookup: NotebookClient['lookup'] = () => () => undefined): string {
  const name = identityName(text);
  return name === text && textTokens(text).some(token => token.kind === 'tag') ? plainText(text, lookup) : name;
}

function plainToken(token: Token, lookup: NotebookClient['lookup'], seen: ReadonlySet<string>, deletedHolder?: { id: string; text: string } | null): string {
  return isViewReference(token) ? token.alias || 'Saved view' : isStableReference(token) ? referenceLabel(token, lookup(token.id!)(), lookup, seen, deletedHolder && deletedHolder.id === token.id ? deletedHolderLabel(deletedHolder) : undefined) + (token.locator ? `\u2009${token.locator}` : '') : token.kind === 'tag' ? `#${tagLabel(token, lookup)}` : token.kind === 'url' ? token.alias ?? token.value : token.value;
}

/** The shared live display pipeline used by reference labels, breadcrumbs and field previews. */
export function plainText(text: string, lookup: NotebookClient['lookup'], seen: ReadonlySet<string> = new Set(), deletedHolder?: { id: string; text: string } | null): string {
  const quoted = quoteTarget(text);
  if (quoted) return `“${referenceLabel({ kind: 'reference', id: quoted, value: '', start: 0, end: 0 }, lookup(quoted)(), lookup, seen, deletedHolder && deletedHolder.id === quoted ? deletedHolderLabel(deletedHolder) : undefined)}”`;
  return textTokens(text).map(token => plainToken(token, lookup, seen, deletedHolder)).join('');
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
    { label: `Create atom “${token.id!.trim()}”`, action: () => choose() },
  ];
}
