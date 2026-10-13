import { describe, expect, test } from 'bun:test';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient, PageDocument, SourceDetailsEdit } from '../document/contract';
import { derivedSourceSiglum, saveSourceField, similarPages, sourceFieldValue, sourceMetadata, validateSourceValue } from './details';
import type { SourceField, SourceFieldValue } from './details';

const page = (text: string, kind: Block['kind'] = 'page', archived = false): Block => ({ id: text, kind, parent_id: null, page_id: text, text, archived } as Block);
const titles = (name: string, pages: Block[]) => similarPages(name, pages).map(block => block.text);

describe('similarPages', () => {
  const people = [page('Marcus Aurelius'), page('Bowen, William G.'), page('Platonism'), page("Plato's Republic"), page('Émile Zola')];

  test('matches reordered names, initials, a dropped middle name and accents', () => {
    expect(titles('Aurelius, Marcus', people)).toEqual(['Marcus Aurelius']);
    expect(titles('M. Aurelius', people)).toEqual(['Marcus Aurelius']);
    expect(titles('Marcus Aurelius Antoninus', people)).toEqual(['Marcus Aurelius']);
    expect(titles('William Bowen', people)).toEqual(['Bowen, William G.']);
    expect(titles('Emile Zola', people)).toEqual(['Émile Zola']);
  });

  test('leaves out the exact title, prefixes without a whole word, distant titles and journals', () => {
    expect(titles('marcus aurelius', people)).toEqual([]);
    expect(titles('Marc Aurel', people)).toEqual([]);
    expect(titles('Plato', people)).toEqual([]);
    expect(titles('Aurelius', [page('Marcus Aurelius', 'journal'), page('Marcus Aurelius', 'page', true)])).toEqual([]);
  });
});

describe('source field validation', () => {
  test('rejects invalid bibliographic values', () => {
    const invalid: [SourceField, SourceFieldValue][] = [
      ['published', '2023-02-29'], ['firstPublished', '2024-13'], ['started', '0000'], ['finished', '2024-04-31'],
      ['published', '2024-2'], ['firstPublished', '20'], ['started', '2024-01-01T00:00:00'],
      ['number', 'NaN'], ['number', '0x12'], ['pages', 'Infinity'], ['pages', '1e999'], ['pages', '12 pages'],
      ['pages', '-12'], ['pages', '0'], ['pages', '2.5'], ['pages', '2.0000000000000001'], ['pages', '9007199254740992'],
      ['siglum', 'ABCDE'], ['siglum', 'A1'], ['siglum', 'A B'], ['title', ' '],
      ['state', 'complete'], ['citationKey', '1book'], ['citationKey', 'has spaces'], ['citationKey', 'A'.repeat(65)],
      ['tags', ['Invalid[tag]']], ['identifiers', 'isbn:9780262033848'],
      ['creators', [{ id: null, name: ' ', role: 'author' }]],
    ];
    for (const [field, value] of invalid) expect(() => validateSourceValue(field, value)).toThrow();
  });

  test('preserves partial dates and optional blanks while scoping whole counts to Pages', () => {
    for (const value of ['', '0001', '1900', '2024-02', '2024-02-29', '2000-02-29']) {
      expect(validateSourceValue('published', ` ${value} `)).toBe(value);
    }
    for (const value of ['', '0', '12.5', '-2', '1e3']) expect(validateSourceValue('number', value)).toBe(value);
    for (const value of ['', '1', '120', '9007199254740991']) expect(validateSourceValue('pages', value)).toBe(value);
    expect(validateSourceValue('siglum', ' AbCD ')).toBe('AbCD');
  });

  test('identifiers include all live values across repeated entries and creator refs retain ids', () => {
    const definitions: FieldDefinition[] = [
      { id: 'identifiers', name: 'Identifier', kind: 'identifier', revision: 1, options: [], targets: [] },
      { id: 'author', name: 'Author', kind: 'instance', revision: 1, options: [], targets: [] },
    ];
    const children: Record<string, string[]> = { page: ['entry1', 'entry2', 'authors'], entry1: ['isbn', 'blank'], entry2: ['doi', 'archived'], authors: ['person1', 'person2', 'person3'] };
    const text: Record<string, string> = { entry1: '[[identifiers]]', entry2: 'Identifier::', authors: '[[author]]', isbn: 'isbn:9780262033848', blank: '', doi: 'doi:10.1000/example', archived: 'ignored', person1: '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]', person2: 'Unlinked author', person3: '[[Arnold J. Toynbee]]' };
    const doc = {
      pageId: 'page', root: () => ({ text: 'A source' }), outline: { children: (id: string) => children[id] ?? [] },
      block: (id: string) => ({ text: text[id], archived: id === 'archived' }),
    } as unknown as PageDocument;
    const notebook = { lookup: () => () => ({ text: 'Linked person' }) } as unknown as NotebookClient;
    expect(sourceFieldValue(doc, notebook, definitions, 'identifiers')).toEqual(['isbn:9780262033848', 'doi:10.1000/example']);
    expect(sourceFieldValue(doc, notebook, definitions, 'creators')).toEqual([
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Linked person', role: 'author' }, { id: null, name: 'Unlinked author', role: 'author' }, { id: null, name: 'Arnold J. Toynbee', role: 'author' },
    ]);
    expect(sourceMetadata(doc, notebook, definitions).creators).toEqual([
      { name: 'Linked person', role: 'author', create_page: true }, { name: 'Unlinked author', role: 'author', create_page: false },
    ]);
  });
});

test('saving a title-form creator uses an eligible alias, not a source title or an invalid ID', async () => {
  const person = { ...page('Arnold Toynbee'), id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
  const source = { ...page('Arnold J. Toynbee'), id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
  const doc = { pageId: 'book', status: () => 'ready', flush: async () => {}, outline: { children: () => [] } } as unknown as PageDocument;
  let written: SourceDetailsEdit | undefined;
  const notebook = { changeSequence: () => 0, api: {
    fields: async () => ({ page_id: 'fields', fields: [{ id: 'author', name: 'Author', kind: 'instance', targets: [] }] }),
    resolveName: async () => [{ page: source, alias: null }, { page: person, alias: 'Arnold J. Toynbee' }],
    noteKinds: async (id: string) => [{ key: id === person.id ? 'person' : 'source' }],
  }, editSourceDetails: async (edits: { edit: SourceDetailsEdit }[]) => { written = edits[0]!.edit; return { undo: async () => {}, redo: async () => {} }; },
  } as unknown as NotebookClient;
  await saveSourceField([doc], notebook, 'creators', [{ id: null, name: '[[Arnold J. Toynbee]]', role: 'author' }]);
  expect(written?.fields[0]?.values).toEqual([`[[${person.id}]]`]);
});

test('derived siglum keeps its real basis independent of an authored override', () => {
  expect(derivedSourceSiglum([{ id: 'wood', name: 'Ellen Meiksins Wood', role: 'author' }], '', 'Citizens to Lords')).toEqual({ mark: 'WOO', basis: 'Wood' });
  expect(derivedSourceSiglum([{ id: 'marx', name: 'Marx, Karl', role: 'author' }], '', 'The Marx-Engels Reader')).toEqual({ mark: 'MAR', basis: 'Marx' });
  expect(derivedSourceSiglum([{ id: 'editor', name: 'Émile Zola', role: 'editor' }], '', '123 Title')).toEqual({ mark: 'ZOL', basis: 'Zola' });
  expect(derivedSourceSiglum([], 'L’Œuvre', 'Title')).toEqual({ mark: 'LŒU', basis: 'LŒuvre' });
  expect(derivedSourceSiglum([], '', '123 The work')).toEqual({ mark: 'THE', basis: 'The' });
});
