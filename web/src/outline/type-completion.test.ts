import { describe, expect, test } from 'bun:test';
import { typeSpelling, typeTokenAt } from './type-completion';

const atEnd = (text: string) => typeTokenAt(text, text.length);

describe('type completion tokens', () => {
  test('requires a query at block start or after whitespace', () => {
    expect(atEnd('#bo')).toEqual({ from: 0, to: 3, query: 'bo' });
    expect(atEnd('Read #Book')).toEqual({ from: 5, to: 10, query: 'Book' });
    expect(atEnd('Read\t#書籍_2/notes')).toEqual({ from: 5, to: 16, query: '書籍_2/notes' });
    expect(atEnd('#C++')?.query).toBe('C++');
    for (const text of ['#', '# ', '##', '##heading', 'a#b', 'https://site.test/#fragment', '#Book ', '#Book\n']) {
      expect(atEnd(text)).toBeNull();
    }
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
    for (const text of ['[[source #bo', '[[source| #bo]]', '#[[Long #bo', '` #bo', '`` #bo``', '```md\n#bo', '~~~\n#bo']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(typeTokenAt('((source #bo', 12)).toBeNull();
    expect(atEnd('[[source]] #bo')?.query).toBe('bo');
    expect(atEnd('`literal` #bo')?.query).toBe('bo');
    expect(atEnd('```md\ncode\n```\n#bo')?.query).toBe('bo');
    for (const text of ['[[source #bo]]', '` #bo`', '((source #bo))']) {
      expect(typeTokenAt(text, text.indexOf('#bo') + 3)).toBeNull();
    }
    expect(atEnd('`((literal` #bo')?.query).toBe('bo');
    expect(atEnd(String.raw`\((literal #bo`)?.query).toBe('bo');
  });

  test('leaves card, cloze and field shorthand to their own syntax', () => {
    for (const text of ['Author:: #bo', ':: #bo', 'front >> #bo', '#bo <> back', '{{c1:: #bo', '{{c1:: #bo}}']) {
      expect(atEnd(text)).toBeNull();
    }
    const cloze = '{{c1:: #bo}}';
    expect(typeTokenAt(cloze, cloze.length - 2)).toBeNull();
    expect(atEnd('{{c1::answer}} #bo')?.query).toBe('bo');
    expect(typeTokenAt('#bo >> back', 3)).toBeNull();
  });
});

describe('type spelling', () => {
  test('keeps inline titles unbracketed and protects multiword or punctuated titles', () => {
    expect(typeSpelling('Book')).toBe('#Book');
    expect(typeSpelling('書籍_2/notes-book')).toBe('#書籍_2/notes-book');
    expect(typeSpelling('Reading list')).toBe('#[[Reading list]]');
    expect(typeSpelling('C++')).toBe('#[[C++]]');
  });
});
