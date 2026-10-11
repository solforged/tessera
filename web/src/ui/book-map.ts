import type { TocEntry } from '../api/types';

/** A stretch of the text by character offset: `start` up to, not including, `end`. */
export interface Chapter { title: string; start: number; end: number }

/**
 * A book's chapters across its text, by character offset. As in the reader, chapters are the outermost level of the
 * contents with at least two entries; text before the first one is a chapter of its own, titled by nothing.
 */
export function bookChapters(toc: readonly TocEntry[], length: number): Chapter[] {
  if (!length) return [];
  const placed = toc.filter((entry): entry is TocEntry & { start: number } => entry.start !== undefined && entry.start < length);
  const counts = new Map<number, number>();
  for (const entry of placed) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  const levels = [...counts].filter(([, count]) => count > 1).map(([level]) => level);
  if (!levels.length) return [{ title: '', start: 0, end: length }];
  const level = Math.min(...levels);
  const starts = placed.filter(entry => entry.level === level).sort((a, b) => a.start - b.start)
    .filter((entry, index, all) => index === 0 || entry.start > all[index - 1]!.start);
  const chapters: Chapter[] = starts.map((entry, index) => ({ title: entry.title, start: entry.start, end: starts[index + 1]?.start ?? length }));
  if (chapters[0]!.start > 0) chapters.unshift({ title: '', start: 0, end: chapters[0]!.start });
  return chapters;
}

/** The chapter holding character offset `at`, with its index; the last chapter holds the very end. */
export function chapterAt(chapters: readonly Chapter[], at: number): { chapter: Chapter; index: number } | null {
  const index = chapters.findIndex(chapter => at >= chapter.start && at < chapter.end);
  const found = index >= 0 ? index : chapters.length - 1;
  return found >= 0 ? { chapter: chapters[found]!, index: found } : null;
}
