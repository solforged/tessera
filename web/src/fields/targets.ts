import type { Operation } from '../api/types';
import type { WorkshopClient } from '../document/contract';

/** The Links to entry for sources, which are a capability rather than a type page; mirrors the core's `SOURCE_TARGET`. */
export const SOURCE_TARGET = 'source';

/** Links to entries that name type pages, leaving out Source. */
export const typeTargets = (targets: readonly string[]) => targets.filter(id => id !== SOURCE_TARGET);

/** A Links to entry's name: Source, else its type page's title. */
export function linksToLabel(workshop: Pick<WorkshopClient, 'lookup'>, id: string): string {
  return id === SOURCE_TARGET ? 'Source' : (workshop.lookup(id)()?.text ?? '…');
}

/** A field's Links to, named in order, or `empty` when it links to any block. */
export function linksToSummary(
  workshop: Pick<WorkshopClient, 'lookup'>,
  targets: readonly string[],
  empty: string,
): string {
  return targets.map(id => linksToLabel(workshop, id)).join(', ') || empty;
}

/** Makes a new page a source, as a manual record waiting to be read. */
export const sourceOperation = (id: string, base_revision: number): Extract<Operation, { op: 'set_source' }> => ({
  op: 'set_source',
  id,
  base_revision,
  source: { format: 'record', state: 'inbox', origin: null, match_key: null, citation_key: null },
});
