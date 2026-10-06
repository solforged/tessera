import type { TaskQuery, TaskQueryResult, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';

export interface PlanningCounts { scheduled: number; deadline: number }
export type PlanningMarks = Readonly<Record<string, PlanningCounts>>;
export interface PlanningRange { from: string; through: string }
type PlanningField = 'scheduled' | 'deadline';
type PlanningNotebook = Pick<NotebookClient, 'changeSequence'> & { readonly api: Pick<NotebookClient['api'], 'taskQuery'> };
interface CachedMonth {
  sequence: number;
  marks?: PlanningMarks;
  pending?: Promise<PlanningMarks>;
}

const monthDays: Record<number, number> = { 1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };
const cache = new WeakMap<PlanningNotebook, Map<string, CachedMonth>>();
// The service rejects task query limits above 2000. Its total is untruncated.
const queryLimit = 2000;

export function planningMonthRange(date: string): PlanningRange {
  const month = date.slice(0, 7);
  const year = Number(date.slice(0, 4));
  const number = Number(date.slice(5, 7));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = number === 2 && leap ? 29 : monthDays[number]!;
  return { from: `${month}-01`, through: `${month}-${days}` };
}

export function countPlanningDates(rows: readonly Pick<TaskRow, 'task'>[], field: PlanningField, range: PlanningRange): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { task } of rows) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    const date = task[field];
    if (date && date >= range.from && date <= range.through) counts[date] = (counts[date] ?? 0) + 1;
  }
  return counts;
}

export function mergePlanningCounts(scheduled: Readonly<Record<string, number>>, deadlines: Readonly<Record<string, number>>): PlanningMarks {
  const marks: Record<string, PlanningCounts> = {};
  for (const [date, count] of Object.entries(scheduled)) marks[date] = { scheduled: count, deadline: 0 };
  for (const [date, count] of Object.entries(deadlines)) {
    const mark = marks[date];
    if (mark) mark.deadline = count;
    else marks[date] = { scheduled: 0, deadline: count };
  }
  return marks;
}

export function planningCountLabel(counts: PlanningCounts | undefined): string {
  if (!counts) return '';
  const scheduled = counts.scheduled ? `${counts.scheduled} scheduled` : '';
  const deadline = counts.deadline ? `${counts.deadline} deadline${counts.deadline === 1 ? '' : 's'}` : '';
  return scheduled && deadline ? `${scheduled} · ${deadline}` : scheduled || deadline;
}

function planningQuery(field: PlanningField, range: PlanningRange): TaskQuery {
  return {
    source: null,
    filter: {
      selection: 'unfinished', statuses: ['todo', 'doing', 'waiting'], recent_days: 7,
      scheduled: field === 'scheduled' ? range : null,
      deadline: field === 'deadline' ? range : null,
      priority: null, project_id: null,
    },
    context_date: range.from,
    limit: queryLimit,
  };
}

async function loadPlanningDates(query: (value: TaskQuery) => Promise<TaskQueryResult>, field: PlanningField, range: PlanningRange): Promise<Record<string, number>> {
  const result = await query(planningQuery(field, range));
  if (result.total <= result.rows.length) return countPlanningDates(result.rows, field, range);
  // An exact-day query's total supplies its count even when that day alone exceeds the cap.
  if (range.from === range.through) return { [range.from]: result.total };
  const middle = Math.floor((Number(range.from.slice(8)) + Number(range.through.slice(8))) / 2);
  const month = range.from.slice(0, 7);
  const left = await loadPlanningDates(query, field, { from: range.from, through: `${month}-${String(middle).padStart(2, '0')}` });
  const right = await loadPlanningDates(query, field, { from: `${month}-${String(middle + 1).padStart(2, '0')}`, through: range.through });
  return { ...left, ...right };
}

/** Retain the previous snapshot while the same month refreshes after a notebook change. */
export function cachedMonthPlanningMarks(notebook: PlanningNotebook, date: string): PlanningMarks | undefined {
  return cache.get(notebook)?.get(date.slice(0, 7))?.marks;
}

/** Share loads by notebook and month, with changeSequence as the cache revision. */
export function loadMonthPlanningMarks(notebook: PlanningNotebook, date: string): Promise<PlanningMarks> {
  const month = date.slice(0, 7);
  const sequence = notebook.changeSequence();
  const months = cache.get(notebook) ?? new Map<string, CachedMonth>();
  cache.set(notebook, months);
  const previous = months.get(month);
  if (previous?.sequence === sequence) {
    if (previous.pending) return previous.pending;
    if (previous.marks) return Promise.resolve(previous.marks);
  }
  const entry: CachedMonth = { sequence, marks: previous?.marks };
  months.set(month, entry);
  const range = planningMonthRange(date);
  const query = (value: TaskQuery) => notebook.api.taskQuery(value);
  entry.pending = Promise.all([
    loadPlanningDates(query, 'scheduled', range),
    loadPlanningDates(query, 'deadline', range),
  ]).then(([scheduled, deadlines]) => {
    const marks = mergePlanningCounts(scheduled, deadlines);
    entry.marks = marks;
    entry.pending = undefined;
    return marks;
  }, reason => {
    // Failed refreshes retain a displayed snapshot but must not become fresh cache hits.
    entry.pending = undefined;
    if (months.get(month) === entry) entry.sequence = -1;
    throw reason;
  });
  return entry.pending;
}
