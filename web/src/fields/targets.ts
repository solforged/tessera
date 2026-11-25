import type { WorkshopClient } from '../document/contract';
import { SOURCE_TARGET, sourceOperation, typeTargets } from '../model/fields';

export { SOURCE_TARGET, sourceOperation, typeTargets };

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
