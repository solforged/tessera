import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Agenda, Citation, LibraryRow, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { SourceCover } from '../library/SourceCover';
import { BlockText } from '../outline/BlockText';
import { shortSourceTitle } from '../outline/source';
import { timeLeft } from '../reader/paged';
import type { OpenTarget } from '../shell/contract';
import { BookMap } from '../ui/BookMap';
import { bookChapters, chapterAt } from '../ui/book-map';
import { Button } from '../ui/Button';
import { spokenJournalDate } from './journal-date';
import { JournalTrail } from './JournalTrail';
import { groupAgenda } from './task-labels';
import './agenda.css';
import '../library/library.css';

export function JournalHeader(props: { date: string; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const today = createMemo(() => props.date === props.notebook.todayDate());
  const [desk, setDesk] = createSignal<{ agenda: Agenda; due: number }>();
  const [deskError, setDeskError] = createSignal('');
  const [reading, setReading] = createSignal<{ row: LibraryRow; source: SourceView; highlights: { at: number; color: Citation['color'] }[] } | null>();
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
    props.notebook.changeSequence(); props.notebook.lastChange();
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
    const groups = groupAgenda(agenda.items, props.date);
    // Match the Agenda pane's Today section, excluding both Overdue and future warning dates.
    const items = groups.planned.filter(item => item.task.status === 'doing'
      || !!item.task.scheduled && item.task.scheduled <= props.date
      || !!item.task.deadline && item.task.deadline <= props.date);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: props.notebook.settings()?.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const next = items.filter(item => item.time && item.time >= clock).sort((a, b) => a.time!.localeCompare(b.time!))[0] ?? items.find(item => !item.time);
    return { planned: items.length, overdue: groups.overdue.length, next };
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
  const Placeholder = () => <span class="journal-tile-placeholder" aria-hidden="true"><span /><span /></span>;
  return <section class="journal-header" aria-label={spokenJournalDate(props.date)}>
    <JournalTrail date={props.date} notebook={props.notebook} onSelect={async date => {
      const pageId = await props.notebook.journal(date);
      props.onOpen({ kind: 'page', pageId }, false);
    }} />
    <Show when={today()}>
      <div class="journal-tiles" aria-label="Today">
        <Button class="journal-tile" aria-busy={!desk() && !deskError()} onClick={() => props.onOpen({ kind: 'agenda', date: props.date }, false)}>
          <span class="journal-tile-heading"><span>Agenda</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={agendaSummary()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Agenda unavailable</span> : <Placeholder />}>{summary => <>
            <span class="journal-tile-count">{summary().planned}<small>today · <span classList={{ 'agenda-late': summary().overdue > 0 }}>{summary().overdue} overdue</span></small></span>
            <span class="journal-tile-meta"><Show when={summary().next} fallback="Nothing else planned today">{next => <>Next: <BlockText text={next().source.block.text} notebook={props.notebook} interactive={false} />{next().time ? ` · ${next().time}` : ''}</>}</Show></span>
          </>}</Show>
        </Button>
        <Button class="journal-tile" aria-busy={!desk() && !deskError()} onClick={() => props.onOpen({ kind: 'review' }, false)}>
          <span class="journal-tile-heading"><span>Review</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={desk()} fallback={deskError() ? <span class="journal-tile-meta journal-tile-unavailable">Review unavailable</span> : <Placeholder />}>{counts => <span class="journal-tile-count">{counts().due}<small>due</small></span>}</Show>
        </Button>
        <Button class="journal-tile journal-reading-tile" aria-busy={reading() === undefined && !readingError()} onClick={event => {
          const book = reading();
          if (book) props.onOpen({ kind: 'reader', sourceId: book.row.page.id, snapshotId: book.source.source.current_snapshot_id ?? undefined }, event.shiftKey || matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
          else props.onOpen({ kind: 'library', tab: 'reading' }, false);
        }}>
          <span class="journal-tile-heading"><span>Reading</span><span class="journal-tile-action" aria-hidden="true">›</span></span>
          <Show when={reading()} fallback={reading() === undefined && !readingError() ? <Placeholder /> : <span class="journal-tile-meta journal-tile-unavailable">{readingError() ? 'Reading unavailable' : 'No book in progress'}</span>}>{book => <>
            <span class="journal-reading-book"><SourceCover row={book().row} siglum={book().row.source.siglum} /><span class="journal-reading-text"><span class="journal-reading-title" title={book().row.page.text}>{shortSourceTitle(book().row.page.text)}</span>
              <Show when={progress()?.length}><span class="journal-tile-meta"><span class="journal-reading-separator"> · </span>{progress()?.current?.chapter.title ? `${timeLeft(progress()!.current!.chapter.end - progress()!.at)} left` : `${timeLeft(progress()!.length - progress()!.at)} left in book`}<span class="journal-reading-chapter">{progress()?.current?.chapter.title ? ` · ${progress()!.current!.chapter.title}` : ''}</span></span></Show>
            </span></span>
            <Show when={progress()?.length}><BookMap chapters={progress()!.chapters} length={progress()!.length} at={progress()!.at} highlights={book().highlights} /></Show>
          </>}</Show>
        </Button>
      </div>
      <Show when={deskError() || readingError()}><p class="agenda-error" role="alert">{[deskError(), readingError()].filter(Boolean).join(' · ')}</p></Show>
    </Show>
    <div class="journal-writing-heading"><span>Journal</span><span class="section-rule" /></div>
  </section>;
}
