import { describe, expect, mock, test } from 'bun:test';
import type { Block, Committed, Operation, TaskRow, TaskState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { movableTo, movedWhen, moveChoices, rescheduleTasks, shortDay } from './reschedule';

const task: TaskState = {
  status: 'waiting', scheduled: '2026-10-11', scheduled_time: '19:00',
  deadline: '2026-10-15', deadline_time: '17:00', warning_days: 3,
  repeater: { every: 2, unit: 'week', mode: 'fixed' }, priority: 'high', completed_on: null,
};
const page: Block = {
  id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Project', heading: null,
  archived: false, revision: 1, created_at: 0, updated_at: 0,
};
function row(id: string, state: Partial<TaskState> = {}, revision = 3): TaskRow {
  return {
    source: { block: { ...page, id, kind: 'block', parent_id: page.id, text: id, revision }, page },
    task: { ...task, ...state }, project_id: null, section_id: null, section_text: null,
  };
}
function commandBoundary() {
  const commit = mock(async (operations: readonly Operation[], _reason?: string): Promise<Committed> => ({
    seq: 1, settings: [], deletions: [], replayed: false, text_rewrites: [],
    revisions: operations.map(operation => {
      if (operation.op !== 'set_task') throw new Error('Expected a task command');
      return { id: operation.id, revision: operation.base_revision + 1 };
    }),
  }));
  return { notebook: { commit } as unknown as NotebookClient, commit };
}

describe('agenda rescheduling', () => {
  test.each([
    ['2026-10-12', '14:30'],
    ['2026-10-11', '14:30'],
    ['2026-10-11', null],
    ['2026-10-12', null],
  ] as const)('changes 19:00 to %s at %s and Undo restores the complete plan', async (date, time) => {
    const { notebook, commit } = commandBoundary();
    const original = row('timed');
    const before = structuredClone(original);
    const result = await rescheduleTasks(notebook, [original], date, 'Reschedule task', time);
    expect(result?.count).toBe(1);
    expect(commit.mock.calls[0]![0]).toEqual([
      { op: 'set_task', id: 'timed', base_revision: 3, task: { ...task, scheduled: date, scheduled_time: time } },
    ]);
    await result!.undo();
    expect(commit.mock.calls[1]![0]).toEqual([
      { op: 'set_task', id: 'timed', base_revision: 4, task },
    ]);
    expect(original).toEqual(before);
  });

  test('adds a time to an all-day task without moving its day', async () => {
    const { notebook, commit } = commandBoundary();
    const original = row('all-day', { scheduled_time: null });
    expect((await rescheduleTasks(notebook, [original], task.scheduled!, 'Reschedule task', '14:30'))?.count).toBe(1);
    expect(commit.mock.calls[0]![0]).toEqual([
      { op: 'set_task', id: 'all-day', base_revision: 3, task: { ...original.task, scheduled_time: '14:30' } },
    ]);
  });

  test('date-only day moves preserve time', async () => {
    const { notebook, commit } = commandBoundary();
    await rescheduleTasks(notebook, [row('timed')], '2026-10-12', 'Move task');
    expect(commit.mock.calls[0]![0]).toEqual([
      { op: 'set_task', id: 'timed', base_revision: 3, task: { ...task, scheduled: '2026-10-12' } },
    ]);
  });

  test('bulk day moves preserve each original time and Undo restores dates and times together', async () => {
    const { notebook, commit } = commandBoundary();
    const originals = [row('evening'), row('morning', { scheduled: '2026-10-10', scheduled_time: '08:15' }, 8), row('all-day', { scheduled: null, scheduled_time: null }, 12)];
    const unchanged = row('already-there', { scheduled: '2026-10-12', scheduled_time: '12:00' });
    const finished = [row('done', { status: 'done', completed_on: '2026-10-11' }), row('cancelled', { status: 'cancelled' })];
    const result = await rescheduleTasks(notebook, [...originals, unchanged, ...finished], '2026-10-12', 'Move tasks');
    expect(result?.count).toBe(3);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual(originals.map(original => ({
      op: 'set_task', id: original.source.block.id, base_revision: original.source.block.revision,
      task: { ...original.task, scheduled: '2026-10-12' },
    })));
    await result!.undo();
    expect(commit.mock.calls[1]![0]).toEqual(originals.map(original => ({
      op: 'set_task', id: original.source.block.id, base_revision: original.source.block.revision + 1, task: original.task,
    })));
  });

  test('same-day no-ops and finished tasks never submit a command', async () => {
    const { notebook, commit } = commandBoundary();
    const original = row('timed');
    expect(await rescheduleTasks(notebook, [original], task.scheduled!, 'Unchanged')).toBeNull();
    expect(await rescheduleTasks(notebook, [original], task.scheduled!, 'Unchanged', '19:00')).toBeNull();
    expect(await rescheduleTasks(notebook, [row('all-day', { scheduled_time: null })], task.scheduled!, 'Unchanged', null)).toBeNull();
    expect(await rescheduleTasks(notebook, [row('done', { status: 'done' }), row('cancelled', { status: 'cancelled' })], '2026-10-12', 'Unchanged', '14:30')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(movableTo([original], task.scheduled!)).toEqual([]);
    expect(movableTo([original], task.scheduled!, '14:30')).toEqual([original]);
    expect(movableTo([original], task.scheduled!, null)).toEqual([original]);
  });
});

describe('the Move to sheet', () => {
  const days = (today: string) => moveChoices(today).map(choice => `${choice.id} ${choice.date}`);

  test('offers today, tomorrow, the coming Saturday and next Monday on a weekday', () => {
    expect(days('2026-10-29')).toEqual(['today 2026-10-29', 'tomorrow 2026-10-30', 'weekend 2026-10-31', 'next-week 2026-11-02']);
    expect(days('2026-10-26')).toEqual(['today 2026-10-26', 'tomorrow 2026-10-27', 'weekend 2026-10-31', 'next-week 2026-11-02']);
  });

  test('never lists a day twice, so Friday folds the weekend into tomorrow and Sunday the Monday', () => {
    expect(days('2026-10-30')).toEqual(['today 2026-10-30', 'tomorrow 2026-10-31', 'next-week 2026-11-02']);
    expect(days('2026-10-31')).toEqual(['today 2026-10-31', 'tomorrow 2026-11-01', 'next-week 2026-11-02']);
    expect(days('2026-11-01')).toEqual(['today 2026-11-01', 'tomorrow 2026-11-02']);
  });

  test('says where a move landed: today, a weekday inside the week, else a date', () => {
    expect(movedWhen('2026-10-29', '2026-10-29')).toBe('today');
    expect(movedWhen('2026-10-30', '2026-10-29')).toBe('Friday');
    expect(movedWhen('2026-11-04', '2026-10-29')).toBe('Wednesday');
    expect(movedWhen('2026-11-05', '2026-10-29')).toBe('Nov 5');
    expect(movedWhen('2026-10-28', '2026-10-29')).toBe('Oct 28');
    expect(movedWhen('2027-01-04', '2026-10-29')).toBe('Jan 4, 2027');
  });

  test('labels a sheet row with its weekday and date', () => {
    expect(shortDay('2026-10-30', '2026-10-29')).toBe('Fri, Oct 30');
    expect(shortDay('2027-01-04', '2026-10-29')).toBe('Mon, Jan 4, 2027');
  });
});
