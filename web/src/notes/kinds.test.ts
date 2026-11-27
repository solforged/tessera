import { expect, test } from 'bun:test';
import type { IndexKind } from '../api/types';
import { eyebrowNamesTag, indexKindTarget, kindLabel, noteKindIcon } from './kinds';

const kind = (over: Partial<IndexKind> = {}): IndexKind => ({
  key: 'type:1',
  name: 'arabic',
  plural: 'arabics',
  icon: null,
  type_id: '1',
  count: 0,
  tagged_block_count: 1,
  cards: 0,
  fields: [],
  tag: true,
  shelf: 'tags',
  ...over,
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
  expect(noteKindIcon('unfiled')).toBe('page');
  expect(noteKindIcon('all')).toBe('contents');
  expect(noteKindIcon('unknown')).toBe('tag');
  expect(noteKindIcon({ key: 'project', icon: 'book' })).toBe('book');
  expect(noteKindIcon({ key: 'question', icon: 'unknown' })).toBe('tag');
});

test('a title tag for a kind the eyebrow names is not repeated, by page for a canonical tag and by name for a legacy one', () => {
  const eyebrow = [
    { name: 'Concept', type_id: 'concept-page' },
    { name: 'Italian word', type_id: 'italian-page' },
  ];
  expect(eyebrowNamesTag(eyebrow, { id: 'concept-page', value: 'whatever alias' })).toBe(true);
  expect(eyebrowNamesTag(eyebrow, { value: 'concept' })).toBe(true);
  expect(eyebrowNamesTag(eyebrow, { value: 'Italian-word' })).toBe(true);
  expect(eyebrowNamesTag(eyebrow, { id: 'missing-page', value: 'Concept' })).toBe(false);
  expect(eyebrowNamesTag(eyebrow, { value: 'stoic' })).toBe(false);
  expect(eyebrowNamesTag(undefined, { id: 'concept-page', value: 'concept' })).toBe(false);
});

test('structured and work kinds default to Table while editorial directories default to List', () => {
  expect(
    indexKindTarget(kind({ key: 'project', name: 'Project', plural: 'Projects', type_id: 'proj', count: 3 })).kind,
  ).toBe('table');
  expect(indexKindTarget(kind({ key: 'task', name: 'Task', plural: 'Tasks', type_id: 'task', count: 5 })).kind).toBe(
    'table',
  );
  expect(
    indexKindTarget(kind({ key: 'concept', name: 'Concept', plural: 'Concepts', type_id: 'c', count: 2 })).kind,
  ).toBe('table');
  expect(indexKindTarget(kind({ key: 'person', name: 'Person', plural: 'People', type_id: 'p', count: 4 })).kind).toBe(
    'index',
  );
  expect(
    indexKindTarget(kind({ key: 'source', name: 'Source', plural: 'Sources', type_id: null, count: 4 })).kind,
  ).toBe('index');
  expect(
    indexKindTarget(kind({ key: 'question', name: 'Question', plural: 'Questions', type_id: null, count: 2 })).kind,
  ).toBe('index');
});
