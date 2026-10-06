import type { TaskState } from '../api/types';
import { matchFieldEntry } from '../table/query';
import { parseTaskDate } from './date-input';

export interface DateToken { from: number; to: number; query: string; field: 'scheduled' | 'deadline' }
export interface DateSuggestion { label: string; date: string; time: string | null }

export const newTask = (): TaskState => ({ status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null });

/** Ignore even unfinished references/code while the author is typing. */
export function insideProtectedSyntax(text: string, at: number): boolean {
  for (let cursor = 0; cursor < at;) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (text.startsWith('[[', cursor)) {
      cursor += 2;
      while (cursor < text.length && !text.startsWith(']]', cursor)) cursor += text[cursor] === '\\' ? 2 : 1;
      cursor = Math.min(text.length, cursor + 2);
      if (cursor > at) return true;
      continue;
    }
    const marker = text[cursor];
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const fenceStart = /^[ ]{0,3}$/.test(text.slice(lineStart, cursor));
    if (marker !== '`' && !(marker === '~' && fenceStart)) { cursor++; continue; }
    let end = cursor;
    while (text[end] === marker) end++;
    const count = end - cursor;
    const newline = text.indexOf('\n', end);
    const openingEnd = newline < 0 ? text.length : newline;
    if (count >= 3 && fenceStart && (marker === '~' || !text.slice(end, openingEnd).includes('`'))) {
      const close = new RegExp(`^[ ]{0,3}${marker}{${count},}[ \\t\\r]*$`);
      cursor = Math.min(openingEnd + 1, text.length);
      while (cursor < text.length) {
        const next = text.indexOf('\n', cursor);
        const lineEnd = next < 0 ? text.length : next;
        const closed = close.test(text.slice(cursor, lineEnd));
        cursor = Math.min(lineEnd + 1, text.length);
        if (closed) break;
      }
    } else if (marker === '`') {
      cursor = end;
      for (;;) {
        const start = text.indexOf('`', cursor);
        if (start < 0) { cursor = text.length; break; }
        cursor = start;
        while (text[cursor] === '`') cursor++;
        if (cursor - start === count) break;
      }
    } else cursor = end;
    if (cursor > at) return true;
  }
  return false;
}

/** The active @ token ends at the caret, not necessarily at the end of the block. */
export function dateTokenAt(text: string, caret: number): DateToken | null {
  if (caret <= 0 || caret > text.length || matchFieldEntry(text)) return null;
  const from = text.lastIndexOf('@', caret - 1);
  if (from < 0 || from > 0 && !/\s/.test(text[from - 1]!) || insideProtectedSyntax(text, from)) return null;
  const query = text.slice(from + 1, caret);
  if (/^\s/.test(query) || /[\r\n]/.test(query)) return null;
  const deadline = /^(?:by|due)(?: +|$)/i.exec(query);
  if (deadline) return { from, to: caret, query: query.slice(deadline[0].length), field: 'deadline' };
  return { from, to: caret, query, field: 'scheduled' };
}

/** Tab changes only the planning field, retaining the query, surrounding text and live caret. */
export function flipDateToken(text: string, token: DateToken): { text: string; caret: number } {
  const query = text.slice(token.from + 1, token.to);
  const next = token.field === 'scheduled' ? `by ${query}` : query.replace(/^(?:by|due)(?: +|$)/i, '');
  return {
    text: text.slice(0, token.from + 1) + next + text.slice(token.to),
    caret: token.from + 1 + next.length,
  };
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayLabel(date: string): string {
  const year = Number(date.slice(0, 4));
  // Date.UTC interprets years 0–99 as 1900–1999; a Gregorian 400-year cycle has the same weekdays.
  const day = new Date(Date.UTC(year < 100 ? year + 400 : year, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
  return weekdays[day]!;
}
function parsedLabel(query: string, date: string): string {
  const name = query.toLowerCase().replace(/\s+/g, ' ').replace(/(?:^| )(?:\d{1,2}:\d{2}(?:am|pm)?|\d{1,2}(?:am|pm))$/, '');
  if (!name) return 'Today';
  if (name === 'today' || name === 'tomorrow' || name === 'yesterday') return name[0]!.toUpperCase() + name.slice(1);
  const next = name.startsWith('next ');
  const weekday = next ? name.slice(5) : name;
  if (weekdays.some(day => day.toLowerCase() === weekday || day.slice(0, 3).toLowerCase() === weekday)) {
    return `${next ? 'Next ' : ''}${weekdayLabel(date)}`;
  }
  return weekdayLabel(date);
}

/** All relative dates use the supplied civil today, never the device clock. */
export function dateSuggestions(query: string, contextDate: string): DateSuggestion[] {
  const presets: DateSuggestion[] = [];
  for (let offset = 0; offset <= 7; offset++) {
    const parsed = parseTaskDate(`@+${offset}d`, contextDate);
    if (!parsed.ok || !parsed.date) continue;
    const label = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : offset === 7 ? 'Next week' : weekdayLabel(parsed.date);
    presets.push({ label, date: parsed.date, time: null });
  }
  const trimmed = query.trim();
  // Empty input exposes every preset; filtered results below are capped at seven.
  if (!trimmed) return presets;
  const suggestions: DateSuggestion[] = [];
  const parsed = parseTaskDate('@' + trimmed, contextDate);
  if (parsed.ok && parsed.date) {
    const label = parsedLabel(trimmed, parsed.date) + (parsed.time ? ` ${parsed.time}` : '');
    suggestions.push({ label, date: parsed.date, time: parsed.time });
  }
  const prefix = trimmed.toLowerCase();
  for (const preset of presets) {
    if (!preset.label.toLowerCase().startsWith(prefix) && !(preset.label === 'Next week' && 'week'.startsWith(prefix))) continue;
    if (suggestions.some(choice => choice.date === preset.date && choice.time === preset.time)) continue;
    suggestions.push(preset);
  }
  return suggestions.slice(0, 7);
}

/** Trim the introducing whitespace when the suffix is empty or starts with whitespace. */
export function removeToken(text: string, token: { from: number; to: number }): { text: string; caret: number } {
  const before = text.slice(0, token.from);
  const after = text.slice(token.to);
  const start = after === '' || /^\s/.test(after) ? before.trimEnd().length : before.length;
  return { text: text.slice(0, start) + after, caret: start };
}

/** A null choice keeps the current plan for choosing the date in the full picker. */
export function planDateToken(text: string, token: DateToken, choice: DateSuggestion | null, task: TaskState | null): { text: string; caret: number; value: TaskState } {
  const base = task ?? newTask();
  const value = choice
    ? token.field === 'deadline'
      ? { ...base, deadline: choice.date, deadline_time: choice.time }
      : { ...base, scheduled: choice.date, scheduled_time: choice.time }
    : base;
  return { ...removeToken(text, token), value };
}
