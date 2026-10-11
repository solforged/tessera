import { chapterEntries } from '../ui/book-map';

/** Passages laid out together in paged reading; a chunk always starts on a fresh page. */
export interface PageChunk { first: number; last: number }

/** Long or untitled stretches split every this many passages, to bound the work of one layout. */
export const CHUNK_LIMIT = 150;

/** A contents entry placed at a passage: its level, and its character offset where known. */
export interface PlacedSection { ordinal: number; level: number; start?: number }

/**
 * The chapter holding `ordinal`, from its first passage up to (not including) the next chapter's. Chapters are
 * `chapterEntries`: the outermost level with two or more entries, and the chapters inside a part that is only a title
 * page. Front matter before the first chapter is a chapter of its own.
 */
export function chapterAt(sections: readonly PlacedSection[], total: number, ordinal: number): { first: number; end: number } {
  let first = 0, end = total;
  for (const section of chapterEntries(sections)) {
    if (section.ordinal <= ordinal) first = Math.max(first, section.ordinal);
    else end = Math.min(end, section.ordinal);
  }
  return { first, end };
}

/** The chunk holding `ordinal`: its chapter, split every `CHUNK_LIMIT` passages so each chapter starts on a fresh page. */
export function pageChunk(sections: readonly PlacedSection[], total: number, ordinal: number): PageChunk {
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
