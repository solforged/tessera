import type { AgendaItem, TaskState } from '../api/types';

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
  late?: boolean;
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
  if (task.status === 'done') return task.completed_on ? [{ text: `done ${relativeDate(task.completed_on, context.today)}`, label: `Done ${task.completed_on}` }] : [];
  const facts: TaskFact[] = [];
  if (task.scheduled && !(context.listed && task.scheduled === context.date)) {
    const late = task.scheduled < context.date;
    const time = context.timeShown ? '' : clock(task.scheduled_time);
    facts.push({ text: late ? `since ${relativeDate(task.scheduled, context.today)}` : `${relativeDate(task.scheduled, context.today)}${time}`, label: `Scheduled ${task.scheduled}${clock(task.scheduled_time)}`, late });
  }
  if (task.deadline) {
    const late = task.deadline < context.date;
    const listedDay = context.listed && task.deadline === context.date;
    const time = listedDay && context.timeShown ? '' : clock(task.deadline_time);
    facts.push({ text: listedDay ? `due${time}` : `${late ? 'was due' : 'due'} ${relativeDate(task.deadline, context.today)}${time}`, label: `Deadline ${task.deadline}${clock(task.deadline_time)}`, late });
  }
  if (task.priority) facts.push({ text: `!${task.priority}`, label: `${priorityNames[task.priority]} priority` });
  if (task.repeater) {
    const { every, unit, mode } = task.repeater;
    const span = every === 1 ? unit : `${every} ${unit}s`;
    facts.push({ text: `every ${span}`, label: `Repeats every ${span}, ${repeatModes[mode]}` });
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
