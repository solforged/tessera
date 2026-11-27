import type { Block, NameMatch } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import {
  deletedHolderLabel,
  displayTitle,
  foldedHighlights,
  foldName,
  plainText,
  readableText,
  referenceLabel,
  referenceValue,
  resolvedReferenceText,
  tagLabel,
  targetLabel,
} from '../model/names';
import type { Token } from '../model/text-tokens';
import type { MenuItem } from '../ui/Menu';

export {
  deletedHolderLabel,
  displayTitle,
  foldedHighlights,
  foldName,
  plainText,
  readableText,
  referenceLabel,
  referenceValue,
  resolvedReferenceText,
  tagLabel,
  targetLabel,
};

interface Resolutions {
  sequence: number;
  names: Map<string, Promise<NameMatch[]>>;
}
const resolutions = new WeakMap<WorkshopClient, Resolutions>();

/** Share one request per folded name until a change to page titles, aliases or kinds. */
export function resolveName(workshop: WorkshopClient, name: string): Promise<NameMatch[]> {
  const sequence = workshop.changed('pages');
  let cache = resolutions.get(workshop);
  if (!cache || cache.sequence !== sequence) {
    cache = { sequence, names: new Map() };
    resolutions.set(workshop, cache);
  }
  const key = foldName(name);
  const existing = cache.names.get(key);
  if (existing) return existing;
  const request = workshop.api.resolveName(name.trim());
  cache.names.set(key, request);
  const names = cache.names;
  void request.catch(() => {
    if (names.get(key) === request) names.delete(key);
  });
  return request;
}

/** Completion and exact identity share the same folding and aliases, within the caller's allowed pages. */
export async function completeNames(
  workshop: WorkshopClient,
  query: string,
  pages: readonly Block[],
): Promise<{ rows: NameMatch[]; canCreate: boolean }> {
  const title = query.trim();
  const allowed = new Map(pages.filter(page => page.kind === 'page' && !page.archived).map(page => [page.id, page]));
  if (!title) return { rows: [...allowed.values()].map(page => ({ page, alias: null })), canCreate: false };
  const [completed, exact] = await Promise.all([
    workshop.api.complete(title, Math.max(20, workshop.roots().length)),
    resolveName(workshop, title),
  ]);
  const rows = new Map<string, NameMatch>();
  for (const match of [...exact, ...completed.map(page => ({ page, alias: page.alias }))]) {
    const page = allowed.get(match.page.id);
    if (page && !rows.has(page.id)) rows.set(page.id, { page, alias: match.alias });
  }
  return { rows: [...rows.values()], canCreate: !exact.some(match => allowed.has(match.page.id)) };
}

export async function chooseName(
  workshop: WorkshopClient,
  blockId: string,
  token: Token,
  target?: string,
): Promise<void> {
  const block = workshop.lookup(blockId)() ?? (await workshop.api.block(blockId));
  const doc = workshop.open(block.page_id);
  try {
    await doc.ready();
    const current = doc.block(blockId)?.text;
    if (current === undefined || resolvedReferenceText(current, token, '') === null) return;
    const name = token.id!.trim();
    const id = target ?? (await workshop.createPage(name));
    const latest = doc.block(blockId)?.text;
    if (latest === undefined) return;
    const text = resolvedReferenceText(latest, token, id);
    if (text === null) return;
    const result = doc.edit({ kind: 'text', id: blockId, text });
    if (!result.ok) throw new Error(result.reason);
    await doc.flush();
    await workshop.api.addAlias(id, name);
  } finally {
    doc.release();
  }
}

export function nameMenuItems(
  workshop: WorkshopClient,
  blockId: string,
  token: Token,
  matches: NameMatch[],
  onError: (message: string) => void,
): MenuItem[] {
  const choose = (id?: string) => {
    void chooseName(workshop, blockId, token, id).catch(error =>
      onError(error instanceof Error ? error.message : String(error)),
    );
  };
  return [
    ...matches.map(match => ({ label: match.page.text, action: () => choose(match.page.id) })),
    { label: `Create note “${token.id!.trim()}”`, action: () => choose() },
  ];
}
