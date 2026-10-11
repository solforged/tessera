import { describe, expect, test } from 'bun:test';
import { CHARACTERS_PER_MINUTE, CHUNK_LIMIT, pageChunk, timeLeft } from './paged';

describe('pageChunk', () => {
  const book = [{ ordinal: 0, level: 1 }, { ordinal: 2, level: 2 }, { ordinal: 40, level: 2 }, { ordinal: 41, level: 3 }, { ordinal: 90, level: 2 }];

  test('a chapter runs from its heading to the next chapter, ignoring a lone title and subsections', () => {
    expect(pageChunk(book, 120, 2)).toEqual({ first: 2, last: 39 });
    expect(pageChunk(book, 120, 60)).toEqual({ first: 40, last: 89 });
    expect(pageChunk(book, 120, 119)).toEqual({ first: 90, last: 119 });
  });

  test('front matter before the first chapter is its own chunk', () => {
    expect(pageChunk(book, 120, 1)).toEqual({ first: 0, last: 1 });
  });

  test('chapters inside a part that is only a title page start their own chunks; a chapter with opening pages keeps its sections', () => {
    const parts = [
      { ordinal: 0, level: 1, start: 0 }, { ordinal: 1, level: 2, start: 100 }, { ordinal: 30, level: 2, start: 40_000 },
      { ordinal: 60, level: 1, start: 80_000 }, { ordinal: 70, level: 2, start: 90_000 }, { ordinal: 80, level: 2, start: 95_000 },
    ];
    expect(pageChunk(parts, 100, 0)).toEqual({ first: 0, last: 0 });
    expect(pageChunk(parts, 100, 40)).toEqual({ first: 30, last: 59 });
    expect(pageChunk(parts, 100, 75)).toEqual({ first: 60, last: 99 });
  });

  test('long or untitled stretches split at fixed points, so neighbours agree on their edges', () => {
    const total = CHUNK_LIMIT * 2 + 10;
    expect(pageChunk([], total, 0)).toEqual({ first: 0, last: CHUNK_LIMIT - 1 });
    expect(pageChunk([], total, CHUNK_LIMIT)).toEqual({ first: CHUNK_LIMIT, last: CHUNK_LIMIT * 2 - 1 });
    expect(pageChunk([], total, total - 1)).toEqual({ first: CHUNK_LIMIT * 2, last: total - 1 });
    expect(pageChunk([{ ordinal: 5, level: 1 }, { ordinal: 500, level: 1 }], 600, 5 + CHUNK_LIMIT)).toEqual({ first: 5 + CHUNK_LIMIT, last: 5 + CHUNK_LIMIT * 2 - 1 });
  });
});

describe('timeLeft', () => {
  test('rounds to whole minutes, says <1 min under half a minute, and switches to hours at an hour', () => {
    expect(timeLeft(0)).toBe('<1 min');
    expect(timeLeft(CHARACTERS_PER_MINUTE * 0.4)).toBe('<1 min');
    expect(timeLeft(CHARACTERS_PER_MINUTE * 6.4)).toBe('6 min');
    expect(timeLeft(CHARACTERS_PER_MINUTE * 59.4)).toBe('59 min');
    expect(timeLeft(CHARACTERS_PER_MINUTE * 59.6)).toBe('1 h');
    expect(timeLeft(CHARACTERS_PER_MINUTE * 80)).toBe('1 h 20 min');
  });
});
