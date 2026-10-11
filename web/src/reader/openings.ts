import type { TocEntry } from '../api/types';

/**
 * A contents entry drawn as a chapter opening: a rubric label over the title in display type. The reader composes it
 * from the entry rather than the file's heading markup, so every book opens its chapters the same way.
 */
export interface Opening {
  ordinal: number;
  /** The contents entry as written, which heading lines that only restate it are matched against. */
  heading: string;
  /**
   * `Chapter I`, `Book One`, `Part Two`; `Chapter` alone when the title is only a number; the section's word for a
   * titled introduction, appendix or the like (`Introduction: The Iron Law`); null otherwise.
   */
  label: string | null;
  /** The title proper, without its numeral or section word; the numeral itself when the entry is only a number. */
  title: string;
  /** How a sentence refers to the section: `chapter I`, `Book One`, `Introduction`, `Preface`. */
  name: string;
}

/** How a section names itself in the toolbar and foot: its numeral apart, in mono, then its title. */
export interface SectionName { numeral: string | null; title: string }

interface Parsed { kind: 'chapter' | 'book' | 'part' | null; numeral: string | null; value: number | null; rest: string }

/** Case, accents and punctuation ignored: `THE LITERATURE OF REVOLUTION` repeats `I. The Literature of Revolution`. */
export const normalizeTitle = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const ROMAN = /^(?=[mdclxvi])m{0,3}(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/** Front matter keeps the file's own markup: it has no chapter to open. */
const FRONT: Record<string, true> = Object.fromEntries(['cover', 'title page', 'title', 'half title', 'copyright', 'copyright page', 'contents', 'table of contents', 'illustrations', 'list of illustrations', 'abbreviations', 'dedication', 'epigraph'].map(key => [key, true]));
const ALSO_BY = /^(also by|other books by|books by|by the same author)\b/;

/** `XIV`, `14` or `fourteen` as a number; null for anything else. */
function numberOf(token: string): number | null {
  const lower = token.toLocaleLowerCase();
  if (/^\d{1,3}$/.test(lower)) return Number(lower);
  const word = WORDS.indexOf(lower);
  if (word >= 0) return word + 1;
  if (!ROMAN.test(lower)) return null;
  let value = 0;
  for (let index = 0; index < lower.length; index++) {
    const digit = ROMAN_VALUES[lower[index]!]!, next = ROMAN_VALUES[lower[index + 1] ?? ''] ?? 0;
    value += digit < next ? -digit : digit;
  }
  return value;
}

const capitalized = (word: string) => word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
/**
 * `Chapter 3 …`, `Book One`, `Part II: …` with any case and number style; or a bare upper-case Roman numeral or a
 * number followed by `.` or `:` (`IV. The Idea of Chivalry`, `1: Dead Zones`), or alone (`12`). A leading capital
 * word that only looks Roman (`I Remember`, `CIVIL WAR`) needs the separator, so it stays a title.
 */
function parse(title: string): Parsed {
  const text = title.trim();
  const named = text.match(/^(chapter|book|part)\s+([^\s.:]+)(?:[.:]|\s+[-–—])?\s*(.*)$/i);
  if (named) {
    const value = numberOf(named[2]!);
    // Roman numerals and digits upper-cased as written; number words capitalized.
    const token = named[2]!, numeral = /^[a-z]+$/i.test(token) && !ROMAN.test(token.toLocaleLowerCase()) ? capitalized(token) : token.toLocaleUpperCase();
    if (value !== null) return { kind: named[1]!.toLocaleLowerCase() as Parsed['kind'], numeral, value, rest: named[3]!.trim() };
  }
  const bare = text.match(/^([IVXLCDM]+|\d{1,3})(?:[.:](?:\s+|$)|\s+[-–—]\s+|$)(.*)$/);
  if (bare) {
    const value = numberOf(bare[1]!);
    if (value !== null) return { kind: 'chapter', numeral: bare[1]!, value, rest: bare[2]!.trim() };
  }
  return { kind: null, numeral: null, value: null, rest: text };
}

/** The book's title, alone or before its subtitle, from each place it is recorded. */
export function bookKeys(...titles: (string | null | undefined)[]): Set<string> {
  const keys = new Set<string>();
  for (const title of titles) {
    if (!title?.trim()) continue;
    keys.add(normalizeTitle(title));
    keys.add(normalizeTitle(title.split(':')[0]!));
  }
  keys.delete('');
  return keys;
}

/** A contents entry that only repeats the book's title: a running head the file marked as navigation. */
export const repeatsBook = (entry: { title: string }, book: ReadonlySet<string>) => book.has(normalizeTitle(entry.title));

export function sectionName(title: string): SectionName {
  const parsed = parse(title);
  if (parsed.kind === null) return { numeral: null, title: parsed.rest };
  if (parsed.kind !== 'chapter') return { numeral: null, title: parsed.rest || `${capitalized(parsed.kind)} ${parsed.numeral}` };
  return parsed.rest ? { numeral: parsed.numeral, title: parsed.rest } : { numeral: null, title: `Chapter ${parsed.numeral}` };
}

/** A titled section that names its kind first, as `Introduction: The Iron Law` or `Postscript. Fulfillment`. */
const SECTION_WORD = /^((?:introduction|preface|foreword|prologue|epilogue|afterword|postscript|conclusion|coda|interlude|appendix)(?:\s+[a-z\d]{1,3})?)[.:]\s+(.+)$/i;

function opening(entry: TocEntry & { ordinal: number }): Opening {
  const parsed = parse(entry.title), at = { ordinal: entry.ordinal, heading: entry.title };
  if (parsed.kind === null) {
    const word = parsed.rest.match(SECTION_WORD);
    return word ? { ...at, label: word[1]!, title: word[2]!, name: word[1]! } : { ...at, label: null, title: parsed.rest, name: parsed.rest };
  }
  const kind = capitalized(parsed.kind);
  return { ...at, label: parsed.rest ? `${kind} ${parsed.numeral}` : kind, title: parsed.rest || parsed.numeral!, name: `${parsed.kind === 'chapter' ? 'chapter' : kind} ${parsed.numeral}` };
}

/**
 * The chapter openings by first passage: entries at the chapter level (the outermost level with two or more entries,
 * as paged reading counts chapters) and above it, leaving out front matter and entries that repeat the book's title.
 * Deeper sections keep the file's own headings.
 */
export function chapterOpenings(contents: readonly TocEntry[], book: ReadonlySet<string>): Map<number, Opening> {
  const entries = contents.filter((entry): entry is TocEntry & { ordinal: number } => {
    if (entry.ordinal === null || repeatsBook(entry, book)) return false;
    const key = normalizeTitle(entry.title);
    return !FRONT[key] && !ALSO_BY.test(key);
  });
  const counts = new Map<number, number>();
  for (const entry of entries) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  const level = Math.min(...[...counts].filter(([, count]) => count > 1).map(([value]) => value));
  const openings = new Map<number, Opening>();
  for (const entry of entries) if ((!Number.isFinite(level) || entry.level <= level) && !openings.has(entry.ordinal)) openings.set(entry.ordinal, opening(entry));
  return openings;
}

/**
 * A heading line that only restates its opening: the contents entry, its title or either half of a title split at a
 * colon, its label, its numeral in any style (`Chapter 1`, `I`, `one`), or the book's title as a running head.
 */
export function repeatsOpening(text: string, entryTitle: string, book: ReadonlySet<string>): boolean {
  if (text.length > 160) return false;
  const key = normalizeTitle(text);
  if (!key) return false;
  if (book.has(key)) return true;
  const parsed = parse(entryTitle), found = opening({ title: entryTitle, locator: '', level: 1, ordinal: 0 });
  const keys = new Set([entryTitle, parsed.rest, found.title, found.label ?? '', `${found.label ?? ''} ${found.title}`, ...entryTitle.split(':'), ...parsed.rest.split(':')].map(normalizeTitle));
  keys.delete('');
  if (keys.has(key)) return true;
  if (parsed.value === null) return false;
  const number = key.match(/^(?:(chapter|book|part) )?(\S+)$/);
  return !!number && (!number[1] || number[1] === parsed.kind) && numberOf(number[2]!) === parsed.value;
}

export interface AbsorbedPassages {
  /** Passages drawn by the opening or the title page instead: shown as nothing, kept for find, jumps and positions. */
  hidden: Set<number>;
  /** Each opening's first passage of text, whose first line takes small capitals. */
  first: Set<number>;
}

/**
 * From each opening's first passage, the heading lines that only restate it, up to the next opening; from each entry
 * that repeats the book's title, the running heads that repeat it. A passage with a highlight, an image or anything
 * else ends the run. `passageAt` is undefined for passages not yet loaded, which also ends it until they arrive.
 */
export function absorbedPassages(openings: ReadonlyMap<number, Opening>, titleEntries: readonly number[],
  passageAt: (ordinal: number) => { kind: string; text: string } | undefined, highlighted: (ordinal: number) => boolean, book: ReadonlySet<string>): AbsorbedPassages {
  const hidden = new Set<number>(), first = new Set<number>();
  const walk = (start: number, repeats: (text: string) => boolean) => {
    for (let ordinal = start; ordinal < start + 6; ordinal++) {
      const passage = passageAt(ordinal);
      if (!passage || ordinal !== start && openings.has(ordinal)) return null;
      if (passage.kind === 'image' || highlighted(ordinal) || !repeats(passage.text)) return ordinal;
      hidden.add(ordinal);
    }
    return null;
  };
  for (const ordinal of titleEntries) if (!openings.has(ordinal)) walk(ordinal, text => book.has(normalizeTitle(text)));
  for (const { ordinal, heading } of openings.values()) {
    const text = walk(ordinal, value => repeatsOpening(value, heading, book));
    if (text !== null && passageAt(text)?.kind !== 'image') first.add(text);
  }
  return { hidden, first };
}
