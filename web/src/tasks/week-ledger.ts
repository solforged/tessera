import type { TaskRow } from '../api/types';
import { agendaTaskTime, isFinished } from './task-labels';
import { calendarWeekDates } from './week-calendar';

/** One source row per day, even when its schedule and deadline coincide. */
export function weekLedgerDays(rows: readonly TaskRow[], date: string, today: string, now: string) {
  return calendarWeekDates(date).filter((day): day is string => day !== null).map(day => {
    const byId = new Map(rows.filter(row => row.task.scheduled === day || row.task.deadline === day).map(row => [row.source.block.id, row]));
    const planned = [...byId.values()];
    const past = (row: TaskRow) => day === today && !!agendaTaskTime(row, day, false) && agendaTaskTime(row, day, false)! < now;
    planned.sort((left, right) => Number(past(right)) - Number(past(left))
      || (agendaTaskTime(left, day, false) ?? '').localeCompare(agendaTaskTime(right, day, false) ?? '')
      || left.source.block.text.localeCompare(right.source.block.text));
    return { date: day, rows: planned, open: planned.filter(row => !isFinished(row.task)).length, done: planned.filter(row => row.task.status === 'done').length };
  });
}

export function weekLedgerSummary(rows: readonly TaskRow[], date: string): string {
  const dates = calendarWeekDates(date).filter((day): day is string => day !== null);
  if (!dates.length) return '';
  const visible = new Set(dates);
  const open = new Map(rows.filter(row => !isFinished(row.task) && (visible.has(row.task.scheduled ?? '') || visible.has(row.task.deadline ?? ''))).map(row => [row.source.block.id, row]));
  const first = new Date(`${dates[0]}T12:00:00Z`), last = new Date(`${dates.at(-1)}T12:00:00Z`);
  const format = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
  const start = first.getUTCMonth() === last.getUTCMonth() ? `${first.getUTCDate()}` : `${first.getUTCDate()} ${format.format(first)}`;
  const due = [...open.values()].filter(row => visible.has(row.task.deadline ?? '')).length;
  return `${start}–${last.getUTCDate()} ${format.format(last)} · ${open.size} open · ${due} due`;
}
