import { describe, expect, test } from 'bun:test';
import type { Block, TaskQuery, TaskQueryResult, TaskRow, TaskState } from '../api/types';
import { cachedMonthPlanningMarks, countPlanningDates, loadMonthPlanningMarks, mergePlanningCounts, planningCountLabel, planningMonthRange } from './planning-marks';

function taskRow(id: string, patch: Partial<TaskState> = {}): TaskRow {
  const page: Block = { id: 'page', page_id: 'page', parent_id: null, kind: 'page', text: 'Planning', heading: null, archived: false, revision: 1, created_at: 1, updated_at: 1 };
  return {
    source: { page, block: { ...page, id, parent_id: page.id, kind: 'block', text: id } },
    task: { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null, ...patch },
    project_id: null,
  };
}

function queryRows(rows: readonly TaskRow[], query: TaskQuery): TaskQueryResult {
  const filtered = rows.filter(({ task }) => {
    if (query.filter.selection === 'unfinished' && (task.status === 'done' || task.status === 'cancelled')) return false;
    if (query.filter.statuses.length && !query.filter.statuses.includes(task.status)) return false;
    for (const field of ['scheduled', 'deadline'] as const) {
      const range = query.filter[field];
      if (!range) continue;
      const date = task[field];
      if (!date || range.from && date < range.from || range.through && date > range.through) return false;
    }
    return true;
  });
  return { rows: filtered.slice(0, query.limit ?? 500), total: filtered.length };
}

function notebookFixture(initialRows: TaskRow[] = [], query?: (value: TaskQuery) => Promise<TaskQueryResult>) {
  let sequence = 1;
  let rows = initialRows;
  const requests: TaskQuery[] = [];
  const notebook = {
    api: { taskQuery(value: TaskQuery) {
      requests.push(value);
      return query ? query(value) : Promise.resolve(queryRows(rows, value));
    } },
    changeSequence() { return sequence; },
  };
  return {
    notebook, requests,
    advance() { sequence++; },
    replace(next: TaskRow[]) { rows = next; },
  };
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('monthly planning counts', () => {
  test('civil month ranges include leap days, century rules and year boundaries', () => {
    expect(planningMonthRange('2024-02-18')).toEqual({ from: '2024-02-01', through: '2024-02-29' });
    expect(planningMonthRange('2100-02-18')).toEqual({ from: '2100-02-01', through: '2100-02-28' });
    expect(planningMonthRange('2000-02-18')).toEqual({ from: '2000-02-01', through: '2000-02-29' });
    expect(planningMonthRange('2026-12-31')).toEqual({ from: '2026-12-01', through: '2026-12-31' });
    expect(planningMonthRange('0001-02-10')).toEqual({ from: '0001-02-01', through: '0001-02-28' });
  });

  test('only open tasks inside the month count, and both planning fields stay independent', () => {
    const rows = [
      taskRow('both', { scheduled: '2026-10-06', deadline: '2026-10-06' }),
      taskRow('doing', { status: 'doing', scheduled: '2026-10-06' }),
      taskRow('waiting', { status: 'waiting', scheduled: '2026-10-06', deadline: '2026-11-01' }),
      taskRow('other-day', { scheduled: '2026-10-31', deadline: '2026-10-01' }),
      taskRow('before', { scheduled: '2026-09-30' }),
      taskRow('done', { status: 'done', scheduled: '2026-10-06', deadline: '2026-10-06' }),
      taskRow('cancelled', { status: 'cancelled', scheduled: '2026-10-06', deadline: '2026-10-06' }),
      taskRow('unplanned'),
    ];
    const range = planningMonthRange('2026-10-06');
    const scheduled = countPlanningDates(rows, 'scheduled', range);
    const deadlines = countPlanningDates(rows, 'deadline', range);
    expect(scheduled).toEqual({ '2026-10-06': 3, '2026-10-31': 1 });
    expect(deadlines).toEqual({ '2026-10-06': 1, '2026-10-01': 1 });
    const marks = mergePlanningCounts(scheduled, deadlines);
    expect(marks).toEqual({
      '2026-10-06': { scheduled: 3, deadline: 1 },
      '2026-10-31': { scheduled: 1, deadline: 0 },
      '2026-10-01': { scheduled: 0, deadline: 1 },
    });
    expect(planningCountLabel(marks['2026-10-06'])).toBe('3 scheduled · 1 deadline');
    expect(planningCountLabel({ scheduled: 0, deadline: 2 })).toBe('2 deadlines');
    expect(planningCountLabel({ scheduled: 1, deadline: 0 })).toBe('1 scheduled');
    expect(planningCountLabel({ scheduled: 0, deadline: 0 })).toBe('');
    expect(planningCountLabel(undefined)).toBe('');
    expect(scheduled).toEqual({ '2026-10-06': 3, '2026-10-31': 1 });
  });

  test('scheduled and deadline month queries never AND their ranges or inherit task view filters', async () => {
    const fixture = notebookFixture([
      taskRow('schedule-only', { scheduled: '2026-10-01' }),
      taskRow('deadline-only', { deadline: '2026-10-31' }),
    ]);
    expect(await loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).toEqual({
      '2026-10-01': { scheduled: 1, deadline: 0 },
      '2026-10-31': { scheduled: 0, deadline: 1 },
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]!.filter.scheduled).toEqual({ from: '2026-10-01', through: '2026-10-31' });
    expect(fixture.requests[0]!.filter.deadline).toBeNull();
    expect(fixture.requests[1]!.filter.deadline).toEqual({ from: '2026-10-01', through: '2026-10-31' });
    expect(fixture.requests[1]!.filter.scheduled).toBeNull();
    for (const query of fixture.requests) {
      expect(query.source).toBeNull();
      expect(query.filter.priority).toBeNull();
      expect(query.filter.project_id).toBeNull();
      expect(query.filter.selection).toBe('unfinished');
      expect(query.filter.statuses).toEqual(['todo', 'doing', 'waiting']);
      expect(query.limit).toBe(2000);
    }
  });

  test('truncated ranges partition down to exact-day totals, including more than 2000 tasks on one day', async () => {
    const rows = [
      ...Array.from({ length: 2001 }, (_, index) => taskRow(`first-${index}`, { scheduled: '2026-10-05', deadline: '2026-10-23' })),
      ...Array.from({ length: 2002 }, (_, index) => taskRow(`last-${index}`, { scheduled: '2026-10-23' })),
      taskRow('done', { status: 'done', scheduled: '2026-10-05', deadline: '2026-10-23' }),
      taskRow('cancelled', { status: 'cancelled', scheduled: '2026-10-23' }),
    ];
    const fixture = notebookFixture(rows);
    expect(await loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).toEqual({
      '2026-10-05': { scheduled: 2001, deadline: 0 },
      '2026-10-23': { scheduled: 2002, deadline: 2001 },
    });
    expect(fixture.requests.some(query => query.filter.scheduled?.from === '2026-10-05' && query.filter.scheduled.through === '2026-10-05')).toBe(true);
    expect(fixture.requests.some(query => query.filter.deadline?.from === '2026-10-23' && query.filter.deadline.through === '2026-10-23')).toBe(true);
    expect(fixture.requests.every(query => query.limit === 2000 && !(query.filter.scheduled && query.filter.deadline))).toBe(true);
  });
});

describe('planning month cache', () => {
  test('concurrent and completed month loads share one notebook snapshot, including empty months', async () => {
    const fixture = notebookFixture();
    const first = loadMonthPlanningMarks(fixture.notebook, '2026-10-01');
    expect(loadMonthPlanningMarks(fixture.notebook, '2026-10-31')).toBe(first);
    const marks = await first;
    expect(marks).toEqual({});
    expect(await loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).toBe(marks);
    expect(fixture.requests).toHaveLength(2);
    await loadMonthPlanningMarks(fixture.notebook, '2026-11-01');
    expect(fixture.requests).toHaveLength(4);
    const otherNotebook = notebookFixture();
    await loadMonthPlanningMarks(otherNotebook.notebook, '2026-10-06');
    expect(otherNotebook.requests).toHaveLength(2);
  });

  test('a new change sequence refreshes counts without discarding the displayed month snapshot', async () => {
    const fixture = notebookFixture([taskRow('first', { scheduled: '2026-10-06' })]);
    const first = await loadMonthPlanningMarks(fixture.notebook, '2026-10-06');
    fixture.replace([taskRow('second', { deadline: '2026-10-07' })]);
    fixture.advance();
    const refreshed = loadMonthPlanningMarks(fixture.notebook, '2026-10-10');
    expect(cachedMonthPlanningMarks(fixture.notebook, '2026-10-01')).toBe(first);
    const next = await refreshed;
    expect(next).toEqual({ '2026-10-07': { scheduled: 0, deadline: 1 } });
    expect(cachedMonthPlanningMarks(fixture.notebook, '2026-10-31')).toBe(next);
    expect(fixture.requests).toHaveLength(4);
  });

  test('an old sequence completing after a new load cannot overwrite the fresh cache', async () => {
    const pending: Deferred<TaskQueryResult>[] = [];
    const fixture = notebookFixture([], () => {
      const result = deferred<TaskQueryResult>();
      pending.push(result);
      return result.promise;
    });
    const old = loadMonthPlanningMarks(fixture.notebook, '2026-10-06');
    fixture.advance();
    const fresh = loadMonthPlanningMarks(fixture.notebook, '2026-10-06');
    pending[2]!.resolve({ rows: [taskRow('fresh', { scheduled: '2026-10-07' })], total: 1 });
    pending[3]!.resolve({ rows: [], total: 0 });
    const marks = await fresh;
    pending[0]!.resolve({ rows: [taskRow('old', { scheduled: '2026-10-06' })], total: 1 });
    pending[1]!.resolve({ rows: [], total: 0 });
    await old;
    expect(cachedMonthPlanningMarks(fixture.notebook, '2026-10-06')).toBe(marks);
    expect(await loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).toEqual({ '2026-10-07': { scheduled: 1, deadline: 0 } });
    expect(fixture.requests).toHaveLength(4);
  });

  test('a failed refresh preserves old marks but is not reused as a successful cache hit', async () => {
    const rows = [taskRow('first', { scheduled: '2026-10-06' })];
    let failed = false;
    const fixture = notebookFixture(rows, query => failed ? Promise.reject(new Error('Planning unavailable')) : Promise.resolve(queryRows(rows, query)));
    const first = await loadMonthPlanningMarks(fixture.notebook, '2026-10-06');
    fixture.advance();
    failed = true;
    await expect(loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).rejects.toThrow('Planning unavailable');
    expect(cachedMonthPlanningMarks(fixture.notebook, '2026-10-06')).toBe(first);
    failed = false;
    expect(await loadMonthPlanningMarks(fixture.notebook, '2026-10-06')).toEqual(first);
    expect(fixture.requests).toHaveLength(6);
  });
});
