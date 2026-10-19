import type { AgendaItem, TaskRow, TaskState } from '../api/types';

// One vocabulary for a task's planning, shared by outline rows, the agenda and task queries, and the rules that keep a plan saveable.

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const priorityNames = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const repeatModes = { fixed: 'fixed', catch_up: 'catch up', after_completion: 'after completion' } as const;
// Local noon keeps day arithmetic clear of daylight-saving edges.
const noon = (date: string) => new Date(`${date}T12:00:00`);

/** Whole civil days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000);
}

/** A date as a reader says it near today: today, tomorrow, yesterday, `Fri 16` within a week, `16 Oct` this year, else ISO. */
export function relativeDate(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const day = noon(date);
  if (Math.abs(days) < 7) return `${weekdays[day.getDay()]} ${day.getDate()}`;
  if (date.slice(0, 4) === today.slice(0, 4)) return `${day.getDate()} ${months[day.getMonth()]}`;
  return date;
}

export interface TaskFact {
  /** Short mono text shown in the row. */
  text: string;
  /** Full wording for tooltips and assistive technology. */
  label: string;
  field: 'status' | 'schedule' | 'deadline' | 'priority' | 'repeat';
  late?: boolean;
  /** Set when the fact is a priority word. High is danger; medium and low stay faint. */
  priority?: NonNullable<TaskState['priority']>;
}

export interface FactContext {
  /** The displayed day: lateness is measured against it. */
  date: string;
  /** The civil today: relative words are measured against it. */
  today: string;
  /** The row is listed on `date`, so a plan for that day goes without saying. */
  listed?: boolean;
  /** The row already shows its time in its own column. */
  timeShown?: boolean;
}

const clock = (time: string | null) => time ? ` ${time}` : '';
export const isFinished = (task: TaskState) => task.status === 'done' || task.status === 'cancelled';

/** Planning facts in reading order. Finished tasks report only when they were done; status itself is the glyph's job. */
export function taskFacts(task: TaskState, context: FactContext): TaskFact[] {
  if (task.status === 'cancelled') return [];
  if (task.status === 'done') return task.completed_on ? [{ field: 'status', text: `done ${relativeDate(task.completed_on, context.today)}`, label: `Done ${task.completed_on}` }] : [];
  const facts: TaskFact[] = [];
  if (task.scheduled && !(context.listed && task.scheduled === context.date)) {
    const late = task.scheduled < context.date;
    const time = context.timeShown ? '' : clock(task.scheduled_time);
    facts.push({ field: 'schedule', text: late ? `since ${relativeDate(task.scheduled, context.today)}` : `${relativeDate(task.scheduled, context.today)}${time}`, label: `Scheduled ${task.scheduled}${clock(task.scheduled_time)}`, late });
  }
  if (task.deadline) {
    const late = task.deadline < context.date;
    const listedDay = context.listed && task.deadline === context.date;
    const time = listedDay && context.timeShown ? '' : clock(task.deadline_time);
    facts.push({ field: 'deadline', text: listedDay ? `due${time}` : `${late ? 'was due' : 'due'} ${relativeDate(task.deadline, context.today)}${time}`, label: `Deadline ${task.deadline}${clock(task.deadline_time)}`, late });
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
