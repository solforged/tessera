import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { planningCountLabel } from '../tasks/planning-marks';
import type { PlanningMarks } from '../tasks/planning-marks';
import { Button } from './Button';
import type { DayCounts } from '../tasks/month-day-counts';
import { inMonth } from './month-day';
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
  /** Open and overdue tasks per day (tasks/month-day-counts.ts): a phone prints the figure under the day and sums the month below. */
  dayCounts?: DayCounts;
  /** The first civil date of the visible month, including keyboard navigation. */
  onMonthChange?(month: string): void;
  disabled?: boolean;
  onPick(date: string): void;
}

/** A month of days with arrow-key movement; Enter or click picks the focused day. */
export function MonthGrid(props: MonthGridProps) {
  const [focused, setFocused] = createSignal(props.value ?? props.today);
  const [month, setMonth] = createSignal(noon(focused()));
  // The day the reader means to be on, so stepping through a short month and on does not leave the 31st behind.
  let wantedDay = noon(focused()).getDate();
  let grid!: HTMLDivElement;
  createEffect(on(() => props.value, value => {
    if (!value) return;
    wantedDay = noon(value).getDate();
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
  // The week being read sits on a soft band, on a phone: its row among the visible weeks, when the chosen day is in them.
  const bandRow = createMemo(() => {
    const index = cells().findIndex(day => localDate(day) === props.value);
    return index < 0 ? null : Math.floor(index / 7);
  });
  // A month that ends before its sixth row leaves that row entirely in the next month; a phone drops it.
  const spill = createMemo(() => cells()[35]!.getMonth() !== month().getMonth());
  const monthTotals = createMemo(() => {
    const totals = { open: 0, overdue: 0 };
    for (const day of cells()) {
      if (day.getMonth() !== month().getMonth()) continue;
      const count = props.dayCounts?.[localDate(day)];
      if (count) { totals.open += count.open; totals.overdue += count.overdue; }
    }
    return totals;
  });
  // Changing month moves the day that holds the grid's one tab stop into the month shown, or Tab could not enter the grid.
  const showMonth = (amount: number) => {
    const next = inMonth(month(), amount, wantedDay);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1, 12));
    setFocused(localDate(next));
  };
  const keydown = (event: KeyboardEvent) => {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    const months = event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : 0;
    if (!step && !months) return;
    event.preventDefault();
    let next = noon(focused());
    if (step) { next.setDate(next.getDate() + step); wantedDay = next.getDate(); }
    else next = inMonth(next, months, wantedDay);
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
      <For each={[['Mo', 'Mon'], ['Tu', 'Tue'], ['We', 'Wed'], ['Th', 'Thu'], ['Fr', 'Fri'], ['Sa', 'Sat'], ['Su', 'Sun']]}>{([short, long]) => <span class="month-grid-weekday" aria-hidden="true"><span class="month-grid-weekday-short">{short}</span><span class="month-grid-weekday-long">{long}</span></span>}</For>
      <Show when={bandRow() !== null}><span class="month-grid-week" style={{ 'grid-row': String((bandRow() ?? 0) + 2) }} aria-hidden="true" /></Show>
      <For each={cells()}>{(day, position) => {
        const date = localDate(day);
        const planning = createMemo(() => props.planningMarks?.[date]);
        const count = createMemo(() => props.dayCounts?.[date]);
        const label = createMemo(() => {
          const figure = count() ? `${count()!.overdue || count()!.open} ${count()!.overdue ? 'overdue' : 'open'}` : '';
          return [props.marks?.[date], planningCountLabel(planning()), figure].filter(Boolean).join(' · ');
        });
        return <button type="button" class="month-grid-day"
          classList={{ 'month-grid-outside': day.getMonth() !== month().getMonth(), 'month-grid-spill': position() >= 35 && spill(), selected: date === props.value }}
          tabIndex={date === focused() ? 0 : -1} disabled={props.disabled}
          aria-label={`${day.toLocaleDateString(undefined, { dateStyle: 'full' })}${label() ? `, ${label()}` : ''}`}
          aria-pressed={date === props.value} aria-current={date === props.today ? 'date' : undefined} title={label() || undefined}
          onFocus={() => { wantedDay = day.getDate(); setFocused(date); }} onClick={() => props.onPick(date)}>
          <span class="month-grid-numeral">{day.getDate()}</span><Show when={count()}>{value => <span class="month-grid-count" classList={{ 'month-grid-overdue': value().overdue > 0 }} aria-hidden="true">{value().overdue || value().open}</span>}</Show><span class="month-grid-markers" aria-hidden="true">
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
    <Show when={props.dayCounts}>
      <div class="month-grid-summary" role="status" aria-busy={props.planningLoading} title={props.planningError || undefined}>
        <Show when={!props.planningError} fallback="Task counts unavailable">
          <Show when={monthTotals().overdue}><span class="month-grid-overdue"><span class="month-grid-figure">{monthTotals().overdue}</span> overdue</span></Show>
          <Show when={monthTotals().overdue && monthTotals().open}><span aria-hidden="true">·</span></Show>
          <Show when={monthTotals().open}><span><span class="month-grid-figure">{monthTotals().open}</span> open</span></Show>
          <Show when={!monthTotals().overdue && !monthTotals().open && !props.planningLoading}>Nothing open this month</Show>
        </Show>
      </div>
    </Show>
  </div>;
}
