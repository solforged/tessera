import type { TaskQuery, TaskQueryResult, TaskRow, TaskState, TaskStatus } from '../api/types';
import { parseTaskDate } from './date-input';

const taskStatuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
const taskQueryLimit = 2000;
const minutesPerDay = 24 * 60;

export interface WeekEntry {
  key: string;
  row: TaskRow;
  date: string;
  kind: 'scheduled' | 'due';
  time: string | null;
  due: boolean;
}

export interface TimedWeekEntry {
  entry: WeekEntry;
  minute: number;
  lane: number;
  lanes: number;
}

export interface IncompleteWeekRange {
  field: 'scheduled' | 'deadline';
  date: string;
  status: TaskStatus;
  shown: number;
  total: number;
}

export interface WeekTaskResults {
  rows: TaskRow[];
  incomplete: IncompleteWeekRange[];
}

/** UTC is only an arithmetic carrier. These values remain civil calendar labels. */
export function shiftCalendarDate(date: string, days: number): string | null {
  if (!Number.isSafeInteger(days) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = parseTaskDate(date, date);
  if (!parsed.ok) return null;
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const year = value.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export function mondayWeekStart(date: string): string | null {
  if (!shiftCalendarDate(date, 0)) return null;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftCalendarDate(date, -((weekday + 6) % 7));
}

/** Keep seven columns even when the final supported year ends midweek. */
export function calendarWeekDates(date: string): (string | null)[] {
  const start = mondayWeekStart(date);
  return Array.from({ length: 7 }, (_, index) => start ? shiftCalendarDate(start, index) : null);
}

export function timeMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function snapWeekMinutes(minutes: number): number {
  return Math.max(0, Math.min(minutesPerDay - 15, Math.round(minutes / 15) * 15));
}

export function scheduleWeekTask(task: TaskState, date: string, minutes: number | null): TaskState {
  const snapped = minutes === null ? null : snapWeekMinutes(minutes);
  const time = snapped === null ? null : `${String(Math.floor(snapped / 60)).padStart(2, '0')}:${String(snapped % 60).padStart(2, '0')}`;
  return { ...task, scheduled: date, scheduled_time: time };
}

export function keyboardWeekSchedule(task: TaskState, visibleDate: string, key: string): TaskState | null {
  const date = task.scheduled ?? visibleDate;
  if (key === 'Home') return scheduleWeekTask(task, date, null);
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const next = shiftCalendarDate(date, key === 'ArrowLeft' ? -1 : 1);
    return next ? { ...task, scheduled: next } : null;
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
  const minutes = (task.scheduled_time ? timeMinutes(task.scheduled_time) : 8 * 60) + (key === 'ArrowUp' ? -15 : 15);
  const nextDate = shiftCalendarDate(date, Math.floor(minutes / minutesPerDay));
  if (!nextDate) return null;
  const withinDay = (minutes + minutesPerDay) % minutesPerDay;
  const time = `${String(Math.floor(withinDay / 60)).padStart(2, '0')}:${String(withinDay % 60).padStart(2, '0')}`;
  return { ...task, scheduled: nextDate, scheduled_time: time };
}

export function mergeWeekTaskRows(...groups: readonly TaskRow[][]): TaskRow[] {
  const rows = new Map<string, TaskRow>();
  for (const group of groups) {
    for (const row of group) {
      const previous = rows.get(row.source.block.id);
      if (!previous || previous.source.block.revision < row.source.block.revision) rows.set(row.source.block.id, row);
    }
  }
  return [...rows.values()];
}

export function weekTaskEntries(rows: readonly TaskRow[], dates: readonly (string | null)[]): WeekEntry[] {
  const visible = new Set(dates);
  const entries: WeekEntry[] = [];
  for (const row of rows) {
    const task = row.task;
    const scheduled = task.scheduled !== null && visible.has(task.scheduled);
    const combined = scheduled && task.scheduled_time === null && task.deadline === task.scheduled;
    if (scheduled) entries.push({ key: `scheduled:${row.source.block.id}`, row, date: task.scheduled!, kind: 'scheduled', time: task.scheduled_time, due: combined });
    if (task.deadline !== null && visible.has(task.deadline) && !combined) {
      entries.push({ key: `due:${row.source.block.id}`, row, date: task.deadline, kind: 'due', time: task.deadline_time, due: true });
    }
  }
  return entries.sort((left, right) => left.date.localeCompare(right.date)
    || Number(['done', 'cancelled'].includes(left.row.task.status)) - Number(['done', 'cancelled'].includes(right.row.task.status))
    || (left.time ?? '').localeCompare(right.time ?? '')
    || left.row.source.block.text.localeCompare(right.row.source.block.text)
    || left.key.localeCompare(right.key));
}

/** Cards last thirty visual minutes. Connected overlaps share equally sized lanes. */
export function layoutWeekTimedEntries(entries: readonly WeekEntry[]): TimedWeekEntry[] {
  const timed = entries.filter(entry => entry.kind === 'scheduled' && entry.time !== null)
    .map(entry => ({ entry, minute: timeMinutes(entry.time!), lane: 0, lanes: 1 }))
    .sort((left, right) => left.minute - right.minute || left.entry.key.localeCompare(right.entry.key));
  let group: TimedWeekEntry[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const finishGroup = () => {
    for (const item of group) item.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const item of timed) {
    if (item.minute >= groupEnd) finishGroup();
    let lane = laneEnds.findIndex(end => end <= item.minute);
    if (lane === -1) lane = laneEnds.length;
    item.lane = lane;
    laneEnds[lane] = item.minute + 30;
    groupEnd = Math.max(groupEnd, item.minute + 30);
    group.push(item);
  }
  finishGroup();
  return timed;
}

export function weekRangeQuery(field: 'scheduled' | 'deadline', from: string, through: string, statuses: readonly TaskStatus[] = taskStatuses): TaskQuery {
  return {
    source: null,
    context_date: from,
    filter: {
      selection: 'all', statuses: [...statuses], recent_days: 7,
      scheduled: field === 'scheduled' ? { from, through } : null,
      deadline: field === 'deadline' ? { from, through } : null,
      priority: null, project_id: null,
    },
    limit: taskQueryLimit,
  };
}

/** The API has no cursor. Split capped weeks into days, then disjoint statuses. */
export async function fetchWeekTaskRange(
  query: (value: TaskQuery) => Promise<TaskQueryResult>,
  field: 'scheduled' | 'deadline',
  from: string,
  through: string,
): Promise<WeekTaskResults> {
  const result = await query(weekRangeQuery(field, from, through));
  if (result.rows.length >= result.total) return { rows: result.rows, incomplete: [] };
  if (from !== through) {
    const dayCount = Math.round((new Date(`${through}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000);
    const middle = shiftCalendarDate(from, Math.floor(dayCount / 2))!;
    const next = shiftCalendarDate(middle, 1)!;
    const [left, right] = await Promise.all([
      fetchWeekTaskRange(query, field, from, middle),
      fetchWeekTaskRange(query, field, next, through),
    ]);
    return { rows: mergeWeekTaskRows(left.rows, right.rows), incomplete: [...left.incomplete, ...right.incomplete] };
  }
  const partitions = await Promise.all(taskStatuses.map(async status => {
    const partition = await query(weekRangeQuery(field, from, through, [status]));
    return {
      rows: partition.rows,
      incomplete: partition.rows.length < partition.total ? [{ field, date: from, status, shown: partition.rows.length, total: partition.total }] : [],
    };
  }));
  return { rows: mergeWeekTaskRows(...partitions.map(partition => partition.rows)), incomplete: partitions.flatMap(partition => partition.incomplete) };
}
