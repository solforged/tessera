import { expect, test } from 'bun:test';
import type { TocEntry } from '../api/types';
import { absorbedPassages, bookKeys, chapterOpenings, contentsTitle, isProseExcerpt, repeatsOpening, repeatsTitlePage, sectionLabel, sectionName, titlePageWords } from './openings';

const entry = (title: string, ordinal: number, level = 1): TocEntry => ({ title, ordinal, level, locator: `#${ordinal}` });
const book = bookKeys('The Waning of the Middle Ages: A Study');

test('contents titles quiet all-caps titles, keeping minor words, Roman numerals and apostrophes', () => {
  for (const [raw, display] of [
    ['BOOK ONE', 'Book One'], ['THE FIRST BOOK', 'The First Book'], ['HIS FIRST BOOK', 'His First Book'],
    ['MARCUS AURELIUS ANTONINUS THE ROMAN EMPEROR', 'Marcus Aurelius Antoninus the Roman Emperor'],
    ['I. THE VIOLENT TENOR OF LIFE', 'I. The Violent Tenor of Life'], ['PART II: THE WAR OF 1812', 'Part II: The War of 1812'],
    ["O'BRIEN AND DON'T", "O'Brien and Don't"], ['O’BRIEN AND DON’T', 'O’Brien and Don’t'],
    ['THE WORLD WE LIVE IN', 'The World We Live In'], ['XXIV', 'XXIV'], ['42', '42'], ['A', 'A'],
  ]) expect(contentsTitle(raw!)).toBe(display!);
});

test('contents titles preserve authored mixed case and short acronyms but quiet long uppercase words', () => {
  expect(contentsTitle('concerning HIMSELF:')).toBe('Concerning Himself');
  expect(contentsTitle('the NATO and USA chapters')).toBe('The NATO and USA chapters');
  expect(contentsTitle('On iPhone, McCarthy and eBooks')).toBe('On iPhone, McCarthy and eBooks');
  expect(contentsTitle('The FOUR parts of HIMSELF')).toBe('The FOUR parts of Himself');
});

test('contents titles collapse whitespace and remove terminal punctuation without losing initials', () => {
  expect(contentsTitle('  THE  FIRST\n BOOK:; ,  ')).toBe('The First Book');
  expect(contentsTitle('The First Book.')).toBe('The First Book');
  expect(contentsTitle('Robert C.')).toBe('Robert C.');
  expect(contentsTitle('Chapter I.')).toBe('Chapter I.');
  expect(contentsTitle('The end…')).toBe('The end…');
  expect(contentsTitle('~Book One~')).toBe('Book One');
});

test('numeral-only openings, running heads and folios use the whole normalized entry', () => {
  const titles = ['BOOK THREE', 'Chapter 5', 'PART TWO', 'XXIV', '12', 'chapter iv'];
  const entries = titles.map((title, ordinal) => entry(title, ordinal));
  const openings = [...chapterOpenings(entries, book).values()];
  expect(openings.map(value => [value.label, value.title])).toEqual([
    [null, 'Book Three'], [null, 'Chapter 5'], [null, 'Part Two'], [null, 'XXIV'], [null, '12'], [null, 'Chapter IV'],
  ]);
  expect(titles.map(sectionLabel)).toEqual(openings.map(value => value.title));
  expect(entries.map(value => value.title)).toEqual(titles);
});

test('numbered chapters, parts and named sections become labelled openings with a name for "Begin at"', () => {
  const openings = chapterOpenings([
    entry('Cover', 0), entry('Title page', 1), entry('Preface', 2), entry('IV. The Idea of Chivalry', 3), entry('1: Dead Zones', 4),
    entry('BOOK ONE', 5), entry('12', 6), entry('Chapter three — Rain', 7), entry('I Remember', 8), entry('CIVIL WAR', 9),
    entry('Introduction: The Iron Law', 10), entry('Postscript. Fulfillment', 11),
  ], book);
  expect([...openings.values()].map(({ label, title, name }) => [label, title, name])).toEqual([
    [null, 'Preface', 'Preface'], ['Chapter IV', 'The Idea of Chivalry', 'chapter IV'], ['Chapter 1', 'Dead Zones', 'chapter 1'], [null, 'Book One', 'Book One'],
    [null, '12', '12'], ['Chapter Three', 'Rain', 'chapter Three'], [null, 'I Remember', 'I Remember'], [null, 'Civil War', 'Civil War'],
    ['Introduction', 'The Iron Law', 'Introduction'], ['Postscript', 'Fulfillment', 'Postscript'],
  ]);
});

test('sections below the chapter level and entries repeating the book title get no opening', () => {
  const openings = chapterOpenings([
    entry('The Waning of the Middle Ages', 0), entry('I. Transformation', 1), entry('1. Representation', 2, 2), entry('2. Rights', 3, 2), entry('II. Contagion', 4),
  ], book);
  expect([...openings.keys()]).toEqual([1, 4]);
});

test('a part that is only a title page opens, so does each chapter in it, and a chapter starting with its part names the part above its label', () => {
  const placed = (title: string, ordinal: number, level: number, start: number): TocEntry => ({ ...entry(title, ordinal, level), start });
  const openings = chapterOpenings([
    placed('List of Maps', 0, 1, 0), placed('~Part I: Trial by Ordeal~', 1, 1, 100), placed('1. The Count', 2, 2, 300), placed('2. Poets', 9, 2, 20_000),
    placed('Part Two - An Excess of Good Fortune', 20, 1, 40_000), placed('Chapter 3 - The Luck of Henry', 20, 2, 40_000), placed('Chapter 4 - Radical', 30, 2, 60_000),
  ], book);
  expect([...openings.values()].map(({ ordinal, part, label, title }) => [ordinal, part?.text ?? null, label, title])).toEqual([
    [1, null, 'Part I', 'Trial by Ordeal'], [2, null, 'Chapter 1', 'The Count'], [9, null, 'Chapter 2', 'Poets'],
    [20, 'Part Two · An Excess of Good Fortune', 'Chapter 3', 'The Luck of Henry'], [30, null, 'Chapter 4', 'Radical'],
  ]);
});

test('heading lines that restate the entry are repeats in any case, punctuation or numeral style', () => {
  expect(repeatsOpening('CHAPTER I', 'I. The Violent Tenor of Life', book)).toBe(true);
  expect(repeatsOpening('Chapter 1', 'I. The Violent Tenor of Life', book)).toBe(true);
  expect(repeatsOpening('THE VIOLENT TENOR OF LIFE', 'I. The Violent Tenor of Life', book)).toBe(true);
  expect(repeatsOpening('The Waning of the Middle Ages', 'I. The Violent Tenor of Life', book)).toBe(true);
  expect(repeatsOpening('Introduction', 'Introduction: The Iron Law', book)).toBe(true);
  expect(repeatsOpening('Book 2', 'I. The Violent Tenor of Life', book)).toBe(false);
  expect(repeatsOpening('II', 'I. The Violent Tenor of Life', book)).toBe(false);
  expect(repeatsOpening('The violent tenor of life was felt everywhere.', 'I. The Violent Tenor of Life', book)).toBe(false);
});

test('absorption stops at the epigraph, a highlight, an image or the next opening, and takes running heads of the book title', () => {
  const texts: Record<number, { kind: string; text: string }> = {
    10: { kind: 'heading', text: 'Chapter I' }, 11: { kind: 'heading', text: 'THE LITERATURE OF REVOLUTION' }, 12: { kind: 'paragraph', text: 'What do we mean by the Revolution?' },
    20: { kind: 'heading', text: 'CHAPTER II' }, 21: { kind: 'heading', text: 'SOURCES' }, 22: { kind: 'paragraph', text: 'Text.' },
    30: { kind: 'image', text: '' }, 31: { kind: 'heading', text: 'CHAPTER III' },
    40: { kind: 'heading', text: 'CHAPTER IV' }, 41: { kind: 'heading', text: 'CHAPTER V' }, 42: { kind: 'paragraph', text: 'Text.' },
    50: { kind: 'paragraph', text: 'THE WANING OF THE MIDDLE AGES' }, 51: { kind: 'paragraph', text: 'Text.' },
  };
  const contents = [entry('I. The Literature of Revolution', 10), entry('II. Sources', 20), entry('III. Power', 30), entry('IV. Logic', 40), entry('V. Transformation', 41)];
  const { hidden, first } = absorbedPassages(chapterOpenings(contents, book), [50], ordinal => texts[ordinal], ordinal => ordinal === 21, book);
  expect([...hidden].sort((a, b) => a - b)).toEqual([10, 11, 20, 40, 41, 50]);
  expect([...first].sort((a, b) => a - b)).toEqual([12, 21, 42]);
});

test('the toolbar names a section by its numeral and title, or by its label when only numbered', () => {
  expect(sectionName('XIV. Religious Sensibility')).toEqual({ numeral: 'XIV', title: 'Religious Sensibility' });
  expect(sectionName('7')).toEqual({ numeral: null, title: '7' });
  expect(sectionName('BOOK TWO')).toEqual({ numeral: null, title: 'Book Two' });
  expect(sectionName('Notes')).toEqual({ numeral: null, title: 'Notes' });
});

test('old inferred contents excerpts stay prose without hiding an editorial heading or a complete title', () => {
  const inferred = entry('"Magic is the first and last religion of the world. It has…', 6);
  const prose = { kind: 'paragraph', text: '"Magic is the first and last religion of the world. It has the power to make us whole."' };
  const next = entry('Chapter 1', 7);
  expect(isProseExcerpt(inferred, prose, next)).toBe(true);
  expect(isProseExcerpt(inferred, { ...prose, kind: 'heading' }, next)).toBe(false);
  expect(isProseExcerpt(inferred, prose, entry('Chapter 2', 20))).toBe(false);
  expect(isProseExcerpt(entry('The end…', 6), { kind: 'paragraph', text: 'The end…' }, next)).toBe(false);
  expect(isProseExcerpt(entry('The end...', 6), { kind: 'paragraph', text: 'The end... ' }, next)).toBe(false);
  const entries = [inferred, next, entry('Chapter 2', 20)];
  expect([...chapterOpenings(entries.filter((value, index) => !isProseExcerpt(value, value.ordinal === 6 ? prose : undefined, entries[index + 1])), book).keys()]).toEqual([7, 20]);
});

test('title-page words recognize split titles, editions, creator order and publisher with at most two other words', () => {
  const words = titlePageWords('The Ideological Origins of the American Revolution', 'Fiftieth Anniversary Edition', 'Bernard Bailyn', 'Harvard University Press');
  for (const text of ['The', 'IDEOLOGICAL ORIGINS', 'of the', 'AMERICAN REVOLUTION', 'FIFTIETH ANNIVERSARY EDITION', 'Bailyn, Bernard', 'The Belknap Press of Harvard University Press']) {
    expect(repeatsTitlePage(text, words)).toBe(true);
  }
  expect(repeatsTitlePage('By Bernard and Bailyn', words)).toBe(true);
  expect(repeatsTitlePage('The American Revolution new revised expanded', words)).toBe(false);
  expect(repeatsTitlePage('The American Revolution new expanded', words)).toBe(true);
  expect(repeatsTitlePage('For Jane', words)).toBe(false);
  expect(repeatsTitlePage('The sea', words)).toBe(false);
  expect(repeatsTitlePage('', words)).toBe(false);
  expect(repeatsTitlePage('A Farewell To Arms Hemingway, Ernest', titlePageWords('A Farewell to Arms', 'Ernest Hemingway'))).toBe(true);
  expect(bookKeys('The Marx-Engels Reader (Second Edition)').has('the marx engels reader')).toBe(true);
  expect(bookKeys('A Story (Notes)').has('a story')).toBe(false);
});

test('explicit title-page sections absorb their full runs, retaining non-cover images and highlights', () => {
  for (const title of ['Cover', 'TITLE PAGE', 'Title', 'Half title', 'Half-title']) {
    const contents = [entry(title, 0), entry('Chapter 1', 12), entry('Chapter 2', 15)];
    const texts = Array.from({ length: 16 }, (_, index) => ({ kind: 'paragraph', text: `Imprint line ${index}`, resource: '' }));
    texts[1] = { kind: 'image', text: '', resource: 'cover.jpg' };
    texts[2] = { kind: 'image', text: '', resource: 'portrait.jpg' };
    texts[3] = { kind: 'quote', text: 'An epigraph', resource: '' };
    texts[8] = { kind: 'image', text: '', resource: 'cover.jpg' };
    const result = absorbedPassages(chapterOpenings(contents, book), [], ordinal => texts[ordinal], () => false, book,
      { contents, total: texts.length, words: titlePageWords('A Farewell to Arms'), cover: 'cover.jpg', highlighted: new Set([5, 6, 7]) });
    expect([...result.hidden]).toEqual([0, 1, 8, 9, 10, 11]);
  }
});

test('unlabelled title pages absorb metadata only before the first chapter and preserve protected front matter', () => {
  const contents = [entry('Copyright', 2), entry('Dedication', 3), entry('Epigraph', 4), entry('Chapter 1', 5), entry('Chapter 2', 9)];
  const texts = [
    { kind: 'paragraph', text: 'A Farewell To Arms Hemingway, Ernest' },
    { kind: 'paragraph', text: 'A Farewell To Arms' },
    { kind: 'paragraph', text: 'Ernest Hemingway' },
    { kind: 'paragraph', text: 'Ernest Hemingway' },
    { kind: 'paragraph', text: 'A Farewell to Arms' },
    { kind: 'paragraph', text: 'Chapter 1' },
    { kind: 'paragraph', text: 'Body text.' },
    { kind: 'paragraph', text: 'Ernest Hemingway' },
    { kind: 'paragraph', text: 'A Farewell to Arms' },
    { kind: 'paragraph', text: 'Chapter 2' },
  ];
  const result = absorbedPassages(chapterOpenings(contents, bookKeys('A Farewell to Arms')), [], ordinal => texts[ordinal], () => false, bookKeys('A Farewell to Arms'),
    { contents, total: texts.length, words: titlePageWords('A Farewell to Arms', 'Ernest Hemingway'), cover: null, highlighted: new Set() });
  expect([...result.hidden]).toEqual([0, 1, 5, 9]);
});

test('title-page absorption respects a first opening at zero, unloaded passages and marked copyright or dedication', () => {
  const texts = [
    { kind: 'paragraph', text: 'Ernest Hemingway' },
    { kind: 'paragraph', text: 'Copyright Ernest Hemingway' },
    { kind: 'paragraph', text: '© Ernest Hemingway' },
    { kind: 'paragraph', text: 'For Ernest Hemingway' },
    { kind: 'paragraph', text: 'To Ernest Hemingway' },
    { kind: 'paragraph', text: 'A Farewell to Arms' },
  ];
  const keys = bookKeys('A Farewell to Arms');
  const page = { contents: [entry('Title page', 0)], total: texts.length, words: titlePageWords('A Farewell to Arms', 'Ernest Hemingway'), cover: null, highlighted: new Set<number>() };
  expect([...absorbedPassages(new Map(), [], ordinal => ordinal === 0 ? undefined : texts[ordinal], () => false, keys, page).hidden]).toEqual([5]);
  expect([...absorbedPassages(new Map(), [], ordinal => texts[ordinal], () => false, keys, page).hidden]).toEqual([0, 5]);
  expect([...absorbedPassages(chapterOpenings([entry('Chapter 1', 0), entry('Chapter 2', 6)], keys), [], ordinal => texts[ordinal], () => false, keys, page).hidden]).toEqual([]);
});

test('a book title beginning For or To is not mistaken for a dedication', () => {
  for (const title of ['For Whom the Bell Tolls', 'To the Lighthouse']) {
    const contents = [entry('Title page', 0), entry('Chapter 1', 1)];
    const result = absorbedPassages(new Map(), [], ordinal => ordinal === 0 ? { kind: 'paragraph', text: title } : undefined, () => false, bookKeys(title),
      { contents, total: 2, words: titlePageWords(title), cover: null, highlighted: new Set() });
    expect([...result.hidden]).toEqual([0]);
  }
});

test('title pages wrapped as quotes are absorbed only when the book classifies its quotes as prose', () => {
  const title = 'A Farewell to Arms', contents = [entry(title, 0), entry('Book One', 4), entry('Book Two', 8)];
  const texts = ['A Farewell To Arms', 'A Farewell To Arms Hemingway, Ernest', 'A Farewell To Arms', 'For Ernest Hemingway']
    .map(text => ({ kind: 'quote', text }));
  const page = { contents, total: 9, words: titlePageWords(title, 'Ernest Hemingway'), cover: null, highlighted: new Set<number>() };
  const openings = chapterOpenings(contents, bookKeys(title));
  expect([...absorbedPassages(openings, [0], ordinal => texts[ordinal], () => false, bookKeys(title), page).hidden]).toEqual([]);
  expect([...absorbedPassages(openings, [0], ordinal => texts[ordinal], () => false, bookKeys(title), { ...page, quotesAreText: true }).hidden]).toEqual([0, 1, 2]);
});

test('retained title-page illustrations keep following captions until the next image or section', () => {
  const contents = [entry('Cover', 0), entry('Title page', 6), entry('Copyright', 11), entry('Chapter 1', 12)];
  const texts = Array.from({ length: 12 }, () => ({ kind: 'paragraph', text: 'The Waning of the Middle Ages', resource: '' }));
  texts[0] = { kind: 'image', text: '', resource: 'cover.jpg' };
  texts[2] = { kind: 'image', text: '', resource: 'portrait.jpg' };
  texts[3] = { kind: 'heading', text: 'Portrait of Philip the Good, Duke of Burgundy', resource: '' };
  texts[7] = { kind: 'image', text: '', resource: 'frontispiece.jpg' };
  texts[9] = { kind: 'image', text: '', resource: 'cover.jpg' };
  const result = absorbedPassages(new Map(), [], ordinal => texts[ordinal], ordinal => ordinal === 2, book,
    { contents, total: 12, words: titlePageWords('The Waning of the Middle Ages'), cover: 'cover.jpg', highlighted: new Set() });
  expect([...result.hidden]).toEqual([0, 1, 6, 9, 10]);
});
