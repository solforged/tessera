import { describe, expect, test } from 'bun:test';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, filterLabel, filterOperatorLabel, filterOperators, matchFieldEntry, missingQueryFields, noteTableQuery, queriesEqual, queryFieldIds, remapQueryField, removeFilter, removeQueryField, removeSort, sortLabel, typeQuery } from './query';
import { attributeDefinitions } from './attributes';
import type { FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';

describe('query edits', () => {
  test('switching a saved field-grouped index to table retains grouping without mutating the recipe', () => {
    const initial = { ...typeQuery(null), note_kind: 'concept', note_view: { layout: 'index' as const, grouping: 'field:strand' } };
    const table = noteTableQuery(initial);
    expect(table.note_view).toEqual({ layout: 'table', grouping: 'field:strand' });
    expect(table.group).toEqual({ key: 'strand', collapsed: [] });
    expect(initial.note_view.layout).toBe('index');
    const collapsed = { ...table, group: { key: 'strand', collapsed: ['city'] } };
    expect(noteTableQuery(collapsed).group).toEqual(collapsed.group);
    expect(noteTableQuery({ ...table, note_view: { layout: 'table', grouping: 'field:other' } }).group?.key).toBe('other');
    expect(noteTableQuery({ ...collapsed, note_view: { layout: 'index', grouping: 'letter' } }).group).toBeUndefined();
    expect(noteTableQuery(typeQuery('books')).note_view).toBeUndefined();
  });
  test('sort choice keeps the first key primary and flips in place without duplicates', () => {
    const initial = typeQuery('books');
    const title = chooseSort(initial, { by: 'title', field: null });
    const author = chooseSort(title, { by: 'field', field: 'author' });
    expect(author.sort).toEqual([{ by: 'title', field: null, direction: 'asc' }, { by: 'field', field: 'author', direction: 'asc' }]);
    expect(chooseSort(author, { by: 'title', field: null }).sort).toEqual([{ by: 'title', field: null, direction: 'desc' }, { by: 'field', field: 'author', direction: 'asc' }]);
    expect(chooseSort(author, { by: 'field', field: 'author' }, 'asc').sort).toEqual(author.sort);
    expect(removeSort(author, 1).sort).toEqual(title.sort);
    expect(initial.sort).toEqual([]);
  });
  test('filter edits preserve exact order and do not mutate inputs', () => {
    const filter = { field: 'author', op: 'contains' as const, value: 'Herbert' };
    const one = addFilter(typeQuery('books'), filter);
    const two = addFilter(one, { field: 'read', op: 'set', value: 'ignored' });
    expect(two.filters).toEqual([filter, { field: 'read', op: 'set', value: null }]);
    expect(removeFilter(two, 0).filters).toEqual([{ field: 'read', op: 'set', value: null }]);
    expect(one.filters).toEqual([filter]);
  });
  test('instance filter chips resolve the current entity title, not the stored ID', () => {
    const fields: FieldDefinition[] = [{ id: 'author', name: 'Author', kind: 'instance', revision: 1, options: [], targets: [] }];
    let title = 'Aristotle';
    const notebook = { lookup: () => () => ({ text: title }) } as unknown as NotebookClient;
    const filter = { field: 'author', op: 'is' as const, value: 'person-id' };
    expect(filterLabel(filter, fields, notebook)).toBe('Author is Aristotle');
    title = 'Aristotle QA';
    expect(filterLabel(filter, fields, notebook)).toBe('Author is Aristotle QA');
    expect(filter.value).toBe('person-id');
    expect(filterLabel({ ...filter, op: 'contains', value: 'Aristotle' }, fields, notebook)).toBe('Author contains Aristotle');
  });
  test('attribute choices show names while preserving their query identities', () => {
    const fields: FieldDefinition[] = [{ id: '@kind', name: 'Kind', kind: 'choice', revision: 0, options: [{ id: 'type:books', text: 'Book' }], targets: [] }];
    expect(filterLabel({ field: '@kind', op: 'is', value: 'type:books' }, fields, {} as NotebookClient)).toBe('Kind is Book');
    expect(attributeDefinitions('tasks').find(field => field.id === '@status')?.options.map(option => option.id)).toEqual(['todo', 'doing', 'waiting', 'done', 'cancelled']);
  });
  test('note predicates use semantic attributes and civil-date comparisons', () => {
    const fields = attributeDefinitions('notes'); const notebook = {} as NotebookClient;
    expect(filterLabel({ field: '@resolved', op: 'is', value: 'true' }, fields, notebook)).toBe('Resolved');
    expect(filterLabel({ field: '@resolved', op: 'is_not', value: 'true' }, fields, notebook)).toBe('Not resolved');
    expect(filterLabel({ field: '@revisit', op: 'lte', value: 'today' }, fields, notebook)).toBe('Revisit on or before today');
    expect(filterLabel({ field: '@revisit', op: 'gte', value: '+7d' }, fields, notebook)).toBe('Revisit on or after a week from now');
  });
  test('filter operators follow field kinds and distinguish presence from values', () => {
    for (const kind of ['choice', 'instance'] as const) {
      expect(filterOperators(kind)).toEqual(['is', 'is_not', 'set', 'empty']);
    }
    for (const kind of ['text', 'url', 'identifier'] as const) {
      expect(filterOperators(kind)).toEqual(['is', 'is_not', 'contains', 'present', 'set', 'empty']);
    }
    for (const kind of ['number', 'date'] as const) {
      expect(filterOperators(kind)).toEqual(['is', 'is_not', 'contains', 'gt', 'gte', 'lt', 'lte', 'present', 'set', 'empty']);
    }
    expect(filterOperators('checkbox')).toEqual(['is', 'is_not']);
    expect(filterOperatorLabel('present')).toBe('has the field');
    expect(filterOperatorLabel('set')).toBe('has a value');
    expect(filterOperatorLabel('is', 'checkbox')).toBe('is checked');
    expect(filterOperatorLabel('is_not', 'checkbox')).toBe('is not checked');
    const fields: FieldDefinition[] = [{ id: 'owned', name: 'Owned', kind: 'checkbox', revision: 1, options: [], targets: [] }];
    const notebook = {} as NotebookClient;
    expect(filterLabel({ field: 'owned', op: 'is', value: 'true' }, fields, notebook)).toBe('Owned is checked');
    expect(filterLabel({ field: 'owned', op: 'is_not', value: 'true' }, fields, notebook)).toBe('Owned is not checked');
    expect(filterLabel({ field: 'owned', op: 'present', value: null }, fields, notebook)).toBe('Owned has the field');
    expect(filterLabel({ field: 'owned', op: 'set', value: null }, fields, notebook)).toBe('Owned has a value');
  });
  test('saved equality compares all fields and preserves ordered filters and sort precedence', () => {
    const query = chooseSort(addFilter(addFilter(typeQuery('books'), { field: 'year', op: 'gte', value: '2000' }), { field: 'author', op: 'contains', value: 'Herbert' }), { by: 'title', field: null });
    const copied = copyQuery(query);
    expect(queriesEqual(query, copied)).toBe(true);
    expect(queriesEqual(query, { ...copied, offset: 0 })).toBe(true);
    expect(queriesEqual({ ...query, offset: 0 }, copied)).toBe(true);
    expect(queriesEqual(query, { ...copied, filters: [...copied.filters].reverse() })).toBe(false);
    for (const difference of [{ type: null }, { text: 'Dune' }, { limit: 20 }, { offset: 500 }, { filters: [] }, { sort: [] }]) expect(queriesEqual(query, { ...copied, ...difference })).toBe(false);
    copied.filters[0]!.value = '1999';
    expect(queriesEqual(query, copied)).toBe(false);
    expect(query.filters[0]!.value).toBe('2000');
    const secondary = chooseSort(query, { by: 'updated', field: null });
    expect(queriesEqual(secondary, { ...secondary, sort: [...secondary.sort].reverse() })).toBe(false);
    expect(queriesEqual(query, chooseSort(query, { by: 'title', field: null }))).toBe(false);
  });
  test('layout changes mark a saved recipe modified while old views default to table', () => {
    const query = { ...typeQuery(null), source: 'positions' as const };
    expect(queriesEqual(query, { ...query, layout: 'table' })).toBe(true);
    for (const layout of ['register', 'matrix', 'desk'] as const) {
      const recipe = { ...query, layout };
      expect(copyQuery(recipe).layout).toBe(layout);
      expect(queriesEqual(query, recipe)).toBe(false);
      expect(queriesEqual(recipe, copyQuery(recipe))).toBe(true);
    }
  });
  test('recipes copy independently and equality includes every saved presentation setting', () => {
    const query = { ...typeQuery(null), source: 'positions' as const, columns: [{ key: '@title', width: 240 }, { key: 'gist', width: 320 }], group: { key: '@subject', collapsed: ['anacyclosis'] }, card: ['gist'], purpose: 'Read Aristotle by concept.', filters: [{ field: '@last_assessed', op: 'lt' as const, value: '-30d', or_empty: true }] };
    const copied = copyQuery(query);
    expect(queriesEqual(query, copied)).toBe(true);
    for (const difference of [{ source: 'notes' as const }, { purpose: '' }, { columns: [...query.columns].reverse() }, { group: { key: '@subject', collapsed: [] } }, { card: [] }, { filters: [{ ...query.filters[0]!, or_empty: false }] }]) expect(queriesEqual(query, { ...copied, ...difference })).toBe(false);
    copied.columns![1]!.width = 400; copied.group!.collapsed!.push('other'); copied.card!.push('work');
    expect(query.columns[1]!.width).toBe(320);
    expect(query.group.collapsed).toEqual(['anacyclosis']);
    expect(query.card).toEqual(['gist']);
  });
  test('field remapping keeps recipe detail and missing-field removal clears every reference', () => {
    const query = { ...typeQuery(null), filters: [{ field: 'old', op: 'present' as const, value: null }],
      sort: [{ by: 'field' as const, field: 'old', direction: 'desc' as const }],
      columns: [{ key: '@title', width: 240 }, { key: 'old', width: 317 }],
      group: { key: 'old', collapsed: ['old', 'Other heading'] }, card: ['old'],
      note_view: { layout: 'table' as const, grouping: 'field:old' }, purpose: 'Keep me.',
    };
    const remapped = remapQueryField(query, 'old', 'survivor');
    expect(queryFieldIds(remapped)).toEqual(['survivor']);
    expect(remapped.columns).toEqual([{ key: '@title', width: 240 }, { key: 'survivor', width: 317 }]);
    expect(remapped.group).toEqual({ key: 'survivor', collapsed: ['survivor', 'Other heading'] });
    expect(remapped.note_view?.grouping).toBe('field:survivor');
    expect(query.filters[0]!.field).toBe('old');
    const missing = { ...query, field_names: { old: 'Publisher' } };
    expect(missingQueryFields(missing, [])).toEqual([{ id: 'old', name: 'Publisher' }]);
    expect(filterLabel(missing.filters[0]!, [], {} as NotebookClient, missing.field_names)).toBe('Publisher has the field');
    expect(sortLabel(missing.sort[0]!, [], missing.field_names)).toBe('Publisher ↓');
    const copy = copyQuery(missing); copy.field_names!.old = 'Other';
    expect(missing.field_names.old).toBe('Publisher');
    expect(queriesEqual(missing, copy)).toBe(false);
    const removed = removeQueryField(missing, 'old');
    expect(queryFieldIds(removed)).toEqual([]);
    expect(removed.field_names).toBeUndefined();
    expect(removed.columns).toEqual([{ key: '@title', width: 240 }]);
    expect(removed.group).toBeUndefined();
    expect(removed.note_view?.grouping).toBe('letter');
    expect(removed.source).toBe('notes');
    expect(removed.purpose).toBe('Keep me.');
  });
});
describe('field entry input rule', () => {
  test('matches names case-preservingly and retains the value after one optional space', () => {
    expect(matchFieldEntry('Author:: Frank Herbert')).toEqual({ name: 'Author', value: 'Frank Herbert' });
    expect(matchFieldEntry(' Read on ::2026-03-02')).toEqual({ name: 'Read on', value: '2026-03-02' });
    expect(matchFieldEntry('Author::')).toEqual({ name: 'Author', value: '' });
    expect(matchFieldEntry('Author::  Frank Herbert')).toEqual({ name: 'Author', value: ' Frank Herbert' });
    expect(matchFieldEntry('A'.repeat(60) + '::yes')).toEqual({ name: 'A'.repeat(60), value: 'yes' });
  });
  test('rejects tags, references, extra colons, blank names, and overlong names', () => {
    for (const text of ['#Author:: value', '[[Author]]:: value', 'A:B:: value', ' :: value', 'A'.repeat(61) + '::value', 'Author: value', 'Author::value\nnext']) expect(matchFieldEntry(text)).toBeNull();
  });
  test('keeps cards, cloze drafts and shielded literals out of field conversion', () => {
    for (const text of [
      '{{c1::answer}}', 'The {{c01::term::hint}} is important', '{{c0::answer}}', '{{c1::',
      'front >> back::suffix', 'front << back::suffix', 'front <> back::suffix',
      String.raw`\{{c1::literal}}`, '`{{c1::literal}}`', '`Author:: literal`', String.raw`Author\:: literal`,
    ]) expect(matchFieldEntry(text)).toBeNull();
  });
  test('retains card and code syntax inside an explicit field value', () => {
    for (const value of ['{{c1::Plato}}', 'question >> answer', 'word <> meaning', '`literal::text`', String.raw`\{{c1::literal}}`]) {
      expect(matchFieldEntry(`Prompt:: ${value}`)).toEqual({ name: 'Prompt', value });
    }
    expect(matchFieldEntry('front :: back')).toEqual({ name: 'front', value: 'back' });
  });
  test('rewrites stable references and identifies only whole-entry references', () => {
    expect(fieldEntryText('field-id')).toBe('[[field-id]]');
    expect(fieldEntryId(' [[field-id|Author]] ')).toBe('field-id');
    expect(fieldEntryId('[[field-id]]')).toBe('field-id');
    expect(fieldEntryId('[[field-id]] more')).toBeNull();
    expect(fieldEntryId('[[field-id]] [[other]]')).toBeNull();
  });
});
