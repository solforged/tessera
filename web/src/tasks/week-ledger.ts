import type { TaskRow } from '../api/types';
import { agendaTaskTime, isFinished } from './task-labels';
import { calendarWeekDates } from './week-calendar';

/** One source row per day, even when its schedule and deadline coincide. */
export function weekLedgerDays(rows: readonly TaskRow[], date: string) {
  return calendarWeekDates(date).filter((day): day is string => day !== null).map(day => {
    const byId = new Map(rows.filter(row => row.task.scheduled === day || row.task.deadline === day).map(row => [row.source.block.id, row]));
    const planned = [...byId.values()];
    planned.sort((left, right) => (agendaTaskTime(left, day, false) ?? '').localeCompare(agendaTaskTime(right, day, false) ?? '')
      || left.source.block.text.localeCompare(right.source.block.text));
    return { date: day, rows: planned, open: planned.filter(row => !isFinished(row.task)).length, done: planned.filter(row => row.task.status === 'done').length };
  });
}

export function weekLedgerSummary(rows: readonly TaskRow[], date: string): string {
  const dates = calendarWeekDates(date).filter((day): day is string => day !== null);
  if (!dates.length) return '';
  const visible = new Set(dates);
  const open = new Map(rows.filter(row => !isFinished(row.task) && (visible.has(row.task.scheduled ?? '') || visible.has(row.task.deadline ?? ''))).map(row => [row.source.block.id, row]));
  const due = [...open.values()].filter(row => visible.has(row.task.deadline ?? '')).length;
  return `${open.size} open · ${due} due`;
}
