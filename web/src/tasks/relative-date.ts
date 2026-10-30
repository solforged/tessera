import { journalBarTitle, journalWeek } from './journal-date';

/**
 * Every list that names a day says it one way, measured from civil today: today, yesterday and tomorrow; the weekday
 * within six days either side; then the month and day (`Oct 24`), adding the year outside today's (`Oct 24, 2025`).
 * Dates are civil ISO strings already in the notebook's zone; `civilDate` brings a timestamp there first.
 */

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// UTC noon keeps day arithmetic clear of daylight-saving edges and the device's zone.
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

/** Whole civil days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000);
}

/** `Oct 24` in `today`'s year, `Oct 24, 2025` outside it. */
export function calendarDate(date: string, today: string): string {
  const day = `${months[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  return date.slice(0, 4) === today.slice(0, 4) ? day : `${day}, ${Number(date.slice(0, 4))}`;
}

/** Lowercase, since it usually follows a word in a row: `since yesterday`, `due Sat`, `done Oct 2`. */
export function relativeDate(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (Math.abs(days) <= 6) return weekdays[noon(date).getUTCDay()]!;
  return calendarDate(date, today);
}

/** A journal day named the way a phone's lists name it: Today, Yesterday, Tomorrow, the weekday in full within six days, then `Oct 2`. */
export function journalLabel(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  return Math.abs(days) <= 6 ? journalBarTitle(date).title : calendarDate(date, today);
}

/** The civil date of a timestamp in `zone`, or this device's zone while the notebook has none. */
export function civilDate(value: number, zone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

/** `Week 44 · Oct 26 – Nov 1`: the ISO week of `monday` and its Monday–Sunday span, the year shown once where it differs from today's. */
export function weekRangeTitle(monday: string, sunday: string, today: string): string {
  return `Week ${journalWeek(monday)} · ${calendarDate(monday, sunday)} – ${calendarDate(sunday, today)}`;
}

/** A phone's week title: `Oct 26 to Nov 1`, the year added where it is not today's. */
export function weekRangeProse(monday: string, sunday: string, today: string): string {
  return `${calendarDate(monday, sunday)} to ${calendarDate(sunday, today)}`;
}
