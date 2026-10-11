import { describe, expect, test } from 'bun:test';
import { journalWeek, spokenJournalDate } from './journal-date';

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
});
