import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
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
  const cells = createMemo(() => {
    const value = month();
    const first = new Date(value.getFullYear(), value.getMonth(), 1, 12);
    const start = new Date(first); start.setDate(1 - first.getDay());
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
    <div ref={grid} class="month-grid-days" role="group" aria-label={month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} onKeyDown={keydown}>
      <For each={['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']}>{day => <span class="month-grid-weekday" aria-hidden="true">{day}</span>}</For>
      <For each={cells()}>{day => {
        const date = localDate(day);
        const mark = () => props.marks?.[date];
        return <button type="button" class="month-grid-day"
          classList={{ 'month-grid-outside': day.getMonth() !== month().getMonth(), selected: date === props.value }}
          tabIndex={date === focused() ? 0 : -1} disabled={props.disabled}
          aria-label={`${day.toLocaleDateString(undefined, { dateStyle: 'full' })}${mark() ? `, ${mark()}` : ''}`}
          aria-pressed={date === props.value} aria-current={date === props.today ? 'date' : undefined} title={mark()}
          onFocus={() => setFocused(date)} onClick={() => props.onPick(date)}>
          {day.getDate()}<Show when={mark()}><span class="month-grid-mark" aria-hidden="true" /></Show>
        </button>;
      }}</For>
    </div>
  </div>;
}
