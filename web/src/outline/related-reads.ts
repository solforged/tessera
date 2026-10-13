import { ApiError } from '../api/client';
import type { Block } from '../api/types';

type RelatedRoot = Pick<Block, 'kind' | 'revision'>;

export function isVirtualJournal(root: RelatedRoot | undefined): boolean {
  return root?.kind === 'journal' && root.revision === 0;
}

/** A local journal root can precede its first committed create_journal batch. */
export async function readJournalRelated<T>(request: Promise<T>, root: RelatedRoot | undefined, empty: T): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (isVirtualJournal(root) && error instanceof ApiError && error.status === 404) return empty;
    throw error;
  }
}
