import type { NoteKind } from '../api/types';

/** Page kinds offered by More and Commands; built-in actions have their own entries. */
export function creatableKinds(kinds: readonly NoteKind[]): NoteKind[] {
  return kinds.filter(kind => kind.key !== 'question' && kind.key !== 'project' && kind.key !== 'source' && kind.key !== 'all' && kind.key !== 'unfiled');
}
