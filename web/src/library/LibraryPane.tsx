import { For, Show, batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ulid } from 'ulid';
import { exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { Block, HighlightResult, HighlightRow, IngestJob, LibraryFilters, LibraryQuery, LibraryResult, LibraryRow, LibraryView, ReadingState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { EMBEDDED } from '../demo/mode';
import { BlockText } from '../outline/BlockText';
import type { LibraryGroup, LibraryTab, LibraryViewState, OpenTarget, PaneId } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { Picker } from '../ui/Picker';
import { downloadBlob } from '../ui/download';
import { createSlowFlag } from '../ui/loading';
import { formatProgress, groupSources, highlightChapterHeading, highlightChapters, highlightEmptyMessage, highlightMeta, importJobName, jobLabel, keepRows, libraryQuery, nextUnprocessedHighlight, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';
import { formatSourceValue } from '../outline/source';
import { createHighlightActions, highlightColors, setLinkedCitation } from './highlights';
import type { HighlightMenu } from './highlights';
import { ResourceImage } from './ResourceImage';
import { SourceCover } from './SourceCover';
import { ReadingCard } from './ReadingCard';
import { AddSheet } from './AddSheet';
import { CollectionNamePopup, CollectionPicker, createCollectionActions } from './Collections';
import { changeCollectionMembers, collectionPages, createCollection, deleteCollection, renameCollection, sourceCollections } from '../document/collections';
import { MetadataInspector } from './MetadataInspector';
import './library.css';
import '../table/table.css';

export interface LibraryPaneProps {
  pane: PaneId;
  view: LibraryViewState;
  notebook: NotebookClient;
  active: boolean;
  /** Another pane is open beside this one. */
  split: boolean;
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

type BrowseField = keyof LibraryFilters;
interface BrowseEntry { field: BrowseField; value: string | number; label: string; count: number }
const browseFields: { field: BrowseField; label: string }[] = [
  { field: 'people', label: 'People' }, { field: 'decades', label: 'Decades' },
  { field: 'publishers', label: 'Publishers' }, { field: 'languages', label: 'Languages' },
];
/** The rail lists the commonest values of each field; the rest are a picker away. */
const browseLimit = 6;
const browsePlaceholders: Record<BrowseField | 'all', string> = {
  all: 'Find a person, decade, publisher or language', people: 'Find a person', decades: 'Find a decade', publishers: 'Find a publisher', languages: 'Find a language',
};
const groupings: { id: LibraryGroup; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'author', label: 'Author' }, { id: 'decade', label: 'Decade' },
  { id: 'publisher', label: 'Publisher' }, { id: 'language', label: 'Language' },
];

type LibraryPopup =
  | { kind: 'add'; anchor: HTMLElement }
  | { kind: 'tags'; anchor: HTMLElement }
  | { kind: 'highlight-filters'; anchor: HTMLElement }
  | { kind: 'highlight-sources'; anchor: HTMLElement }
  | { kind: 'highlight-chapters'; anchor: HTMLElement }
  | { kind: 'highlight-colors'; anchor: HTMLElement; row: HighlightRow }
  | { kind: 'browse'; anchor: HTMLElement; field: BrowseField | null }
  | { kind: 'name'; anchor: HTMLElement; saved: LibraryView | null; id: string }
  | { kind: 'delete'; anchor: HTMLElement; saved: LibraryView }
  | { kind: 'delete-sources'; anchor: HTMLElement; sources: { id: string; title: string }[] }
  | { kind: 'collection-name'; anchor: HTMLElement; collection?: Block }
  | { kind: 'delete-collection'; anchor: HTMLElement; collection: Block }
  | { kind: 'collection-picker'; anchor: HTMLElement; sources: string[] }
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[]; Header?: HighlightMenu['Header']; source?: LibraryRow };
const tabs: { id: LibraryTab; label: string }[] = [
  { id: 'reading', label: 'Reading' }, { id: 'inbox', label: 'Inbox' }, { id: 'highlights', label: 'Highlights' },
  { id: 'all', label: 'All' }, { id: 'collections', label: 'Collections' },
  { id: 'finished', label: 'Finished' }, { id: 'abandoned', label: 'Abandoned' },
];
const sorts: { id: LibraryViewState['sort']; label: string }[] = [
  { id: 'added', label: 'Added' }, { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' }, { id: 'year', label: 'Year' },
  { id: 'last_read', label: 'Last read' }, { id: 'progress', label: 'Progress' },
];
const stateActions: { state: ReadingState; label: string }[] = [
  { state: 'reading', label: 'Mark as reading' }, { state: 'finished', label: 'Mark as finished' },
  { state: 'abandoned', label: 'Mark as abandoned' }, { state: 'inbox', label: 'Return to inbox' },
];
const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

interface LibraryRead { library: LibraryResult; highlights?: HighlightResult }
interface CollectionCard { page: Block; count: number; covers: LibraryRow[] }
interface LibraryCache {
  notebookId?: string;
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
const libraryReads = new WeakMap<NotebookClient, LibraryCache>();
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
    const stored: unknown = JSON.parse(dismissedKey ? localStorage.getItem(dismissedKey) ?? '[]' : '[]');
    if (Array.isArray(stored)) dismissed = stored.filter((id): id is string => typeof id === 'string');
  } catch { /* Session-only preferences. */ }
  return { tabKey, layoutKey, dismissedKey, layout, remembered, dismissed };
}

export function LibraryPane(props: LibraryPaneProps) {
  const cache: LibraryCache = libraryReads.get(props.notebook) ?? { queries: new Map<string, LibraryRead>() };
  libraryReads.set(props.notebook, cache);
  const preferences = libraryPreferences(cache.notebookId);
  const coverMedia = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
  const initialView = { ...props.view };
  if (cache.notebookId && !initialView.view && initialView.tab === 'inbox') {
    const remembered = preferences.remembered;
    const counts = cache.library?.counts;
    const initialTab = coverMedia.matches ? 'reading' : tabs.some(tab => tab.id === remembered) ? remembered as LibraryTab
      : counts ? counts.inbox ? 'inbox' : counts.reading ? 'reading' : 'all' : 'inbox';
    if (initialTab !== initialView.tab) { initialView.tab = initialTab; initialView.scroll = 0; }
  }
  const [view, setView] = createSignal(initialView);
  const [preferencesReady, setPreferencesReady] = createSignal(!!cache.notebookId);
  const tab = createMemo(() => view().tab);
  const text = createMemo(() => view().text);
  const collectionActions = createCollectionActions();
  const collectionsIndex = createMemo(() => tab() === 'collections' && !view().collection);
  const [collections] = createResource(() => props.notebook.changeSequence(), async () => {
    const result = await collectionPages(props.notebook.api);
    cache.collections = result;
    return result;
  }, { initialValue: cache.collections });
  const collection = createMemo(() => collections()?.find(page => page.id === view().collection));
  const [collectionCards] = createResource(() => collectionsIndex() && collections.latest && { pages: collections.latest, sequence: props.notebook.changeSequence() }, async ({ pages }) => {
    const result = await Promise.all(pages.map(async page => {
      const result = await props.notebook.api.library({ collection_id: page.id, limit: 3 });
      return { page, count: result.total, covers: result.rows };
    }));
    cache.collectionCards = result;
    return result;
  }, { initialValue: cache.collectionCards });
  const sort = createMemo(() => view().sort);
  const unprocessedOnly = createMemo(() => view().unprocessedOnly);
  const colors = createMemo(() => view().colors);
  const tags = createMemo(() => view().tags);
  const filters = createMemo(() => view().filters);
  const group = createMemo(() => view().group);
  const filtered = createMemo(() => Object.values(filters()).some(values => values.length > 0));
  const [tagQuery, setTagQuery] = createSignal('');
  const [browseQuery, setBrowseQuery] = createSignal('');
  const [views, setViews] = createSignal<LibraryView[]>(cache.views ?? []);
  const [viewsError, setViewsError] = createSignal('');
  const saved = createMemo(() => views().find(value => value.id === view().view));
  const [deleted, setDeleted] = createSignal<LibraryView | null>(null);
  let deletedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(deletedTimer));
  const currentQuery = createMemo(() => saved()?.query ?? libraryQuery({ tab: tab(), collection: view().collection, text: text(), sort: sort(), filters: filters() }));
  const queryKey = createMemo(() => JSON.stringify([view().view, tab(), currentQuery(), unprocessedOnly(), colors(), tags()]));
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const inspecting = createMemo(() => inspectorOpen() && selected().size > 0 && tab() !== 'highlights');
  const selectedIds = createMemo(() => [...selected()]);
  const [narrowInspector, setNarrowInspector] = createSignal(false);
  let libraryHost!: HTMLDivElement;
  let inspectorScroll = 0;
  const [inspectorPortal, setInspectorPortal] = createSignal<HTMLElement>();
  const [sheetExpanded, setSheetExpanded] = createSignal(false);
  let selectionAnchor: string | null = null;
  createEffect(on(queryKey, () => { setSelected(new Set<string>()); setInspectorOpen(false); selectionAnchor = null; }));
  const initialRead = cache.queries.get(queryKey());
  const [loadedKey, setLoadedKey] = createSignal(initialRead ? queryKey() : '');
  const [library, setLibrary] = createSignal<LibraryResult | undefined>(initialRead?.library);
  // Keep each row kind until its replacement arrives, even when the other tab loads.
  const [sourceRows, setSourceRows] = createSignal<LibraryRow[] | undefined>(initialRead && tab() !== 'highlights' ? initialRead.library.rows : undefined);
  const [highlights, setHighlights] = createSignal<HighlightResult | undefined>(initialRead?.highlights);
  const [unprocessedCount, setUnprocessedCount] = createSignal<number | undefined>(cache.unprocessedCount);
  const [highlightCount, setHighlightCount] = createSignal<number | undefined>(cache.highlightCount);
  const [countError, setCountError] = createSignal('');
  const highlightGroups = createMemo(() => {
    const groups = new Map<string, { sourceId: string; title: string; rows: HighlightRow[] }>();
    for (const row of highlights()?.rows ?? []) {
      const id = row.citation.source_id;
      let group = groups.get(id);
      if (!group) { group = { sourceId: id, title: row.source_title, rows: [] }; groups.set(id, group); }
      group.rows.push(row);
    }
    return [...groups.values()];
  });
  const [highlightSource, setHighlightSource] = createSignal<string | null>(null);
  const [highlightChapter, setHighlightChapter] = createSignal<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = createSignal<string | null>(null);
  const [highlightPassageOpen, setHighlightPassageOpen] = createSignal(false);
  const [highlightBusy, setHighlightBusy] = createSignal(false);
  const scopedHighlightGroups = createMemo(() => highlightGroups().filter(group => !highlightSource() || group.sourceId === highlightSource()));
  const chapterOptions = createMemo(() => [...new Set(scopedHighlightGroups().flatMap(group => highlightChapters(group.rows).map(chapter => chapter.title)).filter((title): title is string => title !== null))]);
  const highlightQueue = createMemo(() => scopedHighlightGroups().flatMap(group => highlightChapters(group.rows).flatMap(chapter => highlightChapter() === null || chapter.title === highlightChapter() ? chapter.rows : [])));
  const selectedHighlight = createMemo(() => highlightQueue().find(row => row.citation.id === selectedHighlightId()));
  const highlightIndex = createMemo(() => highlightQueue().findIndex(row => row.citation.id === selectedHighlightId()));
  createEffect(() => {
    const rows = highlightQueue();
    if (!rows.some(row => row.citation.id === selectedHighlightId())) {
      setSelectedHighlightId(rows[0]?.citation.id ?? null);
      if (!rows.length) setHighlightPassageOpen(false);
    }
  });
  const [followingPassage, setFollowingPassage] = createSignal('');
  const [followingError, setFollowingError] = createSignal('');
  const [followingLoading, setFollowingLoading] = createSignal(false);
  createEffect(on(() => {
    const row = selectedHighlight();
    return row ? `${row.citation.snapshot_id}:${row.citation.ordinal}` : null;
  }, () => {
    const row = selectedHighlight();
    setFollowingPassage(''); setFollowingError('');
    if (!row) { setFollowingLoading(false); return; }
    const controller = new AbortController();
    setFollowingLoading(true);
    void props.notebook.api.passages(row.citation.snapshot_id, row.citation.ordinal + 1, 1, controller.signal).then(result => {
      if (!controller.signal.aborted) { setFollowingPassage(result.passages[0]?.text ?? ''); setFollowingLoading(false); }
    }, reason => {
      if (!controller.signal.aborted) { setFollowingError(reason instanceof Error ? reason.message : String(reason)); setFollowingLoading(false); }
    });
    onCleanup(() => controller.abort());
  }));
  const tagOptions = createMemo(() => [...new Set([...(highlights()?.rows.flatMap(row => row.tags) ?? []), ...tags()])].sort().filter(tag => tag.toLocaleLowerCase().includes(tagQuery().toLocaleLowerCase())));
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const displayedSources = createMemo(() => tab() === 'highlights' || error() ? [] : sourceRows() ?? []);
  const hasResult = createMemo(() => collectionsIndex() ? collectionCards.latest !== undefined : tab() === 'highlights' ? highlights() !== undefined : sourceRows() !== undefined);
  const groups = createMemo(() => group() === 'none' || tab() === 'highlights' ? undefined : groupSources(displayedSources(), group() as Exclude<LibraryGroup, 'none'>));
  // Shift-click ranges follow what is on screen, so a grouped list selects in group order.
  const orderedSources = createMemo(() => groups()?.flatMap(value => value.rows) ?? displayedSources());
  const slowLoad = createSlowFlag(() => loading() && !hasResult());
  const slowCollections = createSlowFlag(() => !collectionCards.latest && (collections.loading || collectionCards.loading));
  let requestedTab: LibraryTab | undefined;
  const [commandError, setCommandError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [refresh, setRefresh] = createSignal(0);
  const [jobs, setJobs] = createSignal<IngestJob[]>([]);
  const [jobsError, setJobsError] = createSignal('');
  const [jobsRefresh, setJobsRefresh] = createSignal(0);
  const [retrying, setRetrying] = createSignal<string[]>([]);
  const [dismissedJobs, setDismissedJobs] = createSignal<Set<string>>(new Set(preferences.dismissed));
  let dismissedKey = preferences.dismissedKey;
  let tabKey = preferences.tabKey;
  let layoutKey = preferences.layoutKey;
  let tabChosen = false;
  // List or Shelf is a device preference per notebook, like the last tab.
  const [layout, setLayout] = createSignal<'list' | 'shelf'>(preferences.layout);
  const [coverLayout, setCoverLayout] = createSignal(coverMedia.matches);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const finishedDate = createMemo(() => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: props.notebook.settings()?.time_zone }));
  const coverChanged = () => setCoverLayout(coverMedia.matches);
  coverMedia.addEventListener('change', coverChanged);
  onCleanup(() => coverMedia.removeEventListener('change', coverChanged));
  // Desktop views may scroll; the cover keeps Reading, Inbox and Highlights visible beside its overflow.
  let tabStrip: HTMLDivElement | undefined;
  let addButton!: HTMLButtonElement;
  createEffect(() => {
    tab(); view().view; coverLayout();
    queueMicrotask(() => tabStrip?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });
  // Every Reading source gets a card, including books not yet started; the cover adds its Inbox below.
  const [reading, setReading] = createSignal<LibraryRow[]>(cache.reading ?? []);
  const [upNext, setUpNext] = createSignal<LibraryRow[]>(cache.upNext ?? []);
  const [readingError, setReadingError] = createSignal('');
  createEffect(() => {
    if (!preferencesReady()) return;
    props.notebook.changeSequence(); refresh();
    const includeInbox = coverLayout();
    const controller = new AbortController();
    // Cards follow the toolbar's sort; on the Reading tab they stand in for the rows.
    const { sort: order, direction } = libraryQuery({ tab: 'reading', text: '', sort: sort(), filters: { people: [], decades: [], publishers: [], languages: [] }, collection: null });
    void props.notebook.api.library({ states: includeInbox ? ['reading', 'inbox'] : ['reading'], sort: order, direction, limit: 100000 }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        cache.reading = keepRows(reading(), result.rows.filter(row => row.source.state === 'reading'));
        cache.upNext = keepRows(upNext(), result.rows.filter(row => row.source.state === 'inbox'));
        batch(() => { setReading(cache.reading!); setUpNext(cache.upNext!); setReadingError(''); });
      }, reason => { if (!controller.signal.aborted) setReadingError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });
  // Reading now leads Reading and All only; the other tabs list their own state.
  const showReading = createMemo(() => (tab() === 'reading' || tab() === 'all') && !view().collection && !text().trim() && !filtered() && !view().view);
  // On Reading the cards are the list, so they give way to the Shelf and to grouped rows; the phone always keeps them.
  const readingCards = createMemo(() => showReading() && tab() === 'reading' && (coverLayout() || layout() === 'list' && group() === 'none'));
  const [openedSource, setOpenedSource] = createSignal<string>();
  function openSource(target: OpenTarget, shift: boolean) {
    if (target.kind === 'page') setOpenedSource(target.pageId);
    // In a split the Library stays the list and the other pane shows the source; Shift opens it here instead.
    props.onOpen(target, props.split ? !shift : shift || window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
  }
  function openAdd(anchor: HTMLElement) {
    if (EMBEDDED) { fileInput.click(); return; }
    setPopup({ kind: 'add', anchor });
  }
  onMount(() => {
    if (initialView.tab !== props.view.tab) props.onViewChange({ ...initialView });
    if (props.add) { openAdd(addButton); props.onAddOpened?.(); }
    if (props.details?.length) {
      setSelected(new Set(props.details)); setInspectorOpen(true);
      props.onDetailsOpened?.();
    }
    setInspectorPortal(libraryHost.closest<HTMLElement>('.pane') ?? undefined);
    // Below 1000 px the ledger beside a 460 px card cannot hold the selection bar on one line, so the card replaces the list.
    const measure = () => setNarrowInspector(libraryHost.clientWidth < 1000);
    const observer = new ResizeObserver(measure);
    observer.observe(libraryHost); measure();
    const viewport = window.visualViewport;
    const resizeSheet = () => {
      const height = viewport?.height ?? window.innerHeight;
      const keyboard = window.innerHeight - height - (viewport?.offsetTop ?? 0);
      const host = inspectorPortal();
      host?.style.setProperty('--inspector-viewport-height', `${height}px`);
      host?.style.setProperty('--inspector-keyboard-bottom', keyboard > 120 ? `${keyboard}px` : '0px');
      host?.classList.toggle('library-inspector-keyboard', keyboard > 120 && inspecting());
    };
    viewport?.addEventListener('resize', resizeSheet); resizeSheet();
    onCleanup(() => {
      observer.disconnect(); viewport?.removeEventListener('resize', resizeSheet);
      inspectorPortal()?.classList.remove('library-inspector-keyboard');
    });
  });
  createEffect(() => {
    const controller = new AbortController();
    void props.notebook.api.notebook(controller.signal).then(async info => {
      if (controller.signal.aborted) return;
      cache.notebookId = info.id;
      if (!untrack(preferencesReady)) {
        const stored = libraryPreferences(info.id);
        dismissedKey = stored.dismissedKey; tabKey = stored.tabKey; layoutKey = stored.layoutKey;
        batch(() => {
          setDismissedJobs(previous => new Set([...previous, ...stored.dismissed]));
          setLayout(stored.layout);
        });
        if (!tabChosen && !view().view && view().tab === 'inbox') {
          if (coverLayout()) update({ tab: 'reading', scroll: 0 });
          else if (tabs.some(tab => tab.id === stored.remembered)) update({ tab: stored.remembered as LibraryTab, scroll: 0 });
          else {
            const result = await props.notebook.api.library({ limit: 0 }, controller.signal);
            if (!controller.signal.aborted && !tabChosen) update({ tab: result.counts.inbox ? 'inbox' : result.counts.reading ? 'reading' : 'all', scroll: 0 });
          }
        }
      }
    }).catch(reason => { if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setPreferencesReady(true); });
    onCleanup(() => controller.abort());
  });
  function chooseLayout(value: 'list' | 'shelf') {
    setLayout(value);
    try { if (layoutKey) localStorage.setItem(layoutKey, value); } catch { /* Session-only preference. */ }
  }
  function dismissJob(id: string) {
    const next = new Set(dismissedJobs()); next.add(id); setDismissedJobs(next);
    try { if (dismissedKey) localStorage.setItem(dismissedKey, JSON.stringify([...next])); } catch { /* The preference lasts for this tab. */ }
  }
  const [popup, setPopup] = createSignal<LibraryPopup | null>(null);
  const sourceMenuId = createMemo(() => {
    const state = popup();
    return state?.kind === 'menu' ? state.source?.page.id : undefined;
  });
  const doneJobs = new Set<string>();
  const sourceTitles = createMemo(() => new Map(props.notebook.roots().map(root => [root.id, root.text])));
  // Failed jobs belong to the Inbox backlog; active jobs still show during ingestion.
  const shownJobs = createMemo(() => tab() === 'highlights' || tab() === 'collections' || error() ? [] : visibleJobs(jobs().filter(job => job.state !== 'failed'), new Set([...displayedSources().map(row => row.page.id), ...sourceTitles().keys()])));
  const failedJobs = createMemo(() => tab() === 'inbox' && !error() ? jobs().filter(job => job.state === 'failed' && !dismissedJobs().has(job.id)) : []);
  const browseEntries = createMemo<BrowseEntry[]>(() => {
    const facets = library()?.facets;
    if (!facets) return [];
    // People without a page cannot be filtered by id, so Browse leaves them out.
    return [
      ...facets.people.flatMap(person => person.id ? [{ field: 'people' as const, value: person.id, label: person.name, count: person.count }] : []),
      ...facets.decades.map(decade => ({ field: 'decades' as const, value: decade.decade, label: `${decade.decade}s`, count: decade.count })),
      ...facets.publishers.map(publisher => ({ field: 'publishers' as const, value: publisher.value, label: publisher.value, count: publisher.count })),
      ...facets.languages.map(language => ({ field: 'languages' as const, value: language.value, label: formatSourceValue('language', language.value), count: language.count })),
    ];
  });
  const chosen = (field: BrowseField, value: string | number) => (filters()[field] as (string | number)[]).includes(value);
  const chosenFilters = createMemo(() => browseFields.flatMap(({ field }) => (filters()[field] as (string | number)[]).map(value => ({
    field, value,
    label: browseEntries().find(entry => entry.field === field && entry.value === value)?.label
      ?? (field === 'people' ? sourceTitles().get(String(value)) ?? 'Unknown person' : field === 'decades' ? `${value}s` : field === 'languages' ? formatSourceValue('language', String(value)) : String(value)),
  }))));
  function toggleFilter(field: BrowseField, value: string | number) {
    const values = filters()[field] as (string | number)[];
    update({ view: null, filters: { ...filters(), [field]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] }, scroll: 0 });
  }
  // A view spanning several states names each row's state.
  const mixedStates = createMemo(() => currentQuery().states?.length !== 1);
  let scroll!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let restoreScroll: number | null = initialView.scroll;
  onMount(() => {
    if (hasResult()) { scroll.scrollTop = restoreScroll ?? 0; restoreScroll = null; }
  });
  let disposed = false;
  onCleanup(() => { disposed = true; setLinkedCitation(null); });

  const highlightActions = createHighlightActions(props.notebook, props.onOpen, setCommandError, row => {
    if (row.processed) return;
    const next = nextUnprocessedHighlight(highlightQueue(), row.citation.id);
    batch(() => {
      setHighlights(previous => previous && ({
        ...previous,
        total: unprocessedOnly() ? Math.max(0, previous.total - 1) : previous.total,
        rows: unprocessedOnly() ? previous.rows.filter(value => value.citation.id !== row.citation.id) : previous.rows.map(value => value.citation.id === row.citation.id ? { ...value, processed: true, triage: 'processed' } : value),
      }));
      setSelectedHighlightId(next ?? (unprocessedOnly() ? null : row.citation.id));
      if (!next && unprocessedOnly()) setHighlightPassageOpen(false);
    });
  });

  function chooseHighlight(row: HighlightRow) {
    setSelectedHighlightId(row.citation.id);
    if (coverLayout()) {
      setHighlightPassageOpen(true);
      queueMicrotask(() => scroll.querySelector<HTMLButtonElement>('.library-back-highlights')?.focus({ preventScroll: true }));
    }
  }
  function closeHighlightPassage() {
    setHighlightPassageOpen(false);
    queueMicrotask(() => Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]')).find(button => button.dataset.libraryRow === selectedHighlightId())?.focus());
  }
  function stepHighlight(direction: number) {
    const row = highlightQueue()[highlightIndex() + direction];
    if (row) setSelectedHighlightId(row.citation.id);
  }
  function highlightKey(event: KeyboardEvent) {
    if (!props.active || tab() !== 'highlights' || event.defaultPrevented || event.isComposing || popup() || document.querySelector('.popup:not([inert])')) return;
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest('.pane[data-pane]');
    if (pane && pane.getAttribute('data-pane') !== props.pane) return;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') || target instanceof HTMLElement && target.isContentEditable) return;
    const key = event.key.toLowerCase();
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'z') {
      if (!highlightActions.canUndo()) return;
      event.preventDefault(); event.stopPropagation(); void undoHighlight(); return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const rows = highlightQueue(), row = selectedHighlight();
    if (!row) return;
    if (['j', 'k', 'arrowdown', 'arrowup', 'home', 'end'].includes(key)) {
      event.preventDefault(); event.stopPropagation();
      const next = key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, highlightIndex() + (key === 'j' || key === 'arrowdown' ? 1 : -1)));
      const id = rows[next]?.citation.id;
      if (!id) return;
      setSelectedHighlightId(id);
      Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]')).find(button => button.dataset.libraryRow === id)?.focus();
      return;
    }
    if (highlightBusy()) return;
    const actions = { e: 'triage', n: 'note', c: 'card', t: 'tag' } as const;
    const color = highlightColors[Number(key) - 1];
    if (key in actions) {
      event.preventDefault(); event.stopPropagation(); void runHighlight(row, actions[key as keyof typeof actions]);
    } else if (color && /^[1-5]$/.test(key)) {
      event.preventDefault(); event.stopPropagation();
      void highlightActions(row).then(actions => actions.setColor(color)).catch(reason => setCommandError(reason instanceof Error ? reason.message : String(reason)));
    } else if (key === 'o') {
      event.preventDefault(); event.stopPropagation();
      openSource({ kind: 'reader', sourceId: row.citation.source_id, snapshotId: row.citation.snapshot_id, citationId: row.citation.id }, false);
    }
  }
  onMount(() => {
    document.addEventListener('keydown', highlightKey);
    onCleanup(() => document.removeEventListener('keydown', highlightKey));
  });
  async function runHighlight(row: HighlightRow, action: 'triage' | 'note' | 'card' | 'tag') {
    if (highlightBusy()) return;
    setCommandError(''); setHighlightBusy(true);
    try {
      const actions = await highlightActions(row);
      if (disposed) return;
      if (action === 'triage') await actions.toggleProcessed();
      else if (action === 'note') actions.openNote();
      else if (action === 'card') actions.makeCard();
      else actions.tag();
    } catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setHighlightBusy(false); }
  }
  function toggleHighlightColor(color: string) {
    update({ colors: colors().includes(color) ? colors().filter(value => value !== color) : [...colors(), color], scroll: 0 });
  }
  async function undoHighlight() {
    setCommandError('');
    try { await highlightActions.undo(); }
    catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function highlightMenu(row: HighlightRow, anchor: HTMLElement) {
    setCommandError('');
    try {
      const { items, Header } = await highlightActions(row, `“${row.citation.quote}” · ${row.source_title}, ${row.citation.chapter_title ?? `¶${row.citation.ordinal + 1}`}`);
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, label: 'Actions for highlight', Header, items: [
        { label: 'Open in reader', action: () => props.onOpen({ kind: 'reader', sourceId: row.citation.source_id, snapshotId: row.citation.snapshot_id, citationId: row.citation.id }, true) },
        ...items,
      ] });
    } catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const update = (patch: Partial<LibraryViewState>) => {
    if (patch.tab !== undefined) {
      if (patch.collection === undefined) patch.collection = null;
      tabChosen = true;
      try { if (tabKey) localStorage.setItem(tabKey, patch.tab); } catch { /* Session-only preference. */ }
    }
    const next = { ...view(), ...patch, scroll: patch.scroll ?? scroll.scrollTop };
    batch(() => {
      const previousKey = queryKey();
      setView(next);
      if (patch.scroll !== undefined) {
        if (queryKey() !== previousKey) restoreScroll = patch.scroll;
        else { restoreScroll = null; scroll.scrollTop = patch.scroll; }
      }
    });
    props.onViewChange({ ...next });
  };
  createEffect(on(() => props.view, next => {
    const previous = view();
    const filtersChanged = JSON.stringify([next.colors, next.tags, next.filters]) !== JSON.stringify([previous.colors, previous.tags, previous.filters]);
    if (next.view === previous.view && next.collection === previous.collection && next.tab === previous.tab && next.text === previous.text && next.sort === previous.sort && next.group === previous.group && next.unprocessedOnly === previous.unprocessedOnly && !filtersChanged && next.scroll === previous.scroll) return;
    const queryChanged = next.view !== previous.view || next.collection !== previous.collection || next.tab !== previous.tab || next.text !== previous.text || next.sort !== previous.sort || next.unprocessedOnly !== previous.unprocessedOnly || filtersChanged;
    restoreScroll = queryChanged ? next.scroll : null;
    setView({ ...next });
    if (!queryChanged) scroll.scrollTop = next.scroll;
  }, { defer: true }));

  function viewFields(query: LibraryQuery): Pick<LibraryViewState, 'tab' | 'text' | 'sort' | 'filters' | 'collection'> {
    return {
      tab: query.collection_id ? 'collections' : query.states?.length === 1 ? query.states[0]! : 'all', collection: query.collection_id ?? null, text: query.text ?? '', sort: query.sort ?? 'added',
      filters: { people: query.people ?? [], decades: query.decades ?? [], publishers: query.publishers ?? [], languages: query.languages ?? [] },
    };
  }
  createEffect(() => {
    props.notebook.changeSequence(); props.notebook.lastChange(); refresh();
    const controller = new AbortController();
    void props.notebook.api.libraryViews(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      cache.views = result;
      batch(() => {
        setViews(result); setViewsError('');
        const id = view().view;
        if (!id) return;
        const value = result.find(value => value.id === id);
        if (value) update(viewFields(value.query));
        else update({ view: null });
      });
    }).catch(reason => {
      if (!controller.signal.aborted) setViewsError(reason instanceof Error ? reason.message : String(reason));
    });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    props.notebook.changeSequence(); refresh();
    const controller = new AbortController();
    void Promise.all([
      props.notebook.api.highlights({ unprocessed: true, limit: 0 }, controller.signal),
      props.notebook.api.highlights({ limit: 0 }, controller.signal),
    ]).then(([unprocessed, all]) => {
      if (!controller.signal.aborted) {
        cache.unprocessedCount = unprocessed.total; cache.highlightCount = all.total;
        batch(() => { setUnprocessedCount(unprocessed.total); setHighlightCount(all.total); setCountError(''); });
      }
    }).catch(reason => { if (!controller.signal.aborted) setCountError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });

  createEffect(() => {
    if (!preferencesReady()) return;
    const currentTab = tab();
    const query = currentQuery();
    const unprocessed = unprocessedOnly();
    const highlightColors = colors(), highlightTags = tags();
    const currentKey = queryKey();
    props.notebook.changeSequence(); refresh();
    const controller = new AbortController();
    setLoading(true); setError('');
    // Typing and bursts of changes wait for a pause; a tab's first rows load at once.
    const pause = currentTab === requestedTab && untrack(hasResult);
    requestedTab = currentTab;
    const timer = setTimeout(() => {
      void Promise.all([
        props.notebook.api.library(query, controller.signal),
        currentTab === 'highlights' ? props.notebook.api.highlights({ unprocessed, colors: highlightColors, tags: highlightTags, limit: 200 }, controller.signal) : Promise.resolve(undefined),
      ]).then(([sources, cited]) => {
        if (controller.signal.aborted) return;
        cache.queries.set(currentKey, { library: sources, highlights: cited });
        cache.library = sources;
        const focused = scroll.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.libraryRow : undefined;
        batch(() => {
          setLibrary(sources);
          if (cited) setHighlights(cited);
          else {
            setSourceRows(rows => keepRows(rows, sources.rows));
            const ids = new Set(sources.rows.map(row => row.page.id));
            // Leave the card open when its edits move a source out of the current filter.
            if (!inspecting()) setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
            if (selectionAnchor && !ids.has(selectionAnchor)) selectionAnchor = null;
          }
          setLoadedKey(currentKey); setLoading(false);
        });
        requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          if (restoreScroll !== null) { scroll.scrollTop = restoreScroll; restoreScroll = null; }
          if (focused) Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]')).find(row => row.dataset.libraryRow === focused)?.focus({ preventScroll: true });
        });
      }).catch(reason => {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      });
    }, pause ? 150 : 0);
    onCleanup(() => { controller.abort(); clearTimeout(timer); });
  });

  createEffect(() => {
    jobsRefresh(); props.notebook.changeSequence();
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await props.notebook.api.ingestJobs(undefined, controller.signal);
        if (controller.signal.aborted) return;
        let completed = false;
        for (const job of result) {
          if (job.state === 'done' && !doneJobs.has(job.id)) { doneJobs.add(job.id); completed = true; }
        }
        setJobs(recentJobs(result, Date.now())); setJobsError('');
        if (completed) setRefresh(value => value + 1);
        if (result.some(job => job.state === 'queued' || job.state === 'running')) timer = window.setTimeout(() => { void poll(); }, 1500);
      } catch (reason) {
        if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    onCleanup(() => { controller.abort(); clearTimeout(timer); });
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
      try { recordJob(await props.notebook.api.upload(file, file.name)); }
      catch (reason) { errors.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`); }
    }
    if (!disposed && errors.length) setCommandError(errors.join('\n'));
  }
  async function retryJob(job: IngestJob) {
    setRetrying(previous => [...previous, job.id]); setCommandError('');
    try { recordJob(await props.notebook.api.retryJob(job.id)); }
    catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setRetrying(previous => previous.filter(id => id !== job.id)); }
  }
  function JobRows(rows: { jobs: IngestJob[] }) {
    return <div class="library-jobs" aria-label="Ingestion jobs"><For each={rows.jobs}>{job => {
      const label = () => jobLabel(job, sourceTitles());
      return <div class="library-row library-job">
        <span class="library-leading"><Icon name={job.state === 'failed' ? 'warning' : job.state === 'done' ? 'book' : 'saving'} /></span>
        <span class="library-job-name" role="group" title={label().name} aria-label={label().name}>{importJobName(label().name)}</span><span class="library-message">{label().state}</span>
        <Show when={job.state !== 'done' && label().attempt}><span class="library-message">{label().attempt}</span></Show>
        <Show when={job.state !== 'done' && job.next_attempt_at !== null && props.notebook.settings()}><span class="library-message">retries at {retryTime(job.next_attempt_at!, props.notebook.settings()!.time_zone)}</span></Show>
        <Show when={job.state === 'failed'}><div class="library-job-actions"><Button disabled={retrying().includes(job.id)} onClick={() => { void retryJob(job); }}>Retry</Button><Button onClick={() => dismissJob(job.id)}>Dismiss</Button></div></Show>
        <Show when={job.error}><span class="library-job-error">{job.error}</span></Show>
      </div>;
    }}</For></div>;
  }
  async function changeState(row: LibraryRow, state: ReadingState) {
    if (saving()) return;
    setSaving(true); setCommandError('');
    try {
      await props.notebook.commit([sourceStateOperation(row, state)]);
      if (!disposed) setRefresh(value => value + 1);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setSaving(false); }
  }
  function clearSelection() {
    setSelected(new Set<string>()); setInspectorOpen(false); selectionAnchor = null;
    props.onSaveState?.('saved');
  }
  function showDetails(ids?: readonly string[]) {
    inspectorScroll = scroll.scrollTop;
    if (ids) { setSelected(new Set(ids)); selectionAnchor = ids[0] ?? null; }
    setInspectorOpen(true);
  }
  function backToSources() {
    setInspectorOpen(false); props.onSaveState?.('saved');
    requestAnimationFrame(() => { scroll.scrollTop = inspectorScroll; });
  }
  async function changeSelectedState(state: ReadingState) {
    if (saving()) return;
    const operations = displayedSources().filter(row => selected().has(row.page.id)).map(row => sourceStateOperation(row, state));
    if (!operations.length) return;
    setSaving(true); setCommandError('');
    try {
      await props.notebook.commit(operations, 'Change reading state');
      if (!disposed) { clearSelection(); setRefresh(value => value + 1); }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setSaving(false); }
  }
  function confirmDelete(anchor: HTMLElement, rows: LibraryRow[]) {
    if (!rows.length) return;
    setCommandError('');
    setPopup({ kind: 'delete-sources', anchor, sources: rows.map(row => ({ id: row.page.id, title: row.page.text })) });
  }
  async function deleteSources(sources: { id: string; title: string }[]) {
    if (saving()) return;
    setSaving(true); setCommandError('');
    try {
      await props.onDeleteSources(sources);
      if (!disposed) { setPopup(null); clearSelection(); }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) { setSaving(false); setRefresh(value => value + 1); } }
  }
  function toggleSelection(id: string, range: boolean) {
    setSelected(previous => selectSources(orderedSources().map(row => row.page.id), previous, id, selectionAnchor, range));
    selectionAnchor = id;
    inspectorScroll = scroll.scrollTop;
    setInspectorOpen(true);
  }
  function chooseView(value: LibraryView) {
    update({ view: value.id, ...viewFields(value.query), scroll: 0 });
  }
  async function saveView(name: string, id: string, previous: LibraryView | null) {
    if (saving()) return;
    setSaving(true); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'save_library_view', id, base_revision: previous?.revision ?? null, name: name.trim(), query: previous?.query ?? currentQuery() }], previous ? 'Rename library view' : 'Save library view');
      if (!disposed) { update({ view: id }); setPopup(null); setRefresh(value => value + 1); }
    } finally { if (!disposed) setSaving(false); }
  }
  async function deleteView(value: LibraryView) {
    if (saving()) return;
    setSaving(true); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'delete_library_view', id: value.id, base_revision: value.revision }], 'Delete library view');
      if (!disposed) {
        setDeleted(value);
        clearTimeout(deletedTimer); deletedTimer = setTimeout(() => setDeleted(null), 10000);
        if (view().view === value.id) update({ view: null });
        setPopup(null); setRefresh(value => value + 1);
      }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setSaving(false); }
  }
  async function undoDelete() {
    const value = deleted(); if (!value || saving()) return;
    setSaving(true); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'save_library_view', id: value.id, base_revision: null, name: value.name, query: value.query }], 'Restore library view');
      if (!disposed) { setDeleted(null); chooseView(value); setRefresh(value => value + 1); }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setSaving(false); }
  }
  function viewMenu(value: LibraryView, anchor: HTMLElement) {
    setPopup({ kind: 'menu', anchor, label: 'Library view actions', items: [
      { label: 'Rename', action: () => setPopup({ kind: 'name', anchor, saved: value, id: value.id }) },
      { label: props.notebook.confirmViewDelete() ? 'Delete view…' : 'Delete view', icon: 'trash', danger: true, action: () => { setCommandError(''); if (props.notebook.confirmViewDelete()) setPopup({ kind: 'delete', anchor, saved: value }); else void deleteView(value); } },
      { label: 'Export BibTeX', action: () => { void downloadQuery('bibtex', value.query); } },
      { label: 'Export CSL JSON', action: () => { void downloadQuery('csl', value.query); } },
      { label: 'Export Markdown', action: () => { void downloadQuery('markdown', value.query); } },
    ] });
  }
  async function downloadQuery(format: ExportFormat, query: LibraryQuery) {
    setCommandError('');
    try {
      const blob = await props.notebook.api.exportQuery(format, query);
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
      const blob = await props.notebook.api.exportSources(format, ids);
      if (disposed) return;
      downloadBlob(blob, `library.${exportExtensions[format]}`);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function exportMenu(anchor: HTMLElement) {
    const ids = [...selected()], query = currentQuery();
    setPopup({ kind: 'menu', anchor, label: 'Export sources', items: [
      { label: 'BibTeX', action: () => { if (ids.length) void download('bibtex', ids); else void downloadQuery('bibtex', query); } },
      { label: 'CSL JSON', action: () => { if (ids.length) void download('csl', ids); else void downloadQuery('csl', query); } },
      { label: 'Markdown', action: () => { if (ids.length) void download('markdown', ids); else void downloadQuery('markdown', query); } },
    ] });
  }
  async function rowMenu(row: LibraryRow, anchor: HTMLElement) {
    setCommandError('');
    let memberships: string[], pages: Block[];
    try { [memberships, pages] = await Promise.all([sourceCollections(props.notebook.api, row.page.id), collectionPages(props.notebook.api)]); }
    catch (reason) { setCommandError(reason instanceof Error ? reason.message : String(reason)); return; }
    if (disposed || !anchor.isConnected) return;
    setPopup({ kind: 'menu', anchor, label: 'Source actions', source: row, items: [
      ...(row.source.current_snapshot_id ? [{ label: row.source.last_read_at != null ? 'Continue reading' : 'Read', icon: 'book' as const, action: () => props.onOpen({ kind: 'reader', sourceId: row.page.id }, false) }] : []),
      { label: 'Details', action: () => showDetails([row.page.id]) },
      ...stateActions.filter(action => action.state !== row.source.state).map(action => ({
        label: action.label, disabledReason: saving() ? 'Saving…' : undefined,
        action: () => { void changeState(row, action.state); },
      })),
      { label: 'Add to collection…', action: () => setPopup({ kind: 'collection-picker', anchor, sources: [row.page.id] }) },
      ...pages.filter(collection => memberships.includes(collection.id)).map(collection => ({
        section: 'Collections', label: `Remove from ${collection.text}`,
        action: () => { void collectionActions.run(`Removed from ${collection.text}`, () => changeCollectionMembers(props.notebook, collection.id, [row.page.id], false)); },
      })),
      { label: 'Export BibTeX', section: coverLayout() ? 'Export' : undefined, icon: 'download', action: () => { void download('bibtex', [row.page.id]); } },
      { label: 'Export CSL JSON', icon: 'download', action: () => { void download('csl', [row.page.id]); } },
      { label: 'Export Markdown', icon: 'download', action: () => { void download('markdown', [row.page.id]); } },
      { label: 'Delete…', section: coverLayout() ? 'Delete' : undefined, icon: 'trash', danger: true, disabledReason: saving() ? 'Saving…' : undefined, action: () => confirmDelete(anchor, [row]) },
    ] });
  }
  function rowKey(event: KeyboardEvent, target: OpenTarget) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); tab() !== 'highlights' ? openSource(target, event.shiftKey) : props.onOpen(target, event.shiftKey);
      return;
    }
    const current = event.currentTarget as HTMLButtonElement;
    const shelf = !!current.closest('.library-shelf');
    const rows = Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]'));
    const index = rows.indexOf(current);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (shelf && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // Up and down go to the nearest cover in the next row of covers, across group headings.
      const from = current.getBoundingClientRect();
      const down = event.key === 'ArrowDown';
      const candidates = rows.map((row, at) => ({ at, rect: row.getBoundingClientRect() })).filter(({ rect }) => down ? rect.top > from.top + 1 : rect.top < from.top - 1);
      if (!candidates.length) next = index;
      else {
        const top = down ? Math.min(...candidates.map(({ rect }) => rect.top)) : Math.max(...candidates.map(({ rect }) => rect.top));
        next = candidates.filter(({ rect }) => rect.top === top).reduce((best, item) => Math.abs(item.rect.left - from.left) < Math.abs(best.rect.left - from.left) ? item : best).at;
      }
    } else {
      // On the shelf left and right move one book; in the list up and down move one row.
      const steps: Record<string, number> = shelf ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
      if (!(event.key in steps)) return;
      next = Math.max(0, Math.min(rows.length - 1, index + steps[event.key]!));
    }
    rows[next]?.focus(); event.preventDefault(); event.stopPropagation();
  }
  function InspectorView() {
    return <aside class="library-inspector-host" classList={{ 'library-inspector-sheet': coverLayout(), 'library-inspector-expanded': sheetExpanded() }} aria-label="Source details">
      <Show when={coverLayout()}><Button class="library-inspector-grip" label={sheetExpanded() ? 'Collapse details sheet' : 'Expand details sheet'} aria-expanded={sheetExpanded()} onClick={() => setSheetExpanded(value => !value)}><span /></Button></Show>
      <MetadataInspector notebook={props.notebook} sourceIds={selectedIds()} onOpen={props.onOpen} onClose={clearSelection} phone={coverLayout()}
        backLabel={narrowInspector() && !coverLayout() ? `Back to ${library()?.total ?? displayedSources().length} sources` : undefined}
        onBack={backToSources} onSaveState={props.onSaveState} />
    </aside>;
  }

  function sourceLongPress(row: LibraryRow) {
    let timer: number | undefined;
    let pressed = false;
    let x = 0, y = 0;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    onCleanup(cancel);
    return {
      onPointerDown: (event: PointerEvent) => {
        if (!coverLayout() || event.button !== 0 || (event.target as HTMLElement).closest('.library-checkbox, .library-book-more, [aria-haspopup]')) return;
        x = event.clientX; y = event.clientY; pressed = false;
        timer = window.setTimeout(() => { pressed = true; showDetails([row.page.id]); }, 500);
      },
      onPointerMove: (event: PointerEvent) => { if (Math.hypot(event.clientX - x, event.clientY - y) > 8) cancel(); },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: MouseEvent) => { if (coverLayout()) { event.preventDefault(); cancel(); pressed = true; showDetails([row.page.id]); } },
      'on:click': { capture: true, handleEvent: (event: MouseEvent) => { if (pressed) { event.preventDefault(); event.stopPropagation(); pressed = false; } } },
    };
  }
  function SourceRows(rowsProps: { rows: LibraryRow[] }) {
    return <Show when={layout() === 'shelf'} fallback={<div role="list"><For each={rowsProps.rows}>{row => {
      const target: OpenTarget = { kind: 'page', pageId: row.page.id };
      return <div class="library-row library-source-row" classList={{ 'library-row-selected': selected().has(row.page.id), 'library-source-current': openedSource() === row.page.id }} role="listitem" {...sourceLongPress(row)}>
        <div class="library-leading">
          {/* A 28 px row cannot show a cover legibly; the phone ledger's taller rows can. */}
          <span class="library-source-image"><Show when={coverLayout() && row.cover} fallback={<Icon name={(row.snapshot_format ?? row.source.format) === 'article' ? 'article' : 'book'} />}><ResourceImage snapshotId={row.source.current_snapshot_id ?? ''} href={row.cover!} alt="" loading="lazy" /></Show></span>
          <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
            <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
          </Button>
        </div>
        <Button class="library-row-open" data-library-row={row.page.id} onClick={event => openSource(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
          <span class="library-siglum" aria-hidden="true">{row.source.siglum}</span><span class="library-title">{row.page.text}</span><span class="library-byline">{sourceByline(row)}</span>
          <Show when={mixedStates()}><span class="library-count library-state">{stateLabels[row.source.state]}</span></Show>
          <span class="library-count library-year" aria-label="Published year">{row.published?.slice(0, 4)}</span>
          {/* Finished needs no percentage, and an unread Inbox or Abandoned source needs no "Not started". */}
          <span class="library-progress"><Show when={row.source.state === 'finished'} fallback={<Show when={row.progress > 0} fallback={row.source.state === 'reading' ? 'Not started' : null}>
            <span class="library-reading-rule library-reading-started" style={{ '--progress': `${row.progress * 100}%` }} aria-hidden="true" /><span>{formatProgress(row.progress)}</span>
          </Show>}><Show when={row.source.state_changed_at != null}><span title={`Finished ${finishedDate().format(row.source.state_changed_at!)}`}>{finishedDate().format(row.source.state_changed_at!)}</span></Show></Show></span>
          <span class="library-highlight-count" aria-label={row.unprocessed ? `${row.unprocessed} unprocessed highlights` : undefined}><Show when={row.unprocessed > 0}><Icon name="highlight" />{row.unprocessed}</Show></span>
        </Button>
        <Button icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" disabled={saving()} onClick={event => rowMenu(row, event.currentTarget)} />
      </div>;
    }}</For></div>}>
      <div class="library-shelf" role="list"><For each={rowsProps.rows}>{row => {
        const target: OpenTarget = { kind: 'page', pageId: row.page.id };
        return <div class="library-book library-source-row" classList={{ 'library-row-selected': selected().has(row.page.id), 'library-source-current': openedSource() === row.page.id }} role="listitem" {...sourceLongPress(row)}>
          <Button class="library-book-open" data-library-row={row.page.id} onClick={event => openSource(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
            <SourceCover row={row} siglum={row.source.siglum} />
            <span class="library-reading-rule" classList={{ 'library-reading-started': row.progress > 0 }} style={{ '--progress': `${row.progress * 100}%` }} aria-hidden="true" />
            <span class="library-book-title">{row.page.text}</span>
            <span class="library-book-byline">{sourceByline(row)}</span>
            <span class="library-book-apparatus">
              <span class="library-siglum" aria-hidden="true">{row.source.siglum}</span>
              <Show when={mixedStates()}><span class="library-book-state">{stateLabels[row.source.state]}</span></Show>
              <Show when={row.published}><span aria-label="Published year">{row.published!.slice(0, 4)}</span></Show>
              <Show when={row.progress > 0 && row.source.state !== 'finished'}><span>{formatProgress(row.progress)}</span></Show>
              <Show when={row.unprocessed > 0}><span class="library-book-highlights" aria-label={`${row.unprocessed} unprocessed highlights`}><Icon name="highlight" />{row.unprocessed}</span></Show>
            </span>
          </Button>
          <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
            <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
          </Button>
          <Button class="library-book-more" icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" aria-expanded={sourceMenuId() === row.page.id} disabled={saving()} onClick={event => rowMenu(row, event.currentTarget)} />
        </div>;
      }}</For></div>
    </Show>;
  }

  function HighlightPassage() {
    let passageScroll!: HTMLDivElement;
    createEffect(on(() => selectedHighlight()?.citation.id, () => {
      if (passageScroll) passageScroll.scrollTop = 0;
    }));
    return <Show when={selectedHighlight()}>{value => {
      const row = value;
      const colorStyle = () => ({ '--highlight-bar': row().color ? `var(--highlight-${row().color})` : 'var(--faint)' });
      return <section class="library-highlight-passage" aria-label="Selected highlight">
        <header class="library-passage-heading">
          <div class="library-passage-topline"><Button class="library-back-highlights" icon="left" onClick={closeHighlightPassage}>Back to highlights</Button><span class="library-highlight-meta">{coverLayout() ? unprocessedOnly() ? 'Unprocessed' : 'All highlights' : `Selected highlight · ${highlightIndex() + 1} of ${highlightQueue().length}`}</span></div>
          <h2>{row().source_title}</h2>
          <Show when={row().citation.chapter_title && row().citation.quote.trim() !== row().citation.chapter_title?.trim()}><p class="library-highlight-meta">{row().citation.chapter_title}</p></Show>
        </header>
        <div ref={passageScroll} class="library-passage-scroll">
          <Show when={row().block.block.text.trim() !== row().citation.quote.trim()}><div class="library-highlight-authored"><BlockText text={row().block.block.text} notebook={props.notebook} interactive={false} /></div></Show>
          <blockquote class="library-passage-quote" style={colorStyle()}>{row().citation.quote}</blockquote>
          <p class="library-highlight-meta">{highlightMeta(row(), props.notebook.settings()?.time_zone ?? 'UTC')} · {row().notes ? `${row().notes} ${row().notes === 1 ? 'note' : 'notes'}` : 'No notes'}</p>
          <Show when={row().block.page.id !== row().citation.source_id}><Button class="library-highlight-filed" onClick={event => openSource({ kind: 'page', pageId: row().block.page.id, blockId: row().block.block.id }, event.shiftKey)}>In {row().block.page.text}</Button></Show>
          <Show when={row().tags.length}><div class="library-highlight-tags"><For each={row().tags}>{tag => <span class="outline-tag">#{tag}</span>}</For></div></Show>
          <Show when={followingPassage()}><div class="library-passage-context"><h3>Passage continues</h3><p>{followingPassage()}</p></div></Show>
          <Show when={followingLoading()}><p class="library-highlight-meta" role="status">Loading passage…</p></Show>
          <Show when={followingError()}><p class="library-error" role="alert">{followingError()}</p></Show>
        </div>
        <footer class="library-highlight-dock">
          <div class="library-passage-pager"><Button icon="left" shortcut="↑ K" disabled={highlightIndex() <= 0} onClick={() => stepHighlight(-1)}>Previous <kbd>↑ K</kbd></Button><span class="library-highlight-meta">{highlightIndex() + 1} of {highlightQueue().length}</span><Button shortcut="J ↓" disabled={highlightIndex() >= highlightQueue().length - 1} onClick={() => stepHighlight(1)}>Next <kbd>J ↓</kbd><Icon name="right" /></Button></div>
          <div class="library-highlight-primary"><Button class="bordered library-mark-processed" icon="check" shortcut="E" disabled={highlightBusy()} onClick={() => { void runHighlight(row(), 'triage'); }}>{row().processed ? 'Mark unprocessed' : 'Mark processed'}<kbd>E</kbd></Button><Button class="bordered" icon="note" shortcut="N" disabled={highlightBusy()} onClick={() => { void runHighlight(row(), 'note'); }}>{row().notes ? 'Open note' : 'Add note'}<kbd>N</kbd></Button><Button class="bordered" icon="review" shortcut="C" disabled={highlightBusy()} onClick={() => { void runHighlight(row(), 'card'); }}>Make card<kbd>C</kbd></Button></div>
          <div class="library-highlight-secondary">
            <Button icon="tag" shortcut="T" disabled={highlightBusy()} onClick={() => { void runHighlight(row(), 'tag'); }}>Tag <kbd>T</kbd></Button>
            <Button shortcut="1–5" aria-haspopup="dialog" disabled={highlightBusy()} onClick={event => setPopup({ kind: 'highlight-colors', anchor: event.currentTarget, row: row() })}><span class="library-highlight-color-bar" style={colorStyle()} aria-hidden="true" />Colour <kbd>1–5</kbd></Button>
            <Button class="library-highlight-undo" icon="undo" shortcut="⌘Z" disabled={!highlightActions.canUndo() || highlightBusy()} onClick={() => { void undoHighlight(); }}>Undo <kbd>⌘Z</kbd></Button>
            <Button class="library-highlight-open-reader" shortcut="O" onClick={event => openSource({ kind: 'reader', sourceId: row().citation.source_id, snapshotId: row().citation.snapshot_id, citationId: row().citation.id }, event.shiftKey)}>Open in reader <kbd>O</kbd><Icon name="right" /></Button>
            <Button icon="more" label="More highlight actions" aria-haspopup="menu" onClick={event => { void highlightMenu(row(), event.currentTarget); }} />
          </div>
        </footer>
      </section>;
    }}</Show>;
  }

  return <div ref={libraryHost} class="library-pane" classList={{ 'library-search-open': searchOpen() || !!text(), 'library-highlights-tab': tab() === 'highlights', 'library-all-tab': tab() === 'all' || !!view().collection, 'library-highlight-passage-open': tab() === 'highlights' && coverLayout() && highlightPassageOpen(), 'library-reading-cards': readingCards(), 'library-cover-reading': coverLayout() && readingCards(), 'library-inspecting': inspecting(), 'library-inspector-narrow': inspecting() && narrowInspector() && !coverLayout(), 'library-inspector-phone': inspecting() && coverLayout() }} data-pane={props.pane} data-pane-pending={!hasResult() ? '' : undefined} aria-label="Library" tabIndex={props.active ? 0 : -1} onFocusIn={props.onActivate} onPointerDown={props.onActivate}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && selected().size && !popup() && !(event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) { event.preventDefault(); event.stopPropagation(); clearSelection(); }
      if (!inspecting() && tab() !== 'highlights' && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && collectionActions.canUndo() && !(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))) {
        event.preventDefault(); event.stopPropagation(); void collectionActions.undo();
      }
    }}
    onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={event => { if (event.dataTransfer?.files.length) { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); } }}>
    <div class="library-catalogue">
    <div class="library-ledger" inert={inspecting() && narrowInspector() && !coverLayout()}>
    <header class="library-toolbar">
      <div class="library-cover-header"><div class="library-cover-heading"><div class="library-register">Sources and highlights</div><h1>Library</h1></div><Button icon="search" label="Search library" aria-expanded={searchOpen() || !!text()} onClick={() => {
        setSearchOpen(value => !value);
        if (searchOpen()) queueMicrotask(() => scroll.closest('.library-pane')?.querySelector<HTMLInputElement>('.library-search')?.focus());
      }} /><Show when={tab() !== 'highlights'}><Button class="bordered" icon="plus" label="Add to library" aria-haspopup={EMBEDDED ? undefined : 'dialog'} onClick={event => openAdd(event.currentTarget)} /></Show></div>
      <div ref={tabStrip} class="library-tabs mode-tabs tab-strip" classList={{ 'library-primary-tabs': coverLayout() }} data-mode-panel=".library-scroll" role="group" aria-label="Library state">
        <For each={coverLayout() ? tabs.slice(0, 3) : tabs}>{item => {
          // Zero counts are left out so the tabs fit a narrow pane.
          const count = () => item.id === 'collections' ? collections()?.length : item.id === 'highlights' ? unprocessedCount() : !library() ? undefined : item.id === 'all' ? Object.values(library()!.counts).reduce((sum, value) => sum + value, 0) : library()!.counts[item.id as ReadingState];
          return <Button data-library-tab={item.id} aria-label={count() ? `${item.label}, ${count()}` : item.label} aria-pressed={!view().view && tab() === item.id} onClick={() => update({ view: null, tab: item.id, scroll: 0 })}>
            {item.label}<Show when={count() && (!coverLayout() || item.id === 'highlights')}><span class="library-count">{count()}</span></Show>
          </Button>;
        }}</For>
        <Show when={coverLayout()}>
          <Button class="library-tabs-more" aria-haspopup="menu" aria-label="More library views" aria-pressed={!!view().view || tabs.slice(3).some(item => item.id === tab())}
            onClick={event => {
              const anchor = event.currentTarget;
              const current = views().find(value => value.id === view().view);
              setPopup({ kind: 'menu', anchor, label: 'Library views', items: [
                ...tabs.slice(3).map(item => ({ label: item.label, checked: !view().view && tab() === item.id, action: () => update({ view: null, tab: item.id, scroll: 0 }) })),
                ...views().map((value, index) => ({ label: value.name, section: index === 0 ? 'Saved views' : undefined, checked: view().view === value.id, action: () => chooseView(value) })),
                ...(current ? [{ label: `Actions for ${current.name}`, section: 'Current view', action: () => viewMenu(current, anchor) }] : []),
              ] });
            }}>
            <span>{views().find(value => value.id === view().view)?.name ?? tabs.slice(3).find(item => item.id === tab())?.label ?? 'More'}</span><Icon name="down" />
          </Button>
        </Show>
        <Show when={!coverLayout()}>
        <For each={views()}>{value => <>
          <Button aria-pressed={view().view === value.id} onClick={() => chooseView(value)}>{value.name}</Button>
          <Button icon="more" label={`Actions for view ${value.name}`} aria-haspopup="menu" disabled={saving()} onClick={event => viewMenu(value, event.currentTarget)} />
        </>}</For>
        </Show>
      </div>
      <Show when={collectionsIndex()}><div class="library-collection-heading"><h2>Collections</h2><Button icon="plus" onClick={event => setPopup({ kind: 'collection-name', anchor: event.currentTarget })}>New collection</Button></div></Show>
      <Show when={view().collection}><div class="library-collection-heading">
        <Button icon="left" onClick={() => update({ view: null, tab: 'collections', collection: null, text: '', scroll: 0 })}>Collections</Button>
        <h2>{collection()?.text ?? 'Collection'}</h2><span class="library-count">{library()?.total ?? 0}</span>
        <Button disabled={!collection()} onClick={event => props.onOpen({ kind: 'page', pageId: view().collection! }, event.shiftKey)}>Open page</Button>
        <Button disabled={!collection()} onClick={event => setPopup({ kind: 'collection-name', anchor: event.currentTarget, collection: collection() })}>Rename</Button>
        <Button disabled={!collection() || collectionActions.busy()} onClick={event => setPopup({ kind: 'delete-collection', anchor: event.currentTarget, collection: collection()! })}>Delete</Button>
      </div></Show>
      <Show when={!collectionsIndex()}>
      <div class="library-controls">
        <Show when={tab() !== 'highlights'} fallback={<div class="library-filter library-highlight-controls">
          <div class="library-tabs mode-tabs tab-strip" data-mode-panel=".library-scroll" role="group" aria-label="Highlight processing">
            <Button aria-pressed={unprocessedOnly()} onClick={() => update({ unprocessedOnly: true, scroll: 0 })}>Unprocessed<Show when={unprocessedCount()}><span class="library-count">{unprocessedCount()}</span></Show></Button>
            <Button aria-pressed={!unprocessedOnly()} onClick={() => update({ unprocessedOnly: false, scroll: 0 })}>All</Button>
          </div>
          <Button class="library-highlight-filters" icon="browse" aria-haspopup="dialog" aria-pressed={!!(colors().length || tags().length)} onClick={event => setPopup({ kind: 'highlight-filters', anchor: event.currentTarget })}>Filters<Show when={colors().length || tags().length}><span class="library-count">{colors().length + tags().length}</span></Show></Button>
          <Show when={!selectedHighlight() && highlightActions.canUndo()}><Button class="library-highlight-toolbar-undo" icon="undo" shortcut="⌘Z" onClick={() => { void undoHighlight(); }}>Undo <kbd>⌘Z</kbd></Button></Show>
          <div class="library-highlight-selectors"><Button class="library-highlight-source-selector" aria-haspopup="listbox" onClick={event => { setBrowseQuery(''); setPopup({ kind: 'highlight-sources', anchor: event.currentTarget }); }}>{highlightGroups().find(group => group.sourceId === highlightSource())?.title ?? (highlightGroups().length === 1 ? highlightGroups()[0]!.title : 'All sources')}<Icon name="down" /></Button><Button aria-haspopup="listbox" onClick={event => { setBrowseQuery(''); setPopup({ kind: 'highlight-chapters', anchor: event.currentTarget }); }}>{highlightChapter() ?? 'All sections'}<Icon name="down" /></Button></div>
        </div>}>
          <Show when={selected().size > 0} fallback={<>
            <input class="input library-search" type="search" aria-label="Search library" placeholder="Search library" value={text()} onInput={event => update({ view: null, text: event.currentTarget.value, scroll: 0 })} />
            <Button class="library-sort" aria-haspopup="menu" label="Sort and group sources" onClick={event => {
              const anchor = event.currentTarget;
              setPopup({ kind: 'menu', anchor, label: 'Sort and group sources', items: [
                ...sorts.map(item => ({ section: 'Sort', label: item.label, icon: sort() === item.id ? 'check' as const : undefined, action: () => update({ view: null, sort: item.id, scroll: 0 }) })),
                ...groupings.map(item => ({ section: 'Group', label: item.label, icon: group() === item.id ? 'check' as const : undefined, action: () => update({ group: item.id }) })),
                { section: 'View', label: 'Save view…', disabledReason: saving() ? 'Saving…' : undefined, action: () => setPopup({ kind: 'name', anchor, saved: null, id: ulid() }) },
              ] });
            }}>{sorts.find(item => item.id === sort())!.label}<Show when={group() !== 'none'}><span class="library-sort-group"> · by {groupings.find(item => item.id === group())!.label.toLowerCase()}</span></Show><Icon name="down" /></Button>
            <div class="library-tabs mode-tabs" data-mode-panel=".library-scroll" role="group" aria-label="Library layout">
              <Button icon="rows" label="List" aria-pressed={layout() === 'list'} onClick={() => chooseLayout('list')} />
              <Button icon="shelf" label="Shelf" aria-pressed={layout() === 'shelf'} onClick={() => chooseLayout('shelf')} />
            </div>
            {/* Always present, so the search field keeps its width on tabs with nothing to browse. */}
            <Button class="library-browse-button" icon="browse" label="Browse" aria-haspopup="dialog" aria-pressed={filtered()} disabled={!browseEntries().length} onClick={event => { setBrowseQuery(''); setPopup({ kind: 'browse', anchor: event.currentTarget, field: null }); }} />
            <Button icon="download" label="Export" aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => exportMenu(event.currentTarget)}><span class="library-export-label">Export</span><Icon name="down" /></Button>
          </>}>
            <span class="library-selection-count">{selected().size} selected</span>
            <Show when={!inspecting()}><Button class="bordered" onClick={() => showDetails()}>Details</Button></Show>
            <Button class="library-inspector-browse" icon="browse" label="Browse" onClick={event => { backToSources(); setBrowseQuery(''); setPopup({ kind: 'browse', anchor: event.currentTarget, field: null }); }}><span class="library-action-label">Browse</span></Button>
            <Button aria-haspopup="menu" disabled={saving()} onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Mark as', items: tabs.filter(item => item.id !== 'all' && item.id !== 'highlights' && item.id !== 'collections').map(item => ({ label: item.label, action: () => { void changeSelectedState(item.id as ReadingState); } })) })}>Mark as<Icon name="down" /></Button>
            <Button icon="download" label="Export" aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => exportMenu(event.currentTarget)}><span class="library-action-label">Export</span><Icon name="down" /></Button>
            <Button icon="shelf" label="Add to collection" disabled={collectionActions.busy()} onClick={event => setPopup({ kind: 'collection-picker', anchor: event.currentTarget, sources: [...selected()] })}><span class="library-action-label">Add to collection…</span></Button>
            <Show when={view().collection}><Button class="library-remove-member" label="Remove from collection" disabled={collectionActions.busy()} onClick={() => { void collectionActions.run('Removed from collection', () => changeCollectionMembers(props.notebook, view().collection!, [...selected()], false)); }}>Remove<span class="library-action-label"> from collection</span></Button></Show>
            <Button icon="trash" label="Delete" class="danger" aria-haspopup="dialog" disabled={saving()} onClick={event => confirmDelete(event.currentTarget, displayedSources().filter(row => selected().has(row.page.id)))}><span class="library-action-label">Delete</span></Button>
            <Button class="library-clear-selection" icon="close" label="Clear selection" onClick={clearSelection}><span class="library-action-label">Clear selection</span></Button>
          </Show>
        </Show>
        <Show when={tab() !== 'highlights' && !selected().size}><Button ref={addButton} class="library-add-trigger" icon="plus" aria-haspopup={EMBEDDED ? undefined : 'dialog'} aria-expanded={EMBEDDED ? undefined : popup()?.kind === 'add'} onClick={event => openAdd(event.currentTarget)}>Add</Button></Show>
      </div>
      <Show when={tab() !== 'highlights' && chosenFilters().length}><div class="library-filter library-chosen" role="group" aria-label="Browse filters">
        <For each={chosenFilters()}>{item => <Button class="bordered library-chip" aria-label={`Remove filter ${item.label}`} onClick={() => toggleFilter(item.field, item.value)}>{item.label}<Icon name="close" /></Button>}</For>
        <Button onClick={() => update({ view: null, filters: { people: [], decades: [], publishers: [], languages: [] }, scroll: 0 })}>Clear filters</Button>
      </div></Show>
      </Show>
      <collectionActions.Notice />
      <Show when={props.notebook.commandState() === 'error'}><p class="library-error" role="alert">{props.notebook.commandMessage()}</p></Show>
      <Show when={deleted()}><footer class="table-footer" role="status">View deleted · <Button disabled={saving()} onClick={() => { void undoDelete(); }}>Undo</Button></footer></Show>
    </header>
    <input ref={fileInput} type="file" hidden aria-label="Choose EPUB files" accept=".epub,application/epub+zip" multiple onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files);
    }} />
    <div ref={scroll} class="library-scroll" aria-busy={loading() && loadedKey() !== queryKey() ? true : undefined} onScroll={() => {
      if (restoreScroll !== null || inspecting() && narrowInspector() && !coverLayout()) return;
      const next = { ...view(), scroll: scroll.scrollTop };
      setView(next); props.onViewChange({ ...next });
    }}>
      <Show when={!collectionsIndex() && tab() !== 'highlights' && browseEntries().length && !inspecting()}>
        <nav class="library-browse" aria-label="Browse library">
          <For each={browseFields}>{section => {
            const entries = () => browseEntries().filter(entry => entry.field === section.field);
            // The commonest values, plus any chosen value further down.
            const shown = () => entries().filter((entry, at) => at < browseLimit || chosen(entry.field, entry.value));
            return <Show when={entries().length}><section class="library-browse-section" aria-label={section.label}>
              <h3 class="library-browse-heading">{section.label}</h3>
              <For each={shown()}>{entry => <Button class="library-browse-item" aria-pressed={chosen(entry.field, entry.value)} onClick={() => toggleFilter(entry.field, entry.value)}>
                <span class="library-browse-label">{entry.label}</span><span class="library-browse-count">{entry.count}</span>
              </Button>}</For>
              <Show when={entries().length > shown().length}><Button class="library-browse-more" aria-haspopup="dialog" onClick={event => { setBrowseQuery(''); setPopup({ kind: 'browse', anchor: event.currentTarget, field: section.field }); }}>All {entries().length}</Button></Show>
            </section></Show>;
          }}</For>
        </nav>
      </Show>
      <div class="library-main">
      <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
      {/* Every read fails together when the service is away; one row and one Retry stand for all of them. */}
      <Show when={countError() || jobsError() || viewsError() || (showReading() && readingError()) || error()}>{message => <div class="library-error" role="alert">{message()}<Button onClick={() => { setRefresh(value => value + 1); setJobsRefresh(value => value + 1); }}>Retry</Button></div>}</Show>
      <Show when={collections.error || collectionCards.error}><p class="library-error" role="alert">{String(collections.error || collectionCards.error)}</p></Show>
      <Show when={collectionsIndex()}>
        <Show when={slowCollections()}><p class="library-message" role="status">Loading collections…</p></Show>
        <Show when={!collections.loading && !collections()?.length}><p class="library-empty">Select books in the library, then choose Add to collection.</p></Show>
        <div class="library-collections" role="list"><For each={collectionCards()}>{card => <div role="listitem">
          <Button class="library-collection-card" data-collection={card.page.id} onClick={() => update({ view: null, tab: 'collections', collection: card.page.id, text: '', filters: { people: [], decades: [], publishers: [], languages: [] }, scroll: 0 })}>
            <span class="library-collection-covers" aria-hidden="true"><For each={card.covers}>{row => <SourceCover row={row} siglum={row.source.siglum} />}</For><Show when={!card.covers.length}><Icon name="shelf" /></Show></span>
            <span class="library-collection-title">{card.page.text}</span><span class="library-count">{card.count}</span>
          </Button>
        </div>}</For></div>
      </Show>
      <Show when={!collectionsIndex()}>
      <Show when={tab() === 'all' ? showReading() : readingCards()}>
        <Show when={reading().length}><section class="library-reading" aria-labelledby={`${props.pane}-reading-heading`}>
          <h2 class="library-reading-heading" id={`${props.pane}-reading-heading`}>Reading now</h2>
          <div class="library-reading-books" role="list"><For each={reading()}>{row => <div class="library-reading-item library-reading-entry" classList={{ 'library-row-selected': selected().has(row.page.id) }} role="listitem" {...sourceLongPress(row)}>
            <ReadingCard row={row} notebook={props.notebook} selected={openedSource() === row.page.id || selected().has(row.page.id)} onOpen={beside => openSource({ kind: 'page', pageId: row.page.id }, beside)} />
            <Show when={tab() === 'reading'}><Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
              <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
            </Button></Show>
            <Button class="library-reading-more" icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" onClick={event => rowMenu(row, event.currentTarget)} />
          </div>}</For></div>
        </section></Show>
        <Show when={coverLayout() && tab() === 'reading' && upNext().length}><section class="library-up-next" aria-label="Up next">
          <h2 class="library-reading-heading">Up next · Inbox</h2>
          <For each={upNext()}>{row => <Button class="library-up-next-book" onClick={event => openSource({ kind: 'page', pageId: row.page.id }, event.shiftKey)} {...sourceLongPress(row)}>
            <span class="library-siglum">{row.source.siglum}</span><span><span class="library-title">{row.page.text}</span><span class="library-book-byline">{sourceByline(row)}</span></span>
          </Button>}</For>
        </section></Show>
      </Show>
      <section class="library-rows" classList={{ 'library-has-selection': selected().size > 0, 'library-rows-shelf': layout() === 'shelf' && tab() !== 'highlights', 'library-rows-grouped': !!groups() }} aria-label={tab() === 'highlights' ? 'Highlights' : 'Sources'} aria-busy={loading()}>
        <Show when={shownJobs().length}><JobRows jobs={shownJobs()} /></Show>
        <Show when={failedJobs().length}><details class="library-failures">
          <summary>{failedJobs().length} imports failed</summary>
          <Button class="library-dismiss-all" onClick={() => { for (const job of failedJobs()) dismissJob(job.id); }}>Dismiss all</Button>
          <JobRows jobs={failedJobs()} />
        </details></Show>
        <Show when={slowLoad()}><p class="library-message" role="status">Loading…</p></Show>
        <Show when={hasResult() && !error()}>
          <Show when={tab() !== 'highlights'} fallback={
            <Show when={highlights()?.rows.length} fallback={<div class="library-empty"><p>{highlightEmptyMessage(highlightCount(), unprocessedOnly())}</p><Show when={colors().length || tags().length}><Button onClick={() => update({ colors: [], tags: [], scroll: 0 })}>Clear filters</Button></Show></div>}>
              <div class="library-highlights-workbench">
                <section class="library-highlight-queue" aria-label="Highlight queue">
                  <header class="library-highlight-queue-head"><span>Reading order</span><span>{highlightQueue().length} highlights<Show when={(highlights()?.total ?? 0) > (highlights()?.rows.length ?? 0)}> · {highlights()?.rows.length} of {highlights()?.total} loaded</Show></span></header>
                  <div class="library-highlight-queue-scroll">
                    <Show when={!highlightQueue().length}><div class="library-empty"><p>No matching highlights in this section.</p><Button onClick={() => { setHighlightSource(null); setHighlightChapter(null); }}>All sections</Button></div></Show>
                    <For each={scopedHighlightGroups()}>{group => <section class="library-highlight-group">
                    <Show when={!highlightSource()}><div class="library-highlight-heading"><Button onClick={() => { setHighlightSource(group.sourceId); setHighlightChapter(null); }}>{group.title}</Button><span>{group.rows.length}</span></div></Show>
                    <For each={highlightChapters(group.rows).filter(chapter => highlightChapter() === null || chapter.title === highlightChapter())}>{chapter => <>
                      <Show when={highlightChapterHeading(chapter)}><h3 class="library-highlight-chapter">{highlightChapterHeading(chapter)}</h3></Show>
                      <div role="list"><For each={chapter.rows}>{row => <div role="listitem" onPointerEnter={() => setLinkedCitation(row.citation.id)} onPointerLeave={() => setLinkedCitation(null)}>
                        <Button class="library-highlight" aria-current={selectedHighlightId() === row.citation.id ? 'true' : undefined} data-library-row={row.citation.id} style={{ '--highlight-bar': row.color ? `var(--highlight-${row.color})` : 'var(--faint)' }} onClick={() => chooseHighlight(row)}>
                          <span class="library-highlight-text">{row.citation.quote}</span>
                          <span class="library-highlight-details"><span class="library-highlight-meta">{highlightMeta(row, props.notebook.settings()?.time_zone ?? 'UTC')}<Show when={row.notes > 0}> · {row.notes} {row.notes === 1 ? 'note' : 'notes'}</Show><Show when={!unprocessedOnly()}> · {row.processed ? 'Processed' : 'Unprocessed'}</Show></span><Show when={row.block.page.id !== row.citation.source_id}><span class="library-highlight-meta library-highlight-filed">In {row.block.page.text}</span></Show></span>
                          <Show when={row.tags.length}><span class="library-highlight-tags"><For each={row.tags}>{tag => <span class="outline-tag">#{tag}</span>}</For></span></Show>
                        </Button>
                      </div>}</For></div>
                    </>}</For>
                  </section>}</For></div>
                  <footer class="library-highlight-queue-dock"><span class="library-highlight-meta">{scopedHighlightGroups().length} {scopedHighlightGroups().length === 1 ? 'source' : 'sources'} · {highlightQueue().length} highlights</span><Button class="bordered library-mark-processed" disabled={!selectedHighlight()} onClick={() => { const row = selectedHighlight(); if (row) chooseHighlight(row); }}>Process selected<Icon name="right" /></Button></footer>
                </section>
                <HighlightPassage />
              </div>
            </Show>
          }>
            <Show when={displayedSources().length} fallback={<div class="library-empty">
              <Show when={text().trim() || filtered()} fallback={<>
                <Show when={!view().collection && !view().view && library() && Object.values(library()!.counts).every(count => !count)} fallback={
                  <p>{view().collection ? 'This collection has no sources yet.' : tab() === 'all' ? 'No sources.' : `No ${tabs.find(item => item.id === tab())?.label.toLowerCase()} sources yet.`}</p>
                }>
                  <h2>Add your first source</h2>
                  <p>{EMBEDDED ? 'Import an EPUB to read, highlight, and make notes.' : 'Import an EPUB, save an article, or add a catalogue record.'}</p>
                </Show>
                <Button class="bordered" icon="plus" onClick={event => openAdd(event.currentTarget)}>{EMBEDDED ? 'Import an EPUB' : 'Add a source'}</Button>
              </>}><p>No sources match.</p><Button onClick={() => update({ view: null, text: '', filters: { people: [], decades: [], publishers: [], languages: [] }, scroll: 0 })}>{filtered() ? 'Clear search and filters' : 'Clear search'}</Button></Show>
            </div>}>
              <Show when={groups()} fallback={<SourceRows rows={displayedSources()} />}>{list => <For each={list()}>{value => <section class="library-group" aria-label={value.label}>
                <h3 class="library-group-heading">
                  <Show when={value.personId} fallback={<span class="library-group-label">{value.label}</span>}>{id => <Button class="library-group-label" onClick={event => props.onOpen({ kind: 'page', pageId: id() }, event.shiftKey)}>{value.label}</Button>}</Show>
                  <span class="library-group-count">{value.rows.length}</span>
                </h3>
                <SourceRows rows={value.rows} />
              </section>}</For>}</Show>
            </Show>
          </Show>
        </Show>
      </section>
      </Show>
      </div>
    </div>
    </div>
    <Show when={inspecting()}>
      <Show when={coverLayout() && inspectorPortal()} fallback={<InspectorView />}>{host => <Portal mount={host() as HTMLElement}><InspectorView /></Portal>}</Show>
    </Show>
    </div>
    <Show when={coverLayout() && (popup()?.kind === 'highlight-filters' || popup()?.kind === 'highlight-colors' || sourceMenuId())}><div class="library-highlight-filter-shade" aria-hidden="true" /></Show>
    <Show keyed when={popup()}>{state => {
      const dismiss = () => { if (popup() === state) setPopup(null); };
      if (state.kind === 'collection-picker') return <CollectionPicker anchor={state.anchor} notebook={props.notebook} sourceIds={state.sources} onChanged={(change, label) => { collectionActions.record(change, label); clearSelection(); }} onDismiss={dismiss} />;
      if (state.kind === 'collection-name') return <CollectionNamePopup anchor={state.anchor} name={state.collection?.text} onDismiss={dismiss} onSave={async name => {
        if (state.collection) collectionActions.record(await renameCollection(props.notebook, state.collection, name), `Renamed to ${name}`);
        else { const result = await createCollection(props.notebook, name); collectionActions.record(result.change, `Created ${name}`); }
        dismiss();
      }} />;
      if (state.kind === 'delete-collection') return <Popup anchor={state.anchor} label="Delete collection?" onDismiss={dismiss}>
        <p>Delete “{state.collection.text}”? Books stay in the library.</p>
        <div class="popup-actions"><Button disabled={collectionActions.busy()} onClick={dismiss}>Cancel</Button><Button class="bordered danger" disabled={collectionActions.busy()} onClick={() => { void collectionActions.run('Deleted collection', () => deleteCollection(props.notebook, state.collection)).then(done => {
          if (done) { update({ view: null, tab: 'collections', collection: null, scroll: 0 }); dismiss(); }
        }); }}>Delete collection</Button></div>
      </Popup>;
      if (state.kind === 'menu') {
        const sheet = coverLayout() && !!state.source;
        const source = state.source;
        return <Menu anchor={state.anchor} label={state.label} items={state.items} placement={sheet ? 'sheet' : 'anchor'} class={sheet ? 'library-source-sheet' : undefined} header={sheet && source ? <header class="library-source-sheet-head">
          <div><h2>{source.page.text}</h2><p>{sourceByline(source)}</p><p class="library-highlight-meta">{[source.source.siglum, { epub: 'Book', article: 'Article', record: 'Record' }[source.snapshot_format ?? source.source.format], source.publisher, source.progress > 0 ? `${formatProgress(source.progress)} read` : null].filter(Boolean).join(' · ')}</p></div>
          <Button icon="close" label="Close source actions" onClick={dismiss} />
        </header> : state.Header && <state.Header onDismiss={dismiss} />} onDismiss={dismiss} />;
      }
      if (state.kind === 'highlight-sources') return <Picker anchor={state.anchor} placement={coverLayout() ? 'sheet' : 'anchor'} label="Choose highlight source" placeholder="Find a source" query={browseQuery()} onQuery={setBrowseQuery}
        items={[{ sourceId: null, title: 'All sources' }, ...highlightGroups()].filter(group => group.title.toLocaleLowerCase().includes(browseQuery().toLocaleLowerCase()))} key={group => group.sourceId ?? 'all'}
        row={group => <><Show when={highlightSource() === group.sourceId}><Icon name="check" /></Show><span>{group.title}</span></>}
        onPick={group => { setHighlightSource(group.sourceId); setHighlightChapter(null); setBrowseQuery(''); dismiss(); }} empty="No matching sources" onDismiss={dismiss} />;
      if (state.kind === 'highlight-chapters') return <Picker anchor={state.anchor} placement={coverLayout() ? 'sheet' : 'anchor'} label="Choose highlight section" placeholder="Find a section" query={browseQuery()} onQuery={setBrowseQuery}
        items={[null, ...chapterOptions()].filter(title => (title ?? 'All sections').toLocaleLowerCase().includes(browseQuery().toLocaleLowerCase()))} key={title => title ?? 'all'}
        row={title => <><Show when={highlightChapter() === title}><Icon name="check" /></Show><span>{title ?? 'All sections'}</span></>}
        onPick={title => { setHighlightChapter(title); setBrowseQuery(''); dismiss(); }} empty="No matching sections" onDismiss={dismiss} />;
      if (state.kind === 'highlight-filters') return <Popup anchor={state.anchor} label="Filter highlights" class="library-highlight-filter-popup" placement={coverLayout() ? 'sheet' : 'anchor'} width={360} onDismiss={dismiss}>
        <header class="library-highlight-filter-head"><h2>Filter highlights</h2><Button icon="close" label="Close filters" onClick={dismiss} /></header>
        <h3 class="library-highlight-filter-label">Colour</h3><div class="library-highlight-filter-colors" role="group" aria-label="Highlight colours"><For each={[...highlightColors, 'none']}>{color => <Button class="bordered" aria-pressed={colors().includes(color)} onClick={() => toggleHighlightColor(color)}><span class="library-highlight-color-bar" style={{ '--highlight-bar': color === 'none' ? 'var(--faint)' : `var(--highlight-${color})` }} aria-hidden="true" />{color === 'none' ? 'No colour' : color[0]!.toUpperCase() + color.slice(1)}<Show when={!colors().length && !tags().length}><span class="library-count">{highlights()?.rows.filter(row => (row.color ?? 'none') === color).length ?? 0}</span></Show></Button>}</For></div>
        <h3 class="library-highlight-filter-label">Tags</h3><Show when={tagOptions().length} fallback={<p class="library-message">No tags on these highlights.</p>}><Button aria-haspopup="dialog" onClick={() => { setTagQuery(''); setPopup({ kind: 'tags', anchor: state.anchor }); }}>Choose tags<Icon name="down" /></Button><div class="library-highlight-filter-tags"><For each={tags()}>{tag => <Button class="outline-tag" onClick={() => update({ tags: tags().filter(value => value !== tag), scroll: 0 })}>#{tag}<Icon name="close" /></Button>}</For></div></Show>
        <footer class="library-highlight-filter-footer"><Show when={colors().length || tags().length}><Button onClick={() => update({ colors: [], tags: [], scroll: 0 })}>Clear filters</Button></Show><span class="library-highlight-meta">{loading() ? 'Loading…' : `${highlights()?.total ?? 0} matching highlights`}</span><Button class="bordered library-mark-processed" onClick={dismiss}>Show highlights</Button></footer>
      </Popup>;
      if (state.kind === 'highlight-colors') return <Popup anchor={state.anchor} label="Highlight colour" placement={coverLayout() ? 'sheet' : 'anchor'} class="library-highlight-filter-popup" width={320} onDismiss={dismiss}>
        <header class="library-highlight-filter-head"><h2>Highlight colour</h2><Button icon="close" label="Close colours" onClick={dismiss} /></header><div class="library-highlight-filter-colors" role="group" aria-label="Highlight colour"><For each={[...highlightColors, null]}>{color => <Button class="bordered" aria-pressed={state.row.color === color} onClick={() => { dismiss(); void highlightActions(state.row).then(actions => actions.setColor(color)).catch(reason => setCommandError(reason instanceof Error ? reason.message : String(reason))); }}><span class="library-highlight-color-bar" style={{ '--highlight-bar': color ? `var(--highlight-${color})` : 'var(--faint)' }} aria-hidden="true" />{color ? color[0]!.toUpperCase() + color.slice(1) : 'No colour'}</Button>}</For></div>
      </Popup>;
      if (state.kind === 'tags') return <Picker anchor={state.anchor} label="Filter highlight tags" placeholder="Find a tag" query={tagQuery()} onQuery={setTagQuery} items={tagOptions()} key={tag => tag}
        row={tag => <><Show when={tags().includes(tag)}><Icon name="check" /></Show><span class="outline-tag">#{tag}</span></>}
        onPick={tag => { update({ tags: tags().includes(tag) ? tags().filter(value => value !== tag) : [...tags(), tag], scroll: 0 }); dismiss(); }} empty="No tags in these highlights" onDismiss={dismiss} />;
      if (state.kind === 'browse') {
        const field = state.field;
        const items = () => browseEntries().filter(entry => (!field || entry.field === field) && entry.label.toLocaleLowerCase().includes(browseQuery().trim().toLocaleLowerCase()));
        return <Picker anchor={state.anchor} label={field ? `Browse ${browseFields.find(item => item.field === field)!.label.toLowerCase()}` : 'Browse library'} class="library-browse-picker" width={360}
          placeholder={browsePlaceholders[field ?? 'all']} query={browseQuery()} onQuery={setBrowseQuery} items={items()} key={entry => `${entry.field}:${entry.value}`}
          section={field ? undefined : entry => browseFields.find(item => item.field === entry.field)!.label}
          row={entry => <><span class="library-browse-check"><Show when={chosen(entry.field, entry.value)}><Icon name="check" /></Show></span><span class="library-browse-label">{entry.label}</span><span class="library-browse-count">{entry.count}</span></>}
          onPick={entry => { toggleFilter(entry.field, entry.value); dismiss(); }} empty="Nothing matches" onDismiss={dismiss} />;
      }
      if (state.kind === 'name') return <LibraryViewNamePopup anchor={state.anchor} saved={state.saved} busy={saving()} onDismiss={dismiss} onSave={name => saveView(name, state.id, state.saved)} />;
      if (state.kind === 'delete') return <Popup anchor={state.anchor} label="Delete library view?" onDismiss={dismiss}>
        <p>Delete “{state.saved.name}”? Sources are not deleted.</p>
        <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
        <div class="popup-actions"><Button disabled={saving()} onClick={dismiss}>Cancel</Button><Button class="bordered danger" disabled={saving()} onClick={() => { void deleteView(state.saved); }}>Delete view</Button></div>
      </Popup>;
      if (state.kind === 'delete-sources') return <Popup anchor={state.anchor} label={state.sources.length === 1 ? 'Delete source?' : 'Delete sources?'} onDismiss={dismiss} width={320}>
        <p>Delete {state.sources.length === 1 ? `“${state.sources[0]!.title}”` : `${state.sources.length} sources`} and {state.sources.length === 1 ? 'its' : 'their'} highlights?</p>
        <p class="muted">You can undo this deletion.</p>
        <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
        <div class="popup-actions"><Button disabled={saving()} onClick={dismiss}>Cancel</Button><Button icon="trash" class="bordered danger" disabled={saving()} onClick={() => { void deleteSources(state.sources); }}>{state.sources.length === 1 ? 'Delete source' : `Delete ${state.sources.length} sources`}</Button></div>
      </Popup>;
      if (EMBEDDED) return null;
      return <AddSheet anchor={state.anchor} notebook={props.notebook} onDismiss={dismiss} onChooseFile={() => fileInput.click()} onFiles={files => { void upload(files); }} onJob={recordJob} onAdded={pageId => openSource({ kind: 'page', pageId }, false)} />;
    }}</Show>
    <highlightActions.Popups />
  </div>;
}

function LibraryViewNamePopup(props: { anchor: HTMLElement; saved: LibraryView | null; busy: boolean; onDismiss(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = createSignal(props.saved?.name ?? '');
  const [error, setError] = createSignal('');
  const submit = async () => {
    if (props.busy || !name().trim()) return;
    setError('');
    try { await props.onSave(name()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <Popup anchor={props.anchor} label={props.saved ? 'Rename library view' : 'Save library view'} onDismiss={props.onDismiss}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <input class="input" aria-label="Library view name" placeholder="View name" value={name()} maxlength={120} disabled={props.busy} onInput={event => setName(event.currentTarget.value)} />
      <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={props.busy} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={props.busy || !name().trim()}>Save</Button></div>
    </form>
  </Popup>;
}
