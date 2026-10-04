import { describe, expect, test } from 'bun:test';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, matchFieldEntry, queriesEqual, removeFilter, removeSort, typeQuery } from './query';

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
