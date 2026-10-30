import { expect, test } from 'bun:test';
import type { Block, TaskRow, TaskState } from '../api/types';
import { dayCounts, monthGridRange } from './month-day-counts';

const page: Block = { id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Notes', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
function row(id: string, task: Partial<TaskState>): TaskRow {
  return { source: { block: { ...page, id, kind: 'block', parent_id: page.id, text: id }, page }, task: { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, priority: null, repeater: null, completed_on: null, ...task }, project_id: null, section_id: null, section_text: null };
}

test('a month grid runs 42 days from the Monday before its first day', () => {
  expect(monthGridRange('2026-10-15')).toEqual({ from: '2026-09-28', through: '2026-11-08' });
  expect(monthGridRange('2026-06-01')).toEqual({ from: '2026-06-01', through: '2026-07-12' });
});

test('days before today count what was left open as overdue, later days count what is planned', () => {
  const range = monthGridRange('2026-10-01');
  const counts = dayCounts([
    row('late', { scheduled: '2026-10-27' }),
    row('also late', { deadline: '2026-10-28' }),
    row('now', { scheduled: '2026-10-29' }),
    row('soon', { scheduled: '2026-10-30' }),
    row('soon too', { deadline: '2026-10-30' }),
  ], range, '2026-10-29');
  expect(counts['2026-10-27']).toEqual({ open: 0, overdue: 1 });
  expect(counts['2026-10-28']).toEqual({ open: 0, overdue: 1 });
  expect(counts['2026-10-29']).toEqual({ open: 1, overdue: 0 });
  expect(counts['2026-10-30']).toEqual({ open: 2, overdue: 0 });
  expect(counts['2026-10-31']).toBeUndefined();
});

test('a task scheduled and due on one day counts once; finished tasks and days off the grid count nothing', () => {
  const range = monthGridRange('2026-10-01');
  const counts = dayCounts([
    row('both', { scheduled: '2026-10-30', deadline: '2026-10-30' }),
    row('done', { status: 'done', scheduled: '2026-10-30' }),
    row('far', { scheduled: '2026-12-25' }),
  ], range, '2026-10-29');
  expect(counts['2026-10-30']).toEqual({ open: 1, overdue: 0 });
  expect(counts['2026-12-25']).toBeUndefined();
});
