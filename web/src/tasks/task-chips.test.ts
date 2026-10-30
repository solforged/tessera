import { describe, expect, test } from 'bun:test';
import { chipLabels, dueMatches, dueRange, withDue, withPriority, withProject, withSearchText, withStatus } from './task-chips';
import { createTaskQuery } from './query';
import { formatTaskQueryLine } from './task-query-line';
import type { TaskQueryLineContext } from './task-query-line';

const today = '2026-10-29';
const ctx: TaskQueryLineContext = { context_date: today, resolveType: () => null, typeTitle: () => null, resolveProject: () => null, projectTitle: id => (id === 'kitchen' ? 'Kitchen renovation' : null) };
const base = () => createTaskQuery(today);

describe('task chips', () => {
  test('due presets are absolute dates around today', () => {
    expect(dueRange('before', today)).toEqual({ from: null, through: '2026-10-28' });
    expect(dueRange('today', today)).toEqual({ from: today, through: today });
    expect(dueRange('tomorrow', today)).toEqual({ from: '2026-10-30', through: '2026-10-30' });
    expect(dueRange('week', today)).toEqual({ from: today, through: '2026-11-04' });
  });

  test('a due choice replaces both planning ranges and null clears them', () => {
    const scheduled = withDue(base(), 'scheduled', 'today', today);
    expect(scheduled.filter.scheduled).toEqual({ from: today, through: today });
    expect(scheduled.filter.deadline).toBeNull();
    const deadline = withDue(scheduled, 'deadline', 'week', today);
    expect(deadline.filter.scheduled).toBeNull();
    expect(deadline.filter.deadline).toEqual({ from: today, through: '2026-11-04' });
    const cleared = withDue(deadline, null, null, today);
    expect(cleared.filter.scheduled).toBeNull();
    expect(cleared.filter.deadline).toBeNull();
  });

  test('dueMatches names exactly the chosen preset on one field', () => {
    const query = withDue(base(), 'deadline', 'tomorrow', today);
    expect(dueMatches(query, 'deadline', 'tomorrow', today)).toBe(true);
    expect(dueMatches(query, 'deadline', 'today', today)).toBe(false);
    expect(dueMatches(query, 'scheduled', 'tomorrow', today)).toBe(false);
    expect(dueMatches({ ...query, filter: { ...query.filter, scheduled: dueRange('tomorrow', today) } }, 'deadline', 'tomorrow', today)).toBe(false);
  });

  test('statuses toggle one at a time and clear together', () => {
    const doing = withStatus(base(), 'doing');
    expect(doing.filter.statuses).toEqual(['doing']);
    const two = withStatus(doing, 'waiting');
    expect(two.filter.statuses).toEqual(['doing', 'waiting']);
    expect(withStatus(two, 'doing').filter.statuses).toEqual(['waiting']);
    expect(withStatus(two, null).filter.statuses).toEqual([]);
  });

  test('priority, project and search text edit one field each', () => {
    expect(withPriority(base(), 'high').filter.priority).toBe('high');
    expect(withPriority(withPriority(base(), 'high'), null).filter.priority).toBeNull();
    expect(withProject(base(), 'kitchen').filter.project_id).toBe('kitchen');
    const searched = withSearchText(base(), 'plants');
    expect(searched.source?.text).toBe('plants');
    expect(withSearchText(searched, '').source).toBeNull();
  });

  test('chip labels stay null at their defaults and name the value once set', () => {
    expect(chipLabels(base(), today, () => undefined)).toEqual({ status: null, due: null, project: null, priority: null });
    let query = withStatus(withStatus(base(), 'doing'), 'todo');
    expect(chipLabels(query, today, () => undefined).status).toBe('2 statuses');
    query = withDue(withPriority(withProject(withStatus(base(), 'doing'), 'kitchen'), 'low'), 'scheduled', 'before', today);
    expect(chipLabels(query, today, id => (id === 'kitchen' ? 'Kitchen renovation' : undefined))).toEqual({ status: 'Doing', due: 'Scheduled before today', project: 'Kitchen renovation', priority: 'Low' });
    const custom = { ...query, filter: { ...query.filter, scheduled: { from: '2026-01-01', through: '2026-01-02' } } };
    expect(chipLabels(custom, today, () => undefined).due).toBe('Scheduled dates');
    expect(chipLabels(custom, today, () => undefined).project).toBe('Project');
  });

  test('a chip-built query reads back in the query line', () => {
    const query = withPriority(withStatus(base(), 'todo'), 'high');
    const line = formatTaskQueryLine(query, ctx);
    expect(line).toContain('priority:high');
    expect(line).toContain('is:todo');
  });
});
