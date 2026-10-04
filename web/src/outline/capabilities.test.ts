import { describe, expect, test } from 'bun:test';
import type { TaskState } from '../api/types';
import { quickTaskPlan } from './capabilities';

const task: TaskState = {
  status: 'waiting', scheduled: '2026-09-01', scheduled_time: '10:30',
  deadline: '2026-12-31', deadline_time: '17:00', warning_days: 3,
  repeater: { every: 2, unit: 'week', mode: 'fixed' }, priority: 'high', completed_on: null,
};

describe('outline quick planning', () => {
  test('removes only the recognized trailing token and plans against the displayed date', () => {
    const plan = quickTaskPlan('  Translate the passage\t @tomorrow 09:05  ', task, '2024-02-28');
    expect(plan).toEqual({
      text: '  Translate the passage\t   ',
      value: { ...task, scheduled: '2024-02-29', scheduled_time: '09:05' },
    });
    expect(task.scheduled).toBe('2026-09-01');
    expect(task.scheduled_time).toBe('10:30');
    expect(quickTaskPlan('Translate the passage\n@today', task, '2024-02-28')).toEqual({
      text: 'Translate the passage\n', value: { ...task, scheduled: '2024-02-28', scheduled_time: null },
    });
  });

  test('leaves field value authoring ahead of task shorthand', () => {
    expect(quickTaskPlan('Author:: @today', task, '2026-10-03')).toBeNull();
    expect(quickTaskPlan('When:: @next Monday', task, '2026-10-03')).toBeNull();
    expect(quickTaskPlan('Time:: @tomorrow 09:05', task, '2026-10-03')).toBeNull();
  });

  test('plans an actual card source without mistaking its markup for a field name', () => {
    expect(quickTaskPlan('Front >> Back::suffix @tomorrow', task, '2026-10-03')?.text).toBe('Front >> Back::suffix ');
    expect(quickTaskPlan('{{c1::answer}} @tomorrow', task, '2026-10-03')?.text).toBe('{{c1::answer}} ');
  });

  test('friendly multiword dates and relative dates keep all unrelated task state', () => {
    expect(quickTaskPlan('Read @next Thursday', task, '2026-12-31')).toEqual({
      text: 'Read ', value: { ...task, scheduled: '2027-01-07', scheduled_time: null },
    });
    expect(quickTaskPlan('Read @in 2 weeks', task, '2026-12-31')?.value.scheduled).toBe('2027-01-14');
    expect(quickTaskPlan('Read @+2d', task, '2026-12-31')?.value.scheduled).toBe('2027-01-02');
  });

  test('leaves ordinary notes, mid-sentence dates and email-like text untouched', () => {
    expect(quickTaskPlan('Read @tomorrow', null, '2026-10-03')).toBeNull();
    for (const text of ['Read @tomorrow then translate', 'name@today', 'Read @@today', 'Read \\@today', 'Read @someone', 'Read @next', 'Read @']) {
      expect(quickTaskPlan(text, task, '2026-10-03')).toBeNull();
    }
  });

  test('leaves complete and unfinished reference content untouched', () => {
    for (const text of ['Read [[source| @today]]', 'Read [[source| @today', 'Read [[ @tomorrow', 'Read #[[source| @today']) {
      expect(quickTaskPlan(text, task, '2026-10-03')).toBeNull();
    }
    expect(quickTaskPlan('Read [[source|some @name]] @tomorrow', task, '2026-10-03')?.text).toBe('Read [[source|some @name]] ');
    expect(quickTaskPlan('Read \\[[literal @tomorrow', task, '2026-10-03')?.text).toBe('Read \\[[literal ');
  });

  test('shields inline code including unmatched and unequal backtick runs', () => {
    for (const text of ['Read `@today`', 'Read ` @today', 'Read ``literal ` @today', 'Read ```literal ` @today']) {
      expect(quickTaskPlan(text, task, '2026-10-03')).toBeNull();
    }
    expect(quickTaskPlan('Read `@today` @tomorrow', task, '2026-10-03')?.text).toBe('Read `@today` ');
    expect(quickTaskPlan('Read ``literal ` code`` @tomorrow', task, '2026-10-03')?.text).toBe('Read ``literal ` code`` ');
  });

  test('shields backtick and tilde fences until their real closing line', () => {
    for (const text of ['```\nplan @today', '~~~md\nplan @today', '  ````md\n```\nplan @today', '~~~\n~~~ still code\nplan @today']) {
      expect(quickTaskPlan(text, task, '2026-10-03')).toBeNull();
    }
    expect(quickTaskPlan('```md\n@today\n```\nRead @tomorrow', task, '2026-10-03')?.text).toBe('```md\n@today\n```\nRead ');
    expect(quickTaskPlan('~~~md\n@today\n~~~~\nRead @tomorrow', task, '2026-10-03')?.text).toBe('~~~md\n@today\n~~~~\nRead ');
  });

  test('does not remove invalid dates, clocks, context or multiline token text', () => {
    for (const text of ['Read @2026-02-29', 'Read @today 24:00', 'Read @09:00', 'Read @next\nMonday']) {
      expect(quickTaskPlan(text, task, '2026-10-03')).toBeNull();
    }
    expect(quickTaskPlan('Read @today', task, 'not a date')).toBeNull();
  });
});
