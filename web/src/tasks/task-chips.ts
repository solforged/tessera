import type { DateRange, TaskPriority, TaskQuery, TaskStatus } from '../api/types';
import { typeQuery } from '../table/query';
import { shiftCalendarDate } from './week-calendar';

/**
 * The phone's Tasks filters. Each chip edits the same `TaskQuery` the query line and the condition bar edit, so a view
 * saved from a chip reads back in the syntax field (`is:todo priority:high @2026-10-29`) and the reverse.
 */

export type DueField = 'scheduled' | 'deadline';
export type DuePreset = 'before' | 'today' | 'tomorrow' | 'week';
export const dueFields: { value: DueField; label: string }[] = [{ value: 'scheduled', label: 'Scheduled' }, { value: 'deadline', label: 'Deadline' }];
export const duePresets: { value: DuePreset; label: string }[] = [
  { value: 'before', label: 'Before today' },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'Next 7 days' },
];
export const taskStatuses: { value: TaskStatus; label: string }[] = [
  { value: 'todo', label: 'Todo' }, { value: 'doing', label: 'Doing' }, { value: 'waiting', label: 'Waiting' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' },
];
export const taskPriorities: { value: TaskPriority; label: string }[] = [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }];

const day = (today: string, offset: number) => shiftCalendarDate(today, offset) ?? today;

/** Absolute dates, so a saved view reads the same whenever it is reopened. */
export function dueRange(preset: DuePreset, today: string): DateRange {
  switch (preset) {
    case 'before': return { from: null, through: day(today, -1) };
    case 'today': return { from: today, through: today };
    case 'tomorrow': return { from: day(today, 1), through: day(today, 1) };
    case 'week': return { from: today, through: day(today, 6) };
  }
}

/** A due choice replaces both planning ranges: the chip names one field and one range at a time. Null clears them. */
export function withDue(query: TaskQuery, field: DueField | null, preset: DuePreset | null, today: string): TaskQuery {
  const filter = { ...query.filter, scheduled: null as DateRange | null, deadline: null as DateRange | null };
  if (field && preset) filter[field] = dueRange(preset, today);
  return { ...query, filter };
}

/** Adds or removes one status; null clears them all. */
export function withStatus(query: TaskQuery, status: TaskStatus | null): TaskQuery {
  const current = query.filter.statuses;
  const statuses = status === null ? [] : current.includes(status) ? current.filter(value => value !== status) : [...current, status];
  return { ...query, filter: { ...query.filter, statuses } };
}

export const withPriority = (query: TaskQuery, priority: TaskPriority | null): TaskQuery => ({ ...query, filter: { ...query.filter, priority } });
export const withProject = (query: TaskQuery, projectId: string | null): TaskQuery => ({ ...query, filter: { ...query.filter, project_id: projectId } });

/** The search well's text is the source's text, the same words the query line keeps after its predicates. */
export function withSearchText(query: TaskQuery, text: string): TaskQuery {
  const source = { ...(query.source ?? typeQuery(null)), text: text || null };
  return { ...query, source: source.type || source.text?.trim() || source.filters.length || source.sort.length || source.limit !== null ? source : null };
}

const sameRange = (left: DateRange | null, right: DateRange) => !!left && left.from === right.from && left.through === right.through;

/** Whether the query holds exactly this preset on this field and no range on the other. */
export function dueMatches(query: TaskQuery, field: DueField, preset: DuePreset, today: string): boolean {
  return !query.filter[field === 'scheduled' ? 'deadline' : 'scheduled'] && sameRange(query.filter[field], dueRange(preset, today));
}

export interface ChipLabels { status: string | null; due: string | null; project: string | null; priority: string | null }

/** What each chip says once it holds a value; null while it is at its default and the chip shows only its name. */
export function chipLabels(query: TaskQuery, today: string, projectTitle: (id: string) => string | undefined): ChipLabels {
  const { statuses, scheduled, deadline, priority, project_id } = query.filter;
  const statusName = (value: TaskStatus) => taskStatuses.find(item => item.value === value)!.label;
  let due: string | null = null;
  if (scheduled && deadline) due = 'Scheduled and deadline';
  else if (scheduled || deadline) {
    const field = scheduled ? dueFields[0]! : dueFields[1]!;
    const preset = duePresets.find(item => dueMatches(query, field.value, item.value, today));
    due = `${field.label} ${preset ? preset.label.toLocaleLowerCase() : 'dates'}`;
  }
  return {
    status: statuses.length === 0 ? null : statuses.length === 1 ? statusName(statuses[0]!) : `${statuses.length} statuses`,
    due,
    project: project_id ? projectTitle(project_id) ?? 'Project' : null,
    priority: priority ? taskPriorities.find(item => item.value === priority)!.label : null,
  };
}
