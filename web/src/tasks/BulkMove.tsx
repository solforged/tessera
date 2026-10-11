import { Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AgendaItem, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { movableTo, rescheduleTasks } from './reschedule';
import type { Rescheduled } from './reschedule';
import { relativeDate } from './task-labels';

/** Moves a group of tasks to one day and keeps a quiet `Moved 6 to today · Undo` line until the next move. */
export function createBulkMove(notebook: NotebookClient, onChanged: () => void): { move(rows: readonly (TaskRow | AgendaItem)[], date: string): void; Notice: () => JSX.Element } {
  const [moved, setMoved] = createSignal<{ label: string; result: Rescheduled } | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const move = (rows: readonly (TaskRow | AgendaItem)[], date: string) => {
    if (busy()) return;
    const count = movableTo(rows, date).length, when = relativeDate(date, notebook.todayDate());
    setBusy(true); setError(''); setMoved(null);
    void rescheduleTasks(notebook, rows, date, `Move ${count} ${count === 1 ? 'task' : 'tasks'} to ${when}`)
      .then(result => { if (result) setMoved({ label: `Moved ${result.count} to ${when}`, result }); onChanged(); }, fail)
      .finally(() => setBusy(false));
  };
  const undo = () => {
    const current = moved();
    if (!current || busy()) return;
    setBusy(true); setError('');
    void current.result.undo().then(() => { setMoved(null); onChanged(); }, fail).finally(() => setBusy(false));
  };
  const Notice = () => <>
    <Show when={moved()}>{state => <p class="agenda-message agenda-moved" role="status">{state().label}<Button disabled={busy()} onClick={undo}>Undo</Button></p>}</Show>
    <Show when={error()}><p class="agenda-error" role="alert">{error()}</p></Show>
  </>;
  return { move, Notice };
}
