import type { NameMatch } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { Token } from '../document/text-tokens';
import { textTokens } from '../document/text-tokens';
import type { MenuItem } from '../ui/Menu';
import { documentReady } from './source-fields';

/** Names compare without case, diacritics or incidental whitespace. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/gu, ' ');
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

/** Only the selected occurrence changes; a concurrently edited token is never overwritten. */
export function resolvedReferenceText(text: string, token: Token, target: string): string | null {
  const current = textTokens(text).find(value => value.start === token.start && value.end === token.end && value.kind === 'reference' && value.id === token.id && value.alias === token.alias);
  if (!current) return null;
  return `${text.slice(0, token.start)}[[${target}|${token.alias ?? token.id!.trim()}]]${text.slice(token.end)}`;
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
