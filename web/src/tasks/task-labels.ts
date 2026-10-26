import type { AgendaItem, TaskRow, TaskState } from '../api/types';
import { journalDayLabel } from './journal-date';
import { calendarDate, daysBetween, relativeDate } from './relative-date';

// One vocabulary for a task's planning, shared by outline rows, the agenda and task queries, and the rules that keep a plan saveable.

const priorityNames = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const repeatModes = { fixed: 'fixed', catch_up: 'catch up', after_completion: 'after completion' } as const;

export interface TaskFact {
  /** Short mono text shown in the row. */
  text: string;
  /** Full wording for tooltips and assistive technology. */
  label: string;
  field: 'status' | 'schedule' | 'deadline' | 'priority' | 'repeat';
  late?: boolean;
  /** An unfinished deadline within its inclusive warning window, but not late. */
  warning?: boolean;
  /** Set when the fact is a priority word. High is danger; medium and low stay faint. */
  priority?: NonNullable<TaskState['priority']>;
}

export interface FactContext {
  /** The displayed day: a plan is late only when it also precedes civil today. */
  date: string;
  /** The civil today: relative words are measured against it. */
  today: string;
  /** The row is listed on `date`, so a plan for that day goes without saying. */
  listed?: boolean;
  /** The row already shows its time in its own column. */
  timeShown?: boolean;
}

const clock = (time: string | null) => time ? ` ${time}` : '';
/** Tooltips spell the day out in full, since the row's own words are relative. */
const spelled = (date: string, time: string | null) => `${journalDayLabel(date)}${time ? ` at ${time}` : ''}`;
export const isFinished = (task: TaskState) => task.status === 'done' || task.status === 'cancelled';

/** Planning facts in reading order. Finished tasks report only when they were done; status itself is the glyph's job. */
export function taskFacts(task: TaskState, context: FactContext): TaskFact[] {
  if (task.status === 'cancelled') return [];
  if (task.status === 'done') return task.completed_on ? [{ field: 'status', text: `done ${relativeDate(task.completed_on, context.today)}`, label: `Done ${spelled(task.completed_on, null)}` }] : [];
  const facts: TaskFact[] = [];
  if (task.scheduled && !(context.listed && task.scheduled === context.date)) {
    const late = task.scheduled < context.date && task.scheduled < context.today;
    const time = context.timeShown ? '' : clock(task.scheduled_time);
    facts.push({ field: 'schedule', text: `${late ? 'since ' : ''}${relativeDate(task.scheduled, context.today)}${time}`, label: `Scheduled ${spelled(task.scheduled, task.scheduled_time)}`, late });
  }
  if (task.deadline) {
    const late = task.deadline < context.date && task.deadline < context.today;
    const remaining = daysBetween(context.date, task.deadline);
    const warning = !late && task.warning_days !== null && remaining >= 0 && remaining <= task.warning_days;
    const listedDay = context.listed && task.deadline === context.date;
    const time = listedDay && context.timeShown ? '' : clock(task.deadline_time);
    facts.push({ field: 'deadline', text: listedDay ? `due${time}` : `due ${relativeDate(task.deadline, context.today)}${time}`, label: `Deadline ${spelled(task.deadline, task.deadline_time)}`, late, warning });
  }
  if (task.priority) facts.push({ field: 'priority', text: priorityNames[task.priority], label: `${priorityNames[task.priority]} priority`, priority: task.priority });
  if (task.repeater) {
    const { every, unit, mode } = task.repeater;
    const span = every === 1 ? unit : `${every} ${unit}s`;
    facts.push({ field: 'repeat', text: `every ${span}`, label: `Repeats every ${span}, ${repeatModes[mode]}` });
  }
  return facts;
}

/**
 * Apply a planning patch so the result can be saved: a repeat counts from a date, so setting one on an undated
 * task schedules it for the context day, and clearing the last date clears the repeat with it.
 */
export function planTask(task: TaskState, patch: Partial<TaskState>, contextDate: string): TaskState {
  const next = { ...task, ...patch };
  if (!next.repeater || next.scheduled || next.deadline) return next;
  return 'repeater' in patch ? { ...next, scheduled: contextDate } : { ...next, repeater: null };
}

export interface AgendaGroups { overdue: AgendaItem[]; planned: AgendaItem[]; unplanned: AgendaItem[]; done: AgendaItem[] }

/** Sorts the service's agenda by its reasons: missed plans, the day's plans and work in progress, undated open tasks, then what was finished. */
export function groupAgenda(items: readonly AgendaItem[], date: string, skipPage?: string): AgendaGroups {
  const groups: AgendaGroups = { overdue: [], planned: [], unplanned: [], done: [] };
  for (const item of items) {
    if (item.source.page.id === skipPage) continue;
    if (item.reasons.includes('recently_completed') || isFinished(item.task)) groups.done.push(item);
    else if (item.reasons.includes('overdue') || !!item.task.scheduled && item.task.scheduled < date) groups.overdue.push(item);
    else if (item.reasons.every(reason => reason === 'unplanned') && item.task.status !== 'doing') groups.unplanned.push(item);
    else groups.planned.push(item);
  }
  return groups;
}

export interface AgendaDayGroup { date: string; rows: (TaskRow | AgendaItem)[] }

/** A day keeps carried work separate and lists each future task once, on its first plan in the next seven days. */
export function groupDayAgenda(items: readonly AgendaItem[], futureRows: readonly TaskRow[], date: string): AgendaGroups & { upcoming: AgendaDayGroup[] } {
  const groups = groupAgenda(items, date);
  const future = (row: TaskRow | AgendaItem) => !isFinished(row.task) && row.task.status !== 'doing'
    && (!row.task.scheduled || row.task.scheduled > date) && (!row.task.deadline || row.task.deadline > date);
  const planned = groups.planned.filter(row => !future(row));
  // A completed occurrence must not suppress the same source's next live plan.
  const listed = new Set([...groups.overdue, ...planned].map(row => row.source.block.id));
  const upcoming = new Map<string, TaskRow | AgendaItem>();
  for (const row of [...groups.planned.filter(future), ...futureRows]) {
    if (!isFinished(row.task) && !listed.has(row.source.block.id)) upcoming.set(row.source.block.id, row);
  }
  const days = new Map<string, (TaskRow | AgendaItem)[]>();
  for (const row of upcoming.values()) {
    const next = [row.task.scheduled, row.task.deadline]
      .filter((plan): plan is string => !!plan && plan > date && daysBetween(date, plan) <= 7).sort()[0];
    if (!next) continue;
    const rows = days.get(next) ?? [];
    rows.push(row);
    days.set(next, rows);
  }
  return {
    ...groups, planned,
    upcoming: [...days].sort(([left], [right]) => left.localeCompare(right)).map(([date, rows]) => ({
      date, rows: rows.sort((left, right) => (agendaTaskTime(left, date) ?? '').localeCompare(agendaTaskTime(right, date) ?? '')
        || left.source.block.text.localeCompare(right.source.block.text)),
    })),
  };
}

/** Time belongs to the visible plan, not another scheduled day; carried agenda rows retain their original clock. */
export function agendaTaskTime(row: TaskRow | AgendaItem, date: string, carried = true): string | null {
  if (isFinished(row.task) || 'reasons' in row && row.reasons.includes('recently_completed')) return null;
  if ('time' in row && row.time && ('reasons' in row && !row.task.scheduled || row.task.scheduled === date || carried && !!row.task.scheduled && row.task.scheduled < date)) return row.time;
  if (row.task.scheduled === date || carried && !!row.task.scheduled && row.task.scheduled < date) return row.task.scheduled_time;
  if (row.task.deadline === date || carried && !!row.task.deadline && row.task.deadline < date) return row.task.deadline_time;
  return null;
}

/** Schedule and deadline on one civil day contribute one count; finished tasks contribute none. */
export function plannedTaskCounts(rows: readonly TaskRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (isFinished(row.task) || seen.has(row.source.block.id)) continue;
    seen.add(row.source.block.id);
    for (const date of new Set([row.task.scheduled, row.task.deadline])) {
      if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  }
  return counts;
}

export interface StripDay { open: number; overdue: number; warning: number }

/**
 * The week strip's dots: each open task once per civil day it is planned on, with today's carried work counted as
 * overdue and deadlines inside their warning window as warnings.
 */
export function stripDays(rows: readonly TaskRow[], today: string, overdueToday = 0): Map<string, StripDay> {
  const days = new Map<string, StripDay>();
  const day = (date: string) => days.get(date) ?? days.set(date, { open: 0, overdue: 0, warning: 0 }).get(date)!;
  for (const [date, count] of plannedTaskCounts(rows)) day(date).open += count;
  const seen = new Set<string>();
  for (const row of rows) {
    const { deadline, warning_days } = row.task;
    if (isFinished(row.task) || seen.has(row.source.block.id) || !deadline || warning_days === null) continue;
    seen.add(row.source.block.id);
    const remaining = daysBetween(today, deadline);
    if (remaining >= 0 && remaining <= warning_days) day(deadline).warning += 1;
  }
  if (overdueToday) { const current = day(today); current.overdue = overdueToday; current.open += overdueToday; }
  return days;
}

/** Upcoming's day subheads: Tomorrow or the weekday, then the month and day, never ISO. */
export function upcomingDayLabel(date: string, today: string): { name: string; detail: string } {
  const name = daysBetween(today, date) === 1 ? 'Tomorrow' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return { name, detail: calendarDate(date, today) };
}
