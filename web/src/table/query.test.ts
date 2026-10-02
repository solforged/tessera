import { describe, expect, test } from 'bun:test';
import type { FieldDefinition, FilterOp } from '../api/types';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, filterLabel, matchFieldEntry, queriesEqual, removeFilter, removeSort, sortLabel, typeQuery } from './query';

const fields: FieldDefinition[] = [
  { id: 'author', name: 'Author', kind: 'text', revision: 1, options: [] },
  { id: 'year', name: 'Year', kind: 'number', revision: 1, options: [] },
  { id: 'read', name: 'Read on', kind: 'date', revision: 1, options: [] },
];
describe('query chips', () => {
  test('sorts use readable field and timestamp labels with direction', () => {
    expect(sortLabel({ by: 'field', field: 'author', direction: 'asc' }, fields)).toBe('Author ↑');
    expect(sortLabel({ by: 'field', field: 'author', direction: 'desc' }, fields)).toBe('Author ↓');
    expect(sortLabel({ by: 'title', field: null, direction: 'asc' }, fields)).toBe('Title ↑');
    expect(sortLabel({ by: 'created', field: null, direction: 'desc' }, fields)).toBe('Created ↓');
    expect(sortLabel({ by: 'updated', field: null, direction: 'desc' }, fields)).toBe('Updated ↓');
  });
  test('filters show operators and omit values for presence checks', () => {
    expect(filterLabel({ field: 'author', op: 'contains', value: 'Herbert' }, fields)).toBe('Author contains Herbert');
    expect(filterLabel({ field: 'year', op: 'gte', value: '2000' }, fields)).toBe('Year ≥ 2000');
    expect(filterLabel({ field: 'read', op: 'set', value: null }, fields)).toBe('Read on is set');
    expect(filterLabel({ field: 'read', op: 'empty', value: null }, fields)).toBe('Read on is empty');
    const operators: Partial<Record<FilterOp, string>> = { is: 'is', is_not: 'is not', gt: '>', lt: '<', lte: '≤' };
    for (const [op, label] of Object.entries(operators)) expect(filterLabel({ field: 'year', op: op as FilterOp, value: '10' }, fields)).toBe(`Year ${label} 10`);
  });
});
describe('query edits', () => {
  test('sort choice adds first, replaces without duplicates, and flips direction', () => {
    const initial = typeQuery('books');
    const title = chooseSort(initial, { by: 'title', field: null });
    const author = chooseSort(title, { by: 'field', field: 'author' });
    expect(author.sort).toEqual([{ by: 'field', field: 'author', direction: 'asc' }, { by: 'title', field: null, direction: 'asc' }]);
    expect(chooseSort(author, { by: 'title', field: null }).sort).toEqual([{ by: 'title', field: null, direction: 'desc' }, { by: 'field', field: 'author', direction: 'asc' }]);
    expect(chooseSort(author, { by: 'field', field: 'author' }, 'asc').sort).toEqual(author.sort);
    expect(removeSort(author, 0).sort).toEqual(title.sort);
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
  test('saved equality compares all fields and preserves ordered filters and sort precedence', () => {
    const query = chooseSort(addFilter(addFilter(typeQuery('books'), { field: 'year', op: 'gte', value: '2000' }), { field: 'author', op: 'contains', value: 'Herbert' }), { by: 'title', field: null });
    const copied = copyQuery(query);
    expect(queriesEqual(query, copied)).toBe(true);
    expect(queriesEqual(query, { ...copied, filters: [...copied.filters].reverse() })).toBe(false);
    for (const difference of [{ type: null }, { text: 'Dune' }, { limit: 20 }, { filters: [] }, { sort: [] }]) expect(queriesEqual(query, { ...copied, ...difference })).toBe(false);
    copied.filters[0]!.value = '1999';
    expect(queriesEqual(query, copied)).toBe(false);
    expect(query.filters[0]!.value).toBe('2000');
    const secondary = chooseSort(query, { by: 'updated', field: null });
    expect(queriesEqual(secondary, { ...secondary, sort: [...secondary.sort].reverse() })).toBe(false);
    expect(queriesEqual(query, chooseSort(query, { by: 'title', field: null }))).toBe(false);
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
  test('rewrites stable references and identifies only whole-entry references', () => {
    expect(fieldEntryText('field-id')).toBe('[[field-id]]');
    expect(fieldEntryId(' [[field-id|Author]] ')).toBe('field-id');
    expect(fieldEntryId('[[field-id]]')).toBe('field-id');
    expect(fieldEntryId('[[field-id]] more')).toBeNull();
    expect(fieldEntryId('[[field-id]] [[other]]')).toBeNull();
  });
});
