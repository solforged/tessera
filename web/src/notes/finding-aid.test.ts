import { describe, expect, test } from 'bun:test';
import type { NoteEntry, NoteSummary } from '../api/types';
import { filingGroups, filingOperations, groupKindIndex } from './finding-aid';

const note = (id: string, title: string, sort_as: string | null = null): NoteEntry => ({ id, title, sort_as, created_at: 0 });

describe('finding aid groups', () => {
  test('interleaves folded titles, Sort as values and aliases without counting cross-references', () => {
    const groups = groupKindIndex({
      notes: [note('z', 'Zürich'), note('b', 'Beryl'), note('a', 'Émile', '  Babbage,   Émile  ')],
      see: [
        { alias: '  Báb  ', targets: [{ id: 'a', title: 'Émile' }] },
        { alias: 'Basil', targets: [{ id: 'b', title: 'Beryl' }] },
        { alias: 'Tully', targets: [{ id: 'a', title: 'Émile' }, { id: 'b', title: 'Beryl' }] },
      ],
    });
    expect(groups.map(group => [group.letter, group.noteCount])).toEqual([['B', 2], ['T', 0], ['Z', 1]]);
    expect(groups[0]!.entries.map(entry => entry.kind === 'note' ? entry.note.title : entry.reference.alias)).toEqual(['  Báb  ', 'Émile', 'Basil', 'Beryl']);
    expect(groups.reduce((sum, group) => sum + group.noteCount, 0)).toBe(3);
    const shared = groups[1]!.entries[0]!;
    expect(shared.kind === 'see' && shared.reference.targets.map(target => target.id)).toEqual(['a', 'b']);
  });

  test('files accented initials under their base letter and other initials last', () => {
    const groups = groupKindIndex({
      notes: [note('e', '  Émile'), note('number', '100 questions'), note('non-latin', '哲学')],
      see: [{ alias: ' Åufhebung', targets: [{ id: 'e', title: '  Émile' }] }],
    });
    expect(groups.map(group => [group.letter, group.noteCount])).toEqual([['A', 0], ['E', 1], ['#', 2]]);
  });

  test('breaks equal folded note sort keys by id without mutating the API result', () => {
    const notes = [note('z', 'Other title', 'same'), note('a', 'Sáme')];
    const groups = groupKindIndex({ notes, see: [] });
    expect(groups[0]!.entries.map(entry => entry.kind === 'note' && entry.note.id)).toEqual(['a', 'z']);
    expect(notes.map(entry => entry.id)).toEqual(['z', 'a']);
  });

  test('has no groups before loading or for an empty kind', () => {
    expect(groupKindIndex(undefined)).toEqual([]);
    expect(groupKindIndex({ notes: [], see: [] })).toEqual([]);
  });
});

test('blank filing rows can have blocks and backlinks without having text', () => {
  const summaries: Record<string, NoteSummary> = {
    a: { preview: null, field: null, block_count: 1, text_blocks: 0, backlinks: 3, referenced_from: [], source: null },
    b: { preview: 'Prose', field: null, block_count: 2, text_blocks: 1, backlinks: 0, referenced_from: [], source: null },
  };
  const groups = filingGroups([note('a', 'Referenced blank'), note('b', 'With prose'), note('c', 'Empty')], summaries);
  expect(groups.map(group => [group.key, group.notes.map(note => note.id)])).toEqual([['text', ['b']], ['blank', ['a', 'c']]]);
});

test('create type and file is one ordered batch while an existing type only adds membership', () => {
  expect(filingOperations('note', 7, 'Concept', 'new-type')).toEqual([
    { op: 'create_page', id: 'new-type', title: 'Concept' },
    { op: 'add_type', id: 'note', base_revision: 7, title: 'Concept' },
  ]);
  expect(filingOperations('note', 7, 'Concept')).toEqual([{ op: 'add_type', id: 'note', base_revision: 7, title: 'Concept' }]);
});
