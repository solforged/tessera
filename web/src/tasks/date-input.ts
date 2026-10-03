type DateResult = { ok: true; date: string | null; time: string | null } | { ok: false; error: string };
type CivilDate = { year: number; month: number; day: number };

const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const leapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year: number, month: number) => month === 2 ? (leapYear(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
const daysBeforeYear = (year: number) => {
  const previous = year - 1;
  return previous * 365 + Math.floor(previous / 4) - Math.floor(previous / 100) + Math.floor(previous / 400);
};
const ordinal = (date: CivilDate) => daysBeforeYear(date.year) + monthStarts[date.month - 1]! + (date.month > 2 && leapYear(date.year) ? 1 : 0) + date.day;
const lastDay = daysBeforeYear(10000);

function civilDate(value: string): CivilDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) return null;
  return { year, month, day };
}

function dateAt(day: number): string {
  let year = 1;
  let end = 10000;
  while (year + 1 < end) {
    const middle = Math.floor((year + end) / 2);
    if (daysBeforeYear(middle) < day) year = middle;
    else end = middle;
  }
  let remaining = day - daysBeforeYear(year);
  let month = 1;
  while (true) {
    const length = monthDays(year, month);
    if (remaining <= length) break;
    remaining -= length;
    month++;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(remaining).padStart(2, '0')}`;
}

/** Civil labels only: contextDate supplies today, independent of clocks and time zones. */
export function parseTaskDate(input: string, contextDate: string): DateResult {
  let text = input.trim();
  if (!text) return { ok: true, date: null, time: null };
  if (text.startsWith('@')) text = text.slice(1).trim();
  if (!text) return { ok: false, error: 'Enter a date after @.' };
  text = text.toLowerCase().replace(/\s+/g, ' ');

  let time: string | null = null;
  const clock = /(?:^| )(\S*:\S*)$/.exec(text);
  if (clock) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock[1]!)) return { ok: false, error: 'Use a time from 00:00 to 23:59 (HH:MM).' };
    time = clock[1]!;
    text = text.slice(0, clock.index).trim();
    if (!text) return { ok: false, error: 'Enter a date before a time.' };
  }

  const context = civilDate(contextDate);
  if (!context) return { ok: false, error: 'The context date must be a valid YYYY-MM-DD date.' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return civilDate(text) ? { ok: true, date: text, time } : { ok: false, error: 'Enter a valid calendar date.' };
  }

  const base = ordinal(context);
  let offset: number;
  if (text === 'today') offset = 0;
  else if (text === 'tomorrow') offset = 1;
  else if (text === 'yesterday') offset = -1;
  else {
    const relative = /^\+(\d+)([dw])$/.exec(text) ?? /^in (\d+) (days?|weeks?)$/.exec(text);
    if (relative) offset = Number(relative[1]) * (relative[2]!.startsWith('w') ? 7 : 1);
    else {
      const next = text.startsWith('next ');
      const name = next ? text.slice(5) : text;
      const weekday = weekdays.findIndex(day => day === name || day.slice(0, 3) === name);
      if (weekday === -1) return { ok: false, error: 'Use YYYY-MM-DD, today, tomorrow, yesterday, a weekday, +Nd/+Nw, or in N days/weeks.' };
      offset = (weekday - base % 7 + 7) % 7;
      if (next && offset === 0) offset = 7;
    }
  }
  const target = base + offset;
  if (!Number.isSafeInteger(offset) || target < 1 || target > lastDay) return { ok: false, error: 'Choose a date from 0001-01-01 to 9999-12-31.' };
  return { ok: true, date: dateAt(target), time };
}
