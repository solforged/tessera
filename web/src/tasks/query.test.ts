import { describe, expect, test } from 'bun:test';
import type { TaskQuery, TaskView } from '../api/types';
import { copyTaskQuery, refreshedTaskQuery, taskQueriesEqual, taskRange } from './query';

const projectQuery: TaskQuery = {
  context_date: '2026-09-30',
  source: {
    type: 'research', text: 'language',
    filters: [{ field: 'author', op: 'is', value: 'Bloomfield' }],
    sort: [{ by: 'updated', field: null, direction: 'desc' }], limit: 800,
  },
  filter: {
    selection: 'unfinished_or_recent', statuses: ['todo', 'doing'], recent_days: 14,
    scheduled: { from: '2026-09-01', through: '2026-09-30' },
    deadline: { from: null, through: '2026-10-15' }, priority: 'high', project_id: 'language-project',
  },
  limit: 100,
};
const savedView: TaskView = { id: 'view', name: 'Language project', query: projectQuery, revision: 1, created_at: 1, updated_at: 1 };

describe('task query drafts', () => {
  test('editing a copied project query cannot mutate its saved source or planning ranges', () => {
    const draft = copyTaskQuery(projectQuery);
    draft.source!.filters[0]!.value = 'Sapir';
    draft.source!.sort[0]!.direction = 'asc';
    draft.filter.statuses.push('waiting');
    draft.filter.scheduled!.from = '2026-08-01';
    draft.filter.deadline!.through = '2026-11-01';
    expect(projectQuery.source!.filters[0]!.value).toBe('Bloomfield');
    expect(projectQuery.source!.sort[0]!.direction).toBe('desc');
    expect(projectQuery.filter.statuses).toEqual(['todo', 'doing']);
    expect(projectQuery.filter.scheduled!.from).toBe('2026-09-01');
    expect(projectQuery.filter.deadline!.through).toBe('2026-10-15');
  });

  test('scheduled and deadline endpoints remain independent, including clearing a range', () => {
    const scheduled = taskRange(projectQuery, 'scheduled', 'from', '2026-10-01');
    const deadline = taskRange(scheduled, 'deadline', 'through', '2026-11-01');
    expect(deadline.filter.scheduled).toEqual({ from: '2026-10-01', through: '2026-09-30' });
    expect(deadline.filter.deadline).toEqual({ from: null, through: '2026-11-01' });
    // Invalid ordering stays a server-visible query, never silently changes the other endpoint.
    expect(projectQuery.filter.scheduled!.from).toBe('2026-09-01');
    const cleared = taskRange(taskRange(deadline, 'scheduled', 'from', null), 'scheduled', 'through', null);
    expect(cleared.filter.scheduled).toBeNull();
    expect(cleared.filter.deadline).toEqual(deadline.filter.deadline);
    expect(cleared.source).toEqual(projectQuery.source);
    expect(cleared.filter.project_id).toBe('language-project');
    expect(cleared.context_date).toBe('2026-09-30');
  });

  test('a clean saved query follows its new server context date without sharing mutable state', () => {
    const next: TaskView = { ...savedView, revision: 2, query: { ...copyTaskQuery(projectQuery), context_date: '2026-10-04' } };
    next.query.filter.project_id = 'another-project';
    const refreshed = refreshedTaskQuery(copyTaskQuery(projectQuery), savedView, next);
    expect(refreshed.context_date).toBe('2026-10-04');
    expect(refreshed.filter.project_id).toBe('another-project');
    refreshed.filter.statuses.push('waiting');
    expect(next.query.filter.statuses).toEqual(['todo', 'doing']);
  });

  test('remote saves preserve dirty filters and an explicitly displayed context date', () => {
    const next: TaskView = { ...savedView, revision: 2, query: { ...copyTaskQuery(projectQuery), context_date: '2026-10-04' } };
    const edits: TaskQuery[] = [
      { ...copyTaskQuery(projectQuery), context_date: '2026-10-01' },
      { ...copyTaskQuery(projectQuery), limit: 200 },
      { ...copyTaskQuery(projectQuery), source: { ...projectQuery.source!, text: 'phonology' } },
      { ...copyTaskQuery(projectQuery), filter: { ...projectQuery.filter, project_id: 'phonology-project' } },
      { ...copyTaskQuery(projectQuery), filter: { ...projectQuery.filter, recent_days: 30 } },
      taskRange(projectQuery, 'scheduled', 'through', '2026-10-02'),
      taskRange(projectQuery, 'deadline', 'from', '2026-09-15'),
    ];
    for (const draft of edits) expect(refreshedTaskQuery(draft, savedView, next)).toEqual(draft);
  });

  test('initial hydration and a different selected view never replace the shell draft', () => {
    const draft = { ...copyTaskQuery(projectQuery), context_date: '2026-10-03' };
    expect(refreshedTaskQuery(draft, null, savedView)).toEqual(draft);
    expect(refreshedTaskQuery(draft, { ...savedView, id: 'previous-view' }, savedView)).toEqual(draft);
  });

  test('status order does not dirty a view, but independent range and source edits do', () => {
    expect(taskQueriesEqual(projectQuery, { ...projectQuery, filter: { ...projectQuery.filter, statuses: ['doing', 'todo'] } })).toBe(true);
    for (const filter of [
      { ...projectQuery.filter, selection: 'all' as const },
      { ...projectQuery.filter, statuses: ['todo' as const] },
      { ...projectQuery.filter, priority: null },
      { ...projectQuery.filter, deadline: null },
      { ...projectQuery.filter, scheduled: null },
    ]) expect(taskQueriesEqual(projectQuery, { ...projectQuery, filter })).toBe(false);
    const source = { ...projectQuery.source!, filters: [{ field: 'author', op: 'is' as const, value: 'Sapir' }] };
    expect(taskQueriesEqual(projectQuery, { ...projectQuery, source })).toBe(false);
  });
});
