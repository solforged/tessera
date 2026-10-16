import type { TocEntry } from '../api/types';
import { chapterEntries } from '../ui/book-map';

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
  /** The part this chapter opens, when the two start at the same passage: its entry as written and as drawn (`Part One · An Excess of Good Fortune`). */
  part: { heading: string; text: string } | null;
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
/** Front matter keeps the file's own markup: it has no chapter to open, nor a name in the foot or progress. */
const FRONT: Record<string, true> = Object.fromEntries(['cover', 'title page', 'title', 'half title', 'copyright', 'copyright page', 'contents', 'table of contents', 'illustrations', 'list of illustrations', 'abbreviations', 'list of abbreviations', 'dedication', 'epigraph', 'frontispiece', 'map', 'maps', 'list of maps', 'family tree', 'family trees', 'genealogy', 'genealogical table', 'genealogical tables', 'major characters', 'principal characters', 'cast of characters', 'dramatis personae', 'list of figures', 'list of tables', 'praise'].map(key => [key, true]));
const ALSO_BY = /^(also by|other books by|other titles by|books by|by the same author)\b/;
/** A cover, contents page, map or list of the author's other books: front matter, not a chapter. */
export const isFrontMatter = (title: string) => { const key = normalizeTitle(title); return !!FRONT[key] || ALSO_BY.test(key); };

/** An old inferred entry naming a lone paragraph by a truncated excerpt, not an editorial chapter title. */
export function isProseExcerpt(entry: TocEntry, passage: { kind: string; text: string } | undefined, next: TocEntry | undefined): boolean {
  const prefix = entry.title.match(/^(.*?)(?:…|\.\.\.)$/s)?.[1]?.trimEnd();
  return !!prefix && !!passage && passage.kind !== 'heading' && passage.text.length > prefix.length && passage.text.startsWith(prefix)
    && entry.ordinal !== null && next?.ordinal === entry.ordinal + 1;
}

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
  // Decorations around a title (`~Book One~`, `* 3 *`) are not part of it.
  const text = title.trim().replace(/^[~*•·◆◇\s]+|[~*•·◆◇\s]+$/gu, '');
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

/** The book's title, alone, before its subtitle or without a parenthetical edition, from each place it is recorded. */
export function bookKeys(...titles: (string | null | undefined)[]): Set<string> {
  const keys = new Set<string>();
  for (const title of titles) {
    if (!title?.trim()) continue;
    const main = title.replace(/\s*\([^()]*(?:edition|ed\.)[^()]*\)\s*$/i, '');
    for (const value of [title, main]) {
      keys.add(normalizeTitle(value));
      keys.add(normalizeTitle(value.split(':')[0]!));
    }
  }
  keys.delete('');
  return keys;
}

/** Title-page-only repetitions: a split edition and a byline made from the recorded creators. */
export function repeatsTitleDetails(text: string, titles: readonly string[], creators: readonly string[]): boolean {
  const key = normalizeTitle(text);
  if (titles.some(title => normalizeTitle(title.match(/\(([^()]*(?:edition|ed\.)[^()]*)\)\s*$/i)?.[1] ?? '') === key)) return !!key;
  const names = text.replace(/^\s*by\s+/i, '').split(/\s+(?:and|&)\s+|,\s*/i).map(normalizeTitle);
  const known = new Set(creators.map(normalizeTitle));
  return names.length > 0 && names.every(name => !!name && known.has(name));
}

/** A contents entry that only repeats the book's title: a running head the file marked as navigation. */
export const repeatsBook = (entry: { title: string }, book: ReadonlySet<string>) => book.has(normalizeTitle(entry.title));

export function sectionName(title: string): SectionName {
  const parsed = parse(title);
  if (parsed.kind === null) return { numeral: null, title: parsed.rest };
  if (parsed.kind !== 'chapter') return { numeral: null, title: parsed.rest || `${capitalized(parsed.kind)} ${parsed.numeral}` };
  return parsed.rest ? { numeral: parsed.numeral, title: parsed.rest } : { numeral: null, title: `Chapter ${parsed.numeral}` };
}

/** A section's name on one line, as the running head, the progress card and the library say it: `IV · The Idea of Chivalry`, `Chapter 5`. */
export function sectionLabel(title: string): string {
  const name = sectionName(title);
  return name.numeral ? `${name.numeral} · ${name.title}` : name.title;
}

/** A titled section that names its kind first, as `Introduction: The Iron Law` or `Postscript. Fulfillment`. */
const SECTION_WORD = /^((?:introduction|preface|foreword|prologue|epilogue|afterword|postscript|conclusion|coda|interlude|appendix)(?:\s+[a-z\d]{1,3})?)[.:]\s+(.+)$/i;

function opening(entry: TocEntry & { ordinal: number }): Opening {
  const parsed = parse(entry.title), at = { ordinal: entry.ordinal, heading: entry.title, part: null };
  if (parsed.kind === null) {
    const word = parsed.rest.match(SECTION_WORD);
    return word ? { ...at, label: word[1]!, title: word[2]!, name: word[1]! } : { ...at, label: null, title: parsed.rest, name: parsed.rest };
  }
  const kind = capitalized(parsed.kind);
  return { ...at, label: parsed.rest ? `${kind} ${parsed.numeral}` : kind, title: parsed.rest || parsed.numeral!, name: `${parsed.kind === 'chapter' ? 'chapter' : kind} ${parsed.numeral}` };
}

/**
 * The chapter openings by first passage: the entries that start chapters (`chapterEntries`, as paged reading counts
 * them, so a part that is only a title page opens and so does each chapter in it), leaving out front matter and
 * entries that repeat the book's title. A part and its first chapter at the same passage make one opening, the part
 * above the chapter's label. Deeper sections keep the file's own headings.
 */
export function chapterOpenings(contents: readonly TocEntry[], book: ReadonlySet<string>): Map<number, Opening> {
  const entries = contents.filter((entry): entry is TocEntry & { ordinal: number } => entry.ordinal !== null && !repeatsBook(entry, book));
  const chosen = chapterEntries(entries);
  const openings = new Map<number, Opening>(), levels = new Map<number, number>();
  for (const entry of chosen.length ? chosen : entries) {
    if (isFrontMatter(entry.title)) continue;
    const outer = openings.get(entry.ordinal), value = opening(entry);
    if (!outer) { openings.set(entry.ordinal, value); levels.set(entry.ordinal, entry.level); }
    else if (entry.level > levels.get(entry.ordinal)!) {
      openings.set(entry.ordinal, { ...value, part: { heading: outer.heading, text: outer.label ? `${outer.label} · ${outer.title}` : outer.title } });
      levels.set(entry.ordinal, entry.level);
    }
  }
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
  passageAt: (ordinal: number) => { kind: string; text: string } | undefined, highlighted: (ordinal: number) => boolean, book: ReadonlySet<string>,
  titleDetails: (text: string) => boolean = () => false): AbsorbedPassages {
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
  // A file's opening title page need not have its own contents entry. Skip only its leading cover images.
  for (let ordinal = 0; ordinal < 6; ordinal++) {
    const passage = passageAt(ordinal);
    if (!passage) break;
    if (passage.kind === 'image') continue;
    if (book.has(normalizeTitle(passage.text))) walk(ordinal, text => book.has(normalizeTitle(text)) || titleDetails(text));
    break;
  }
  for (const ordinal of titleEntries) if (!openings.has(ordinal)) walk(ordinal, text => book.has(normalizeTitle(text)) || titleDetails(text));
  for (const { ordinal, heading, part } of openings.values()) {
    const text = walk(ordinal, value => repeatsOpening(value, heading, book) || (!!part && repeatsOpening(value, part.heading, book)));
    if (text !== null && passageAt(text)?.kind !== 'image') first.add(text);
  }
  return { hidden, first };
}
