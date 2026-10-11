import type { CrossReference, KindIndex, NoteEntry } from '../api/types';
import { foldName } from '../outline/names';

export type FindingAidEntry =
  | { kind: 'note'; note: NoteEntry }
  | { kind: 'see'; reference: CrossReference };

export interface FindingAidGroup {
  letter: string;
  entries: FindingAidEntry[];
  noteCount: number;
}

/** File notes and cross-references together; apparatus counts only actual notes. */
export function groupKindIndex(index: KindIndex | undefined): FindingAidGroup[] {
  if (!index) return [];
  const entries: { key: string; tie: string; entry: FindingAidEntry }[] = [];
  for (const note of index.notes) {
    entries.push({ key: foldName(note.sort_as ?? note.title), tie: note.id, entry: { kind: 'note', note } });
  }
  for (const reference of index.see) {
    entries.push({ key: foldName(reference.alias), tie: reference.alias, entry: { kind: 'see', reference } });
  }
  entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
  const groups = new Map<string, FindingAidGroup>();
  for (const { key, entry } of entries) {
    const initial = key.charAt(0).toUpperCase();
    const letter = /^[A-Z]$/.test(initial) ? initial : '#';
    let group = groups.get(letter);
    if (!group) {
      group = { letter, entries: [], noteCount: 0 };
      groups.set(letter, group);
    }
    group.entries.push(entry);
    if (entry.kind === 'note') group.noteCount++;
  }
  return [...groups.values()].sort((a, b) => a.letter === '#' ? 1 : b.letter === '#' ? -1 : a.letter.localeCompare(b.letter));
}
