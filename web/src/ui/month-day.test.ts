import { describe, expect, test } from 'bun:test';
import { inMonth } from './month-day';

const day = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];

describe('the same day in another month', () => {
  test('keeps the day of the month when the month has it', () => {
    expect(day(inMonth(new Date(2026, 10, 14, 12), 1, 14))).toEqual([2026, 12, 14]);
    expect(day(inMonth(new Date(2026, 10, 14, 12), -3, 14))).toEqual([2026, 8, 14]);
  });

  test('clamps to a shorter month instead of spilling into the next', () => {
    expect(day(inMonth(new Date(2027, 0, 31, 12), 1, 31))).toEqual([2027, 2, 28]);
    expect(day(inMonth(new Date(2028, 0, 31, 12), 1, 31))).toEqual([2028, 2, 29]);
    expect(day(inMonth(new Date(2026, 4, 31, 12), 1, 31))).toEqual([2026, 6, 30]);
  });

  test('crosses year ends in both directions', () => {
    expect(day(inMonth(new Date(2026, 11, 15, 12), 1, 15))).toEqual([2027, 1, 15]);
    expect(day(inMonth(new Date(2027, 0, 15, 12), -1, 15))).toEqual([2026, 12, 15]);
  });

  test('a remembered 31st comes back when the month allows it', () => {
    const february = inMonth(new Date(2027, 0, 31, 12), 1, 31);
    expect(day(inMonth(february, 1, 31))).toEqual([2027, 3, 31]);
  });
});
