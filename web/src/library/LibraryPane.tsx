import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import { exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { HighlightResult, HighlightRow, IngestJob, LibraryQuery, LibraryResult, LibraryRow, LibraryView, ReadingState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { EMBEDDED } from '../demo/mode';
import { BlockText } from '../outline/BlockText';
import type { LibraryTab, LibraryViewState, OpenTarget, PaneId } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { Picker } from '../ui/Picker';
import { downloadBlob } from '../ui/download';
import { formatProgress, highlightMeta, jobLabel, libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';
import { createHighlightActions, highlightColors, highlightSections, setLinkedCitation } from './highlights';
import type { HighlightMenu, HighlightSection } from './highlights';
import { ResourceImage } from './ResourceImage';
import './library.css';

export interface LibraryPaneProps {
  pane: PaneId;
  view: LibraryViewState;
  notebook: NotebookClient;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: LibraryViewState): void;
}

type LibraryPopup =
  | { kind: 'add'; anchor: HTMLElement }
  | { kind: 'tags'; anchor: HTMLElement }
  | { kind: 'name'; anchor: HTMLElement; saved: LibraryView | null; id: string }
  | { kind: 'delete'; anchor: HTMLElement; saved: LibraryView }
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[]; Header?: HighlightMenu['Header'] };
const tabs: { id: LibraryTab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'reading', label: 'Reading' },
  { id: 'finished', label: 'Finished' }, { id: 'abandoned', label: 'Abandoned' },
  { id: 'all', label: 'All' }, { id: 'highlights', label: 'Highlights' },
];
const sorts: { id: LibraryViewState['sort']; label: string }[] = [
  { id: 'added', label: 'Added' }, { id: 'title', label: 'Title' },
  { id: 'last_read', label: 'Last read' }, { id: 'progress', label: 'Progress' },
];
const stateActions: { state: ReadingState; label: string }[] = [
  { state: 'reading', label: 'Mark as reading' }, { state: 'finished', label: 'Mark as finished' },
  { state: 'abandoned', label: 'Mark as abandoned' }, { state: 'inbox', label: 'Return to inbox' },
];

const processedExplanation = 'A highlight counts as processed once it has a note, a card or a link, or when you mark it.';
export function LibraryPane(props: LibraryPaneProps) {
  const [view, setView] = createSignal({ ...props.view });
  const tab = createMemo(() => view().tab);
  const text = createMemo(() => view().text);
  const sort = createMemo(() => view().sort);
  const unprocessedOnly = createMemo(() => view().unprocessedOnly);
  const colors = createMemo(() => view().colors);
  const tags = createMemo(() => view().tags);
  const [tagQuery, setTagQuery] = createSignal('');
  const [views, setViews] = createSignal<LibraryView[]>([]);
  const [viewsError, setViewsError] = createSignal('');
  const saved = createMemo(() => views().find(value => value.id === view().view));
  const currentQuery = createMemo(() => saved()?.query ?? libraryQuery({ tab: tab(), text: text(), sort: sort() }));
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
  createEffect(() => {
    const controller = new AbortController();
    void props.notebook.api.notebook(controller.signal).then(info => {
      if (controller.signal.aborted) return;
      dismissedKey = `tessera.library.dismissed.${info.id}`;
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(dismissedKey) ?? '[]');
        if (Array.isArray(stored)) setDismissedJobs(previous => new Set([...previous, ...stored.filter((id): id is string => typeof id === 'string')]));
      } catch { /* The preference lasts for this tab. */ }
    }).catch(reason => { if (!controller.signal.aborted) setJobsError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });
  function dismissJob(id: string) {
    const next = new Set(dismissedJobs()); next.add(id); setDismissedJobs(next);
    try { if (dismissedKey) localStorage.setItem(dismissedKey, JSON.stringify([...next])); } catch { /* The preference lasts for this tab. */ }
  }
  const [popup, setPopup] = createSignal<LibraryPopup | null>(null);
  const [url, setUrl] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal('');
  const doneJobs = new Set<string>();
  // Jobs concern sources; the Highlights tab shows none.
  const shownJobs = createMemo(() => tab() === 'highlights' || error() ? [] : visibleJobs(jobs().filter(job => !(job.state === 'failed' && dismissedJobs().has(job.id))), new Set(displayedSources().map(row => row.page.id))));
  const sourceTitles = createMemo(() => new Map(props.notebook.roots().map(root => [root.id, root.text])));
  let scroll!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let restoreScroll: number | null = props.view.scroll;
  let disposed = false;
  onCleanup(() => { disposed = true; setLinkedCitation(null); });

  const highlightActions = createHighlightActions(props.notebook, props.onOpen, setCommandError);
  const [highlightContents, setHighlightContents] = createSignal(new Map<string, HighlightSection[]>());
  const sectionCache = new Map<string, HighlightSection[]>();
  createEffect(() => {
    const snapshots = [...new Set(highlights()?.rows.map(row => row.citation.snapshot_id) ?? [])];
    const controller = new AbortController();
    void Promise.all(snapshots.map(async id => {
      const sections = sectionCache.get(id) ?? await highlightSections(props.notebook.api, id, controller.signal);
      if (!controller.signal.aborted) sectionCache.set(id, sections);
      return [id, sections] as const;
    })).then(entries => { if (!controller.signal.aborted) setHighlightContents(new Map(entries)); })
      .catch(reason => { if (!controller.signal.aborted) setCommandError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });

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
    const filtersChanged = JSON.stringify([next.colors, next.tags]) !== JSON.stringify([previous.colors, previous.tags]);
    if (next.view === previous.view && next.tab === previous.tab && next.text === previous.text && next.sort === previous.sort && next.unprocessedOnly === previous.unprocessedOnly && !filtersChanged && next.scroll === previous.scroll) return;
    const queryChanged = next.view !== previous.view || next.tab !== previous.tab || next.text !== previous.text || next.sort !== previous.sort || next.unprocessedOnly !== previous.unprocessedOnly || filtersChanged;
    restoreScroll = queryChanged ? next.scroll : null;
    setView({ ...next });
    if (!queryChanged) scroll.scrollTop = next.scroll;
  }, { defer: true }));

  function viewFields(query: LibraryQuery): Pick<LibraryViewState, 'tab' | 'text' | 'sort'> {
    return { tab: query.states?.length === 1 ? query.states[0]! : 'all', text: query.text ?? '', sort: query.sort ?? 'added' };
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
  async function queueUrl() {
    if (EMBEDDED || !url().trim() || adding()) return;
    setAdding(true); setAddError('');
    try {
      const job = await props.notebook.api.queueUrl(url().trim());
      if (disposed) return;
      recordJob(job); setUrl(''); setPopup(null);
    } catch (reason) {
      if (!disposed) setAddError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setAdding(false); }
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
  function toggleSelection(id: string, range: boolean) {
    setSelected(previous => selectSources(displayedSources().map(row => row.page.id), previous, id, selectionAnchor, range));
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
      { label: 'Read', icon: 'book', action: () => props.onOpen({ kind: 'reader', sourceId: row.page.id }, false) },
      ...stateActions.filter(action => action.state !== row.source.state).map(action => ({
        label: action.label, disabledReason: saving() ? 'Saving…' : undefined,
        action: () => { void changeState(row, action.state); },
      })),
      { label: 'Export BibTeX', icon: 'download', action: () => { void download('bibtex', [row.page.id]); } },
      { label: 'Export CSL JSON', icon: 'download', action: () => { void download('csl', [row.page.id]); } },
      { label: 'Export Markdown', icon: 'download', action: () => { void download('markdown', [row.page.id]); } },
    ] });
  }
  function rowKey(event: KeyboardEvent, target: OpenTarget) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); props.onOpen(target, event.shiftKey);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const rows = Array.from(scroll.querySelectorAll<HTMLButtonElement>('[data-library-row]'));
      const index = rows.indexOf(event.currentTarget as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus(); event.preventDefault(); event.stopPropagation();
    }
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
            <Button class="library-sort" aria-haspopup="menu" label="Sort sources" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Sort sources', items: sorts.map(item => ({ label: item.label, icon: sort() === item.id ? 'check' : undefined, action: () => update({ view: null, sort: item.id, scroll: 0 }) })) })}>{sorts.find(item => item.id === sort())!.label}<Icon name="down" /></Button>
            <Button icon="plus" aria-haspopup={EMBEDDED ? undefined : 'dialog'} aria-expanded={EMBEDDED ? undefined : popup()?.kind === 'add'} onClick={event => { if (EMBEDDED) { fileInput.click(); return; } setAddError(''); setPopup({ kind: 'add', anchor: event.currentTarget }); }}>Add</Button>
            <Button icon="download" aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => exportMenu(event.currentTarget)}>Export<Icon name="down" /></Button>
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
            <Button class="library-clear-selection" onClick={clearSelection}>Clear selection</Button>
          </Show>
        </Show>
      </div>
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
      <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
      <Show when={countError()}><div class="library-error" role="alert">{countError()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={jobsError()}><div class="library-error" role="alert">{jobsError()}<Button onClick={() => setJobsRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={viewsError()}><div class="library-error" role="alert">{viewsError()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <section class="library-rows" classList={{ 'library-has-selection': selected().size > 0 }} aria-label={tab() === 'highlights' ? 'Highlights' : 'Sources'} aria-busy={loading()}>
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
                <div role="list"><For each={group.rows}>{row => {
                  const target: OpenTarget = { kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id };
                  return <div class="library-row" role="listitem" onPointerEnter={() => setLinkedCitation(row.citation.id)} onPointerLeave={() => setLinkedCitation(null)}><Button class="library-highlight" data-library-row={row.citation.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
                    <span class="library-highlight-text"><span class={`highlight-color-dot highlight-color-${row.color ?? 'none'}`} role="img" aria-label={row.color ? `${row.color} highlight` : 'No colour'} /><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></span>
                    <span class="library-highlight-details">
                      <Show when={props.notebook.settings()}>{settings => <span class="library-highlight-meta">{highlightMeta(row, highlightContents().get(row.citation.snapshot_id) ?? [], settings().time_zone)}<Show when={row.notes > 0}> · {row.notes} {row.notes === 1 ? 'note' : 'notes'}</Show></span>}</Show>
                      <Show when={row.tags.length}><span class="library-highlight-tags"><For each={row.tags}>{tag => <span class="outline-tag">#{tag}</span>}</For></span></Show>
                    </span>
                    <Show when={row.block.block.text.trim() !== row.citation.quote.trim()}><span class="library-highlight-quote">{row.citation.quote}</span></Show>
                  </Button><Button icon="more" label="Actions for highlight" aria-haspopup="menu" aria-expanded={popup()?.kind === 'menu' && popup()?.anchor.dataset.highlightId === row.citation.id} data-highlight-id={row.citation.id} onClick={event => { void highlightMenu(row, event.currentTarget); }} /></div>;
                }}</For></div>
              </div>}</For></div>
            </Show>
          }>
            <Show when={displayedSources().length} fallback={<div class="library-empty">
              <Show when={text().trim()} fallback={<Show when={tab() === 'inbox'} fallback={<p>No sources.</p>}>
                <p>{EMBEDDED ? 'Nothing in your inbox. Add an EPUB.' : 'Nothing in your inbox. Add a book or article.'}</p>
              </Show>}><p>No sources match.</p><Button onClick={() => update({ view: null, text: '', scroll: 0 })}>Clear search</Button></Show>
            </div>}>
              <div role="list"><For each={displayedSources()}>{row => {
                const target: OpenTarget = { kind: 'page', pageId: row.page.id };
                return <div class="library-row library-source-row" classList={{ 'library-row-selected': selected().has(row.page.id) }} role="listitem">
                  <div class="library-leading">
                    <span class="library-source-image"><Show when={row.cover && row.source.current_snapshot_id} fallback={<Icon name={row.source.format === 'epub' ? 'book' : 'article'} />}><ResourceImage snapshotId={row.source.current_snapshot_id!} href={row.cover!} alt="" loading="lazy" /></Show></span>
                    <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="icon-only library-checkbox" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
                      <span class="library-checkbox-square"><Show when={selected().has(row.page.id)}><Icon name="check" /></Show></span>
                    </Button>
                  </div>
                  <Button class="library-row-open" data-library-row={row.page.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
                    <span class="library-title">{row.page.text}</span><span class="library-byline">{sourceByline(row)}</span>
                    <span class="library-progress"><Show when={row.progress > 0}>{formatProgress(row.progress)}</Show></span>
                    <span class="library-highlight-count" aria-label={row.unprocessed ? `${row.unprocessed} unprocessed highlights` : undefined}><Show when={row.unprocessed > 0}><Icon name="highlight" />{row.unprocessed}</Show></span>
                  </Button>
                  <Button icon="more" label={`Actions for ${row.page.text}`} aria-haspopup="menu" disabled={saving()} onClick={event => rowMenu(row, event.currentTarget)} />
                </div>;
              }}</For></div>
            </Show>
          </Show>
        </Show>
      </section>
    </div>
    <Show keyed when={popup()}>{state => {
      const dismiss = () => { if (popup() === state) setPopup(null); };
      if (state.kind === 'menu') return <Menu anchor={state.anchor} label={state.label} items={state.items} header={state.Header && <state.Header onDismiss={dismiss} />} onDismiss={dismiss} />;
      if (state.kind === 'tags') return <Picker anchor={state.anchor} label="Filter highlight tags" placeholder="Find a tag" query={tagQuery()} onQuery={setTagQuery} items={tagOptions()} key={tag => tag}
        row={tag => <><Show when={tags().includes(tag)}><Icon name="check" /></Show><span class="outline-tag">#{tag}</span></>}
        onPick={tag => { update({ tags: tags().includes(tag) ? tags().filter(value => value !== tag) : [...tags(), tag], scroll: 0 }); dismiss(); }} empty="No tags in these highlights" onDismiss={dismiss} />;
      if (state.kind === 'name') return <LibraryViewNamePopup anchor={state.anchor} saved={state.saved} busy={saving()} onDismiss={dismiss} onSave={name => saveView(name, state.id, state.saved)} />;
      if (state.kind === 'delete') return <Popup anchor={state.anchor} label="Delete library view?" onDismiss={dismiss}>
        <p>Delete “{state.saved.name}”? Sources are not deleted.</p>
        <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
        <div class="popup-actions"><Button disabled={saving()} onClick={dismiss}>Cancel</Button><Button class="bordered danger" disabled={saving()} onClick={() => { void deleteView(state.saved); }}>Delete view</Button></div>
      </Popup>;
      if (EMBEDDED) return null;
      return <Popup anchor={state.anchor} label="Add source" class="library-add" fitContent onDismiss={dismiss}>
        <h2 class="popup-title">Add source</h2>
        <form onSubmit={event => { event.preventDefault(); void queueUrl(); }}>
          <label class="library-add-url">Article URL<input class="input" aria-label="URL" placeholder="https://…" inputmode="url" value={url()} disabled={adding()} onInput={event => setUrl(event.currentTarget.value)} /></label>
          <Show when={addError()}><p class="library-error" role="alert">{addError()}</p></Show>
          <div class="library-add-actions">
            <Button icon="upload" disabled={adding()} onClick={() => { dismiss(); fileInput.click(); }}>Choose EPUB…</Button>
            <Button type="submit" class="bordered" disabled={!url().trim() || adding()}>{adding() ? 'Adding…' : 'Add article'}</Button>
          </div>
        </form>
      </Popup>;
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
