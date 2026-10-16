import { For, Show, createMemo, createSignal } from 'solid-js';
import type { TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Icon } from '../ui/Icon';
import { TaskSourceRows } from './JournalAgenda';
import { createClock } from './clock';
import { spokenJournalDate } from './journal-date';
import { calendarWeekDates } from './week-calendar';
import { weekLedgerDays, weekLedgerSummary } from './week-ledger';
import type { TaskSourceHistory } from './source-history';
import './week-ledger.css';

export function WeekLedger(props: {
  date: string;
  rows: readonly TaskRow[];
  notebook: NotebookClient;
  history: TaskSourceHistory;
  loading: boolean;
  disabled: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const clock = createClock(props.notebook);
  const days = createMemo(() => weekLedgerDays(props.rows, props.date, props.notebook.todayDate(), clock()));
  const dates = createMemo(() => calendarWeekDates(props.date).filter((day): day is string => day !== null));
  const byDate = createMemo(() => new Map(days().map(day => [day.date, day])));
  const summary = createMemo(() => weekLedgerSummary(props.rows, props.date));
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  return <section class="week-ledger" data-task-rows aria-label="Week agenda" aria-busy={props.loading}>
    <p class="week-ledger-summary">{summary()}</p>
    <For each={dates()}>{date => {
      const day = createMemo(() => byDate().get(date)!);
      const civil = new Date(`${date}T12:00:00Z`);
      const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(civil);
      const heading = <><span class="agenda-day-weekday">{weekday}</span><span class="agenda-day-numeral">{civil.getUTCDate()}</span><span class="week-ledger-rule" /><span class="agenda-day-count">{props.loading ? '·' : date < props.notebook.todayDate() ? `${day().done} done${day().open ? ` · ${day().open} open` : ''}` : day().rows.length ? day().open : 'Nothing planned'}</span></>;
      return <section class="week-ledger-day" classList={{ 'week-ledger-today': date === props.notebook.todayDate(), 'week-ledger-compact': !day().rows.length || date < props.notebook.todayDate() && !expanded()[date] }} aria-label={spokenJournalDate(date)}>
        <h2><Show when={date < props.notebook.todayDate()} fallback={<span class="week-ledger-heading">{heading}</span>}>
          <button type="button" class="week-ledger-heading week-ledger-toggle" aria-expanded={!!expanded()[date]} onClick={() => setExpanded(value => ({ ...value, [date]: !value[date] }))}>{heading}<Icon name={expanded()[date] ? 'down' : 'right'} /></button>
        </Show></h2>
        <Show when={date >= props.notebook.todayDate() || expanded()[date]}>
          <TaskSourceRows rows={day().rows} date={date} notebook={props.notebook} history={props.history} timetable plan showNow={date === props.notebook.todayDate() && !!day().rows.length} deadlineLabel now={date === props.notebook.todayDate() ? clock() : undefined} disabled={props.disabled} onOpen={props.onOpen} onChanged={props.onChanged} />
        </Show>
      </section>;
    }}</For>
  </section>;
}
