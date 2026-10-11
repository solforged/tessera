import { describe, expect, test } from 'bun:test';
import { journalDayLabel, journalISOWeek, journalMonthGrid, journalQuarter, journalWeek, journalWeekDays, journalYearMonths, spokenJournalDate } from './journal-date';

describe('journal date presentation', () => {
  test('speaks a civil date without changing its stored ISO label', () => {
    expect(spokenJournalDate('2026-10-10')).toBe('Saturday 10 October');
    expect(spokenJournalDate('2026-01-01')).toBe('Thursday 1 January');
  });
  test('uses ISO weeks at both ends of the calendar year', () => {
    expect(journalWeek('2026-10-10')).toBe(41);
    expect(journalWeek('2021-01-01')).toBe(53);
    expect(journalWeek('2024-12-30')).toBe(1);
    expect(journalWeek('2026-01-01')).toBe(1);
  });
  test('keeps the ISO week-year through New Year', () => {
    expect(journalISOWeek('2026-12-31')).toEqual({ year: 2026, week: 53 });
    expect(journalISOWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(journalISOWeek('2027-01-04')).toEqual({ year: 2027, week: 1 });
    expect(journalISOWeek('2024-12-30')).toEqual({ year: 2025, week: 1 });
  });
  test('lists all seven civil days across year boundaries', () => {
    expect(journalWeekDays('2027-01-01')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(journalWeekDays('2026-10-11')).toEqual(journalWeekDays('2026-10-05'));
    expect(journalWeekDays('2026-10-12')[0]).toBe('2026-10-12');
  });
  test('month grids put Monday first and keep week-year labels on their margin', () => {
    const january = journalMonthGrid('2027-01-01');
    expect(january[0]).toEqual({ year: 2026, week: 53, monday: '2026-12-28', days: [null, null, null, null, '2027-01-01', '2027-01-02', '2027-01-03'] });
    expect(january[1]!.week).toBe(1);
    expect(january[1]!.year).toBe(2027);
    expect(january.flatMap(row => row.days).filter(Boolean)).toHaveLength(31);
    expect(journalMonthGrid('2026-02-01')).toHaveLength(5);
    expect(journalMonthGrid('2021-02-01')).toHaveLength(4);
    expect(journalMonthGrid('2026-03-01')).toHaveLength(6);
  });
  test('month grids honour leap-year and century boundaries', () => {
    expect(journalMonthGrid('2024-02-01').flatMap(row => row.days).filter(Boolean)).toHaveLength(29);
    expect(journalMonthGrid('2000-02-01').flatMap(row => row.days).filter(Boolean)).toHaveLength(29);
    expect(journalMonthGrid('2100-02-01').flatMap(row => row.days).filter(Boolean)).toHaveLength(28);
  });
  test('quarter months transition at their civil boundaries', () => {
    expect(journalQuarter('2026-03-31')).toEqual({ year: 2026, quarter: 1, months: ['2026-01-01', '2026-02-01', '2026-03-01'] });
    expect(journalQuarter('2026-04-01').quarter).toBe(2);
    expect(journalQuarter('2026-10-10')).toEqual({ year: 2026, quarter: 4, months: ['2026-10-01', '2026-11-01', '2026-12-01'] });
    expect(journalYearMonths('2027-01-01')).toHaveLength(12);
    expect(journalYearMonths('2027-12-31').at(-1)).toBe('2027-12-01');
  });
  test('day buttons have a full spoken civil label including the year', () => {
    expect(journalDayLabel('2027-01-01')).toBe('Friday 1 January 2027');
  });
});
