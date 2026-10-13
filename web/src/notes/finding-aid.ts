import type { CrossReference, Filter, KindIndex, NoteEntry, NoteSummary, Operation, Query } from '../api/types';
import { foldName } from '../outline/names';

export type FindingAidEntry =
  | { kind: 'note'; note: NoteEntry }
  | { kind: 'see'; reference: CrossReference };

export interface FindingAidGroup {
  letter: string;
  entries: FindingAidEntry[];
  noteCount: number;
}

/** The alphabetical whole-kind read already contains every row this query would select. */
export function wholeKindIndex(query: Query, kind: string, type: string | null): boolean {
  return (!query.source || query.source === 'notes') && query.note_kind === kind && query.type === type
    && (query.note_view?.grouping ?? 'letter') === 'letter' && !query.text?.trim()
    && !query.filters.length && !query.sort.length && !query.links?.length && !query.from?.length && !query.cites?.length;
}

/** File notes and cross-references together; apparatus counts only actual notes. */
export function groupKindIndex(index: Pick<KindIndex, 'notes' | 'see'> | undefined): FindingAidGroup[] {
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

export function filingGroups(notes: readonly NoteEntry[], summaries: Readonly<Record<string, NoteSummary>>) {
  return [
    { key: 'text' as const, label: 'With text', notes: notes.filter(note => (summaries[note.id]?.text_blocks ?? 0) > 0) },
    { key: 'blank' as const, label: 'Blank', notes: notes.filter(note => (summaries[note.id]?.text_blocks ?? 0) === 0) },
  ];
}

/** Creating the explicitly named type and filing must acknowledge as one atomic batch. */
export function filingOperations(pageId: string, revision: number, title: string, newTypeId?: string): Operation[] {
  return [
    ...(newTypeId ? [{ op: 'create_page' as const, id: newTypeId, title }] : []),
    { op: 'add_type', id: pageId, base_revision: revision, title },
  ];
}
export const notePredicates = ['links', 'from', 'cites'] as const;
export type NotePredicate = typeof notePredicates[number];
export function parseNoteFind(text: string) {
  const terms: { key: NotePredicate; value: string; raw: string }[] = [];
  const plain = text.replace(/\b(links|from|cites):(?:"([^"]*)"|([^\s"]+))/g, (raw, key: NotePredicate, quoted: string | undefined, bare: string | undefined) => {
    terms.push({ key, value: quoted ?? bare ?? '', raw }); return '';
  }).trim();
  const filters: { filter: Filter; raw: string }[] = [];
  const words = plain.replace(/\b(is:resolved|revisit:(?:due|set|none))\b/g, raw => {
    const filter: Filter = raw === 'is:resolved' ? { field: '@resolved', op: 'is', value: 'true' }
      : { field: '@revisit', op: raw === 'revisit:due' ? 'lte' : raw === 'revisit:set' ? 'set' : 'empty', value: raw === 'revisit:due' ? 'today' : null };
    filters.push({ filter, raw }); return '';
  }).trim();
  return { terms, filters, text: words };
}
