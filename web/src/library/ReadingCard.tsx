import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { LibraryRow, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { isFrontMatter, sectionLabel } from '../reader/openings';
import { timeLeft } from '../reader/paged';
import { BookMap } from '../ui/BookMap';
import { bookChapters, chapterAt } from '../ui/book-map';
import { Button } from '../ui/Button';
import { SourceCover } from './SourceCover';
import { formatProgress, sourceByline } from './query';

/** A Reading source's actual chapter and position, with requests owned by the mounted card. */
export function ReadingCard(props: { row: LibraryRow; notebook: NotebookClient; selected?: boolean; onOpen(beside: boolean): void }) {
  const [source, setSource] = createSignal<SourceView>();
  const [error, setError] = createSignal('');
  createEffect(() => {
    const id = props.row.page.id;
    props.notebook.changeSequence();
    const controller = new AbortController();
    void props.notebook.api.source(id, controller.signal).then(view => {
      if (!controller.signal.aborted) { setSource(view); setError(''); }
    }, reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });
  const snapshot = createMemo(() => source()?.snapshots.find(snapshot => snapshot.id === source()?.source.current_snapshot_id));
  const length = createMemo(() => snapshot()?.text_length ?? 0);
  const progress = createMemo(() => source()?.progress ?? props.row.progress);
  const at = createMemo(() => progress() * length());
  const chapters = createMemo(() => bookChapters(source()?.toc ?? [], length()));
  const current = createMemo(() => chapterAt(chapters(), at()));
  return <Button class="library-reading-card" classList={{ 'library-reading-current': props.selected }} aria-current={props.selected ? 'page' : undefined} onClick={event => props.onOpen(event.shiftKey)}>
    <span class="library-reading-head">
      <Show when={props.row.cover || (snapshot()?.format ?? props.row.source.format) !== 'article'}><SourceCover row={props.row} siglum={props.row.source.siglum} /></Show>
      <span class="library-reading-text">
        <span class="library-reading-title" title={props.row.page.text}>{props.row.page.text}</span>
        <span class="library-reading-author" title={sourceByline(props.row)}>{sourceByline(props.row)}</span>
        <span class="library-reading-chapter">{current()?.chapter.title ? sectionLabel(current()!.chapter.title) : !source() && props.row.section && !isFrontMatter(props.row.section) ? sectionLabel(props.row.section) : progress() ? 'Reading position' : 'Not started'}</span>
      </span>
    </span>
    {/* The map and its figures span the card under the cover, so the time left reads on one line. */}
    <Show when={length() > 0} fallback={<span class="book-map library-reading-map-pending" aria-hidden="true" />}><BookMap chapters={chapters()} length={length()} at={at()} /></Show>
    <span class="library-reading-position">
      {/* The chapter line above names what the time is left in, so the figure fits beside the percentage. */}
      <span><Show when={current()?.chapter.title ? current() : null}>{value => <span title={`${timeLeft(value().chapter.end - at())} left in chapter`}>{timeLeft(value().chapter.end - at())} left</span>}</Show></span>
      <span>{formatProgress(progress())}</span>
    </span>
    <Show when={error()}><span class="library-error" role="alert">{error()}</span></Show>
  </Button>;
}
