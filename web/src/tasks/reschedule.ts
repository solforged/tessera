import type { AgendaItem, Committed, Operation, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { isFinished } from './task-labels';

/** Unfinished tasks whose date or explicitly supplied time would change; omitted time preserves each task's time. */
export function movableTo<T extends TaskRow | AgendaItem>(rows: readonly T[], date: string, time?: string | null): T[] {
  return rows.filter(row => !isFinished(row.task) && (row.task.scheduled !== date || time !== undefined && row.task.scheduled_time !== time));
}

export interface Rescheduled {
  count: number;
  /** Puts every moved task's plan back, refusing a task changed since. */
  undo(): Promise<Committed>;
}

/**
 * Moves the schedule of each movable task to `date` as one notebook command. Omitted time preserves each task's
 * time; null explicitly makes it all-day. Deadlines and repeats stay. A missed deadline without a schedule gains
 * one, so the task shows on that day. Null when neither date nor time changes.
 */
export async function rescheduleTasks(notebook: NotebookClient, rows: readonly (TaskRow | AgendaItem)[], date: string, label: string, time?: string | null): Promise<Rescheduled | null> {
  const moving = movableTo(rows, date, time);
  if (!moving.length) return null;
  const operations: Operation[] = moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: row.source.block.revision, task: { ...row.task, scheduled: date, scheduled_time: time === undefined ? row.task.scheduled_time : time } }));
  const committed = await notebook.commit(operations, label);
  const revisions = new Map(committed.revisions.map(value => [value.id, value.revision]));
  return {
    count: moving.length,
    undo: () => notebook.commit(moving.map(row => ({ op: 'set_task', id: row.source.block.id, base_revision: revisions.get(row.source.block.id) ?? row.source.block.revision, task: row.task })), `Undo: ${label}`),
  };
}
