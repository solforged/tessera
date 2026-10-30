import { expect, test } from 'bun:test';
import { dropIndex, makeRoom, settleOffset } from './reorder';

const centers = [50, 150, 250, 350];

test('a dragged row lands after the rows whose centres it has passed', () => {
  expect(dropIndex(centers, 0, 50)).toBe(0);
  expect(dropIndex(centers, 0, 160)).toBe(1);
  expect(dropIndex(centers, 0, 260)).toBe(2);
  expect(dropIndex(centers, 0, 900)).toBe(3);
  expect(dropIndex(centers, 3, 140)).toBe(1);
  expect(dropIndex(centers, 3, -20)).toBe(0);
  expect(dropIndex(centers, 2, 250)).toBe(2);
});

test('rows between the start and the drop slide by the held row\'s height, and no other', () => {
  expect([0, 1, 2, 3].map(row => makeRoom(row, 0, 2, 60))).toEqual([0, -60, -60, 0]);
  expect([0, 1, 2, 3].map(row => makeRoom(row, 3, 1, 60))).toEqual([0, 60, 60, 0]);
  expect([0, 1, 2, 3].map(row => makeRoom(row, 1, 1, 60))).toEqual([0, 0, 0, 0]);
});

test('a dropped row settles over the combined height of the rows it passed', () => {
  const heights = [70, 90, 110, 70];
  expect(settleOffset(heights, 0, 2)).toBe(200);
  expect(settleOffset(heights, 3, 1)).toBe(-200);
  expect(settleOffset(heights, 2, 2)).toBe(0);
});
