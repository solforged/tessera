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

  test('a part that is only a title page holds chapters, while a chapter with its own opening pages keeps its sections', () => {
    const toc = [
      entry('Cover', 1, 0), entry('Contents', 1, 50), entry('Introduction', 1, 1_000),
      entry('Part I: Trial', 1, 10_000), entry('1. The Count', 2, 10_200), entry('2. Poets', 2, 30_000),
      entry('Part II: Kingdom', 1, 50_000), entry('3. Sigurd', 2, 50_000), entry('4. Fields', 2, 70_000),
      entry('V. Transformation', 1, 90_000), entry('1. Representation', 2, 95_000), entry('2. Rights', 2, 110_000),
      entry('Index', 1, 130_000),
    ];
    expect(bookChapters(toc, 140_000)).toEqual([
      { title: '', start: 0, end: 50 }, { title: '', start: 50, end: 1_000 }, { title: 'Introduction', start: 1_000, end: 10_000 },
      { title: 'Part I: Trial', start: 10_000, end: 10_200 }, { title: '1. The Count', start: 10_200, end: 30_000 }, { title: '2. Poets', start: 30_000, end: 50_000 },
      // A chapter that starts with its part takes the part's place.
      { title: '3. Sigurd', start: 50_000, end: 70_000 }, { title: '4. Fields', start: 70_000, end: 90_000 },
      { title: 'V. Transformation', start: 90_000, end: 130_000 }, { title: 'Index', start: 130_000, end: 140_000 },
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
