import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { shiftCalendarDate } from './week-calendar';
import { Figures } from './Figures';
import { journalDayLabel, journalISOWeek, journalMonthGrid, journalMonthLabel, journalQuarter, journalWeekDays, journalYearMonths, spokenJournalDate } from './journal-date';
import { createPhone, installDaySwipe } from './journal-phone';

type Period = 'year' | 'quarter' | 'month' | 'week';
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** `October 5–11`, or `September 28 – October 4` across a month boundary. */
function weekRange(days: string[]) {
  const first = days[0]!, last = days[days.length - 1]!;
  const day = (date: string) => Number(date.slice(8));
  return first.slice(0, 7) === last.slice(0, 7)
    ? `${journalMonthLabel(first)} ${day(first)}–${day(last)}`
    : `${journalMonthLabel(first)} ${day(first)} – ${journalMonthLabel(last)} ${day(last)}`;
}

export function JournalTrail(props: { date: string; today?: boolean; journalPeriod?: Period; notebook: NotebookClient; onSelect(date: string): Promise<void> }) {
  const [ledger, setLedger] = createSignal<{ kind: Period; date: string } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const coarse = matchMedia('(pointer: coarse)');
  const [touch, setTouch] = createSignal(coarse.matches);
  const changePointer = () => setTouch(coarse.matches);
  coarse.addEventListener('change', changePointer);
  onCleanup(() => coarse.removeEventListener('change', changePointer));
  const id = createUniqueId();
  const triggers = new Map<Period, HTMLButtonElement>();
  const [written, setWritten] = createSignal<ReadonlySet<string>>(new Set());
  const [writtenError, setWrittenError] = createSignal('');
  createEffect(() => {
    const open = ledger();
    props.notebook.changeSequence();
    if (!open) { setWritten(new Set<string>()); setWrittenError(''); return; }
    const dates = open.kind === 'week' ? journalWeekDays(open.date)
      : (open.kind === 'year' ? journalYearMonths(open.date) : open.kind === 'quarter' ? journalQuarter(open.date).months : [open.date])
        .flatMap(date => journalMonthGrid(date).flatMap(row => row.days.filter((day): day is string => day !== null)));
    const controller = new AbortController();
    setWrittenError('');
    void props.notebook.api.writtenJournalDates(dates[0]!, dates[dates.length - 1]!, controller.signal)
      .then(value => { if (!controller.signal.aborted) setWritten(new Set(value)); })
      .catch(reason => { if (!controller.signal.aborted) setWrittenError(`Could not load written days: ${reason instanceof Error ? reason.message : String(reason)}`); });
    onCleanup(() => controller.abort());
  });
  // The trail names the period being inspected: drilling into another week or month moves its labels with the ledger.
  const focus = () => ledger()?.date ?? props.date;
  const quarter = createMemo(() => journalQuarter(focus()));
  const week = createMemo(() => journalISOWeek(focus()));
  // The trail runs from the nearest period outward: week, month, then year; the quarter shows only while its ledger is open.
  // A phone leaves the month to the title and the day picker, so it joins the trail only while its ledger is open.
  const phone = createPhone();
  const segments = createMemo(() => [
    { kind: 'week' as const, label: `Week ${week().week}`, name: `Week ${week().week}, ${week().year}` },
    ...(!phone() || ledger()?.kind === 'month' ? [{ kind: 'month' as const, label: journalMonthLabel(focus()), name: journalMonthLabel(focus()) }] : []),
    ...(ledger()?.kind === 'quarter' ? [{ kind: 'quarter' as const, label: `Q${quarter().quarter}`, name: `Quarter ${quarter().quarter}` }] : []),
    { kind: 'year' as const, label: focus().slice(0, 4), name: focus().slice(0, 4) },
  ]);
  const step = (days: number) => { const date = shiftCalendarDate(props.date, days); if (date) void select(date); };
  // On a phone the title block alone changes the day by swiping, so task rows below keep their own swipes.
  let titleBlock: HTMLDivElement | undefined;
  createEffect(() => {
    if (!phone() || !titleBlock) return;
    onCleanup(installDaySwipe(titleBlock, step));
  });
  let ledgerElement: HTMLDivElement | undefined;
  /** Opening a finer period from inside a ledger lands on it, rather than leaving the page scrolled past a shorter ledger. */
  function drill(kind: Period, date: string) {
    setLedger({ kind, date });
    requestAnimationFrame(() => ledgerElement?.scrollIntoView({ block: 'nearest' }));
  }
  createEffect(() => { const date = props.date, kind = props.journalPeriod; setLedger(kind ? { kind, date } : null); setError(''); });
  createEffect(() => {
    const open = ledger();
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.popup')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setLedger(null); triggers.get(open.kind)?.focus();
    };
    window.addEventListener('keydown', escape, true);
    onCleanup(() => window.removeEventListener('keydown', escape, true));
  });
  async function select(date: string) {
    if (busy()) return;
    setBusy(true); setError('');
    try { await props.onSelect(date); setLedger(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function Day(propsDay: { date: string; weekday?: string }) {
    return <Button class={`journal-ledger-day${written().has(propsDay.date) ? ' journal-day-written' : ''}${propsDay.date === props.date ? ' journal-day-current' : ''}`} disabled={busy()}
      aria-current={propsDay.date === props.notebook.todayDate() ? 'date' : undefined} aria-pressed={propsDay.date === props.date}
      label={`${journalDayLabel(propsDay.date)}${written().has(propsDay.date) ? ', journal written' : ''}`} onClick={() => { void select(propsDay.date); }}>
      <Show when={propsDay.weekday}><span class="journal-ledger-weekday">{propsDay.weekday}</span></Show>
      <span class="journal-day-numeral">{Number(propsDay.date.slice(8))}</span><span class="journal-day-mark" aria-hidden="true" />
    </Button>;
  }
  function Month(propsMonth: { date: string; mini?: boolean }) {
    const weeks = createMemo(() => journalMonthGrid(propsMonth.date));
    return <section class="journal-ledger-month" aria-label={`${journalMonthLabel(propsMonth.date)} ${propsMonth.date.slice(0, 4)}`}>
      <h2>{journalMonthLabel(propsMonth.date)} <span>{propsMonth.date.slice(0, 4)}</span></h2>
      <div class="journal-month-grid" classList={{ 'journal-mini-grid': !!propsMonth.mini }}>
        <Show when={!propsMonth.mini}><span class="journal-ledger-weekday" aria-hidden="true">Wk</span></Show>
        <For each={weekdays}>{weekday => <span class="journal-ledger-weekday" aria-hidden="true">{weekday.slice(0, 2)}</span>}</For>
        <For each={weeks()}>{row => <>
          <Show when={!propsMonth.mini}><Button class="journal-week-number" disabled={busy()} label={`Open week ${row.week}, ${row.year}`} onClick={() => drill('week', row.monday)}>{row.week}</Button></Show>
          <For each={row.days}>{date => <Show when={date} fallback={<span class="journal-day-empty" />}>{value => <Day date={value()} />}</Show>}</For>
        </>}</For>
      </div>
    </section>;
  }
  function MiniMonth(propsMonth: { date: string }) {
    const weeks = createMemo(() => journalMonthGrid(propsMonth.date));
    return <Show when={touch()} fallback={<Month date={propsMonth.date} mini />}>
      <Button class="journal-month-overview" disabled={busy()} label={`Open ${journalMonthLabel(propsMonth.date)} ${propsMonth.date.slice(0, 4)}`} onClick={() => drill('month', propsMonth.date)}>
        <span class="journal-overview-title">{journalMonthLabel(propsMonth.date)}</span>
        <span class="journal-mini-grid" aria-hidden="true">
          <For each={weekdays}>{weekday => <span class="journal-ledger-weekday">{weekday.slice(0, 2)}</span>}</For>
          <For each={weeks()}>{row => <For each={row.days}>{date => <span class="journal-overview-day" classList={{ 'journal-day-written': !!date && written().has(date), 'journal-day-current': date === props.date, 'journal-day-today': date === props.notebook.todayDate() }}>
            {date ? Number(date.slice(8)) : ''}<span class="journal-day-mark" />
          </span>}</For>}</For>
        </span>
      </Button>
    </Show>;
  }
  return <>
    <div class="journal-title-block" ref={titleBlock}>
    <nav class="journal-trail" aria-label="Journal periods"><Show when={props.today}><span class="journal-trail-today">Today</span><span class="journal-trail-separator" aria-hidden="true">·</span></Show><For each={segments()}>{(segment, index) => <>
      <Show when={index() > 0}><span class="journal-trail-separator" aria-hidden="true">·</span></Show>
      <Button ref={element => triggers.set(segment.kind, element)} class="journal-trail-segment" aria-expanded={ledger()?.kind === segment.kind} aria-controls={id}
        label={`${segment.name} journal ledger`} onClick={() => setLedger(value => value?.kind === segment.kind ? null : { kind: segment.kind, date: value?.date ?? props.date })}><Figures text={segment.label} /></Button>
    </>}</For></nav>
    <div class="journal-title-row">
      <h1>{spokenJournalDate(props.date)}</h1>
      <Show when={!phone()}><div class="journal-day-stepper" role="group" aria-label="Journal day">
        <Button icon="left" label="Previous day" disabled={busy()} onClick={() => step(-1)} />
        <Button icon="calendar" label="Month ledger" aria-expanded={ledger()?.kind === 'month'} aria-controls={id} onClick={() => setLedger(value => value?.kind === 'month' ? null : { kind: 'month', date: props.date })} />
        <Button icon="right" label="Next day" disabled={busy()} onClick={() => step(1)} />
      </div></Show>
    </div>
    </div>
    <Show when={ledger()}>{open => <div ref={ledgerElement} id={id} class="journal-ledger" aria-label={`${open().kind} journal ledger`} aria-busy={busy()}>
      <Show when={open().kind === 'week'}><section class="journal-ledger-month" aria-label={`Week ${week().week}, ${week().year}`}>
        <h2>Week {week().week} <span>{weekRange(journalWeekDays(open().date))}</span></h2>
        <div class="journal-week-ledger"><For each={journalWeekDays(open().date)}>{(date, index) => <Day date={date} weekday={weekdays[index()]} />}</For></div>
      </section></Show>
      <Show when={open().kind === 'month'}><Month date={open().date} /></Show>
      <Show when={open().kind === 'quarter' || open().kind === 'year'}><div class="journal-mini-months" classList={{ 'journal-quarter-ledger': open().kind === 'quarter', 'journal-year-ledger': open().kind === 'year' }}>
        <For each={open().kind === 'quarter' ? journalQuarter(open().date).months : journalYearMonths(open().date)}>{date => <MiniMonth date={date} />}</For>
      </div></Show>
      <Show when={error()}><p class="journal-ledger-error" role="alert">{error()}</p></Show>
      <Show when={writtenError()}><p class="journal-ledger-error" role="alert">{writtenError()}</p></Show>
    </div>}</Show>
  </>;
}
