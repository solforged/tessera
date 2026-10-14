import { ulid } from 'ulid';
import type { NotebookClient } from '../document/contract';

/** A perspective's holder is a person or group; these are the two built-in kinds it can be filed as. */
export type EntityKind = 'Person' | 'Group';
export const entityKinds: readonly EntityKind[] = ['Person', 'Group'];
export const entityLabel = (kind: EntityKind) => kind === 'Person' ? 'person' : 'group';

/** Creates the page and files it in one change, so a new holder never exists untyped. */
export async function createEntity(notebook: NotebookClient, title: string, kind: EntityKind): Promise<string> {
  const id = ulid();
  await notebook.commit([{ op: 'create_page', id, title: title.trim() }, { op: 'add_type', id, base_revision: 1, title: kind }], `Create ${entityLabel(kind)}`);
  return id;
}

/** Files an existing page as a person or group, keeping its title and content. */
export async function fileAsEntity(notebook: NotebookClient, id: string, kind: EntityKind, refreshPages?: readonly string[]): Promise<void> {
  const page = await notebook.api.block(id);
  // Perspectives elsewhere derive their problem from this page's kind, so their pages reload their capabilities.
  await notebook.commit([{ op: 'add_type', id, base_revision: page.revision, title: kind }], `File as ${entityLabel(kind)}`, refreshPages);
}
