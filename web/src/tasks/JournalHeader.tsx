import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { Agenda, Citation, LibraryRow, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { SourceCover } from '../library/SourceCover';
import { BlockText } from '../outline/BlockText';
import { shortSourceTitle } from '../outline/source';
import { sectionLabel } from '../reader/openings';
import { timeLeft } from '../reader/paged';
import type { OpenTarget } from '../shell/contract';
import { agendaDaySummary } from '../shell/desk-counts';
import { opensBeside } from '../shell/beside';
import { BookMap } from '../ui/BookMap';
import { bookChapters, chapterAt } from '../ui/book-map';
import { Button } from '../ui/Button';
import { spokenJournalDate } from './journal-date';
import { JournalTrail } from './JournalTrail';
import { groupDayAgenda } from './task-labels';
import { createClock } from './clock';
import { TaskSourceRows } from './JournalAgenda';
import { movableTo } from './reschedule';
import { createBulkMove } from './BulkMove';
import { Icon } from '../ui/Icon';
import { createSettledChanges, sameData } from '../ui/loading';
import './agenda.css';
import '../library/library.css';

export function JournalHeader(props: { date: string; journalPeriod?: Extract<OpenTarget, { kind: 'page' }>['journalPeriod']; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const today = createMemo(() => props.date === props.notebook.todayDate());
  // Refetches return equal data for most edits; equality keeps the tiles, ledger rows and book map from re-rendering.
  const [desk, setDesk] = createSignal<{ agenda: Agenda; due: number } | undefined>(undefined, { equals: sameData });
  const [deskError, setDeskError] = createSignal('');
  const [reading, setReading] = createSignal<{ row: LibraryRow; source: SourceView; highlights: { at: number; color: Citation['color'] }[] } | null | undefined>(undefined, { equals: sameData });
  const readingChanges = createSettledChanges(props.notebook);
  const [readingError, setReadingError] = createSignal('');
  createEffect(() => {
    const date = props.date;
    if (!today()) return;
    props.notebook.changeSequence(); props.notebook.lastChange();
    const controller = new AbortController();
    setDeskError('');
    void Promise.all([
      props.notebook.api.agenda(date, controller.signal),
      props.notebook.api.cardQuery({ source: null, selection: 'due', limit: 1 }, controller.signal),
    ]).then(([agenda, cards]) => {
      if (!controller.signal.aborted) setDesk({ agenda, due: cards.total });
    }).catch(reason => {
      if (!controller.signal.aborted) setDeskError(reason instanceof Error ? reason.message : String(reason));
    });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    if (!today()) return;
    readingChanges();
    const controller = new AbortController();
    setReadingError('');
    void props.notebook.api.library({ states: ['reading'], format: 'epub', sort: 'last_read', direction: 'desc', limit: 1 }, controller.signal).then(async result => {
      const row = result.rows[0];
      if (!row || row.source.last_read_at === null || !row.source.current_snapshot_id) {
        if (!controller.signal.aborted) setReading(null);
        return;
      }
      const [source, highlights] = await Promise.all([
        props.notebook.api.source(row.page.id, controller.signal),
        props.notebook.api.highlights({ source_id: row.page.id, limit: null }, controller.signal),
      ]);
      const snapshotId = source.source.current_snapshot_id;
      const marks = highlights.rows.flatMap(highlight => highlight.citation.snapshot_id === snapshotId && highlight.citation.position !== undefined ? [{ at: highlight.citation.position, color: highlight.color }] : []);
      if (!controller.signal.aborted) setReading({ row, source, highlights: marks });
    }).catch(reason => {
      if (!controller.signal.aborted) setReadingError(reason instanceof Error ? reason.message : String(reason));
    });
    onCleanup(() => controller.abort());
  });
  const agendaSummary = createMemo(() => {
    const agenda = desk()?.agenda;
    if (!agenda) return null;
    const summary = agendaDaySummary(agenda.items, props.date);
    const items = summary.items;
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: props.notebook.settings()?.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const next = items.filter(item => item.time && item.time >= clock).sort((a, b) => a.time!.localeCompare(b.time!))[0] ?? items.find(item => !item.time);
    return { planned: summary.planned, overdue: summary.overdue, next };
  });
  const progress = createMemo(() => {
    const book = reading();
    if (!book) return null;
    const snapshot = book.source.snapshots.find(snapshot => snapshot.id === book.source.source.current_snapshot_id);
    const length = snapshot?.text_length ?? 0;
    const at = book.source.progress * length;
    const chapters = bookChapters(book.source.toc, length);
    const current = chapterAt(chapters, at);
    return { length, at, chapters, current };
  });
  // The Agenda tile opens today's tasks in place: checkable, reschedulable, with carried work folded to one line.
  const ledgerId = createUniqueId();
  const ledgerKey = 'tessera.today.ledger';
  const [ledger, setLedgerOpen] = createSignal(localStorage.getItem(ledgerKey) !== 'closed');
  const setLedger = (open: boolean) => {
    setLedgerOpen(open);
    try { localStorage.setItem(ledgerKey, open ? 'open' : 'closed'); } catch { /* The choice lasts for this page. */ }
  };
  const [carriedOpen, setCarriedOpen] = createSignal(false);
  const clock = createClock(props.notebook);
  const dayGroups = createMemo(() => { const agenda = desk()?.agenda; return agenda ? groupDayAgenda(agenda.items, [], props.date) : null; });
  // Tasks written in this journal already sit in the outline below with their plan, so the ledger lists only work from elsewhere.
  const ledgerRows = createMemo(() => {
    const planned = dayGroups()?.planned ?? [];
    const elsewhere = planned.filter(row => row.source.page.kind !== 'journal' || row.source.page.text !== props.date);
    return { elsewhere, below: planned.length - elsewhere.length };
  });
  // Every commit refreshes the desk, so the ledger needs no refresh of its own.
  const carried = createBulkMove(props.notebook, () => {});
  const Placeholder = () => <span class="journal-tile-placeholder" aria-hidden="true"><span /><span /></span>;
  return <section class="journal-header" aria-label={spokenJournalDate(props.date)}>
    <JournalTrail date={props.date} journalPeriod={props.journalPeriod} notebook={props.notebook} onSelect={async date => {
      const pageId = await props.notebook.journal(date);
      props.onOpen({ kind: 'page', pageId }, false);
    }} />
    <Show when={today()}>
      <div class="journal-tiles" aria-label="Today">
        <Button class="journal-tile journal-agenda-tile" aria-busy={!desk() && !deskError()} aria-expanded={ledger()} aria-controls={ledgerId} title={ledger() ? 'Hide today’s tasks' : 'Show today’s tasks'} onClick={() => setLedger(!ledger())}>
          <span class="journal-tile-heading"><span>Agenda</span><Icon name="down" class="journal-tile-chevron" /></span>
          <Show when={agendaSummary()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Agenda unavailable</span> : <Placeholder />}>{summary => <>
            <span class="journal-tile-count">{summary().planned}<small>today · <span classList={{ 'agenda-late': summary().overdue > 0 }}>{summary().overdue} overdue</span></small></span>
            <span class="journal-tile-meta"><Show when={summary().next} fallback={summary().planned ? 'Nothing else planned today' : 'Nothing planned today'}>{next => <>Next: <BlockText text={next().source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} />{next().time ? ` · ${next().time}` : ''}</>}</Show></span>
          </>}</Show>
        </Button>
        <Button class="journal-tile" aria-busy={!desk() && !deskError()} onClick={() => props.onOpen({ kind: 'review', start: true }, false)}>
          <span class="journal-tile-heading"><span>Review</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={desk()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Review unavailable</span> : <Placeholder />}>{counts => <span class="journal-tile-count">{counts().due}<small>due</small></span>}</Show>
        </Button>
        <Button class="journal-tile journal-reading-tile" aria-busy={reading() === undefined && !readingError()} onClick={event => {
          const book = reading();
          if (book) props.onOpen({ kind: 'reader', sourceId: book.row.page.id, snapshotId: book.source.source.current_snapshot_id ?? undefined }, opensBeside(event) || matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
          else props.onOpen({ kind: 'library', tab: 'reading' }, false);
        }}>
          <span class="journal-tile-heading"><span>Reading</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={reading()} fallback={reading() === undefined && !readingError() ? <Placeholder /> : <span class="journal-tile-meta journal-tile-unavailable">{readingError() ? 'Reading unavailable' : 'No book in progress'}</span>}>{book => <>
            <span class="journal-reading-book"><SourceCover row={book().row} siglum={book().row.source.siglum} /><span class="journal-reading-text"><span class="journal-reading-title" title={book().row.page.text}>{shortSourceTitle(book().row.page.text)}</span>
              <Show when={progress()?.length}><span class="journal-tile-meta">{progress()?.current?.chapter.title ? `${timeLeft(progress()!.current!.chapter.end - progress()!.at)} left` : `${timeLeft(progress()!.length - progress()!.at)} left in book`}</span><Show when={progress()?.current?.chapter.title}><span class="journal-tile-meta journal-reading-chapter">{sectionLabel(progress()!.current!.chapter.title)}</span></Show></Show>
            </span></span>
            <Show when={progress()?.length}><BookMap chapters={progress()!.chapters} length={progress()!.length} at={progress()!.at} highlights={book().highlights} /></Show>
          </>}</Show>
        </Button>
      </div>
      <Show when={deskError() || readingError()}><p class="agenda-error" role="alert">{[deskError(), readingError()].filter(Boolean).join(' · ')}</p></Show>
      <Show when={ledger() && dayGroups()}>{groups => <section id={ledgerId} class="today-ledger" data-task-rows aria-label="Today's tasks">
        <carried.Notice />
        <Show when={groups().overdue.length}>
          <div class="today-carried" classList={{ 'today-carried-collapsed': !carriedOpen() }}>
            <Button class="today-carried-toggle" aria-expanded={carriedOpen()} onClick={() => setCarriedOpen(value => !value)}><span class="agenda-late">{groups().overdue.length} carried over</span><Icon name="down" /></Button>
            <span class="section-rule" />
            <Show when={movableTo(groups().overdue, props.date).length}><Button class="today-carried-move" onClick={() => carried.move(groups().overdue, props.date)}>Move to today</Button></Show>
          </div>
          <Show when={carriedOpen()}><TaskSourceRows rows={groups().overdue} date={props.date} notebook={props.notebook} timetable plan onOpen={props.onOpen} onChanged={() => {}} /></Show>
        </Show>
        <Show when={groups().overdue.length && (ledgerRows().elsewhere.length || ledgerRows().below)}>
          <h2 class="agenda-section-heading"><span>Today</span><span class="section-rule" /><span class="agenda-summary">{ledgerRows().elsewhere.length + ledgerRows().below}</span></h2>
        </Show>
        <Show when={ledgerRows().elsewhere.length} fallback={<Show when={ledgerRows().below}><p class="agenda-message">{ledgerRows().below} planned in the journal below</p></Show>}>
          <TaskSourceRows rows={ledgerRows().elsewhere} date={props.date} notebook={props.notebook} timetable plan now={clock()} onOpen={props.onOpen} onChanged={() => {}} />
          <Show when={ledgerRows().below}><p class="agenda-message agenda-day-empty">{ledgerRows().below} more in the journal below</p></Show>
        </Show>
        <Button class="today-ledger-open" onClick={event => props.onOpen({ kind: 'agenda', date: props.date }, opensBeside(event))}>Open agenda<span aria-hidden="true">›</span></Button>
      </section>}</Show>
    </Show>
    <h2 class="journal-writing-heading"><span>Journal</span></h2>
  </section>;
}
