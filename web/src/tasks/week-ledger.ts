import type { TaskRow } from '../api/types';
import { agendaTaskTime, isFinished } from './task-labels';
import { calendarWeekDates } from './week-calendar';

/** One source row per day, even when its schedule and deadline coincide. Missed work joins today, as in the desktop grid. */
export function weekLedgerDays(rows: readonly TaskRow[], date: string, today = '', overdue: readonly TaskRow[] = []) {
  return calendarWeekDates(date).filter((day): day is string => day !== null).map(day => {
    const byId = new Map([...(day === today ? overdue : []), ...rows.filter(row => row.task.scheduled === day || row.task.deadline === day)].map(row => [row.source.block.id, row]));
    const planned = [...byId.values()];
    planned.sort((left, right) => (agendaTaskTime(left, day, false) ?? '').localeCompare(agendaTaskTime(right, day, false) ?? '')
      || left.source.block.text.localeCompare(right.source.block.text));
    return { date: day, rows: planned, open: planned.filter(row => !isFinished(row.task)).length, done: planned.filter(row => row.task.status === 'done').length };
  });
}

/** Open tasks whose plan predates the week; work missed earlier in the week stays on its own day. */
export function weekLedgerOverdue(rows: readonly TaskRow[], date: string): TaskRow[] {
  const first = calendarWeekDates(date).find((day): day is string => day !== null);
  if (!first) return [];
  return rows.filter(row => row.task.status !== null && !isFinished(row.task) && (!!row.task.scheduled && row.task.scheduled < first || !!row.task.deadline && row.task.deadline < first));
}

export function weekLedgerSummary(rows: readonly TaskRow[], date: string, overdue: readonly TaskRow[] = []): string {
  const dates = calendarWeekDates(date).filter((day): day is string => day !== null);
  if (!dates.length) return '';
  const visible = new Set(dates);
  const open = new Map(rows.filter(row => !isFinished(row.task) && (visible.has(row.task.scheduled ?? '') || visible.has(row.task.deadline ?? ''))).map(row => [row.source.block.id, row]));
  const due = [...open.values()].filter(row => visible.has(row.task.deadline ?? '')).length;
  const missed = new Set(overdue.map(row => row.source.block.id).filter(id => !open.has(id))).size;
  return `${open.size} open · ${due} due${missed ? ` · ${missed} overdue` : ''}`;
}

export interface WeekCounts { open: number; overdue: number }

/**
 * The week band's two figures on a phone: unfinished tasks planned this week or missed before it, and those among them
 * whose plan day has already passed. Each source counts once, however many of its dates fall in the week.
 */
export function weekLedgerCounts(rows: readonly TaskRow[], date: string, today: string, overdue: readonly TaskRow[] = []): WeekCounts {
  const visible = new Set(calendarWeekDates(date).filter((day): day is string => day !== null));
  const plans = (row: TaskRow) => [row.task.scheduled, row.task.deadline].filter((plan): plan is string => !!plan);
  const open = new Map(rows.filter(row => !isFinished(row.task) && plans(row).some(plan => visible.has(plan))).map(row => [row.source.block.id, row]));
  const missed = new Set(overdue.map(row => row.source.block.id));
  for (const row of overdue) open.set(row.source.block.id, row);
  const late = [...open].filter(([id, row]) => missed.has(id) || plans(row).some(plan => visible.has(plan) && plan < today)).length;
  return { open: open.size, overdue: late };
}
