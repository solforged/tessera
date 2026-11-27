import { ulid } from 'ulid';
import type { Block, BlockInPage, Operation } from '../api/types';
import type { RelationPickIntent, WorkshopClient } from '../document/contract';
import { SOURCE_TARGET, sourceOperation } from '../model/fields';
import { foldName, targetLabel } from '../model/names';
import { completeNames } from '../outline/names';

/** Members of a field's target types, and sources when it links to them: pages, and blocks with their containing page. */
export interface RelationMembers {
  pages: Block[];
  blocks: BlockInPage[];
}

/** Target membership is read from the model, not inferred from a page's title. */
export async function relationMembers(workshop: WorkshopClient, targets: readonly string[]): Promise<RelationMembers> {
  if (!targets.length)
    return { pages: workshop.roots().filter(page => page.kind === 'page' && !page.archived), blocks: [] };
  const pages = new Map<string, Block>();
  const blocks = new Map<string, BlockInPage>();
  await Promise.all(
    targets.map(async type => {
      const result = await workshop.api.query(
        type === SOURCE_TARGET
          ? { type: null, note_kind: SOURCE_TARGET, text: null, filters: [], sort: [], limit: 2000, offset: 0 }
          : { type, text: null, filters: [], sort: [], limit: 2000, offset: 0 },
      );
      for (const row of result.rows) {
        const block = row.block.block;
        if (block.archived) continue;
        if (block.kind === 'page') pages.set(block.id, block);
        else blocks.set(block.id, row.block);
      }
    }),
  );
  return { pages: [...pages.values()].sort((a, b) => a.text.localeCompare(b.text)), blocks: [...blocks.values()] };
}

/** The page members of the target types, for interpretations that propose only pages. */
export async function instancePages(workshop: WorkshopClient, targets: readonly string[]): Promise<Block[]> {
  return (await relationMembers(workshop, targets)).pages;
}

/** A relation picker row: a page, or a block named by its label and placed by its page. */
export interface RelationCandidate {
  block: Block;
  page: Block | null;
  label: string;
  alias: string | null;
  here: boolean;
}
export interface RelationCandidates {
  rows: RelationCandidate[];
  canCreate: boolean;
}

/**
 * Candidates for a relation value. With target types, their members match by name, pages by title or alias
 * and blocks by label. Without types, pages match as before and blocks come from search once the query has
 * a few characters. Blocks on the owner's page lead; the owner itself is never offered.
 */
export async function relationCandidates(
  workshop: WorkshopClient,
  members: RelationMembers,
  targeted: boolean,
  query: string,
  owner?: { id: string; page: string },
): Promise<RelationCandidates> {
  const lookup: WorkshopClient['lookup'] = id => workshop.lookup(id);
  const needle = foldName(query);
  const names = await completeNames(workshop, query, members.pages);
  const found = targeted
    ? members.blocks
    : needle.length >= 3
      ? (await workshop.api.search(query.trim(), 30)).filter(row => row.block.kind === 'block' && !row.block.archived)
      : [];
  const blocks = found
    .flatMap(row => {
      if (row.block.id === owner?.id) return [];
      const label = targetLabel(row.block.text, lookup) || 'Empty note';
      return !targeted || foldName(label).includes(needle)
        ? [{ block: row.block, page: row.page, label, alias: null, here: row.page.id === owner?.page }]
        : [];
    })
    .sort((a, b) => Number(b.here) - Number(a.here) || a.label.localeCompare(b.label));
  const pages = names.rows
    .filter(match => match.page.id !== owner?.id)
    .map(match => ({ block: match.page, page: null, label: match.page.text, alias: match.alias, here: false }));
  const here = blocks.filter(row => row.here);
  return {
    rows: [...here, ...pages, ...blocks.filter(row => !row.here)],
    canCreate: names.canCreate && !members.blocks.length,
  };
}

/** Resolve a durable accepted query only when its text command reaches the outbox head. */
export async function resolveRelationPick(workshop: WorkshopClient, intent: RelationPickIntent) {
  if (intent.targetId) return { text: `[[${intent.targetId}]]`, operations: [] as Operation[] };
  let create = intent.create;
  if (!create) {
    const members = await relationMembers(workshop, intent.targets);
    const found = await relationCandidates(workshop, members, !!intent.targets.length, intent.query, intent.owner);
    if (found.rows[0]) return { text: `[[${found.rows[0].block.id}]]`, operations: [] as Operation[] };
    if (!found.canCreate || !intent.query.trim())
      throw new Error('No relation target matched the accepted query. Its text was kept.');
    if (intent.targets.includes(SOURCE_TARGET)) create = { source: true };
    else {
      const types = await Promise.all(intent.targets.map(id => workshop.api.block(id)));
      const type = types.find(type => !type.archived);
      if (intent.targets.length && !type)
        throw new Error('The relation target tags are no longer available. Its text was kept.');
      create = { typeTitle: type?.text };
    }
  }
  if (!intent.createId) throw new Error('The accepted relation has no note identity. Its text was kept.');
  const id = intent.createId;
  const operations: Operation[] = [
    { op: 'create_page', id, title: intent.query.trim() },
    ...(create.typeTitle ? [{ op: 'add_type' as const, id, base_revision: 1, title: create.typeTitle }] : []),
    ...(create.source ? [sourceOperation(id, 1)] : []),
  ];
  return { text: `[[${id}]]`, operations };
}

/** Creation and filing travel together, including when the picker is used offline. A page made for Source becomes one. */
export async function createInstance(
  workshop: WorkshopClient,
  title: string,
  typeTitle?: string,
  source = false,
): Promise<Block> {
  const id = ulid();
  await workshop.commit(
    [
      { op: 'create_page', id, title: title.trim() },
      ...(typeTitle ? [{ op: 'add_type' as const, id, base_revision: 1, title: typeTitle }] : []),
      ...(source ? [sourceOperation(id, 1)] : []),
    ],
    'Create linked note',
  );
  return workshop.api.block(id);
}
