/** Passages laid out together in paged reading; a chunk always starts on a fresh page. */
export interface PageChunk { first: number; last: number }

/** Long or untitled stretches split every this many passages, to bound the work of one layout. */
export const CHUNK_LIMIT = 150;

/**
 * The chapter holding `ordinal`, from its first passage up to (not including) the next chapter's. Chapters are the
 * outermost level of the contents that has at least two entries, as in a printed book; a book's single title
 * heading does not count as a level. Front matter before the first chapter is a chapter of its own.
 */
export function chapterAt(sections: readonly { ordinal: number; level: number }[], total: number, ordinal: number): { first: number; end: number } {
  const counts = new Map<number, number>();
  for (const section of sections) counts.set(section.level, (counts.get(section.level) ?? 0) + 1);
  const level = Math.min(...[...counts].filter(([, count]) => count > 1).map(([value]) => value));
  let first = 0, end = total;
  for (const section of sections) {
    if (section.level !== level) continue;
    if (section.ordinal <= ordinal) first = Math.max(first, section.ordinal);
    else end = Math.min(end, section.ordinal);
  }
  return { first, end };
}

/** The chunk holding `ordinal`: its chapter, split every `CHUNK_LIMIT` passages so each chapter starts on a fresh page. */
export function pageChunk(sections: readonly { ordinal: number; level: number }[], total: number, ordinal: number): PageChunk {
  const { first, end } = chapterAt(sections, total, ordinal);
  const from = first + Math.floor((ordinal - first) / CHUNK_LIMIT) * CHUNK_LIMIT;
  return { first: from, last: Math.min(end, from + CHUNK_LIMIT) - 1 };
}

/** Reading speed for time-left estimates: 250 words a minute at about six characters a word, spaces included. */
export const CHARACTERS_PER_MINUTE = 1500;

/** Time left for `characters` of text, as a reader would say it: `<1 min`, `6 min`, `1 h 20 min`, `3 h`. */
export function timeLeft(characters: number): string {
  const minutes = Math.round(Math.max(0, characters) / CHARACTERS_PER_MINUTE);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
