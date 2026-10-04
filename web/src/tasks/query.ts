import type { DateRange, TaskQuery, TaskView } from '../api/types';
import { copyQuery, queriesEqual } from '../table/query';

export function createTaskQuery(date: string): TaskQuery {
  return {
    source: null,
    filter: { selection: 'unfinished_or_recent', statuses: [], recent_days: 7, scheduled: null, deadline: null, priority: null, project_id: null },
    context_date: date,
    limit: null,
  };
}

export function copyTaskQuery(query: TaskQuery): TaskQuery {
  return {
    ...query,
    source: query.source ? copyQuery(query.source) : null,
    filter: {
      ...query.filter,
      statuses: [...query.filter.statuses],
      scheduled: query.filter.scheduled ? { ...query.filter.scheduled } : null,
      deadline: query.filter.deadline ? { ...query.filter.deadline } : null,
    },
  };
}

const rangesEqual = (left: DateRange | null, right: DateRange | null) => left === right
  || !!left && !!right && left.from === right.from && left.through === right.through;

export function taskQueriesEqual(left: TaskQuery, right: TaskQuery): boolean {
  const a = left.filter; const b = right.filter;
  return left.context_date === right.context_date && left.limit === right.limit
    && (left.source === right.source || !!left.source && !!right.source && queriesEqual(left.source, right.source))
    && a.selection === b.selection && a.recent_days === b.recent_days
    && a.priority === b.priority && a.project_id === b.project_id
    && a.statuses.length === b.statuses.length && a.statuses.every(status => b.statuses.includes(status))
    && rangesEqual(a.scheduled, b.scheduled) && rangesEqual(a.deadline, b.deadline);
}

export function taskRange(query: TaskQuery, field: 'scheduled' | 'deadline', edge: keyof DateRange, date: string | null): TaskQuery {
  const range = { from: null, through: null, ...query.filter[field], [edge]: date };
  return { ...query, filter: { ...query.filter, [field]: range.from || range.through ? range : null } };
}

/** A remote saved-view update may replace a clean query, never a local draft. */
export function refreshedTaskQuery(draft: TaskQuery, previous: TaskView | null, next: TaskView): TaskQuery {
  return copyTaskQuery(previous?.id === next.id && taskQueriesEqual(draft, previous.query) ? next.query : draft);
}
