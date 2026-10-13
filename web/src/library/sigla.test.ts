import { expect, test } from 'bun:test';
import { pageSigla } from './sigla';

const source = (id: string, siglum: string, basis: string, authored = false) => ({
  block_id: id, siglum, siglum_basis: basis, siglum_authored: authored, siglum_disambiguation: null,
});
const matuschak = (id: string, year: string | null, initial: string | null) => ({
  ...source(id, 'MAT', 'MATUSCHAK'), siglum_disambiguation: { year, title_initial: initial },
});

test('page sigla preserve noncolliding marks and first appearance order', () => {
  expect([...pageSigla([source('thomas', 'THO', 'THOMAS'), source('garcia', 'GAR', 'GARCÍA')])])
    .toEqual([['thomas', 'THO'], ['garcia', 'GAR']]);
});

test('page sigla extend later sources by uppercase basis letters', () => {
  expect([...pageSigla([source('first', 'THO', 'THOMAS'), source('second', 'THO', 'THOMAS'), source('third', 'THO', 'THOMAS')])])
    .toEqual([['first', 'THO'], ['second', 'THOM'], ['third', 'THOMA']]);
});

test('page sigla extend Unicode names without splitting a letter', () => {
  expect([...pageSigla([source('first', 'GÓM', 'GÓMEZ'), source('second', 'GÓM', 'GÓMEZ'), source('third', 'GÓM', 'GÓMEZ')])])
    .toEqual([['first', 'GÓM'], ['second', 'GÓME'], ['third', 'GÓMEZ']]);
  expect([...pageSigla([source('a', '𐐀𐐁𐐂', '𐐀𐐁𐐂𐐃'), source('b', '𐐀𐐁𐐂', '𐐀𐐁𐐂𐐃')])])
    .toEqual([['a', '𐐀𐐁𐐂'], ['b', '𐐀𐐁𐐂𐐃']]);
});

test('authored sigla never change, including collisions with earlier marks', () => {
  expect([...pageSigla([source('first', 'THO', 'THOMAS'), source('second', 'THO', 'THO', true), source('third', 'THO', 'THO', true), source('fourth', 'THO', 'THOMAS')])])
    .toEqual([['first', 'THO'], ['second', 'THO'], ['third', 'THO'], ['fourth', 'THOM']]);
  expect([...pageSigla([source('authored', 'THOM', 'THOM', true), source('first', 'THO', 'THOMAS'), source('later', 'THO', 'THOMAS')])])
    .toEqual([['authored', 'THOM'], ['first', 'THO'], ['later', 'THOMA']]);
});

test('page sigla append successive numbers starting at two when the basis runs out', () => {
  expect([...pageSigla([source('first', 'THO', 'THO'), source('second', 'THO', 'THO'), source('third', 'THO', 'THO')])])
    .toEqual([['first', 'THO'], ['second', 'THO2'], ['third', 'THO3']]);
  expect([...pageSigla([source('first', 'LI', 'LI'), source('second', 'LI', 'LI')])])
    .toEqual([['first', 'LI'], ['second', 'LI2']]);
});

test('page sigla number an exhausted full basis and avoid previous numbered marks', () => {
  expect([...pageSigla([source('a', 'THO', 'THOM'), source('b', 'THO', 'THOM'), source('c', 'THO', 'THOM'), source('d', 'THO', 'THOM')])])
    .toEqual([['a', 'THO'], ['b', 'THOM'], ['c', 'THOM2'], ['d', 'THOM3']]);
});

test('page sigla do not reassign a source mentioned more than once', () => {
  expect([...pageSigla([source('a', 'THO', 'THOMAS'), source('b', 'THO', 'THOMAS'), source('a', 'THO', 'THOMAS')])])
    .toEqual([['a', 'THO'], ['b', 'THOM']]);
});

test('page sigla skip nonletters in extension bases', () => {
  expect([...pageSigla([source('a', 'THO', 'THOMAS'), source('b', 'THO', '123Tho-mas!')])])
    .toEqual([['a', 'THO'], ['b', 'THOM']]);
});

test('page sigla handle an empty page', () => {
  expect(pageSigla([]).size).toBe(0);
});

test('author collisions prefer a unique two-digit publication year', () => {
  expect([...pageSigla([matuschak('first', null, 'e'), matuschak('second', '19', 'e'), matuschak('third', '20', 'e')])])
    .toEqual([['first', 'MAT'], ['second', 'MAT19'], ['third', 'MAT20']]);
});

test('author collisions use a unique lowercase title initial when the year is absent or shared', () => {
  expect([...pageSigla([matuschak('first', '19', 'a'), matuschak('second', '19', 'e'), matuschak('third', null, 'h')])])
    .toEqual([['first', 'MAT'], ['second', 'MATe'], ['third', 'MATh']]);
});

test('author collisions use stem ordinals when both distinguishers are shared or missing', () => {
  expect([...pageSigla([matuschak('first', '19', 'e'), matuschak('second', '19', 'e'), matuschak('third', null, 'e'), matuschak('fourth', null, null)])])
    .toEqual([['first', 'MAT'], ['second', 'MAT2'], ['third', 'MAT3'], ['fourth', 'MAT4']]);
});

test('adding later colliders never renames previously assigned years, initials or ordinals', () => {
  const sources = [matuschak('first', null, 'a'), matuschak('year', '19', 'e'), matuschak('initial', '19', 'h'), matuschak('ordinal', '19', 'h')];
  const before = pageSigla(sources);
  expect([...before]).toEqual([['first', 'MAT'], ['year', 'MAT19'], ['initial', 'MATh'], ['ordinal', 'MAT2']]);
  const after = pageSigla([...sources, matuschak('new', '19', 'h')]);
  for (const [id, mark] of before) expect(after.get(id)).toBe(mark);
  expect(after.get('new')).toBe('MAT3');
});

test('author distinguishers avoid marks assigned by another stem', () => {
  expect([...pageSigla([source('other', 'MAT19', 'MAT19'), matuschak('first', null, 'a'), matuschak('second', '19', 'e')])])
    .toEqual([['other', 'MAT19'], ['first', 'MAT'], ['second', 'MATe']]);
});

test('author marks preserve Unicode stems and title initials', () => {
  const first = { ...matuschak('first', null, 'e'), siglum: 'GÓM', siglum_basis: 'GÓMEZ' };
  const second = { ...matuschak('second', null, 'é'), siglum: 'GÓM', siglum_basis: 'GÓMEZ' };
  expect([...pageSigla([first, second, second])]).toEqual([['first', 'GÓM'], ['second', 'GÓMé']]);
});

test('author ordinals do not reuse a numeric year distinguisher', () => {
  const sources = [matuschak('first', null, 'e'), matuschak('year', '10', 'e')];
  for (let i = 2; i <= 10; i++) sources.push(matuschak(`ordinal${i}`, null, 'e'));
  const sigla = pageSigla(sources);
  expect(sigla.get('year')).toBe('MAT10');
  expect(sigla.get('ordinal10')).toBe('MAT11');
});
