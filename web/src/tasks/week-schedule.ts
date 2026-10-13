import type { TaskRow, TaskState } from '../api/types';
import type { NotebookClient } from '../document/contract';

export interface ScheduledWeekTask {
  row: TaskRow;
  pending: boolean;
  committedSequence: number | null;
}
interface Move { row: TaskRow; before: TaskState; after: TaskState }

/** Calendar intents compose immediately; their revision-checked commands and history travel in input order. */
export class WeekScheduleHistory {
  private queue = Promise.resolve();
  private confirmed = new Map<string, TaskRow>();
  private pending = new Map<string, ScheduledWeekTask>();
  private undoStack: Move[] = [];
  private redoStack: Move[] = [];

  constructor(private notebook: Pick<NotebookClient, 'commit'>, private changed: (id: string, value: ScheduledWeekTask) => void) {}

  latest(row: TaskRow): TaskRow {
    const pending = this.pending.get(row.source.block.id);
    if (pending) return pending.row;
    const confirmed = this.confirmed.get(row.source.block.id);
    return confirmed && confirmed.source.block.revision >= row.source.block.revision ? confirmed : row;
  }

  schedule(row: TaskRow, task: TaskState): Promise<void> {
    row = this.latest(row);
    if (task.scheduled === row.task.scheduled && task.scheduled_time === row.task.scheduled_time) return Promise.resolve();
    const move = { row, before: row.task, after: task };
    this.undoStack.push(move);
    this.redoStack = [];
    return this.write(row, task).catch(reason => {
      this.undoStack = this.undoStack.filter(value => value !== move);
      this.redoStack = this.redoStack.filter(value => value !== move);
      throw reason;
    });
  }

  undo(redo = false): Promise<void> {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const move = from.pop();
    if (!move) return Promise.resolve();
    to.push(move);
    return this.write(this.latest(move.row), redo ? move.after : move.before).catch(reason => {
      const index = to.indexOf(move);
      if (index >= 0) to.splice(index, 1);
      from.push(move);
      throw reason;
    });
  }

  private write(row: TaskRow, task: TaskState): Promise<void> {
    const id = row.source.block.id;
    const value: ScheduledWeekTask = { row: { ...row, task }, pending: true, committedSequence: null };
    this.pending.set(id, value);
    this.changed(id, value);
    const run = this.queue.then(async () => {
      const confirmed = this.confirmed.get(id);
      const source = confirmed && confirmed.source.block.revision >= row.source.block.revision ? confirmed : row;
      const label = `${task.scheduled}${task.scheduled_time ? ` at ${task.scheduled_time}` : ', all-day'}`;
      const receipt = await this.notebook.commit([{ op: 'set_task', id, base_revision: source.source.block.revision, task }], `Reschedule task to ${label}`);
      const revision = receipt.revisions.find(value => value.id === id)?.revision ?? source.source.block.revision;
      const saved = { ...row, source: { ...row.source, block: { ...row.source.block, revision } }, task };
      this.confirmed.set(id, saved);
      if (this.pending.get(id) !== value) return;
      this.pending.delete(id);
      this.changed(id, { row: saved, pending: false, committedSequence: receipt.seq });
    }).catch(reason => {
      if (this.pending.get(id) === value) {
        this.pending.delete(id);
        this.changed(id, { row: this.confirmed.get(id) ?? row, pending: false, committedSequence: null });
      }
      throw reason;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
