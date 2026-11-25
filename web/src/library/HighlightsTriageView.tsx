import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { HighlightResult, HighlightRow } from '../api/types';
import { opensBeside } from '../core/beside';
import type { LibraryViewState, OpenTarget, PaneId } from '../core/contract';
import type { WorkshopClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { contentsTitle } from '../reader/openings';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { createTopicQuery } from '../ui/loading';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { createHighlightActions, highlightColors, setLinkedCitation } from './highlights';
import {
  highlightChapterHeading,
  highlightChapters,
  highlightEmptyMessage,
  highlightMeta,
  highlightProse,
  nextUnprocessedHighlight,
} from './query';

export type HighlightFilterPopupKind = 'highlight-filters' | 'highlight-sources' | 'highlight-chapters' | 'tags';

export interface HighlightsTriageOptions {
  pane: PaneId;
  active: Accessor<boolean>;
  workshop: WorkshopClient;
  view: Accessor<LibraryViewState>;
  target: Accessor<LibraryViewState>;
  refresh: Accessor<number>;
  coverLayout: Accessor<boolean>;
  hasOpenPopup: Accessor<boolean>;
  initialCounts?: { unprocessed?: number; total?: number };
  onCountsLoaded(unprocessed: number, total: number): void;
  highlights: Accessor<HighlightResult | undefined>;
  setHighlights: Setter<HighlightResult | undefined>;
  scroll: () => HTMLDivElement | undefined;
  disposed: () => boolean;
  update(patch: Partial<LibraryViewState>): void;
  openSource(target: OpenTarget, beside: boolean): void;
  setCommandError: Setter<string>;
  openMenu(anchor: HTMLElement, label: string, items: MenuItem[]): void;
}

export function createHighlightsTriage(options: HighlightsTriageOptions) {
  const [tagQuery, setTagQuery] = createSignal('');
  const [highlightSource, setHighlightSource] = createSignal<string | null>(null);
  const [highlightChapter, setHighlightChapter] = createSignal<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = createSignal<string | null>(null);
  const [highlightPassageOpen, setHighlightPassageOpen] = createSignal(false);
  const [highlightBusy, setHighlightBusy] = createSignal(false);
  const [followingPassage, setFollowingPassage] = createSignal<string[]>([]);
  const [followingError, setFollowingError] = createSignal('');
  const [followingLoading, setFollowingLoading] = createSignal(false);

  const highlightCounts = createTopicQuery({
    workshop: options.workshop,
    topics: ['library'],
    key: () => options.refresh() + 1,
    initial:
      options.initialCounts?.unprocessed !== undefined && options.initialCounts?.total !== undefined
        ? { unprocessed: options.initialCounts.unprocessed, total: options.initialCounts.total }
        : undefined,
    fetcher: async (_, signal) => {
      const [unprocessed, all] = await Promise.all([
        options.workshop.api.highlights({ unprocessed: true, limit: 0 }, signal),
        options.workshop.api.highlights({ limit: 0 }, signal),
      ]);
      options.onCountsLoaded(unprocessed.total, all.total);
      return { unprocessed: unprocessed.total, total: all.total };
    },
  });

  const unprocessedCount = () => highlightCounts.data()?.unprocessed;
  const highlightCount = () => highlightCounts.data()?.total;
  const countError = highlightCounts.error;

  const highlightGroups = createMemo(() => {
    const groups = new Map<string, { sourceId: string; title: string; rows: HighlightRow[] }>();
    for (const row of options.highlights()?.rows ?? []) {
      const id = row.citation.source_id;
      let group = groups.get(id);
      if (!group) {
        group = { sourceId: id, title: row.source_title, rows: [] };
        groups.set(id, group);
      }
      group.rows.push(row);
    }
    return [...groups.values()];
  });

  const scopedHighlightGroups = createMemo(() =>
    highlightGroups().filter(group => !highlightSource() || group.sourceId === highlightSource()),
  );
  const chapterOptions = createMemo(() => [
    ...new Set(
      scopedHighlightGroups()
        .flatMap(group => highlightChapters(group.rows).map(chapter => chapter.title))
        .filter((title): title is string => title !== null),
    ),
  ]);
  const highlightQueue = createMemo(() =>
    scopedHighlightGroups().flatMap(group =>
      highlightChapters(group.rows).flatMap(chapter =>
        highlightChapter() === null || chapter.title === highlightChapter() ? chapter.rows : [],
      ),
    ),
  );
  const highlightFilterCount = createMemo(
    () =>
      options.target().colors.length +
      options.target().tags.length +
      Number(highlightSource() !== null) +
      Number(highlightChapter() !== null),
  );
  const selectedHighlight = createMemo(() => highlightQueue().find(row => row.citation.id === selectedHighlightId()));
  const highlightIndex = createMemo(() => highlightQueue().findIndex(row => row.citation.id === selectedHighlightId()));

  createEffect(() => {
    const rows = highlightQueue();
    if (!rows.some(row => row.citation.id === selectedHighlightId())) {
      setSelectedHighlightId(rows[0]?.citation.id ?? null);
      if (!rows.length) setHighlightPassageOpen(false);
    }
  });

  createEffect(
    on(
      () => {
        const row = selectedHighlight();
        return row
          ? `${row.citation.id}:${row.citation.snapshot_id}:${row.citation.end.passage_id}:${row.citation.end.offset}`
          : null;
      },
      () => {
        const row = selectedHighlight();
        setFollowingPassage([]);
        setFollowingError('');
        if (!row) {
          setFollowingLoading(false);
          return;
        }
        const controller = new AbortController();
        setFollowingLoading(true);
        const continuation = async () => {
          const citation = row.citation;
          let page = await options.workshop.api.passages(
            citation.snapshot_id,
            citation.ordinal,
            citation.start.passage_id === citation.end.passage_id ? 2 : 32,
            controller.signal,
          );
          while (!controller.signal.aborted) {
            const end = page.passages.findIndex(passage => passage.id === citation.end.passage_id);
            if (end >= 0) {
              const passage = page.passages[end]!;
              let next = page.passages[end + 1];
              if (!next && passage.ordinal + 1 < page.total)
                next = (
                  await options.workshop.api.passages(citation.snapshot_id, passage.ordinal + 1, 1, controller.signal)
                ).passages[0];
              return [passage.text.slice(citation.end.offset), next?.text ?? ''].filter(text => text.trim());
            }
            const last = page.passages.at(-1);
            if (!last || last.ordinal + 1 >= page.total) throw new Error('The highlighted passage could not be found.');
            page = await options.workshop.api.passages(citation.snapshot_id, last.ordinal + 1, 32, controller.signal);
          }
          return [];
        };
        void continuation().then(
          passages => {
            if (!controller.signal.aborted) {
              setFollowingPassage(passages);
              setFollowingLoading(false);
            }
          },
          reason => {
            if (!controller.signal.aborted) {
              setFollowingError(reason instanceof Error ? reason.message : String(reason));
              setFollowingLoading(false);
            }
          },
        );
        onCleanup(() => controller.abort());
      },
    ),
  );

  const tagOptions = createMemo(() =>
    [...new Set([...(options.highlights()?.rows.flatMap(row => row.tags) ?? []), ...options.view().tags])]
      .sort()
      .filter(tag => tag.toLocaleLowerCase().includes(tagQuery().toLocaleLowerCase())),
  );

  // Color facets ignore the selected colors but retain the other filters, so a zero-match choice never hides the alternatives.
  const highlightFacetKey = createMemo(() =>
    options.target().tab === 'highlights'
      ? JSON.stringify([
          options.target().unprocessedOnly,
          options.target().tags,
          highlightSource(),
          highlightChapter(),
          options.workshop.changed('library'),
          options.refresh(),
        ])
      : false,
  );
  const [highlightFacets] = createResource(highlightFacetKey, async key => {
    const [unprocessed, tags, source_id, chapter] = JSON.parse(key) as [
      boolean,
      string[],
      string | null,
      string | null,
    ];
    if (chapter !== null) {
      const result = await options.workshop.api.highlights({ unprocessed, tags, source_id, limit: null });
      const counts = new Map<string, number>();
      for (const row of result.rows) {
        if (row.citation.chapter_title !== chapter) continue;
        const color = row.color ?? 'none';
        counts.set(color, (counts.get(color) ?? 0) + 1);
      }
      return counts;
    }
    return new Map(
      await Promise.all(
        [...highlightColors, 'none'].map(async color => {
          const result = await options.workshop.api.highlights({
            unprocessed,
            tags,
            source_id,
            colors: [color],
            limit: 0,
          });
          return [color, result.total] as const;
        }),
      ),
    );
  });

  const highlightActions = createHighlightActions(
    options.workshop,
    options.workshop ? (target, beside) => options.openSource(target, beside) : () => {},
    options.setCommandError,
    row => {
      if (row.processed) return;
      const unprocessedOnly = options.view().unprocessedOnly;
      const next = nextUnprocessedHighlight(highlightQueue(), row.citation.id);
      batch(() => {
        options.setHighlights(
          previous =>
            previous && {
              ...previous,
              total: unprocessedOnly ? Math.max(0, previous.total - 1) : previous.total,
              rows: unprocessedOnly
                ? previous.rows.filter(value => value.citation.id !== row.citation.id)
                : previous.rows.map(value =>
                    value.citation.id === row.citation.id ? { ...value, processed: true, triage: 'processed' } : value,
                  ),
            },
        );
        setSelectedHighlightId(next ?? (unprocessedOnly ? null : row.citation.id));
        if (!next && unprocessedOnly) setHighlightPassageOpen(false);
      });
    },
  );

  createEffect(
    on(options.highlights, result => {
      if (result)
        void highlightActions.prepare(result.rows).catch(reason => {
          if (!options.disposed()) options.setCommandError(reason instanceof Error ? reason.message : String(reason));
        });
    }),
  );

  function chooseHighlight(row: HighlightRow) {
    setSelectedHighlightId(row.citation.id);
    if (options.coverLayout()) {
      setHighlightPassageOpen(true);
      queueMicrotask(() =>
        options.scroll()?.querySelector<HTMLButtonElement>('.library-back-highlights')?.focus({ preventScroll: true }),
      );
    }
  }

  function closeHighlightPassage() {
    setHighlightPassageOpen(false);
    queueMicrotask(() =>
      Array.from(options.scroll()?.querySelectorAll<HTMLButtonElement>('[data-library-row]') ?? [])
        .find(button => button.dataset.libraryRow === selectedHighlightId())
        ?.focus(),
    );
  }

  function stepHighlight(direction: number) {
    const row = highlightQueue()[highlightIndex() + direction];
    if (row) setSelectedHighlightId(row.citation.id);
  }

  async function runHighlight(row: HighlightRow, action: 'triage' | 'note' | 'card' | 'tag') {
    if (highlightBusy()) return;
    options.setCommandError('');
    setHighlightBusy(true);
    try {
      const actions = await highlightActions(row);
      if (options.disposed()) return;
      if (action === 'triage') await actions.toggleProcessed();
      else if (action === 'note') actions.openNote();
      else if (action === 'card') actions.makeCard();
      else actions.tag();
    } catch (reason) {
      if (!options.disposed()) options.setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!options.disposed()) setHighlightBusy(false);
    }
  }

  function toggleHighlightColor(color: string) {
    const colors = options.target().colors;
    options.update({
      colors: colors.includes(color) ? colors.filter(value => value !== color) : [...colors, color],
      scroll: 0,
    });
  }

  async function undoHighlight() {
    options.setCommandError('');
    try {
      await highlightActions.undo();
    } catch (reason) {
      if (!options.disposed()) options.setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function highlightMenu(row: HighlightRow, anchor: HTMLElement) {
    options.setCommandError('');
    try {
      const actions = await highlightActions(
        row,
        `“${row.citation.quote}” · ${row.source_title}, ${row.citation.chapter_title ?? `¶${row.citation.ordinal + 1}`}`,
        anchor,
      );
      if (!options.disposed() && anchor.isConnected)
        options.openMenu(anchor, 'Actions for highlight', [
          ...actions.secondaryItems,
          {
            label: 'Color',
            shortcut: '1–5',
            submenu: () => ({
              title: 'Highlight color',
              items: [...highlightColors, null].map(color => ({
                label: color ? color[0]!.toUpperCase() + color.slice(1) : 'No color',
                shortcut: color ? String(highlightColors.indexOf(color) + 1) : undefined,
                key: color ? String(highlightColors.indexOf(color) + 1) : '0',
                checked: row.color === color,
                action: () => actions.setColor(color),
              })),
            }),
          },
          {
            label: 'Undo',
            icon: 'undo',
            shortcut: '⌘Z',
            disabledReason: highlightActions.canUndo() ? undefined : 'No highlight changes to undo',
            action: () => {
              void undoHighlight();
            },
          },
          {
            label: 'Open in reader',
            shortcut: 'O',
            key: 'o',
            action: event =>
              options.openSource(
                {
                  kind: 'reader',
                  sourceId: row.citation.source_id,
                  snapshotId: row.citation.snapshot_id,
                  citationId: row.citation.id,
                },
                event ? opensBeside(event) : false,
              ),
          },
        ]);
    } catch (reason) {
      if (!options.disposed()) options.setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function highlightKey(event: KeyboardEvent) {
    if (
      !options.active() ||
      options.view().tab !== 'highlights' ||
      event.defaultPrevented ||
      event.isComposing ||
      options.hasOpenPopup() ||
      document.querySelector('.popup:not([inert])')
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest('.pane[data-pane]');
    if (pane && pane.getAttribute('data-pane') !== options.pane) return;
    if (
      target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    const key = event.key.toLowerCase();
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'z') {
      if (!highlightActions.canUndo()) return;
      event.preventDefault();
      event.stopPropagation();
      void undoHighlight();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const rows = highlightQueue(),
      row = selectedHighlight();
    if (!row) return;
    if (['j', 'k', 'arrowdown', 'arrowup', 'home', 'end'].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      const next =
        key === 'home'
          ? 0
          : key === 'end'
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, highlightIndex() + (key === 'j' || key === 'arrowdown' ? 1 : -1)));
      const id = rows[next]?.citation.id;
      if (!id) return;
      setSelectedHighlightId(id);
      Array.from(options.scroll()?.querySelectorAll<HTMLButtonElement>('[data-library-row]') ?? [])
        .find(button => button.dataset.libraryRow === id)
        ?.focus();
      return;
    }
    if (highlightBusy()) return;
    const actions = { e: 'triage', n: 'note', c: 'card', t: 'tag' } as const;
    const color = highlightColors[Number(key) - 1];
    if (key in actions) {
      event.preventDefault();
      event.stopPropagation();
      void runHighlight(row, actions[key as keyof typeof actions]);
    } else if (color && /^[1-5]$/.test(key)) {
      event.preventDefault();
      event.stopPropagation();
      void highlightActions(row)
        .then(itemActions => itemActions.setColor(color))
        .catch(reason => options.setCommandError(reason instanceof Error ? reason.message : String(reason)));
    } else if (key === 'o') {
      event.preventDefault();
      event.stopPropagation();
      options.openSource(
        {
          kind: 'reader',
          sourceId: row.citation.source_id,
          snapshotId: row.citation.snapshot_id,
          citationId: row.citation.id,
        },
        false,
      );
    }
  }

  onMount(() => {
    document.addEventListener('keydown', highlightKey);
    onCleanup(() => document.removeEventListener('keydown', highlightKey));
  });

  return {
    unprocessedCount,
    highlightCount,
    countError,
    tagQuery,
    setTagQuery,
    tagOptions,
    highlightGroups,
    highlightSource,
    setHighlightSource,
    highlightChapter,
    setHighlightChapter,
    selectedHighlightId,
    highlightPassageOpen,
    highlightBusy,
    scopedHighlightGroups,
    chapterOptions,
    highlightQueue,
    highlightFilterCount,
    selectedHighlight,
    highlightIndex,
    followingPassage,
    followingError,
    followingLoading,
    highlightFacets,
    highlightActions,
    chooseHighlight,
    closeHighlightPassage,
    stepHighlight,
    runHighlight,
    toggleHighlightColor,
    undoHighlight,
    highlightMenu,
  };
}

export function HighlightControls(props: {
  unprocessedOnly: boolean;
  unprocessedCount: number | undefined;
  highlightDesk: boolean;
  filterCount: number;
  showUndo: boolean;
  onUnprocessed(only: boolean): void;
  onOpenFilters(anchor: HTMLElement): void;
  onUndo(): void;
}) {
  return (
    <div class="library-filter library-highlight-controls">
      <div class="library-tabs mode-tabs tab-strip" role="group" aria-label="Highlight processing">
        <Button aria-pressed={props.unprocessedOnly} onClick={() => props.onUnprocessed(true)}>
          Unprocessed
          <Show when={props.unprocessedCount}>
            <span class="library-count">{props.unprocessedCount}</span>
          </Show>
        </Button>
        <Button aria-pressed={!props.unprocessedOnly} onClick={() => props.onUnprocessed(false)}>
          All
        </Button>
      </div>
      <Show when={props.highlightDesk}>
        <Button
          class="library-highlight-filters"
          icon="browse"
          aria-haspopup="dialog"
          aria-pressed={props.filterCount > 0}
          onClick={event => props.onOpenFilters(event.currentTarget)}
        >
          Filters
          <Show when={props.filterCount}>
            <span class="library-count">{props.filterCount}</span>
          </Show>
        </Button>
      </Show>
      <Show when={props.showUndo}>
        <Button class="library-highlight-toolbar-undo" icon="undo" shortcut="⌘Z" onClick={props.onUndo}>
          Undo <kbd>⌘Z</kbd>
        </Button>
      </Show>
    </div>
  );
}

export function HighlightsTriageView(props: {
  workshop: WorkshopClient;
  triage: ReturnType<typeof createHighlightsTriage>;
  highlights: HighlightResult | undefined;
  unprocessedOnly: boolean;
  colors: string[];
  tags: string[];
  coverLayout: boolean;
  onClearFilters(): void;
  onOpenSource(target: OpenTarget, beside: boolean): void;
}) {
  let passageScroll!: HTMLDivElement;
  createEffect(
    on(
      () => props.triage.selectedHighlight()?.citation.id,
      () => {
        if (passageScroll) passageScroll.scrollTop = 0;
      },
    ),
  );
  const timeZone = () => props.workshop.settings()?.time_zone ?? 'UTC';

  return (
    <Show
      when={props.highlights?.rows.length}
      fallback={
        <div class="library-empty">
          <p>
            {highlightEmptyMessage(
              props.triage.highlightCount(),
              props.unprocessedOnly,
              !!(props.colors.length || props.tags.length),
            )}
          </p>
          <Show when={props.colors.length || props.tags.length}>
            <Button onClick={props.onClearFilters}>Clear filters</Button>
          </Show>
        </div>
      }
    >
      <div class="library-highlights-workbench">
        <section class="library-highlight-queue" aria-label="Highlight queue">
          <div class="library-highlight-queue-scroll">
            <Show when={!props.triage.highlightQueue().length}>
              <div class="library-empty">
                <p>No matching highlights in this section.</p>
                <Button
                  onClick={() => {
                    props.triage.setHighlightSource(null);
                    props.triage.setHighlightChapter(null);
                  }}
                >
                  All sections
                </Button>
              </div>
            </Show>
            <For each={props.triage.scopedHighlightGroups()}>
              {group => (
                <section class="library-highlight-group">
                  <div class="library-highlight-heading">
                    <Button
                      title={group.title}
                      onClick={() => {
                        props.triage.setHighlightSource(group.sourceId);
                        props.triage.setHighlightChapter(null);
                      }}
                    >
                      {group.title}
                    </Button>
                    <span class="section-rule" />
                    <span>{group.rows.length}</span>
                  </div>
                  <For
                    each={highlightChapters(group.rows).filter(
                      chapter =>
                        props.triage.highlightChapter() === null || chapter.title === props.triage.highlightChapter(),
                    )}
                  >
                    {chapter => (
                      <>
                        <Show when={highlightChapterHeading(chapter)}>
                          {heading => <h3 class="library-highlight-chapter">{contentsTitle(heading())}</h3>}
                        </Show>
                        <div role="list">
                          <For each={chapter.rows}>
                            {row => (
                              <div
                                role="listitem"
                                onPointerEnter={() => setLinkedCitation(row.citation.id)}
                                onPointerLeave={() => setLinkedCitation(null)}
                              >
                                <Button
                                  class="library-highlight"
                                  aria-current={
                                    props.triage.selectedHighlightId() === row.citation.id ? 'true' : undefined
                                  }
                                  data-library-row={row.citation.id}
                                  style={{
                                    '--highlight-bar': row.color ? `var(--highlight-${row.color})` : 'var(--faint)',
                                  }}
                                  onClick={() => props.triage.chooseHighlight(row)}
                                >
                                  <span class="library-highlight-text">{row.citation.quote}</span>
                                  <span class="library-highlight-details">
                                    <span class="library-highlight-meta">
                                      {highlightMeta(row, timeZone())}
                                      <Show when={(props.triage.highlightActions.noteCount(row) ?? 0) > 0}>
                                        {' '}
                                        · {props.triage.highlightActions.noteCount(row)}{' '}
                                        {props.triage.highlightActions.noteCount(row) === 1 ? 'atom' : 'atoms'}
                                      </Show>
                                      <Show when={!props.unprocessedOnly}>
                                        {' '}
                                        · {row.processed ? 'Processed' : 'Unprocessed'}
                                      </Show>
                                    </span>
                                    <Show when={row.block.page.id !== row.citation.source_id}>
                                      <span class="library-highlight-meta library-highlight-filed">
                                        In {row.block.page.text}
                                      </span>
                                    </Show>
                                  </span>
                                  <Show when={row.tags.length}>
                                    <span class="library-highlight-tags">
                                      <For each={row.tags}>{tag => <span class="outline-tag">#{tag}</span>}</For>
                                    </span>
                                  </Show>
                                </Button>
                              </div>
                            )}
                          </For>
                        </div>
                      </>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
          <footer class="library-highlight-queue-dock">
            <span class="library-highlight-meta">
              {props.triage.scopedHighlightGroups().length}{' '}
              {props.triage.scopedHighlightGroups().length === 1 ? 'source' : 'sources'} ·{' '}
              {props.triage.highlightQueue().length}{' '}
              {props.triage.highlightQueue().length === 1 ? 'highlight' : 'highlights'}
              <Show when={(props.highlights?.total ?? 0) > (props.highlights?.rows.length ?? 0)}>
                {' '}
                · {props.highlights?.rows.length} of {props.highlights?.total} loaded
              </Show>
            </span>
            <Button
              class="bordered library-mark-processed"
              disabled={!props.triage.selectedHighlight()}
              onClick={() => {
                const row = props.triage.selectedHighlight();
                if (row) props.triage.chooseHighlight(row);
              }}
            >
              Process selected
              <Icon name="right" />
            </Button>
          </footer>
        </section>
        <Show when={props.triage.selectedHighlight()}>
          {value => {
            const row = value;
            const colorStyle = () => ({
              '--highlight-bar': row().color ? `var(--highlight-${row().color})` : 'var(--faint)',
            });
            return (
              <section class="library-highlight-passage" aria-label="Selected highlight">
                <header class="library-passage-heading">
                  <div class="library-passage-topline">
                    <Button class="library-back-highlights" icon="left" onClick={props.triage.closeHighlightPassage}>
                      Back to highlights
                    </Button>
                    <span class="library-highlight-meta">
                      {props.coverLayout
                        ? props.unprocessedOnly
                          ? 'Unprocessed'
                          : 'All highlights'
                        : `Selected highlight · ${props.triage.highlightIndex() + 1} of ${props.triage.highlightQueue().length}`}
                    </span>
                  </div>
                  <h2>{row().source_title}</h2>
                  <Show
                    when={
                      row().citation.chapter_title &&
                      row().citation.quote.trim() !== row().citation.chapter_title?.trim()
                    }
                  >
                    <p class="library-highlight-meta">{contentsTitle(row().citation.chapter_title!)}</p>
                  </Show>
                </header>
                <div
                  ref={passageScroll}
                  class="library-passage-scroll"
                  classList={{ 'library-passage-has-context': props.triage.followingPassage().length > 0 }}
                >
                  <Show when={highlightProse(row().block.block.text) !== highlightProse(row().citation.quote)}>
                    <div class="library-highlight-authored">
                      <BlockText
                        text={highlightProse(row().block.block.text)}
                        workshop={props.workshop}
                        interactive={false}
                      />
                    </div>
                  </Show>
                  <blockquote class="library-passage-quote" style={colorStyle()}>
                    {row().citation.quote}
                  </blockquote>
                  <p class="library-highlight-meta">
                    {highlightMeta(row(), timeZone())} ·{' '}
                    {props.triage.highlightActions.noteCount(row()) === undefined
                      ? 'Loading atoms…'
                      : props.triage.highlightActions.noteCount(row())
                        ? `${props.triage.highlightActions.noteCount(row())} ${props.triage.highlightActions.noteCount(row()) === 1 ? 'atom' : 'atoms'}`
                        : 'No atoms'}
                  </p>
                  <Show when={row().block.page.id !== row().citation.source_id}>
                    <Button
                      class="library-highlight-filed"
                      onClick={event =>
                        props.onOpenSource(
                          { kind: 'page', pageId: row().block.page.id, blockId: row().block.block.id },
                          opensBeside(event),
                        )
                      }
                    >
                      In {row().block.page.text}
                    </Button>
                  </Show>
                  <Show when={row().tags.length}>
                    <div class="library-highlight-tags">
                      <For each={row().tags}>{tag => <span class="outline-tag">#{tag}</span>}</For>
                    </div>
                  </Show>
                  <Show when={props.triage.followingPassage().length}>
                    <div class="library-passage-context">
                      <h3>Passage continues</h3>
                      <For each={props.triage.followingPassage()}>{passage => <p>{passage}</p>}</For>
                    </div>
                  </Show>
                  <Show when={props.triage.followingLoading()}>
                    <p class="library-highlight-meta" role="status">
                      Loading passage…
                    </p>
                  </Show>
                  <Show when={props.triage.followingError()}>
                    <p class="library-error" role="alert">
                      {props.triage.followingError()}
                    </p>
                  </Show>
                </div>
                <footer class="library-highlight-dock">
                  <div class="library-passage-pager">
                    <Button
                      icon="left"
                      shortcut="↑ K"
                      disabled={props.triage.highlightIndex() <= 0}
                      onClick={() => props.triage.stepHighlight(-1)}
                    >
                      Previous <kbd>↑ K</kbd>
                    </Button>
                    <span class="library-highlight-meta">
                      {props.triage.highlightIndex() + 1} of {props.triage.highlightQueue().length}
                    </span>
                    <Button
                      shortcut="J ↓"
                      disabled={props.triage.highlightIndex() >= props.triage.highlightQueue().length - 1}
                      onClick={() => props.triage.stepHighlight(1)}
                    >
                      Next <kbd>J ↓</kbd>
                      <Icon name="right" />
                    </Button>
                  </div>
                  <div class="library-highlight-primary">
                    <Button
                      class="bordered library-mark-processed"
                      icon="check"
                      shortcut="E"
                      aria-disabled={props.triage.highlightBusy() || undefined}
                      onClick={() => {
                        if (!props.triage.highlightBusy()) void props.triage.runHighlight(row(), 'triage');
                      }}
                    >
                      {row().processed ? 'Mark unprocessed' : 'Mark processed'}
                      <kbd>E</kbd>
                    </Button>
                    <Button
                      class="bordered"
                      icon="note"
                      shortcut="N"
                      aria-disabled={props.triage.highlightBusy() || undefined}
                      onClick={() => {
                        if (!props.triage.highlightBusy()) void props.triage.runHighlight(row(), 'note');
                      }}
                    >
                      {props.triage.highlightActions.noteCount(row()) ? 'Open atom' : 'Add atom'}
                      <kbd>N</kbd>
                    </Button>
                    <Button
                      class="bordered"
                      icon="review"
                      shortcut="C"
                      aria-disabled={props.triage.highlightBusy() || undefined}
                      onClick={() => {
                        if (!props.triage.highlightBusy()) void props.triage.runHighlight(row(), 'card');
                      }}
                    >
                      Make card<kbd>C</kbd>
                    </Button>
                    <Button
                      icon="more"
                      label="More highlight actions"
                      aria-haspopup="menu"
                      aria-disabled={props.triage.highlightBusy() || undefined}
                      onClick={event => {
                        if (!props.triage.highlightBusy()) void props.triage.highlightMenu(row(), event.currentTarget);
                      }}
                    />
                  </div>
                </footer>
              </section>
            );
          }}
        </Show>
      </div>
    </Show>
  );
}

export function HighlightFilterPopups(props: {
  kind: HighlightFilterPopupKind;
  anchor: HTMLElement;
  coverLayout: boolean;
  loading: boolean;
  highlights: HighlightResult | undefined;
  targetTags: string[];
  targetColors: string[];
  browseQuery: string;
  onBrowseQuery: Setter<string>;
  triage: ReturnType<typeof createHighlightsTriage>;
  onSwitchKind(kind: HighlightFilterPopupKind): void;
  onUpdate(patch: Partial<LibraryViewState>): void;
  onDismiss(): void;
}) {
  if (props.kind === 'highlight-sources')
    return (
      <Picker
        anchor={props.anchor}
        placement={props.coverLayout ? 'sheet' : 'anchor'}
        label="Choose highlight source"
        placeholder="Find a source"
        query={props.browseQuery}
        onQuery={props.onBrowseQuery}
        items={[{ sourceId: null, title: 'All sources' }, ...props.triage.highlightGroups()].filter(group =>
          group.title.toLocaleLowerCase().includes(props.browseQuery.toLocaleLowerCase()),
        )}
        key={group => group.sourceId ?? 'all'}
        row={group => (
          <>
            <Show when={props.triage.highlightSource() === group.sourceId}>
              <Icon name="check" />
            </Show>
            <span>{group.title}</span>
          </>
        )}
        onPick={group => {
          props.triage.setHighlightSource(group.sourceId);
          props.triage.setHighlightChapter(null);
          props.onBrowseQuery('');
          props.onSwitchKind('highlight-filters');
        }}
        empty="No matching sources"
        onDismiss={props.onDismiss}
      />
    );
  if (props.kind === 'highlight-chapters')
    return (
      <Picker
        anchor={props.anchor}
        placement={props.coverLayout ? 'sheet' : 'anchor'}
        label="Choose highlight section"
        placeholder="Find a section"
        query={props.browseQuery}
        onQuery={props.onBrowseQuery}
        items={[null, ...props.triage.chapterOptions()].filter(title =>
          (title ?? 'All sections').toLocaleLowerCase().includes(props.browseQuery.toLocaleLowerCase()),
        )}
        key={title => title ?? 'all'}
        row={title => (
          <>
            <Show when={props.triage.highlightChapter() === title}>
              <Icon name="check" />
            </Show>
            <span>{title ?? 'All sections'}</span>
          </>
        )}
        onPick={title => {
          props.triage.setHighlightChapter(title);
          props.onBrowseQuery('');
          props.onSwitchKind('highlight-filters');
        }}
        empty="No matching sections"
        onDismiss={props.onDismiss}
      />
    );
  if (props.kind === 'tags')
    return (
      <Picker
        anchor={props.anchor}
        label="Filter highlight tags"
        placeholder="Find a tag"
        query={props.triage.tagQuery()}
        onQuery={props.triage.setTagQuery}
        items={props.triage.tagOptions()}
        key={tag => tag}
        row={tag => (
          <>
            <Show when={props.targetTags.includes(tag)}>
              <Icon name="check" />
            </Show>
            <span class="outline-tag">#{tag}</span>
          </>
        )}
        onPick={tag => {
          const tags = props.targetTags;
          props.onUpdate({
            tags: tags.includes(tag) ? tags.filter(value => value !== tag) : [...tags, tag],
            scroll: 0,
          });
          props.onDismiss();
        }}
        empty="No tags in these highlights"
        onDismiss={props.onDismiss}
      />
    );
  return (
    <Popup
      anchor={props.anchor}
      label="Filter highlights"
      class="library-highlight-filter-popup"
      placement={props.coverLayout ? 'sheet' : 'anchor'}
      width={360}
      onDismiss={props.onDismiss}
    >
      <header class="library-highlight-filter-head">
        <h2>Filter highlights</h2>
        <Show when={!props.coverLayout}>
          <Button icon="close" label="Close filters" onClick={props.onDismiss} />
        </Show>
      </header>
      <h3 class="library-highlight-filter-label">Source</h3>
      <Button
        class="bordered library-highlight-scope"
        aria-haspopup="listbox"
        onClick={() => {
          props.onBrowseQuery('');
          props.onSwitchKind('highlight-sources');
        }}
      >
        {props.triage.highlightGroups().find(group => group.sourceId === props.triage.highlightSource())?.title ??
          'All sources'}
        <Icon name="down" />
      </Button>
      <h3 class="library-highlight-filter-label">Section</h3>
      <Button
        class="bordered library-highlight-scope"
        aria-haspopup="listbox"
        onClick={() => {
          props.onBrowseQuery('');
          props.onSwitchKind('highlight-chapters');
        }}
      >
        {props.triage.highlightChapter() ?? 'All sections'}
        <Icon name="down" />
      </Button>
      <h3 class="library-highlight-filter-label">Color</h3>
      <div class="library-highlight-filter-colors" role="group" aria-label="Highlight colors">
        <For each={[...highlightColors, 'none']}>
          {color => (
            <Button
              class="bordered"
              aria-pressed={props.targetColors.includes(color)}
              onClick={() => props.triage.toggleHighlightColor(color)}
            >
              <span
                class="library-highlight-color-bar"
                style={{ '--highlight-bar': color === 'none' ? 'var(--faint)' : `var(--highlight-${color})` }}
                aria-hidden="true"
              />
              {color === 'none' ? 'No color' : color[0]!.toUpperCase() + color.slice(1)}
              <span class="library-count">
                {props.triage.highlightFacets.loading && !props.triage.highlightFacets.latest
                  ? '…'
                  : props.triage.highlightFacets.error
                    ? '—'
                    : (props.triage.highlightFacets()?.get(color) ?? 0)}
              </span>
            </Button>
          )}
        </For>
      </div>
      <Show when={props.triage.highlightFacets.error}>
        <p class="library-error" role="alert">
          {String(props.triage.highlightFacets.error)}
        </p>
      </Show>
      <h3 class="library-highlight-filter-label">Tags</h3>
      <Show
        when={props.triage.tagOptions().length}
        fallback={<p class="library-message">No tags on these highlights.</p>}
      >
        <Button
          aria-haspopup="dialog"
          onClick={() => {
            props.triage.setTagQuery('');
            props.onSwitchKind('tags');
          }}
        >
          Choose tags
          <Icon name="down" />
        </Button>
        <div class="library-highlight-filter-tags">
          <For each={props.targetTags}>
            {tag => (
              <Button
                class="outline-tag"
                onClick={() => props.onUpdate({ tags: props.targetTags.filter(value => value !== tag), scroll: 0 })}
              >
                #{tag}
                <Icon name="close" />
              </Button>
            )}
          </For>
        </div>
      </Show>
      <footer class="library-highlight-filter-footer">
        <Show when={props.triage.highlightFilterCount()}>
          <Button
            onClick={() => {
              props.triage.setHighlightSource(null);
              props.triage.setHighlightChapter(null);
              props.onUpdate({ colors: [], tags: [], scroll: 0 });
            }}
          >
            Clear filters
          </Button>
        </Show>
        <Button class="bordered library-mark-processed" onClick={props.onDismiss}>
          {props.loading || !props.highlights
            ? 'Show highlights'
            : `Show ${props.triage.highlightQueue().length} ${props.triage.highlightQueue().length === 1 ? 'highlight' : 'highlights'}`}
        </Button>
      </footer>
    </Popup>
  );
}
