import { ulid } from 'ulid';
import type { WorkshopClient } from '../document/contract';

/** A perspective's holder is a person or group; these are the two built-in kinds it can be filed as. */
export type EntityKind = 'Person' | 'Group';
export const entityKinds: readonly EntityKind[] = ['Person', 'Group'];
export const entityLabel = (kind: EntityKind) => (kind === 'Person' ? 'person' : 'group');

/** Creates the page and files it in one change, so a new holder never exists untyped. */
export async function createEntity(workshop: WorkshopClient, title: string, kind: EntityKind): Promise<string> {
  const id = ulid();
  await workshop.commit(
    [
      { op: 'create_page', id, title: title.trim() },
      { op: 'add_type', id, base_revision: 1, title: kind },
    ],
    `Create ${entityLabel(kind)}`,
  );
  return id;
}

/** Files an existing page as a person or group, keeping its title and content. */
export async function fileAsEntity(
  workshop: WorkshopClient,
  id: string,
  kind: EntityKind,
  refreshPages?: readonly string[],
): Promise<void> {
  const page = await workshop.api.block(id);
  // Perspectives elsewhere derive their problem from this page's kind, so their pages reload their capabilities.
  await workshop.commit(
    [{ op: 'add_type', id, base_revision: page.revision, title: kind }],
    `File as ${entityLabel(kind)}`,
    refreshPages,
  );
}
