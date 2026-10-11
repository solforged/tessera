import { For, createMemo } from 'solid-js';
import type { TaskRow } from '../api/types';
import { Button } from '../ui/Button';
import { isFinished } from './task-labels';

/** Seven civil days with one dot per open task, even when a task has both planning dates on that day. */
export function AgendaWeekStrip(props: { dates: readonly (string | null)[]; date: string; rows: readonly TaskRow[]; loading: boolean; disabled?: boolean; onSelect(date: string): void }) {
  const days = createMemo(() => props.dates.map(date => {
    const items = props.rows.filter(row => !isFinished(row.task) && (row.task.scheduled === date || row.task.deadline === date));
    const label = date ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
    return { date, label, items };
  }));
  return <nav class="agenda-week-strip" aria-label="Week days" aria-busy={props.loading}>
    <For each={days()}>{day => <Button class="agenda-week-day" aria-current={props.date === day.date ? 'date' : undefined} label={`${day.label}${props.loading ? ', loading tasks' : `, ${day.items.length} open task${day.items.length === 1 ? '' : 's'}`}`} disabled={props.disabled || !day.date} onClick={() => { if (day.date) props.onSelect(day.date); }}>
      <span>{day.label}</span><span class="agenda-day-dots" aria-hidden="true"><For each={day.items}>{() => <i />}</For></span>
    </Button>}</For>
  </nav>;
}
