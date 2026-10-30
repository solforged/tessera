import { describe, expect, test } from 'bun:test';
import type { Grade, ReviewEvent, ReviewForecastDay, SchedulingState } from '../api/types';
import { nextDueLine, rememberedLine, tallyGrades } from './session-end';

const schedule: SchedulingState = { stability: 8, difficulty: 5, interval_days: 8, repetitions: 3, lapses: 0, due_at: 100, last_reviewed_at: 50 };
const event = (grade: Grade | null, kind: ReviewEvent['kind'] = 'grade'): ReviewEvent => ({
  id: `${kind}-${grade}`, card_id: 'card', session_id: 'session', kind, grade,
  shown_front: 'a', shown_back: 'b', definition_revision: 1, scheduler_version: 'fsrs-6', before: schedule, after: schedule,
  created_at: 1, change_seq: 1, undone_by: null,
});
const day = (date: string, count: number): ReviewForecastDay => ({ date, count });

describe('the end of a review session', () => {
  test('counts each grade and treats everything but Again as remembered', () => {
    const tally = tallyGrades([event('again'), event('hard'), event('hard'), event('good'), event('good'), event('good'), event('good'), event('good'), event('easy'), event(null, 'reset')]);
    expect(tally).toEqual({ graded: 9, again: 1, hard: 2, good: 5, easy: 1, remembered: 8 });
    expect(rememberedLine(tally)).toBe('You remembered 8 of them');
  });

  test('says retention in words for one card, a clean session and an empty one', () => {
    expect(rememberedLine(tallyGrades([event('good')]))).toBe('You remembered it');
    expect(rememberedLine(tallyGrades([event('again')]))).toBe('It will come back soon');
    expect(rememberedLine(tallyGrades([event('easy'), event('good')]))).toBe('You remembered all of them');
    expect(rememberedLine(tallyGrades([]))).toBe('');
  });

  test('names the next due day in words and counts what falls due after today', () => {
    const forecast = [day('2026-10-29', 0), day('2026-10-30', 0), day('2026-10-31', 1), day('2026-11-01', 1), day('2026-11-04', 1), day('2026-11-05', 2), day('2026-11-06', 1), day('2026-11-11', 2)];
    expect(nextDueLine(forecast, '2026-10-29')).toBe('Next card is due Saturday, 8 more in two weeks');
  });

  test('says tomorrow, a calendar day beyond six days, and a single card without a tally', () => {
    expect(nextDueLine([day('2026-10-29', 0), day('2026-10-30', 3)], '2026-10-29')).toBe('Next card is due tomorrow, 3 more in two weeks');
    expect(nextDueLine([day('2026-10-29', 0), day('2026-11-08', 1)], '2026-10-29')).toBe('Next card is due Nov 8');
  });

  test('a card still due today comes first, and an empty forecast promises nothing', () => {
    expect(nextDueLine([day('2026-10-29', 2), day('2026-10-30', 1)], '2026-10-29')).toBe('Next card is due today');
    expect(nextDueLine([day('2026-10-29', 0), day('2026-10-30', 0)], '2026-10-29')).toBe('Nothing else is due in the next two weeks');
  });
});
