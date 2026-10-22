import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { AgendaItem } from '../api/types';
import { groupAgenda } from '../tasks/task-labels';

/** Today and the sidebar share the day's actionable plans, separate from overdue work and future warnings. */
export function agendaDaySummary(rows: readonly AgendaItem[], date: string): { planned: number; overdue: number; items: AgendaItem[] } {
  const groups = groupAgenda(rows, date);
  const items = groups.planned.filter(item => item.task.status === 'doing'
    || !!item.task.scheduled && item.task.scheduled <= date
    || !!item.task.deadline && item.task.deadline <= date);
  return { planned: items.length, overdue: groups.overdue.length, items };
}

/** What the sidebar's landmarks report: planned tasks for the day, cards due and highlights not yet worked. */
export interface DeskCounts { planned: number; overdue: number; cards: number; revisits: number; highlights: number }

export function deskCounts(notebook: NotebookClient, date: Accessor<string>): Accessor<DeskCounts | undefined> {
  const [counts, setCounts] = createSignal<DeskCounts>();
  createEffect(() => {
    const day = date(); notebook.changeSequence(); notebook.lastChange();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all([
        notebook.api.agenda(day, controller.signal),
        notebook.api.cardQuery({ source: null, selection: 'due', limit: 1 }, controller.signal),
        notebook.api.highlights({ unprocessed: true, limit: 0 }, controller.signal),
        notebook.api.revisits(day, controller.signal),
      ]).then(([agenda, cards, highlights, revisits]) => {
        if (controller.signal.aborted) return;
        const { planned, overdue } = agendaDaySummary(agenda.items, day);
        setCounts({ planned, overdue, cards: cards.total, revisits: revisits.length, highlights: highlights.total });
      }, () => {
        // A stale count would mislead; each destination reports its own loading errors.
        if (!controller.signal.aborted) setCounts(undefined);
      });
    }, 0);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  return counts;
}

/** `2026-10-07` → `Wed 7`, read as a civil date so no time zone can shift it. */
export function shortDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}
