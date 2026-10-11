import { For, Show, createMemo } from 'solid-js';
import type { Citation } from '../api/types';
import { formatProgress } from '../library/query';
import { BookMap } from '../ui/BookMap';
import { Button } from '../ui/Button';
import type { Chapter } from '../ui/book-map';
import { Popup } from '../ui/Popup';
import { timeLeft } from './paged';

/** How many chapters the card lists after the one being read. */
const NEXT_CHAPTERS = 5;

/** A time left with its numbers set larger than its units: `17 h 31 min`. */
function Duration(props: { characters: number }) {
  return <For each={timeLeft(props.characters).split(/(\d+)/).filter(Boolean)}>{part => /^\d+$/.test(part) ? <b>{part}</b> : <span>{part}</span>}</For>;
}

/**
 * Where the reader is in the book, opened from the percentage: the book and chapter position, the map with its
 * highlights, the time left in each and the chapters ahead with their lengths. On the cover screen it is a sheet.
 */
export function ProgressCard(props: {
  anchor: HTMLElement; sheet: boolean; chapters: readonly Chapter[]; length: number; at: number;
  highlights: readonly { at: number; color: Citation['color'] }[]; added: number | null;
  onJump(chapter: Chapter): void; onDismiss(): void;
}) {
  // Front matter before the first chapter is a stretch of the map but not a numbered chapter.
  const titled = createMemo(() => props.chapters.filter(chapter => chapter.title));
  const current = createMemo(() => props.chapters.find(chapter => props.at >= chapter.start && props.at < chapter.end) ?? props.chapters.at(-1));
  const number = (chapter: Chapter) => titled().indexOf(chapter) + 1;
  const chapterLine = () => {
    const chapter = current();
    if (!chapter || !titled().length) return '';
    if (!chapter.title) return `Before chapter 1 of ${titled().length}`;
    const through = Math.floor((props.at - chapter.start) / Math.max(1, chapter.end - chapter.start) * 100);
    return `Chapter ${number(chapter)} of ${titled().length}, ${through}% through`;
  };
  const ahead = createMemo(() => {
    const chapter = current();
    const from = chapter ? props.chapters.indexOf(chapter) : 0;
    return props.chapters.slice(from, from + NEXT_CHAPTERS + 1).filter(entry => entry.title);
  });
  const added = () => {
    if (props.added === null) return '';
    const date = new Date(props.added);
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
  };
  return <Popup anchor={props.anchor} placement={props.sheet ? 'sheet' : 'anchor'} width={380} fitContent label="Reading progress" class="reader-progress-card" onDismiss={props.onDismiss}>
    <div class="progress-card-head">
      <div>
        <p class="progress-card-share"><b>{formatProgress(props.at / (props.length || 1))}</b> of the book</p>
        <Show when={chapterLine()}><p class="progress-card-chapter">{chapterLine()}</p></Show>
      </div>
      <Show when={added()}><p class="progress-card-added">Added {added()}</p></Show>
    </div>
    <BookMap large chapters={props.chapters} length={props.length} at={props.at} highlights={props.highlights} />
    <p class="progress-card-ends">
      <span>{titled().length ? 'Ch. 1' : 'Start'}</span>
      <span>{props.highlights.length === 1 ? '1 highlight' : `${props.highlights.length} highlights`}</span>
      <span>{titled().length ? `Ch. ${titled().length}` : 'End'}</span>
    </p>
    <dl class="progress-card-times">
      <Show when={current()?.title}><div><dt>Left in chapter</dt><dd><Duration characters={current()!.end - props.at} /></dd></div></Show>
      <div><dt>Left in book</dt><dd><Duration characters={props.length - props.at} /></dd></div>
    </dl>
    <Show when={ahead().length}>
      <ol class="progress-card-chapters" aria-label="Chapters ahead">
        <For each={ahead()}>{chapter => <li>
          <Button class="progress-card-chapter-row" aria-current={chapter === current() ? 'location' : undefined} onClick={() => props.onJump(chapter)}>
            <span>{number(chapter)} · {chapter.title}</span>
            <span class="progress-card-minutes">{chapter === current() ? `${timeLeft(chapter.end - props.at)} left` : timeLeft(chapter.end - chapter.start)}</span>
          </Button>
        </li>}</For>
      </ol>
    </Show>
    <p class="progress-card-note">Times assume about 250 words a minute.</p>
  </Popup>;
}
