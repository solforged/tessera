import { For, Index, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import type { TaskRow } from '../api/types';
import { Button } from '../ui/Button';
import { stripDays } from './task-labels';
import type { StripDay } from './task-labels';
import { shiftCalendarDate } from './week-calendar';

/** Dots beyond this become a count beside them. */
const maxDots = 6;

type Dot = 'overdue' | 'warning' | 'open';
interface StripDayModel { date: string | null; weekday: string; numeral: number | string; count: StripDay; dots: Dot[] }

/** `phone` keeps open work as plain dots and marks every unfinished plan on a past day overdue; the rainbow stays on the desktop. */
function stripModels(dates: readonly (string | null)[], rows: readonly TaskRow[], today: string, overdueToday: number, phone: boolean): StripDayModel[] {
  const counts = stripDays(rows, today, phone ? 0 : overdueToday);
  return dates.map(date => {
    const day = date ? new Date(`${date}T12:00:00Z`) : null;
    const weekday = day?.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) ?? '';
    const numeral = day?.getUTCDate() ?? '';
    const found = date ? counts.get(date) ?? { open: 0, overdue: 0, warning: 0 } : { open: 0, overdue: 0, warning: 0 };
    const count = phone && date && date < today ? { open: found.open, overdue: found.open, warning: 0 } : phone ? { ...found, warning: 0 } : found;
    // Overdue dots lead, then deadline warnings, then the rest, all within the first six.
    const dots = Array.from({ length: Math.min(count.open, maxDots) }, (_, index): Dot => index < count.overdue ? 'overdue' : index < count.overdue + count.warning ? 'warning' : 'open');
    return { date, weekday, numeral, count, dots };
  });
}

const dayLabel = (day: StripDayModel, loading: boolean) => `${day.weekday} ${day.numeral}, ${loading ? 'loading tasks'
  : [`${day.count.open} open`, day.count.overdue ? `${day.count.overdue} overdue` : '', day.count.warning ? `${day.count.warning} due soon` : ''].filter(Boolean).join(' · ')}`;

function DayButton(props: { day: StripDayModel; date: string; today: string; loading: boolean; disabled?: boolean; onSelect(date: string): void }) {
  return <Button class={`agenda-week-day${props.today === props.day.date ? ' agenda-week-today' : ''}${props.day.date && props.day.date < props.today ? ' agenda-week-past' : ''}`} aria-current={props.date === props.day.date ? 'date' : undefined} label={dayLabel(props.day, props.loading)} disabled={props.disabled || !props.day.date} onClick={() => { if (props.day.date) props.onSelect(props.day.date); }}>
    <span class="agenda-day-weekday">{props.day.weekday}</span>
    <span class="agenda-day-numeral">{props.day.numeral}</span>
    <span class="agenda-day-dots" aria-hidden="true">
      <Show when={!props.loading}>
        <For each={props.day.dots}>{dot => <span class={`agenda-day-dot agenda-day-dot-${dot}`} />}</For>
        <Show when={props.day.count.open > maxDots}><span class="agenda-day-more">{props.day.count.open}</span></Show>
      </Show>
    </span>
  </Button>;
}

/** Seven ruled civil days, one dot per open task; each deduplicates a task's coincident schedule and deadline. */
export function AgendaWeekStrip(props: { dates: readonly (string | null)[]; date: string; today: string; rows: readonly TaskRow[]; overdueToday?: number; loading: boolean; disabled?: boolean; onSelect(date: string): void }) {
  const days = createMemo(() => stripModels(props.dates, props.rows, props.today, props.overdueToday ?? 0, false));
  return <nav class="agenda-week-strip" aria-label="Week days" aria-busy={props.loading}>
    <For each={days()}>{day => <DayButton day={day} date={props.date} today={props.today} loading={props.loading} disabled={props.disabled} onSelect={props.onSelect} />}</For>
  </nav>;
}

/**
 * The phone's day strip: one Monday-to-Sunday week at a time, swiped like pages. The chosen day is a lit pill; open work
 * is one dot per task, red once its day has passed. Three weeks are kept (the one shown and its neighbours); landing on a
 * neighbour makes it the shown week and slides the pages back under the finger so the strip never runs out.
 */
export function AgendaDayStrip(props: { start: string; date: string; today: string; rows: readonly TaskRow[]; loading: boolean; disabled?: boolean; onSelect(date: string): void; onWeek(start: string): void }) {
  const starts = createMemo(() => [shiftCalendarDate(props.start, -7), props.start, shiftCalendarDate(props.start, 7)]);
  let pager!: HTMLElement;
  const centre = () => { pager.scrollLeft = pager.clientWidth; };
  const shown = () => Math.round(pager.scrollLeft / pager.clientWidth);
  let touching = false, timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (touching) return;
    const start = starts()[shown()];
    if (start && start !== props.start) props.onWeek(start);
    // The pages re-render for the new week in this task, so the strip is centred before it paints.
    centre();
  };
  // Where the browser says when a scroll has ended it is trusted; otherwise a quiet moment after the last scroll event is.
  const hasScrollEnd = 'onscrollend' in window;
  const scrolled = () => { if (!hasScrollEnd) { clearTimeout(timer); timer = setTimeout(settle, 110); } };
  onMount(() => {
    centre();
    if (hasScrollEnd) pager.addEventListener('scrollend', settle);
    onCleanup(() => { clearTimeout(timer); pager.removeEventListener('scrollend', settle); });
  });
  // A week chosen elsewhere (the Today button, the date sheet) comes back to the middle page without a glide.
  createEffect(on(() => props.start, () => queueMicrotask(() => { if (pager.isConnected && shown() !== 1 && !touching) centre(); }), { defer: true }));
  const release = () => { touching = false; scrolled(); };
  return <nav ref={pager} class="agenda-strip-pager" aria-label="Week days" aria-busy={props.loading} onScroll={scrolled} onTouchStart={() => { touching = true; }} onTouchEnd={release} onTouchCancel={release}>
    <Index each={starts()}>{(start, page) => {
      const days = createMemo(() => stripModels(Array.from({ length: 7 }, (_, index) => { const first = start(); return first ? shiftCalendarDate(first, index) : null; }), props.rows, props.today, 0, true));
      return <div class="agenda-strip-week" role="group" inert={page !== 1}>
        <For each={days()}>{day => <DayButton day={day} date={props.date} today={props.today} loading={props.loading} disabled={props.disabled} onSelect={props.onSelect} />}</For>
      </div>;
    }}</Index>
  </nav>;
}
