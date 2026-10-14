import { describe, expect, test } from 'bun:test';
import type { KindIndex, NoteEntry, NoteSummary, Query, QueryResult, QueryRow } from '../api/types';
import { filingGroups, filingOperations, groupKindIndex, parseNoteFind, settleFindingAid, wholeKindIndex } from './finding-aid';

const note = (id: string, title: string, sort_as: string | null = null): NoteEntry => ({ id, title, sort_as, created_at: 0 });

describe('finding aid loading', () => {
  const index: KindIndex = {
    notes: [note('a', 'Asabiyya'), note('b', 'Badawa')], summaries: {},
    see: [{ alias: 'Desert life', targets: [{ id: 'b', title: 'Badawa' }] }],
  };
  const query: Query = { type: null, note_kind: 'concept', text: null, filters: [], sort: [], limit: null };
  const result = (ids: string[], note_groups?: QueryResult['note_groups']): QueryResult => ({
    fields: [], columns: [], rows: ids.map(id => ({ block: { block: { id } } } as QueryRow)), total: ids.length, note_groups,
  });

  test('keeps the complete index through the first search, then replaces rows, aliases and count together', () => {
    const initial = settleFindingAid(undefined, index, query, true)!;
    const search = { ...query, text: 'Asabiyya' };
    expect(settleFindingAid(initial, index, search, false)).toBe(initial);
    const found = settleFindingAid(initial, index, search, false, { query: search, result: result(['a']) })!;
    expect(found.count).toBe(1);
    expect(found.index.notes.map(note => note.id)).toEqual(['a']);
    expect(found.index.see).toEqual([]);
    expect(found.groups.map(group => group.letter)).toEqual(['A']);
  });

  test('never applies new grouping to old matches, including an out-of-order search result', () => {
    const search = { ...query, text: 'Badawa' };
    const read = { query: search, result: result(['b']) };
    const previous = settleFindingAid(undefined, index, search, false, read)!;
    const grouped = { ...query, note_view: { layout: 'index' as const, grouping: 'created' } };
    expect(settleFindingAid(previous, index, grouped, false, read)).toBe(previous);
    expect(previous.grouping).toBe('letter');
    expect(previous.groups.map(group => group.letter)).toEqual(['B', 'D']);
    const next = settleFindingAid(previous, index, grouped, false, {
      query: grouped, result: result(['a', 'b'], [{ key: '2026-10', title: '2026-10', target: null, siglum: null, note_ids: ['a', 'b'] }]),
    })!;
    expect(next.grouping).toBe('created');
    expect(next.count).toBe(2);
    expect(next.groups.map(group => [group.letter, group.noteCount])).toEqual([['2026-10', 2]]);
    expect(settleFindingAid(next, index, grouped, false, read)).toBe(next);
  });

  test('clearing search restores the whole index without waiting for the in-flight search', () => {
    const search = { ...query, text: 'Badawa' };
    const read = { query: search, result: result(['b']) };
    const previous = settleFindingAid(undefined, index, search, false, read);
    const cleared = settleFindingAid(previous, index, query, true, read)!;
    expect(cleared.index).toBe(index);
    expect(cleared.count).toBe(2);
    expect(cleared.grouping).toBe('letter');
  });

  test('a saved search waits for both reads and only shows empty after its result arrives', () => {
    const search = { ...query, text: 'unknown' };
    const read = { query: search, result: result([]) };
    expect(settleFindingAid(undefined, undefined, search, false, read)).toBeUndefined();
    expect(settleFindingAid(undefined, index, search, false)).toBeUndefined();
    const empty = settleFindingAid(undefined, index, search, false, read)!;
    expect(empty.count).toBe(0);
    expect(empty.index.notes).toEqual([]);
    expect(empty.groups).toEqual([]);
  });
});

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
    a: { preview: null, field: null, block_count: 0, text_blocks: 0, prose_excerpt: [], backlinks: 3, referenced_from: [], source: null },
    b: { preview: 'Prose', field: null, block_count: 1, text_blocks: 1, prose_excerpt: ['Prose'], backlinks: 0, referenced_from: [], source: null },
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

test('note Find preserves quoted names, repeated predicates and plain words', () => {
  const parsed = parseNoteFind('dynasty links:"Three generations of a dynasty" from:Asabiyya cites:IK links:Mulk');
  expect(parsed.text).toBe('dynasty');
  expect(parsed.terms.map(({ key, value }) => [key, value])).toEqual([['links', 'Three generations of a dynasty'], ['from', 'Asabiyya'], ['cites', 'IK'], ['links', 'Mulk']]);
  expect(parseNoteFind('links:"unfinished name').terms).toEqual([]);
  expect(parseNoteFind('is:settled revisit:due').text).toBe('is:settled');
  expect(parseNoteFind('is:resolved revisit:due revisit:set revisit:none').filters.map(term => term.filter)).toEqual([
    { field: '@resolved', op: 'is', value: 'true' }, { field: '@revisit', op: 'lte', value: 'today' },
    { field: '@revisit', op: 'set', value: null }, { field: '@revisit', op: 'empty', value: null },
  ]);
});

test('whole-kind reads never bypass a query restriction or another grouping', () => {
  const query: Query = { type: 'person-type', note_kind: 'person', text: null, filters: [], sort: [], limit: null };
  expect(wholeKindIndex(query, 'person', 'person-type')).toBe(true);
  const restrictions: Partial<Query>[] = [
    { source: 'sources' }, { note_kind: 'concept' }, { type: 'other-type' },
    { text: 'Ada' }, { filters: [{ field: '@resolved', op: 'is', value: 'true' }] },
    { sort: [{ by: 'title', field: null, direction: 'desc' }] }, { links: ['ada'] }, { from: ['ada'] }, { cites: ['work'] },
    { note_view: { layout: 'index', grouping: 'created' } },
  ];
  for (const restriction of restrictions) expect(wholeKindIndex({ ...query, ...restriction }, 'person', 'person-type')).toBe(false);
});
