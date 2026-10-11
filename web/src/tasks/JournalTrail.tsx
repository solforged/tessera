import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { journalDayLabel, journalISOWeek, journalMonthGrid, journalMonthLabel, journalQuarter, journalWeekDays, journalYearMonths, spokenJournalDate } from './journal-date';

type Period = 'year' | 'quarter' | 'month' | 'week';
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function JournalTrail(props: { date: string; notebook: NotebookClient; onSelect(date: string): Promise<void> }) {
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
  const written = createMemo(() => new Set(props.notebook.roots().filter(root => root.kind === 'journal').map(root => root.text)));
  const quarter = createMemo(() => journalQuarter(props.date));
  const week = createMemo(() => journalISOWeek(props.date));
  const segments = createMemo(() => [
    { kind: 'year' as const, label: props.date.slice(0, 4) },
    { kind: 'quarter' as const, label: `Q${quarter().quarter}` },
    { kind: 'month' as const, label: journalMonthLabel(props.date) },
    { kind: 'week' as const, label: `Week ${week().week}` },
  ]);
  createEffect(() => { props.date; setLedger(null); setError(''); });
  createEffect(() => {
    const open = ledger();
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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
          <Show when={!propsMonth.mini}><Button class="journal-week-number" disabled={busy()} label={`Open week ${row.week}, ${row.year}`} onClick={() => setLedger({ kind: 'week', date: row.monday })}>{row.week}</Button></Show>
          <For each={row.days}>{date => <Show when={date} fallback={<span class="journal-day-empty" />}>{value => <Day date={value()} />}</Show>}</For>
        </>}</For>
      </div>
    </section>;
  }
  function MiniMonth(propsMonth: { date: string }) {
    const weeks = createMemo(() => journalMonthGrid(propsMonth.date));
    return <Show when={touch()} fallback={<Month date={propsMonth.date} mini />}>
      <Button class="journal-month-overview" disabled={busy()} label={`Open ${journalMonthLabel(propsMonth.date)} ${propsMonth.date.slice(0, 4)}`} onClick={() => setLedger({ kind: 'month', date: propsMonth.date })}>
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
    <nav class="journal-trail" aria-label="Journal periods"><For each={segments()}>{(segment, index) => <>
      <Show when={index() > 0}><span class="journal-trail-separator" aria-hidden="true">·</span></Show>
      <Button ref={element => triggers.set(segment.kind, element)} class="journal-trail-segment" aria-expanded={ledger()?.kind === segment.kind} aria-controls={id}
        label={`${segment.label}${segment.kind === 'week' ? `, ${week().year}` : ''} journal ledger`} onClick={() => setLedger(value => value?.kind === segment.kind ? null : { kind: segment.kind, date: props.date })}>{segment.label}</Button>
    </>}</For></nav>
    <h1>{spokenJournalDate(props.date)}</h1>
    <Show when={ledger()}>{open => <div id={id} class="journal-ledger" aria-label={`${open().kind} journal ledger`} aria-busy={busy()}>
      <Show when={open().kind === 'week'}><div class="journal-week-ledger"><For each={journalWeekDays(open().date)}>{(date, index) => <Day date={date} weekday={weekdays[index()]} />}</For></div></Show>
      <Show when={open().kind === 'month'}><Month date={open().date} /></Show>
      <Show when={open().kind === 'quarter' || open().kind === 'year'}><div class="journal-mini-months" classList={{ 'journal-quarter-ledger': open().kind === 'quarter', 'journal-year-ledger': open().kind === 'year' }}>
        <For each={open().kind === 'quarter' ? journalQuarter(open().date).months : journalYearMonths(open().date)}>{date => <MiniMonth date={date} />}</For>
      </div></Show>
      <Show when={error()}><p class="journal-ledger-error" role="alert">{error()}</p></Show>
    </div>}</Show>
  </>;
}
