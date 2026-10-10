import { describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaReason, Block, TaskState } from '../api/types';
import { groupAgenda, planTask, relativeDate, taskFacts } from './task-labels';

const todo: TaskState = { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };

function item(id: string, reasons: AgendaReason[], patch: Partial<TaskState> = {}, pageId = 'page'): AgendaItem {
  const page: Block = { id: pageId, page_id: pageId, parent_id: null, kind: 'page', text: 'Plan', heading: null, archived: false, revision: 1, created_at: 1, updated_at: 1 };
  return { source: { page, block: { ...page, id, parent_id: pageId, kind: 'block', text: id } }, task: { ...todo, ...patch }, reasons, project_id: null, time: null };
}

describe('relativeDate', () => {
  test('names nearby days, then weekdays within a week, then day and month, then ISO across years', () => {
    expect(relativeDate('2026-10-10', '2026-10-10')).toBe('today');
    expect(relativeDate('2026-10-11', '2026-10-10')).toBe('tomorrow');
    expect(relativeDate('2026-10-09', '2026-10-10')).toBe('yesterday');
    expect(relativeDate('2026-10-16', '2026-10-10')).toBe('Fri 16');
    expect(relativeDate('2026-10-04', '2026-10-10')).toBe('Sun 4');
    expect(relativeDate('2026-10-17', '2026-10-10')).toBe('17 Oct');
    expect(relativeDate('2027-01-02', '2026-12-30')).toBe('Sat 2');
    expect(relativeDate('2027-01-20', '2026-12-30')).toBe('2027-01-20');
  });

  test('counts civil days across a daylight-saving change', () => {
    expect(relativeDate('2026-11-02', '2026-11-01')).toBe('tomorrow');
    expect(relativeDate('2026-03-08', '2026-03-07')).toBe('tomorrow');
  });
});

describe('taskFacts', () => {
  const day = { date: '2026-10-10', today: '2026-10-10' };

  test('marks missed scheduled and deadline dates late against the displayed day', () => {
    const facts = taskFacts({ ...todo, scheduled: '2026-10-06', scheduled_time: '19:00', deadline: '2026-10-08' }, day);
    expect(facts.map(fact => [fact.text, !!fact.late])).toEqual([['since Tue 6', true], ['was due Thu 8', true]]);
    expect(facts[0]!.label).toBe('Scheduled 2026-10-06 19:00');
  });

  test('omits the plan a listing already implies and a time shown in its own column', () => {
    const task = { ...todo, scheduled: '2026-10-10', scheduled_time: '09:00', deadline: '2026-10-10', deadline_time: '17:00', priority: 'high' as const };
    expect(taskFacts(task, { ...day, listed: true, timeShown: true }).map(fact => fact.text)).toEqual(['due', '!high']);
    expect(taskFacts(task, day).map(fact => fact.text)).toEqual(['today 09:00', 'due today 17:00', '!high']);
  });

  test('finished tasks report only completion, never their plan', () => {
    const planned = { ...todo, scheduled: '2026-10-01', priority: 'low' as const, repeater: { mode: 'fixed' as const, every: 2, unit: 'week' as const } };
    expect(taskFacts({ ...planned, status: 'done', completed_on: '2026-10-09' }, day).map(fact => fact.text)).toEqual(['done yesterday']);
    expect(taskFacts({ ...planned, status: 'cancelled' }, day)).toEqual([]);
    expect(taskFacts(planned, day).at(-1)!.text).toBe('every 2 weeks');
  });
});

describe('planTask', () => {
  const weekly = { mode: 'catch_up' as const, every: 1, unit: 'week' as const };

  test('a repeat on an undated task schedules it for the context day', () => {
    expect(planTask(todo, { repeater: weekly }, '2026-10-10')).toMatchObject({ scheduled: '2026-10-10', repeater: weekly });
  });

  test('clearing the last date clears the repeat, while a remaining date keeps it', () => {
    const scheduled = { ...todo, scheduled: '2026-10-10', repeater: weekly };
    expect(planTask(scheduled, { scheduled: null, scheduled_time: null }, '2026-10-10')).toMatchObject({ scheduled: null, repeater: null });
    expect(planTask({ ...scheduled, deadline: '2026-10-12' }, { scheduled: null }, '2026-10-10')).toMatchObject({ deadline: '2026-10-12', repeater: weekly });
  });
});

describe('groupAgenda', () => {
  test('sorts by reason: carried and missed plans first, work in progress with the day, finished last', () => {
    const groups = groupAgenda([
      item('carried', ['scheduled'], { scheduled: '2026-10-06' }),
      item('missed', ['deadline', 'overdue'], { deadline: '2026-10-08' }),
      item('today', ['scheduled'], { scheduled: '2026-10-10' }),
      item('doing', ['unplanned'], { status: 'doing' }),
      item('idle', ['unplanned']),
      item('repeated', ['scheduled', 'recently_completed'], { scheduled: '2026-10-17' }),
      item('closed', ['unplanned', 'recently_completed'], { status: 'done', completed_on: '2026-10-10' }),
      item('journal', ['scheduled'], { scheduled: '2026-10-10' }, 'day'),
    ], '2026-10-10', 'day');
    const ids = (rows: AgendaItem[]) => rows.map(row => row.source.block.id);
    expect(ids(groups.overdue)).toEqual(['carried', 'missed']);
    expect(ids(groups.planned)).toEqual(['today', 'doing']);
    expect(ids(groups.unplanned)).toEqual(['idle']);
    expect(ids(groups.done)).toEqual(['repeated', 'closed']);
  });
});
