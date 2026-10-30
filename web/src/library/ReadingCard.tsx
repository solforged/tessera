import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Citation, LibraryRow, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { isFrontMatter, sectionLabel } from '../reader/openings';
import { timeLeft } from '../reader/paged';
import { opensBeside } from '../shell/beside';
import { BookMap } from '../ui/BookMap';
import { bookChapters, chapterAt } from '../ui/book-map';
import { Button } from '../ui/Button';
import { SourceCover } from './SourceCover';
import { Figures } from '../reader/Figures';
import { Icon } from '../ui/Icon';
import { formatProgress, sourceByline } from './query';
import { displayTitle } from '../outline/names';

// Cards remount whenever Reading now leaves and returns with the tab. The last source each one read lets it come back
// as it was, rather than rebuilding its chapter line and map from the list row, while the request refreshes it.
interface ReadingSource { source: SourceView; highlights: { at: number; color: Citation['color'] }[] }
const sources = new Map<string, ReadingSource>();

/** A Reading source's actual chapter and position, with requests owned by the mounted card. */
export function ReadingCard(props: { row: LibraryRow; notebook: NotebookClient; selected?: boolean; onOpen(beside: boolean): void }) {
  const cached = sources.get(props.row.page.id);
  const [source, setSource] = createSignal<SourceView | undefined>(cached?.source);
  const [highlights, setHighlights] = createSignal<ReadingSource['highlights']>(cached?.highlights ?? []);
  const [error, setError] = createSignal('');
  createEffect(() => {
    const id = props.row.page.id;
    props.notebook.changeSequence();
    const controller = new AbortController();
    void Promise.all([
      props.notebook.api.source(id, controller.signal),
      props.notebook.api.highlights({ source_id: id, limit: null }, controller.signal),
    ]).then(([view, highlights]) => {
      if (controller.signal.aborted) return;
      const marks = highlights.rows.flatMap(row => row.citation.snapshot_id === view.source.current_snapshot_id && row.citation.position !== undefined ? [{ at: row.citation.position, color: row.color }] : []);
      sources.set(id, { source: view, highlights: marks }); setSource(view); setHighlights(marks); setError('');
    }, reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });
  const snapshot = createMemo(() => source()?.snapshots.find(snapshot => snapshot.id === source()?.source.current_snapshot_id));
  const length = createMemo(() => snapshot()?.text_length ?? 0);
  const progress = createMemo(() => source()?.progress ?? props.row.progress);
  const at = createMemo(() => progress() * length());
  const chapters = createMemo(() => bookChapters(source()?.toc ?? [], length()));
  const current = createMemo(() => chapterAt(chapters(), at()));
  return <Button class="library-reading-card" classList={{ 'library-reading-current': props.selected }} aria-current={props.selected ? 'page' : undefined} onClick={event => props.onOpen(opensBeside(event))}>
    <span class="library-reading-head">
      <Show when={props.row.cover || (snapshot()?.format ?? props.row.snapshot_format ?? props.row.source.format) !== 'article'}><SourceCover row={props.row} siglum={props.row.source.siglum} /></Show>
      <span class="library-reading-text">
        <span class="library-reading-title" title={displayTitle(props.row.page.text, id => props.notebook.lookup(id))}>{displayTitle(props.row.page.text, id => props.notebook.lookup(id))}</span>
        <span class="library-reading-author" title={sourceByline(props.row)}>{sourceByline(props.row)}</span>
        <span class="library-reading-chapter">{current()?.chapter.title ? sectionLabel(current()!.chapter.title) : !source() && props.row.section && !isFrontMatter(props.row.section) ? sectionLabel(props.row.section) : progress() ? 'Reading position' : 'Not started'}</span>
        <span class="library-reading-continue" aria-hidden="true"><Icon name="book" />{progress() ? 'Continue' : 'Start'}</span>
      </span>
    </span>
    {/* The map and its figures span the card under the cover, so the time left reads on one line. */}
    <Show when={length() > 0} fallback={<span class="book-map library-reading-map-pending" aria-hidden="true" />}><BookMap chapters={chapters()} length={length()} at={at()} highlights={highlights()} /></Show>
    <span class="library-reading-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, progress() * 100)}%` }} /></span>
    <span class="library-reading-position">
      <span><Show when={current()?.chapter.title ? current() : null} fallback={<Show when={length() > 0}><Figures text={`${timeLeft(length() - at())} left in book`} /></Show>}>{value => <span><span class="library-reading-time-phone"><Figures text={`${timeLeft(value().chapter.end - at())} left in chapter`} /></span><span class="library-reading-time-desktop">{timeLeft(value().chapter.end - at())} in chapter</span></span>}</Show></span>
      <span><Figures text={formatProgress(progress())} /></span>
    </span>
    <Show when={error()}><span class="library-error" role="alert">{error()}</span></Show>
  </Button>;
}
