import { describe, expect, test } from 'bun:test';
import { completeTypes, typeChoiceSpelling, typeSpelling, typeTokenAt } from './type-completion';
import type { NotebookClient } from '../document/contract';
import type { Block } from '../api/types';

const atEnd = (text: string) => typeTokenAt(text, text.length);

describe('type completion tokens', () => {
  test('opens on a bare hash at block start or after whitespace', () => {
    expect(atEnd('#')).toEqual({ from: 0, to: 1, query: '' });
    expect(atEnd('Read #')).toEqual({ from: 5, to: 6, query: '' });
    expect(atEnd('#bo')).toEqual({ from: 0, to: 3, query: 'bo' });
    expect(atEnd('Read #Book')).toEqual({ from: 5, to: 10, query: 'Book' });
    expect(atEnd('Read\t#書籍_2/notes')).toEqual({ from: 5, to: 16, query: '書籍_2/notes' });
    expect(atEnd('#C++')?.query).toBe('C++');
    for (const text of ['# ', '##', '##heading', 'a#b', 'https://site.test/#fragment', '#Book ', '#Book\n', '#123', 'Read #１２３', '`#', '`#`']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(typeTokenAt('Read # next', 6)).toBeNull();
    expect(typeTokenAt('Read `#`', 7)).toBeNull();
  });

  test('uses the caret boundary and does not fall back to earlier tokens', () => {
    expect(typeTokenAt('Read #bo then prose', 8)).toEqual({ from: 5, to: 8, query: 'bo' });
    expect(atEnd('#Book a#b')).toBeNull();
    expect(typeTokenAt('#bo', 0)).toBeNull();
    expect(typeTokenAt('#bo', 4)).toBeNull();
    expect(atEnd(String.raw`\#bo`)).toBeNull();
  });

  test('takes the whole tag word when the caret is moved back into it', () => {
    expect(typeTokenAt('C #philo after', 6)).toEqual({ from: 2, to: 8, query: 'philo' });
    expect(typeTokenAt('#bo:ok', 2)).toEqual({ from: 0, to: 3, query: 'bo' });
  });

  test('shields references, block references, inline code and code fences', () => {
    for (const text of ['[[source #bo', '[[source| #bo]]', '#[[Long #bo', '` #bo`', '`` #bo``', '```md\n#bo', '~~~\n#bo']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(typeTokenAt('((source #bo', 12)).toBeNull();
    expect(atEnd('[[source]] #bo')?.query).toBe('bo');
    expect(atEnd('`literal` #bo')?.query).toBe('bo');
    expect(atEnd('it`s about #history')).toBeNull();
    expect(atEnd('```md\ncode\n```\n#bo')?.query).toBe('bo');
    for (const text of ['[[source #bo]]', '` #bo`', '((source #bo))']) {
      expect(typeTokenAt(text, text.indexOf('#bo') + 3)).toBeNull();
    }
    expect(atEnd('`((literal` #bo')?.query).toBe('bo');
    expect(atEnd(String.raw`\((literal #bo`)?.query).toBe('bo');
  });

  test('completes on card blocks but leaves cloze spans and field shorthand to their own syntax', () => {
    for (const text of ['Author:: #bo', ':: #bo', '{{c1:: #bo', '{{c1:: #bo}}']) {
      expect(atEnd(text)).toBeNull();
    }
    const cloze = '{{c1:: #bo}}';
    expect(typeTokenAt(cloze, cloze.length - 2)).toBeNull();
    expect(atEnd('{{c1::answer}} #bo')?.query).toBe('bo');
    expect(atEnd('front >> #bo')?.query).toBe('bo');
    expect(atEnd('#bo <> back')).toBeNull();
    expect(typeTokenAt('#bo >> back', 3)?.query).toBe('bo');
  });
});

test('type completion excludes note bodies, matches registered type aliases and offers absent built-in tags', async () => {
  const type = { id: 'type', kind: 'page', text: 'idea', archived: false } as Block;
  const prose = { id: 'prose', kind: 'block', text: '[[person|Plato]] describes an ideal city', archived: false } as Block;
  const kinds = [
    { key: 'person', name: 'Person', icon: 'person', type_id: null, tag: true },
    { key: 'question', name: 'Question', icon: 'question-open', type_id: null, tag: false },
    { key: 'type:type', name: 'idea', icon: null, type_id: 'type', tag: true },
  ];
  const notebook = { roots: () => [type], changeSequence: () => 0, api: {
    types: async () => [{ page: type }],
    noteIndex: async () => ({ kinds }),
    complete: async () => [{ ...type, alias: 'idéa' }, { ...prose, alias: null }],
    resolveName: async () => [{ page: type, alias: 'idéa' }],
  } } as unknown as NotebookClient;
  expect(await completeTypes(notebook, 'idéa')).toEqual({ rows: [{ ...type, alias: 'idéa', icon: null }], canCreate: false });
  const absent = { roots: () => [type], changeSequence: () => 0, api: {
    types: async () => [{ page: type }],
    noteIndex: async () => ({ kinds }),
    complete: async () => [],
    resolveName: async () => [],
  } } as unknown as NotebookClient;
  const person = await completeTypes(absent, 'pers');
  expect(person.rows.map(row => [row.text, row.icon, row.id])).toEqual([['Person', 'person', '']]);
  expect(person.canCreate).toBe(true);
  expect((await completeTypes(absent, 'Person')).canCreate).toBe(false);
  expect((await completeTypes(absent, 'quest')).rows).toEqual([]);
});

test('a bare hash puts the four behavior tags first, retaining existing IDs and registry glyphs', async () => {
  const essay = { id: 'essay', kind: 'page', text: 'essay', archived: false } as Block;
  const task = { id: 'task-page', kind: 'page', text: 'Task', archived: false } as Block;
  const kinds = [
    { key: 'person', name: 'Person', icon: 'person', type_id: null, tag: true },
    { key: 'source', name: 'Source', icon: 'library', type_id: null, tag: true },
    { key: 'task', name: 'Task', icon: 'task', type_id: task.id, tag: true },
    { key: 'project', name: 'Project', icon: 'flag', type_id: null, tag: true },
    { key: 'question', name: 'Question', icon: 'question-open', type_id: null, tag: true },
  ];
  const notebook = { api: {
    types: async () => [{ page: essay }, { page: task }],
    noteIndex: async () => ({ kinds }),
  } } as unknown as NotebookClient;
  const result = await completeTypes(notebook, '');
  expect(result.rows.map(row => [row.text, row.icon, row.id])).toEqual([
    ['Task', 'task', task.id],
    ['Question', 'question-open', ''],
    ['Project', 'flag', ''],
    ['Source', 'library', ''],
    ['essay', null, essay.id],
    ['Person', 'person', ''],
  ]);
  expect(result.canCreate).toBe(false);
});

describe('type spelling', () => {
  test('keeps inline titles unbracketed and protects multiword or punctuated titles', () => {
    expect(typeSpelling('Book')).toBe('#Book');
    expect(typeSpelling('書籍_2/notes-book')).toBe('#書籍_2/notes-book');
    expect(typeSpelling('हिन्दी')).toBe('#हिन्दी');
    expect(typeSpelling('cafe\u0301')).toBe('#cafe\u0301');
    expect(typeSpelling('Reading list')).toBe('#[[Reading list]]');
    expect(typeSpelling('C++')).toBe('#[[C++]]');
  });

  test('existing picker choices insert identity and the current title, not the search spelling', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(typeChoiceSpelling('arab', 'Arabe', id)).toBe(`#[[${id}|Arabe]]`);
    expect(typeChoiceSpelling('ARABE', 'Arabe', id)).toBe(`#[[${id}|Arabe]]`);
    expect(typeSpelling('Reading list', id)).toBe(`#[[${id}|Reading list]]`);
  });

  test('accepting a type that matches the typed tag ignoring case keeps the typed spelling', () => {
    expect(typeChoiceSpelling('proposition', 'Proposition')).toBe('#proposition');
    expect(typeChoiceSpelling('PROPOSITION', 'Proposition')).toBe('#PROPOSITION');
    expect(typeChoiceSpelling('c++', 'C++')).toBe('#[[c++]]');
    // A prefix picks the title, spelled as the title.
    expect(typeChoiceSpelling('prop', 'Proposition')).toBe('#Proposition');
  });
});
