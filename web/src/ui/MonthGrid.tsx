import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { planningCountLabel } from '../tasks/planning-marks';
import type { PlanningMarks } from '../tasks/planning-marks';
import { Button } from './Button';
import './month-grid.css';

/** Calendar dates are local dates, never UTC slices. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// Local noon keeps day arithmetic clear of daylight-saving edges.
const noon = (date: string) => new Date(`${date}T12:00:00`);

export interface MonthGridProps {
  /** The chosen date; the grid shows its month and follows it when it changes. */
  value: string | null;
  /** The civil today: the journal or agenda date, never the device clock. */
  today: string;
  /** Other dates worth seeing while choosing, such as a task's deadline, with a short label. */
  marks?: Record<string, string>;
  /** Notebook-wide open-task counts, independent of the picker’s related dates. */
  planningMarks?: PlanningMarks;
  planningLoading?: boolean;
  planningError?: string;
  /** The first civil date of the visible month, including keyboard navigation. */
  onMonthChange?(month: string): void;
  disabled?: boolean;
  onPick(date: string): void;
}

/** A month of days with arrow-key movement; Enter or click picks the focused day. */
export function MonthGrid(props: MonthGridProps) {
  const [focused, setFocused] = createSignal(props.value ?? props.today);
  const [month, setMonth] = createSignal(noon(focused()));
  let grid!: HTMLDivElement;
  createEffect(on(() => props.value, value => {
    if (!value) return;
    setFocused(value);
    setMonth(noon(value));
  }, { defer: true }));
  const visibleMonth = createMemo(() => {
    const value = month();
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-01`;
  });
  createEffect(() => { props.onMonthChange?.(visibleMonth()); });
  const cells = createMemo(() => {
    const value = month();
    const first = new Date(value.getFullYear(), value.getMonth(), 1, 12);
    // Weeks start on Monday, as in the Week view.
    const start = new Date(first); start.setDate(1 - (first.getDay() + 6) % 7);
    return Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day; });
  });
  const showMonth = (amount: number) => setMonth(value => new Date(value.getFullYear(), value.getMonth() + amount, 1, 12));
  const keydown = (event: KeyboardEvent) => {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    const months = event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : 0;
    if (!step && !months) return;
    event.preventDefault();
    const next = noon(focused());
    if (step) next.setDate(next.getDate() + step);
    else next.setMonth(next.getMonth() + months);
    setFocused(localDate(next));
    if (next.getMonth() !== month().getMonth() || next.getFullYear() !== month().getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1, 12));
    queueMicrotask(() => grid.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
  };
  return <div class="month-grid">
    <div class="month-grid-header">
      <Button icon="left" label="Previous month" disabled={props.disabled} onClick={() => showMonth(-1)} />
      <strong>{month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
      <Button icon="right" label="Next month" disabled={props.disabled} onClick={() => showMonth(1)} />
    </div>
    <div ref={grid} class="month-grid-days" role="group" aria-label={month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} aria-busy={props.planningLoading} onKeyDown={keydown}>
      <For each={['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']}>{day => <span class="month-grid-weekday" aria-hidden="true">{day}</span>}</For>
      <For each={cells()}>{day => {
        const date = localDate(day);
        const planning = createMemo(() => props.planningMarks?.[date]);
        const label = createMemo(() => {
          const related = props.marks?.[date];
          const counts = planningCountLabel(planning());
          return related && counts ? `${related} · ${counts}` : related || counts;
        });
        return <button type="button" class="month-grid-day"
          classList={{ 'month-grid-outside': day.getMonth() !== month().getMonth(), selected: date === props.value }}
          tabIndex={date === focused() ? 0 : -1} disabled={props.disabled}
          aria-label={`${day.toLocaleDateString(undefined, { dateStyle: 'full' })}${label() ? `, ${label()}` : ''}`}
          aria-pressed={date === props.value} aria-current={date === props.today ? 'date' : undefined} title={label() || undefined}
          onFocus={() => setFocused(date)} onClick={() => props.onPick(date)}>
          {day.getDate()}<span class="month-grid-markers" aria-hidden="true">
            <Show when={planning()?.scheduled}><span class="month-grid-scheduled" /></Show>
            <Show when={planning()?.deadline}><span class="month-grid-deadline" /></Show>
            <Show when={props.marks?.[date]}><span class="month-grid-mark" /></Show>
          </span>
        </button>;
      }}</For>
    </div>
    <Show when={props.planningMarks}>
      <div class="month-grid-planning-key" role="status" title={props.planningError || undefined}>
        <Show when={!props.planningError} fallback={<span class="error">Planning counts unavailable</span>}>
          <span class="month-grid-key-item"><span class="month-grid-scheduled" aria-hidden="true" />Scheduled</span>
          <span class="month-grid-key-item"><span class="month-grid-deadline" aria-hidden="true" />Deadlines</span>
          <span class="visually-hidden">{props.planningLoading ? 'Loading planning counts' : ''}</span>
        </Show>
      </div>
    </Show>
  </div>;
}
