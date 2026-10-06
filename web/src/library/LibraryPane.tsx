import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { HighlightResult, HighlightRow, IngestJob, LibraryQuery, LibraryResult, LibraryRow, LibraryView, ReadingState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { LibraryTab, LibraryViewState, OpenTarget, PaneId } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { formatProgress, highlightMeta, jobLabel, libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';
import { createHighlightActions, highlightSections } from './highlights';
import type { HighlightSection } from './highlights';
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
  | { kind: 'name'; anchor: HTMLElement; saved: LibraryView | null; id: string }
  | { kind: 'delete'; anchor: HTMLElement; saved: LibraryView }
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[] };
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

export function LibraryPane(props: LibraryPaneProps) {
  const [view, setView] = createSignal({ ...props.view });
  const tab = createMemo(() => view().tab);
  const text = createMemo(() => view().text);
  const sort = createMemo(() => view().sort);
  const unprocessedOnly = createMemo(() => view().unprocessedOnly);
  const [views, setViews] = createSignal<LibraryView[]>([]);
  const [viewsError, setViewsError] = createSignal('');
  const saved = createMemo(() => views().find(value => value.id === view().view));
  const currentQuery = createMemo(() => saved()?.query ?? libraryQuery({ tab: tab(), text: text(), sort: sort() }));
  const queryKey = createMemo(() => JSON.stringify([view().view, tab(), currentQuery(), unprocessedOnly()]));
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  let selectionAnchor: string | null = null;
  createEffect(on(queryKey, () => { setSelected(new Set<string>()); selectionAnchor = null; }));
  const [loadedKey, setLoadedKey] = createSignal('');
  const [library, setLibrary] = createSignal<LibraryResult>();
  const [highlights, setHighlights] = createSignal<HighlightResult>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [commandError, setCommandError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [refresh, setRefresh] = createSignal(0);
  const [jobs, setJobs] = createSignal<IngestJob[]>([]);
  const [jobsError, setJobsError] = createSignal('');
  const [jobsRefresh, setJobsRefresh] = createSignal(0);
  const [retrying, setRetrying] = createSignal<string[]>([]);
  const [popup, setPopup] = createSignal<LibraryPopup | null>(null);
  const [url, setUrl] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal('');
  const doneJobs = new Set<string>();
  const shownJobs = createMemo(() => visibleJobs(jobs(), new Set(tab() === 'highlights' || loadedKey() !== queryKey() ? [] : library()?.rows.map(row => row.page.id) ?? [])));
  const sourceTitles = createMemo(() => new Map(props.notebook.roots().map(root => [root.id, root.text])));
  let scroll!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let restoreScroll: number | null = props.view.scroll;
  let disposed = false;
  onCleanup(() => { disposed = true; });

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
      const items = await highlightActions(row);
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, label: 'Actions for highlight', items: [
        { label: 'Open in reader', action: () => props.onOpen({ kind: 'reader', sourceId: row.citation.source_id, snapshotId: row.citation.snapshot_id, citationId: row.citation.id }, true) },
        ...items,
      ] });
    } catch (reason) { if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const update = (patch: Partial<LibraryViewState>) => {
    const next = { ...view(), ...patch, scroll: patch.scroll ?? scroll.scrollTop };
    if (patch.scroll !== undefined) { restoreScroll = null; scroll.scrollTop = patch.scroll; }
    setView(next);
    props.onViewChange({ ...next });
  };
  createEffect(on(() => props.view, next => {
    const previous = view();
    if (next.view === previous.view && next.tab === previous.tab && next.text === previous.text && next.sort === previous.sort && next.unprocessedOnly === previous.unprocessedOnly && next.scroll === previous.scroll) return;
    restoreScroll = next.view !== previous.view || next.tab !== previous.tab || next.text !== previous.text || next.sort !== previous.sort || next.unprocessedOnly !== previous.unprocessedOnly ? next.scroll : null;
    setView({ ...next });
    scroll.scrollTop = next.scroll;
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
    const currentTab = tab();
    const query = currentQuery();
    const unprocessed = unprocessedOnly();
    const currentKey = queryKey();
    props.notebook.changeSequence(); refresh();
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      void Promise.all([
        props.notebook.api.library(query, controller.signal),
        currentTab === 'highlights' ? props.notebook.api.highlights({ unprocessed, limit: 200 }, controller.signal) : Promise.resolve(undefined),
      ]).then(([sources, cited]) => {
        if (controller.signal.aborted) return;
        const focused = scroll.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.libraryRow : undefined;
        batch(() => { setLibrary(sources); setHighlights(cited); setLoadedKey(currentKey); setLoading(false); });
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
    if (!url().trim() || adding()) return;
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
  function toggleSelection(id: string, range: boolean) {
    setSelected(previous => selectSources(library()?.rows.map(row => row.page.id) ?? [], previous, id, selectionAnchor, range));
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
    ] });
  }
  async function downloadQuery(format: 'bibtex' | 'csl', query: LibraryQuery) {
    setCommandError('');
    try {
      const blob = await props.notebook.api.exportQuery(format, query);
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = format === 'bibtex' ? 'library.bib' : 'library.json';
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function download(format: 'bibtex' | 'csl', ids: string[]) {
    // An empty ID list means every source to the API, not the empty result set.
    if (!ids.length) return;
    const anchor = document.createElement('a');
    anchor.href = props.notebook.api.exportUrl(format, ids);
    anchor.download = format === 'bibtex' ? 'library.bib' : 'library.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
  }
  function rowMenu(row: LibraryRow, anchor: HTMLElement) {
    setPopup({ kind: 'menu', anchor, label: 'Source actions', items: [
      { label: 'Read', icon: 'book', action: () => props.onOpen({ kind: 'reader', sourceId: row.page.id }, false) },
      ...stateActions.filter(action => action.state !== row.source.state).map(action => ({
        label: action.label, disabledReason: saving() ? 'Saving…' : undefined,
        action: () => { void changeState(row, action.state); },
      })),
      { label: 'Export BibTeX', icon: 'download', action: () => download('bibtex', [row.page.id]) },
      { label: 'Export CSL JSON', icon: 'download', action: () => download('csl', [row.page.id]) },
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
    onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={event => { if (event.dataTransfer?.files.length) { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); } }}>
    <header class="library-toolbar">
      <div class="library-tabs" role="group" aria-label="Library state">
        <For each={tabs}>{item => <Button aria-pressed={!view().view && tab() === item.id} onClick={() => update({ view: null, tab: item.id, scroll: 0 })}>
          {item.label}<Show when={item.id !== 'highlights' && library()}><span class="library-count">{item.id === 'all' ? Object.values(library()!.counts).reduce((sum, count) => sum + count, 0) : library()!.counts[item.id as ReadingState]}</span></Show>
        </Button>}</For>
        <For each={views()}>{value => <div class="library-tabs">
          <Button aria-pressed={view().view === value.id} onClick={() => chooseView(value)}>{value.name}</Button>
          <Button icon="more" label={`Actions for view ${value.name}`} aria-haspopup="menu" disabled={saving()} onClick={event => viewMenu(value, event.currentTarget)} />
        </div>}</For>
      </div>
      <div class="library-controls">
        <Show when={tab() !== 'highlights'} fallback={<div class="library-filter"><div class="library-tabs" role="group" aria-label="Highlight processing">
          <Button aria-pressed={unprocessedOnly()} onClick={() => update({ unprocessedOnly: true, scroll: 0 })}>Unprocessed</Button>
          <Button aria-pressed={!unprocessedOnly()} onClick={() => update({ unprocessedOnly: false, scroll: 0 })}>All</Button>
        </div><p class="library-message">A highlight counts as processed once it has a note, a card or a link, or when you mark it.</p></div>}>
          <input class="input library-search" type="search" aria-label="Search library" placeholder="Search library" value={text()} onInput={event => update({ view: null, text: event.currentTarget.value, scroll: 0 })} />
          <Button aria-haspopup="menu" label="Sort sources" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Sort sources', items: sorts.map(item => ({ label: item.label, icon: sort() === item.id ? 'check' : undefined, action: () => update({ view: null, sort: item.id, scroll: 0 }) })) })}>{sorts.find(item => item.id === sort())!.label}<Icon name="down" /></Button>
        </Show>
        <Button icon="plus" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'add'} onClick={event => { setAddError(''); setPopup({ kind: 'add', anchor: event.currentTarget }); }}>Add</Button>
        <Show when={tab() !== 'highlights'}><Button icon="download" aria-haspopup="menu" disabled={loading() || !!error() || loadedKey() !== queryKey()} onClick={event => {
          const ids = [...selected()], query = currentQuery();
          setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Export sources', items: [
            { label: 'BibTeX', action: () => { if (ids.length) download('bibtex', ids); else void downloadQuery('bibtex', query); } },
            { label: 'CSL JSON', action: () => { if (ids.length) download('csl', ids); else void downloadQuery('csl', query); } },
          ] });
        }}>{selected().size ? `Export ${selected().size} selected` : 'Export this view'}</Button></Show>
        <Button icon="more" label="Library actions" aria-haspopup="menu" onClick={event => {
          const anchor = event.currentTarget;
          setPopup({ kind: 'menu', anchor, label: 'Library actions', items: [
            { label: 'Save view…', disabledReason: tab() === 'highlights' ? 'Select a source view.' : saving() ? 'Saving…' : undefined,
              action: () => setPopup({ kind: 'name', anchor, saved: null, id: ulid() }) },
          ] });
        }} />
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
      <Show when={jobsError()}><div class="library-error" role="alert">{jobsError()}<Button onClick={() => setJobsRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={viewsError()}><div class="library-error" role="alert">{viewsError()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={shownJobs().length}><section class="library-jobs" aria-label="Ingestion jobs"><For each={shownJobs()}>{job => {
        const label = () => jobLabel(job, sourceTitles());
        return <div class="library-job">
        <span class="library-job-name">{label().name}</span><span class="library-message">{label().state}</span>
        <Show when={label().attempt}><span class="library-message">{label().attempt}</span></Show>
        <Show when={job.next_attempt_at !== null && props.notebook.settings()}><span class="library-message">retries at {retryTime(job.next_attempt_at!, props.notebook.settings()!.time_zone)}</span></Show>
        <Show when={job.state === 'failed'}><Button disabled={retrying().includes(job.id)} onClick={() => { void retryJob(job); }}>Retry</Button></Show>
        <Show when={job.error}><span class="library-job-error" role={job.state === 'failed' ? 'alert' : undefined}>{job.error}</span></Show>
      </div>; }}</For></section></Show>
      <section aria-label={tab() === 'highlights' ? 'Highlights' : 'Sources'} aria-busy={loading()}>
        <Show when={loading()}><p class="library-message" role="status">Loading…</p></Show>
        <Show when={error()}><div class="library-error" role="alert">{error()}<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
        <Show when={loadedKey() === queryKey() && !error()}>
          <Show when={tab() !== 'highlights'} fallback={
            <Show when={highlights()?.rows.length} fallback={<p class="library-empty">No unprocessed highlights.</p>}>
              <div class="library-highlights" role="list"><For each={highlights()?.rows}>{row => {
                const target: OpenTarget = { kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id };
                return <div class="library-row" role="listitem"><Button class="library-highlight" data-library-row={row.citation.id} onClick={event => props.onOpen(target, event.shiftKey)} onKeyDown={event => rowKey(event, target)}>
                  <span class="library-highlight-text"><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></span>
                  <Show when={props.notebook.settings()}>{settings => <span class="library-highlight-meta">{highlightMeta(row, highlightContents().get(row.citation.snapshot_id) ?? [], settings().time_zone)}</span>}</Show>
                  <span class="library-highlight-source">{row.source_title}</span>
                  <Show when={row.block.block.text.trim() !== row.citation.quote.trim()}><span class="library-highlight-quote">{row.citation.quote}</span></Show>
                </Button><Button icon="more" label="Actions for highlight" aria-haspopup="menu" aria-expanded={popup()?.kind === 'menu' && popup()?.anchor.dataset.highlightId === row.citation.id} data-highlight-id={row.citation.id} onClick={event => { void highlightMenu(row, event.currentTarget); }} /></div>;
              }}</For></div>
            </Show>
          }>
            <Show when={library()?.rows.length} fallback={<div class="library-empty">
              <Show when={text().trim()} fallback={<Show when={tab() === 'inbox'} fallback={<p>No sources.</p>}>
                <p>Nothing in your inbox. Add a book or article.</p>
              </Show>}><p>No sources match.</p><Button onClick={() => update({ view: null, text: '', scroll: 0 })}>Clear search</Button></Show>
            </div>}>
              <div class="library-rows" role="list"><For each={library()?.rows}>{row => {
                const target: OpenTarget = { kind: 'page', pageId: row.page.id };
                return <div class="library-row" role="listitem">
                  <Button role="checkbox" aria-checked={selected().has(row.page.id)} label={`Select ${row.page.text}`} class="bordered icon-only" onClick={event => toggleSelection(row.page.id, event.shiftKey)}>
                    <Show when={selected().has(row.page.id)} fallback={<span class="icon" />}><Icon name="check" /></Show>
                  </Button>
                  <Button class="library-row-open" data-library-row={row.page.id} onClick={event => { if (event.shiftKey) toggleSelection(row.page.id, true); else props.onOpen(target, false); }} onKeyDown={event => rowKey(event, target)}>
                    <span class="library-title">{row.page.text}</span><span class="library-byline">{sourceByline(row)}</span>
                    <Show when={row.progress > 0}><span class="library-progress">{formatProgress(row.progress)}</span></Show>
                    <Show when={row.unprocessed > 0}><span class="library-count" aria-label={`${row.unprocessed} unprocessed highlights`}><Icon name="highlight" />{row.unprocessed}</span></Show>
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
      if (state.kind === 'menu') return <Menu anchor={state.anchor} label={state.label} items={state.items} onDismiss={dismiss} />;
      if (state.kind === 'name') return <LibraryViewNamePopup anchor={state.anchor} saved={state.saved} busy={saving()} onDismiss={dismiss} onSave={name => saveView(name, state.id, state.saved)} />;
      if (state.kind === 'delete') return <Popup anchor={state.anchor} label="Delete library view?" onDismiss={dismiss}>
        <p>Delete “{state.saved.name}”? Sources are not deleted.</p>
        <Show when={commandError()}><p class="library-error" role="alert">{commandError()}</p></Show>
        <div class="popup-actions"><Button disabled={saving()} onClick={dismiss}>Cancel</Button><Button class="bordered danger" disabled={saving()} onClick={() => { void deleteView(state.saved); }}>Delete view</Button></div>
      </Popup>;
      return <Popup anchor={state.anchor} label="Add source" class="library-add" onDismiss={dismiss}>
        <form onSubmit={event => { event.preventDefault(); void queueUrl(); }}>
          <input class="input" aria-label="URL" placeholder="URL" inputmode="url" value={url()} disabled={adding()} onInput={event => setUrl(event.currentTarget.value)} />
          <Show when={addError()}><p class="library-error" role="alert">{addError()}</p></Show>
          <Button icon="upload" disabled={adding()} onClick={() => { dismiss(); fileInput.click(); }}>Choose EPUB…</Button>
        </form>
      </Popup>;
    }}</Show>
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
