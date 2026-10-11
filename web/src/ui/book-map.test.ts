import { describe, expect, test } from 'bun:test';
import { bookChapters, chapterAt } from './book-map';

const entry = (title: string, level: number, start?: number) => ({ title, locator: title, level, ordinal: null, start });

describe('bookChapters', () => {
  test('takes the outermost level with two entries, skips a lone title, and keeps front matter as its own stretch', () => {
    const toc = [entry('Book', 1, 100), entry('One', 2, 300), entry('One.1', 3, 400), entry('Two', 2, 700), entry('Lost', 2)];
    expect(bookChapters(toc, 1000)).toEqual([
      { title: '', start: 0, end: 300 }, { title: 'One', start: 300, end: 700 }, { title: 'Two', start: 700, end: 1000 },
    ]);
  });

  test('is one stretch when no level repeats, and empty for an empty text', () => {
    expect(bookChapters([entry('Only', 1, 0)], 500)).toEqual([{ title: '', start: 0, end: 500 }]);
    expect(bookChapters([entry('A', 1, 0), entry('B', 1, 10)], 0)).toEqual([]);
  });
});

describe('chapterAt', () => {
  test('finds the chapter holding an offset, and the last one at the very end', () => {
    const chapters = [{ title: 'A', start: 0, end: 10 }, { title: 'B', start: 10, end: 20 }];
    expect(chapterAt(chapters, 10)?.index).toBe(1);
    expect(chapterAt(chapters, 20)?.index).toBe(1);
    expect(chapterAt([], 5)).toBeNull();
  });
});
