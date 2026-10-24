import type { TocEntry } from '../api/types';
import { contentsTitle, isFrontMatter } from '../reader/openings';

/** A stretch of the text by character offset: `start` up to, not including, `end`. */
export interface Chapter { title: string; start: number; end: number }

/** A part whose own text before its first entry is shorter than this many characters (a title page, an epigraph) holds chapters rather than being one. */
export const PART_PAGE = 2000;

/**
 * The contents entries that start chapters, in reading order. Chapters are the outermost level with two or more
 * entries, as in a printed book, so a book's single title heading does not count; but a part whose own text is only
 * its title page holds chapters, so its entries start chapters too and the part keeps its title page as a stretch of
 * its own. A chapter with a page of its own before its sections keeps them inside it. Entries without a `start` are
 * only ever chapters, never parts.
 */
export function chapterEntries<T extends { level: number; start?: number }>(entries: readonly T[]): T[] {
  const counts = new Map<number, number>();
  for (const entry of entries) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  const level = Math.min(...[...counts].filter(([, count]) => count > 1).map(([value]) => value));
  if (!Number.isFinite(level)) return [];
  const chapters: T[] = [];
  const tops = entries.flatMap((entry, index) => entry.level === level ? [index] : []);
  tops.forEach((at, index) => {
    const top = entries[at]!, inside = entries.slice(at + 1, tops[index + 1] ?? entries.length).filter(entry => entry.level > level);
    const first = inside[0];
    const part = inside.length > 1 && top.start !== undefined && first?.start !== undefined && first.start - top.start < PART_PAGE;
    chapters.push(top, ...(part ? chapterEntries(inside) : []));
  });
  return chapters;
}

/**
 * A book's chapters across its text, by character offset, as `chapterEntries` picks them; text before the first one
 * is a chapter of its own. Front matter (cover, contents, maps) and text before the first chapter are titled by
 * nothing: they are stretches of the map, not chapters to name.
 */
export function bookChapters(toc: readonly TocEntry[], length: number): Chapter[] {
  if (!length) return [];
  const placed = toc.filter((entry): entry is TocEntry & { start: number } => entry.start !== undefined && entry.start < length);
  const starts = chapterEntries(placed).sort((a, b) => a.start - b.start)
    .filter((entry, index, all) => index === all.length - 1 || entry.start < all[index + 1]!.start);
  if (!starts.length) return [{ title: '', start: 0, end: length }];
  const chapters: Chapter[] = starts.map((entry, index) => ({ title: isFrontMatter(entry.title) ? '' : contentsTitle(entry.title), start: entry.start, end: starts[index + 1]?.start ?? length }));
  if (chapters[0]!.start > 0) chapters.unshift({ title: '', start: 0, end: chapters[0]!.start });
  return chapters;
}

/** The chapter holding character offset `at`, with its index; the last chapter holds the very end. */
export function chapterAt(chapters: readonly Chapter[], at: number): { chapter: Chapter; index: number } | null {
  const index = chapters.findIndex(chapter => at >= chapter.start && at < chapter.end);
  const found = index >= 0 ? index : chapters.length - 1;
  return found >= 0 ? { chapter: chapters[found]!, index: found } : null;
}
