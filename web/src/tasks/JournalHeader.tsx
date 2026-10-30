import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
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
import { Icon } from '../ui/Icon';
import { ListGroup, ListRow } from '../ui/List';
import { spokenJournalDate } from './journal-date';
import { JournalTrail } from './JournalTrail';
import { Figures } from './Figures';
import { createPhone } from './journal-phone';
import { agendaTaskTime, groupDayAgenda } from './task-labels';
import { createClock } from './clock';
import { TaskSourceRows } from './JournalAgenda';
import { movableTo } from './reschedule';
import { createBulkMove } from './BulkMove';
import { SectionHead } from '../ui/SectionHead';
import { section } from './today-template';
import { createSettledChanges, sameData } from '../ui/loading';
import './agenda.css';
import './journal-phone.css';
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
  const clock = createClock(props.notebook);
  const dayGroups = createMemo(() => { const agenda = desk()?.agenda; return agenda ? groupDayAgenda(agenda.items, [], props.date) : null; });
  // Every commit refreshes the desk, so Plan needs no refresh of its own.
  const carried = createBulkMove(props.notebook, () => {});
  const tiles = () => props.notebook.todayTemplate().tiles;
  const plan = () => section(props.notebook.todayTemplate(), 'plan');
  const Placeholder = () => <span class="journal-tile-placeholder" aria-hidden="true"><span /><span /></span>;
  const phone = createPhone();
  const openReading = (event: MouseEvent) => {
    const book = reading();
    if (book) props.onOpen({ kind: 'reader', sourceId: book.row.page.id, snapshotId: book.source.source.current_snapshot_id ?? undefined }, opensBeside(event) || matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
    else props.onOpen({ kind: 'library', tab: 'reading' }, false);
  };
  const timeRemaining = createMemo(() => {
    const book = progress();
    if (!book?.length) return '';
    return book.current?.chapter.title ? `${timeLeft(book.current.chapter.end - book.at)} left` : `${timeLeft(book.length - book.at)} left in book`;
  });
  const readingLead = createMemo(() => { const book = reading(); return book ? <SourceCover row={book.row} siglum={book.row.source.siglum} /> : <Icon name="library" />; });
  return <section class="journal-header" aria-label={spokenJournalDate(props.date)}>
    <JournalTrail date={props.date} today={today()} journalPeriod={props.journalPeriod} notebook={props.notebook} onSelect={async date => {
      const pageId = await props.notebook.journal(date);
      props.onOpen({ kind: 'page', pageId }, false);
    }} />
    <Show when={today()}>
      {/* Each tile is one button to its destination; Plan below holds today's tasks. */}
      <Show when={!phone() && (tiles().agenda || tiles().review || tiles().reading)}><div class="journal-tiles" aria-label="Today" style={{ '--journal-tiles': [tiles().agenda, tiles().review, tiles().reading].filter(Boolean).length }}>
        <Show when={tiles().agenda}><Button class="journal-tile" aria-busy={!desk() && !deskError()} onClick={event => props.onOpen({ kind: 'agenda', date: props.date }, opensBeside(event))}>
          <span class="journal-tile-heading"><span>Agenda</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={agendaSummary()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Agenda unavailable</span> : <Placeholder />}>{summary => <>
            <span class="journal-tile-count">{summary().planned}<small>today<Show when={summary().overdue}> · <span class="agenda-late">{summary().overdue} carried</span></Show></small></span>
            <span class="journal-tile-meta"><Show when={summary().next} fallback={summary().planned ? 'Nothing else planned today' : 'Nothing planned today'}>{next => <><Show when={next().time}><span class="journal-tile-clock">{next().time}</span> </Show><BlockText text={next().source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></>}</Show></span>
          </>}</Show>
        </Button></Show>
        <Show when={tiles().review}><Button class="journal-tile" aria-busy={!desk() && !deskError()} onClick={() => props.onOpen({ kind: 'review', start: true }, false)}>
          <span class="journal-tile-heading"><span>Review</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={desk()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Review unavailable</span> : <Placeholder />}>{counts => <>
            <span class="journal-tile-count">{counts().due}<small>due</small></span>
            <span class="journal-tile-meta">{counts().due ? 'Start the due queue' : 'All caught up'}</span>
          </>}</Show>
        </Button></Show>
        <Show when={tiles().reading}><Button class="journal-tile journal-reading-tile" aria-busy={reading() === undefined && !readingError()} onClick={openReading}>
          <span class="journal-tile-heading"><span>Reading</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={reading()} fallback={reading() === undefined && !readingError() ? <Placeholder /> : <span class="journal-tile-meta journal-tile-unavailable">{readingError() ? 'Reading unavailable' : 'No book in progress'}</span>}>{book => <>
            <span class="journal-reading-book"><SourceCover row={book().row} siglum={book().row.source.siglum} /><span class="journal-reading-text"><span class="journal-reading-title" title={book().row.page.text}>{shortSourceTitle(book().row.page.text)}</span>
              <Show when={progress()?.length}><span class="journal-tile-meta">{progress()?.current?.chapter.title ? `${timeLeft(progress()!.current!.chapter.end - progress()!.at)} left` : `${timeLeft(progress()!.length - progress()!.at)} left in book`}</span><Show when={progress()?.current?.chapter.title}><span class="journal-tile-meta journal-reading-chapter">{sectionLabel(progress()!.current!.chapter.title)}</span></Show></Show>
            </span></span>
            <Show when={progress()?.length}><BookMap chapters={progress()!.chapters} length={progress()!.length} at={progress()!.at} highlights={book().highlights} /></Show>
          </>}</Show>
        </Button></Show>
      </div></Show>
      {/* A phone says the two things on Today that are not tasks of the day: what to review and what to read. Plan below is the agenda. */}
      <Show when={phone() && (tiles().review || tiles().reading)}><ListGroup class="journal-digest">
        <Show when={tiles().review}><ListRow push lead={<Icon name="review" />} detail={desk() ? desk()!.due ? 'Start the due queue' : 'All caught up' : deskError() ? 'Unavailable' : undefined} onClick={() => props.onOpen({ kind: 'review', start: true }, false)}>
          <Show when={desk()} fallback="Review">{counts => <><span class="journal-fig">{counts().due}</span> due</>}</Show>
        </ListRow></Show>
        <Show when={tiles().reading}><ListRow push lead={readingLead()} name={reading() ? 'work' : undefined} onClick={openReading}
          detail={reading() ? <>Reading<Show when={timeRemaining()}> · <Figures text={timeRemaining()} /></Show></> : readingError() ? 'Unavailable' : reading() === null ? 'No book in progress' : undefined}>
          {reading() ? shortSourceTitle(reading()!.row.page.text) : 'Reading'}
        </ListRow></Show>
      </ListGroup></Show>
      <Show when={deskError() || readingError()}><p class="agenda-error" role="alert">{[deskError(), readingError()].filter(Boolean).join(' · ')}</p></Show>
      <Show when={plan()?.on && dayGroups()}>{groups => <JournalPlan name={plan()!.name} date={props.date} groups={groups()} now={clock()} notebook={props.notebook} carried={carried} onOpen={props.onOpen} />}</Show>
    </Show>
  </section>;
}

const planFoldKey = 'tessera.today.plan';

/** Today's generated Plan: carried work folded to one band, then today's rows from Agenda. */
function JournalPlan(props: { name: string; date: string; groups: ReturnType<typeof groupDayAgenda>; now: string; notebook: NotebookClient; carried: ReturnType<typeof createBulkMove>; onOpen(target: OpenTarget, beside: boolean): void }) {
  const id = createUniqueId();
  const phone = createPhone();
  const [open, setOpenSignal] = createSignal((() => { try { return localStorage.getItem(planFoldKey) !== 'closed'; } catch { return true; } })());
  const setOpen = (value: boolean) => {
    setOpenSignal(value);
    try { localStorage.setItem(planFoldKey, value ? 'open' : 'closed'); } catch { /* The choice lasts for this page. */ }
  };
  const [review, setReview] = createSignal(false);
  const empty = () => !props.groups.planned.length && !props.groups.overdue.length;
  const gutter = createMemo(() => [...props.groups.overdue, ...props.groups.planned].some(row => !!agendaTaskTime(row, props.date)));
  const movable = () => movableTo(props.groups.overdue, props.date).length > 0;
  /** A phone lists what was carried over in a few lines, each whole, and counts the rest. */
  const carriedShown = 3;
  return <section class="journal-plan" aria-label="Plan">
    {/* A phone's Plan is a plain head, "Plan  3 today": it does not fold, and the Agenda tab is the way to the rest. */}
    <Show when={phone()} fallback={<SectionHead name={props.name} count={empty() ? 'Nothing planned' : `${props.groups.planned.length} today`} open={open() && !empty()} controls={id} onToggle={empty() ? undefined : () => setOpen(!open())}>
      <Button class="bordered" onClick={event => props.onOpen({ kind: 'agenda', date: props.date }, opensBeside(event))}>Open agenda<span class="journal-plan-open" aria-hidden="true">›</span></Button>
    </SectionHead>}>
      <SectionHead name={props.name} count={empty() ? 'Nothing planned' : <Figures text={`${props.groups.planned.length} today`} />} />
    </Show>
    <Show when={(phone() || open()) && !empty()}><div id={id} class="journal-plan-body" data-task-rows>
      <props.carried.Notice />
      <Show when={props.groups.overdue.length}>
        <Show when={phone()} fallback={<div class="journal-carried">
          <span class="journal-carried-count">{props.groups.overdue.length} carried over</span>
          <span class="journal-carried-titles">{props.groups.overdue.map(row => row.source.block.text || 'Empty task').join(' · ')}</span>
          <Show when={movable()}><Button class="journal-carried-action" onClick={() => props.carried.move(props.groups.overdue, props.date)}>Move to today</Button></Show>
          <Button class="journal-carried-action" aria-expanded={review()} onClick={() => setReview(value => !value)}>{review() ? 'Hide' : 'Review…'}</Button>
        </div>}>
          {/* A neutral leaf: danger only on "carried over", one tint action, and the leaf itself opens the carried tasks. */}
          <div class="journal-carried-leaf leaf">
            <button type="button" class="journal-carried-body" aria-expanded={review()} onClick={() => setReview(value => !value)}>
              <span class="journal-carried-count"><Figures text={`${props.groups.overdue.length} carried over`} /></span>
              <span class="journal-carried-titles">
                <For each={props.groups.overdue.slice(0, carriedShown)}>{row => <span><BlockText text={row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>}</For>
                <Show when={props.groups.overdue.length > carriedShown}><span class="journal-carried-more">and {props.groups.overdue.length - carriedShown} more</span></Show>
              </span>
            </button>
            <Show when={movable()}><Button kind="tint" onClick={() => props.carried.move(props.groups.overdue, props.date)}>Move to today</Button></Show>
          </div>
        </Show>
        <Show when={review()}><TaskSourceRows rows={props.groups.overdue} date={props.date} notebook={props.notebook} timetable gutter={gutter()} plan onOpen={props.onOpen} onChanged={() => {}} /></Show>
      </Show>
      <TaskSourceRows rows={props.groups.planned} date={props.date} notebook={props.notebook} timetable gutter={gutter()} plan now={props.now} onOpen={props.onOpen} onChanged={() => {}} />
    </div></Show>
  </section>;
}
