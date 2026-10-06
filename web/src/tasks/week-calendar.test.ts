import { describe, expect, test } from 'bun:test';
import type { Block, TaskQuery, TaskQueryResult, TaskRow, TaskState, TaskStatus } from '../api/types';
import { calendarWeekDates, fetchWeekTaskRange, keyboardWeekSchedule, layoutWeekTimedEntries, mergeWeekTaskRows, mondayWeekStart, scheduleWeekTask, shiftCalendarDate, snapWeekMinutes, timeMinutes, weekRangeQuery, weekTaskEntries } from './week-calendar';

const task: TaskState = {
  status: 'waiting', scheduled: '2026-10-06', scheduled_time: '10:30',
  deadline: '2026-10-09', deadline_time: '17:00', warning_days: 3,
  repeater: { every: 2, unit: 'week', mode: 'fixed' }, priority: 'high', completed_on: null,
};
const page: Block = {
  id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Project', heading: null,
  archived: false, revision: 1, created_at: 0, updated_at: 0,
};

function row(id: string, state: Partial<TaskState> = {}, revision = 1): TaskRow {
  return {
    source: { block: { ...page, id, kind: 'block', parent_id: page.id, text: id, revision }, page },
    task: { ...task, ...state }, project_id: null,
  };
}

function simulatedQuery(rows: readonly TaskRow[], calls: TaskQuery[]) {
  return async (query: TaskQuery): Promise<TaskQueryResult> => {
    calls.push(query);
    const field = query.filter.scheduled ? 'scheduled' : 'deadline';
    const range = query.filter[field]!;
    const matches = rows.filter(value => {
      const date = value.task[field];
      return date !== null && (!range.from || date >= range.from) && (!range.through || date <= range.through)
        && query.filter.statuses.includes(value.task.status);
    });
    return { rows: matches.slice(0, query.limit ?? 500), total: matches.length };
  };
}

describe('civil calendar weeks', () => {
  test('starts on Monday and spans month, year, and daylight-saving boundaries', () => {
    expect(mondayWeekStart('2026-10-06')).toBe('2026-10-05');
    expect(mondayWeekStart('2026-10-05')).toBe('2026-10-05');
    expect(mondayWeekStart('2026-10-11')).toBe('2026-10-05');
    expect(calendarWeekDates('2026-01-01')).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(calendarWeekDates('2026-03-08')).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
    expect(calendarWeekDates('2026-11-01')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  });

  test('supports early years, leap years, and the full civil date bounds', () => {
    expect(shiftCalendarDate('0099-12-31', 1)).toBe('0100-01-01');
    expect(shiftCalendarDate('2000-02-28', 1)).toBe('2000-02-29');
    expect(shiftCalendarDate('1900-02-28', 1)).toBe('1900-03-01');
    expect(shiftCalendarDate('0001-01-01', -1)).toBeNull();
    expect(shiftCalendarDate('9999-12-31', 1)).toBeNull();
    expect(mondayWeekStart('0001-01-01')).toBe('0001-01-01');
    expect(calendarWeekDates('9999-12-31')).toEqual(['9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31', null, null]);
  });

  test('rejects invalid date labels and non-integral offsets', () => {
    for (const date of ['2026-02-30', '0000-01-01', '2026-13-01', '26-10-06', 'today']) {
      expect(shiftCalendarDate(date, 0)).toBeNull();
      expect(mondayWeekStart(date)).toBeNull();
    }
    expect(shiftCalendarDate('2026-10-06', 0.5)).toBeNull();
    expect(shiftCalendarDate('2026-10-06', Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('week task scheduling', () => {
  test('snaps to nearest quarter hour and clamps within a day', () => {
    expect(snapWeekMinutes(-100)).toBe(0);
    expect(snapWeekMinutes(7)).toBe(0);
    expect(snapWeekMinutes(8)).toBe(15);
    expect(snapWeekMinutes(9 * 60 + 22)).toBe(9 * 60 + 15);
    expect(snapWeekMinutes(9 * 60 + 23)).toBe(9 * 60 + 30);
    expect(snapWeekMinutes(1439)).toBe(1425);
    expect(snapWeekMinutes(2000)).toBe(1425);
    expect(timeMinutes('23:59')).toBe(1439);
  });

  test('a timed or all-day drop changes only scheduled fields in the full task', () => {
    expect(scheduleWeekTask(task, '2026-10-08', 543)).toEqual({ ...task, scheduled: '2026-10-08', scheduled_time: '09:00' });
    expect(scheduleWeekTask(task, '2026-10-08', null)).toEqual({ ...task, scheduled: '2026-10-08', scheduled_time: null });
    expect(task.scheduled).toBe('2026-10-06');
    expect(task.scheduled_time).toBe('10:30');
  });

  test('keyboard day changes preserve time and all unrelated planning', () => {
    expect(keyboardWeekSchedule(task, '2026-10-09', 'ArrowLeft')).toEqual({ ...task, scheduled: '2026-10-05' });
    expect(keyboardWeekSchedule(task, '2026-10-09', 'ArrowRight')).toEqual({ ...task, scheduled: '2026-10-07' });
    expect(keyboardWeekSchedule({ ...task, scheduled: null, scheduled_time: null }, '2026-10-09', 'ArrowRight')).toEqual({ ...task, scheduled: '2026-10-10', scheduled_time: null });
    expect(keyboardWeekSchedule(task, '2026-10-09', 'Home')).toEqual({ ...task, scheduled_time: null });
  });

  test('keyboard quarter-hour changes carry across midnight without changing deadlines', () => {
    expect(keyboardWeekSchedule({ ...task, scheduled_time: '00:00' }, '2026-10-06', 'ArrowUp')).toEqual({ ...task, scheduled: '2026-10-05', scheduled_time: '23:45' });
    expect(keyboardWeekSchedule({ ...task, scheduled_time: '23:45' }, '2026-10-06', 'ArrowDown')).toEqual({ ...task, scheduled: '2026-10-07', scheduled_time: '00:00' });
    expect(keyboardWeekSchedule({ ...task, scheduled_time: null }, '2026-10-06', 'ArrowDown')?.scheduled_time).toBe('08:15');
    expect(keyboardWeekSchedule({ ...task, scheduled_time: null }, '2026-10-06', 'ArrowUp')?.scheduled_time).toBe('07:45');
    expect(keyboardWeekSchedule({ ...task, scheduled: '0001-01-01', scheduled_time: '00:00' }, '0001-01-01', 'ArrowUp')).toBeNull();
    expect(keyboardWeekSchedule({ ...task, scheduled: '9999-12-31', scheduled_time: '23:45' }, '9999-12-31', 'ArrowDown')).toBeNull();
    expect(keyboardWeekSchedule(task, '2026-10-06', 'Escape')).toBeNull();
    expect(keyboardWeekSchedule({ ...task, scheduled_time: '10:07' }, '2026-10-06', 'ArrowDown')?.scheduled_time).toBe('10:22');
    expect(keyboardWeekSchedule({ ...task, scheduled_time: '10:07' }, '2026-10-06', 'ArrowUp')?.scheduled_time).toBe('09:52');
    expect(keyboardWeekSchedule({ ...task, scheduled_time: '23:59' }, '2026-10-06', 'ArrowDown')).toEqual({ ...task, scheduled: '2026-10-07', scheduled_time: '00:14' });
  });
});

describe('week entries and time lanes', () => {
  test('deduplicates query sources using the newest source revision', () => {
    const older = row('one', {}, 1);
    const newer = row('one', { scheduled_time: '11:00' }, 2);
    expect(mergeWeekTaskRows([older, row('two')], [newer])).toEqual([newer, row('two')]);
    expect(mergeWeekTaskRows([newer], [older])).toEqual([newer]);
  });

  test('combines same-day all-day scheduling and due, but keeps timed scheduling and deadlines', () => {
    const dates = calendarWeekDates('2026-10-06');
    const entries = weekTaskEntries([
      row('all-day', { scheduled_time: null, deadline: '2026-10-06' }),
      row('timed', { deadline: '2026-10-06' }),
      row('deadline-only', { scheduled: '2026-10-01' }),
      row('outside', { scheduled: '2026-10-01', deadline: '2026-10-12' }),
      row('done', { status: 'done', scheduled_time: null, deadline: null }),
      row('cancelled', { status: 'cancelled', scheduled_time: null, deadline: null }),
    ], dates);
    const allDay = entries.filter(entry => entry.row.source.block.id === 'all-day');
    expect(allDay).toHaveLength(1);
    expect(allDay[0]!.kind).toBe('scheduled');
    expect(allDay[0]!.due).toBe(true);
    expect(allDay[0]!.time).toBeNull();
    expect(entries.filter(entry => entry.row.source.block.id === 'timed').map(entry => entry.kind).sort()).toEqual(['due', 'scheduled']);
    expect(entries.find(entry => entry.row.source.block.id === 'deadline-only')?.kind).toBe('due');
    expect(entries.some(entry => entry.row.source.block.id === 'outside')).toBe(false);
    expect(entries.some(entry => entry.row.task.status === 'done')).toBe(true);
    expect(entries.some(entry => entry.row.task.status === 'cancelled')).toBe(true);
  });

  test('close tasks use lanes without shifting their scheduled starts', () => {
    const entries = weekTaskEntries([
      row('a', { scheduled_time: '09:00', deadline: null }),
      row('b', { scheduled_time: '09:00', deadline: null }),
      row('c', { scheduled_time: '09:15', deadline: null }),
      row('d', { scheduled_time: '09:30', deadline: null }),
      row('e', { scheduled_time: '10:00', deadline: null }),
      row('late', { scheduled_time: '23:59', deadline: null }),
      row('due', { scheduled: null, scheduled_time: null }),
    ], calendarWeekDates('2026-10-06'));
    const layout = layoutWeekTimedEntries(entries);
    expect(layout.map(item => [item.entry.row.source.block.id, item.minute, item.lane, item.lanes])).toEqual([
      ['a', 540, 0, 3], ['b', 540, 1, 3], ['c', 555, 2, 3], ['d', 570, 0, 3], ['e', 600, 0, 1], ['late', 1439, 0, 1],
    ]);
    for (let left = 0; left < layout.length; left++) {
      for (let right = left + 1; right < layout.length; right++) {
        const a = layout[left]!; const b = layout[right]!;
        if (a.minute + 30 > b.minute) expect(a.lane).not.toBe(b.lane);
      }
    }
  });
});

describe('complete week task queries', () => {
  test('sends independent unlimited-source ranges with every status and the explicit API maximum', () => {
    const scheduled = weekRangeQuery('scheduled', '2026-10-05', '2026-10-11');
    const deadline = weekRangeQuery('deadline', '2026-10-05', '2026-10-11');
    expect(scheduled.source).toBeNull();
    expect(scheduled.limit).toBe(2000);
    expect(scheduled.filter.selection).toBe('all');
    expect(scheduled.filter.statuses).toEqual(['todo', 'doing', 'waiting', 'done', 'cancelled']);
    expect(scheduled.filter.scheduled).toEqual({ from: '2026-10-05', through: '2026-10-11' });
    expect(scheduled.filter.deadline).toBeNull();
    expect(deadline.filter.scheduled).toBeNull();
    expect(deadline.filter.deadline).toEqual(scheduled.filter.scheduled);
  });

  test('fetches more than the default 500 without an unnecessary second request', async () => {
    const calls: TaskQuery[] = [];
    const rows = Array.from({ length: 501 }, (_, index) => row(String(index)));
    const result = await fetchWeekTaskRange(simulatedQuery(rows, calls), 'scheduled', '2026-10-05', '2026-10-11');
    expect(result.rows).toHaveLength(501);
    expect(result.incomplete).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.limit).toBe(2000);
  });

  test('splits a capped week into disjoint date ranges until every task is loaded', async () => {
    const calls: TaskQuery[] = [];
    const dates = calendarWeekDates('2026-10-06').filter((date): date is string => date !== null);
    const rows = dates.flatMap(date => Array.from({ length: 300 }, (_, index) => row(`${date}:${index}`, { scheduled: date })));
    const result = await fetchWeekTaskRange(simulatedQuery(rows, calls), 'scheduled', '2026-10-05', '2026-10-11');
    expect(result.rows).toHaveLength(2100);
    expect(result.incomplete).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).map(query => query.filter.scheduled)).toEqual([{ from: '2026-10-05', through: '2026-10-08' }, { from: '2026-10-09', through: '2026-10-11' }]);
  });

  test('splits a capped single day by statuses, including done and cancelled', async () => {
    const calls: TaskQuery[] = [];
    const statuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
    const rows = statuses.flatMap(status => Array.from({ length: 500 }, (_, index) => row(`${status}:${index}`, { status })));
    const result = await fetchWeekTaskRange(simulatedQuery(rows, calls), 'scheduled', '2026-10-06', '2026-10-06');
    expect(result.rows).toHaveLength(2500);
    expect(result.incomplete).toEqual([]);
    expect(calls).toHaveLength(6);
    expect(calls.slice(1).map(query => query.filter.statuses)).toEqual(statuses.map(status => [status]));
  });

  test('reports an unsplittable day/status cap instead of silently hiding planned items', async () => {
    const calls: TaskQuery[] = [];
    const rows = Array.from({ length: 2005 }, (_, index) => row(String(index), { status: 'todo', deadline: '2026-10-09' }));
    const result = await fetchWeekTaskRange(simulatedQuery(rows, calls), 'deadline', '2026-10-09', '2026-10-09');
    expect(result.rows).toHaveLength(2000);
    expect(result.incomplete).toEqual([{ field: 'deadline', date: '2026-10-09', status: 'todo', shown: 2000, total: 2005 }]);
  });

  test('propagates query failures for the calendar error state', async () => {
    await expect(fetchWeekTaskRange(async () => { throw new Error('Unavailable'); }, 'scheduled', '2026-10-05', '2026-10-11')).rejects.toThrow('Unavailable');
  });
});
