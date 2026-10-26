import { describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaReason, Block, TaskRow, TaskState } from '../api/types';
import { agendaTaskTime, groupAgenda, groupDayAgenda, planTask, plannedTaskCounts, stripDays, taskFacts, upcomingDayLabel } from './task-labels';

const todo: TaskState = { status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null };

function item(id: string, reasons: AgendaReason[], patch: Partial<TaskState> = {}, pageId = 'page'): AgendaItem & TaskRow {
  const page: Block = { id: pageId, page_id: pageId, parent_id: null, kind: 'page', text: 'Plan', heading: null, archived: false, revision: 1, created_at: 1, updated_at: 1 };
  return { source: { page, block: { ...page, id, parent_id: pageId, kind: 'block', text: id } }, task: { ...todo, ...patch }, reasons, project_id: null, time: null, section_id: null, section_text: null };
}

describe('taskFacts', () => {
  const day = { date: '2026-10-10', today: '2026-10-10' };

  test('marks missed scheduled and deadline dates late only before both displayed day and civil today', () => {
    const facts = taskFacts({ ...todo, scheduled: '2026-10-06', scheduled_time: '19:00', deadline: '2026-10-08' }, day);
    expect(facts.map(fact => [fact.text, !!fact.late])).toEqual([['since Tue 19:00', true], ['due Thu', true]]);
    expect(facts[0]!.label).toBe('Scheduled Tuesday, October 6, 2026 at 19:00');
  });

  test('prospective days do not mark plans on or after today late or add a since prefix', () => {
    const future = { date: '2026-10-25', today: '2026-10-22' };
    const facts = taskFacts({ ...todo, scheduled: '2026-10-23', deadline: '2026-10-24' }, future);
    expect(facts.map(fact => [fact.text, fact.late])).toEqual([['tomorrow', false], ['due Sat', false]]);
    expect(taskFacts({ ...todo, scheduled: '2026-10-22', deadline: '2026-10-22' }, future).map(fact => [fact.text, fact.late])).toEqual([['today', false], ['due today', false]]);
    expect(taskFacts({ ...todo, scheduled: '2026-10-21', deadline: '2026-10-21' }, future).map(fact => [fact.text, fact.late])).toEqual([['since yesterday', true], ['due yesterday', true]]);
  });

  test('past displayed days do not mark a later plan late merely because it precedes today', () => {
    const facts = taskFacts({ ...todo, scheduled: '2026-10-21', deadline: '2026-10-21' }, { date: '2026-10-20', today: '2026-10-22' });
    expect(facts.map(fact => [fact.text, fact.late])).toEqual([['yesterday', false], ['due yesterday', false]]);
  });

  test('warns from deadline day through the configured lead inclusively, excluding late dates', () => {
    for (const [deadline, warning, late] of [
      ['2026-10-10', true, false],
      ['2026-10-13', true, false],
      ['2026-10-14', false, false],
      ['2026-10-09', false, true],
    ] as const) {
      expect(taskFacts({ ...todo, deadline, warning_days: 3 }, day)[0]).toMatchObject({ field: 'deadline', warning, late });
    }
    expect(taskFacts({ ...todo, deadline: day.date, warning_days: 0 }, day)[0]!.warning).toBe(true);
    expect(taskFacts({ ...todo, deadline: day.date }, day)[0]!.warning).toBe(false);
    expect(taskFacts({ ...todo, deadline: day.date, warning_days: 3, status: 'done', completed_on: day.date }, day).some(fact => fact.warning)).toBe(false);
    expect(taskFacts({ ...todo, deadline: day.date, warning_days: 3, status: 'cancelled' }, day)).toEqual([]);
  });

  test('measures warning windows from the displayed day, not civil today', () => {
    const task = { ...todo, deadline: '2026-10-28', warning_days: 3 };
    expect(taskFacts(task, { date: '2026-10-25', today: '2026-10-22' })[0]!.warning).toBe(true);
    expect(taskFacts(task, { date: '2026-10-24', today: '2026-10-22' })[0]!.warning).toBe(false);
  });

  test('omits the plan a listing already implies and a time shown in its own column', () => {
    const task = { ...todo, scheduled: '2026-10-10', scheduled_time: '09:00', deadline: '2026-10-10', deadline_time: '17:00', priority: 'high' as const };
    expect(taskFacts(task, { ...day, listed: true, timeShown: true }).map(fact => fact.text)).toEqual(['due', 'High']);
    expect(taskFacts(task, day).map(fact => fact.text)).toEqual(['today 09:00', 'due today 17:00', 'High']);
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

describe('groupDayAgenda', () => {
  test('keeps today and carried work out of lookahead and includes the seventh day, not the eighth', () => {
    const today = item('today', ['scheduled'], { scheduled: '2026-10-10' });
    const carried = item('carried', ['overdue'], { scheduled: '2026-10-06', deadline: '2026-10-12' });
    const warning = item('warning', ['warning'], { deadline: '2026-10-13' });
    const future = item('next', ['scheduled'], { scheduled: '2026-10-11', deadline: '2026-10-12' });
    const last = item('last', ['scheduled'], { scheduled: '2026-10-17' });
    const outside = item('outside', ['scheduled'], { scheduled: '2026-10-18' });
    const closed = item('closed', ['recently_completed'], { status: 'done', scheduled: '2026-10-11' });
    const groups = groupDayAgenda([today, carried, warning, closed], [today, carried, future, future, warning, last, outside, closed], '2026-10-10');
    expect(groups.planned.map(row => row.source.block.id)).toEqual(['today']);
    expect(groups.overdue.map(row => row.source.block.id)).toEqual(['carried']);
    expect(groups.upcoming.map(day => [day.date, day.rows.map(row => row.source.block.id)])).toEqual([
      ['2026-10-11', ['next']], ['2026-10-13', ['warning']], ['2026-10-17', ['last']],
    ]);
  });

  test('completion history does not hide the next recurrence or its later Doing state', () => {
    const history = item('repeat', ['recently_completed'], { status: 'done', scheduled: '2026-10-01', completed_on: '2026-10-10' });
    const live = item('repeat', ['scheduled'], { scheduled: '2026-10-11' });
    const next = groupDayAgenda([history], [live], '2026-10-10');
    expect(next.done).toEqual([history]);
    expect(next.upcoming[0]!.rows).toEqual([live]);
    const doing = { ...live, task: { ...live.task, status: 'doing' as const }, reasons: ['in_progress' as const] };
    const active = groupDayAgenda([history, doing], [doing], '2026-10-10');
    expect(active.done).toEqual([history]);
    expect(active.planned).toEqual([doing]);
    expect(active.upcoming).toEqual([]);
  });

  test('moving the displayed day brings that day into the main section and advances the seven-day boundary', () => {
    const next = item('next', ['scheduled'], { scheduled: '2026-10-11' });
    const eighth = item('eighth', ['scheduled'], { scheduled: '2026-10-18' });
    const groups = groupDayAgenda([next], [next, eighth], '2026-10-11');
    expect(groups.planned.map(row => row.source.block.id)).toEqual(['next']);
    expect(groups.upcoming.map(day => day.date)).toEqual(['2026-10-18']);
    expect(groupDayAgenda([], [], '2026-10-11').planned).toEqual([]);
  });

  test('orders future plans by civil day and then time while preserving untimed rows', () => {
    const groups = groupDayAgenda([], [
      item('late', ['scheduled'], { scheduled: '2026-10-11', scheduled_time: '19:00' }),
      item('early', ['scheduled'], { scheduled: '2026-10-11', scheduled_time: '09:00' }),
      item('untimed', ['scheduled'], { scheduled: '2026-10-11' }),
      item('deadline', ['deadline'], { deadline: '2026-10-12', deadline_time: '17:00' }),
    ], '2026-10-10');
    expect(groups.upcoming[0]!.rows.map(row => row.source.block.id)).toEqual(['untimed', 'early', 'late']);
    expect(groups.upcoming[1]!.date).toBe('2026-10-12');
  });
});

describe('agendaTaskTime', () => {
  test('shows the relevant plan clock and leaves untimed or finished work blank', () => {
    const row = item('timed', ['scheduled'], { scheduled: '2026-10-11', scheduled_time: '09:00', deadline: '2026-10-12', deadline_time: '17:00' });
    expect(agendaTaskTime(row, '2026-10-10')).toBeNull();
    expect(agendaTaskTime(row, '2026-10-11')).toBe('09:00');
    expect(agendaTaskTime({ ...row, task: { ...row.task, scheduled: null, scheduled_time: null } }, '2026-10-12')).toBe('17:00');
    expect(agendaTaskTime(item('untimed', ['scheduled'], { scheduled: '2026-10-10' }), '2026-10-10')).toBeNull();
    expect(agendaTaskTime(item('finished', ['recently_completed'], { scheduled: '2026-10-11', scheduled_time: '09:00' }), '2026-10-11')).toBeNull();
  });

  test('carried work retains its clock but reports its date once as a missed-plan fact', () => {
    const row = item('carried', ['overdue'], { scheduled: '2026-10-06', scheduled_time: '19:00' });
    expect(agendaTaskTime(row, '2026-10-10')).toBe('19:00');
    expect(taskFacts(row.task, { date: '2026-10-10', today: '2026-10-10', listed: true, timeShown: true }).map(fact => fact.text)).toEqual(['since Tue']);
  });
});

describe('plannedTaskCounts', () => {
  test('deduplicates coincident dates and repeated rows while excluding finished work', () => {
    const both = item('both', ['scheduled', 'deadline'], { scheduled: '2026-10-10', deadline: '2026-10-10' });
    const separate = item('separate', ['scheduled'], { scheduled: '2026-10-10', deadline: '2026-10-11' });
    const closed = item('done', ['recently_completed'], { status: 'done', scheduled: '2026-10-10' });
    const cancelled = item('cancelled', [], { status: 'cancelled', deadline: '2026-10-11' });
    expect([...plannedTaskCounts([both, both, separate, closed, cancelled])]).toEqual([['2026-10-10', 2], ['2026-10-11', 1]]);
  });
});

describe('stripDays', () => {
  test('counts open work per day, warns inside a deadline window and adds carried work to today', () => {
    const near = item('near', ['deadline'], { deadline: '2026-10-27', warning_days: 3 });
    const far = item('far', ['deadline'], { deadline: '2026-10-31', warning_days: 3 });
    const planned = item('planned', ['scheduled'], { scheduled: '2026-10-25' });
    const days = stripDays([near, near, far, planned], '2026-10-25', 2);
    expect(days.get('2026-10-25')).toEqual({ open: 3, overdue: 2, warning: 0 });
    expect(days.get('2026-10-27')).toEqual({ open: 1, overdue: 0, warning: 1 });
    expect(days.get('2026-10-31')).toEqual({ open: 1, overdue: 0, warning: 0 });
  });
});

describe('upcomingDayLabel', () => {
  test('names tomorrow, then weekdays, with a month and day rather than ISO', () => {
    expect(upcomingDayLabel('2026-10-26', '2026-10-25')).toEqual({ name: 'Tomorrow', detail: 'Oct 26' });
    expect(upcomingDayLabel('2026-11-01', '2026-10-25')).toEqual({ name: 'Sunday', detail: 'Nov 1' });
  });
});
