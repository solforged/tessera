import { describe, expect, test } from 'bun:test';
import type { Block, TaskRow, TaskState } from '../api/types';
import { dueDate, dueGroupName, groupByDue, groupByStatus } from './task-groups';

const page: Block = { id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Notes', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
function row(id: string, task: Partial<TaskState>): TaskRow {
  return { source: { block: { ...page, id, kind: 'block', parent_id: page.id, text: id }, page }, task: { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: 0, priority: null, repeater: null, completed_on: null, ...task }, project_id: null, section_id: null, section_text: null };
}
const today = '2026-10-29';

describe('task groups', () => {
  test('a task is due on its earlier plan', () => {
    expect(dueDate(row('a', { scheduled: '2026-11-02', deadline: '2026-11-01' }))).toBe('2026-11-01');
    expect(dueDate(row('b', {}))).toBeNull();
  });

  test('day headings are prose near today and dates beyond it', () => {
    expect(dueGroupName('2026-10-29', today)).toBe('Today');
    expect(dueGroupName('2026-10-30', today)).toBe('Tomorrow');
    expect(dueGroupName('2026-11-02', today)).toBe('Monday');
    expect(dueGroupName('2026-11-14', today)).toBe('Nov 14');
  });

  test('by due: overdue first, then each day, then no date and done', () => {
    const groups = groupByDue([
      row('done', { status: 'done', scheduled: '2026-10-29' }),
      row('none', {}),
      row('later', { scheduled: '2026-11-14' }),
      row('untimed', { scheduled: '2026-10-29' }),
      row('late', { scheduled: '2026-10-27' }),
      row('later-still', { deadline: '2026-10-28' }),
      row('timed', { scheduled: '2026-10-29', scheduled_time: '09:00' }),
    ], today);
    expect(groups.map(group => group.name)).toEqual(['Overdue', 'Today', 'Nov 14', 'No date', 'Done']);
    expect(groups[0]!.overdue).toBe(true);
    expect(groups[0]!.rows.map(item => item.source.block.id)).toEqual(['late', 'later-still']);
    expect(groups[1]!.date).toBe(today);
    expect(groups[1]!.rows.map(item => item.source.block.id)).toEqual(['timed', 'untimed']);
  });

  test('by status: work in progress first, appointments last, empty statuses omitted', () => {
    const groups = groupByStatus([
      row('todo', {}), row('doing', { status: 'doing' }), row('appointment', { status: null }), row('done', { status: 'done' }),
    ]);
    expect(groups.map(group => group.name)).toEqual(['Doing', 'Todo', 'Done', 'No status']);
    expect(groups.find(group => group.key === 'none')!.rows.map(item => item.source.block.id)).toEqual(['appointment']);
  });
});
