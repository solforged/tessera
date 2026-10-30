import type { TaskRow, TaskStatus } from '../api/types';
import { calendarDate, daysBetween } from './relative-date';
import { agendaTaskTime, isFinished } from './task-labels';
import { taskStatuses } from './task-chips';

/** How the phone's Tasks list is grouped: by the day a task is due, or by where it stands. */
export type TaskGrouping = 'due' | 'status';
export const taskGroupings: { value: TaskGrouping; label: string }[] = [{ value: 'due', label: 'By due' }, { value: 'status', label: 'By status' }];

export interface TaskGroup {
  key: string;
  /** Heading text: Overdue, Today, Tomorrow, a weekday, a month and day, No date, Done or a status. */
  name: string;
  /** Set on a day's group, for the rows' plan date. */
  date?: string;
  overdue?: boolean;
  rows: TaskRow[];
}

/** The day a task asks for: its earlier plan, since missed work leads its group. */
export function dueDate(row: TaskRow): string | null {
  return [row.task.scheduled, row.task.deadline].filter((date): date is string => !!date).sort()[0] ?? null;
}

/** A day's heading in prose: Today, Tomorrow, the weekday within the next week, else `Nov 14`. */
export function dueGroupName(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return calendarDate(date, today);
}

const byClock = (date: string) => (left: TaskRow, right: TaskRow) => {
  const from = agendaTaskTime(left, date), to = agendaTaskTime(right, date);
  if (from !== to && (from === null || to === null)) return from === null ? 1 : -1;
  return (from ?? '').localeCompare(to ?? '') || left.source.block.text.localeCompare(right.source.block.text);
};

/**
 * Open tasks by due day: Overdue (oldest first), then each day in order, then No date; finished work closes the list as Done.
 * A task with a time leads its day's untimed ones.
 */
export function groupByDue(rows: readonly TaskRow[], today: string): TaskGroup[] {
  const overdue: TaskRow[] = [], days = new Map<string, TaskRow[]>(), undated: TaskRow[] = [], done: TaskRow[] = [];
  for (const row of rows) {
    const date = dueDate(row);
    if (isFinished(row.task)) done.push(row);
    else if (!date) undated.push(row);
    else if (date < today) overdue.push(row);
    else days.set(date, [...days.get(date) ?? [], row]);
  }
  const groups: TaskGroup[] = [];
  if (overdue.length) groups.push({ key: 'overdue', name: 'Overdue', overdue: true, rows: overdue.sort((left, right) => dueDate(left)!.localeCompare(dueDate(right)!) || byClock(dueDate(left)!)(left, right)) });
  for (const date of [...days.keys()].sort()) groups.push({ key: date, name: dueGroupName(date, today), date, rows: days.get(date)!.sort(byClock(date)) });
  if (undated.length) groups.push({ key: 'undated', name: 'No date', rows: undated });
  if (done.length) groups.push({ key: 'done', name: 'Done', rows: done });
  return groups;
}

const statusOrder: TaskStatus[] = ['doing', 'todo', 'waiting', 'done', 'cancelled'];

/** One group per status that has tasks, work in progress first; order within a status is the query's. Appointments have no status. */
export function groupByStatus(rows: readonly TaskRow[]): TaskGroup[] {
  const groups: TaskGroup[] = statusOrder.flatMap(status => {
    const members = rows.filter(row => row.task.status === status);
    return members.length ? [{ key: status, name: taskStatuses.find(item => item.value === status)!.label, rows: members }] : [];
  });
  const appointments = rows.filter(row => row.task.status === null);
  return appointments.length ? [...groups, { key: 'none', name: 'No status', rows: appointments }] : groups;
}
