import { expect, test } from 'bun:test';
import type { IndexKind } from '../api/types';
import { kindLabel, noteKindIcon } from './kinds';

const kind = (over: Partial<IndexKind> = {}): IndexKind => ({
  key: 'type:1', name: 'arabic', plural: 'arabics', icon: null, type_id: '1',
  count: 0, tagged_block_count: 1, cards: 0, fields: [], tag: true, shelf: 'tags', ...over,
});

test('a tag-only kind keeps the spelling you wrote', () => {
  expect(kindLabel(kind())).toBe('arabic');
  expect(kindLabel(kind({ plural: 'Arabic studies' }))).toBe('Arabic studies');
  expect(kindLabel(kind({ name: 'Italian word', plural: 'Italian words' }))).toBe('Italian word');
  expect(kindLabel(kind({ name: 'Italian vocabulary', plural: 'Italian vocabularies' }))).toBe('Italian vocabulary');
  expect(kindLabel(kind({ key: 'type:2', name: 'Book', plural: 'Books', count: 2 }))).toBe('Books');
  expect(kindLabel(kind({ key: 'person', name: 'Person', plural: 'People', type_id: 'p' }))).toBe('People');
});

test('shell capabilities have their glyphs without overriding registry icons', () => {
  expect(noteKindIcon('question')).toBe('question-open');
  expect(noteKindIcon('project')).toBe('flag');
  expect(noteKindIcon('all')).toBe('contents');
  expect(noteKindIcon('unknown')).toBe('tag');
  expect(noteKindIcon({ key: 'project', icon: 'book' })).toBe('book');
  expect(noteKindIcon({ key: 'question', icon: 'unknown' })).toBe('tag');
});
