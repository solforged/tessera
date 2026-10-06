import { expect, test } from 'bun:test';
import { pageSigla } from './sigla';

const source = (id: string, siglum: string, basis: string) => ({ id, siglum, basis });

test('page sigla preserve noncolliding marks and first appearance order', () => {
  expect([...pageSigla([source('plato', 'P', 'plato'), source('aristotle', 'A', 'aristotle')])])
    .toEqual([['plato', 'P'], ['aristotle', 'A']]);
});

test('page sigla extend the later source in a two-way collision', () => {
  expect([...pageSigla([source('plato', 'P', 'plato'), source('popper', 'P', 'popper')])])
    .toEqual([['plato', 'P'], ['popper', 'Po']]);
});

test('page sigla extend as far as needed in a three-way collision', () => {
  expect([...pageSigla([source('plato', 'P', 'plato'), source('popper', 'P', 'popper'), source('polanyi', 'P', 'polanyi')])])
    .toEqual([['plato', 'P'], ['popper', 'Po'], ['polanyi', 'Pol']]);
});

test('page sigla preserve authored multi-letter sigla except on collision', () => {
  expect([...pageSigla([source('first', 'Po', 'Po'), source('second', 'Po', 'Po'), source('third', 'P', 'popper')])])
    .toEqual([['first', 'Po'], ['second', 'Po1'], ['third', 'P']]);
});

test('page sigla append successive digits after exhausting a basis', () => {
  expect([...pageSigla([source('first', 'P', 'p'), source('second', 'P', 'p'), source('third', 'P', 'p')])])
    .toEqual([['first', 'P'], ['second', 'P1'], ['third', 'P2']]);
});

test('page sigla avoid previously assigned extensions and numbered authored sigla', () => {
  expect([...pageSigla([source('a', 'P', 'plato'), source('b', 'Po', 'Po'), source('c', 'Po1', 'Po1'), source('d', 'P', 'po')])])
    .toEqual([['a', 'P'], ['b', 'Po'], ['c', 'Po1'], ['d', 'Po2']]);
});

test('page sigla do not reassign a source mentioned more than once', () => {
  expect([...pageSigla([source('a', 'P', 'plato'), source('b', 'P', 'popper'), source('a', 'P', 'plato')])])
    .toEqual([['a', 'P'], ['b', 'Po']]);
});

test('page sigla extend after the initial letter when a folded basis starts with digits', () => {
  expect([...pageSigla([source('a', 'P', 'plato'), source('b', 'P', '123popper')])])
    .toEqual([['a', 'P'], ['b', 'Po']]);
});

test('page sigla handle an empty page', () => {
  expect(pageSigla([]).size).toBe(0);
});
