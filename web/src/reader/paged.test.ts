import { describe, expect, test } from 'bun:test';
import { CHUNK_LIMIT, pageChunk } from './paged';

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

  test('long or untitled stretches split at fixed points, so neighbours agree on their edges', () => {
    const total = CHUNK_LIMIT * 2 + 10;
    expect(pageChunk([], total, 0)).toEqual({ first: 0, last: CHUNK_LIMIT - 1 });
    expect(pageChunk([], total, CHUNK_LIMIT)).toEqual({ first: CHUNK_LIMIT, last: CHUNK_LIMIT * 2 - 1 });
    expect(pageChunk([], total, total - 1)).toEqual({ first: CHUNK_LIMIT * 2, last: total - 1 });
    expect(pageChunk([{ ordinal: 5, level: 1 }, { ordinal: 500, level: 1 }], 600, 5 + CHUNK_LIMIT)).toEqual({ first: 5 + CHUNK_LIMIT, last: 5 + CHUNK_LIMIT * 2 - 1 });
  });
});
