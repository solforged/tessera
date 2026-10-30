import { describe, expect, test } from 'bun:test';
import { calendarDate, civilDate, daysBetween, relativeDate, weekRangeProse, weekRangeTitle } from './relative-date';

describe('relativeDate', () => {
  const today = '2026-10-26';

  test('names civil neighbors in words', () => {
    expect(relativeDate('2026-10-26', today)).toBe('today');
    expect(relativeDate('2026-10-25', today)).toBe('yesterday');
    expect(relativeDate('2026-10-27', today)).toBe('tomorrow');
  });

  test('uses the weekday within six days either side, across a week boundary', () => {
    expect(relativeDate('2026-10-24', today)).toBe('Sat');
    expect(relativeDate('2026-10-20', today)).toBe('Tue');
    expect(relativeDate('2026-11-01', today)).toBe('Sun');
    expect(relativeDate('2026-10-28', today)).toBe('Wed');
  });

  test('uses the month and day from a week away within the year, and adds the year beyond it', () => {
    expect(relativeDate('2026-10-19', today)).toBe('Oct 19');
    expect(relativeDate('2026-11-02', today)).toBe('Nov 2');
    expect(relativeDate('2026-01-01', today)).toBe('Jan 1');
    expect(relativeDate('2025-10-24', today)).toBe('Oct 24, 2025');
    expect(relativeDate('2027-03-05', today)).toBe('Mar 5, 2027');
  });

  test('keeps weekdays across a year boundary but names the year for farther dates', () => {
    expect(relativeDate('2027-01-02', '2026-12-30')).toBe('Sat');
    expect(relativeDate('2027-01-06', '2026-12-30')).toBe('Jan 6, 2027');
  });

  test('counts civil days across a daylight-saving change', () => {
    expect(relativeDate('2026-11-02', '2026-11-01')).toBe('tomorrow');
    expect(relativeDate('2026-03-08', '2026-03-07')).toBe('tomorrow');
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-24')).toBe(-7);
  });
});

describe('calendarDate', () => {
  test('omits the year only in today’s year', () => {
    expect(calendarDate('2026-10-24', '2026-10-26')).toBe('Oct 24');
    expect(calendarDate('2025-12-31', '2026-01-01')).toBe('Dec 31, 2025');
    expect(calendarDate('0099-02-03', '2026-10-26')).toBe('Feb 3, 99');
  });
});

describe('civilDate', () => {
  test('reads a timestamp’s date in the notebook zone', () => {
    const at = Date.UTC(2026, 9, 25, 23, 30);
    expect(civilDate(at, 'UTC')).toBe('2026-10-25');
    expect(civilDate(at, 'Asia/Tokyo')).toBe('2026-10-26');
    expect(civilDate(at, 'America/Los_Angeles')).toBe('2026-10-25');
  });
});

describe('weekRangeTitle', () => {
  test('names the ISO week and its span in month and day', () => {
    expect(weekRangeTitle('2026-10-26', '2026-11-01', '2026-10-26')).toBe('Week 44 · Oct 26 – Nov 1');
  });

  test('shows the year once for another year’s week, and on both sides across a year boundary', () => {
    expect(weekRangeTitle('2025-10-27', '2025-11-02', '2026-10-26')).toBe('Week 44 · Oct 27 – Nov 2, 2025');
    expect(weekRangeTitle('2026-12-28', '2027-01-03', '2026-10-26')).toBe('Week 53 · Dec 28, 2026 – Jan 3, 2027');
    expect(weekRangeTitle('2025-12-29', '2026-01-04', '2026-10-26')).toBe('Week 1 · Dec 29, 2025 – Jan 4');
  });
});

describe('weekRangeProse', () => {
  test('reads the week as a span of month and day, naming the year once where it is not today’s', () => {
    expect(weekRangeProse('2026-10-26', '2026-11-01', '2026-10-29')).toBe('Oct 26 to Nov 1');
    expect(weekRangeProse('2025-10-27', '2025-11-02', '2026-10-29')).toBe('Oct 27 to Nov 2, 2025');
    expect(weekRangeProse('2026-12-28', '2027-01-03', '2026-12-30')).toBe('Dec 28, 2026 to Jan 3, 2027');
  });
});
