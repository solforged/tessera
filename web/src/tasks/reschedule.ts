import type { AgendaItem, Committed, Operation, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { calendarDate, daysBetween } from './relative-date';
import { isFinished } from './task-labels';
import { shiftCalendarDate } from './week-calendar';

/** Unfinished tasks whose date or explicitly supplied time would change; omitted time preserves each task's time. */
export function movableTo<T extends TaskRow | AgendaItem>(rows: readonly T[], date: string, time?: string | null): T[] {
  return rows.filter(row => !isFinished(row.task) && (row.task.scheduled !== date || time !== undefined && row.task.scheduled_time !== time));
}

export interface Rescheduled {
  count: number;
  /** Puts every moved task's plan back, refusing a task changed since. */
  undo(): Promise<Committed>;
}

/**
 * Moves the schedule of each movable task to `date` as one notebook command. Omitted time preserves each task's
 * time; null explicitly makes it all-day. Deadlines and repeats stay. A missed deadline without a schedule gains
 * one, so the task shows on that day. Null when neither date nor time changes.
 */
export async function rescheduleTasks(notebook: NotebookClient, rows: readonly (TaskRow | AgendaItem)[], date: string, label: string, time?: string | null): Promise<Rescheduled | null> {
  const moving = movableTo(rows, date, time);
  if (!moving.length) return null;
  const operations: Operation[] = moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: row.source.block.revision, task: { ...row.task, scheduled: date, scheduled_time: time === undefined ? row.task.scheduled_time : time } }));
  const committed = await notebook.commit(operations, label);
  const revisions = new Map(committed.revisions.map(value => [value.id, value.revision]));
  return {
    count: moving.length,
    undo: () => notebook.commit(moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: revisions.get(row.source.block.id) ?? row.source.block.revision, task: row.task })), `Undo: ${label}`),
  };
}

export type MoveChoiceId = 'today' | 'tomorrow' | 'weekend' | 'next-week';
export interface MoveChoice { id: MoveChoiceId; label: string; date: string }

/**
 * The quick days the Move to sheet offers, each one once: Today, Tomorrow, this weekend's Saturday while it is further
 * than tomorrow and still ahead this week (Monday to Thursday), and the Monday after today unless that is tomorrow.
 */
export function moveChoices(today: string): MoveChoice[] {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const choices: MoveChoice[] = [{ id: 'today', label: 'Today', date: today }];
  const at = (days: number) => shiftCalendarDate(today, days)!;
  choices.push({ id: 'tomorrow', label: 'Tomorrow', date: at(1) });
  if (weekday >= 1 && weekday <= 4) choices.push({ id: 'weekend', label: 'This weekend', date: at(6 - weekday) });
  const monday = at((8 - weekday) % 7 || 7);
  if (monday !== at(1)) choices.push({ id: 'next-week', label: 'Next week', date: monday });
  return choices;
}

const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shortWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Where a move landed, in prose for a notice: `today`, the weekday within the next six days (`Friday`), else `Nov 9`. */
export function movedWhen(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days > 0 && days <= 6) return weekdayNames[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  return calendarDate(date, today);
}

/** A day for a sheet row: `Fri, Oct 30`. */
export function shortDay(date: string, today: string): string {
  return `${shortWeekdays[new Date(`${date}T12:00:00Z`).getUTCDay()]}, ${calendarDate(date, today)}`;
}
