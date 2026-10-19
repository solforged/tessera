import { expect, test } from 'bun:test';
import type { Block, TaskRow, TaskState } from '../api/types';
import { agendaTaskTime } from './task-labels';
import { weekLedgerDays, weekLedgerSummary } from './week-ledger';

const page: Block = { id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Notes', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
function row(id: string, task: Partial<TaskState>): TaskRow {
  return { source: { block: { ...page, id, kind: 'block', parent_id: page.id, text: id }, page }, task: { status: 'todo', scheduled: '2026-10-13', scheduled_time: null, deadline: null, deadline_time: null, warning_days: 0, priority: null, repeater: null, completed_on: null, ...task }, project_id: null, section_id: null, section_text: null };
}

test('ledger deduplicates coincident plans and counts distinct open sources and deadlines', () => {
  const both = row('both', { deadline: '2026-10-13' });
  const rows = [both, both, row('done', { status: 'done', scheduled: '2026-10-12' }), row('later', { scheduled: '2026-10-15', deadline: '2026-10-16' })];
  const days = weekLedgerDays(rows, '2026-10-13', '2026-10-13', '11:20');
  expect(days).toHaveLength(7);
  expect(days[0]).toMatchObject({ done: 1, open: 0 });
  expect(days[1]!.rows.map(row => row.source.block.id)).toEqual(['both']);
  expect(weekLedgerSummary(rows, '2026-10-13')).toBe('12–18 Oct · 2 open · 2 due');
});

test('today places all elapsed clocks chronologically above untimed work regardless of status', () => {
  const rows = [row('untimed', {}), row('future', { scheduled_time: '14:00' }), row('doing', { status: 'doing', scheduled_time: '08:00' }), row('past', { scheduled_time: '09:00' })];
  expect(weekLedgerDays(rows, '2026-10-13', '2026-10-13', '11:20')[1]!.rows.map(row => row.source.block.id)).toEqual(['doing', 'past', 'untimed', 'future']);
  expect(weekLedgerSummary([], '2026-12-31')).toBe('28 Dec–3 Jan · 0 open · 0 due');
  expect(weekLedgerDays([], 'invalid', '2026-10-13', '11:20')).toEqual([]);
});

test('deadline day uses its own clock rather than carrying another scheduled day', () => {
  const task = row('deadline', { scheduled: '2026-10-12', scheduled_time: '09:00', deadline: '2026-10-13', deadline_time: '16:00' });
  expect(agendaTaskTime(task, '2026-10-13', false)).toBe('16:00');
  expect(agendaTaskTime(task, '2026-10-13')).toBe('09:00');
  expect(agendaTaskTime({ ...task, task: { ...task.task, deadline_time: null } }, '2026-10-13', false)).toBeNull();
});

test('appointments stay on their exact day with no task status', () => {
  const timed = row('call', { status: null, scheduled_time: '09:00' });
  const untimed = row('visit', { status: null });
  const tomorrow = row('tomorrow', { status: null, scheduled: '2026-10-14' });
  const days = weekLedgerDays([timed, untimed, tomorrow], '2026-10-13', '2026-10-13', '11:20');
  expect(days[1]!.rows.map(row => row.source.block.id)).toEqual(['call', 'visit']);
  expect(days[1]!.rows.every(row => row.task.status === null)).toBe(true);
  expect(days[2]!.rows.map(row => row.source.block.id)).toEqual(['tomorrow']);
  expect(days[0]!.rows).toEqual([]);
});
