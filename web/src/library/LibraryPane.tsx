import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import { exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { HighlightResult, HighlightRow, IngestJob, LibraryFilters, LibraryQuery, LibraryResult, LibraryRow, LibraryView, ReadingState } from '../api/types';
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
import { formatProgress, groupSources, highlightChapters, highlightMeta, jobLabel, libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';
import { formatSourceValue } from '../outline/source';
import { createHighlightActions, highlightColors, setLinkedCitation } from './highlights';
import type { HighlightMenu } from './highlights';
import { ResourceImage } from './ResourceImage';
import { SourceCover } from './SourceCover';
import { pageSigla } from './sigla';
import { AddSheet } from './AddSheet';
import './library.css';

export interface LibraryPaneProps {
  pane: PaneId;
  view: LibraryViewState;
  notebook: NotebookClient;
  active: boolean;
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
  | { kind: 'browse'; anchor: HTMLElement; field: BrowseField | null }
  | { kind: 'name'; anchor: HTMLElement; saved: LibraryView | null; id: string }
  | { kind: 'delete'; anchor: HTMLElement; saved: LibraryView }
  | { kind: 'delete-sources'; anchor: HTMLElement; sources: { id: string; title: string }[] }
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[]; Header?: HighlightMenu['Header'] };
const tabs: { id: LibraryTab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'reading', label: 'Reading' },
  { id: 'finished', label: 'Finished' }, { id: 'abandoned', label: 'Abandoned' },
  { id: 'all', label: 'All' }, { id: 'highlights', label: 'Highlights' },
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

const processedExplanation = 'A highlight counts as processed once it has a note, a card or a link, or when you mark it.';
export function LibraryPane(props: LibraryPaneProps) {
  const [view, setView] = createSignal({ ...props.view });
  const tab = createMemo(() => view().tab);
  const text = createMemo(() => view().text);
  const sort = createMemo(() => view().sort);
  const unprocessedOnly = createMemo(() => view().unprocessedOnly);
  const colors = createMemo(() => view().colors);
  const tags = createMemo(() => view().tags);
  const filters = createMemo(() => view().filters);
  const group = createMemo(() => view().group);
  const filtered = createMemo(() => Object.values(filters()).some(values => values.length > 0));
  const [tagQuery, setTagQuery] = createSignal('');
  const [browseQuery, setBrowseQuery] = createSignal('');
  const [views, setViews] = createSignal<LibraryView[]>([]);
  const [viewsError, setViewsError] = createSignal('');
  const saved = createMemo(() => views().find(value => value.id === view().view));
  const currentQuery = createMemo(() => saved()?.query ?? libraryQuery({ tab: tab(), text: text(), sort: sort(), filters: filters() }));
  const queryKey = createMemo(() => JSON.stringify([view().view, tab(), currentQuery(), unprocessedOnly(), colors(), tags()]));
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  let selectionAnchor: string | null = null;
  createEffect(on(queryKey, () => { setSelected(new Set<string>()); selectionAnchor = null; }));
  const [loadedKey, setLoadedKey] = createSignal('');
  const [library, setLibrary] = createSignal<LibraryResult>();
  // Keep each row kind until its replacement arrives, even when the other tab loads.
  const [sourceRows, setSourceRows] = createSignal<LibraryRow[]>();
  const [highlights, setHighlights] = createSignal<HighlightResult>();
  const [unprocessedCount, setUnprocessedCount] = createSignal<number>();
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
  const tagOptions = createMemo(() => [...new Set([...(highlights()?.rows.flatMap(row => row.tags) ?? []), ...tags()])].sort().filter(tag => tag.toLocaleLowerCase().includes(tagQuery().toLocaleLowerCase())));
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const displayedSources = createMemo(() => tab() === 'highlights' || error() ? [] : sourceRows() ?? []);
  const hasResult = createMemo(() => tab() === 'highlights' ? highlights() !== undefined : sourceRows() !== undefined);
  const groups = createMemo(() => group() === 'none' || tab() === 'highlights' ? undefined : groupSources(displayedSources(), group() as Exclude<LibraryGroup, 'none'>));
  // Shift-click ranges follow what is on screen, so a grouped list selects in group order.
  const orderedSources = createMemo(() => groups()?.flatMap(value => value.rows) ?? displayedSources());
  const [slowLoad, setSlowLoad] = createSignal(false);
  createEffect(() => {
    setSlowLoad(false);
    if (!loading() || hasResult()) return;
    const timer = setTimeout(() => setSlowLoad(true), 300);
    onCleanup(() => clearTimeout(timer));
  });
  const [commandError, setCommandError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [refresh, setRefresh] = createSignal(0);
  const [jobs, setJobs] = createSignal<IngestJob[]>([]);
  const [jobsError, setJobsError] = createSignal('');
  const [jobsRefresh, setJobsRefresh] = createSignal(0);
  const [retrying, setRetrying] = createSignal<string[]>([]);
  const [dismissedJobs, setDismissedJobs] = createSignal<Set<string>>(new Set());
  let dismissedKey: string | undefined;
  let tabKey: string | undefined;
  let layoutKey: string | undefined;
  let tabChosen = false;
  // List or Shelf is a device preference per notebook, like the last tab.
  const [layout, setLayout] = createSignal<'list' | 'shelf'>('list');
  // Recently read books, for the Continue reading strip; a failed load leaves the strip out and the list reports the error.
  const [resume, setResume] = createSignal<LibraryRow[]>([]);
  createEffect(() => {
    props.notebook.changeSequence(); refresh();
    const controller = new AbortController();
    void props.notebook.api.library({ states: ['reading'], sort: 'last_read', direction: 'desc', limit: 3 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setResume(result.rows.filter(row => row.progress > 0)); }, () => undefined);
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const controller = new AbortController();
    void props.notebook.api.notebook(controller.signal).then(async info => {
      if (controller.signal.aborted) return;
      dismissedKey = `tessera.library.dismissed.${info.id}`;
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(dismissedKey) ?? '[]');
        if (Array.isArray(stored)) setDismissedJobs(previous => new Set([...previous, ...stored.filter((id): id is string => typeof id === 'string')]));
      } catch { /* The preference lasts for this tab. */ }
      tabKey = `tessera.library.tab.${info.id}`;
      layoutKey = `tessera.library.layout.${info.id}`;
      try { if (localStorage.getItem(layoutKey) === 'shelf') setLayout('shelf'); } catch { /* Session-only preference. */ }
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(tabKey); } catch { /* Session-only preference. */ }
      if (!tabChosen && !view().view && view().tab === 'inbox') {
        if (tabs.some(tab => tab.id === remembered)) update({ tab: remembered as LibraryTab, scroll: 0 });
        else {
          const result = await props.notebook.api.library({ limit: 0 }, controller.signal);
          if (!controller.signal.aborted && !tabChosen) update({ tab: result.counts.inbox ? 'inbox' : result.counts.reading ? 'reading' : 'all', scroll: 0 });
        }
      }
    }).catch(reason => { if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason)); });
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
  const doneJobs = new Set<string>();
  const sourceTitles = createMemo(() => new Map(props.notebook.roots().map(root => [root.id, root.text])));
  // Jobs concern sources; the Highlights tab shows none. A finished job leaves once its source exists, whichever view lists it.
  const shownJobs = createMemo(() => tab() === 'highlights' || error() ? [] : visibleJobs(jobs().filter(job => !(job.state === 'failed' && dismissedJobs().has(job.id))), new Set([...displayedSources().map(row => row.page.id), ...sourceTitles().keys()])));
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
  // Marks stay unique within the list; the earliest-added source keeps the bare one, so sorting never renames.
  const sigla = createMemo(() => pageSigla([...displayedSources()]
    .sort((a, b) => a.source.added_at - b.source.added_at || a.page.id.localeCompare(b.page.id))
    .map(row => ({ id: row.page.id, siglum: row.source.siglum, basis: row.source.siglum_basis, authored: row.source.siglum_authored }))));
  let scroll!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let restoreScroll: number | null = props.view.scroll;
  let disposed = false;
  onCleanup(() => { disposed = true; setLinkedCitation(null); });

  const highlightActions = createHighlightActions(props.notebook, props.onOpen, setCommandError);

  async function highlightMenu(row: HighlightRow, anchor: HTMLElement) {
    setCommandError('');
    try {
      const { items, Header } = await highlightActions(row);
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, label: 'Actions for highlight', Header, items: [
        { label: 'Open in reader', action: () => props.onOpen({ kind: 'reader', sourceId: row.citation.source_id, snapshotId: row.citation.snapshot_id, citationId: row.citation.id }, true) },
        ...items,
      ] });
    } catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const update = (patch: Partial<LibraryViewState>) => {
    if (patch.tab !== undefined) {
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
    if (next.view === previous.view && next.tab === previous.tab && next.text === previous.text && next.sort === previous.sort && next.group === previous.group && next.unprocessedOnly === previous.unprocessedOnly && !filtersChanged && next.scroll === previous.scroll) return;
    const queryChanged = next.view !== previous.view || next.tab !== previous.tab || next.text !== previous.text || next.sort !== previous.sort || next.unprocessedOnly !== previous.unprocessedOnly || filtersChanged;
    restoreScroll = queryChanged ? next.scroll : null;
    setView({ ...next });
    if (!queryChanged) scroll.scrollTop = next.scroll;
  }, { defer: true }));

  function viewFields(query: LibraryQuery): Pick<LibraryViewState, 'tab' | 'text' | 'sort' | 'filters'> {
    return {
      tab: query.states?.length === 1 ? query.states[0]! : 'all', text: query.text ?? '', sort: query.sort ?? 'added',
      filters: { people: query.people ?? [], decades: query.decades ?? [], publishers: query.publishers ?? [], languages: query.languages ?? [] },
    };
  }
  createEffect(() => {
    props.notebook.changeSequence(); props.notebook.lastChange(); refresh();
    const controller = new AbortController();
    void props.notebook.api.libraryViews(controller.signal).then(result => {
      if (controller.signal.aborted) return;
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
    void props.notebook.api.highlights({ unprocessed: true, limit: 0 }, controller.signal).then(result => {
      if (!controller.signal.aborted) { setUnprocessedCount(result.total); setCountError(''); }
    }).catch(reason => { if (!controller.signal.aborted) setCountError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });

  createEffect(() => {
    const currentTab = tab();
    const query = currentQuery();
    const unprocessed = unprocessedOnly();
    const highlightColors = colors(), highlightTags = tags();
    const currentKey = queryKey();
    props.notebook.changeSequence(); refresh();
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      void Promise.all([
        props.notebook.api.library(query, controller.signal),
        currentTab === 'highlights' ? props.notebook.api.highlights({ unprocessed, colors: highlightColors, tags: highlightTags, limit: 200 }, controller.signal) : Promise.resolve(undefined),
      ]).then(([sources, cited]) => {
        if (controller.signal.aborted) return;
        const focused = scroll.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.libraryRow : undefined;
        batch(() => {
          setLibrary(sources);
          if (cited) setHighlights(cited);
          else {
            setSourceRows(sources.rows);
            const ids = new Set(sources.rows.map(row => row.page.id));
            setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
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
    }, 150);
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
  function clearSelection() { setSelected(new Set<string>()); selectionAnchor = null; }
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
        if (view().view === value.id) update({ view: null });
        setPopup(null); setRefresh(value => value + 1);
      }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setSaving(false); }
  }
  function viewMenu(value: LibraryView, anchor: HTMLElement) {
    setPopup({ kind: 'menu', anchor, label: 'Library view actions', items: [
      { label: 'Rename', action: () => setPopup({ kind: 'name', anchor, saved: value, id: value.id }) },
      { label: 'Delete', action: () => { setCommandError(''); setPopup({ kind: 'delete', anchor, saved: value }); } },
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
  function rowMenu(row: LibraryRow, anchor: HTMLElement) {
    setPopup({ kind: 'menu', anchor, label: 'Source actions', items: [
      ...(row.source.current_snapshot_id ? [{ label: 'Read', icon: 'book' as const, action: () => props.onOpen({ kind: 'reader', sourceId: row.page.id }, false) }] : []),
      ...stateActions.filter(action => action.state !== row.source.state).map(action => ({
        label: action.label, disabledReason: saving() ? 'Saving…' : undefined,
        action: () => { void changeState(row, action.state); },
      })),
      { label: 'Export BibTeX', icon: 'download', action: () => { void download('bibtex', [row.page.id]); } },
      { label: 'Export CSL JSON', icon: 'download', action: () => { void download('csl', [row.page.id]); } },
      { label: 'Export Markdown', icon: 'download', action: () => { void download('markdown', [row.page.id]); } },
      { label: 'Delete…', icon: 'trash', danger: true, disabledReason: saving() ? 'Saving…' : undefined, action: () => confirmDelete(anchor, [row]) },
    ] });
  }
  function rowKey(event: KeyboardEvent, target: OpenTarget) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); props.onOpen(target, event.shiftKey);
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

  function SourceRows(rowsProps: { rows: LibraryRow[] }) {
    return <Show when={layout() === 'shelf'} fallback={<div role="list"><For each={rowsProps.rows}>{row => {
      const target: OpenTarget = { kind: 'page', pageId: row.page.id };
      return <div class="library-row library-source-row" classList={{ 'library-row-selected': selected().has(row.page.id) }} role="listitem">
        <div class="library-leading">
          <span class="library-source-image"><Show when={row.cover} fallback={<Icon name={row.source.format === 'article' ? 'article' : 'book'} />}><ResourceImage snapshotId={row.source.current_snapshot_id ?? ''} href={row.cover!} alt="" loading="lazy" /></Show></span>
          <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
            <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
          </Button>
        </div>
        <Button class="library-row-open" data-library-row={row.page.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
          <span class="library-siglum" aria-hidden="true">{sigla().get(row.page.id) ?? row.source.siglum}</span><span class="library-title">{row.page.text}</span><span class="library-byline">{sourceByline(row)}</span>
          <Show when={mixedStates()}><span class="library-count library-state">{stateLabels[row.source.state]}</span></Show>
          <span class="library-count library-year" aria-label="Published year">{row.published?.slice(0, 4)}</span>
          <span class="library-progress"><Show when={row.progress > 0}>{formatProgress(row.progress)}</Show></span>
          <span class="library-highlight-count" aria-label={row.unprocessed ? `${row.unprocessed} unprocessed highlights` : undefined}><Show when={row.unprocessed > 0}><Icon name="highlight" />{row.unprocessed}</Show></span>
        </Button>
        <Button icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" disabled={saving()} onClick={event => rowMenu(row, event.currentTarget)} />
      </div>;
    }}</For></div>}>
      <div class="library-shelf" role="list"><For each={rowsProps.rows}>{row => {
        const target: OpenTarget = { kind: 'page', pageId: row.page.id };
        const siglum = () => sigla().get(row.page.id) ?? row.source.siglum;
        return <div class="library-book library-source-row" classList={{ 'library-row-selected': selected().has(row.page.id) }} role="listitem">
          <Button class="library-book-open" data-library-row={row.page.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
            <SourceCover row={row} siglum={siglum()} />
            <span class="library-reading-rule" classList={{ 'library-reading-started': row.progress > 0 }} style={{ '--progress': `${row.progress * 100}%` }} aria-hidden="true" />
            <span class="library-book-title">{row.page.text}</span>
            <span class="library-book-byline">{sourceByline(row)}</span>
            <span class="library-book-apparatus">
              <span class="library-siglum" aria-hidden="true">{siglum()}</span>
              <Show when={mixedStates()}><span class="library-book-state">{stateLabels[row.source.state]}</span></Show>
              <Show when={row.published}><span aria-label="Published year">{row.published!.slice(0, 4)}</span></Show>
              <Show when={row.progress > 0}><span>{formatProgress(row.progress)}</span></Show>
              <Show when={row.unprocessed > 0}><span class="library-book-highlights" aria-label={`${row.unprocessed} unprocessed highlights`}><Icon name="highlight" />{row.unprocessed}</span></Show>
            </span>
          </Button>
          <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
            <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
          </Button>
          <Button class="library-book-more" icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" disabled={saving()} onClick={event => rowMenu(row, event.currentTarget)} />
        </div>;
      }}</For></div>
    </Show>;
  }

  return <div class="library-pane" data-pane={props.pane} aria-label="Library" tabIndex={props.active ? 0 : -1} onFocusIn={props.onActivate} onPointerDown={props.onActivate}
    onKeyDown={event => { if (event.key === 'Escape' && selected().size && !popup()) { event.preventDefault(); event.stopPropagation(); clearSelection(); } }}
    onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={event => { if (event.dataTransfer?.files.length) { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); } }}>
    <header class="library-toolbar">
      <div class="library-tabs mode-tabs" role="group" aria-label="Library state">
        <For each={tabs}>{item => {
          // Zero counts are left out so the tabs fit a narrow pane.
          const count = () => item.id === 'highlights' ? unprocessedCount() : !library() ? undefined : item.id === 'all' ? Object.values(library()!.counts).reduce((sum, value) => sum + value, 0) : library()!.counts[item.id as ReadingState];
          return <Button aria-pressed={!view().view && tab() === item.id} onClick={() => update({ view: null, tab: item.id, scroll: 0 })}>
            {item.label}<Show when={count()}><span class="library-count">{count()}</span></Show>
          </Button>;
        }}</For>
        <For each={views()}>{value => <div class="library-tabs mode-tabs">
          <Button aria-pressed={view().view === value.id} onClick={() => chooseView(value)}>{value.name}</Button>
          <Button icon="more" label={`Actions for view ${value.name}`} aria-haspopup="menu" disabled={saving()} onClick={event => viewMenu(value, event.currentTarget)} />
        </div>}</For>
      </div>
      <div class="library-controls">
        <Show when={tab() !== 'highlights'} fallback={<div class="library-filter">
          <div class="library-tabs mode-tabs" role="group" aria-label="Highlight processing">
            <Button title={processedExplanation} aria-pressed={unprocessedOnly()} onClick={() => update({ unprocessedOnly: true, scroll: 0 })}>Unprocessed</Button>
            <Button aria-pressed={!unprocessedOnly()} onClick={() => update({ unprocessedOnly: false, scroll: 0 })}>All</Button>
          </div>
          <div class="library-tabs" role="group" aria-label="Highlight colours">
            <For each={highlightColors}>{color => <Button class="icon-only" aria-label={`Filter ${color}`} aria-pressed={colors().includes(color)} onClick={() => update({ colors: colors().includes(color) ? colors().filter(value => value !== color) : [...colors(), color], scroll: 0 })}><span class={`highlight-color-dot highlight-color-${color}`} aria-hidden="true" /></Button>}</For>
          </div>
          <Button aria-haspopup="dialog" onClick={event => { setTagQuery(''); setPopup({ kind: 'tags', anchor: event.currentTarget }); }}>Filter tags</Button>
          <For each={tags()}>{tag => <Button class="outline-tag" aria-label={`Remove tag filter ${tag}`} onClick={() => update({ tags: tags().filter(value => value !== tag), scroll: 0 })}>#{tag}<Icon name="close" /></Button>}</For>
          <Show when={colors().length || tags().length}><Button onClick={() => update({ colors: [], tags: [], scroll: 0 })}>Clear filters</Button></Show>
        </div>}>
          <Show when={selected().size > 0} fallback={<>
            <input class="input library-search" type="search" aria-label="Search library" placeholder="Search library" value={text()} onInput={event => update({ view: null, text: event.currentTarget.value, scroll: 0 })} />
            <Button class="library-sort" aria-haspopup="menu" label="Sort and group sources" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Sort and group sources', items: [
              ...sorts.map(item => ({ section: 'Sort', label: item.label, icon: sort() === item.id ? 'check' as const : undefined, action: () => update({ view: null, sort: item.id, scroll: 0 }) })),
              ...groupings.map(item => ({ section: 'Group', label: item.label, icon: group() === item.id ? 'check' as const : undefined, action: () => update({ group: item.id }) })),
            ] })}>{sorts.find(item => item.id === sort())!.label}<Show when={group() !== 'none'}><span class="library-sort-group"> · by {groupings.find(item => item.id === group())!.label.toLowerCase()}</span></Show><Icon name="down" /></Button>
            <div class="library-tabs mode-tabs" role="group" aria-label="Library layout">
              <Button icon="rows" label="List" aria-pressed={layout() === 'list'} onClick={() => chooseLayout('list')} />
              <Button icon="shelf" label="Shelf" aria-pressed={layout() === 'shelf'} onClick={() => chooseLayout('shelf')} />
            </div>
            <Show when={browseEntries().length}><Button class="library-browse-button" icon="browse" label="Browse" aria-haspopup="dialog" aria-pressed={filtered()} onClick={event => { setBrowseQuery(''); setPopup({ kind: 'browse', anchor: event.currentTarget, field: null }); }} /></Show>
            <Button icon="download" label="Export" aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => exportMenu(event.currentTarget)}><span class="library-export-label">Export</span><Icon name="down" /></Button>
            <Button icon="more" label="Library actions" aria-haspopup="menu" onClick={event => {
              const anchor = event.currentTarget;
              setPopup({ kind: 'menu', anchor, label: 'Library actions', items: [
                { label: 'Save view…', disabledReason: saving() ? 'Saving…' : undefined,
                  action: () => setPopup({ kind: 'name', anchor, saved: null, id: ulid() }) },
              ] });
            }} />
          </>}>
            <span class="library-selection-count">{selected().size} selected</span>
            <Button aria-haspopup="menu" disabled={saving()} onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Mark as', items: tabs.filter(item => item.id !== 'all' && item.id !== 'highlights').map(item => ({ label: item.label, action: () => { void changeSelectedState(item.id as ReadingState); } })) })}>Mark as<Icon name="down" /></Button>
            <Button aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => exportMenu(event.currentTarget)}>Export<Icon name="down" /></Button>
            <Button icon="trash" class="danger" aria-haspopup="dialog" disabled={saving()} onClick={event => confirmDelete(event.currentTarget, displayedSources().filter(row => selected().has(row.page.id)))}>Delete</Button>
            <Button class="library-clear-selection" onClick={clearSelection}>Clear selection</Button>
          </Show>
        </Show>
        <Button icon="plus" aria-haspopup={EMBEDDED ? undefined : 'dialog'} aria-expanded={EMBEDDED ? undefined : popup()?.kind === 'add'} onClick={event => { if (EMBEDDED) { fileInput.click(); return; } setPopup({ kind: 'add', anchor: event.currentTarget }); }}>Add</Button>
      </div>
      <Show when={tab() !== 'highlights' && chosenFilters().length}><div class="library-filter library-chosen" role="group" aria-label="Browse filters">
        <For each={chosenFilters()}>{item => <Button class="bordered library-chip" aria-label={`Remove filter ${item.label}`} onClick={() => toggleFilter(item.field, item.value)}>{item.label}<Icon name="close" /></Button>}</For>
        <Button onClick={() => update({ view: null, filters: { people: [], decades: [], publishers: [], languages: [] }, scroll: 0 })}>Clear filters</Button>
      </div></Show>
      <Show when={saving() || props.notebook.commandState() !== 'saved'}><p class="library-message" role="status">{props.notebook.commandMessage() || (saving() ? 'Saving…' : props.notebook.commandState())}</p></Show>
    </header>
    <input ref={fileInput} type="file" hidden aria-label="Choose EPUB files" accept=".epub,application/epub+zip" multiple onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files);
    }} />
    <div ref={scroll} class="library-scroll" onScroll={() => {
      if (restoreScroll !== null) return;
      const next = { ...view(), scroll: scroll.scrollTop };
      setView(next); props.onViewChange({ ...next });
    }}>
      <Show when={tab() !== 'highlights' && browseEntries().length}>
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
      <Show when={countError()}><div class="library-error" role="alert">{countError()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={jobsError()}><div class="library-error" role="alert">{jobsError()}<Button onClick={() => setJobsRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={viewsError()}><div class="library-error" role="alert">{viewsError()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      {/* The Reading tab already lists these books, so it leaves the strip out, as do search and Browse; it stays while selecting so rows never shift under the pointer. */}
      <Show when={resume().length && tab() !== 'reading' && tab() !== 'highlights' && !text().trim() && !filtered()}>
        <section class="library-resume" aria-labelledby={`${props.pane}-resume-heading`}>
          <h2 class="library-resume-heading" id={`${props.pane}-resume-heading`}>Continue reading</h2>
          <div class="library-resume-books" role="list"><For each={resume()}>{row => <div role="listitem">
            <Button class="library-resume-book" onClick={event => props.onOpen({ kind: 'reader', sourceId: row.page.id }, event.shiftKey)}>
              <SourceCover row={row} siglum={row.source.siglum} />
              <span class="library-resume-text">
                <span class="library-resume-title">{row.page.text}</span>
                <span class="library-resume-section">{row.section ?? sourceByline(row)}</span>
                <span class="library-resume-position">
                  <span class="library-reading-rule library-reading-started" style={{ '--progress': `${row.progress * 100}%` }} aria-hidden="true" />
                  <span>{formatProgress(row.progress)}</span>
                </span>
              </span>
            </Button>
          </div>}</For></div>
        </section>
      </Show>
      <section class="library-rows" classList={{ 'library-has-selection': selected().size > 0, 'library-rows-shelf': layout() === 'shelf' && tab() !== 'highlights', 'library-rows-grouped': !!groups() }} aria-label={tab() === 'highlights' ? 'Highlights' : 'Sources'} aria-busy={loading()}>
        <Show when={shownJobs().length}><div class="library-jobs" aria-label="Ingestion jobs"><For each={shownJobs()}>{job => {
          const label = () => jobLabel(job, sourceTitles());
          return <div class="library-row library-job">
            <span class="library-leading"><Icon name={job.state === 'failed' ? 'warning' : job.state === 'done' ? 'book' : 'saving'} /></span>
            <span class="library-job-name">{label().name}</span><span class="library-message">{label().state}</span>
            <Show when={job.state !== 'done' && label().attempt}><span class="library-message">{label().attempt}</span></Show>
            <Show when={job.state !== 'done' && job.next_attempt_at !== null && props.notebook.settings()}><span class="library-message">retries at {retryTime(job.next_attempt_at!, props.notebook.settings()!.time_zone)}</span></Show>
            <Show when={job.state === 'failed'}><div class="library-job-actions"><Button disabled={retrying().includes(job.id)} onClick={() => { void retryJob(job); }}>Retry</Button><Button onClick={() => dismissJob(job.id)}>Dismiss</Button></div></Show>
            <Show when={job.error}><span class="library-job-error" role={job.state === 'failed' ? 'alert' : undefined}>{job.error}</span></Show>
          </div>; }}</For></div></Show>
        <Show when={loading() && !hasResult() && slowLoad()}><p class="library-message" role="status">Loading…</p></Show>
        <Show when={error()}><div class="library-error" role="alert">{error()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
        <Show when={hasResult() && !error()}>
          <Show when={tab() !== 'highlights'} fallback={
            <Show when={highlights()?.rows.length} fallback={<div class="library-empty"><Show when={unprocessedOnly()} fallback={<p>No matching highlights.</p>}><p>No unprocessed highlights.</p><p>{processedExplanation}</p></Show></div>}>
              <div class="library-highlights" role="list"><For each={highlightGroups()}>{group => <div class="library-highlight-group" role="listitem">
                <div class="library-highlight-heading"><Button onClick={event => props.onOpen({ kind: 'page', pageId: group.sourceId }, event.shiftKey)}>{group.title}</Button><span>{group.rows.length}</span></div>
                <For each={highlightChapters(group.rows)}>{chapter => <>
                  <Show when={chapter.title}><h4 class="library-highlight-chapter">{chapter.title}</h4></Show>
                  <div role="list"><For each={chapter.rows}>{row => {
                    const target: OpenTarget = { kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id };
                    return <div class="library-row" role="listitem" onPointerEnter={() => setLinkedCitation(row.citation.id)} onPointerLeave={() => setLinkedCitation(null)}><Button class="library-highlight" data-library-row={row.citation.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
                      <span class="library-highlight-text"><span class={`highlight-color-dot highlight-color-${row.color ?? 'none'}`} role="img" aria-label={row.color ? `${row.color} highlight` : 'No colour'} /><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></span>
                      <span class="library-highlight-details">
                        <Show when={props.notebook.settings()}>{settings => <span class="library-highlight-meta">{highlightMeta(row, settings().time_zone)}<Show when={row.notes > 0}> · {row.notes} {row.notes === 1 ? 'note' : 'notes'}</Show></span>}</Show>
                        <Show when={row.tags.length}><span class="library-highlight-tags"><For each={row.tags}>{tag => <span class="outline-tag">#{tag}</span>}</For></span></Show>
                      </span>
                      <Show when={row.block.block.text.trim() !== row.citation.quote.trim()}><span class="library-highlight-quote">{row.citation.quote}</span></Show>
                    </Button><Button icon="more" label="Actions for highlight" aria-haspopup="menu" aria-expanded={popup()?.kind === 'menu' && popup()?.anchor.dataset.highlightId === row.citation.id} data-highlight-id={row.citation.id} onClick={event => { void highlightMenu(row, event.currentTarget); }} /></div>;
                  }}</For></div>
                </>}</For>
              </div>}</For></div>
            </Show>
          }>
            <Show when={displayedSources().length} fallback={<div class="library-empty">
              <Show when={text().trim() || filtered()} fallback={<Show when={tab() === 'inbox'} fallback={<p>No sources.</p>}>
                <p>{EMBEDDED ? 'Nothing in your inbox. Add an EPUB.' : 'Nothing in your inbox. Add a book or article.'}</p>
              </Show>}><p>No sources match.</p><Button onClick={() => update({ view: null, text: '', filters: { people: [], decades: [], publishers: [], languages: [] }, scroll: 0 })}>{filtered() ? 'Clear search and filters' : 'Clear search'}</Button></Show>
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
      </div>
    </div>
    <Show keyed when={popup()}>{state => {
      const dismiss = () => { if (popup() === state) setPopup(null); };
      if (state.kind === 'menu') return <Menu anchor={state.anchor} label={state.label} items={state.items} header={state.Header && <state.Header onDismiss={dismiss} />} onDismiss={dismiss} />;
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
      return <AddSheet anchor={state.anchor} notebook={props.notebook} onDismiss={dismiss} onChooseFile={() => fileInput.click()} onFiles={files => { void upload(files); }} onJob={recordJob} onAdded={pageId => props.onOpen({ kind: 'page', pageId }, false)} />;
    }}</Show>
    <highlightActions.TagPopup />
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
