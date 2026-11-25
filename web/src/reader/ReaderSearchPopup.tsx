import { For, Show, batch, createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { PassageHit, TocEntry } from '../api/types';
import type { HighlightSection } from '../library/highlights';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { Figures } from './Figures';
import { contentsTitle, sectionLabel } from './openings';
import { timeLeft } from './paged';

const SEARCH_PAGE_SIZE = 40;

export function createReaderSearch(options: {
  api: ApiClient;
  sourceId: Accessor<string>;
  open: Accessor<boolean>;
  popupIdentity: Accessor<unknown>;
  query: Accessor<string>;
}) {
  const [hits, setHits] = createSignal<PassageHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal('');
  const [morePassages, setMorePassages] = createSignal(false);
  let searchRequest: {
    text: string;
    sourceId: string;
    popup: unknown;
    controller: AbortController;
    offset: number;
    pending: boolean;
  } | null = null;

  async function loadSearchPage() {
    const request = searchRequest;
    if (!request || request.pending) return;
    const current = () =>
      searchRequest === request &&
      !request.controller.signal.aborted &&
      options.popupIdentity() === request.popup &&
      options.query().trim() === request.text &&
      options.sourceId() === request.sourceId;
    if (!current()) return;
    request.pending = true;
    setSearching(true);
    setSearchError('');
    try {
      const values = await options.api.searchPassages(
        request.text,
        request.sourceId,
        SEARCH_PAGE_SIZE + 1,
        request.offset,
        request.controller.signal,
      );
      if (!current()) return;
      const page = values.slice(0, SEARCH_PAGE_SIZE);
      request.offset += page.length;
      batch(() => {
        setHits(previous => {
          const keys = new Set(previous.map(hit => `${hit.snapshot_id}:${hit.passage.id}`));
          return [
            ...previous,
            ...page.filter(hit => {
              const key = `${hit.snapshot_id}:${hit.passage.id}`;
              if (keys.has(key)) return false;
              keys.add(key);
              return true;
            }),
          ];
        });
        setMorePassages(values.length > SEARCH_PAGE_SIZE);
      });
    } catch (reason) {
      if (current()) setSearchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      request.pending = false;
      if (current()) setSearching(false);
    }
  }

  createEffect(() => {
    const isOpen = options.open(),
      popup = options.popupIdentity(),
      text = options.query().trim(),
      sourceId = options.sourceId();
    searchRequest = null;
    setHits([]);
    setSearching(false);
    setSearchError('');
    setMorePassages(false);
    if (!isOpen || !text) return;
    const controller = new AbortController();
    searchRequest = { text, sourceId, popup, controller, offset: 0, pending: false };
    setSearching(true);
    const timer = window.setTimeout(() => {
      void loadSearchPage();
    }, 180);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
      searchRequest = null;
    });
  });

  return {
    hits,
    searching,
    searchError,
    morePassages,
    loadSearchPage,
  };
}

export function ReaderSearchPopup(props: {
  anchor: HTMLElement;
  coverReading: boolean;
  query: string;
  onQuery: Setter<string>;
  hits: PassageHit[];
  searching: boolean;
  searchError: string;
  morePassages: boolean;
  onLoadMore(): void;
  sectionAt(ordinal: number): HighlightSection | undefined;
  onPick(hit: PassageHit): void;
  onDismiss(): void;
}) {
  return (
    <Picker
      class="reader-picker"
      anchor={props.anchor}
      placement={props.coverReading ? 'sheet' : 'anchor'}
      label="Find in source"
      title="Find in source"
      prefix={props.coverReading ? <Icon name="search" /> : undefined}
      placeholder="Find in source"
      query={props.query}
      onQuery={props.onQuery}
      items={props.hits}
      key={hit => `${hit.snapshot_id}:${hit.passage.id}`}
      status={
        <div class="reader-find-status">
          <span role="status">
            {props.hits.length} passages{props.morePassages ? ' shown' : ''}
          </span>
          <Show when={props.morePassages}>
            {' '}
            <Button disabled={props.searching} onClick={props.onLoadMore}>
              Load more passages
            </Button>
          </Show>
        </div>
      }
      row={hit => (
        <span class="reader-search-entry">
          <span class="reader-search-snippet">
            <For each={hit.snippet_parts}>
              {part => (part.match ? <mark class="reader-search-match">{part.text}</mark> : part.text)}
            </For>
          </span>
          <span class="reader-highlight-section">
            Passage {hit.passage.ordinal + 1}
            <Show when={props.sectionAt(hit.passage.ordinal)}>{entry => <> · {sectionLabel(entry().title)}</>}</Show>
          </span>
        </span>
      )}
      busy={props.searching && !props.hits.length}
      error={props.searchError}
      empty={props.query.trim() ? 'No passages found' : 'Search this source'}
      onPick={props.onPick}
      onDismiss={props.onDismiss}
    />
  );
}

/** A contents entry on the phone: its name in display type, a tick once it has been read through, and for the chapter being read its gilt name, time left and ring. */
export function ReaderTocRow(props: {
  entry: TocEntry;
  currentSection: TocEntry | undefined;
  span: { end: number; subtree: number } | undefined;
  here: number;
  coverReading: boolean;
}) {
  const now = () => props.entry === props.currentSection;
  const done = () => !now() && !!props.span && props.span.subtree <= props.here;
  const share = () => {
    const value = props.span;
    return value && now()
      ? Math.round(
          Math.max(0, Math.min(1, (props.here - props.entry.start!) / Math.max(1, value.end - props.entry.start!))) *
            100,
        )
      : null;
  };
  const left = () => {
    const value = props.span;
    return value && now() ? timeLeft(value.end - props.here) : null;
  };
  return (
    <span
      class="reader-toc-entry"
      classList={{ 'reader-toc-now': now() }}
      aria-current={now() ? 'true' : undefined}
      style={{ '--level': Math.max(0, props.entry.level - 1) }}
    >
      <span class="reader-toc-check">
        <Show when={now()}>
          <Icon name="check" />
        </Show>
      </span>
      <span class="reader-toc-name">
        <span>{contentsTitle(props.entry.title)}</span>
        <Show when={props.coverReading && left()}>
          {time => (
            <small>
              <Figures text={`${time()} left`} />
            </small>
          )}
        </Show>
      </span>
      <Show when={props.coverReading}>
        <Show
          when={share() !== null}
          fallback={
            <Show when={done()}>
              <span class="reader-toc-read">
                <Icon name="check" />
              </span>
            </Show>
          }
        >
          <span class="reader-toc-progress">
            <span>
              <Figures text={`${share()}%`} />
            </span>
            <span class="reader-ring" style={{ '--p': share() ?? 0 }} />
          </span>
        </Show>
      </Show>
    </span>
  );
}
