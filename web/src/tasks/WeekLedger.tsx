import { For, Show, createMemo, createSignal } from 'solid-js';
import type { TaskRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Icon } from '../ui/Icon';
import { isPhone } from '../ui/phone';
import { TaskSourceRows } from './JournalAgenda';
import { createClock } from './clock';
import { spokenJournalDate } from './journal-date';
import { calendarWeekDates } from './week-calendar';
import { weekLedgerDays, weekLedgerOverdue, weekLedgerSummary } from './week-ledger';
import type { TaskSourceHistory } from './source-history';
import './week-ledger.css';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A phone day head's one summary, in a few words: `1 done`, `1 open` (danger once the day has passed), `3 tasks`. */
function DaySummary(props: { open: number; done: number; past: boolean; loading: boolean }) {
  return <span class="week-ledger-sum">
    <Show when={!props.loading} fallback="·">
      <Show when={props.open || props.done} fallback="Nothing planned">
        <Show when={props.done}><span class="week-ledger-done"><Icon name="check" />{props.done} done</span></Show>
        <Show when={props.open}><span classList={{ 'week-ledger-late': props.past }}>{props.past ? `${props.open} open` : plural(props.open, 'task')}</span></Show>
      </Show>
    </Show>
  </span>;
}

export function WeekLedger(props: {
  date: string;
  rows: readonly TaskRow[];
  /** Today's overdue agenda rows; the ledger keeps those planned before this week. */
  overdue: readonly TaskRow[];
  notebook: NotebookClient;
  history: TaskSourceHistory;
  loading: boolean;
  disabled: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const phone = isPhone();
  const clock = createClock(props.notebook);
  const overdue = createMemo(() => weekLedgerOverdue(props.overdue, props.date));
  const days = createMemo(() => weekLedgerDays(props.rows, props.date, props.notebook.todayDate(), overdue()));
  const dates = createMemo(() => calendarWeekDates(props.date).filter((day): day is string => day !== null));
  const byDate = createMemo(() => new Map(days().map(day => [day.date, day])));
  const summary = createMemo(() => weekLedgerSummary(props.rows, props.date, overdue()));
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  return <section class="week-ledger" data-task-rows aria-label="Week agenda" aria-busy={props.loading}>
    {/* A phone's week band above carries the figures. */}
    <Show when={!phone}><p class="week-ledger-summary">{summary()}</p></Show>
    <For each={dates()}>{date => {
      const day = createMemo(() => byDate().get(date)!);
      const civil = new Date(`${date}T12:00:00Z`);
      const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(civil);
      const today = () => props.notebook.todayDate();
      // Elsewhere only past days fold. On a phone every day but today folds to its head, which opens when it has tasks.
      const foldable = () => phone ? date !== today() && day().rows.length > 0 : date < today();
      const heading = phone
        ? <><span class="week-ledger-name"><span class="week-ledger-weekday">{weekday}</span><span class="week-ledger-numeral">{civil.getUTCDate()}</span></span><DaySummary open={day().open} done={day().done} past={date < today()} loading={props.loading} /></>
        : <><span class="agenda-day-weekday">{weekday}</span><span class="agenda-day-numeral">{civil.getUTCDate()}</span><span class="week-ledger-rule" /><span class="agenda-day-count">{props.loading ? '·' : date < today() ? `${day().done} done${day().open ? ` · ${day().open} open` : ''}` : day().rows.length ? day().open : 'Nothing planned'}</span></>;
      return <section class="week-ledger-day" classList={{ 'week-ledger-today': date === today(), 'week-ledger-past': date < today(), 'week-ledger-compact': !day().rows.length || foldable() && !expanded()[date] }} aria-label={spokenJournalDate(date)}>
        <h2><Show when={foldable()} fallback={<span class="week-ledger-heading">{heading}</span>}>
          <button type="button" class="week-ledger-heading week-ledger-toggle" aria-expanded={!!expanded()[date]} onClick={() => setExpanded(value => ({ ...value, [date]: !value[date] }))}>{heading}<Icon name={expanded()[date] ? 'down' : 'right'} /></button>
        </Show></h2>
        <Show when={!foldable() || expanded()[date]}>
          <TaskSourceRows rows={day().rows} date={date} notebook={props.notebook} history={props.history} timetable plan showNow={date === today() && !!day().rows.length} deadlineLabel now={date === today() ? clock() : undefined} disabled={props.disabled} onOpen={props.onOpen} onChanged={props.onChanged} />
        </Show>
      </section>;
    }}</For>
  </section>;
}
