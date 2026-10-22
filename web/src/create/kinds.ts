import type { IndexKind, NoteKind } from '../api/types';

/** Registry tags with no dedicated creation command. */
export function creatableKinds(kinds: readonly IndexKind[]): IndexKind[] {
  return kinds.filter(kind => kind.tag && !['task', 'question', 'project', 'source'].includes(kind.key));
}

/** Generated action labels read in sentence case for built-in and notebook-defined kinds alike. */
export function kindNoun(kind: Pick<NoteKind, 'key' | 'name'>): string {
  return kind.name.toLocaleLowerCase();
}
