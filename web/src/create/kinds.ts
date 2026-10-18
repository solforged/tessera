import type { IndexKind, NoteKind } from '../api/types';

/** Registry tags with no dedicated creation command. */
export function creatableKinds(kinds: readonly IndexKind[]): IndexKind[] {
  return kinds.filter(kind => kind.tag && !['task', 'question', 'project', 'source'].includes(kind.key));
}

/** Built-in kinds read in lower case mid-sentence (`New person`); a notebook's own types keep the name as written (`New Italian word`). */
export function kindNoun(kind: Pick<NoteKind, 'key' | 'name'>): string {
  return kind.key.startsWith('type:') ? kind.name : kind.name.toLocaleLowerCase();
}
