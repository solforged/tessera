import { For, Show, createMemo, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { IngestJob, LibraryRow, ReadingState } from '../api/types';
import { listOpensBeside, opensBeside } from '../core/beside';
import type { LibraryGroup, LibraryTab, LibraryViewState, OpenTarget, PaneId } from '../core/contract';
import { DEMO } from '../core/mode';
import type { WorkshopClient } from '../document/contract';
import { displayTitle } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { isPhone } from '../ui/viewport';
import { clearedFilters } from './LibraryBrowseRail';
import { formatProgress, importJobName, jobLabel, retryTime, sourceByline } from './query';
import type { SourceGroup } from './query';
import { ReadingCard } from './ReadingCard';
import { ResourceImage } from './ResourceImage';
import { SourceCover } from './SourceCover';

// Rows below the fold skip layout only in long lists. Their placeholder cannot match both one- and two-line rows, and WebKit (no scroll anchoring) shows every mismatch as a jump while scrolling up.
const longList = 300;

export const stateActions: { state: ReadingState; label: string }[] = [
  { state: 'reading', label: 'Mark as reading' },
  { state: 'finished', label: 'Mark as finished' },
  { state: 'abandoned', label: 'Mark as abandoned' },
  { state: 'inbox', label: 'Return to inbox' },
];

export const stateLabels: Record<ReadingState, string> = {
  inbox: 'Inbox',
  reading: 'Reading',
  finished: 'Finished',
  abandoned: 'Abandoned',
};

function JobRows(props: {
  jobs: IngestJob[];
  sourceTitles: Map<string, string>;
  workshop: WorkshopClient;
  retrying: string[];
  onRetry(job: IngestJob): void;
  onDismiss(id: string): void;
}) {
  return (
    <div class="library-jobs" aria-label="Ingestion jobs">
      <For each={props.jobs}>
        {job => {
          const label = () => jobLabel(job, props.sourceTitles);
          return (
            <div class="library-row library-job">
              <span class="library-leading">
                <Icon name={job.state === 'failed' ? 'warning' : job.state === 'done' ? 'book' : 'saving'} />
              </span>
              <span class="library-job-name" role="group" title={label().name} aria-label={label().name}>
                {importJobName(label().name)}
              </span>
              <span class="library-message">{label().state}</span>
              <Show when={job.state !== 'done' && label().attempt}>
                <span class="library-message">{label().attempt}</span>
              </Show>
              <Show when={job.state !== 'done' && job.next_attempt_at !== null && props.workshop.settings()}>
                <span class="library-message">
                  retries at{' '}
                  <span class="library-job-time">
                    {retryTime(job.next_attempt_at!, props.workshop.settings()!.time_zone)}
                  </span>
                </span>
              </Show>
              <Show when={job.state === 'failed'}>
                <div class="library-job-actions">
                  <Button
                    disabled={props.retrying.includes(job.id)}
                    onClick={() => {
                      props.onRetry(job);
                    }}
                  >
                    Retry
                  </Button>
                  <Button onClick={() => props.onDismiss(job.id)}>Dismiss</Button>
                </div>
              </Show>
              <Show when={job.error}>
                <span class="library-job-error">{job.error}</span>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export function LibrarySourcesView(props: {
  pane: PaneId;
  workshop: WorkshopClient;
  neighbour?: boolean;
  tab: LibraryTab;
  tabLabel: string | undefined;
  view: LibraryViewState;
  layout: 'list' | 'shelf';
  group: LibraryGroup;
  groups: SourceGroup[] | undefined;
  displayedSources: LibraryRow[];
  orderedSources: LibraryRow[];
  readingCards: boolean;
  reading: LibraryRow[];
  upNext: LibraryRow[];
  coverLayout: boolean;
  selectMode: boolean;
  selected: Set<string>;
  openedSource: string | undefined;
  sourceMenuId: string | undefined;
  mixedStates: boolean;
  finishedDate: Intl.DateTimeFormat;
  saving: boolean;
  loading: boolean;
  slowLoad: boolean;
  hasResult: boolean;
  error: string;
  noSources: boolean;
  filtered: boolean;
  shownJobs: IngestJob[];
  failedJobs: IngestJob[];
  failuresOpen: boolean;
  onOpenFailures(): void;
  sourceTitles: Map<string, string>;
  retrying: string[];
  onRetryJob(job: IngestJob): void;
  onDismissJob(id: string): void;
  scroll: () => HTMLDivElement | undefined;
  readingTarget(row: LibraryRow): OpenTarget;
  onOpenSource(target: OpenTarget, beside: boolean): void;
  onOpenPage(target: OpenTarget, beside: boolean): void;
  onToggleSelection(id: string, range: boolean, inspect?: boolean): void;
  onChangeState(row: LibraryRow, state: ReadingState): void;
  onRowMenu(row: LibraryRow, anchor: HTMLElement, press?: HTMLElement): void;
  onOpenAdd(anchor: HTMLElement): void;
  onUpdate(patch: Partial<LibraryViewState>): void;
  highlightsContent: JSX.Element;
}) {
  const lookup = (id: string) => props.workshop.lookup(id);

  /** Long-press opens a source's details on the phone; in select mode a tap on a selectable source toggles it instead. */
  function sourceLongPress(row: LibraryRow, selectable: () => boolean = () => true) {
    let timer: number | undefined;
    let pressed = false;
    let x = 0,
      y = 0,
      host: HTMLElement | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const choosing = () => props.selectMode && selectable();
    onCleanup(cancel);
    return {
      onPointerDown: (event: PointerEvent) => {
        if (
          !props.coverLayout ||
          choosing() ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest(
            '.library-checkbox, .library-book-more, .library-start-reading, [aria-haspopup]',
          )
        )
          return;
        host = event.currentTarget as HTMLElement;
        x = event.clientX;
        y = event.clientY;
        pressed = false;
        timer = window.setTimeout(() => {
          pressed = true;
          props.onRowMenu(row, host!, host!);
        }, 450);
      },
      onPointerMove: (event: PointerEvent) => {
        if (Math.hypot(event.clientX - x, event.clientY - y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: MouseEvent) => {
        if (!props.coverLayout) return;
        event.preventDefault();
        cancel();
        if (!choosing()) {
          pressed = true;
          host = event.currentTarget as HTMLElement;
          props.onRowMenu(row, host, host);
        }
      },
      'on:click': {
        capture: true,
        handleEvent: (event: MouseEvent) => {
          if (pressed) {
            event.preventDefault();
            event.stopPropagation();
            pressed = false;
            return;
          }
          if (
            choosing() &&
            (event.target as HTMLElement).closest('.library-row-open, .library-book-open, .library-reading-card')
          ) {
            event.preventDefault();
            event.stopPropagation();
            props.onToggleSelection(row.page.id, event.shiftKey, false);
          }
        },
      },
    };
  }

  function rowKey(event: KeyboardEvent, target: OpenTarget) {
    if (
      event.isComposing ||
      event.altKey ||
      ((event.metaKey || event.ctrlKey) && (event.key !== 'Enter' || !opensBeside(event)))
    )
      return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (props.selectMode && target.kind === 'page') props.onToggleSelection(target.pageId, event.shiftKey, false);
      else
        props.tab !== 'highlights'
          ? props.onOpenSource(target, opensBeside(event))
          : props.onOpenPage(target, listOpensBeside(event, !!props.neighbour));
      return;
    }
    const current = event.currentTarget as HTMLButtonElement;
    const shelf = !!current.closest('.library-shelf');
    const rows = Array.from(props.scroll()?.querySelectorAll<HTMLButtonElement>('[data-library-row]') ?? []);
    const index = rows.indexOf(current);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (shelf && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const from = current.getBoundingClientRect();
      const down = event.key === 'ArrowDown';
      const candidates = rows
        .map((row, at) => ({ at, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => (down ? rect.top > from.top + 1 : rect.top < from.top - 1));
      if (!candidates.length) next = index;
      else {
        const top = down
          ? Math.min(...candidates.map(({ rect }) => rect.top))
          : Math.max(...candidates.map(({ rect }) => rect.top));
        next = candidates
          .filter(({ rect }) => rect.top === top)
          .reduce((best, item) =>
            Math.abs(item.rect.left - from.left) < Math.abs(best.rect.left - from.left) ? item : best,
          ).at;
      }
    } else {
      const steps: Record<string, number> = shelf ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
      if (!(event.key in steps)) return;
      next = Math.max(0, Math.min(rows.length - 1, index + steps[event.key]!));
    }
    rows[next]?.focus();
    event.preventDefault();
    event.stopPropagation();
  }

  /** With `groups`, the shelf flows as one grid and each group's first cover carries its name. */
  function SourceRows(rowsProps: { rows: LibraryRow[]; groups?: SourceGroup[] }) {
    const groupStarts = createMemo(() => new Map(rowsProps.groups?.map(value => [value.rows[0]!.page.id, value])));
    return (
      <Show
        when={props.layout === 'shelf'}
        fallback={
          <div role="list">
            <For each={rowsProps.rows}>
              {row => {
                const target: OpenTarget = { kind: 'page', pageId: row.page.id };
                return (
                  <div
                    class="library-row library-source-row"
                    classList={{
                      'library-row-selected': props.selected.has(row.page.id),
                      'library-source-current': props.openedSource === row.page.id,
                    }}
                    role="listitem"
                    {...sourceLongPress(row)}
                  >
                    <div class="library-leading">
                      <span class="library-source-image">
                        <Show
                          when={props.coverLayout && row.cover}
                          fallback={
                            <Icon
                              name={(row.snapshot_format ?? row.source.format) === 'article' ? 'article' : 'book'}
                            />
                          }
                        >
                          <ResourceImage
                            api={props.workshop.api}
                            snapshotId={row.source.current_snapshot_id ?? ''}
                            href={row.cover!}
                            alt=""
                            loading="lazy"
                          />
                        </Show>
                      </span>
                      <Button
                        role="checkbox"
                        aria-checked={props.selected.has(row.page.id)}
                        label={`Select ${displayTitle(row.page.text, lookup)}`}
                        class="icon-only library-checkbox"
                        onClick={event => props.onToggleSelection(row.page.id, event.shiftKey, !props.selectMode)}
                      >
                        <span class="library-checkbox-square">
                          <Show when={props.selected.has(row.page.id)}>
                            <Icon name="check" />
                          </Show>
                        </span>
                      </Button>
                    </div>
                    <Button
                      class="library-row-open"
                      data-library-row={row.page.id}
                      data-open-page={row.page.id}
                      data-open-label={displayTitle(row.page.text, lookup)}
                      onClick={event => props.onOpenSource(target, opensBeside(event))}
                      onKeyDown={event => rowKey(event, target)}
                    >
                      <span class="library-siglum" aria-hidden="true">
                        {row.source.siglum}
                      </span>
                      <span class="library-title" title={displayTitle(row.page.text, lookup)}>
                        {displayTitle(row.page.text, lookup)}
                      </span>
                      <span class="library-byline" title={sourceByline(row)}>
                        {sourceByline(row)}
                      </span>
                      <Show
                        when={
                          props.mixedStates && (row.source.state !== 'finished' || row.source.state_changed_at == null)
                        }
                      >
                        <span class="library-count library-state">{stateLabels[row.source.state]}</span>
                      </Show>
                      <Show when={props.group !== 'year'}>
                        <span class="library-count library-year" aria-label="Published year">
                          {row.published?.slice(0, 4)}
                        </span>
                      </Show>
                      <span
                        class="library-progress"
                        classList={{ 'library-progress-finished': row.source.state === 'finished' }}
                      >
                        <Show
                          when={row.source.state === 'finished'}
                          fallback={
                            <Show
                              when={row.progress > 0}
                              fallback={row.source.state === 'reading' ? 'Not started' : null}
                            >
                              <span
                                class="library-reading-rule library-reading-started"
                                style={{ '--progress': `${row.progress * 100}%` }}
                                aria-hidden="true"
                              />
                              <span>{formatProgress(row.progress)}</span>
                            </Show>
                          }
                        >
                          <Show when={row.source.state_changed_at != null}>
                            <span>Finished {props.finishedDate.format(row.source.state_changed_at!)}</span>
                          </Show>
                        </Show>
                      </span>
                      <span
                        class="library-highlight-count"
                        aria-label={row.unprocessed ? `${row.unprocessed} unprocessed highlights` : undefined}
                      >
                        <Show when={row.unprocessed > 0}>
                          <Icon name="highlight" />
                          {row.unprocessed}
                        </Show>
                      </span>
                    </Button>
                    <Show when={props.tab === 'inbox' && row.source.state === 'inbox'}>
                      <Button
                        class="library-start-reading"
                        icon="book"
                        label="Start reading"
                        disabled={props.saving}
                        onClick={() => props.onChangeState(row, 'reading')}
                      >
                        <span class="library-start-reading-label">Start reading</span>
                      </Button>
                    </Show>
                    <Button
                      icon="more"
                      label={`Actions for ${displayTitle(row.page.text, lookup)}`}
                      aria-haspopup="menu"
                      disabled={props.saving}
                      onClick={event => props.onRowMenu(row, event.currentTarget)}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        }
      >
        <div class="library-shelf" classList={{ 'library-shelf-grouped': !!rowsProps.groups }} role="list">
          <For each={rowsProps.rows}>
            {row => {
              const target: OpenTarget = { kind: 'page', pageId: row.page.id };
              return (
                <div
                  class="library-book library-source-row"
                  classList={{
                    'library-row-selected': props.selected.has(row.page.id),
                    'library-source-current': props.openedSource === row.page.id,
                  }}
                  role="listitem"
                  {...sourceLongPress(row)}
                >
                  <Show when={rowsProps.groups}>
                    <span
                      class="library-book-group"
                      classList={{ 'library-book-group-start': groupStarts().has(row.page.id) }}
                    >
                      <Show when={groupStarts().get(row.page.id)}>
                        {value => (
                          <Show
                            when={value().personId}
                            fallback={
                              <span class="library-group-label" title={value().label}>
                                {value().label}
                              </span>
                            }
                          >
                            {id => (
                              <Button
                                class="library-group-label"
                                title={value().label}
                                onClick={event => props.onOpenPage({ kind: 'page', pageId: id() }, opensBeside(event))}
                              >
                                {value().label}
                              </Button>
                            )}
                          </Show>
                        )}
                      </Show>
                    </span>
                  </Show>
                  <Button
                    class="library-book-open"
                    data-library-row={row.page.id}
                    data-open-page={row.page.id}
                    data-open-label={displayTitle(row.page.text, lookup)}
                    onClick={event => props.onOpenSource(target, opensBeside(event))}
                    onKeyDown={event => rowKey(event, target)}
                  >
                    <SourceCover api={props.workshop.api} row={row} siglum={row.source.siglum} />
                    <span
                      class="library-reading-rule"
                      classList={{ 'library-reading-started': row.progress > 0 }}
                      style={{ '--progress': `${row.progress * 100}%` }}
                      aria-hidden="true"
                    />
                    <span class="library-book-title">{displayTitle(row.page.text, lookup)}</span>
                    <span class="library-book-byline" title={sourceByline(row)}>
                      {sourceByline(row)}
                    </span>
                    <span class="library-book-apparatus">
                      <span class="library-siglum" aria-hidden="true">
                        {row.source.siglum}
                      </span>
                      <Show when={props.mixedStates}>
                        <span class="library-book-state">{stateLabels[row.source.state]}</span>
                      </Show>
                      <Show when={row.published && props.group !== 'year'}>
                        <span aria-label="Published year">{row.published!.slice(0, 4)}</span>
                      </Show>
                      <Show when={row.progress > 0 && row.source.state !== 'finished'}>
                        <span>{formatProgress(row.progress)}</span>
                      </Show>
                      <Show when={row.unprocessed > 0}>
                        <span class="library-book-highlights" aria-label={`${row.unprocessed} unprocessed highlights`}>
                          <Icon name="highlight" />
                          {row.unprocessed}
                        </span>
                      </Show>
                    </span>
                  </Button>
                  <Button
                    role="checkbox"
                    aria-checked={props.selected.has(row.page.id)}
                    label={`Select ${displayTitle(row.page.text, lookup)}`}
                    class="icon-only library-checkbox"
                    onClick={event => props.onToggleSelection(row.page.id, event.shiftKey, !props.selectMode)}
                  >
                    <span class="library-checkbox-square">
                      <Show when={props.selected.has(row.page.id)}>
                        <Icon name="check" />
                      </Show>
                    </span>
                  </Button>
                  <Button
                    class="library-book-more"
                    icon="more"
                    label={`Actions for ${displayTitle(row.page.text, lookup)}`}
                    aria-haspopup="menu"
                    aria-expanded={props.sourceMenuId === row.page.id}
                    disabled={props.saving}
                    onClick={event => props.onRowMenu(row, event.currentTarget)}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    );
  }

  return (
    <>
      <Show when={props.readingCards}>
        <Show when={props.reading.length}>
          <section class="library-reading" aria-labelledby={`${props.pane}-reading-heading`}>
            <h2 class="library-reading-heading" id={`${props.pane}-reading-heading`}>
              Reading now
            </h2>
            <div class="library-reading-books" role="list">
              <For each={props.reading}>
                {row => (
                  <div
                    class="library-reading-item library-reading-entry"
                    classList={{ 'library-row-selected': props.selected.has(row.page.id) }}
                    role="listitem"
                    {...sourceLongPress(row)}
                  >
                    <ReadingCard
                      row={row}
                      workshop={props.workshop}
                      selected={props.openedSource === row.page.id || props.selected.has(row.page.id)}
                      onOpen={beside => props.onOpenSource(props.readingTarget(row), beside)}
                    />
                    <Button
                      role="checkbox"
                      aria-checked={props.selected.has(row.page.id)}
                      label={`Select ${displayTitle(row.page.text, lookup)}`}
                      class="icon-only library-checkbox"
                      onClick={event => props.onToggleSelection(row.page.id, event.shiftKey, !props.selectMode)}
                    >
                      <span class="library-checkbox-square">
                        <Show when={props.selected.has(row.page.id)}>
                          <Icon name="check" />
                        </Show>
                      </span>
                    </Button>
                    <Button
                      class="library-reading-more"
                      icon="more"
                      label={`Actions for ${displayTitle(row.page.text, lookup)}`}
                      aria-haspopup="menu"
                      onClick={event => props.onRowMenu(row, event.currentTarget)}
                    />
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
        <Show when={props.coverLayout && props.upNext.length}>
          <section class="library-up-next" aria-label="Up next">
            <h2 class="library-reading-heading">Up next · Inbox</h2>
            <For each={props.upNext}>
              {row => (
                <Button
                  class="library-up-next-book"
                  onClick={event => props.onOpenSource({ kind: 'page', pageId: row.page.id }, opensBeside(event))}
                  {...sourceLongPress(row, () => false)}
                >
                  <Show when={isPhone()} fallback={<span class="library-siglum">{row.source.siglum}</span>}>
                    <SourceCover
                      api={props.workshop.api}
                      row={row}
                      siglum={row.source.siglum}
                      title={displayTitle(row.page.text, lookup)}
                    />
                  </Show>
                  <span>
                    <span class="library-title">{displayTitle(row.page.text, lookup)}</span>
                    <span class="library-book-byline" title={sourceByline(row)}>
                      {sourceByline(row)}
                    </span>
                  </span>
                </Button>
              )}
            </For>
          </section>
        </Show>
      </Show>
      <section
        class="library-rows"
        classList={{
          'library-has-selection': props.selected.size > 0,
          'library-rows-shelf': props.layout === 'shelf' && props.tab !== 'highlights',
          'library-rows-grouped': !!props.groups,
          'library-rows-long': props.displayedSources.length > longList,
        }}
        aria-label={props.tab === 'highlights' ? 'Highlights' : 'Sources'}
        aria-busy={props.loading}
      >
        <Show when={props.shownJobs.length}>
          <JobRows
            jobs={props.shownJobs}
            sourceTitles={props.sourceTitles}
            workshop={props.workshop}
            retrying={props.retrying}
            onRetry={props.onRetryJob}
            onDismiss={props.onDismissJob}
          />
        </Show>
        <Show when={props.failedJobs.length}>
          <section class="library-failures" aria-label="Failed imports">
            <h3 class="library-failure-heading">
              <span>
                {props.failedJobs.length} {props.failedJobs.length === 1 ? 'import' : 'imports'} failed
              </span>
            </h3>
            <JobRows
              jobs={props.failuresOpen ? props.failedJobs : props.failedJobs.slice(0, 2)}
              sourceTitles={props.sourceTitles}
              workshop={props.workshop}
              retrying={props.retrying}
              onRetry={props.onRetryJob}
              onDismiss={props.onDismissJob}
            />
            <div class="library-failure-more">
              <Show when={!props.failuresOpen && props.failedJobs.length > 2}>
                <Button onClick={props.onOpenFailures}>{props.failedJobs.length - 2} more</Button>
              </Show>
              <Button
                class="library-dismiss-all"
                onClick={() => {
                  for (const job of props.failedJobs) props.onDismissJob(job.id);
                }}
              >
                Dismiss all
              </Button>
            </div>
          </section>
        </Show>
        <Show when={props.slowLoad}>
          <p class="library-message" role="status">
            Loading…
          </p>
        </Show>
        <Show when={props.hasResult && !props.error}>
          <Show when={props.tab !== 'highlights'} fallback={props.highlightsContent}>
            <Show
              when={props.displayedSources.length}
              fallback={
                <div class="library-empty">
                  <Show
                    when={props.view.text.trim() || props.filtered}
                    fallback={
                      <>
                        <Show
                          when={!props.view.collection && !props.view.view && props.noSources}
                          fallback={
                            <p>
                              {props.view.collection
                                ? 'This collection has no sources yet. Select books in the library, then choose Add to collection.'
                                : props.tab === 'all'
                                  ? 'No sources.'
                                  : `No ${props.tabLabel?.toLowerCase() ?? ''} sources yet.`}
                            </p>
                          }
                        >
                          <h2>Add your first source</h2>
                          <p>
                            {DEMO
                              ? 'Import an EPUB to read, highlight, and make notes.'
                              : 'Import an EPUB, save an article, or add a catalog record.'}
                          </p>
                        </Show>
                        <Show
                          when={props.view.collection}
                          fallback={
                            <Show when={props.noSources || props.tab === 'inbox' || props.tab === 'all'}>
                              <Button
                                class="bordered"
                                icon="plus"
                                onClick={event => props.onOpenAdd(event.currentTarget)}
                              >
                                {DEMO ? 'Import an EPUB' : 'Add a source'}
                              </Button>
                            </Show>
                          }
                        >
                          <Button
                            class="bordered"
                            onClick={() =>
                              props.onUpdate({
                                view: null,
                                tab: 'all',
                                collection: null,
                                text: '',
                                filters: clearedFilters(),
                                scroll: 0,
                              })
                            }
                          >
                            All sources
                          </Button>
                        </Show>
                      </>
                    }
                  >
                    <p>No sources match.</p>
                    <Button
                      onClick={() => props.onUpdate({ view: null, text: '', filters: clearedFilters(), scroll: 0 })}
                    >
                      {props.filtered ? 'Clear search and filters' : 'Clear search'}
                    </Button>
                  </Show>
                </div>
              }
            >
              <Show when={!props.readingCards}>
                <Show when={props.groups} fallback={<SourceRows rows={props.displayedSources} />}>
                  {list => (
                    <Show
                      when={props.layout !== 'shelf'}
                      fallback={<SourceRows rows={props.orderedSources} groups={list()} />}
                    >
                      <For each={list()}>
                        {value => (
                          <section class="library-group" aria-label={value.label}>
                            <h3 class="library-group-heading">
                              <Show
                                when={value.personId}
                                fallback={<span class="library-group-label">{value.label}</span>}
                              >
                                {id => (
                                  <Button
                                    class="library-group-label"
                                    onClick={event =>
                                      props.onOpenPage({ kind: 'page', pageId: id() }, opensBeside(event))
                                    }
                                  >
                                    {value.label}
                                  </Button>
                                )}
                              </Show>
                              <span class="library-group-count">{value.rows.length}</span>
                            </h3>
                            <SourceRows rows={value.rows} />
                          </section>
                        )}
                      </For>
                    </Show>
                  )}
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </section>
    </>
  );
}
