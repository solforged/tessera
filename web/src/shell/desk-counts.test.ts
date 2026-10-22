import { expect, test } from 'bun:test';
import type { AgendaItem, AgendaReason, Block, TaskState } from '../api/types';
import { agendaDaySummary } from './desk-counts';

const todo: TaskState = { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };

function item(id: string, reasons: AgendaReason[], patch: Partial<TaskState> = {}): AgendaItem {
  const page: Block = { id: 'page', page_id: 'page', parent_id: null, kind: 'page', text: 'Plan', heading: null, archived: false, revision: 1, created_at: 1, updated_at: 1 };
  return { source: { page, block: { ...page, id, parent_id: page.id, kind: 'block', text: id } }, task: { ...todo, ...patch }, reasons, project_id: null, time: null };
}

test('Today and the sidebar count current plans and overdue work separately, without future warnings', () => {
  const date = '2026-10-22';
  const rows = [
    item('scheduled', ['scheduled'], { scheduled: date }),
    item('deadline', ['deadline'], { deadline: date }),
    item('both', ['scheduled', 'deadline'], { scheduled: date, deadline: date }),
    item('doing', ['in_progress'], { status: 'doing' }),
    item('missed-schedule', ['scheduled'], { scheduled: '2026-10-21' }),
    item('missed-deadline', ['overdue'], { deadline: '2026-10-21' }),
    item('warning', ['warning'], { deadline: '2026-10-24', warning_days: 3 }),
    item('unplanned', ['unplanned']),
    item('completed', ['recently_completed'], { scheduled: date, status: 'done', completed_on: date }),
    item('cancelled', ['scheduled'], { scheduled: date, status: 'cancelled' }),
  ];
  const summary = agendaDaySummary(rows, date);
  expect(summary.planned).toBe(4);
  expect(summary.overdue).toBe(2);
  expect(summary.planned + summary.overdue).toBe(6);
  expect(summary.items.map(row => row.source.block.id)).toEqual(['scheduled', 'deadline', 'both', 'doing']);
});

test('an empty day has no actionable plans', () => {
  expect(agendaDaySummary([], '2026-10-22')).toEqual({ planned: 0, overdue: 0, items: [] });
});
