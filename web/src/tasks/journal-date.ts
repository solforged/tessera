/**
 * Journal dates speak in one place so their form can become a setting: weekday, month, then day (`Tuesday, October 13`).
 * UTC carries the label without a time-zone shift.
 */
const spoken = (date: string, options: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });

export function spokenJournalDate(date: string): string {
  return spoken(date, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** A phone nav bar's inline title for a journal day: the weekday over the month and day, never the ISO date. */
export function journalBarTitle(date: string): { title: string; detail: string } {
  return { title: spoken(date, { weekday: 'long' }), detail: spoken(date, { month: 'long', day: 'numeric' }) };
}

export function journalDayLabel(date: string): string {
  return spoken(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function journalMonthLabel(date: string): string {
  return spoken(date, { month: 'long' });
}

/** ISO weeks are named by their Thursday, including dates that fall in the neighbouring week-year. */
export function journalISOWeek(date: string): { year: number; week: number } {
  const thursday = new Date(`${date}T12:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - (thursday.getUTCDay() + 6) % 7);
  const first = new Date(thursday);
  first.setUTCMonth(0, 4);
  first.setUTCDate(first.getUTCDate() + 3 - (first.getUTCDay() + 6) % 7);
  return { year: thursday.getUTCFullYear(), week: 1 + Math.round((thursday.getTime() - first.getTime()) / 604_800_000) };
}

export function journalWeek(date: string): number {
  return journalISOWeek(date).week;
}

/** Monday through Sunday, carrying civil labels across month and year boundaries. */
export function journalWeekDays(date: string): string[] {
  const monday = new Date(`${date}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

export interface JournalMonthWeek {
  year: number;
  week: number;
  monday: string;
  days: (string | null)[];
}

/** Only this month's days are populated; each margin number retains its ISO week-year. */
export function journalMonthGrid(date: string): JournalMonthWeek[] {
  const first = `${date.slice(0, 7)}-01`;
  const month = Number(date.slice(5, 7)) - 1;
  const end = new Date(`${first}T12:00:00Z`);
  end.setUTCMonth(month + 1, 0);
  const count = end.getUTCDate();
  const start = journalWeekDays(first)[0]!;
  const monday = new Date(`${start}T12:00:00Z`);
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: Math.ceil((offset + count) / 7) }, (_, index) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + index * 7);
    const label = day.toISOString().slice(0, 10);
    return { ...journalISOWeek(label), monday: label, days: journalWeekDays(label).map(value => value.slice(0, 7) === first.slice(0, 7) ? value : null) };
  });
}

export function journalYearMonths(date: string): string[] {
  return Array.from({ length: 12 }, (_, month) => `${date.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-01`);
}

export function journalQuarter(date: string): { year: number; quarter: number; months: string[] } {
  const quarter = Math.ceil(Number(date.slice(5, 7)) / 3);
  return { year: Number(date.slice(0, 4)), quarter, months: journalYearMonths(date).slice((quarter - 1) * 3, quarter * 3) };
}
