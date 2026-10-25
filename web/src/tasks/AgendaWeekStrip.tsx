import { For, Show, createMemo } from 'solid-js';
import type { TaskRow } from '../api/types';
import { Button } from '../ui/Button';
import { stripDays } from './task-labels';

/** Dots beyond this become a count beside them. */
const maxDots = 6;

/** Seven ruled civil days, one dot per open task; each deduplicates a task's coincident schedule and deadline. */
export function AgendaWeekStrip(props: { dates: readonly (string | null)[]; date: string; today: string; rows: readonly TaskRow[]; overdueToday?: number; loading: boolean; disabled?: boolean; onSelect(date: string): void }) {
  const days = createMemo(() => {
    const counts = stripDays(props.rows, props.today, props.overdueToday);
    return props.dates.map(date => {
      const day = date ? new Date(`${date}T12:00:00Z`) : null;
      const weekday = day?.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) ?? '';
      const numeral = day?.getUTCDate() ?? '';
      const count = date ? counts.get(date) ?? { open: 0, overdue: 0, warning: 0 } : { open: 0, overdue: 0, warning: 0 };
      // Overdue dots lead, then deadline warnings, then the rest, all within the first six.
      const dots = Array.from({ length: Math.min(count.open, maxDots) }, (_, index) => index < count.overdue ? 'overdue' : index < count.overdue + count.warning ? 'warning' : 'open');
      return { date, weekday, numeral, count, dots };
    });
  });
  const label = (day: ReturnType<typeof days>[number]) => props.loading ? 'loading tasks'
    : [`${day.count.open} open`, day.count.overdue ? `${day.count.overdue} overdue` : '', day.count.warning ? `${day.count.warning} due soon` : ''].filter(Boolean).join(' · ');
  return <nav class="agenda-week-strip" aria-label="Week days" aria-busy={props.loading}>
    <For each={days()}>{day => <Button class={`agenda-week-day${props.today === day.date ? ' agenda-week-today' : ''}`} aria-current={props.date === day.date ? 'date' : undefined} label={`${day.weekday} ${day.numeral}, ${label(day)}`} disabled={props.disabled || !day.date} onClick={() => { if (day.date) props.onSelect(day.date); }}>
      <span class="agenda-day-weekday">{day.weekday}</span>
      <span class="agenda-day-numeral">{day.numeral}</span>
      <span class="agenda-day-dots" aria-hidden="true">
        <Show when={!props.loading}>
          <For each={day.dots}>{dot => <span class={`agenda-day-dot agenda-day-dot-${dot}`} />}</For>
          <Show when={day.count.open > maxDots}><span class="agenda-day-more">{day.count.open}</span></Show>
        </Show>
      </span>
    </Button>}</For>
  </nav>;
}
