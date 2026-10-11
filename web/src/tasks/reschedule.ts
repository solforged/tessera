import type { AgendaItem, Committed, Operation, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { isFinished } from './task-labels';

/** Unfinished tasks not yet scheduled on `date`; a missed deadline already scheduled there stays to be dealt with. */
export function movableTo<T extends TaskRow | AgendaItem>(rows: readonly T[], date: string): T[] {
  return rows.filter(row => !isFinished(row.task) && row.task.scheduled !== date);
}

export interface Rescheduled {
  count: number;
  /** Puts every moved task's plan back, refusing a task changed since. */
  undo(): Promise<Committed>;
}

/**
 * Moves the schedule of each movable task to `date` as one notebook command. Times, deadlines and repeats stay; a
 * missed deadline without a schedule gains one, so the task shows on that day. Null when nothing moves.
 */
export async function rescheduleTasks(notebook: NotebookClient, rows: readonly (TaskRow | AgendaItem)[], date: string, label: string): Promise<Rescheduled | null> {
  const moving = movableTo(rows, date);
  if (!moving.length) return null;
  const operations: Operation[] = moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: row.source.block.revision, task: { ...row.task, scheduled: date } }));
  const committed = await notebook.commit(operations, label);
  const revisions = new Map(committed.revisions.map(value => [value.id, value.revision]));
  return {
    count: moving.length,
    undo: () => notebook.commit(moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: revisions.get(row.source.block.id) ?? row.source.block.revision, task: row.task })), `Undo: ${label}`),
  };
}
