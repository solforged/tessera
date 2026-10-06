import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { VirtualItem } from '@tanstack/solid-virtual';
import { ulid } from 'ulid';
import type { Citation, HighlightRow, Passage, PassageHit, PassagePage, SourceView, TocEntry } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, ReaderViewState } from '../shell/contract';
import { formatProgress, highlightLocation } from '../library/query';
import { createHighlightActions, highlightSections } from '../library/highlights';
import type { HighlightSection } from '../library/highlights';
import { documentReady } from '../tasks/JournalAgenda';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { PassageText } from './PassageText';
import { selectionInPassages } from './passages';
import type { PassageSelection } from './passages';
import './reader.css';

export interface ReaderPaneProps {
  pane: PaneId;
  target: Extract<OpenTarget, { kind: 'reader' }>;
  view: ReaderViewState;
  notebook: NotebookClient;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: ReaderViewState): void;
}

const PAGE_SIZE = 200;
type ReaderPopup = { kind: 'contents' | 'find' | 'highlights'; anchor: HTMLElement } | { kind: 'note'; anchor: HTMLElement; text: string; loading: boolean } | { kind: 'menu'; anchor: HTMLElement; items: MenuItem[] };
type SelectionToolbar = PassageSelection & { rect: DOMRect; snapshotId: string };

export function ReaderPane(props: ReaderPaneProps) {
  const api = props.notebook.api;
  const [source, setSource] = createSignal<SourceView>();
  const [snapshot, setSnapshot] = createSignal('');
  const [contents, setContents] = createSignal<TocEntry[]>([]);
  const [total, setTotal] = createSignal(0);
  const [progress, setProgress] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<ReaderPopup | null>(null);
  const [query, setQuery] = createSignal('');
  const [hits, setHits] = createSignal<PassageHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal('');
  const [selection, setSelection] = createSignal<SelectionToolbar | null>(null);
  const [editError, setEditError] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [flash, setFlash] = createSignal<Citation | null>(null);
  const [highlights, setHighlights] = createSignal<HighlightRow[]>([]);
  const [sections, setSections] = createSignal<HighlightSection[]>([]);
  const [highlightsLoading, setHighlightsLoading] = createSignal(false);
  const [highlightsError, setHighlightsError] = createSignal('');
  const actions = createHighlightActions(props.notebook, props.onOpen, setError);
  const pages = new Map<number, PassagePage>();
  const passages = new Map<number, Passage>();
  const ordinals = new Map<string, number>();
  const pending = new Map<number, Promise<void>>();
  const locating = new Map<string, Promise<number | null>>();
  let scroll!: HTMLDivElement;
  let disposed = false, restoring = true, generation = 0, jumpVersion = 0;
  let suppressed = !!(props.target.at || props.target.citationId), jumpOrigin = 0, userScroll = false;
  let reportTimer = 0, positionTimer = 0, flashTimer = 0;
  const requests = new AbortController();
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return total(); },
    getScrollElement: () => scroll,
    estimateSize: () => 112,
    overscan: 8,
    get rangeExtractor() {
      const selected = selection();
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = defaultRangeExtractor(range);
        if (selected) for (let i = selected.first; i <= selected.last; i++) if (!indices.includes(i)) indices.push(i);
        return indices.sort((a, b) => a - b);
      };
    },
  });
  const items = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [item.index, item])));
  const citations = createMemo(() => {
    version();
    const values = new Map<string, Citation>();
    for (const page of pages.values()) for (const citation of page.citations) values.set(citation.id, citation);
    const flashed = flash();
    if (flashed) values.set(flashed.id, flashed);
    return [...values.values()];
  });
  const toc = createMemo(() => contents().filter(entry => entry.title.toLocaleLowerCase().includes(query().toLocaleLowerCase())));
  const sourceHighlights = createMemo(() => highlights()
    .filter(row => row.citation.snapshot_id === snapshot())
    .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset || a.citation.id.localeCompare(b.citation.id)));
  const highlightLabel = (row: HighlightRow) => `${highlightLocation(row.citation, sections())} · ${row.citation.quote.slice(0, 80)}`;
  const filteredHighlights = createMemo(() => sourceHighlights().filter(row => highlightLabel(row).toLocaleLowerCase().includes(query().toLocaleLowerCase())));

  createEffect(() => {
    const id = snapshot();
    if (!id) return;
    const controller = new AbortController();
    setSections([]);
    void highlightSections(api, id, controller.signal).then(values => { if (!controller.signal.aborted) setSections(values); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const sourceId = props.target.sourceId;
    props.notebook.changeSequence();
    const controller = new AbortController();
    setHighlightsLoading(true); setHighlightsError('');
    void api.highlights({ source_id: sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, controller.signal).then(result => {
      if (!controller.signal.aborted) { setHighlights(result.rows); setHighlightsLoading(false); }
    }).catch(reason => {
      if (!controller.signal.aborted) { setHighlightsError(reason instanceof Error ? reason.message : String(reason)); setHighlightsLoading(false); }
    });
    onCleanup(() => controller.abort());
  });

  async function locate(at: string): Promise<number | null> {
    const cached = ordinals.get(at);
    if (cached !== undefined) return cached;
    const existing = locating.get(at);
    if (existing) return existing;
    const id = snapshot(), epoch = generation;
    const request = api.locate(id, at, requests.signal).then(ordinal => {
      if (epoch === generation && ordinal !== null) { ordinals.set(at, ordinal); setVersion(value => value + 1); }
      return ordinal;
    }).finally(() => { if (epoch === generation) locating.delete(at); });
    locating.set(at, request);
    return request;
  }

  async function loadPage(from: number, refresh = false) {
    const start = Math.floor(from / PAGE_SIZE) * PAGE_SIZE;
    if (!snapshot() || start < 0 || start >= total() || pages.has(start) && !refresh) return;
    if (pending.has(start)) return pending.get(start);
    const id = snapshot(), epoch = generation;
    const request = api.passages(id, start, PAGE_SIZE, requests.signal).then(async page => {
      if (disposed || epoch !== generation) return;
      pages.set(start, page);
      for (const passage of page.passages) { passages.set(passage.ordinal, passage); ordinals.set(passage.id, passage.ordinal); }
      batch(() => { setTotal(page.total); setContents(page.toc); setVersion(value => value + 1); });
      await Promise.all(page.citations.flatMap(citation => [locate(citation.start.passage_id), locate(citation.end.passage_id)]));
    }).finally(() => { if (epoch === generation) pending.delete(start); });
    pending.set(start, request);
    return request;
  }

  function switchSnapshot(id: string) {
    if (snapshot() === id) return;
    generation++;
    pages.clear(); passages.clear(); ordinals.clear(); pending.clear(); locating.clear();
    clearTimeout(positionTimer);
    batch(() => {
      setSelection(null); setFlash(null); setSnapshot(id);
      setContents([]);
      setTotal(source()?.snapshots.find(value => value.id === id)?.passage_count ?? 0);
      setProgress(id === source()?.source.current_snapshot_id ? source()!.progress : 0);
      setVersion(value => value + 1);
    });
    virtualizer.measure();
  }

  async function jump(ordinal: number, offset = 0) {
    const token = ++jumpVersion, epoch = generation;
    restoring = true; userScroll = false; clearTimeout(positionTimer); setSelection(null);
    const index = Math.max(0, Math.min(ordinal, total() - 1));
    await loadPage(index);
    if (disposed || epoch !== generation || token !== jumpVersion || !total()) return;
    virtualizer.scrollToIndex(index, { align: 'start' });
    // The destination's real height replaces its estimate after Solid mounts it.
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (disposed || epoch !== generation || token !== jumpVersion) return;
      virtualizer.scrollToIndex(index, { align: 'start' });
    }
    if (offset) scroll.scrollTop -= offset;
    jumpOrigin = scroll.scrollTop;
    restoring = false;
    report();
  }

  async function jumpTo(at: string) {
    setPopup(null);
    try {
      const ordinal = await locate(at);
      if (ordinal === null) throw new Error('Passage not found.');
      await jump(ordinal);
    } catch (reason) { if (!disposed) { restoring = false; setError(String(reason instanceof Error ? reason.message : reason)); } }
  }

  function visibleRange() {
    if (!scroll || !scroll.getClientRects().length || scroll.closest('[inert], [aria-hidden="true"]') || document.visibilityState === 'hidden') return null;
    const viewport = scroll.getBoundingClientRect();
    let first: { ordinal: number; offset: number } | null = null, last = -1;
    for (const row of scroll.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const rect = row.getBoundingClientRect(), ordinal = Number(row.dataset.ordinal);
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      if (!first || ordinal < first.ordinal) first = { ordinal, offset: rect.top - viewport.top };
      last = Math.max(last, ordinal);
    }
    return first ? { ...first, last } : null;
  }

  function report() {
    if (disposed || restoring) return;
    const range = visibleRange();
    if (range) props.onViewChange({ snapshotId: snapshot(), ordinal: range.ordinal, offset: range.offset });
  }

  async function savePosition() {
    const range = visibleRange(), id = snapshot(), epoch = generation;
    if (!range || disposed || restoring || suppressed || !userScroll) return;
    try {
      const result = await api.readingPosition(id, range.ordinal, range.ordinal, range.last + 1, requests.signal);
      if (!disposed && epoch === generation) setProgress(result.progress);
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function scrolled() {
    if (restoring) return;
    if (!reportTimer) reportTimer = window.setTimeout(() => { reportTimer = 0; report(); }, 120);
    if (suppressed && userScroll && Math.abs(scroll.scrollTop - jumpOrigin) > scroll.clientHeight) suppressed = false;
    clearTimeout(positionTimer);
    if (!suppressed && userScroll) positionTimer = window.setTimeout(() => { void savePosition(); }, 2000);
    if (!editing()) setSelection(null);
  }

  createEffect(() => {
    const rows = virtualizer.getVirtualItems();
    snapshot(); total();
    const needed = new Set(rows.map(row => Math.floor(row.index / PAGE_SIZE) * PAGE_SIZE));
    for (const start of needed) void loadPage(start).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
  });
  createEffect(on(() => props.notebook.changeSequence(), () => {
    for (const from of pages.keys()) void loadPage(from, true).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
  }, { defer: true }));
  createEffect(() => {
    const state = popup(), text = query().trim(), sourceId = props.target.sourceId;
    if (state?.kind !== 'find' || !text) { setHits([]); setSearching(false); setSearchError(''); return; }
    const controller = new AbortController();
    setSearching(true); setSearchError('');
    const timer = window.setTimeout(() => {
      void api.searchPassages(text, sourceId, 40, controller.signal).then(values => {
        if (!controller.signal.aborted) { setHits(values); setSearching(false); }
      }).catch(reason => { if (!controller.signal.aborted) { setSearchError(reason instanceof Error ? reason.message : String(reason)); setSearching(false); } });
    }, 180);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });

  async function note(locator: string, anchor: HTMLElement) {
    const state: ReaderPopup = { kind: 'note', anchor, text: '', loading: true };
    setPopup(state);
    try {
      const ordinal = await locate(locator);
      if (ordinal === null) throw new Error('Footnote not found.');
      await loadPage(ordinal);
      if (!disposed && popup() === state) setPopup({ kind: 'note', anchor, text: passages.get(ordinal)?.text ?? '', loading: false });
    } catch (reason) { if (!disposed && popup() === state) setPopup({ kind: 'note', anchor, text: reason instanceof Error ? reason.message : String(reason), loading: false }); }
  }

  async function openCitation(citation: Citation) {
    try {
      const block = props.notebook.lookup(citation.block_id)() ?? await api.block(citation.block_id);
      if (!disposed) props.onOpen({ kind: 'page', pageId: block.page_id, blockId: citation.block_id }, true);
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function citationMenu(citation: Citation, anchor: HTMLElement) {
    try {
      const result = await api.highlights({ source_id: citation.source_id, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, requests.signal);
      const row = result.rows.find(value => value.citation.id === citation.id);
      if (!row) throw new Error('Citation not found.');
      const items = await actions(row, `“${row.citation.quote}” — ${row.source_title}, ${highlightLocation(row.citation, sections())}`);
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, items });
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function clickedCitation(values: Citation[], anchor: HTMLElement, beside: boolean) {
    if (beside) { void openCitation(values[0]!); return; }
    if (values.length === 1) { void citationMenu(values[0]!, anchor); return; }
    setPopup({ kind: 'menu', anchor, items: values.map(citation => ({
      label: `“${citation.quote.slice(0, 40)}…”`, action: () => { void citationMenu(citation, anchor); },
    })) });
  }

  async function jumpHighlight(citation: Citation) {
    setPopup(null); suppressed = true;
    try {
      await locate(citation.end.passage_id);
      const ordinal = await locate(citation.start.passage_id);
      if (ordinal === null) throw new Error('Passage not found.');
      await jump(ordinal);
      if (!disposed) {
        clearTimeout(flashTimer); setFlash(citation);
        flashTimer = window.setTimeout(() => setFlash(null), 1500);
      }
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function selected() {
    if (editing()) return;
    const dom = window.getSelection();
    const value = dom && selectionInPassages(scroll, dom, [...passages.values()]);
    setSelection(value && dom!.rangeCount ? { ...value, rect: dom!.getRangeAt(0).getBoundingClientRect(), snapshotId: snapshot() } : null);
    setEditError('');
  }

  async function highlight(withNote: boolean) {
    const value = selection();
    if (!value || editing()) return;
    setEditing(true); setEditError('');
    const sourceId = props.target.sourceId, doc = props.notebook.open(sourceId);
    try {
      await documentReady(doc);
      const result = doc.edit({ kind: 'highlight', parentId: sourceId, text: value.quote, citation: {
        id: ulid(), sourceId, snapshotId: value.snapshotId, start: value.start, end: value.end, quote: value.quote, locator: value.locator, ordinal: value.first,
      } });
      if (!result.ok) { setEditError(result.reason); return; }
      const highlightId = result.created[0]!;
      // An empty note does not mark the highlight processed until it has text.
      const note = withNote ? doc.edit({ kind: 'insert', parentId: highlightId, after: null }) : null;
      if (note && !note.ok) { setEditError(note.reason); return; }
      await doc.flush();
      if (!disposed) {
        setSelection(null); window.getSelection()?.removeAllRanges();
        if (note?.ok) props.onOpen({ kind: 'page', pageId: sourceId, blockId: highlightId, caretId: note.created[0] }, true);
      }
    } catch (reason) { if (!disposed) setEditError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc.release(); if (!disposed) setEditing(false); }
  }

  const selectionKey = (event: KeyboardEvent) => {
    if (!props.active || !selection() || popup() || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as Element)?.closest('input, textarea, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'h' || key === 'n') { event.preventDefault(); event.stopImmediatePropagation(); void highlight(key === 'n'); }
    else if (event.key === 'Escape') { event.preventDefault(); setSelection(null); }
  };

  onMount(() => {
    document.addEventListener('selectionchange', selected);
    document.addEventListener('keydown', selectionKey, true);
    const initialView = { ...props.view }, target = { ...props.target };
    void (async () => {
      const value = await api.source(target.sourceId, requests.signal);
      if (disposed) return;
      setSource(value);
      const id = initialView.snapshotId ?? target.snapshotId ?? value.source.current_snapshot_id;
      if (!id) throw new Error('No snapshot available.');
      switchSnapshot(id);
      let ordinal = initialView.ordinal >= 0 ? initialView.ordinal : value.position?.snapshot_id === id ? value.position.passage_ordinal : 0;
      let citation: Citation | undefined;
      await loadPage(ordinal);
      if (target.citationId) {
        citation = (await api.highlights({ source_id: target.sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, requests.signal)).rows.find(row => row.citation.id === target.citationId)?.citation;
        if (!citation) throw new Error('Citation not found.');
        switchSnapshot(citation.snapshot_id);
        await loadPage(0);
        const located = await locate(citation.start.passage_id);
        if (located === null) throw new Error('Passage not found.');
        ordinal = located;
        await locate(citation.end.passage_id);
        setFlash(citation);
      } else if (target.at) {
        const located = await locate(target.at);
        if (located === null) throw new Error('Passage not found.');
        ordinal = located;
      }
      if (disposed) return;
      await jump(ordinal, target.at || citation || initialView.ordinal < 0 ? 0 : initialView.offset);
      if (citation) flashTimer = window.setTimeout(() => setFlash(null), 1500);
      setLoading(false);
    })().catch(reason => { if (!disposed) { restoring = false; setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); } });
  });
  onCleanup(() => {
    disposed = true; requests.abort();
    clearTimeout(reportTimer); clearTimeout(positionTimer); clearTimeout(flashTimer);
    document.removeEventListener('selectionchange', selected);
    document.removeEventListener('keydown', selectionKey, true);
  });

  function PassageRow(row: { ordinal: number; item: () => VirtualItem }) {
    const passage = createMemo(() => { version(); return passages.get(row.ordinal); });
    let element!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(element));
    return <div ref={element} class="reader-row" data-index={row.ordinal} style={{ transform: `translateY(${row.item().start}px)` }}>
      <Show when={passage()} fallback={<div class="reader-placeholder" aria-hidden="true" />}>{value => <Dynamic
        component={value().kind === 'heading' ? `h${Math.min(3, Math.max(1, value().level ?? 1))}` : value().kind === 'quote' ? 'blockquote' : value().kind === 'code' ? 'pre' : 'div'}
        class={`reader-passage reader-${value().kind}`} data-passage-id={value().id} data-ordinal={value().ordinal} style={{ '--level': Math.max(0, value().level ?? 0) }}>
        <Show when={value().kind === 'image' && value().resource} fallback={<PassageText passage={value()} citations={citations()} ordinals={(() => { version(); return ordinals; })()} flashId={flash()?.id ?? null} onLocate={at => { void jumpTo(at); }} onNote={(at, anchor) => { void note(at, anchor); }} onCitation={clickedCitation} />}>
          <img src={api.resourceUrl(snapshot(), value().resource!)} alt={value().text} onLoad={() => virtualizer.measureElement(element)} />
        </Show>
      </Dynamic>}</Show>
    </div>;
  }

  return <div class="reader-pane" onPointerDown={props.onActivate} onFocusIn={props.onActivate}>
    <div class="reader-header">
      <Show when={contents().length}><Button icon="contents" aria-haspopup="dialog" onClick={event => { setQuery(''); setPopup({ kind: 'contents', anchor: event.currentTarget }); }}>Contents</Button></Show>
      <Button icon="highlight" aria-haspopup="dialog" disabled={!snapshot()} onClick={event => { setQuery(''); setPopup({ kind: 'highlights', anchor: event.currentTarget }); }}>Highlights</Button>
      <Button icon="search" aria-haspopup="dialog" disabled={!snapshot()} onClick={event => { setQuery(''); setPopup({ kind: 'find', anchor: event.currentTarget }); }}>Find in source</Button>
      <span class="reader-progress" aria-label="Reading progress">{formatProgress(progress())}</span>
    </div>
    <Show when={error()}><p class="reader-error error" role="alert">{error()}</p></Show>
    <Show when={loading()}><p class="reader-status" role="status">Loading…</p></Show>
    <div ref={scroll} class="reader-scroll" tabIndex={0} aria-label="Source passages" onScroll={scrolled}
      onWheel={() => { userScroll = true; }} onTouchMove={() => { userScroll = true; }} onPointerDown={() => { userScroll = true; }}
      onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) userScroll = true; }}>
      <div class="reader-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={[...items().keys()]}>{ordinal => <PassageRow ordinal={ordinal} item={() => items().get(ordinal)!} />}</For>
      </div>
    </div>
    <Show when={popup()}>{state => <>
      <Show when={state().kind === 'contents'}><Picker anchor={state().anchor} label="Contents" placeholder="Find a section" query={query()} onQuery={setQuery} items={toc()} key={entry => entry.locator}
        row={entry => <span class="reader-toc-entry" style={{ '--level': Math.max(0, entry.level - 1) }}>{entry.title}</span>}
        onPick={entry => { void jumpTo(entry.locator); }} empty="No sections" onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'highlights'}><Picker anchor={state().anchor} label="Highlights" placeholder="Highlights" query={query()} onQuery={setQuery} items={filteredHighlights()} key={row => row.citation.id}
        row={row => <span class="reader-search-snippet">{highlightLabel(row)}</span>} busy={highlightsLoading()} error={highlightsError()} empty="No highlights"
        onPick={row => { void jumpHighlight(row.citation); }} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'menu'}><Menu anchor={state().anchor} label="Actions for highlight" items={(() => { const value = state(); return value.kind === 'menu' ? value.items : []; })()} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'find'}><Picker anchor={state().anchor} label="Find in source" placeholder="Find in source" query={query()} onQuery={setQuery} items={hits()} key={hit => `${hit.snapshot_id}:${hit.passage.id}`}
        row={hit => <span class="reader-search-snippet">{hit.snippet}</span>} busy={searching()} error={searchError()} empty={query().trim() ? 'No passages found' : 'Search this source'}
        onPick={hit => { setPopup(null); switchSnapshot(hit.snapshot_id); void jump(hit.passage.ordinal).catch(reason => { restoring = false; setError(reason instanceof Error ? reason.message : String(reason)); }); }}
        onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'note'}><Popup anchor={state().anchor} label="Footnote" class="reader-note" onDismiss={() => setPopup(null)}>
        <p>{(() => { const value = state(); return value.kind === 'note' ? value.loading ? 'Loading…' : value.text : ''; })()}</p>
      </Popup></Show>
    </>}</Show>
    <Show when={selection()}>{value => <Portal><div class="reader-selection-toolbar" role="toolbar" aria-label="Highlight selection"
      style={{ left: `${Math.max(8, Math.min(value().rect.left, window.innerWidth - 320))}px`, top: `${Math.max(0, value().rect.top)}px` }}
      onPointerDown={event => event.preventDefault()}>
      <div class="reader-selection-actions"><Button icon="highlight" disabled={editing()} onClick={() => { void highlight(false); }}>Highlight <kbd>H</kbd></Button><Button disabled={editing()} onClick={() => { void highlight(true); }}>Highlight and note <kbd>N</kbd></Button></div>
      <Show when={editError()}><p class="error" role="alert">{editError()}</p></Show>
    </div></Portal>}</Show>
  </div>;
}
