import { describe, expect, test } from 'bun:test';
import type { Block } from '../api/types';
import { similarPages } from './details';

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
