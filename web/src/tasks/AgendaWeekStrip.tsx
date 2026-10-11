import { For, createMemo } from 'solid-js';
import type { TaskRow } from '../api/types';
import { Button } from '../ui/Button';
import { plannedTaskCounts } from './task-labels';

/** Seven ruled civil days; each count deduplicates a task's coincident schedule and deadline. */
export function AgendaWeekStrip(props: { dates: readonly (string | null)[]; date: string; today: string; rows: readonly TaskRow[]; loading: boolean; disabled?: boolean; onSelect(date: string): void }) {
  const days = createMemo(() => {
    const counts = plannedTaskCounts(props.rows);
    return props.dates.map(date => {
      const day = date ? new Date(`${date}T12:00:00Z`) : null;
      const weekday = day?.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) ?? '';
      const numeral = day?.getUTCDate() ?? '';
      return { date, weekday, numeral, count: date ? counts.get(date) ?? 0 : 0 };
    });
  });
  return <nav class="agenda-week-strip" aria-label="Week days" aria-busy={props.loading}>
    <For each={days()}>{day => <Button class={`agenda-week-day${props.today === day.date ? ' agenda-week-today' : ''}`} aria-current={props.date === day.date ? 'date' : undefined} label={`${day.weekday} ${day.numeral}${props.loading ? ', loading tasks' : `, ${day.count} open task${day.count === 1 ? '' : 's'}`}`} disabled={props.disabled || !day.date} onClick={() => { if (day.date) props.onSelect(day.date); }}>
      <span class="agenda-day-weekday">{day.weekday}</span>
      <span class="agenda-day-numeral">{day.numeral}</span>
      <span class="agenda-day-count" aria-hidden="true">{props.loading ? '·' : day.count || ''}</span>
    </Button>}</For>
  </nav>;
}
