import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { DEMO } from '../demo/mode';

/** What the sidebar's landmarks report: planned tasks for the day, cards due and highlights not yet worked. */
export interface DeskCounts { planned: number; overdue: number; cards: number; highlights: number }

// Typing commits a change every second or so; counts follow once a burst settles.
const REFRESH_DELAY = 800;

export function deskCounts(notebook: NotebookClient, date: Accessor<string>): Accessor<DeskCounts | undefined> {
  const [counts, setCounts] = createSignal<DeskCounts>();
  createEffect(() => {
    const day = date(); notebook.changeSequence();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all([
        notebook.api.agenda(day, controller.signal),
        notebook.api.cardQuery({ source: null, selection: 'due', limit: 1 }, controller.signal),
        !DEMO ? notebook.api.highlights({ unprocessed: true, limit: 0 }, controller.signal) : undefined,
      ]).then(([agenda, cards, highlights]) => {
        let planned = 0, overdue = 0;
        for (const item of agenda.items) {
          if (item.reasons.includes('recently_completed') || item.reasons.every(reason => reason === 'unplanned')) continue;
          planned++;
          if (item.reasons.includes('overdue') || !!item.task.scheduled && item.task.scheduled < day) overdue++;
        }
        setCounts({ planned, overdue, cards: cards.total, highlights: highlights?.total ?? 0 });
      }, () => {
        // A stale count would mislead; each destination reports its own loading errors.
        if (!controller.signal.aborted) setCounts(undefined);
      });
    }, untrack(counts) ? REFRESH_DELAY : 0);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  return counts;
}

/** `2026-10-07` → `Wed 7`, read as a civil date so no time zone can shift it. */
export function shortDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}
