import { For, Show, batch, createComputed, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { VirtualItem } from '@tanstack/solid-virtual';
import { ulid } from 'ulid';
import type { Citation, HighlightRow, Passage, PassageHit, PassagePage, SourceView, TocEntry } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, ReaderViewState } from '../shell/contract';
import { sourceMetadata } from '../library/details';
import { formatProgress, highlightLocation } from '../library/query';
import { createHighlightActions, highlightColors, setLinkedCitation } from '../library/highlights';
import type { HighlightMenu, HighlightSection } from '../library/highlights';
import { ResourceImage } from '../library/ResourceImage';
import { documentReady } from '../tasks/JournalAgenda';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { HighlightComposer } from './HighlightComposer';
import type { HighlightNoteDraft } from './HighlightComposer';
import { PassageText } from './PassageText';
import { passageNode, selectionInPassages } from './passages';
import type { PassageSelection } from './passages';
import { extendSelection, followOn, leadIn, sentenceAt, shrinkSelection } from './sentences';
import type { SelectionUnit, SentenceSelection } from './sentences';
import { ReaderSettingsPopup, readerSettings, readerStyle } from './ReaderSettings';
import { pageChunk } from './paged';
import type { PageChunk } from './paged';
import { mergeMembers, overlappingHighlights } from './highlight-merge';
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
  /** The reader fills the app window, without the sidebar, rail or pane header. */
  immersive: boolean;
  onImmersive(immersive: boolean): void;
}

const PAGE_SIZE = 200;
/** The gutter between columns, and between one page and the next. */
const PAGE_GAP = 48;
const pageTurns: Record<string, 1 | -1> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 1, PageUp: -1, ' ': 1 };
/** A place in the paged flow: a passage and a character offset into its text. */
type PageAnchor = { ordinal: number; offset: number };
type ReaderPopup = { kind: 'contents' | 'find' | 'highlights' | 'settings' | 'actions'; anchor: HTMLElement } | { kind: 'note'; anchor: HTMLElement; text: string; loading: boolean } | { kind: 'menu'; anchor: HTMLElement; items: MenuItem[]; Header?: HighlightMenu['Header'] };
type SelectionToolbar = PassageSelection & { rect: DOMRect; snapshotId: string };
/** Touch screens write a new highlight's note beside the passage, not in the source page. */
const coarsePointer = window.matchMedia('(pointer: coarse)');
const prose: Partial<Record<Passage['kind'], true>> = { paragraph: true, quote: true, list_item: true };

export function ReaderPane(props: ReaderPaneProps) {
  const api = props.notebook.api;
  const [source, setSource] = createSignal<SourceView>();
  const [snapshot, setSnapshot] = createSignal('');
  const [contents, setContents] = createSignal<TocEntry[]>([]);
  const [total, setTotal] = createSignal(0);
  const [firstVisible, setFirstVisible] = createSignal(0);
  const [titleHeight, setTitleHeight] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<ReaderPopup | null>(null);
  const [query, setQuery] = createSignal('');
  const [hits, setHits] = createSignal<PassageHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal('');
  const [selection, setSelection] = createSignal<SelectionToolbar | null>(null);
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [keyboardRange, setKeyboardRange] = createSignal<{ first: number; last: number } | null>(null);
  const [editError, setEditError] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [mergeMessage, setMergeMessage] = createSignal('');
  const readerDocument = props.notebook.open(props.target.sourceId);
  const [flash, setFlash] = createSignal<Citation | null>(null);
  const [highlights, setHighlights] = createSignal<HighlightRow[]>([]);
  const [composing, setComposing] = createSignal<HighlightNoteDraft | null>(null);
  const paged = () => readerSettings().layout === 'pages';
  const [chunk, setChunk] = createSignal<PageChunk | null>(null);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [pageCount, setPageCount] = createSignal(1);
  const [pageFrame, setPageFrame] = createSignal({ width: 0, columns: 1 });
  /** The text column's width when the contents margin fits beside it, else null. */
  const [textWidth, setTextWidth] = createSignal<number | null>(null);
  const chunkOrdinals = createMemo(() => {
    const value = chunk();
    return value ? Array.from({ length: value.last - value.first + 1 }, (_, index) => value.first + index) : [];
  });
  const sections = createMemo(() => contents().filter((entry): entry is HighlightSection => entry.ordinal !== null).sort((a, b) => a.ordinal - b.ordinal));
  const [highlightsLoading, setHighlightsLoading] = createSignal(false);
  const [highlightsError, setHighlightsError] = createSignal('');
  const actions = createHighlightActions(props.notebook, props.onOpen, setError);
  const pages = new Map<number, PassagePage>();
  const passages = new Map<number, Passage>();
  const ordinals = new Map<string, number>();
  const pending = new Map<number, Promise<void>>();
  const locating = new Map<string, Promise<number | null>>();
  let scroll!: HTMLDivElement, probe!: HTMLDivElement, frame: HTMLDivElement | undefined, margin: HTMLElement | undefined;
  let pointerStart: { x: number; y: number; touch: boolean } | null = null, wheelTotal = 0, lastWheel = 0, lastTurn = 0, countFrame = 0;
  // The character that relayouts keep on screen: set by turning, jumping and the cursor, never by a relayout itself.
  // A passage alone is not enough: a long one spans pages, and returning to its start would walk back a page each time.
  let pageAnchor: PageAnchor = { ordinal: 0, offset: 0 };
  let disposed = false, restoring = true, generation = 0, jumpVersion = 0;
  let suppressed = !!(props.target.at || props.target.citationId), jumpOrigin = 0, userScroll = false;
  let reportTimer = 0, positionTimer = 0, flashTimer = 0;
  let keyboardQueue = Promise.resolve(), keyboardPending = 0, keyboardVersion = 0, rewritingSelection = false;
  let shiftPressed = false;
  let settingsViewport: { ordinal: number; offset: number } | null = null, settingsAtStart = false, settingsFromPages = false, settingsVersion = 0;
  const requests = new AbortController();
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return total(); },
    getScrollElement: () => scroll,
    estimateSize: () => 112,
    overscan: 8,
    get paddingStart() { return titleHeight(); },
    get rangeExtractor() {
      const selected = keyboardRange() ?? selection(), current = cursor();
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = defaultRangeExtractor(range);
        if (selected) for (let i = selected.first; i <= selected.last; i++) if (!indices.includes(i)) indices.push(i);
        if (current !== null && !indices.includes(current)) indices.push(current);
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
  const currentSnapshot = createMemo(() => source()?.snapshots.find(value => value.id === snapshot()));
  const sectionAt = (ordinal: number) => {
    const entries = sections();
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.ordinal <= ordinal) return entries[index];
    return undefined;
  };
  const currentSection = createMemo(() => sectionAt(firstVisible()));
  /** A passage's place as a share of the text, the same measure the library and source page show. */
  const share = (ordinal: number) => {
    const length = currentSnapshot()?.text_length ?? 0;
    return length ? (passages.get(ordinal)?.start ?? 0) / length : 0;
  };
  /** The reading position. */
  const position = createMemo(() => { version(); return share(firstVisible()); });
  // The source page is the record: renaming the book or editing its creators shows here at once. The snapshot keeps
  // what the file said at import, and stands in only until the page has loaded.
  const [fieldDefinitions] = createResource(() => props.notebook.api.fields());
  const details = createMemo(() => sourceMetadata(readerDocument, props.notebook, fieldDefinitions()?.fields ?? []));
  const title = () => details().title?.trim() || currentSnapshot()?.metadata.title || '';
  const byline = createMemo(() => {
    const metadata = currentSnapshot()?.metadata, page = details();
    const names = page.creators.length ? page.creators.map(creator => creator.name) : metadata?.creators.map(creator => creator.name) ?? [];
    return [names.join(', ') || metadata?.site, (page.published ?? metadata?.published)?.match(/\d{4}/)?.[0]].filter(Boolean).join(' · ');
  });
  const sourceHighlights = createMemo(() => highlights()
    .filter(row => row.citation.snapshot_id === snapshot())
    .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset || a.citation.id.localeCompare(b.citation.id)));
  const filteredHighlights = createMemo(() => sourceHighlights().filter(row => `${row.citation.quote} ${highlightLocation(row.citation, sections())}`.toLocaleLowerCase().includes(query().toLocaleLowerCase())));
  const highlightNotes = createMemo(() => new Map(sourceHighlights().filter(row => row.notes > 0).map(row => [row.citation.id, row])));

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

  createComputed(on(readerSettings, () => {
    if (!settingsViewport) {
      settingsFromPages = !!scroll?.classList.contains('reader-paged') && !!chunk();
      settingsViewport = settingsFromPages ? { ordinal: pageAnchor.ordinal, offset: 0 } : visibleRange();
      settingsAtStart = !settingsFromPages && scroll?.scrollTop === 0;
    }
    const range = settingsViewport;
    if (!range) return;
    const epoch = generation, token = ++settingsVersion;
    requestAnimationFrame(() => {
      void (async () => {
        // fonts.ready can settle before the new face is requested; load it explicitly.
        if (readerSettings().typeface === 'serif') await document.fonts.load(`${readerSettings().size}px "Piazzolla Variable"`);
        if (disposed || epoch !== generation || token !== settingsVersion) return;
        // measure() would drop every cached size, and rows whose height did not change
        // (images, short headings) then fall back to the estimate. Re-measure mounted rows
        // only; rows mounted later measure themselves.
        for (const row of scroll.querySelectorAll<HTMLDivElement>('.reader-row')) virtualizer.measureElement(row);
        await (settingsFromPages && paged() ? relayoutPages() : jump(range.ordinal, range.offset));
        if (!disposed && epoch === generation && token === settingsVersion) {
          if (settingsAtStart) { scroll.scrollTop = 0; report(); }
          settingsViewport = null;
        }
      })().catch(reason => { if (!disposed) { settingsViewport = null; setError(reason instanceof Error ? reason.message : String(reason)); } });
    });
  }, { defer: true }));

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
    setCursor(null); setKeyboardRange(null);
    batch(() => {
      setSelection(null); setFlash(null); setSnapshot(id); setChunk(null);
      setContents([]);
      setFirstVisible(0);
      setTotal(source()?.snapshots.find(value => value.id === id)?.passage_count ?? 0);
      setVersion(value => value + 1);
    });
    virtualizer.measure();
  }

  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const pageStride = () => pageFrame().width + PAGE_GAP;

  /**
   * One column per page, or two when the pane fits two of at least 22em; never wider than the measure allows.
   * The frame takes a whole number of pixels no wider than the pane's fractional width, so pages are exactly
   * one frame and gap apart; a clamped fractional frame would drift a fraction of a pixel per page.
   */
  function layoutPages() {
    const style = getComputedStyle(scroll);
    const available = Math.floor(scroll.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const em = parseFloat(getComputedStyle(probe).fontSize), measure = probe.getBoundingClientRect().width;
    const columns = available >= 2 * 22 * em + PAGE_GAP ? 2 : 1;
    setPageFrame({ width: Math.floor(Math.min(available, columns * measure + (columns - 1) * PAGE_GAP)), columns });
  }

  /** The contents margin takes `--apparatus-width` and a 48 px gap left of the text, inside the pane's padding; it shows only where both fit. */
  function fitMargin() {
    if (!scroll.clientWidth) return;
    const style = getComputedStyle(scroll);
    const text = paged() ? pageFrame().width : probe.getBoundingClientRect().width;
    const room = (scroll.clientWidth - text) / 2 - parseFloat(style.paddingLeft);
    setTextWidth(room >= parseFloat(style.getPropertyValue('--apparatus-width')) + parseFloat(style.getPropertyValue('--space-48')) ? text : null);
  }
  createEffect(on([paged, pageFrame], fitMargin, { defer: true }));
  // The current section stays in view in the margin as reading moves on.
  createEffect(on(currentSection, () => {
    const entry = margin?.querySelector<HTMLElement>('[aria-current]');
    if (!margin || !entry) return;
    if (entry.offsetTop < margin.scrollTop || entry.offsetTop + entry.offsetHeight > margin.scrollTop + margin.clientHeight) margin.scrollTop = entry.offsetTop - margin.clientHeight / 3;
  }));

  function applyPage(index: number) {
    setPageIndex(index);
    if (frame) frame.scrollLeft = index * pageStride();
  }

  /** Overflowing columns run to the right of the frame, one page per frame width and gap. */
  function countPages() {
    if (!frame?.isConnected) return;
    const count = Math.max(1, Math.round((frame.scrollWidth + PAGE_GAP) / pageStride()));
    setPageCount(count);
    applyPage(Math.min(pageIndex(), count - 1));
  }
  const scheduleCount = () => { cancelAnimationFrame(countFrame); countFrame = requestAnimationFrame(countPages); };
  // Highlights, notes and late images reflow the chunk.
  createEffect(on(version, () => { if (paged()) scheduleCount(); }, { defer: true }));

  /** Text nodes of a passage in reading order, each with its offset into the passage's text. */
  function passageText(row: HTMLElement) {
    const nodes: { node: Text; start: number }[] = [], walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let start = 0;
    // SHOW_TEXT yields only Text nodes.
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.length) nodes.push({ node, start });
      start += node.length;
    }
    return nodes;
  }
  function characterRect(node: Text, index: number): DOMRect | undefined {
    const range = document.createRange();
    range.setStart(node, index); range.setEnd(node, index + 1);
    return range.getClientRects()[0];
  }

  /** The first character on the current page; characters run left to right across columns and pages. */
  function firstOnPage(): PageAnchor | null {
    if (!frame?.isConnected) return null;
    const view = frame.getBoundingClientRect(), past = (rect: DOMRect | undefined) => !!rect && rect.right > view.left + 1;
    for (const row of frame.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const rects = [...row.getClientRects()].filter(rect => rect.width);
      if (!rects.some(rect => past(rect) && rect.left < view.right - 1)) continue;
      const ordinal = Number(row.dataset.ordinal);
      if (rects[0]!.left > view.left - 1) return { ordinal, offset: 0 };
      for (const { node, start } of passageText(row)) {
        if (!past(characterRect(node, node.length - 1))) continue;
        let low = 0, high = node.length - 1;
        while (low < high) { const middle = (low + high) >> 1; if (past(characterRect(node, middle))) high = middle; else low = middle + 1; }
        return { ordinal, offset: start + low };
      }
      return { ordinal, offset: 0 };
    }
    return null;
  }

  /** The page holding an anchor's character. A column starts every stride / columns; 8 px absorbs rounding, well under the gap. */
  function pageOf(anchor: PageAnchor) {
    const row = frame?.querySelector<HTMLElement>(`[data-ordinal="${anchor.ordinal}"]`);
    if (!frame || !row) return 0;
    let rect = row.getClientRects()[0];
    if (anchor.offset) for (const { node, start } of passageText(row)) {
      if (anchor.offset < start + node.length) { rect = characterRect(node, anchor.offset - start) ?? rect; break; }
    }
    if (!rect) return 0;
    const { columns } = pageFrame(), x = rect.left - frame.getBoundingClientRect().left + frame.scrollLeft;
    return Math.max(0, Math.floor(Math.floor((x + 8) / (pageStride() / columns)) / columns));
  }

  /** Lay out the chunk holding an anchor, then turn to the anchor's page or the chunk's last page. */
  async function showPassage(anchor: PageAnchor, stale: () => boolean, edge?: 'last') {
    const target = pageChunk(sections(), total(), anchor.ordinal);
    for (let from = Math.floor(target.first / PAGE_SIZE) * PAGE_SIZE; from <= target.last; from += PAGE_SIZE) await loadPage(from);
    await document.fonts.ready;
    if (stale()) return;
    layoutPages();
    const current = chunk();
    if (current?.first !== target.first || current.last !== target.last) setChunk(target);
    await nextFrame(); await nextFrame();
    if (stale() || !frame) return;
    countPages();
    applyPage(edge === 'last' ? pageCount() - 1 : Math.min(pageOf(anchor), pageCount() - 1));
  }

  /** Lay the pages out again around the anchor after the pane or the type changes. */
  async function relayoutPages() {
    const token = ++jumpVersion, epoch = generation, anchor = pageAnchor, stale = () => disposed || epoch !== generation || token !== jumpVersion;
    restoring = true;
    await showPassage(anchor, stale);
    if (stale()) return;
    restoring = false;
    report();
  }

  async function revealPassage(ordinal: number) {
    pageAnchor = { ordinal, offset: 0 };
    const value = chunk();
    if (value && ordinal >= value.first && ordinal <= value.last) applyPage(pageOf(pageAnchor));
    else await showPassage(pageAnchor, () => disposed);
  }

  /** Turn a page; past a chunk's edge, lay out the neighbouring chunk. */
  async function turn(direction: 1 | -1) {
    const value = chunk();
    if (!value || restoring || editing()) return;
    userScroll = true; suppressed = false; lastTurn = performance.now();
    setSelection(null); setCursor(null);
    const next = pageIndex() + direction;
    if (next >= 0 && next < pageCount()) applyPage(next);
    else {
      const ordinal = direction > 0 ? value.last + 1 : value.first - 1;
      if (ordinal < 0 || ordinal >= total()) return;
      const token = ++jumpVersion, epoch = generation;
      restoring = true;
      try { await showPassage({ ordinal, offset: 0 }, () => disposed || epoch !== generation || token !== jumpVersion, direction < 0 ? 'last' : undefined); }
      finally { if (token === jumpVersion) restoring = false; }
    }
    pageAnchor = firstOnPage() ?? pageAnchor;
    report();
    clearTimeout(positionTimer);
    positionTimer = window.setTimeout(() => { void savePosition(); }, 2000);
  }

  /** Swipe sideways to turn; on a touch screen a tap in the outer sixth of the page turns too. */
  function pagePointerUp(event: PointerEvent) {
    const start = pointerStart;
    pointerStart = null;
    if (!start?.touch || !frame || window.getSelection()?.isCollapsed === false) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) { void turn(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8 || event.target instanceof Element && event.target.closest('button, a, .reader-highlight')) return;
    const rect = frame.getBoundingClientRect(), x = event.clientX - rect.left;
    if (x < rect.width / 6) void turn(-1);
    else if (x > rect.width * 5 / 6) void turn(1);
  }

  function pageWheel(event: WheelEvent) {
    const now = performance.now();
    if (now - lastWheel > 300) wheelTotal = 0;
    lastWheel = now;
    wheelTotal += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(wheelTotal) < 40 || now - lastTurn < 400) return;
    const direction = wheelTotal > 0 ? 1 : -1;
    wheelTotal = 0;
    void turn(direction);
  }

  async function jump(ordinal: number, offset = 0) {
    const token = ++jumpVersion, epoch = generation;
    restoring = true; userScroll = false; clearTimeout(positionTimer); setSelection(null);
    keyboardVersion++; setCursor(null);
    const index = Math.max(0, Math.min(ordinal, total() - 1));
    await loadPage(index);
    if (disposed || epoch !== generation || token !== jumpVersion || !total()) return;
    if (paged()) {
      pageAnchor = { ordinal: index, offset: 0 };
      await showPassage(pageAnchor, () => disposed || epoch !== generation || token !== jumpVersion);
      if (disposed || epoch !== generation || token !== jumpVersion) return;
      restoring = false;
      report();
      return;
    }
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
    if (scroll.classList.contains('reader-paged')) {
      if (!frame?.isConnected) return null;
      // The first passage that starts on the page. Restoring a passage turns to the page holding its start, so
      // reporting one begun on an earlier page would walk back a page at every reopen. A passage that fills the
      // page counts only when none starts there.
      const view = frame.getBoundingClientRect();
      let spanning: number | null = null;
      for (const row of frame.querySelectorAll<HTMLElement>('[data-passage-id]')) {
        const rects = [...row.getClientRects()].filter(rect => rect.width);
        if (!rects.length) continue;
        if (rects[0]!.left >= view.right - 1) break;
        if (rects[0]!.left > view.left - 1) return { ordinal: Number(row.dataset.ordinal), offset: 0 };
        if (rects.some(rect => rect.right > view.left + 1)) spanning ??= Number(row.dataset.ordinal);
      }
      return spanning === null ? null : { ordinal: spanning, offset: 0 };
    }
    const viewport = scroll.getBoundingClientRect();
    let first: { ordinal: number; offset: number } | null = null;
    for (const row of scroll.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const rect = row.getBoundingClientRect(), ordinal = Number(row.dataset.ordinal);
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      if (!first || ordinal < first.ordinal) first = { ordinal, offset: rect.top - viewport.top };
    }
    return first;
  }

  function report() {
    if (disposed || restoring) return;
    const range = visibleRange();
    if (range) {
      setFirstVisible(range.ordinal);
      props.onViewChange({ snapshotId: snapshot(), ordinal: range.ordinal, offset: range.offset });
    }
  }

  async function savePosition() {
    const range = visibleRange(), id = snapshot();
    if (!range || disposed || restoring || suppressed || !userScroll) return;
    try { await api.readingPosition(id, range.ordinal, requests.signal); }
    catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function scrolled() {
    if (restoring) return;
    if (!reportTimer) reportTimer = window.setTimeout(() => { reportTimer = 0; report(); }, 120);
    if (suppressed && userScroll && Math.abs(scroll.scrollTop - jumpOrigin) > scroll.clientHeight) suppressed = false;
    clearTimeout(positionTimer);
    if (!suppressed && userScroll) positionTimer = window.setTimeout(() => { void savePosition(); }, 2000);
    if (!editing() && !rewritingSelection) setSelection(null);
  }

  createEffect(() => {
    if (paged()) return;
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
      const { items, Header } = await actions(row, `“${row.citation.quote}” — ${row.source_title}, ${highlightLocation(row.citation, sections())}`);
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, items, Header });
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function openHighlightNote(row: HighlightRow) {
    try {
      const menu = await actions(row);
      if (!disposed) menu.openNote();
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
    if (editing() || rewritingSelection || popup()?.kind === 'actions') return;
    const dom = window.getSelection();
    const value = dom && selectionInPassages(scroll, dom, [...passages.values()]);
    setSelection(value && dom!.rangeCount ? { ...value, rect: dom!.getRangeAt(0).getBoundingClientRect(), snapshotId: snapshot() } : null);
    setEditError('');
  }

  /** The quotation with the sentence before and after it, from loaded prose passages. */
  function noteDraft(value: PassageSelection, noteId: string): HighlightNoteDraft {
    const first = passages.get(value.first)!, last = passages.get(value.last)!;
    const neighbour = (ordinal: number) => { const passage = passages.get(ordinal); return passage && prose[passage.kind] ? passage.text : ''; };
    const before = first.text.slice(0, value.start.offset), after = last.text.slice(value.end.offset);
    return {
      sourceId: props.target.sourceId, noteId, title: title(), byline: byline(),
      section: sectionAt(value.first)?.title ?? '', progress: share(value.first), quote: value.quote,
      before: leadIn(before.trim() ? before : neighbour(value.first - 1)), after: followOn(after.trim() ? after : neighbour(value.last + 1)),
    };
  }

  async function prepareMerges(value?: SelectionToolbar, color: Citation['color'] = null) {
    await documentReady(readerDocument);
    await readerDocument.flush();
    const sourceId = props.target.sourceId;
    const rows = (await api.highlights({ source_id: sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, requests.signal)).rows
      .filter(row => !value || row.citation.snapshot_id === value.snapshotId);
    const points = new Map<string, number>();
    for (const row of rows) {
      points.set(row.citation.start.passage_id, row.citation.ordinal);
      if (!points.has(row.citation.end.passage_id)) {
        const ordinal = await api.locate(row.citation.snapshot_id, row.citation.end.passage_id, requests.signal);
        if (ordinal === null) throw new Error('Passage not found.');
        points.set(row.citation.end.passage_id, ordinal);
      }
    }
    if (value) { points.set(value.start.passage_id, value.first); points.set(value.end.passage_id, value.last); }
    const groups = overlappingHighlights(rows, points, value ? { snapshot_id: value.snapshotId, start: value.start, end: value.end } : undefined);
    const merges: { citation: Citation; removeIds: string[]; removeCitationIds: string[] }[] = [];
    let selectedRange = value, kept = 0, removed = 0;
    for (const group of groups) {
      const referenced = new Set<string>();
      for (const row of group.rows) if (row.block.block.page_id === sourceId
        && (await api.backlinks(row.block.block.id, 1, requests.signal)).length) referenced.add(row.block.block.id);
      const members = mergeMembers(group, sourceId, referenced, color);
      kept += members.kept.length;
      const snapshotId = group.rows[0]?.citation.snapshot_id ?? value!.snapshotId;
      const first = points.get(group.start.passage_id)!, last = points.get(group.end.passage_id)!;
      const evidence: Passage[] = [];
      for (let from = first; from <= last; from += PAGE_SIZE) {
        evidence.push(...(await api.passages(snapshotId, from, Math.min(PAGE_SIZE, last - from + 1), requests.signal)).passages);
      }
      const quote = evidence.map(passage => passage.text.slice(passage.id === group.start.passage_id ? group.start.offset : 0, passage.id === group.end.passage_id ? group.end.offset : passage.text.length)).join('\n\n');
      const range = { start: group.start, end: group.end, quote, locator: evidence[0]!.locator, ordinal: first };
      if (value) selectedRange = { ...value, ...range, first, last };
      if (!members.survivor) continue;
      const previous = members.survivor.citation;
      merges.push({ citation: { ...previous, ...range, color: members.color },
        removeIds: [...new Set(members.removed.filter(row => row.block.block.id !== previous.block_id).map(row => row.block.block.id))],
        removeCitationIds: members.removed.filter(row => row.block.block.id === previous.block_id).map(row => row.citation.id),
      });
      removed += members.removed.length;
    }
    return { merges, selectedRange, removed, kept };
  }

  async function mergeOverlapping() {
    if (editing()) return;
    setEditing(true); setMergeMessage(''); setError('');
    try {
      const plan = await prepareMerges();
      if (plan.merges.length) {
        const result = readerDocument.edit({ kind: 'mergeHighlights', merges: plan.merges });
        if (!result.ok) throw new Error(result.reason);
        await readerDocument.flush();
      }
      setMergeMessage(`${plan.removed ? `Merged ${plan.removed} highlights` : 'No overlapping highlights'}${plan.kept ? `; ${plan.kept} cited elsewhere kept` : ''}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setEditing(false); }
  }

  async function highlight(withNote: boolean, color: Citation['color'] = null) {
    const value = selection();
    if (!value || editing()) return;
    setEditing(true); setEditError('');
    const sourceId = props.target.sourceId, doc = readerDocument;
    try {
      const plan = await prepareMerges(value, color), range = plan.selectedRange!;
      const result = plan.merges.length ? doc.edit({ kind: 'mergeHighlights', merges: plan.merges, note: withNote })
        : doc.edit({ kind: 'highlight', parentId: sourceId, text: range.quote, color, note: withNote, citation: {
          id: ulid(), sourceId, snapshotId: range.snapshotId, start: range.start, end: range.end, quote: range.quote, locator: range.locator, ordinal: range.first,
        } });
      if (!result.ok) { setEditError(result.reason); return; }
      const highlightId = plan.merges[0]?.citation.block_id ?? result.created[0]!;
      await doc.flush();
      if (!disposed) {
        setSelection(null); window.getSelection()?.removeAllRanges();
        if (withNote && coarsePointer.matches) setComposing(noteDraft(value, result.created.at(-1)!));
        else if (withNote) props.onOpen({ kind: 'page', pageId: sourceId, blockId: highlightId, caretId: result.created.at(-1) }, true);
      }
    } catch (reason) { if (!disposed) setEditError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setEditing(false); }
  }

  function readerKeyBlocked(event: KeyboardEvent, shifted = false) {
    if (!props.active || loading() || popup() || editing() || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return true;
    if (event.shiftKey && !shifted && event.key !== '{' && event.key !== '}') return true;
    const target = event.target;
    return target instanceof Element && (!!target.closest('input, textarea') || target instanceof HTMLElement && target.isContentEditable);
  }

  function visibleCursor() {
    if (cursor() !== null) return cursor()!;
    if (scroll.classList.contains('reader-paged')) return visibleRange()?.ordinal ?? 0;
    const viewport = scroll.getBoundingClientRect();
    for (const row of scroll.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const top = row.getBoundingClientRect().top;
      if (top >= viewport.top && top < viewport.bottom) return Number(row.dataset.ordinal);
    }
    return visibleRange()?.ordinal ?? 0;
  }

  async function moveCursor(direction: number) {
    if (!total()) return;
    const ordinal = Math.max(0, Math.min(total() - 1, visibleCursor() + direction)), epoch = generation, token = keyboardVersion;
    setCursor(ordinal);
    await loadPage(ordinal);
    if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
    userScroll = true;
    if (paged()) await revealPassage(ordinal);
    else virtualizer.scrollToIndex(ordinal, { align: 'auto' });
  }

  async function writeSelection(range: SentenceSelection) {
    const first = ordinals.get(range.start.passage_id), last = ordinals.get(range.end.passage_id), epoch = generation, token = keyboardVersion;
    if (first === undefined || last === undefined) return;
    rewritingSelection = true;
    setKeyboardRange({ first, last });
    try {
      // Keep both endpoints mounted while scrolling to the new selection end.
      for (let frame = 0; frame < 3; frame++) {
        if (paged()) await revealPassage(last);
        else virtualizer.scrollToIndex(last, { align: 'auto' });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
      }
      const rows = [...scroll.querySelectorAll<HTMLElement>('[data-passage-id]')];
      const startRow = rows.find(row => row.dataset.passageId === range.start.passage_id);
      const endRow = rows.find(row => row.dataset.passageId === range.end.passage_id);
      const start = startRow && passageNode(startRow, range.start.offset), end = endRow && passageNode(endRow, range.end.offset);
      const dom = window.getSelection();
      if (!start || !end || !dom) return;
      const value = document.createRange();
      value.setStart(start.node, start.offset); value.setEnd(end.node, end.offset);
      dom.removeAllRanges(); dom.addRange(value);
      rewritingSelection = false;
      selected();
    } finally {
      rewritingSelection = false;
      setKeyboardRange(null);
    }
  }

  async function selectSentence() {
    const ordinal = visibleCursor(), epoch = generation, token = keyboardVersion;
    setCursor(ordinal);
    await loadPage(ordinal);
    if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
    const passage = passages.get(ordinal), range = passage && sentenceAt(passage.text, 0);
    if (passage && range) await writeSelection({ start: { passage_id: passage.id, offset: range.start }, end: { passage_id: passage.id, offset: range.end } });
  }

  async function resizeSelection(extend: boolean, unit: SelectionUnit) {
    const value = selection(), epoch = generation, token = keyboardVersion;
    if (!value) return;
    const ordered: Passage[] = [];
    for (let ordinal = value.first; ordinal <= value.last; ordinal++) {
      const passage = passages.get(ordinal);
      if (!passage) return;
      ordered.push(passage);
    }
    let range = extend ? extendSelection(value, ordered, unit) : shrinkSelection(value, ordered, unit);
    for (let ordinal = value.last + 1; extend && range === value && ordinal < total(); ordinal++) {
      await loadPage(ordinal);
      const current = selection();
      if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup() || current?.first !== value.first || current.last !== value.last || current.start.offset !== value.start.offset || current.end.offset !== value.end.offset) return;
      const passage = passages.get(ordinal);
      if (!passage) return;
      ordered.push(passage);
      range = extendSelection(value, ordered, unit);
    }
    if (range !== value) await writeSelection(range);
  }

  const readerActions = createMemo<MenuItem[]>(() => {
    const needsSelection = selection() ? undefined : 'Select text first';
    return [
      { label: 'Open source page', icon: 'page', shortcut: 'Shift beside', action: () => props.onOpen({ kind: 'page', pageId: props.target.sourceId }, shiftPressed) },
      { label: 'Merge overlapping highlights', icon: 'highlight', disabledReason: editing() ? 'Saving…' : undefined, action: () => { void mergeOverlapping(); } },
      { label: 'Next passage', section: 'Keyboard', shortcut: 'J', action: () => { void moveCursor(1); } },
      { label: 'Previous passage', shortcut: 'K', action: () => { void moveCursor(-1); } },
      { label: 'Select sentence', shortcut: 'S', action: () => { void selectSentence(); } },
      { label: 'Extend by sentence', shortcut: ']', disabledReason: needsSelection, action: () => { void resizeSelection(true, 'sentence'); } },
      { label: 'Shrink by sentence', shortcut: '[', disabledReason: needsSelection, action: () => { void resizeSelection(false, 'sentence'); } },
      { label: 'Extend by passage', shortcut: '}', disabledReason: needsSelection, action: () => { void resizeSelection(true, 'passage'); } },
      { label: 'Shrink by passage', shortcut: '{', disabledReason: needsSelection, action: () => { void resizeSelection(false, 'passage'); } },
      { label: 'Highlight', shortcut: 'H', disabledReason: needsSelection, action: () => { void highlight(false); } },
      { label: 'Highlight and note', shortcut: 'N', disabledReason: needsSelection, action: () => { void highlight(true); } },
      { label: props.immersive ? 'Exit full screen' : 'Full screen', shortcut: 'F', action: () => props.onImmersive(!props.immersive) },
    ];
  });
  const trackShift = (event: KeyboardEvent | PointerEvent) => { shiftPressed = event.shiftKey; };

  const readerKey = (event: KeyboardEvent) => {
    if (props.active && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.shiftKey) readerDocument.redo(); else readerDocument.undo();
      void readerDocument.flush().catch(reason => setError(String(reason)));
      return;
    }
    const turnBy = pageTurns[event.key];
    if (turnBy && paged() && !readerKeyBlocked(event, event.key === ' ') && window.getSelection()?.isCollapsed !== false) {
      event.preventDefault(); event.stopImmediatePropagation();
      void turn(event.key === ' ' && event.shiftKey ? -1 : turnBy);
      return;
    }
    if (readerKeyBlocked(event)) return;
    // Escape first clears a selection (selectionKey prevents it); the next one leaves full screen.
    if (event.key === 'f' || event.key === 'Escape' && props.immersive && !event.defaultPrevented && !selection() && window.getSelection()?.isCollapsed !== false) {
      event.preventDefault(); event.stopImmediatePropagation();
      props.onImmersive(event.key === 'f' ? !props.immersive : false);
      return;
    }
    const key = event.key, moving = key === 'j' || key === 'k' || key === 's', resizing = '][}{'.includes(key) && key.length === 1;
    if (!moving && !resizing || moving && selection() || resizing && !selection() && !keyboardPending) return;
    if (moving && !window.getSelection()?.isCollapsed) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const epoch = generation, token = keyboardVersion;
    keyboardPending++;
    keyboardQueue = keyboardQueue.then(async () => {
      if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup() || editing()) return;
      if (key === 's' && !selection()) await selectSentence();
      else if ((key === 'j' || key === 'k') && !selection()) await moveCursor(key === 'j' ? 1 : -1);
      else if (resizing && selection()) await resizeSelection(key === ']' || key === '}', key === ']' || key === '[' ? 'sentence' : 'passage');
    }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { keyboardPending--; });
  };

  const selectionKey = (event: KeyboardEvent) => {
    if (readerKeyBlocked(event) || !selection() && !keyboardPending) return;
    const key = event.key.toLowerCase();
    const color = /^[1-5]$/.test(key) ? highlightColors[Number(key) - 1] : undefined;
    if (key === 'h' || key === 'n' || color) {
      event.preventDefault(); event.stopImmediatePropagation();
      const epoch = generation, token = keyboardVersion;
      keyboardQueue = keyboardQueue.then(async () => {
        if (!disposed && epoch === generation && token === keyboardVersion && props.active && !popup()) await highlight(key === 'n', color);
      });
    }
    else if (event.key === 'Escape') { event.preventDefault(); keyboardVersion++; setSelection(null); window.getSelection()?.removeAllRanges(); }
  };

  onMount(() => {
    document.addEventListener('selectionchange', selected);
    document.addEventListener('keydown', selectionKey, true);
    document.addEventListener('keydown', readerKey, true);
    document.addEventListener('keydown', trackShift, true);
    document.addEventListener('keyup', trackShift, true);
    document.addEventListener('pointerdown', trackShift, true);
    // Folding, unfolding and the sidebar change the page; keep the passage being read in view.
    let pageSize = '', resizeFrame = 0;
    const resizer = new ResizeObserver(() => {
      // A hidden or collapsing pane has no page to lay out; wait for its real size.
      if (!scroll.clientWidth || !scroll.clientHeight) return;
      const size = `${scroll.clientWidth}x${scroll.clientHeight}`;
      if (size === pageSize) return;
      pageSize = size;
      if (!paged() || loading() || !chunk()) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { void relayoutPages(); });
    });
    resizer.observe(scroll);
    // Reader settings change the measure without resizing the pane.
    const marginFitter = new ResizeObserver(fitMargin);
    marginFitter.observe(scroll); marginFitter.observe(probe);
    onCleanup(() => marginFitter.disconnect());
    onCleanup(() => { resizer.disconnect(); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(countFrame); });
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
      await jump(ordinal, ordinal === 0 && initialView.ordinal < 0 && !target.at && !citation ? titleHeight() : target.at || citation || initialView.ordinal < 0 ? 0 : initialView.offset);
      if (citation) flashTimer = window.setTimeout(() => setFlash(null), 1500);
      setLoading(false);
    })().catch(reason => { if (!disposed) { restoring = false; setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); } });
  });
  onCleanup(() => {
    disposed = true; requests.abort();
    readerDocument.release();
    setLinkedCitation(null);
    clearTimeout(reportTimer); clearTimeout(positionTimer); clearTimeout(flashTimer);
    document.removeEventListener('selectionchange', selected);
    document.removeEventListener('keydown', selectionKey, true);
    document.removeEventListener('keydown', readerKey, true);
    document.removeEventListener('keydown', trackShift, true);
    document.removeEventListener('keyup', trackShift, true);
    document.removeEventListener('pointerdown', trackShift, true);
  });

  function PassageContent(row: { ordinal: number; onImageLoad(): void }) {
    const passage = createMemo(() => { version(); return passages.get(row.ordinal); });
    return <Show when={passage()} fallback={<div class="reader-placeholder" aria-hidden="true" />}>{value => <Dynamic
      component={value().kind === 'heading' ? `h${Math.min(3, Math.max(1, value().level ?? 1))}` : value().kind === 'quote' ? 'blockquote' : value().kind === 'code' ? 'pre' : 'div'}
      class={`reader-passage reader-${value().kind}`} classList={{ 'reader-cursor': props.active && cursor() === row.ordinal }} aria-current={props.active && cursor() === row.ordinal ? 'true' : undefined}
      data-passage-id={value().id} data-ordinal={value().ordinal} style={{ '--level': Math.max(0, value().level ?? 0) }}>
      <Show when={value().kind === 'image' && value().resource} fallback={<PassageText passage={value()} citations={citations()} notes={highlightNotes()} ordinals={(() => { version(); return ordinals; })()} flashId={flash()?.id ?? null} onLocate={at => { void jumpTo(at); }} onNote={(at, anchor) => { void note(at, anchor); }} onCitation={clickedCitation} onHighlightNote={row => { void openHighlightNote(row); }} />}>
        <ResourceImage snapshotId={snapshot()} href={value().resource!} alt={value().text} onLoad={row.onImageLoad} />
      </Show>
    </Dynamic>}</Show>;
  }

  function PassageRow(row: { ordinal: number; item: () => VirtualItem }) {
    let element!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(element));
    return <div ref={element} class="reader-row" data-index={row.ordinal} style={{ transform: `translateY(${row.item().start}px)` }}>
      <PassageContent ordinal={row.ordinal} onImageLoad={() => virtualizer.measureElement(element)} />
    </div>;
  }

  function TitleBlock() {
    let element!: HTMLDivElement;
    onMount(() => {
      const measure = () => setTitleHeight(element.getBoundingClientRect().height);
      const observer = new ResizeObserver(measure);
      measure(); observer.observe(element);
      onCleanup(() => { observer.disconnect(); setTitleHeight(0); });
    });
    return <div ref={element} class="reader-title-block">
      <h1>{title()}</h1>
      <Show when={byline()}><p>{byline()}</p></Show>
    </div>;
  }

  function SelectionTools() {
    let element!: HTMLDivElement;
    const [placement, setPlacement] = createSignal({ left: 0, top: 0, width: 0, visible: false });
    const place = () => {
      const value = selection();
      if (!element || !value) return;
      const viewport = scroll.getBoundingClientRect();
      const left = Math.max(0, viewport.left), right = Math.min(window.innerWidth, viewport.right);
      const top = Math.max(0, viewport.top), bottom = Math.min(window.innerHeight, viewport.bottom);
      const gap = parseFloat(getComputedStyle(element).getPropertyValue('--space-4'));
      const width = Math.min(element.offsetWidth, right - left), height = element.offsetHeight;
      const above = value.rect.top - height - gap;
      setPlacement({
        left: Math.max(left, Math.min((value.rect.left + value.rect.right - width) / 2, right - width)),
        top: Math.max(top, Math.min(above < top ? value.rect.bottom + gap : above, bottom - height)),
        width: right - left, visible: true,
      });
    };
    createEffect(place);
    onMount(() => {
      const observer = new ResizeObserver(place);
      observer.observe(element); observer.observe(scroll);
      place();
      onCleanup(() => observer.disconnect());
    });
    return <Portal><div ref={element} class="reader-selection-toolbar" role="toolbar" aria-label="Highlight selection"
      style={{ left: `${placement().left}px`, top: `${placement().top}px`, 'max-width': `${placement().width}px`, visibility: placement().visible ? 'visible' : 'hidden' }}
      onPointerDown={event => event.preventDefault()}>
      <div class="reader-selection-actions"><Button icon="highlight" disabled={editing()} onClick={() => { void highlight(false); }}>Highlight <kbd>H</kbd></Button><Button disabled={editing()} onClick={() => { void highlight(true); }}>Highlight and note <kbd>N</kbd></Button></div>
      <div class="reader-selection-actions"><For each={highlightColors}>{(color, index) => <Button aria-label={`Highlight ${color}`} title={`Highlight ${color} (${index() + 1})`} disabled={editing()} onClick={() => { void highlight(false, color); }}><span class={`highlight-color-dot highlight-color-${color}`} aria-hidden="true" /><kbd>{index() + 1}</kbd></Button>}</For></div>
      <Show when={editError()}><p class="error" role="alert">{editError()}</p></Show>
    </div></Portal>;
  }

  return <div class="reader-pane" style={readerStyle()} onPointerDown={props.onActivate} onFocusIn={props.onActivate}>
    <div class="reader-header">
      <Button class="reader-contents" icon="contents" label="Contents" aria-haspopup="dialog" disabled={!contents().length} onClick={event => { setQuery(''); setPopup({ kind: 'contents', anchor: event.currentTarget }); }}><span>{currentSection()?.title ?? 'Contents'}</span><Icon name="down" /></Button>
      <Button icon="highlight" label="Highlights" aria-haspopup="dialog" disabled={!snapshot()} onClick={event => { setQuery(''); setPopup({ kind: 'highlights', anchor: event.currentTarget }); }}><Show when={sourceHighlights().length}><span>{sourceHighlights().length}</span></Show></Button>
      <Button icon="search" label="Find in source" aria-haspopup="dialog" disabled={!snapshot()} onClick={event => { setQuery(''); setPopup({ kind: 'find', anchor: event.currentTarget }); }} />
      <span class="reader-progress" aria-label="Reading position">{formatProgress(position())}</span>
      <Button label="Reader settings" aria-haspopup="dialog" onClick={event => setPopup({ kind: 'settings', anchor: event.currentTarget })}>Aa</Button>
      <Button icon={props.immersive ? 'contract' : 'expand'} label={props.immersive ? 'Exit full screen' : 'Full screen'} shortcut={props.immersive ? 'F or Esc' : 'F'} onClick={() => props.onImmersive(!props.immersive)} />
      <Button icon="more" label="Reader actions" aria-haspopup="menu" onPointerDown={event => event.preventDefault()} onClick={event => setPopup({ kind: 'actions', anchor: event.currentTarget })} />
    </div>
    <div class="reader-progress-rule" aria-hidden="true"><span style={{ width: `${position() * 100}%` }} /></div>
    <Show when={error()}><p class="reader-error error" role="alert">{error()}</p></Show>
    <Show when={loading()}><p class="reader-status" role="status">Loading…</p></Show>
    <Show when={mergeMessage()}><p class="reader-status" role="status">{mergeMessage()}</p></Show>
    <div class="reader-measure-probe" aria-hidden="true"><div ref={probe} /></div>
    <div class="reader-body" style={{ '--reader-text-width': `${textWidth() ?? 0}px` }}>
      <Show when={textWidth() !== null && contents().length}>
        <nav ref={margin} class="reader-margin" aria-label="Contents">
          <For each={contents()}>{entry => <Button class="reader-margin-entry" aria-current={entry === currentSection() ? 'location' : undefined} style={{ '--level': Math.max(0, entry.level - 1) }}
            onClick={() => { if (entry.ordinal !== null) void jump(entry.ordinal); else void jumpTo(entry.locator); }}>{entry.title}</Button>}</For>
        </nav>
      </Show>
      <div ref={scroll} class="reader-scroll" classList={{ 'reader-paged': paged() }} tabIndex={0} aria-label="Source passages" onScroll={scrolled}
        onWheel={() => { userScroll = true; }} onTouchMove={() => { userScroll = true; }} onPointerDown={() => { userScroll = true; }}
        onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) userScroll = true; }}>
        <Show when={paged()} fallback={<div class="reader-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <Show when={title()}><TitleBlock /></Show>
          <For each={[...items().keys()]}>{ordinal => <PassageRow ordinal={ordinal} item={() => items().get(ordinal)!} />}</For>
        </div>}>
          <div ref={frame} class="reader-page-frame" style={{ width: `${pageFrame().width}px` }} onWheel={pageWheel}
            onPointerDown={event => { pointerStart = { x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse' }; }}
            onPointerUp={pagePointerUp} onPointerCancel={() => { pointerStart = null; }}>
            <div class="reader-flow" style={{ 'column-count': pageFrame().columns, 'column-gap': `${PAGE_GAP}px` }}>
              <Show when={chunk()?.first === 0 && title()}><div class="reader-title-block reader-page-title">
                <h1>{title()}</h1>
                <Show when={byline()}><p>{byline()}</p></Show>
              </div></Show>
              <For each={chunkOrdinals()}>{ordinal => <PassageContent ordinal={ordinal} onImageLoad={scheduleCount} />}</For>
            </div>
          </div>
          <div class="reader-page-bar">
            <Button icon="left" label="Previous page" disabled={pageIndex() === 0 && !chunk()?.first} onClick={() => { void turn(-1); }} />
            <span>{pageIndex() + 1} / {pageCount()}</span>
            <Button icon="right" label="Next page" disabled={pageIndex() >= pageCount() - 1 && (chunk()?.last ?? 0) >= total() - 1} onClick={() => { void turn(1); }} />
          </div>
        </Show>
      </div>
    </div>
    <Show when={popup()}>{state => <>
      <Show when={state().kind === 'settings'}><ReaderSettingsPopup anchor={state().anchor} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'actions'}><Menu anchor={state().anchor} label="Reader actions" items={readerActions()} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'contents'}><Picker class="reader-picker" anchor={state().anchor} label="Contents" placeholder="Find a section" query={query()} onQuery={setQuery} items={toc()} key={entry => entry.locator} initial={Math.max(0, toc().indexOf(currentSection()!))}
        row={entry => <span class="reader-toc-entry" aria-current={entry === currentSection() ? 'true' : undefined} style={{ '--level': Math.max(0, entry.level - 1) }}><span class="reader-toc-check"><Show when={entry === currentSection()}><Icon name="check" /></Show></span><span>{entry.title}</span></span>}
        onPick={entry => { setPopup(null); if (entry.ordinal !== null) void jump(entry.ordinal); else void jumpTo(entry.locator); }} empty="No sections" onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'highlights'}><Picker class="reader-picker" anchor={state().anchor} label="Highlights" placeholder="Find a highlight" query={query()} onQuery={setQuery} items={filteredHighlights()} key={row => row.citation.id}
        row={row => <div class="reader-highlight-entry"><span class={`highlight-color-dot highlight-color-${row.citation.color ?? 'none'}`} aria-hidden="true" /><span class="reader-highlight-quote">{row.citation.quote}</span><span class="reader-highlight-section">{highlightLocation(row.citation, sections())}</span></div>} busy={highlightsLoading()} error={highlightsError()} empty="No highlights"
        onPick={row => { void jumpHighlight(row.citation); }} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'menu'}><Menu anchor={state().anchor} label="Actions for highlight" items={(() => { const value = state(); return value.kind === 'menu' ? value.items : []; })()} header={(() => { const value = state(); return value.kind === 'menu' && value.Header ? <value.Header onDismiss={() => setPopup(null)} /> : undefined; })()} onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'find'}><Picker class="reader-picker" anchor={state().anchor} label="Find in source" placeholder="Find in source" query={query()} onQuery={setQuery} items={hits()} key={hit => `${hit.snapshot_id}:${hit.passage.id}`}
        status={<p class="reader-find-status" role="status">{hits().length === 40 ? 'First 40 passages' : `${hits().length} passages`}</p>}
        row={hit => <span class="reader-search-snippet"><For each={hit.snippet.replace(/^(?:\.\.\.|…)\s*/, '…').replace(/\s*(?:\.\.\.|…)$/, '…').split(/(\[[^\]]+\])/g)}>{part => part.startsWith('[') && part.endsWith(']') ? <mark class="reader-search-match">{part.slice(1, -1)}</mark> : part}</For></span>} busy={searching()} error={searchError()} empty={query().trim() ? 'No passages found' : 'Search this source'}
        onPick={hit => { setPopup(null); switchSnapshot(hit.snapshot_id); void jump(hit.passage.ordinal).catch(reason => { restoring = false; setError(reason instanceof Error ? reason.message : String(reason)); }); }}
        onDismiss={() => setPopup(null)} /></Show>
      <Show when={state().kind === 'note'}><Popup anchor={state().anchor} label="Footnote" class="reader-note" onDismiss={() => setPopup(null)}>
        <p>{(() => { const value = state(); return value.kind === 'note' ? value.loading ? 'Loading…' : value.text : ''; })()}</p>
      </Popup></Show>
    </>}</Show>
    <Show when={selection()}><SelectionTools /></Show>
    <Show when={composing()}>{draft => <HighlightComposer notebook={props.notebook} draft={draft()} onClose={() => setComposing(null)} />}</Show>
    <actions.TagPopup />
  </div>;
}
