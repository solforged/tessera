import { expect, test } from 'bun:test';
import { pageSigla } from './sigla';

const source = (id: string, siglum: string, basis: string, authored = false) => ({ id, siglum, basis, authored });

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
