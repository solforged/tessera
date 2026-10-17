import type { IndexKind, NoteKind } from '../api/types';

/** Page kinds offered by More and Commands; built-in actions have their own entries, and source kinds start from Add source. */
export function creatableKinds(kinds: readonly IndexKind[]): IndexKind[] {
  return kinds.filter(kind => kind.shelf !== 'sources' && kind.key !== 'question' && kind.key !== 'project' && kind.key !== 'source' && kind.key !== 'all' && kind.key !== 'unfiled');
}

/** Built-in kinds read in lower case mid-sentence (`New person`); a notebook's own types keep the name as written (`New Italian word`). */
export function kindNoun(kind: Pick<NoteKind, 'key' | 'name'>): string {
  return kind.key.startsWith('type:') ? kind.name : kind.name.toLocaleLowerCase();
}
