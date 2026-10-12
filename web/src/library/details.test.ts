import { describe, expect, test } from 'bun:test';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient, PageDocument, SourceDetailsEdit } from '../document/contract';
import { derivedSourceSiglum, saveSourceField, similarPages, sourceFieldValue } from './details';
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
  test('invalid dates, numbers, sigla, titles, states and citation keys fail before writing', async () => {
    const invalid: [SourceField, SourceFieldValue][] = [
      ['published', '2023-02-29'], ['firstPublished', '2024-13'], ['started', '0000'], ['finished', '2024-04-31'],
      ['published', '2024-2'], ['firstPublished', '20'], ['started', '2024-01-01T00:00:00'],
      ['number', 'NaN'], ['number', '0x12'], ['pages', 'Infinity'], ['pages', '1e999'], ['pages', '12 pages'],
      ['siglum', 'ABCDE'], ['siglum', 'A1'], ['siglum', 'A B'], ['title', ' '],
      ['state', 'complete'], ['citationKey', '1book'], ['citationKey', 'has spaces'], ['citationKey', 'A'.repeat(65)],
      ['tags', ['Invalid[tag]']], ['identifiers', 'isbn:9780262033848'],
      ['creators', [{ id: null, name: ' ', role: 'author' }]],
    ];
    for (const [field, value] of invalid) await expect(saveSourceField([], {} as NotebookClient, field, value)).rejects.toThrow();
  });

  test('valid partial dates, finite numbers and blank optional values reach the shared planner', async () => {
    const definitions: FieldDefinition[] = [
      { id: 'date', name: 'Published', kind: 'date', revision: 1, options: [] },
      { id: 'pages', name: 'Pages', kind: 'number', revision: 1, options: [] },
      { id: 'siglum', name: 'Siglum', kind: 'text', revision: 1, options: [] },
    ];
    const captured: SourceDetailsEdit[] = [];
    const doc = { pageId: 'page', status: () => 'ready', flush: async () => {}, outline: { children: () => [] }, root: () => ({ text: 'Source' }) } as unknown as PageDocument;
    const notebook = {
      api: { fields: async () => ({ page_id: 'fields', fields: definitions }) },
      editSourceDetails: async (edits: { edit: SourceDetailsEdit }[]) => {
        captured.push(...edits.map(item => item.edit));
        return { undo: async () => {}, redo: async () => {} };
      },
    } as unknown as NotebookClient;
    for (const value of ['', '0001', '1900', '2024-02', '2024-02-29', '2000-02-29']) {
      await saveSourceField([doc], notebook, 'published', value);
      expect(captured.at(-1)!.fields[0]?.values).toEqual(value ? [value] : []);
    }
    for (const value of ['', '0', '12.5', '-2', '1e3']) await saveSourceField([doc], notebook, 'pages', value);
    for (const value of ['', 'A', 'AbCD']) await saveSourceField([doc], notebook, 'siglum', value);
  });

  test('identifiers include all live values across repeated entries and creator refs retain ids', () => {
    const definitions: FieldDefinition[] = [
      { id: 'identifiers', name: 'Identifier', kind: 'identifier', revision: 1, options: [] },
      { id: 'author', name: 'Author', kind: 'instance', revision: 1, options: [] },
    ];
    const children: Record<string, string[]> = { page: ['entry1', 'entry2', 'authors'], entry1: ['isbn', 'blank'], entry2: ['doi', 'archived'], authors: ['person1', 'person2'] };
    const text: Record<string, string> = { entry1: '[[identifiers]]', entry2: 'Identifier::', authors: '[[author]]', isbn: 'isbn:9780262033848', blank: '', doi: 'doi:10.1000/example', archived: 'ignored', person1: '[[person-id]]', person2: 'Unlinked author' };
    const doc = {
      pageId: 'page', root: () => ({ text: 'A source' }), outline: { children: (id: string) => children[id] ?? [] },
      block: (id: string) => ({ text: text[id], archived: id === 'archived' }),
    } as unknown as PageDocument;
    const notebook = { lookup: () => () => ({ text: 'Linked person' }) } as unknown as NotebookClient;
    expect(sourceFieldValue(doc, notebook, definitions, 'identifiers')).toEqual(['isbn:9780262033848', 'doi:10.1000/example']);
    expect(sourceFieldValue(doc, notebook, definitions, 'creators')).toEqual([
      { id: 'person-id', name: 'Linked person', role: 'author' }, { id: null, name: 'Unlinked author', role: 'author' },
    ]);
  });
});

test('derived siglum keeps its real basis independent of an authored override', () => {
  expect(derivedSourceSiglum([{ id: 'wood', name: 'Ellen Meiksins Wood', role: 'author' }], '', 'Citizens to Lords')).toEqual({ mark: 'WOO', basis: 'Wood' });
  expect(derivedSourceSiglum([{ id: 'marx', name: 'Marx, Karl', role: 'author' }], '', 'The Marx-Engels Reader')).toEqual({ mark: 'MAR', basis: 'Marx' });
  expect(derivedSourceSiglum([{ id: 'editor', name: 'Émile Zola', role: 'editor' }], '', '123 Title')).toEqual({ mark: 'ZOL', basis: 'Zola' });
  expect(derivedSourceSiglum([], 'L’Œuvre', 'Title')).toEqual({ mark: 'LŒU', basis: 'LŒuvre' });
  expect(derivedSourceSiglum([], '', '123 The work')).toEqual({ mark: 'THE', basis: 'The' });
});
