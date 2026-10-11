import { expect, test } from 'bun:test';
import type { TocEntry } from '../api/types';
import { absorbedPassages, bookKeys, chapterOpenings, repeatsOpening, sectionName } from './openings';

const entry = (title: string, ordinal: number, level = 1): TocEntry => ({ title, ordinal, level, locator: `#${ordinal}` });
const book = bookKeys('The Waning of the Middle Ages: A Study');

test('numbered chapters, parts and named sections become labelled openings with a name for "Begin at"', () => {
  const openings = chapterOpenings([
    entry('Cover', 0), entry('Title page', 1), entry('Preface', 2), entry('IV. The Idea of Chivalry', 3), entry('1: Dead Zones', 4),
    entry('BOOK ONE', 5), entry('12', 6), entry('Chapter three — Rain', 7), entry('I Remember', 8), entry('CIVIL WAR', 9),
    entry('Introduction: The Iron Law', 10), entry('Postscript. Fulfillment', 11),
  ], book);
  expect([...openings.values()].map(({ label, title, name }) => [label, title, name])).toEqual([
    [null, 'Preface', 'Preface'], ['Chapter IV', 'The Idea of Chivalry', 'chapter IV'], ['Chapter 1', 'Dead Zones', 'chapter 1'], ['Book', 'One', 'Book One'],
    ['Chapter', '12', 'chapter 12'], ['Chapter Three', 'Rain', 'chapter Three'], [null, 'I Remember', 'I Remember'], [null, 'CIVIL WAR', 'CIVIL WAR'],
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
  expect(sectionName('7')).toEqual({ numeral: null, title: 'Chapter 7' });
  expect(sectionName('BOOK TWO')).toEqual({ numeral: null, title: 'Book Two' });
  expect(sectionName('Notes')).toEqual({ numeral: null, title: 'Notes' });
});
