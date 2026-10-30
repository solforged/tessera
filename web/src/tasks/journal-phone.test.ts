import { expect, test } from 'bun:test';
import { daySwipeStep, swipeDistance } from './journal-phone';

test('a long, mostly sideways drag changes the day: left reads on, right reads back', () => {
  expect(daySwipeStep(-swipeDistance, 0)).toBe(1);
  expect(daySwipeStep(swipeDistance, 10)).toBe(-1);
  expect(daySwipeStep(-120, 40)).toBe(1);
});

test('a short drag, or one that is mostly vertical, is a scroll and moves nothing', () => {
  expect(daySwipeStep(-(swipeDistance - 1), 0)).toBe(0);
  expect(daySwipeStep(-80, 80)).toBe(0);
  expect(daySwipeStep(0, 200)).toBe(0);
});
