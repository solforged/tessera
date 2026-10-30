import type { ReviewEvent, ReviewForecastDay } from '../api/types';
import { journalBarTitle } from '../tasks/journal-date';
import { calendarDate, daysBetween } from '../tasks/relative-date';

export interface SessionTally { graded: number; again: number; hard: number; good: number; easy: number; remembered: number }

/** How a session went, from the grade events it has kept; a grade that was undone is not among them. */
export function tallyGrades(events: readonly ReviewEvent[]): SessionTally {
  const tally: SessionTally = { graded: 0, again: 0, hard: 0, good: 0, easy: 0, remembered: 0 };
  for (const event of events) {
    if (event.kind !== 'grade' || !event.grade) continue;
    tally.graded++; tally[event.grade]++;
  }
  tally.remembered = tally.graded - tally.again;
  return tally;
}

/** The session's retention in words; a card is remembered unless it was graded Again. */
export function rememberedLine(tally: SessionTally): string {
  if (!tally.graded) return '';
  if (tally.graded === 1) return tally.remembered ? 'You remembered it' : 'It will come back soon';
  return tally.remembered === tally.graded ? 'You remembered all of them' : `You remembered ${tally.remembered} of them`;
}

/** A day as the end screen says it: tomorrow, the weekday within six days, then the month and day. */
function dayInWords(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days <= 6 ? journalBarTitle(date).title : calendarDate(date, today);
}

/**
 * What comes next, from the two-week forecast the landing draws: the first day with cards due, and how many fall due
 * after today. An empty forecast says so rather than promising a card.
 */
export function nextDueLine(forecast: readonly ReviewForecastDay[], today: string): string {
  const next = forecast.find(day => day.count > 0 && daysBetween(today, day.date) >= 0);
  if (!next) return 'Nothing else is due in the next two weeks';
  const later = forecast.reduce((sum, day) => daysBetween(today, day.date) > 0 ? sum + day.count : sum, 0);
  return `Next card is due ${dayInWords(next.date, today)}${later > 1 ? `, ${later} more in two weeks` : ''}`;
}
