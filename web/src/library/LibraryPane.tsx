import { listOpensBeside } from '../core/beside';
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
  untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { ulid } from 'ulid';
import { exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type {
  Block,
  HighlightResult,
  IngestJob,
  LibraryQuery,
  LibraryResult,
  LibraryRow,
  LibraryView,
  ReadingState,
} from '../api/types';
import type { WorkshopClient } from '../document/contract';
import { DEMO } from '../core/mode';
import type { LibraryGroup, LibraryTab, LibraryViewState, OpenTarget, PaneId } from '../core/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { NavButton, NavEnd } from '../ui/NavBar';
import { openContextMenu } from '../ui/context-menu';
import { downloadBlob } from '../ui/download';
import { createSlowFlag } from '../ui/loading';
import { createSavedViewController, DeleteSavedViewPopup, SavedViewNamePopup } from '../workflows/saved-views';
import { crossfade, glide } from '../ui/pane-motion';
import {
  formatProgress,
  groupSources,
  keepRows,
  libraryQuery,
  recentJobs,
  selectSources,
  sourceByline,
  sourceStateOperation,
  visibleJobs,
} from './query';
import { formatSourceValue } from '../outline/source';
import { displayTitle } from '../outline/names';
import { setLinkedCitation } from './highlights';
import { AddSheet } from './AddSheet';
import { createCollectionActions } from './Collections';
import { changeCollectionMembers, collectionPages, sourceCollections } from '../document/collections';
import {
  browseFields,
  browseRailMinimum,
  clearedFilters,
  computeBrowseEntries,
  LibraryBrowsePicker,
  LibraryBrowseRail,
  LibraryChosenFilters,
  railFields,
  type BrowseEntry,
  type BrowseField,
} from './LibraryBrowseRail';
import { CollectionPopups, CollectionsToolbarHeading, CollectionsView, type CollectionCard } from './CollectionsView';
import {
  createHighlightsTriage,
  HighlightControls,
  HighlightFilterPopups,
  HighlightsTriageView,
} from './HighlightsTriageView';
import { LibrarySourcesView, stateActions } from './LibrarySourcesView';
import { lazy as solidLazy } from 'solid-js';
import '../ui/covers.css';
import '../ui/chips.css';
import './library.css';

const MetadataInspector = solidLazy(() =>
  import('./MetadataInspector').then(module => ({ default: module.MetadataInspector })),
);

export interface LibraryPaneProps {
  pane: PaneId;
  view: LibraryViewState;
  workshop: WorkshopClient;
  active: boolean;
  /** A pane is open to the right of this list. */
  neighbour?: boolean;
  /** One-time request to open the existing Add sheet on arrival. */
  add?: boolean;
  onAddOpened?(): void;
  /** One-time request from a source page to inspect its metadata. */
  details?: readonly string[];
  onDetailsOpened?(): void;
  onSaveState?(state: 'saved' | 'saving' | 'error', message?: string): void;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: LibraryViewState): void;
  /** Delete sources with their highlights; the shell offers undo. */
  onDeleteSources(sources: { id: string; title: string }[]): Promise<void>;
}

const groupings: { id: LibraryGroup; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'author', label: 'Author' },
  { id: 'year', label: 'Year' },
  { id: 'decade', label: 'Decade' },
  { id: 'publisher', label: 'Publisher' },
  { id: 'language', label: 'Language' },
];

type LibraryPopup =
  | { kind: 'add'; anchor: HTMLElement }
  | { kind: 'tags'; anchor: HTMLElement }
  | { kind: 'highlight-filters'; anchor: HTMLElement }
  | { kind: 'highlight-sources'; anchor: HTMLElement }
  | { kind: 'highlight-chapters'; anchor: HTMLElement }
  | { kind: 'browse'; anchor: HTMLElement; field: BrowseField | null }
  | { kind: 'name'; anchor: HTMLElement; saved: LibraryView | null; id: string }
  | { kind: 'delete'; anchor: HTMLElement; saved: LibraryView }
  | { kind: 'delete-sources'; anchor: HTMLElement; sources: { id: string; title: string }[] }
  | { kind: 'collection-name'; anchor: HTMLElement; collection?: Block }
  | { kind: 'delete-collection'; anchor: HTMLElement; collection: Block }
  | { kind: 'collection-picker'; anchor: HTMLElement; sources: string[] }
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[]; source?: LibraryRow };
const tabs: { id: LibraryTab; label: string }[] = [
  { id: 'reading', label: 'Reading' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'all', label: 'All' },
  { id: 'collections', label: 'Collections' },
  { id: 'finished', label: 'Finished' },
  { id: 'abandoned', label: 'Abandoned' },
];
const sorts: { id: LibraryViewState['sort']; label: string }[] = [
  { id: 'added', label: 'Added' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
  { id: 'year', label: 'Year' },
  { id: 'last_read', label: 'Last read' },
  { id: 'progress', label: 'Progress' },
];

interface LibraryRead {
  library: LibraryResult;
  highlights?: HighlightResult;
}
interface LibraryCache {
  workshopId?: string;
  queries: Map<string, LibraryRead>;
  library?: LibraryResult;
  reading?: LibraryRow[];
  upNext?: LibraryRow[];
  unprocessedCount?: number;
  highlightCount?: number;
  views?: LibraryView[];
  collections?: Block[];
  collectionCards?: CollectionCard[];
}
// Reopening either pane paints its last read before the service refreshes it.
const libraryReads = new WeakMap<WorkshopClient, LibraryCache>();
function libraryPreferences(id?: string) {
  const tabKey = id ? `tessera.library.tab.${id}` : undefined;
  const layoutKey = id ? `tessera.library.layout.${id}` : undefined;
  const dismissedKey = id ? `tessera.library.dismissed.${id}` : undefined;
  let layout: 'list' | 'shelf' = 'list';
  let remembered: string | null = null;
  let dismissed: string[] = [];
  try {
    if (layoutKey && localStorage.getItem(layoutKey) === 'shelf') layout = 'shelf';
    if (tabKey) remembered = localStorage.getItem(tabKey);
    const stored: unknown = JSON.parse(dismissedKey ? (localStorage.getItem(dismissedKey) ?? '[]') : '[]');
    if (Array.isArray(stored)) dismissed = stored.filter((id): id is string => typeof id === 'string');
  } catch {
    /* Session-only preferences. */
  }
  return { tabKey, layoutKey, dismissedKey, layout, remembered, dismissed };
}

export function LibraryPane(props: LibraryPaneProps) {
  const cache: LibraryCache = libraryReads.get(props.workshop) ?? { queries: new Map<string, LibraryRead>() };
  libraryReads.set(props.workshop, cache);
  const preferences = libraryPreferences(cache.workshopId);
  const coverMedia = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
  const initialView = { ...props.view };
  if (cache.workshopId && !initialView.view && initialView.tab === 'inbox') {
    const remembered = preferences.remembered;
    const counts = cache.library?.counts;
    const initialTab = coverMedia.matches
      ? 'reading'
      : tabs.some(tab => tab.id === remembered)
        ? (remembered as LibraryTab)
        : counts
          ? counts.inbox
            ? 'inbox'
            : counts.reading
              ? 'reading'
              : 'all'
          : 'inbox';
    if (initialTab !== initialView.tab) {
      initialView.tab = initialTab;
      initialView.scroll = 0;
    }
  }
  // `view` is what the panel shows and `target` what the reader last chose. The toolbar answers a click at once; the
  // panel, its headings and filter chips change together, in one step, once the target's rows are ready.
  const [view, setView] = createSignal(initialView);
  const [target, setTarget] = createSignal(initialView);
  const [preferencesReady, setPreferencesReady] = createSignal(!!cache.workshopId);
  const tab = createMemo(() => view().tab);
  const text = createMemo(() => view().text);
  const collectionActions = createCollectionActions();
  const collectionsIndex = createMemo(() => tab() === 'collections' && !view().collection);
  const [collections] = createResource(
    () => props.workshop.changed('pages'),
    async () => {
      const result = await collectionPages(props.workshop.api);
      cache.collections = result;
      return result;
    },
    { initialValue: cache.collections },
  );
  const collection = createMemo(() => collections()?.find(page => page.id === view().collection));
  const [collectionCards] = createResource(
    () =>
      collectionsIndex() &&
      collections.latest && { pages: collections.latest, library: props.workshop.changed('library') },
    async ({ pages }) => {
      const result = await Promise.all(
        pages.map(async page => {
          const result = await props.workshop.api.library({ collection_id: page.id, limit: 4 });
          return { page, count: result.total, covers: result.rows };
        }),
      );
      cache.collectionCards = result;
      return result;
    },
    { initialValue: cache.collectionCards },
  );
  const sort = createMemo(() => view().sort);
  const unprocessedOnly = createMemo(() => view().unprocessedOnly);
  const colors = createMemo(() => view().colors);
  const tags = createMemo(() => view().tags);
  const filters = createMemo(() => view().filters);
  const group = createMemo(() => view().group);
  const filtered = createMemo(() => Object.values(filters()).some(values => values.length > 0));
  const [browseQuery, setBrowseQuery] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  function viewFields(query: LibraryQuery): Pick<LibraryViewState, 'tab' | 'text' | 'sort' | 'filters' | 'collection'> {
    return {
      tab: query.collection_id ? 'collections' : query.states?.length === 1 ? query.states[0]! : 'all',
      collection: query.collection_id ?? null,
      text: query.text ?? '',
      sort: query.sort ?? 'added',
      filters: {
        people: query.people ?? [],
        decades: query.decades ?? [],
        years: query.years ?? [],
        publishers: query.publishers ?? [],
        languages: query.languages ?? [],
      },
    };
  }
  const savedViews = createSavedViewController<LibraryView, LibraryQuery>({
    workshop: props.workshop,
    topic: 'library',
    viewId: () => target().view,
    initialViews: cache.views ?? [],
    list: signal => props.workshop.api.libraryViews(signal),
    saveOperation: ({ id, baseRevision, name, query }) => ({
      op: 'save_library_view',
      id,
      base_revision: baseRevision,
      name,
      query,
    }),
    deleteOperation: ({ id, baseRevision }) => ({
      op: 'delete_library_view',
      id,
      base_revision: baseRevision,
    }),
    onViewsLoaded: result => {
      cache.views = result;
      const id = target().view;
      if (!id) return;
      const found = result.find(value => value.id === id);
      if (found) update(viewFields(found.query));
      else update({ view: null });
    },
  });
  const { views, viewsError, deleted } = savedViews;
  const queryOf = (state: LibraryViewState) =>
    views().find(value => value.id === state.view)?.query ??
    libraryQuery({
      tab: state.tab,
      collection: state.collection,
      text: state.text,
      sort: state.sort,
      filters: state.filters,
    });
  const keyOf = (state: LibraryViewState) =>
    JSON.stringify([state.view, state.tab, queryOf(state), state.unprocessedOnly, state.colors, state.tags]);
  const currentQuery = createMemo(() => queryOf(view()));
  const queryKey = createMemo(() => keyOf(view()));
  const targetKey = createMemo(() => keyOf(target()));
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const inspecting = createMemo(() => inspectorOpen() && selected().size > 0 && tab() !== 'highlights');
  const selectedIds = createMemo(() => [...selected()]);
  // The phone shows covers whole; Select reveals the checkboxes, and a tap then toggles a source instead of opening it.
  const [selectMode, setSelectMode] = createSignal(false);
  const [narrowInspector, setNarrowInspector] = createSignal(false);
  let libraryHost!: HTMLDivElement;
  let inspectorScroll = 0;
  const [inspectorPortal, setInspectorPortal] = createSignal<HTMLElement>();
  const [sheetExpanded, setSheetExpanded] = createSignal(false);
  // The ledger makes room only once the card has something to show, and its parts glide over in the same frame.
  const [cardShown, setCardShown] = createSignal(false);
  const [inspectorShown, setInspectorShown] = createSignal(false);
  createEffect(
    on(
      () => inspecting() && cardShown(),
      open => {
        if (open === untrack(inspectorShown)) return;
        glide(
          () => [...libraryHost.querySelectorAll<HTMLElement>('.library-toolbar > *, .library-scroll > .library-main')],
          () => setInspectorShown(open),
        );
      },
    ),
  );
  let selectionAnchor: string | null = null;
  createEffect(
    on(queryKey, () => {
      setSelected(new Set<string>());
      setInspectorOpen(false);
      setSelectMode(false);
      selectionAnchor = null;
    }),
  );
  const initialRead = cache.queries.get(queryKey())?.library ? cache.queries.get(queryKey()) : undefined;
  const [loadedKey, setLoadedKey] = createSignal(initialRead ? queryKey() : '');
  const [library, setLibrary] = createSignal<LibraryResult | undefined>(initialRead?.library);
  // Keep each row kind until its replacement arrives, even when the other tab loads.
  const [sourceRows, setSourceRows] = createSignal<LibraryRow[] | undefined>(
    initialRead?.library && tab() !== 'highlights' ? initialRead.library.rows : undefined,
  );
  const [highlights, setHighlights] = createSignal<HighlightResult | undefined>(initialRead?.highlights);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const displayedSources = createMemo(() => (tab() === 'highlights' || error() ? [] : (sourceRows() ?? [])));
  const hasResult = createMemo(() =>
    collectionsIndex()
      ? collectionCards.latest !== undefined
      : tab() === 'highlights'
        ? highlights() !== undefined
        : sourceRows() !== undefined,
  );
  const groups = createMemo(() =>
    group() === 'none' || tab() === 'highlights'
      ? undefined
      : groupSources(displayedSources(), group() as Exclude<LibraryGroup, 'none'>),
  );
  const orderedSources = createMemo(() => groups()?.flatMap(value => value.rows) ?? displayedSources());
  const slowLoad = createSlowFlag(() => loading() && !hasResult());
  const slowCollections = createSlowFlag(
    () => !collectionCards.latest && (collections.loading || collectionCards.loading),
  );
  let requestedText = initialView.text;
  const [commandError, setCommandError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [popup, setPopup] = createSignal<LibraryPopup | null>(null);
  const [jobs, setJobs] = createSignal<IngestJob[]>([]);
  const [jobsError, setJobsError] = createSignal('');
  const [jobsRefresh, setJobsRefresh] = createSignal(0);
  const [retrying, setRetrying] = createSignal<string[]>([]);
  const [dismissedJobs, setDismissedJobs] = createSignal<Set<string>>(new Set(preferences.dismissed));
  let dismissedKey = preferences.dismissedKey;
  let tabKey = preferences.tabKey;
  let layoutKey = preferences.layoutKey;
  let tabChosen = false;
  // List or Shelf is a device preference per workshop, like the last tab.
  const [layout, setLayout] = createSignal<'list' | 'shelf'>(preferences.layout);
  const [coverLayout, setCoverLayout] = createSignal(coverMedia.matches);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const finishedDate = createMemo(
    () =>
      new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: props.workshop.settings()?.time_zone,
      }),
  );
  const coverChanged = () => setCoverLayout(coverMedia.matches);
  coverMedia.addEventListener('change', coverChanged);
  onCleanup(() => coverMedia.removeEventListener('change', coverChanged));
  let addButton: HTMLButtonElement | undefined;
  const primaryTabs = tabs.slice(0, 3);
  const overflowTabs = tabs.slice(3);
  // Every Reading source gets a card, including books not yet started; the cover adds its Inbox below.
  const [reading, setReading] = createSignal<LibraryRow[]>(cache.reading ?? []);
  const [upNext, setUpNext] = createSignal<LibraryRow[]>(cache.upNext ?? []);
  const [readingError, setReadingError] = createSignal('');
  createEffect(() => {
    if (!preferencesReady()) return;
    // Reading progress is written outside commits, so no topic names it; any change refreshes these cards.
    props.workshop.changeSequence();
    refresh();
    const includeInbox = coverLayout();
    const controller = new AbortController();
    // Cards follow the toolbar's sort; on the Reading tab they stand in for the rows.
    const { sort: order, direction } = libraryQuery({
      tab: 'reading',
      text: '',
      sort: sort(),
      filters: clearedFilters(),
      collection: null,
    });
    void props.workshop.api
      .library(
        { states: includeInbox ? ['reading', 'inbox'] : ['reading'], sort: order, direction, limit: 100000 },
        controller.signal,
      )
      .then(
        result => {
          if (controller.signal.aborted) return;
          cache.reading = keepRows(
            reading(),
            (result?.rows ?? []).filter(row => row.source.state === 'reading'),
          );
          cache.upNext = keepRows(
            upNext(),
            (result?.rows ?? []).filter(row => row.source.state === 'inbox'),
          );
          batch(() => {
            setReading(cache.reading!);
            setUpNext(cache.upNext!);
            setReadingError('');
          });
        },
        reason => {
          if (!controller.signal.aborted) setReadingError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    onCleanup(() => controller.abort());
  });
  // Reading now belongs to Reading, never a second copy above All.
  const showReading = createMemo(
    () => tab() === 'reading' && !view().collection && !text().trim() && !filtered() && !view().view,
  );
  // The cards give way to Shelf and explicit grouping; the phone keeps them.
  const readingCards = createMemo(
    () => showReading() && (coverLayout() || (layout() === 'list' && group() === 'none')),
  );
  const [openedSource, setOpenedSource] = createSignal<string>();
  /** On the cover screen a Reading now card goes straight back into the book, as Today's reading line does; its page stays in the card's menu. */
  function readingTarget(row: LibraryRow): OpenTarget {
    return coverLayout() && row.source.current_snapshot_id
      ? { kind: 'reader', sourceId: row.page.id }
      : { kind: 'page', pageId: row.page.id };
  }
  function openSource(target: OpenTarget, beside: boolean) {
    if (target.kind === 'page') setOpenedSource(target.pageId);
    // Keep this pane as the list when a pane is open to its right.
    props.onOpen(target, beside || listOpensBeside(null, !!props.neighbour));
  }
  function openAdd(anchor: HTMLElement) {
    if (DEMO) {
      fileInput.click();
      return;
    }
    setPopup({ kind: 'add', anchor });
  }
  onMount(() => {
    if (initialView.tab !== props.view.tab) props.onViewChange({ ...initialView });
    if (props.add) {
      openAdd(addButton ?? libraryHost);
      props.onAddOpened?.();
    }
    if (props.details?.length) {
      setSelected(new Set(props.details));
      setInspectorOpen(true);
      props.onDetailsOpened?.();
    }
    setInspectorPortal(libraryHost.closest<HTMLElement>('.pane') ?? undefined);
    // Below 1000 px the ledger beside a 460 px card cannot hold the selection bar on one line, so the card replaces the list.
    const measure = () => setNarrowInspector(libraryHost.clientWidth < 1000);
    const observer = new ResizeObserver(measure);
    observer.observe(libraryHost);
    measure();
    const viewport = window.visualViewport;
    const resizeSheet = () => {
      const height = viewport?.height ?? window.innerHeight;
      const keyboard = window.innerHeight - height - (viewport?.offsetTop ?? 0);
      const host = inspectorPortal();
      host?.style.setProperty('--inspector-viewport-height', `${height}px`);
      host?.style.setProperty('--inspector-keyboard-bottom', keyboard > 120 ? `${keyboard}px` : '0px');
      host?.classList.toggle('library-inspector-keyboard', keyboard > 120 && inspecting());
    };
    viewport?.addEventListener('resize', resizeSheet);
    resizeSheet();
    onCleanup(() => {
      observer.disconnect();
      viewport?.removeEventListener('resize', resizeSheet);
      inspectorPortal()?.classList.remove('library-inspector-keyboard');
    });
  });
  createEffect(() => {
    const controller = new AbortController();
    void props.workshop.api
      .workshop(controller.signal)
      .then(async info => {
        if (controller.signal.aborted) return;
        cache.workshopId = info.id;
        if (!untrack(preferencesReady)) {
          const stored = libraryPreferences(info.id);
          dismissedKey = stored.dismissedKey;
          tabKey = stored.tabKey;
          layoutKey = stored.layoutKey;
          batch(() => {
            setDismissedJobs(previous => new Set([...previous, ...stored.dismissed]));
            setLayout(stored.layout);
          });
          if (!tabChosen && !target().view && target().tab === 'inbox') {
            if (coverLayout()) update({ tab: 'reading', scroll: 0 });
            else if (tabs.some(tab => tab.id === stored.remembered))
              update({ tab: stored.remembered as LibraryTab, scroll: 0 });
            else {
              const result = await props.workshop.api.library({ limit: 0 }, controller.signal);
              if (!controller.signal.aborted && !tabChosen)
                update({ tab: result.counts.inbox ? 'inbox' : result.counts.reading ? 'reading' : 'all', scroll: 0 });
            }
          }
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreferencesReady(true);
      });
    onCleanup(() => controller.abort());
  });
  function chooseLayout(value: 'list' | 'shelf') {
    setLayout(value);
    try {
      if (layoutKey) localStorage.setItem(layoutKey, value);
    } catch {
      /* Session-only preference. */
    }
  }
  function dismissJob(id: string) {
    const next = new Set(dismissedJobs());
    next.add(id);
    setDismissedJobs(next);
    try {
      if (dismissedKey) localStorage.setItem(dismissedKey, JSON.stringify([...next]));
    } catch {
      /* The preference lasts for this tab. */
    }
  }
  const [failuresOpen, setFailuresOpen] = createSignal(false);
  const sourceMenuId = createMemo(() => {
    const state = popup();
    return state?.kind === 'menu' ? state.source?.page.id : undefined;
  });
  const doneJobs = new Set<string>();
  const lookup = (id: string) => props.workshop.lookup(id);
  const sourceTitles = createMemo(() => new Map(props.workshop.roots().map(root => [root.id, root.text])));
  // Failed jobs belong to the Inbox backlog; active jobs still show during ingestion.
  const shownJobs = createMemo(() =>
    tab() === 'highlights' || tab() === 'collections' || error()
      ? []
      : visibleJobs(
          jobs().filter(job => job.state !== 'failed'),
          new Set([...displayedSources().map(row => row.page.id), ...sourceTitles().keys()]),
        ),
  );
  const failedJobs = createMemo(() =>
    tab() === 'inbox' && !error() ? jobs().filter(job => job.state === 'failed' && !dismissedJobs().has(job.id)) : [],
  );
  let scroll!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let restoreScroll: number | null = initialView.scroll;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    setLinkedCitation(null);
  });

  const triage = createHighlightsTriage({
    pane: props.pane,
    active: () => props.active,
    workshop: props.workshop,
    view,
    target,
    refresh,
    coverLayout,
    hasOpenPopup: () => !!popup(),
    initialCounts: { unprocessed: cache.unprocessedCount, total: cache.highlightCount },
    onCountsLoaded: (unprocessed, total) => {
      cache.unprocessedCount = unprocessed;
      cache.highlightCount = total;
    },
    highlights,
    setHighlights,
    scroll: () => scroll,
    disposed: () => disposed,
    update: patch => update(patch),
    openSource,
    setCommandError,
    openMenu: (anchor, label, items) => setPopup({ kind: 'menu', anchor, label, items }),
  });
  const { unprocessedCount, highlightCount, countError, highlightPassageOpen, selectedHighlight, highlightActions } =
    triage;

  const browseEntries = createMemo<BrowseEntry[]>(() => computeBrowseEntries(library()?.facets));
  const sourceCount = createMemo(() => Object.values(library()?.counts ?? {}).reduce((sum, count) => sum + count, 0));
  // An empty result (a search, a filter, the Reading or Highlights tab with nothing in it) keeps the rail's column empty, so the measure and the search field stay where Inbox puts them.
  const emptyResult = createMemo(() =>
    tab() === 'highlights'
      ? highlights() !== undefined && !((highlightCount() ?? highlights()?.rows.length ?? 0) > 0)
      : hasResult() && !displayedSources().length,
  );
  const browseRail = createMemo(
    () =>
      sourceCount() >= browseRailMinimum &&
      !collectionsIndex() &&
      !inspectorShown() &&
      (tab() === 'highlights'
        ? emptyResult()
        : browseEntries().some(entry => railFields.some(section => section.field === entry.field)) || emptyResult()),
  );
  const noSources = createMemo(() => !!library() && sourceCount() === 0);
  // Highlights widens to the processing desk only once there are highlights to process; until then it keeps the other tabs' measure.
  const highlightDesk = createMemo(
    () => tab() === 'highlights' && (highlightCount() ?? highlights()?.rows.length ?? 0) > 0,
  );
  // The rail and Browse answer at once, so they read the chosen filters rather than the shown ones.
  const chosen = (field: BrowseField, value: string | number) =>
    (target().filters[field] as (string | number)[]).includes(value);
  const chosenFilters = createMemo(() =>
    browseFields.flatMap(({ field }) =>
      (filters()[field] as (string | number)[]).map(value => ({
        field,
        value,
        label:
          browseEntries().find(entry => entry.field === field && entry.value === value)?.label ??
          (field === 'people'
            ? displayTitle(sourceTitles().get(String(value)) ?? 'Unknown person', lookup)
            : field === 'decades'
              ? `${value}s`
              : field === 'languages'
                ? formatSourceValue('language', String(value))
                : String(value)),
      })),
    ),
  );
  function toggleFilter(field: BrowseField, value: string | number) {
    const filters = target().filters,
      values = filters[field] as (string | number)[];
    update({
      view: null,
      filters: {
        ...filters,
        [field]: values.includes(value) ? values.filter(item => item !== value) : [...values, value],
      },
      scroll: 0,
    });
  }
  // A view spanning several states names each row's state.
  const mixedStates = createMemo(() => currentQuery().states?.length !== 1);
  onMount(() => {
    if (hasResult()) {
      scroll.scrollTop = restoreScroll ?? 0;
      restoreScroll = null;
    }
  });

  const update = (patch: Partial<LibraryViewState>) => {
    if (patch.tab !== undefined) {
      if (patch.collection === undefined) patch.collection = null;
      tabChosen = true;
      try {
        if (tabKey) localStorage.setItem(tabKey, patch.tab);
      } catch {
        /* Session-only preference. */
      }
    }
    const next = { ...target(), ...patch, scroll: patch.scroll ?? scroll.scrollTop };
    setTarget(next);
    props.onViewChange({ ...next });
    present(next, patch.scroll);
  };
  /** Shows `next` now when its rows are on screen already or cached; otherwise its load commits it. */
  function present(next: LibraryViewState, scrollTo: number | undefined) {
    const key = keyOf(next);
    if (key === queryKey()) {
      setView(next);
      if (scrollTo !== undefined) {
        restoreScroll = null;
        scroll.scrollTop = scrollTo;
      }
      return;
    }
    if (scrollTo !== undefined) restoreScroll = scrollTo;
    const cached = cache.queries.get(key);
    if (cached?.library) commit(next, key, cached.library, cached.highlights);
  }
  /** Puts `next` and its rows on screen together, cross-fading from what was shown unless nothing visible changes. */
  function commit(next: LibraryViewState, key: string, sources: LibraryResult, cited: HighlightResult | undefined) {
    const apply = () => {
      // A later choice supersedes this one while its fade waits for a frame.
      if (untrack(targetKey) !== key) return;
      const focused = scroll.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)?.dataset.libraryRow
        : undefined;
      batch(() => {
        setView({ ...next, scroll: untrack(target).scroll });
        setLibrary(sources);
        if (cited) setHighlights(cited);
        else {
          setSourceRows(rows => keepRows(rows, sources.rows));
          const ids = new Set(sources.rows.map(row => row.page.id));
          // Leave the card open when its edits move a source out of the current filter.
          if (!untrack(inspecting)) setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
          if (selectionAnchor && !ids.has(selectionAnchor)) selectionAnchor = null;
        }
        setLoadedKey(key);
      });
      if (restoreScroll !== null) {
        scroll.scrollTop = restoreScroll;
        restoreScroll = null;
      }
      if (focused)
        Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]'))
          .find(row => row.dataset.libraryRow === focused)
          ?.focus({ preventScroll: true });
    };
    if (key === untrack(queryKey) || !untrack(hasResult)) apply();
    else crossfade(scroll, apply);
  }
  createEffect(
    on(
      () => props.view,
      next => {
        const previous = target();
        const filtersChanged =
          JSON.stringify([next.colors, next.tags, next.filters]) !==
          JSON.stringify([previous.colors, previous.tags, previous.filters]);
        if (
          next.view === previous.view &&
          next.collection === previous.collection &&
          next.tab === previous.tab &&
          next.text === previous.text &&
          next.sort === previous.sort &&
          next.group === previous.group &&
          next.unprocessedOnly === previous.unprocessedOnly &&
          !filtersChanged &&
          next.scroll === previous.scroll
        )
          return;
        setTarget({ ...next });
        present({ ...next }, next.scroll);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!preferencesReady()) return;
    const key = targetKey();
    const state = untrack(target);
    const query = untrack(() => queryOf(state));
    // Rows carry reading progress, which is written outside commits; any change refreshes them.
    props.workshop.changeSequence();
    refresh();
    const controller = new AbortController();
    setLoading(true);
    setError('');
    // Typing waits for a pause; a tab, filter or sort loads at once.
    const pause = state.text !== requestedText && untrack(hasResult);
    requestedText = state.text;
    const timer = setTimeout(
      () => {
        void Promise.all([
          props.workshop.api.library({ ...query, limit: query.limit ?? 100_000 }, controller.signal),
          state.tab === 'highlights'
            ? props.workshop.api.highlights(
                { unprocessed: state.unprocessedOnly, colors: state.colors, tags: state.tags, limit: 200 },
                controller.signal,
              )
            : Promise.resolve(undefined),
        ])
          .then(([sources, cited]) => {
            if (controller.signal.aborted) return;
            if (!sources) {
              setLoading(false);
              return;
            }
            cache.queries.set(key, { library: sources, highlights: cited });
            cache.library = sources;
            setLoading(false);
            commit(untrack(target), key, sources, cited);
          })
          .catch(reason => {
            if (!controller.signal.aborted) {
              setError(reason instanceof Error ? reason.message : String(reason));
              setLoading(false);
            }
          });
      },
      pause ? 150 : 0,
    );
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
    });
  });

  createEffect(() => {
    jobsRefresh();
    props.workshop.changed('library');
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await props.workshop.api.ingestJobs(undefined, controller.signal);
        if (controller.signal.aborted) return;
        let completed = false;
        for (const job of result) {
          if (job.state === 'done' && !doneJobs.has(job.id)) {
            doneJobs.add(job.id);
            completed = true;
          }
        }
        setJobs(recentJobs(result, Date.now()));
        setJobsError('');
        if (completed) setRefresh(value => value + 1);
        if (result.some(job => job.state === 'queued' || job.state === 'running'))
          timer = window.setTimeout(() => {
            void poll();
          }, 1500);
      } catch (reason) {
        if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
    });
  });

  function recordJob(job: IngestJob) {
    if (disposed) return;
    setJobs(previous => recentJobs([job, ...previous.filter(value => value.id !== job.id)], Date.now()));
    setJobsRefresh(value => value + 1);
  }
  async function upload(files: File[]) {
    setCommandError('');
    const errors: string[] = [];
    for (const file of files) {
      try {
        recordJob(await props.workshop.api.upload(file, file.name));
      } catch (reason) {
        errors.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    if (!disposed && errors.length) setCommandError(errors.join('\n'));
  }
  async function retryJob(job: IngestJob) {
    setRetrying(previous => [...previous, job.id]);
    setCommandError('');
    try {
      recordJob(await props.workshop.api.retryJob(job.id));
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setRetrying(previous => previous.filter(id => id !== job.id));
    }
  }
  async function changeState(row: LibraryRow, state: ReadingState) {
    if (saving()) return;
    setSaving(true);
    setCommandError('');
    try {
      await props.workshop.commit([sourceStateOperation(row, state)]);
      if (!disposed) setRefresh(value => value + 1);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setSaving(false);
    }
  }
  function clearSelection() {
    setSelected(new Set<string>());
    setInspectorOpen(false);
    setSelectMode(false);
    selectionAnchor = null;
    props.onSaveState?.('saved');
  }
  function showDetails(ids?: readonly string[]) {
    inspectorScroll = scroll.scrollTop;
    if (ids) {
      setSelected(new Set(ids));
      selectionAnchor = ids[0] ?? null;
    }
    setInspectorOpen(true);
  }
  function backToSources() {
    setInspectorOpen(false);
    props.onSaveState?.('saved');
    requestAnimationFrame(() => {
      scroll.scrollTop = inspectorScroll;
    });
  }
  function closeInspector() {
    backToSources();
    queueMicrotask(() => libraryHost.querySelector<HTMLElement>('.library-checkbox[aria-checked="true"]')?.focus());
  }
  async function changeSelectedState(state: ReadingState) {
    if (saving()) return;
    const operations = displayedSources()
      .filter(row => selected().has(row.page.id))
      .map(row => sourceStateOperation(row, state));
    if (!operations.length) return;
    setSaving(true);
    setCommandError('');
    try {
      await props.workshop.commit(operations, 'Change reading state');
      if (!disposed) {
        clearSelection();
        setRefresh(value => value + 1);
      }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setSaving(false);
    }
  }
  function confirmDelete(anchor: HTMLElement, rows: LibraryRow[]) {
    if (!rows.length) return;
    setCommandError('');
    setPopup({
      kind: 'delete-sources',
      anchor,
      sources: rows.map(row => ({ id: row.page.id, title: displayTitle(row.page.text, lookup) })),
    });
  }
  async function deleteSources(sources: { id: string; title: string }[]) {
    if (saving()) return;
    setSaving(true);
    setCommandError('');
    try {
      await props.onDeleteSources(sources);
      if (!disposed) {
        setPopup(null);
        clearSelection();
      }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) {
        setSaving(false);
        setRefresh(value => value + 1);
      }
    }
  }
  function toggleSelection(id: string, range: boolean, inspect = true) {
    setSelected(previous =>
      selectSources(
        orderedSources().map(row => row.page.id),
        previous,
        id,
        selectionAnchor,
        range,
      ),
    );
    selectionAnchor = id;
    inspectorScroll = scroll.scrollTop;
    if (inspect) setInspectorOpen(true);
  }
  function chooseView(value: LibraryView) {
    update({ view: value.id, ...viewFields(value.query), scroll: 0 });
  }
  async function saveView(name: string, id: string, previous: LibraryView | null) {
    if (saving() || savedViews.busy()) return;
    setSaving(true);
    setCommandError('');
    try {
      await savedViews.save({
        id,
        baseRevision: previous?.revision ?? null,
        name,
        query: previous?.query ?? currentQuery(),
        reason: previous ? 'Rename library view' : 'Save library view',
      });
      if (!disposed) {
        update({ view: id });
        setPopup(null);
        setRefresh(value => value + 1);
      }
    } finally {
      if (!disposed) setSaving(false);
    }
  }
  async function deleteView(value: LibraryView) {
    if (saving() || savedViews.busy()) return;
    setSaving(true);
    setCommandError('');
    try {
      if (await savedViews.remove(value, 'Delete library view')) {
        if (!disposed) {
          if (target().view === value.id) update({ view: null });
          setPopup(null);
          setRefresh(value => value + 1);
        }
      } else if (!disposed) {
        setCommandError(savedViews.error());
      }
    } finally {
      if (!disposed) setSaving(false);
    }
  }
  async function undoDelete() {
    if (saving() || savedViews.busy()) return;
    setSaving(true);
    setCommandError('');
    try {
      const restored = await savedViews.undoDelete('Restore library view');
      if (!disposed && restored) {
        chooseView(restored);
        setRefresh(value => value + 1);
      } else if (!disposed && savedViews.error()) {
        setCommandError(savedViews.error());
      }
    } finally {
      if (!disposed) setSaving(false);
    }
  }
  function viewMenu(value: LibraryView, anchor: HTMLElement) {
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Library view actions',
      items: [
        { label: 'Rename', action: () => setPopup({ kind: 'name', anchor, saved: value, id: value.id }) },
        {
          label: 'Export BibTeX',
          divider: true,
          icon: 'download',
          action: () => {
            void downloadQuery('bibtex', value.query);
          },
        },
        {
          label: 'Export CSL JSON',
          icon: 'download',
          action: () => {
            void downloadQuery('csl', value.query);
          },
        },
        {
          label: 'Export Markdown',
          icon: 'download',
          action: () => {
            void downloadQuery('markdown', value.query);
          },
        },
        {
          label: props.workshop.confirmViewDelete() ? 'Delete view…' : 'Delete view',
          divider: true,
          icon: 'trash',
          danger: true,
          action: () => {
            setCommandError('');
            if (props.workshop.confirmViewDelete()) setPopup({ kind: 'delete', anchor, saved: value });
            else void deleteView(value);
          },
        },
      ],
    });
  }
  async function downloadQuery(format: ExportFormat, query: LibraryQuery) {
    setCommandError('');
    try {
      const blob = await props.workshop.api.exportQuery(format, query);
      if (disposed) return;
      downloadBlob(blob, `library.${exportExtensions[format]}`);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function download(format: ExportFormat, ids: readonly string[]) {
    // An empty ID list means every source to the API, not the empty result set.
    if (!ids.length) return;
    setCommandError('');
    try {
      const blob = await props.workshop.api.exportSources(format, ids);
      if (disposed) return;
      downloadBlob(blob, `library.${exportExtensions[format]}`);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function exportMenu(anchor: HTMLElement) {
    const ids = [...selected()],
      query = currentQuery();
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Export sources',
      items: [
        {
          label: 'BibTeX',
          action: () => {
            if (ids.length) void download('bibtex', ids);
            else void downloadQuery('bibtex', query);
          },
        },
        {
          label: 'CSL JSON',
          action: () => {
            if (ids.length) void download('csl', ids);
            else void downloadQuery('csl', query);
          },
        },
        {
          label: 'Markdown',
          action: () => {
            if (ids.length) void download('markdown', ids);
            else void downloadQuery('markdown', query);
          },
        },
      ],
    });
  }
  /** `press` is the source's row when a long press asked: its actions open as a context menu over it instead of a menu at its button. */
  async function rowMenu(row: LibraryRow, anchor: HTMLElement, press?: HTMLElement) {
    setCommandError('');
    let memberships: string[], pages: Block[];
    try {
      [memberships, pages] = await Promise.all([
        sourceCollections(props.workshop.api, row.page.id),
        collectionPages(props.workshop.api),
      ]);
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (disposed || !anchor.isConnected) return;
    const items: MenuItem[] = [
      ...(row.source.current_snapshot_id
        ? [
            {
              label: row.source.last_read_at != null ? 'Continue reading' : 'Read',
              icon: 'book' as const,
              action: () => props.onOpen({ kind: 'reader', sourceId: row.page.id }, false),
            },
          ]
        : []),
      ...(readingTarget(row).kind === 'reader' && reading().some(value => value.page.id === row.page.id)
        ? [
            {
              label: 'Open page',
              icon: 'page' as const,
              action: () => openSource({ kind: 'page', pageId: row.page.id }, false),
            },
          ]
        : []),
      { label: 'Details', action: () => showDetails([row.page.id]) },
      ...stateActions
        .filter(action => action.state !== row.source.state)
        .map(action => ({
          label: action.label,
          disabledReason: saving() ? 'Saving…' : undefined,
          action: () => {
            void changeState(row, action.state);
          },
        })),
      {
        label: 'Add to collection…',
        action: () => setPopup({ kind: 'collection-picker', anchor, sources: [row.page.id] }),
      },
      ...pages
        .filter(collection => memberships.includes(collection.id))
        .map(collection => ({
          section: 'Collections',
          label: `Remove from ${collection.text}`,
          action: () => {
            void collectionActions.run(`Removed from ${collection.text}`, () =>
              changeCollectionMembers(props.workshop, collection.id, [row.page.id], false),
            );
          },
        })),
      {
        label: 'Export BibTeX',
        section: coverLayout() ? 'Export' : undefined,
        divider: !coverLayout(),
        icon: 'download',
        action: () => {
          void download('bibtex', [row.page.id]);
        },
      },
      {
        label: 'Export CSL JSON',
        icon: 'download',
        action: () => {
          void download('csl', [row.page.id]);
        },
      },
      {
        label: 'Export Markdown',
        icon: 'download',
        action: () => {
          void download('markdown', [row.page.id]);
        },
      },
      {
        label: 'Delete…',
        section: coverLayout() ? 'Delete' : undefined,
        divider: !coverLayout(),
        icon: 'trash',
        danger: true,
        disabledReason: saving() ? 'Saving…' : undefined,
        action: () => confirmDelete(anchor, [row]),
      },
    ];
    if (press) openContextMenu({ source: press, label: 'Source actions', items });
    else setPopup({ kind: 'menu', anchor, label: 'Source actions', source: row, items });
  }
  function InspectorView() {
    return (
      <aside
        class="library-inspector-host"
        classList={{
          'library-inspector-sheet': coverLayout(),
          'library-inspector-expanded': sheetExpanded(),
          'library-inspector-pending': !inspectorShown(),
        }}
        aria-label="Source details"
      >
        <Show when={coverLayout()}>
          <Button
            class="library-inspector-grip"
            label={sheetExpanded() ? 'Collapse details sheet' : 'Expand details sheet'}
            aria-expanded={sheetExpanded()}
            onClick={() => setSheetExpanded(value => !value)}
          >
            <span />
          </Button>
        </Show>
        <MetadataInspector
          workshop={props.workshop}
          sourceIds={selectedIds()}
          onOpen={props.onOpen}
          onClose={clearSelection}
          onShown={setCardShown}
          phone={coverLayout()}
          backLabel={
            narrowInspector() && !coverLayout()
              ? `Back to ${library()?.total ?? displayedSources().length} sources`
              : undefined
          }
          onBack={backToSources}
          onSaveState={props.onSaveState}
        />
      </aside>
    );
  }

  return (
    <div
      ref={libraryHost}
      class="library-pane"
      classList={{
        'library-search-open': searchOpen() || !!text(),
        'library-highlights-tab': tab() === 'highlights',
        'library-highlight-desk': highlightDesk(),
        'library-highlight-passage-open': tab() === 'highlights' && coverLayout() && highlightPassageOpen(),
        'library-reading-cards': readingCards(),
        'library-cover-reading': coverLayout() && readingCards(),
        'library-inspecting': inspectorShown(),
        'library-inspector-narrow': inspectorShown() && narrowInspector() && !coverLayout(),
        'library-inspector-phone': inspectorShown() && coverLayout(),
        'library-select-mode': selectMode(),
      }}
      data-pane={props.pane}
      data-pane-pending={!hasResult() ? '' : undefined}
      aria-label="Library"
      tabIndex={props.active ? 0 : -1}
      onFocusIn={props.onActivate}
      onPointerDown={props.onActivate}
      onKeyDown={event => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          (selected().size || selectMode()) &&
          !popup() &&
          !(event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          // One layer per press: the card closes first and the selection stays, with focus back on its row.
          if (inspecting()) closeInspector();
          else clearSelection();
        }
        if (
          !inspecting() &&
          tab() !== 'highlights' &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'z' &&
          collectionActions.canUndo() &&
          !(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          void collectionActions.undo();
        }
      }}
      onDragOver={event => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={event => {
        if (event.dataTransfer?.files.length) {
          event.preventDefault();
          void upload(Array.from(event.dataTransfer.files));
        }
      }}
    >
      <div class="library-catalogue">
        <div class="library-ledger" inert={inspectorShown() && narrowInspector() && !coverLayout()}>
          <header class="library-toolbar">
            <div class="library-cover-header">
              <div class="library-cover-heading">
                <div class="library-register">Sources and highlights</div>
                <h1>Library</h1>
              </div>
              <Show when={coverLayout() && tab() !== 'highlights'}>
                <NavEnd>
                  <NavButton
                    icon="more"
                    label="Library actions"
                    aria-haspopup="menu"
                    onClick={event => {
                      const anchor = event.currentTarget;
                      const selectable =
                        !collectionsIndex() && (displayedSources().length || (readingCards() && reading().length));
                      setPopup({
                        kind: 'menu',
                        anchor,
                        label: 'Library actions',
                        items: [
                          { label: 'Add source', icon: 'plus', action: () => openAdd(anchor) },
                          ...(selectable
                            ? [
                                {
                                  label: selectMode() ? 'Done' : 'Select',
                                  icon: selectMode() ? ('check' as const) : ('select' as const),
                                  divider: true,
                                  action: () => {
                                    if (selectMode()) clearSelection();
                                    else setSelectMode(true);
                                  },
                                },
                              ]
                            : []),
                        ],
                      });
                    }}
                  />
                </NavEnd>
              </Show>
              <Show when={coverLayout() && tab() === 'highlights'}>
                <NavEnd>
                  <NavButton
                    icon="search"
                    label="Search highlights"
                    aria-expanded={searchOpen() || !!text()}
                    onClick={() => {
                      setSearchOpen(value => !value);
                      if (searchOpen())
                        queueMicrotask(() =>
                          scroll.closest('.library-pane')?.querySelector<HTMLInputElement>('.library-search')?.focus(),
                        );
                    }}
                  />
                </NavEnd>
              </Show>
              <Show
                when={
                  !coverLayout() &&
                  !collectionsIndex() &&
                  tab() !== 'highlights' &&
                  (displayedSources().length || (readingCards() && reading().length))
                }
              >
                <Button
                  class="library-select-toggle"
                  aria-pressed={selectMode()}
                  onClick={() => {
                    if (selectMode()) clearSelection();
                    else setSelectMode(true);
                  }}
                >
                  {selectMode() ? 'Done' : 'Select'}
                </Button>
              </Show>
              <Show when={!coverLayout() && (collectionsIndex() || tab() === 'highlights')}>
                <Button
                  icon="search"
                  label="Search library"
                  aria-expanded={searchOpen() || !!text()}
                  onClick={() => {
                    setSearchOpen(value => !value);
                    if (searchOpen())
                      queueMicrotask(() =>
                        scroll.closest('.library-pane')?.querySelector<HTMLInputElement>('.library-search')?.focus(),
                      );
                  }}
                />
              </Show>
              <Show when={!coverLayout() && tab() !== 'highlights'}>
                <Button
                  ref={addButton}
                  class="bordered"
                  icon="plus"
                  label="Add to library"
                  aria-haspopup={DEMO ? undefined : 'dialog'}
                  aria-expanded={DEMO ? undefined : popup()?.kind === 'add'}
                  onClick={event => openAdd(event.currentTarget)}
                />
              </Show>
            </div>
            {/* Primary tabs stay fixed; More names the selected secondary or saved view. */}
            <div class="library-tabs library-primary-tabs mode-tabs tab-strip" role="group" aria-label="Library state">
              <For each={primaryTabs}>
                {item => {
                  const count = () => (item.id === 'highlights' ? unprocessedCount() : undefined);
                  return (
                    <Button
                      data-library-tab={item.id}
                      aria-label={count() ? `${item.label}, ${count()}` : item.label}
                      aria-pressed={!target().view && target().tab === item.id}
                      onClick={() => update({ view: null, tab: item.id, scroll: 0 })}
                    >
                      {item.label}
                      <Show when={count()}>
                        <span class="library-count">{count()}</span>
                      </Show>
                    </Button>
                  );
                }}
              </For>
              <Button
                class="library-tabs-more"
                aria-haspopup="menu"
                aria-label="More library views"
                aria-pressed={!!target().view || overflowTabs.some(item => item.id === target().tab)}
                onClick={event => {
                  const anchor = event.currentTarget;
                  const current = views().find(value => value.id === target().view);
                  setPopup({
                    kind: 'menu',
                    anchor,
                    label: 'Library views',
                    items: [
                      ...overflowTabs.map(item => ({
                        label: item.label,
                        checked: !target().view && target().tab === item.id,
                        action: () => update({ view: null, tab: item.id, scroll: 0 }),
                      })),
                      ...views().map((value, index) => ({
                        label: value.name,
                        section: index === 0 ? 'Saved views' : undefined,
                        checked: target().view === value.id,
                        action: () => chooseView(value),
                      })),
                      ...(current
                        ? [
                            {
                              label: `Actions for ${current.name}`,
                              section: 'Current view',
                              action: () => viewMenu(current, anchor),
                            },
                          ]
                        : []),
                    ],
                  });
                }}
              >
                <span>
                  {views().find(value => value.id === target().view)?.name ??
                    (target().view ? undefined : overflowTabs.find(item => item.id === target().tab)?.label) ??
                    'More'}
                </span>
                <Icon name="down" />
              </Button>
            </div>
            <CollectionsToolbarHeading
              collectionsIndex={collectionsIndex()}
              collectionId={view().collection}
              collection={collection()}
              total={library()?.total ?? 0}
              busy={collectionActions.busy()}
              onNewCollection={anchor => setPopup({ kind: 'collection-name', anchor })}
              onBackToCollections={() =>
                update({ view: null, tab: 'collections', collection: null, text: '', scroll: 0 })
              }
              onOpenPage={props.onOpen}
              onRenameCollection={(anchor, item) => setPopup({ kind: 'collection-name', anchor, collection: item })}
              onDeleteCollection={(anchor, item) => setPopup({ kind: 'delete-collection', anchor, collection: item })}
            />
            <Show when={!collectionsIndex()}>
              <div class="library-controls">
                <Show
                  when={tab() !== 'highlights'}
                  fallback={
                    <HighlightControls
                      unprocessedOnly={target().unprocessedOnly}
                      unprocessedCount={unprocessedCount()}
                      highlightDesk={highlightDesk()}
                      filterCount={triage.highlightFilterCount()}
                      showUndo={!selectedHighlight() && highlightActions.canUndo()}
                      onUnprocessed={only => update({ unprocessedOnly: only, scroll: 0 })}
                      onOpenFilters={anchor => setPopup({ kind: 'highlight-filters', anchor })}
                      onUndo={() => {
                        void triage.undoHighlight();
                      }}
                    />
                  }
                >
                  <Show
                    when={selected().size > 0}
                    fallback={
                      <>
                        <input
                          class="input library-search"
                          type="search"
                          aria-label="Search library"
                          placeholder="Search library"
                          value={target().text}
                          onInput={event => update({ view: null, text: event.currentTarget.value, scroll: 0 })}
                        />
                        <Button
                          class="library-sort"
                          aria-haspopup="menu"
                          label="Sort and group sources"
                          onClick={event => {
                            const anchor = event.currentTarget;
                            setPopup({
                              kind: 'menu',
                              anchor,
                              label: 'Sort and group sources',
                              items: [
                                ...sorts.map(item => ({
                                  section: 'Sort',
                                  label: item.label,
                                  checked: target().sort === item.id,
                                  action: () => update({ view: null, sort: item.id, scroll: 0 }),
                                })),
                                ...groupings.map(item => ({
                                  section: 'Group',
                                  label: item.label,
                                  checked: target().group === item.id,
                                  action: () => update({ group: item.id }),
                                })),
                                {
                                  section: 'View',
                                  label: 'Save view…',
                                  disabledReason: saving() ? 'Saving…' : undefined,
                                  action: () => setPopup({ kind: 'name', anchor, saved: null, id: ulid() }),
                                },
                              ],
                            });
                          }}
                        >
                          {sorts.find(item => item.id === target().sort)!.label}
                          <Show when={target().group !== 'none'}>
                            <span class="library-sort-group">
                              {' '}
                              · by {groupings.find(item => item.id === target().group)!.label.toLowerCase()}
                            </span>
                          </Show>
                          <Icon name="down" />
                        </Button>
                        <div class="library-tabs mode-tabs" role="group" aria-label="Library layout">
                          <Button
                            icon="rows"
                            label="List"
                            aria-pressed={layout() === 'list'}
                            onClick={() => chooseLayout('list')}
                          />
                          <Button
                            icon="shelf"
                            label="Shelf"
                            aria-pressed={layout() === 'shelf'}
                            onClick={() => chooseLayout('shelf')}
                          />
                        </div>
                        {/* Always present, so the search field keeps its width on tabs with nothing to browse. */}
                        <Button
                          class="library-browse-button"
                          icon="browse"
                          label="Browse"
                          aria-haspopup="dialog"
                          aria-pressed={filtered()}
                          disabled={!browseEntries().length}
                          onClick={event => {
                            setBrowseQuery('');
                            setPopup({ kind: 'browse', anchor: event.currentTarget, field: null });
                          }}
                        />
                        <Button
                          icon="download"
                          label="Export"
                          aria-haspopup="menu"
                          disabled={loading() || !!error() || loadedKey() !== queryKey() || !displayedSources().length}
                          onClick={event => exportMenu(event.currentTarget)}
                        >
                          <span class="library-export-label">Export</span>
                          <Icon name="down" />
                        </Button>
                      </>
                    }
                  >
                    <span class="library-selection-count">{selected().size} selected</span>
                    <Show when={!inspecting()}>
                      <Button class="bordered" onClick={() => showDetails()}>
                        Details
                      </Button>
                    </Show>
                    <Button
                      class="library-inspector-browse"
                      icon="browse"
                      label="Browse"
                      onClick={event => {
                        backToSources();
                        setBrowseQuery('');
                        setPopup({ kind: 'browse', anchor: event.currentTarget, field: null });
                      }}
                    >
                      <span class="library-action-label">Browse</span>
                    </Button>
                    <Button
                      aria-haspopup="menu"
                      disabled={saving()}
                      onClick={event =>
                        setPopup({
                          kind: 'menu',
                          anchor: event.currentTarget,
                          label: 'Mark as',
                          items: tabs
                            .filter(item => item.id !== 'all' && item.id !== 'highlights' && item.id !== 'collections')
                            .map(item => ({
                              label: item.label,
                              action: () => {
                                void changeSelectedState(item.id as ReadingState);
                              },
                            })),
                        })
                      }
                    >
                      Mark as
                      <Icon name="down" />
                    </Button>
                    <Button
                      icon="download"
                      label="Export"
                      aria-haspopup="menu"
                      disabled={loading() || !!error() || loadedKey() !== queryKey()}
                      onClick={event => exportMenu(event.currentTarget)}
                    >
                      <span class="library-action-label">Export</span>
                      <Icon name="down" />
                    </Button>
                    <Button
                      icon="shelf"
                      label="Add to collection"
                      disabled={collectionActions.busy()}
                      onClick={event =>
                        setPopup({ kind: 'collection-picker', anchor: event.currentTarget, sources: [...selected()] })
                      }
                    >
                      <span class="library-action-label">Add to collection…</span>
                    </Button>
                    <Show when={view().collection}>
                      <Button
                        class="library-remove-member"
                        label="Remove from collection"
                        disabled={collectionActions.busy()}
                        onClick={() => {
                          void collectionActions.run('Removed from collection', () =>
                            changeCollectionMembers(props.workshop, view().collection!, [...selected()], false),
                          );
                        }}
                      >
                        Remove<span class="library-action-label"> from collection</span>
                      </Button>
                    </Show>
                    <Button
                      icon="trash"
                      label="Delete"
                      class="danger"
                      aria-haspopup="dialog"
                      disabled={saving()}
                      onClick={event =>
                        confirmDelete(
                          event.currentTarget,
                          displayedSources().filter(row => selected().has(row.page.id)),
                        )
                      }
                    >
                      <span class="library-action-label">Delete</span>
                    </Button>
                    <Button
                      class="library-clear-selection"
                      icon="close"
                      label="Clear selection"
                      onClick={clearSelection}
                    >
                      <span class="library-action-label">Clear selection</span>
                    </Button>
                  </Show>
                </Show>
              </div>
              <Show when={tab() !== 'highlights' && chosenFilters().length}>
                <LibraryChosenFilters
                  filters={chosenFilters()}
                  onToggle={toggleFilter}
                  onClear={() => update({ view: null, filters: clearedFilters(), scroll: 0 })}
                />
              </Show>
            </Show>
            <collectionActions.Notice />
            <Show when={props.workshop.commandState() === 'error'}>
              <p class="library-error" role="alert">
                {props.workshop.commandMessage()}
              </p>
            </Show>
            <Show when={deleted()}>
              <footer class="table-footer" role="status">
                View deleted ·{' '}
                <Button
                  disabled={saving()}
                  onClick={() => {
                    void undoDelete();
                  }}
                >
                  Undo
                </Button>
              </footer>
            </Show>
          </header>
          <input
            ref={fileInput}
            type="file"
            hidden
            aria-label="Choose EPUB files"
            accept=".epub,application/epub+zip"
            multiple
            onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              void upload(files);
            }}
          />
          <div
            ref={scroll}
            class="library-scroll"
            aria-busy={targetKey() !== queryKey() ? true : undefined}
            onScroll={() => {
              if (restoreScroll !== null || (inspectorShown() && narrowInspector() && !coverLayout())) return;
              const next = { ...target(), scroll: scroll.scrollTop };
              setTarget(next);
              props.onViewChange({ ...next });
            }}
          >
            <Show when={browseRail()}>
              <LibraryBrowseRail
                entries={browseEntries}
                chosen={chosen}
                onToggle={toggleFilter}
                onOpenField={(field, anchor) => {
                  setBrowseQuery('');
                  setPopup({ kind: 'browse', anchor, field });
                }}
              />
            </Show>
            <div class="library-main">
              <Show when={commandError()}>
                <p class="library-error" role="alert">
                  {commandError()}
                </p>
              </Show>
              {/* Every read fails together when the service is away; one row and one Retry stand for all of them. */}
              <Show when={countError() || jobsError() || viewsError() || (showReading() && readingError()) || error()}>
                {message => (
                  <div class="library-error" role="alert">
                    {message()}
                    <Button
                      onClick={() => {
                        setRefresh(value => value + 1);
                        setJobsRefresh(value => value + 1);
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
              </Show>
              <Show when={collections.error || collectionCards.error}>
                <p class="library-error" role="alert">
                  {String(collections.error || collectionCards.error)}
                </p>
              </Show>
              <Show when={collectionsIndex()}>
                <CollectionsView
                  workshop={props.workshop}
                  slow={slowCollections()}
                  loading={collections.loading}
                  collections={collections()}
                  cards={collectionCards()}
                  onSelectCollection={collectionId =>
                    update({
                      view: null,
                      tab: 'collections',
                      collection: collectionId,
                      text: '',
                      filters: clearedFilters(),
                      scroll: 0,
                    })
                  }
                />
              </Show>
              <Show when={!collectionsIndex()}>
                <LibrarySourcesView
                  pane={props.pane}
                  workshop={props.workshop}
                  neighbour={props.neighbour}
                  tab={tab()}
                  tabLabel={tabs.find(item => item.id === tab())?.label}
                  view={view()}
                  layout={layout()}
                  group={group()}
                  groups={groups()}
                  displayedSources={displayedSources()}
                  orderedSources={orderedSources()}
                  readingCards={readingCards()}
                  reading={reading()}
                  upNext={upNext()}
                  coverLayout={coverLayout()}
                  selectMode={selectMode()}
                  selected={selected()}
                  openedSource={openedSource()}
                  sourceMenuId={sourceMenuId()}
                  mixedStates={mixedStates()}
                  finishedDate={finishedDate()}
                  saving={saving()}
                  loading={loading()}
                  slowLoad={slowLoad()}
                  hasResult={hasResult()}
                  error={error()}
                  noSources={noSources()}
                  filtered={filtered()}
                  shownJobs={shownJobs()}
                  failedJobs={failedJobs()}
                  failuresOpen={failuresOpen()}
                  onOpenFailures={() => setFailuresOpen(true)}
                  sourceTitles={sourceTitles()}
                  retrying={retrying()}
                  onRetryJob={job => {
                    void retryJob(job);
                  }}
                  onDismissJob={dismissJob}
                  scroll={() => scroll}
                  readingTarget={readingTarget}
                  onOpenSource={openSource}
                  onOpenPage={props.onOpen}
                  onToggleSelection={toggleSelection}
                  onChangeState={(row, state) => {
                    void changeState(row, state);
                  }}
                  onRowMenu={(row, anchor, press) => {
                    void rowMenu(row, anchor, press);
                  }}
                  onOpenAdd={openAdd}
                  onUpdate={update}
                  highlightsContent={
                    <HighlightsTriageView
                      workshop={props.workshop}
                      triage={triage}
                      highlights={highlights()}
                      unprocessedOnly={unprocessedOnly()}
                      colors={colors()}
                      tags={tags()}
                      coverLayout={coverLayout()}
                      onClearFilters={() => update({ colors: [], tags: [], scroll: 0 })}
                      onOpenSource={openSource}
                    />
                  }
                />
              </Show>
            </div>
          </div>
        </div>
        <Show when={inspecting() || inspectorShown()}>
          <Show when={coverLayout() && inspectorPortal()} fallback={<InspectorView />}>
            {host => (
              <Portal mount={host() as HTMLElement}>
                <InspectorView />
              </Portal>
            )}
          </Show>
        </Show>
      </div>
      <Show when={coverLayout() && (popup()?.kind === 'highlight-filters' || sourceMenuId())}>
        <div class="library-highlight-filter-shade" aria-hidden="true" />
      </Show>
      <Show keyed when={popup()}>
        {state => {
          const dismiss = () => {
            if (popup() === state) setPopup(null);
          };
          if (
            state.kind === 'collection-picker' ||
            state.kind === 'collection-name' ||
            state.kind === 'delete-collection'
          )
            return (
              <CollectionPopups
                state={state}
                workshop={props.workshop}
                actions={collectionActions}
                onClearSelection={clearSelection}
                onDeletedCollection={() => update({ view: null, tab: 'collections', collection: null, scroll: 0 })}
                onDismiss={dismiss}
              />
            );
          if (state.kind === 'menu') {
            const sheet = coverLayout() && !!state.source;
            const source = state.source;
            return (
              <Menu
                anchor={state.anchor}
                label={state.label}
                items={state.items}
                placement={sheet ? 'sheet' : 'anchor'}
                class={sheet ? 'library-source-sheet' : undefined}
                header={
                  sheet && source ? (
                    <header class="library-source-sheet-head">
                      <div>
                        <h2>{displayTitle(source.page.text, lookup)}</h2>
                        <p>{sourceByline(source)}</p>
                        <p class="library-highlight-meta">
                          {[
                            source.source.siglum,
                            { epub: 'Book', article: 'Article', record: 'Record' }[
                              source.snapshot_format ?? source.source.format
                            ],
                            source.publisher,
                            source.progress > 0 ? `${formatProgress(source.progress)} read` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </header>
                  ) : undefined
                }
                onDismiss={dismiss}
              />
            );
          }
          if (
            state.kind === 'highlight-sources' ||
            state.kind === 'highlight-chapters' ||
            state.kind === 'highlight-filters' ||
            state.kind === 'tags'
          )
            return (
              <HighlightFilterPopups
                kind={state.kind}
                anchor={state.anchor}
                coverLayout={coverLayout()}
                loading={loading()}
                highlights={highlights()}
                targetTags={target().tags}
                targetColors={target().colors}
                browseQuery={browseQuery()}
                onBrowseQuery={setBrowseQuery}
                triage={triage}
                onSwitchKind={kind => setPopup({ kind, anchor: state.anchor })}
                onUpdate={update}
                onDismiss={dismiss}
              />
            );
          if (state.kind === 'browse')
            return (
              <LibraryBrowsePicker
                anchor={state.anchor}
                field={state.field}
                query={browseQuery()}
                onQuery={setBrowseQuery}
                entries={browseEntries()}
                chosen={chosen}
                onToggle={toggleFilter}
                onDismiss={dismiss}
              />
            );
          if (state.kind === 'name')
            return (
              <SavedViewNamePopup
                anchor={state.anchor}
                label={state.saved ? 'Rename library view' : 'Save library view'}
                inputLabel="Library view name"
                placeholder="View name"
                name={state.saved?.name ?? ''}
                busy={saving() || savedViews.busy()}
                errorClass="library-error"
                onDismiss={dismiss}
                onSave={name => saveView(name, state.id, state.saved)}
              />
            );
          if (state.kind === 'delete')
            return (
              <DeleteSavedViewPopup
                anchor={state.anchor}
                label="Delete library view?"
                name={state.saved.name}
                keptNoun="Sources"
                busy={saving() || savedViews.busy()}
                error={commandError()}
                errorClass="library-error"
                onDismiss={dismiss}
                onConfirm={() => {
                  void deleteView(state.saved);
                }}
              />
            );
          if (state.kind === 'delete-sources')
            return (
              <Popup
                anchor={state.anchor}
                label={state.sources.length === 1 ? 'Delete source?' : 'Delete sources?'}
                onDismiss={dismiss}
                width={320}
              >
                <p>
                  Delete{' '}
                  {state.sources.length === 1 ? `“${state.sources[0]!.title}”` : `${state.sources.length} sources`} and{' '}
                  {state.sources.length === 1 ? 'its' : 'their'} highlights?
                </p>
                <p class="muted">You can undo this deletion.</p>
                <Show when={commandError()}>
                  <p class="library-error" role="alert">
                    {commandError()}
                  </p>
                </Show>
                <div class="popup-actions">
                  <Button disabled={saving()} onClick={dismiss}>
                    Cancel
                  </Button>
                  <Button
                    icon="trash"
                    class="bordered danger"
                    disabled={saving()}
                    onClick={() => {
                      void deleteSources(state.sources);
                    }}
                  >
                    {state.sources.length === 1 ? 'Delete source' : `Delete ${state.sources.length} sources`}
                  </Button>
                </div>
              </Popup>
            );
          if (DEMO) return null;
          return (
            <AddSheet
              anchor={state.anchor}
              placement={coverLayout() ? 'sheet' : 'anchor'}
              workshop={props.workshop}
              onDismiss={dismiss}
              onChooseFile={() => fileInput.click()}
              onFiles={files => {
                void upload(files);
              }}
              onJob={recordJob}
              onAdded={pageId => openSource({ kind: 'page', pageId }, false)}
            />
          );
        }}
      </Show>
      <highlightActions.Popups />
    </div>
  );
}
