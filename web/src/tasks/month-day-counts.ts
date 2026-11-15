import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { TaskRow } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import { plannedTaskCounts } from './task-labels';
import { fetchWeekTaskRange, mondayWeekStart, shiftCalendarDate } from './week-calendar';

/**
 * What the day picker prints under a day: the open tasks planned on it, or, for a day already past, the ones that were
 * never finished (overdue). Exactly one of the two is non-zero.
 */
export interface DayCount {
  open: number;
  overdue: number;
}
export type DayCounts = Readonly<Record<string, DayCount>>;

/** The 42 civil days a month grid shows, Monday first, from the Monday on or before the month's first day. */
export function monthGridRange(month: string): { from: string; through: string } {
  const from = mondayWeekStart(`${month.slice(0, 7)}-01`)!;
  return { from, through: shiftCalendarDate(from, 41)! };
}

/** Each open task counts once on every day it is planned for, as Agenda's week strip counts it. */
export function dayCounts(
  rows: readonly TaskRow[],
  range: { from: string; through: string },
  today: string,
): DayCounts {
  const counts: Record<string, DayCount> = {};
  for (const [date, count] of plannedTaskCounts(rows)) {
    if (date < range.from || date > range.through) continue;
    counts[date] = date < today ? { open: 0, overdue: count } : { open: count, overdue: 0 };
  }
  return counts;
}

const cache = new WeakMap<WorkshopClient, Map<string, { sequence: number; today: string; counts: DayCounts }>>();

/** The visible month's counts: scheduled and deadline rows over the grid's range, shared by workshop revision. */
async function loadMonthDayCounts(
  workshop: WorkshopClient,
  month: string,
  today: string,
  signal: AbortSignal,
): Promise<DayCounts> {
  const range = monthGridRange(month);
  const sequence = workshop.changeSequence();
  const months = cache.get(workshop) ?? new Map();
  cache.set(workshop, months);
  const kept = months.get(range.from);
  if (kept?.sequence === sequence && kept.today === today) return kept.counts;
  const query = (value: Parameters<WorkshopClient['api']['taskQuery']>[0]) => workshop.api.taskQuery(value, signal);
  const [scheduled, deadlines] = await Promise.all([
    fetchWeekTaskRange(query, 'scheduled', range.from, range.through),
    fetchWeekTaskRange(query, 'deadline', range.from, range.through),
  ]);
  const counts = dayCounts([...scheduled.rows, ...deadlines.rows], range, today);
  months.set(range.from, { sequence, today, counts });
  return counts;
}

/** Counts for the month a grid shows; the previous month's stay on screen while the next one loads. */
export function createMonthDayCounts(workshop: Accessor<WorkshopClient>, initialDate: string, today: Accessor<string>) {
  const [month, setMonth] = createSignal(`${initialDate.slice(0, 7)}-01`);
  const [counts, setCounts] = createSignal<DayCounts>({});
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  createEffect(() => {
    const current = workshop(),
      visible = month(),
      now = today();
    current.changeSequence();
    const controller = new AbortController();
    setLoading(true);
    setError('');
    loadMonthDayCounts(current, visible, now, controller.signal).then(
      result => {
        if (controller.signal.aborted) return;
        setCounts(result);
        setLoading(false);
      },
      reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    onCleanup(() => controller.abort());
  });
  return { counts, loading, error, setMonth };
}
