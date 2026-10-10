/** Passages laid out together in paged reading; a chunk always starts on a fresh page. */
export interface PageChunk { first: number; last: number }

/** Long or untitled stretches split every this many passages, to bound the work of one layout. */
export const CHUNK_LIMIT = 150;

/**
 * The chunk holding `ordinal`. Chunks follow the outermost level of the contents that has at least
 * two entries, so each chapter starts on a fresh page as in a printed book; a book's single title
 * heading does not count as a level.
 */
export function pageChunk(sections: readonly { ordinal: number; level: number }[], total: number, ordinal: number): PageChunk {
  const counts = new Map<number, number>();
  for (const section of sections) counts.set(section.level, (counts.get(section.level) ?? 0) + 1);
  const level = Math.min(...[...counts].filter(([, count]) => count > 1).map(([value]) => value));
  let first = 0, end = total;
  for (const section of sections) {
    if (section.level !== level) continue;
    if (section.ordinal <= ordinal) first = Math.max(first, section.ordinal);
    else end = Math.min(end, section.ordinal);
  }
  const from = first + Math.floor((ordinal - first) / CHUNK_LIMIT) * CHUNK_LIMIT;
  return { first: from, last: Math.min(end, from + CHUNK_LIMIT) - 1 };
}
