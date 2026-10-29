import { Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AgendaItem, TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { movableTo, rescheduleTasks } from './reschedule';
import type { Rescheduled } from './reschedule';
import { relativeDate } from './relative-date';
import { exitRow, holdRows, releaseRow } from './row-motion';
import { handOffFocus } from './focus-handoff';

/** Moves a group of tasks to one day and keeps a quiet `Moved 6 to today · Undo` line until the next move. */
export function createBulkMove(notebook: NotebookClient, onChanged: () => void): { move(rows: readonly (TaskRow | AgendaItem)[], date: string): void; Notice: () => JSX.Element } {
  const [moved, setMoved] = createSignal<{ label: string; result: Rescheduled; ids: string[] } | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  let undoButton: HTMLButtonElement | undefined;
  const move = (rows: readonly (TaskRow | AgendaItem)[], date: string) => {
    if (busy()) return;
    const movable = movableTo(rows, date), count = movable.length, when = relativeDate(date, notebook.todayDate());
    const ids = movable.map(row => row.source.block.id);
    setBusy(true); setError(''); setMoved(null);
    // The moved rows start leaving now: the refetch removes them within a frame or two of the commit. The rows they
    // arrive as are new, and fade in where they land.
    const leaving = ids.flatMap(id => [...document.querySelectorAll<HTMLElement>(`.agenda-row[data-task-id="${CSS.escape(id)}"]`)]);
    const exits = leaving.map(element => exitRow(element));
    if (exits.some(Boolean)) holdRows(ids, Promise.all(exits.map(exit => exit?.finished)));
    const restore = () => leaving.forEach(element => releaseRow(element));
    void rescheduleTasks(notebook, rows, date, `Move ${count} ${count === 1 ? 'task' : 'tasks'} to ${when}`)
      .then(result => {
        if (result) setMoved({ label: `Moved ${result.count} to ${when}`, result, ids });
        else restore();
        onChanged();
      }, reason => { restore(); fail(reason); })
      .finally(() => {
        setBusy(false);
        // The menu's trigger leaves with its section, so the notice's Undo takes the keyboard rather than the page body.
        const active = document.activeElement;
        if (moved() && undoButton && (!active || active === document.body || active.closest('[data-task-rows], .popup'))) undoButton.focus({ preventScroll: true });
      });
  };
  const undo = () => {
    const current = moved(), origin = undoButton;
    if (!current || busy()) return;
    // Undo unmounts with the notice, so the first restored row takes the keyboard it held.
    const owner = origin?.closest<HTMLElement>('.agenda-pane') ?? origin?.closest<HTMLElement>('[data-task-rows]');
    const held = !!origin && document.activeElement === origin;
    setBusy(true); setError('');
    void current.result.undo().then(() => { setMoved(null); onChanged(); if (held && origin) handOffFocus(origin, current.ids, owner); }, fail).finally(() => setBusy(false));
  };
  const Notice = () => <>
    <Show when={moved()}>{state => <p class="agenda-message agenda-moved" role="status">{state().label}<Button ref={undoButton} disabled={busy()} onClick={undo}>Undo</Button></p>}</Show>
    <Show when={error()}><p class="agenda-error" role="alert">{error()}</p></Show>
  </>;
  return { move, Notice };
}
