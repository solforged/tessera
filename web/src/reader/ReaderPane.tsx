import { opensBeside, besideKey } from '../core/beside';
import {
  For,
  Show,
  batch,
  createComputed,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import { ulid } from 'ulid';
import type { Citation, HighlightRow, Passage, PassagePage, SourceView, TocEntry } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import type { OpenTarget, PaneId, ReaderViewState } from '../core/contract';
import { createRetained } from '../core/retained';
import { crossfade } from '../ui/pane-motion';
import { sourceMetadata } from '../library/details';
import { formatProgress, highlightLocation } from '../library/query';
import { createHighlightActions, highlightColors, setLinkedCitation } from '../library/highlights';
import type { HighlightMenu, HighlightSection } from '../library/highlights';
import { BookMap } from './BookMap';
import { bookChapters, chapterEntries } from './book-map';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { HighlightComposer } from './HighlightComposer';
import type { HighlightNoteDraft } from './HighlightComposer';
import { passageNode, selectionInPassages } from './passages';
import type { PassageSelection } from './passages';
import { extendSelection, followOn, leadIn, sentenceAt, shrinkSelection } from './sentences';
import type { SelectionUnit, SentenceSelection } from './sentences';
import { ReaderSettingsPopup, readerSettings, readerStyle } from './ReaderSettings';
import { ProgressCard } from './ProgressCard';
import { chapterAt, timeLeft } from './paged';
import {
  absorbedPassages,
  bookKeys,
  chapterOpenings,
  contentsTitle,
  isFrontMatter,
  isProseExcerpt,
  repeatsBook,
  sectionLabel,
  titlePageWords,
} from './openings';
import { mergeMembers, overlappingHighlights } from './highlight-merge';
import { NavButton, NavEnd, NavGroup, NavTitle } from '../ui/NavBar';
import { isPhone, matchesCoarsePointer, matchesTouchOnly } from '../ui/viewport';
import { Figures } from './Figures';
import { hideEditMenu, nativeEditMenu, onEditMenu, showEditMenu } from './edit-menu';
import { createReaderChrome, deferred } from './createReaderChrome';
import {
  characterRect,
  createPagedReader,
  cssValue,
  PagedFlow,
  pageTurns,
  passageText,
  type PageAnchor,
} from './PagedFlow';
import { createReaderSearch, ReaderSearchPopup, ReaderTocRow } from './ReaderSearchPopup';
import { ScrolledPassages, SectionLabel, type ReaderPassageView } from './ScrolledPassages';
import './reader.css';

export interface ReaderPaneProps {
  pane: PaneId;
  target: Extract<OpenTarget, { kind: 'reader' }>;
  view: ReaderViewState;
  workshop: WorkshopClient;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: ReaderViewState): void;
  /** The reader fills the app window, without the sidebar, rail or pane header. */
  immersive: boolean;
  onImmersive(immersive: boolean): void;
  /** Leaves the reader, as the system Back gesture does on the cover screen. */
  onBack(): void;
}

const PAGE_SIZE = 200;
type ReaderPopup =
  | { kind: 'contents' | 'find' | 'highlights' | 'settings' | 'actions' | 'progress'; anchor: HTMLElement }
  | { kind: 'note'; anchor: HTMLElement; text: string; loading: boolean; ordinal?: number; locator?: string }
  | { kind: 'menu'; anchor: HTMLElement; items: MenuItem[]; Header?: HighlightMenu['Header'] };
type SelectionToolbar = PassageSelection & { rect: DOMRect; rects: DOMRect[]; snapshotId: string };
const prose: Partial<Record<Passage['kind'], true>> = { paragraph: true, quote: true, list_item: true };

export function ReaderPane(props: ReaderPaneProps) {
  const api = props.workshop.api;
  const [source, setSource] = createSignal<SourceView>();
  const [snapshot, setSnapshot] = createSignal('');
  const [allContents, setContents] = createSignal<TocEntry[]>([]);
  const [total, setTotal] = createSignal(0);
  const [firstVisible, setFirstVisible] = createSignal(0);
  const [atEnd, setAtEnd] = createSignal(false);
  const [titleHeight, setTitleHeight] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<ReaderPopup | null>(null);
  const [noteReturn, setNoteReturn] = createSignal<{
    ordinal: number;
    offset: number;
    page: PageAnchor | null;
    passageId?: string;
    locator: string;
  } | null>(null);
  /** Where reading was before a jump from the contents, the book map, a highlight or a search; offered while the reading stays in the section it landed in. */
  const [jumpReturn, setJumpReturn] = createSignal<{
    ordinal: number;
    offset: number;
    page: PageAnchor | null;
    label: string;
    landing: number;
  } | null>(null);
  const [query, setQuery] = createSignal('');
  const { hits, searching, searchError, morePassages, loadSearchPage } = createReaderSearch({
    api,
    sourceId: () => props.target.sourceId,
    open: () => popup()?.kind === 'find',
    popupIdentity: popup,
    query,
  });
  const [selection, setSelection] = createSignal<SelectionToolbar | null>(null);
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [keyboardRange, setKeyboardRange] = createSignal<{ first: number; last: number } | null>(null);
  const [editError, setEditError] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [mergeMessage, setMergeMessage] = createSignal('');
  const [removedNotice, setRemovedNotice] = createSignal(false);
  const [noticeHeld, setNoticeHeld] = createSignal(false);
  createEffect(() => {
    if (!removedNotice() || noticeHeld()) return;
    const timer = setTimeout(() => setRemovedNotice(false), 8000);
    onCleanup(() => clearTimeout(timer));
  });
  const readerDocument = props.workshop.open(props.target.sourceId);
  // The source page is the record: renaming the book or editing its creators shows here at once. The snapshot keeps
  // what the file said at import, and stands in only until the page has loaded.
  const [fieldDefinitions] = createResource(() => props.workshop.api.fields());
  const details = createMemo(() => sourceMetadata(readerDocument, props.workshop, fieldDefinitions()?.fields ?? []));
  const title = () => details().title?.trim() || currentSnapshot()?.metadata.title || '';
  /** The book's title as the source page and the file record it. */
  const book = createMemo(() =>
    bookKeys(details().title, source()?.snapshots.find(value => value.id === snapshot())?.metadata.title),
  );
  /** Leave out running book titles and old inferred entries that only name a lone prose excerpt. */
  const contents = createMemo(() => {
    version();
    return allContents().filter(
      (entry, index, entries) =>
        !repeatsBook(entry, book()) &&
        !isProseExcerpt(entry, entry.ordinal === null ? undefined : passages.get(entry.ordinal), entries[index + 1]),
    );
  });
  const [flash, setFlash] = createSignal<Citation | null>(null);
  const [highlights, setHighlights] = createSignal<HighlightRow[]>([]);
  const [composing, setComposing] = createSignal<HighlightNoteDraft | null>(null);
  /** A new highlight, drawing itself under its words; a note's highlight draws once the note sheet has gone. */
  const [ink, setInk] = createSignal<string | null>(null);
  let inkTimer = 0,
    composedCitation = '';
  function drawInk(citationId: string) {
    clearTimeout(inkTimer);
    setInk(citationId);
    inkTimer = window.setTimeout(() => setInk(null), cssValue('--motion-ink') + cssValue('--motion-ui'));
  }
  const paged = () => readerSettings().layout === 'pages';
  /** The text column's width when the contents margin fits beside it, else null. */
  const [textWidth, setTextWidth] = createSignal<number | null>(null);
  const sections = createMemo(() =>
    contents()
      .filter((entry): entry is HighlightSection => entry.ordinal !== null)
      .sort((a, b) => a.ordinal - b.ordinal),
  );
  const [highlightsLoading, setHighlightsLoading] = createSignal(false);
  const [highlightsError, setHighlightsError] = createSignal('');
  const actions = createHighlightActions(
    props.workshop,
    props.onOpen,
    setError,
    undefined,
    () => {
      setNoticeHeld(false);
      setRemovedNotice(true);
    },
    composeNote,
  );
  const pages = new Map<number, PassagePage>();
  const passages = new Map<number, Passage>();
  const ordinals = new Map<string, number>();
  const pending = new Map<number, Promise<void>>();
  const locating = new Map<string, Promise<number | null>>();
  // Some books mark every paragraph as a quotation; when quotes outnumber plain paragraphs among the loaded passages, they are the body text and get no quote rule.
  const quotesAreText = createMemo(() => {
    version();
    let quotes = 0,
      plain = 0;
    for (const passage of passages.values()) {
      if (passage.kind === 'quote') quotes++;
      else if (passage.kind === 'paragraph') plain++;
    }
    return quotes >= 12 && quotes > plain;
  });
  let scroll!: HTMLDivElement, probe!: HTMLDivElement, header!: HTMLDivElement, margin: HTMLElement | undefined;
  let disposed = false,
    restoring = true,
    generation = 0,
    jumpVersion = 0;
  let suppressed = !!(props.target.at || props.target.citationId),
    jumpOrigin = 0,
    userScroll = false;
  let reportTimer = 0,
    positionTimer = 0,
    flashTimer = 0;
  let pendingPosition: { snapshotId: string; ordinal: number } | null = null;
  let keyboardQueue = Promise.resolve(),
    keyboardPending = 0,
    keyboardVersion = 0,
    rewritingSelection = false;
  let besidePressed = false;
  /** The tap that closes a popup or clears a selection does only that: no page turn, no chrome. */
  let dismissingTap = false;
  let settingsViewport: { ordinal: number; offset: number; character?: number } | null = null,
    settingsAtStart = false,
    settingsFromPages = false,
    settingsVersion = 0;
  const requests = new AbortController();
  let readerRoot!: HTMLDivElement;
  /** The cover screen's navigation bar: the pane header, which the reader's title and controls live in. */
  const navBar = () => readerRoot?.closest('.pane')?.querySelector<HTMLElement>(':scope > .pane-header') ?? null;

  const pagedReader = createPagedReader({
    pageSize: PAGE_SIZE,
    paged,
    version,
    total,
    sections,
    editing,
    disposed: () => disposed,
    generation: () => generation,
    nextJumpToken: () => ++jumpVersion,
    jumpVersion: () => jumpVersion,
    isRestoring: () => restoring,
    setRestoring: value => {
      restoring = value;
    },
    markUserTurn: () => {
      userScroll = true;
      suppressed = false;
    },
    clearSelectionAndCursor: () => {
      setSelection(null);
      setCursor(null);
    },
    dismissingTap: () => dismissingTap,
    toggleChrome: () => chrome.toggleChrome(),
    scroll: () => scroll,
    probe: () => probe,
    loadPage: from => loadPage(from),
    report: () => report(),
    schedulePosition: () => schedulePosition(),
  });
  const {
    chunk,
    setChunk,
    pageIndex,
    pageCount,
    pageFrame,
    chunkOrdinals,
    nextFrame,
    scheduleCount,
    firstOnPage,
    showPassage,
    relayoutPages,
    revealPassage,
    turn,
    readerPointerDown,
    readerPointerMove,
    readerPointerUp,
    readerPointerCancel,
    pageWheel,
  } = pagedReader;

  const chrome = createReaderChrome({
    active: () => props.active,
    immersive: () => props.immersive,
    loading,
    firstVisible,
    pageIndex,
    chunk,
    popupKind: () => popup()?.kind ?? null,
    closePopup: () => setPopup(null),
    hasSelection: () => !!selection(),
    header: () => header,
    navBar,
    onBack: () => props.onBack(),
  });
  const {
    coverReading,
    chromeHides,
    chromeOverlays,
    chromeHidden,
    showChrome,
    hideChrome,
    onHeaderFocusIn,
    pointerMoved,
  } = chrome;
  /** What a phone's nav bar covers at the top of the page (the page's `scroll-padding-top`): text passes under it, but a jump lands, and the reading point is taken, just below it. */
  const [topInset, setTopInset] = createSignal(0);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return total();
    },
    getScrollElement: () => scroll,
    estimateSize: () => 112,
    overscan: 8,
    // Row measurements can mount and resize other observed rows. Deliver them after the resize cycle.
    useAnimationFrameWithResizeObserver: true,
    get paddingStart() {
      return titleHeight();
    },
    get scrollPaddingStart() {
      return topInset();
    },
    get rangeExtractor() {
      const selected = keyboardRange() ?? selection(),
        current = cursor();
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = defaultRangeExtractor(range);
        if (selected) for (let i = selected.first; i <= selected.last; i++) if (!indices.includes(i)) indices.push(i);
        if (current !== null && !indices.includes(current)) indices.push(current);
        return indices.sort((a, b) => a - b);
      };
    },
  });
  const items = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [item.index, item])));
  createEffect(() => {
    coverReading();
    const element = scroll;
    if (!element) return;
    const measure = () => setTopInset(parseFloat(getComputedStyle(element).scrollPaddingTop) || 0);
    measure();
    const later = deferred(measure);
    const observer = new ResizeObserver(later);
    observer.observe(element);
    onCleanup(() => {
      observer.disconnect();
      later.cancel();
    });
  });
  const citations = createMemo(() => {
    version();
    const values = new Map<string, Citation>();
    for (const page of pages.values()) for (const citation of page.citations) values.set(citation.id, citation);
    const flashed = flash();
    if (flashed) values.set(flashed.id, flashed);
    return [...values.values()];
  });
  const toc = createMemo(() =>
    contents().filter(entry => entry.title.toLocaleLowerCase().includes(query().toLocaleLowerCase())),
  );
  const currentSnapshot = createMemo(() => source()?.snapshots.find(value => value.id === snapshot()));
  const sectionAt = (ordinal: number) => {
    const entries = sections();
    for (let index = entries.length - 1; index >= 0; index--)
      if (entries[index]!.ordinal <= ordinal) return entries[index];
    return undefined;
  };
  const currentSection = createMemo(() => sectionAt(firstVisible()));
  /** A passage's place as a share of the text, the same measure the library and source page show. */
  const share = (ordinal: number) => {
    const length = currentSnapshot()?.text_length ?? 0;
    return length ? (passages.get(ordinal)?.start ?? 0) / length : 0;
  };
  /** At the scroll boundary the whole text is read, not just the first passage still visible above it. */
  const here = createMemo(() => {
    version();
    return atEnd() ? (currentSnapshot()?.text_length ?? 0) : (passages.get(firstVisible())?.start ?? 0);
  });
  /** The reading position. */
  const position = createMemo(() => here() / (currentSnapshot()?.text_length || 1));
  /** The book as a map of chapters by character offset, the reading point on it and the highlights along it. */
  const mapChapters = createMemo(() => bookChapters(contents(), currentSnapshot()?.text_length ?? 0));
  /** The chapter being read, as paged reading and the book map count chapters (`chapterEntries`). */
  const chapter = createMemo(() => chapterAt(sections(), total(), atEnd() ? total() - 1 : firstVisible()));
  /** Characters left in the chapter and in the text; null until known. */
  const chapterLeft = createMemo(() => {
    version();
    const end = chapter().end;
    const until = end >= total() ? currentSnapshot()?.text_length : passages.get(end)?.start;
    return until === undefined ? null : Math.max(0, until - here());
  });
  const bookLeft = createMemo(() => {
    const length = currentSnapshot()?.text_length;
    return !length ? null : Math.max(0, length - here());
  });
  // The next chapter's first passage says where this one ends.
  createEffect(() => {
    const end = chapter().end;
    if (end < total() && !passages.has(end)) void loadPage(end);
  });
  /** The chapter's own entry: the deepest one starting it, so a chapter that opens a part names the chapter. */
  const chapterEntry = createMemo(() =>
    chapterEntries(sections())
      .filter(entry => entry.ordinal === chapter().first)
      .reduce<HighlightSection | undefined>(
        (deepest, entry) => (!deepest || entry.level > deepest.level ? entry : deepest),
        undefined,
      ),
  );
  /** How the foot and running head name the chapter: nothing in front matter or before the first chapter. */
  const chapterName = createMemo(() => {
    const entry = chapterEntry();
    return entry && !isFrontMatter(entry.title) ? sectionLabel(entry.title) : '';
  });
  /** Where each contents entry's own stretch ends (at the next entry), and where it and everything under it ends. */
  const tocSpans = createMemo(() => {
    const entries = contents(),
      length = currentSnapshot()?.text_length ?? 0,
      spans = new Map<TocEntry, { end: number; subtree: number }>();
    entries.forEach((entry, index) => {
      if (entry.start === undefined) return;
      let end: number | undefined, subtree: number | undefined;
      for (let next = index + 1; next < entries.length && subtree === undefined; next++) {
        const value = entries[next]!;
        if (value.start === undefined || value.start <= entry.start) continue;
        end ??= value.start;
        if (value.level <= entry.level) subtree = value.start;
      }
      spans.set(entry, { end: end ?? length, subtree: subtree ?? length });
    });
    return spans;
  });
  /** What the phone says of time: left in the book under its title, left in the chapter under the chapter's name (the book where there are no chapters). */
  const bookTime = () => (bookLeft() === null ? '' : atEnd() ? 'Finished' : `${timeLeft(bookLeft()!)} left in book`);
  const whereTime = () =>
    atEnd()
      ? 'Finished'
      : chapterName() && chapterLeft() !== null
        ? `${timeLeft(chapterLeft()!)} left in chapter`
        : bookTime();
  /** Chapter openings by first passage, composed from the contents rather than the file's heading markup. */
  const openings = createMemo(() => chapterOpenings(contents(), book()));
  /** The cover beside the title page: the one on the source page, else the file's. */
  const titleCover = () => details().cover ?? currentSnapshot()?.metadata.cover ?? null;
  /**
   * Heading lines the openings draw instead, running heads that repeat the book's title, and the file's cover image
   * where the title page shows it; and each chapter's first passage of text. A highlight endpoint always shows.
   */
  const absorbed = createMemo(() => {
    version();
    const highlighted = new Set<number>(),
      titleHighlighted = new Set<number>();
    for (const citation of citations()) {
      const from = ordinals.get(citation.start.passage_id),
        to = ordinals.get(citation.end.passage_id);
      if (from !== undefined) highlighted.add(from);
      if (to !== undefined) highlighted.add(to);
      for (const ordinal of passages.keys())
        if (ordinal >= (from ?? citation.ordinal) && ordinal <= (to ?? total() - 1)) titleHighlighted.add(ordinal);
    }
    const titleEntries = allContents().flatMap(entry =>
      entry.ordinal !== null && repeatsBook(entry, book()) ? [entry.ordinal] : [],
    );
    const metadata = currentSnapshot()?.metadata,
      page = details();
    const result = absorbedPassages(
      openings(),
      titleEntries,
      ordinal => passages.get(ordinal),
      ordinal => highlighted.has(ordinal),
      book(),
      {
        contents: allContents(),
        total: total(),
        highlighted: titleHighlighted,
        quotesAreText: quotesAreText(),
        cover: title() && titleCover() ? (metadata?.cover ?? null) : null,
        words: titlePageWords(
          page.title,
          metadata?.title,
          page.subtitle,
          metadata?.subtitle,
          page.publisher,
          metadata?.publisher,
          ...page.creators.map(creator => creator.name),
          ...(metadata?.creators ?? []).map(creator => creator.name),
        ),
      },
    );
    return result;
  });
  const creators = createMemo(() => {
    const metadata = currentSnapshot()?.metadata,
      page = details();
    return (
      page.creators.length
        ? page.creators.map(creator => creator.name)
        : (metadata?.creators.map(creator => creator.name) ?? [])
    ).join(', ');
  });
  const year = () => (details().published ?? currentSnapshot()?.metadata.published)?.match(/\d{4}/)?.[0];
  const byline = createMemo(() => [creators() || currentSnapshot()?.metadata.site, year()].filter(Boolean).join(' · '));
  const sourceHighlights = createMemo(() =>
    highlights()
      .filter(row => row.citation.snapshot_id === snapshot())
      .sort(
        (a, b) =>
          a.citation.ordinal - b.citation.ordinal ||
          a.citation.start.offset - b.citation.start.offset ||
          a.citation.id.localeCompare(b.citation.id),
      ),
  );
  const marks = createMemo(() =>
    sourceHighlights().flatMap(row =>
      row.citation.position === undefined ? [] : [{ at: row.citation.position, color: row.color }],
    ),
  );
  const filteredHighlights = createMemo(() =>
    sourceHighlights().filter(row =>
      `${row.citation.quote} ${highlightLocation(row.citation, sections())}`
        .toLocaleLowerCase()
        .includes(query().toLocaleLowerCase()),
    ),
  );
  const highlightNotes = createMemo(
    () =>
      new Map(
        sourceHighlights()
          .filter(row => row.notes > 0)
          .map(row => [row.citation.id, row]),
      ),
  );

  createEffect(() => {
    const sourceId = props.target.sourceId;
    props.workshop.changed('library');
    const controller = new AbortController();
    setHighlightsLoading(true);
    setHighlightsError('');
    void api
      .highlights({ source_id: sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setHighlights(result.rows);
          setHighlightsLoading(false);
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setHighlightsError(reason instanceof Error ? reason.message : String(reason));
          setHighlightsLoading(false);
        }
      });
    onCleanup(() => controller.abort());
  });

  createComputed(
    on(
      readerSettings,
      () => {
        if (!settingsViewport) {
          settingsFromPages = !!scroll?.classList.contains('reader-paged') && !!chunk();
          const anchor = settingsFromPages ? (firstOnPage() ?? pagedReader.pageAnchor) : null;
          settingsViewport = anchor ? { ordinal: anchor.ordinal, offset: 0, character: anchor.offset } : visibleRange();
          settingsAtStart = !settingsFromPages && scroll?.scrollTop === 0;
        }
        const range = settingsViewport;
        if (!range) return;
        const epoch = generation,
          token = ++settingsVersion;
        requestAnimationFrame(() => {
          void (async () => {
            // fonts.ready can settle before the new face is requested; load it explicitly.
            if (readerSettings().typeface === 'serif')
              await document.fonts.load(`${readerSettings().size}px "Piazzolla Variable"`);
            if (disposed || epoch !== generation || token !== settingsVersion) return;
            // measure() would drop every cached size, and rows whose height did not change
            // (images, short headings) then fall back to the estimate. Re-measure mounted rows
            // only; rows mounted later measure themselves.
            for (const row of scroll.querySelectorAll<HTMLDivElement>('.reader-row')) virtualizer.measureElement(row);
            await (settingsFromPages && paged() ? relayoutPages() : jump(range.ordinal, range));
            if (!disposed && epoch === generation && token === settingsVersion) {
              if (settingsAtStart) {
                scroll.scrollTop = 0;
                report();
              }
              settingsViewport = null;
            }
          })().catch(reason => {
            if (!disposed) {
              settingsViewport = null;
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          });
        });
      },
      { defer: true },
    ),
  );

  async function locate(at: string): Promise<number | null> {
    const cached = ordinals.get(at);
    if (cached !== undefined) return cached;
    const existing = locating.get(at);
    if (existing) return existing;
    const id = snapshot(),
      epoch = generation;
    const request = api
      .locate(id, at, requests.signal)
      .then(ordinal => {
        if (epoch === generation && ordinal !== null) {
          ordinals.set(at, ordinal);
          setVersion(value => value + 1);
        }
        return ordinal;
      })
      .finally(() => {
        if (epoch === generation) locating.delete(at);
      });
    locating.set(at, request);
    return request;
  }

  async function loadPage(from: number, refresh = false) {
    const start = Math.floor(from / PAGE_SIZE) * PAGE_SIZE;
    if (!snapshot() || start < 0 || start >= total() || (pages.has(start) && !refresh)) return;
    if (pending.has(start)) return pending.get(start);
    const id = snapshot(),
      epoch = generation;
    const request = api
      .passages(id, start, PAGE_SIZE, requests.signal)
      .then(async page => {
        if (disposed || epoch !== generation) return;
        pages.set(start, page);
        for (const passage of page.passages) {
          passages.set(passage.ordinal, passage);
          ordinals.set(passage.id, passage.ordinal);
        }
        batch(() => {
          setTotal(page.total);
          setContents(page.toc);
          setVersion(value => value + 1);
        });
        await Promise.all(
          page.citations.flatMap(citation => [locate(citation.start.passage_id), locate(citation.end.passage_id)]),
        );
      })
      .finally(() => {
        if (epoch === generation) pending.delete(start);
      });
    pending.set(start, request);
    return request;
  }

  function switchSnapshot(id: string) {
    if (snapshot() === id) return;
    void savePosition();
    generation++;
    pages.clear();
    passages.clear();
    ordinals.clear();
    pending.clear();
    locating.clear();
    clearTimeout(positionTimer);
    setCursor(null);
    setKeyboardRange(null);
    setNoteReturn(null);
    setJumpReturn(null);
    batch(() => {
      setSelection(null);
      setFlash(null);
      setSnapshot(id);
      setChunk(null);
      setContents([]);
      setAtEnd(false);
      setFirstVisible(0);
      setTotal(source()?.snapshots.find(value => value.id === id)?.passage_count ?? 0);
      setVersion(value => value + 1);
    });
    virtualizer.measure();
  }

  /** The contents margin takes `--apparatus-width` and a 48 px gap left of the text, inside the pane's padding; it shows only where both fit. */
  /** The width the text could take at most: the reading column inside the pane's padding. */
  function textRoom() {
    const style = getComputedStyle(scroll);
    return scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  function fitMargin() {
    if (!scroll.clientWidth) return;
    const style = getComputedStyle(scroll);
    const text = paged() ? pageFrame().width : probe.getBoundingClientRect().width;
    const room = (scroll.clientWidth - text) / 2 - parseFloat(style.paddingLeft);
    setTextWidth(
      room >= parseFloat(style.getPropertyValue('--apparatus-width')) + parseFloat(style.getPropertyValue('--space-48'))
        ? text
        : null,
    );
  }
  createEffect(on([paged, pageFrame], fitMargin, { defer: true }));
  // The current section stays in view in the margin as reading moves on.
  createEffect(
    on(currentSection, () => {
      const entry = margin?.querySelector<HTMLElement>('[aria-current]');
      if (!margin || !entry) return;
      if (
        entry.offsetTop < margin.scrollTop ||
        entry.offsetTop + entry.offsetHeight > margin.scrollTop + margin.clientHeight
      )
        margin.scrollTop = entry.offsetTop - margin.clientHeight / 3;
    }),
  );

  /** Resolves true once the passage is on screen, false when disposed or overtaken by another jump. */
  async function jump(
    ordinal: number,
    options: { offset?: number; character?: number; titlePage?: boolean; reveal?: boolean } = {},
  ): Promise<boolean> {
    void savePosition();
    const token = ++jumpVersion,
      epoch = generation;
    restoring = true;
    userScroll = false;
    clearTimeout(positionTimer);
    setSelection(null);
    keyboardVersion++;
    setCursor(null);
    const index = Math.max(0, Math.min(ordinal, total() - 1));
    await loadPage(index);
    if (disposed || epoch !== generation || token !== jumpVersion || !total()) return false;
    if (paged()) {
      const anchor: PageAnchor = { ordinal: index, offset: options.character ?? 0 };
      pagedReader.setPageAnchor(anchor);
      await showPassage(anchor, () => disposed || epoch !== generation || token !== jumpVersion);
      if (disposed || epoch !== generation || token !== jumpVersion) return false;
      restoring = false;
      report();
      return true;
    }
    virtualizer.scrollToIndex(index, { align: 'start' });
    // The destination's real height replaces its estimate after Solid mounts it.
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (disposed || epoch !== generation || token !== jumpVersion) return false;
      virtualizer.scrollToIndex(index, { align: 'start' });
    }
    // The title's height changes as metadata and fonts settle. Opening it means the scroll origin,
    // not subtracting a height sampled before loadPage and the virtualizer's measurements.
    if (options.titlePage) scroll.scrollTop = 0;
    else if (options.character !== undefined) {
      const row = scroll.querySelector<HTMLElement>(`[data-passage-id][data-ordinal="${index}"]`);
      if (row)
        for (const { node, start } of passageText(row)) {
          if (options.character >= start + node.length) continue;
          const rect = characterRect(node, options.character - start);
          // Citation reveals clear the top fade; position restoration keeps its exact character anchor.
          const top = scroll.getBoundingClientRect().top + topInset();
          const chrome =
            options.reveal && chromeOverlays() && !chromeHidden() && !coverReading()
              ? Math.max(0, header.getBoundingClientRect().bottom - top)
              : 0;
          const inset = options.reveal ? chrome + cssValue('--space-24') + cssValue('--space-4') : 0;
          if (rect) scroll.scrollTop += rect.top - top - inset;
          break;
        }
    } else if (options.offset) scroll.scrollTop -= options.offset;
    jumpOrigin = scroll.scrollTop;
    restoring = false;
    report();
    return true;
  }

  async function jumpTo(at: string) {
    setPopup(null);
    try {
      const ordinal = await locate(at);
      if (ordinal === null) throw new Error('Passage not found.');
      return await jump(ordinal);
    } catch (reason) {
      if (!disposed) {
        restoring = false;
        setError(String(reason instanceof Error ? reason.message : reason));
      }
    }
    return false;
  }

  /** Contents moves the reading position: unlike opening a citation, choosing a section is reading on from there. */
  /** `begin` starts reading there (the title page's Begin at); any other jump is a peek with a way back. */
  async function openSection(entry: TocEntry, begin = false) {
    setPopup(null);
    const back = begin ? null : returnMark();
    if (!(await (entry.ordinal === null ? jumpTo(entry.locator) : jump(entry.ordinal)))) return;
    if (begin) setJumpReturn(null);
    else offerReturn(back);
    // A peek moves the saved place only once reading goes on from it: a page turn, or a screen's scroll.
    userScroll = true;
    suppressed = !begin;
    report();
    if (begin) await savePosition();
  }

  /** The place a jump leaves: the earlier one while a return is still offered, so a run of peeks comes back to where reading was. */
  function returnMark() {
    const offered = jumpReturn();
    if (offered) return offered;
    const origin = visibleRange();
    if (!origin) return null;
    const section = sectionAt(origin.ordinal);
    return {
      ...origin,
      page: paged() ? firstOnPage() : null,
      label: section && !isFrontMatter(section.title) ? sectionLabel(section.title) : `passage ${origin.ordinal + 1}`,
    };
  }
  function offerReturn(back: ReturnType<typeof returnMark>) {
    const landing = visibleRange()?.ordinal;
    if (
      !back ||
      landing === undefined ||
      (sectionAt(landing) === sectionAt(back.ordinal) && Math.abs(landing - back.ordinal) < 2)
    ) {
      setJumpReturn(null);
      return;
    }
    setJumpReturn({ ...back, landing });
  }
  // Reading on out of the section a jump landed in keeps the new place, so the way back goes.
  createEffect(
    on(
      currentSection,
      section => {
        const back = jumpReturn();
        if (back && section !== sectionAt(back.landing)) setJumpReturn(null);
      },
      { defer: true },
    ),
  );

  async function returnFromJump() {
    const back = jumpReturn();
    if (!back) return;
    setJumpReturn(null);
    try {
      if (paged() && back.page) {
        pagedReader.setPageAnchor(back.page);
        await relayoutPages();
      } else if (!(await jump(back.ordinal, { offset: back.offset }))) return;
      userScroll = true;
      suppressed = false;
      report();
      await savePosition();
    } catch (reason) {
      if (!disposed) {
        restoring = false;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  function visibleRange() {
    if (
      !scroll ||
      !scroll.getClientRects().length ||
      scroll.closest('[inert], [aria-hidden="true"]') ||
      document.visibilityState === 'hidden'
    )
      return null;
    if (scroll.classList.contains('reader-paged')) {
      const frame = pagedReader.frame;
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
    const viewport = scroll.getBoundingClientRect(),
      edge = viewport.top + topInset();
    let first: { ordinal: number; offset: number } | null = null;
    for (const row of scroll.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const rect = row.getBoundingClientRect(),
        ordinal = Number(row.dataset.ordinal);
      if (rect.bottom <= edge || rect.top >= viewport.bottom) continue;
      if (!first || ordinal < first.ordinal) first = { ordinal, offset: rect.top - edge };
    }
    return first;
  }

  function report() {
    if (disposed || restoring) return;
    const range = visibleRange();
    if (range) {
      setAtEnd(
        !paged() &&
          total() > 0 &&
          passages.has(total() - 1) &&
          scroll.clientHeight > 0 &&
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1,
      );
      setFirstVisible(range.ordinal);
      props.onViewChange({ snapshotId: snapshot(), ordinal: range.ordinal, offset: range.offset });
      if (!suppressed && userScroll) pendingPosition = { snapshotId: snapshot(), ordinal: range.ordinal };
    }
  }

  async function savePosition() {
    if (disposed) return;
    const point = pendingPosition;
    if (!point) return;
    pendingPosition = null;
    // Position writes must outlive this pane's requests, including an unmount or page hide.
    try {
      await api.readingPosition(point.snapshotId, point.ordinal);
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function schedulePosition() {
    clearTimeout(positionTimer);
    if (suppressed || !userScroll) return;
    const range = visibleRange();
    if (range) pendingPosition = { snapshotId: snapshot(), ordinal: range.ordinal };
    positionTimer = window.setTimeout(() => {
      positionTimer = 0;
      void savePosition();
    }, 2000);
  }

  function scrolled() {
    if (restoring) return;
    if (!reportTimer)
      reportTimer = window.setTimeout(() => {
        reportTimer = 0;
        report();
      }, 120);
    if (suppressed && userScroll && Math.abs(scroll.scrollTop - jumpOrigin) > scroll.clientHeight) suppressed = false;
    schedulePosition();
    if (!editing() && !rewritingSelection) {
      if (matchesCoarsePointer()) selected();
      else if (selection()) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    }
    if (userScroll && chromeOverlays()) hideChrome();
  }

  createEffect(() => {
    if (paged()) return;
    const rows = virtualizer.getVirtualItems();
    snapshot();
    total();
    const needed = new Set(rows.map(row => Math.floor(row.index / PAGE_SIZE) * PAGE_SIZE));
    for (const start of needed)
      void loadPage(start).catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
  });
  createEffect(
    on(
      () => props.workshop.changed('library'),
      () => {
        for (const from of pages.keys())
          void loadPage(from, true).catch(reason => {
            if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
          });
      },
      { defer: true },
    ),
  );
  async function note(locator: string, anchor: HTMLElement) {
    const state: ReaderPopup = { kind: 'note', anchor, text: '', loading: true };
    setPopup(state);
    try {
      const ordinal = await locate(locator);
      if (ordinal === null) throw new Error('Footnote not found.');
      await loadPage(ordinal);
      if (!disposed && popup() === state)
        setPopup({ kind: 'note', anchor, text: passages.get(ordinal)?.text ?? '', loading: false, ordinal, locator });
    } catch (reason) {
      if (!disposed && popup() === state)
        setPopup({
          kind: 'note',
          anchor,
          text: reason instanceof Error ? reason.message : String(reason),
          loading: false,
        });
    }
  }

  async function openFootnote(ordinal: number, locator: string, anchor: HTMLElement) {
    const origin = visibleRange();
    if (!origin) return;
    const back = {
      ...origin,
      page: paged() ? firstOnPage() : null,
      passageId: anchor.closest<HTMLElement>('[data-passage-id]')?.dataset.passageId,
      locator,
    };
    setPopup(null);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    try {
      if (await jump(ordinal)) {
        setNoteReturn(back);
        setCursor(ordinal);
        showChrome(false);
        await nextFrame();
        if (!disposed && !paged())
          scroll.querySelector<HTMLElement>(`[data-ordinal="${ordinal}"]`)?.scrollIntoView({ block: 'center' });
      }
    } catch (reason) {
      if (!disposed) {
        restoring = false;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  async function returnFromFootnote() {
    const back = noteReturn();
    if (!back) return;
    try {
      if (paged() && back.page) {
        pagedReader.setPageAnchor(back.page);
        await relayoutPages();
      } else if (!(await jump(back.ordinal, { offset: back.offset }))) return;
      setNoteReturn(null);
      setCursor(null);
      showChrome(false);
      await nextFrame();
      const passage = [...scroll.querySelectorAll<HTMLElement>('[data-passage-id]')].find(
        row => row.dataset.passageId === back.passageId,
      );
      const reference = [...(passage?.querySelectorAll<HTMLElement>('[data-note-locator]') ?? [])].find(
        link => link.dataset.noteLocator === back.locator,
      );
      reference?.focus({ preventScroll: true });
    } catch (reason) {
      if (!disposed) {
        restoring = false;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  async function openCitation(citation: Citation) {
    try {
      const block = props.workshop.lookup(citation.block_id)() ?? (await api.block(citation.block_id));
      if (!disposed) props.onOpen({ kind: 'page', pageId: block.page_id, blockId: citation.block_id }, true);
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function citationMenu(citation: Citation, anchor: HTMLElement) {
    try {
      const result = await api.highlights(
        { source_id: citation.source_id, unprocessed: false, limit: Number.MAX_SAFE_INTEGER },
        requests.signal,
      );
      const row = result.rows.find(value => value.citation.id === citation.id);
      if (!row) throw new Error('Citation not found.');
      const { items, Header } = await actions(
        row,
        `“${row.citation.quote}” — ${row.source_title}, ${highlightLocation(row.citation, sections())}`,
        anchor,
      );
      if (!disposed && anchor.isConnected) setPopup({ kind: 'menu', anchor, items, Header });
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function openHighlightNote(row: HighlightRow) {
    try {
      const menu = await actions(row);
      if (!disposed) menu.openNote();
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function clickedCitation(values: Citation[], anchor: HTMLElement, beside: boolean) {
    if (beside) {
      void openCitation(values[0]!);
      return;
    }
    if (values.length === 1) {
      void citationMenu(values[0]!, anchor);
      return;
    }
    setPopup({
      kind: 'menu',
      anchor,
      items: values.map(citation => ({
        label: `“${citation.quote.slice(0, 40)}…”`,
        action: () => {
          void citationMenu(citation, anchor);
        },
      })),
    });
  }

  async function jumpHighlight(citation: Citation) {
    setPopup(null);
    suppressed = true;
    const back = returnMark();
    try {
      await locate(citation.end.passage_id);
      const ordinal = await locate(citation.start.passage_id);
      if (ordinal === null) throw new Error('Passage not found.');
      if (!(await jump(ordinal, { character: citation.start.offset, reveal: true }))) return;
      offerReturn(back);
      if (!disposed) {
        clearTimeout(flashTimer);
        setFlash(citation);
        flashTimer = window.setTimeout(() => setFlash(null), 1500);
      }
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  createEffect(() => {
    if (props.active) return;
    setSelection(null);
    const dom = window.getSelection();
    if (dom?.anchorNode && scroll?.contains(dom.anchorNode)) dom.removeAllRanges();
  });

  function selected() {
    if (editing() || rewritingSelection || popup()) return;
    if (!props.active || !scroll.getClientRects().length) {
      setSelection(null);
      return;
    }
    const dom = window.getSelection();
    const value = dom && selectionInPassages(scroll, dom, [...passages.values()]);
    const range = value && dom!.rangeCount ? dom!.getRangeAt(0) : null;
    setSelection(
      value && range
        ? { ...value, rect: range.getBoundingClientRect(), rects: [...range.getClientRects()], snapshotId: snapshot() }
        : null,
    );
    setEditError('');
  }
  createEffect(
    on(
      popup,
      state => {
        if (!state) selected();
      },
      { defer: true },
    ),
  );

  /**
   * On a touch screen a new note on an existing highlight is written in the composer, as on a new one, so reading
   * stays in this pane. A highlight in another snapshot of the book has no passages here and opens its page instead.
   */
  function composeNote(row: HighlightRow, noteId: string) {
    const citation = row.citation;
    if (!matchesCoarsePointer() || citation.source_id !== props.target.sourceId || citation.snapshot_id !== snapshot())
      return false;
    setPopup(null);
    void (async () => {
      const last = await locate(citation.end.passage_id);
      if (last === null) throw new Error('Passage not found.');
      await Promise.all([
        loadPage(citation.ordinal - 1),
        loadPage(citation.ordinal),
        loadPage(last),
        loadPage(last + 1),
      ]);
      if (disposed || composing()) return;
      composedCitation = citation.id;
      setComposing(
        noteDraft(
          {
            start: citation.start,
            end: citation.end,
            first: citation.ordinal,
            last,
            quote: citation.quote,
            locator: citation.locator,
          },
          noteId,
        ),
      );
    })().catch(reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return true;
  }

  /** The quotation with the sentence before and after it, from loaded prose passages. */
  function noteDraft(value: PassageSelection, noteId: string): HighlightNoteDraft {
    const first = passages.get(value.first)!,
      last = passages.get(value.last)!;
    const neighbour = (ordinal: number) => {
      const passage = passages.get(ordinal);
      return passage && prose[passage.kind] ? passage.text : '';
    };
    const before = first.text.slice(0, value.start.offset),
      after = last.text.slice(value.end.offset);
    let following = followOn(after);
    for (let ordinal = value.last + 1; !following && passages.has(ordinal); ordinal++)
      following = followOn(neighbour(ordinal));
    const section = sectionAt(value.first)?.title;
    return {
      sourceId: props.target.sourceId,
      noteId,
      title: title(),
      byline: byline(),
      section: section ? sectionLabel(section) : '',
      progress: share(value.first),
      quote: value.quote,
      before: leadIn(before.trim() ? before : neighbour(value.first - 1)),
      after: following,
    };
  }

  async function prepareMerges(value?: SelectionToolbar, color: Citation['color'] = null) {
    await readerDocument.ready();
    await readerDocument.flush();
    const sourceId = props.target.sourceId;
    const rows = (
      await api.highlights({ source_id: sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER }, requests.signal)
    ).rows.filter(row => !value || row.citation.snapshot_id === value.snapshotId);
    const points = new Map<string, number>();
    for (const row of rows) {
      points.set(row.citation.start.passage_id, row.citation.ordinal);
      if (!points.has(row.citation.end.passage_id)) {
        const ordinal = await api.locate(row.citation.snapshot_id, row.citation.end.passage_id, requests.signal);
        if (ordinal === null) throw new Error('Passage not found.');
        points.set(row.citation.end.passage_id, ordinal);
      }
    }
    if (value) {
      points.set(value.start.passage_id, value.first);
      points.set(value.end.passage_id, value.last);
    }
    const groups = overlappingHighlights(
      rows,
      points,
      value ? { snapshot_id: value.snapshotId, start: value.start, end: value.end } : undefined,
    );
    const merges: { citation: Citation; removeIds: string[]; removeCitationIds: string[] }[] = [];
    let selectedRange = value,
      kept = 0,
      removed = 0;
    for (const group of groups) {
      const referenced = new Set<string>();
      for (const row of group.rows)
        if (
          row.block.block.page_id === sourceId &&
          (await api.backlinks(row.block.block.id, 1, requests.signal)).length
        )
          referenced.add(row.block.block.id);
      const members = mergeMembers(group, sourceId, referenced, color);
      kept += members.kept.length;
      const snapshotId = group.rows[0]?.citation.snapshot_id ?? value!.snapshotId;
      const first = points.get(group.start.passage_id)!,
        last = points.get(group.end.passage_id)!;
      const evidence: Passage[] = [];
      for (let from = first; from <= last; from += PAGE_SIZE) {
        evidence.push(
          ...(await api.passages(snapshotId, from, Math.min(PAGE_SIZE, last - from + 1), requests.signal)).passages,
        );
      }
      const quote = evidence
        .map(passage =>
          passage.text.slice(
            passage.id === group.start.passage_id ? group.start.offset : 0,
            passage.id === group.end.passage_id ? group.end.offset : passage.text.length,
          ),
        )
        .join('\n\n');
      const range = { start: group.start, end: group.end, quote, locator: evidence[0]!.locator, ordinal: first };
      if (value) selectedRange = { ...value, ...range, first, last };
      if (!members.survivor) continue;
      const previous = members.survivor.citation;
      merges.push({
        citation: { ...previous, ...range, color: members.color },
        removeIds: [
          ...new Set(
            members.removed.filter(row => row.block.block.id !== previous.block_id).map(row => row.block.block.id),
          ),
        ],
        removeCitationIds: members.removed
          .filter(row => row.block.block.id === previous.block_id)
          .map(row => row.citation.id),
      });
      removed += members.removed.length;
    }
    return { merges, selectedRange, removed, kept };
  }

  async function mergeOverlapping() {
    if (editing()) return;
    setEditing(true);
    setMergeMessage('');
    setError('');
    try {
      const plan = await prepareMerges();
      if (plan.merges.length) {
        const result = readerDocument.edit({ kind: 'mergeHighlights', merges: plan.merges });
        if (!result.ok) throw new Error(result.reason);
        await readerDocument.flush();
      }
      setMergeMessage(
        `${plan.removed ? `Merged ${plan.removed} highlights` : 'No overlapping highlights'}${plan.kept ? `; ${plan.kept} cited elsewhere kept` : ''}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEditing(false);
    }
  }

  async function highlight(withNote: boolean, color: Citation['color'] = null) {
    const value = selection();
    if (!value || value.blockedReason || editing()) return;
    setEditing(true);
    setEditError('');
    setRemovedNotice(false);
    const sourceId = props.target.sourceId,
      doc = readerDocument;
    try {
      const plan = await prepareMerges(value, color),
        range = plan.selectedRange!;
      if (withNote && matchesCoarsePointer())
        await Promise.all([loadPage(range.first), loadPage(range.last), loadPage(range.last + 1)]);
      const citationId = plan.merges[0]?.citation.id ?? ulid();
      const result = plan.merges.length
        ? doc.edit({ kind: 'mergeHighlights', merges: plan.merges, note: withNote })
        : doc.edit({
            kind: 'highlight',
            parentId: sourceId,
            text: range.quote,
            color,
            note: withNote,
            citation: {
              id: citationId,
              sourceId,
              snapshotId: range.snapshotId,
              start: range.start,
              end: range.end,
              quote: range.quote,
              locator: range.locator,
              ordinal: range.first,
            },
          });
      if (!result.ok) {
        setEditError(result.reason);
        return;
      }
      const highlightId = plan.merges[0]?.citation.block_id ?? result.created[0]!;
      await doc.flush();
      if (!disposed) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        if (withNote && matchesCoarsePointer()) {
          composedCitation = citationId;
          setComposing(noteDraft(range, result.created.at(-1)!));
        } else {
          drawInk(citationId);
          if (withNote)
            props.onOpen(
              { kind: 'page', pageId: sourceId, blockId: highlightId, caretId: result.created.at(-1) },
              true,
            );
        }
      }
    } catch (reason) {
      if (!disposed) setEditError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setEditing(false);
    }
  }

  /** Full screen changes the whole window around the page; the page morphs between its two sizes instead of snapping. */
  const setImmersive = (value: boolean) => crossfade(readerRoot, () => props.onImmersive(value));

  function readerKeyBlocked(event: KeyboardEvent, shifted = false) {
    if (
      !props.active ||
      loading() ||
      popup() ||
      composing() ||
      editing() ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return true;
    if (event.shiftKey && !shifted && event.key !== '{' && event.key !== '}') return true;
    const target = event.target;
    const control =
      target instanceof Element
        ? target.closest(
            'button, a[href], input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"]',
          )
        : null;
    // A reading-tool button or a highlight only acts on Space and Enter, so the reader's other keys pass through it: closing a popover leaves focus on the control that opened it.
    if (
      control?.matches('.reader-header button, .pane-header button, .reader-folio button, .reader-highlight') &&
      event.key !== ' ' &&
      event.key !== 'Enter'
    )
      return false;
    return !!control || (target instanceof HTMLElement && target.isContentEditable);
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
    const ordinal = Math.max(0, Math.min(total() - 1, visibleCursor() + direction)),
      epoch = generation,
      token = keyboardVersion;
    setCursor(ordinal);
    await loadPage(ordinal);
    if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
    userScroll = true;
    if (paged()) await revealPassage(ordinal);
    else virtualizer.scrollToIndex(ordinal, { align: 'auto' });
  }

  async function writeSelection(range: SentenceSelection) {
    const first = ordinals.get(range.start.passage_id),
      last = ordinals.get(range.end.passage_id),
      epoch = generation,
      token = keyboardVersion;
    if (first === undefined || last === undefined) return;
    rewritingSelection = true;
    setKeyboardRange({ first, last });
    try {
      // Keep both endpoints mounted while scrolling to the new selection end.
      for (let frame = 0; frame < 3; frame++) {
        if (paged()) await revealPassage(last, Math.max(0, range.end.offset - 1));
        else virtualizer.scrollToIndex(last, { align: 'auto' });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
      }
      const rows = [...scroll.querySelectorAll<HTMLElement>('[data-passage-id]')];
      const startRow = rows.find(row => row.dataset.passageId === range.start.passage_id);
      const endRow = rows.find(row => row.dataset.passageId === range.end.passage_id);
      const start = startRow && passageNode(startRow, range.start.offset),
        end = endRow && passageNode(endRow, range.end.offset);
      const dom = window.getSelection();
      if (!start || !end || !dom) return;
      const value = document.createRange();
      value.setStart(start.node, start.offset);
      value.setEnd(end.node, end.offset);
      dom.removeAllRanges();
      dom.addRange(value);
      rewritingSelection = false;
      selected();
    } finally {
      rewritingSelection = false;
      setKeyboardRange(null);
    }
  }

  async function selectSentence() {
    const ordinal = visibleCursor(),
      epoch = generation,
      token = keyboardVersion;
    const anchor = paged() ? firstOnPage() : null;
    setCursor(ordinal);
    await loadPage(ordinal);
    if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup()) return;
    const passage = passages.get(ordinal),
      range = passage && sentenceAt(passage.text, anchor?.ordinal === ordinal ? anchor.offset : 0);
    if (passage && range)
      await writeSelection({
        start: { passage_id: passage.id, offset: range.start },
        end: { passage_id: passage.id, offset: range.end },
      });
  }

  async function resizeSelection(extend: boolean, unit: SelectionUnit) {
    const value = selection(),
      epoch = generation,
      token = keyboardVersion;
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
      if (
        disposed ||
        epoch !== generation ||
        token !== keyboardVersion ||
        !props.active ||
        popup() ||
        current?.first !== value.first ||
        current.last !== value.last ||
        current.start.offset !== value.start.offset ||
        current.end.offset !== value.end.offset
      )
        return;
      const passage = passages.get(ordinal);
      if (!passage) return;
      ordered.push(passage);
      range = extendSelection(value, ordered, unit);
    }
    if (range !== value) await writeSelection(range);
  }
  async function undoHighlight() {
    setRemovedNotice(false);
    try {
      if (actions.canUndo()) await actions.undo();
      else {
        readerDocument.undo();
        await readerDocument.flush();
      }
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const readerActions = createMemo<MenuItem[]>(() => {
    const needsSelection = selection() ? undefined : 'Select text first';
    // A touch screen without a keyboard has the selection bar, swipes and taps for these, so only the source's actions show.
    if (matchesTouchOnly())
      return [
        {
          label: 'Open source page',
          icon: 'page',
          action: () => props.onOpen({ kind: 'page', pageId: props.target.sourceId }, false),
        },
        {
          label: 'Merge overlapping highlights',
          icon: 'merge',
          disabledReason: editing() ? 'Saving…' : undefined,
          action: () => {
            void mergeOverlapping();
          },
        },
        {
          label: 'Undo',
          icon: 'undo',
          divider: true,
          disabledReason: actions.canUndo() || readerDocument.canUndo() ? undefined : 'Nothing to undo',
          action: () => {
            void undoHighlight();
          },
        },
        ...(coverReading()
          ? []
          : [
              {
                label: props.immersive ? 'Exit full screen' : 'Full screen',
                action: () => setImmersive(!props.immersive),
              },
            ]),
      ];
    return [
      {
        label: 'Open source',
        icon: 'page',
        shortcut: `${besideKey} beside`,
        action: () => props.onOpen({ kind: 'page', pageId: props.target.sourceId }, besidePressed),
      },
      {
        label: 'Merge overlapping highlights',
        icon: 'highlight',
        disabledReason: editing() ? 'Saving…' : undefined,
        action: () => {
          void mergeOverlapping();
        },
      },
      {
        label: 'Undo last edit',
        icon: 'undo',
        disabledReason: actions.canUndo() || readerDocument.canUndo() ? undefined : 'Nothing to undo',
        action: () => {
          void undoHighlight();
        },
      },
      {
        label: 'Next passage',
        section: 'Keyboard',
        shortcut: 'J',
        action: () => {
          void moveCursor(1);
        },
      },
      {
        label: 'Previous passage',
        shortcut: 'K',
        action: () => {
          void moveCursor(-1);
        },
      },
      {
        label: 'Select sentence',
        shortcut: 'S',
        action: () => {
          void selectSentence();
        },
      },
      {
        label: 'Extend by sentence',
        shortcut: ']',
        disabledReason: needsSelection,
        action: () => {
          void resizeSelection(true, 'sentence');
        },
      },
      {
        label: 'Shrink by sentence',
        shortcut: '[',
        disabledReason: needsSelection,
        action: () => {
          void resizeSelection(false, 'sentence');
        },
      },
      {
        label: 'Extend by passage',
        shortcut: '}',
        disabledReason: needsSelection,
        action: () => {
          void resizeSelection(true, 'passage');
        },
      },
      {
        label: 'Shrink by passage',
        shortcut: '{',
        disabledReason: needsSelection,
        action: () => {
          void resizeSelection(false, 'passage');
        },
      },
      {
        label: 'Highlight',
        shortcut: 'H',
        disabledReason: needsSelection,
        action: () => {
          void highlight(false);
        },
      },
      {
        label: 'Highlight and annotate',
        shortcut: 'N',
        disabledReason: needsSelection,
        action: () => {
          void highlight(true);
        },
      },
      {
        label: 'Highlight color',
        shortcut: '1–5',
        submenu: () => ({
          title: 'Highlight color',
          items: highlightColors.map(
            (color, index): MenuItem => ({
              label: color[0]!.toUpperCase() + color.slice(1),
              shortcut: String(index + 1),
              disabledReason: needsSelection,
              action: () => {
                void highlight(false, color);
              },
            }),
          ),
        }),
      },
      {
        label: 'Clear selection',
        shortcut: 'Esc',
        disabledReason: needsSelection,
        action: () => {
          keyboardVersion++;
          setSelection(null);
          window.getSelection()?.removeAllRanges();
        },
      },
      ...(paged()
        ? [
            {
              label: 'Next page',
              section: 'Pages',
              shortcut: '→ / Page Down / Space',
              action: () => {
                void turn(1);
              },
            },
            {
              label: 'Previous page',
              shortcut: '← / Page Up / Shift+Space',
              action: () => {
                void turn(-1);
              },
            },
          ]
        : []),
      {
        label: props.immersive ? 'Exit full screen' : 'Full screen',
        shortcut: props.immersive ? 'F / Esc' : 'F',
        action: () => setImmersive(!props.immersive),
      },
    ];
  });
  const trackBeside = (event: KeyboardEvent) => {
    besidePressed = opensBeside(event);
  };
  // Registered before any popup opens, so it sees the popup and selection a tap is about to dismiss.
  const pointerDown = (event: PointerEvent) => {
    besidePressed = opensBeside(event);
    dismissingTap = !!popup() || window.getSelection()?.isCollapsed === false;
    if (!(event.target instanceof Element && event.target.closest('.reader-highlight-undo'))) setRemovedNotice(false);
  };

  const readerKey = (event: KeyboardEvent) => {
    if (props.active && !(event.target instanceof Element && event.target.closest('.reader-highlight-undo')))
      setRemovedNotice(false);
    if (
      props.active &&
      !composing() &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'z' &&
      !(event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) readerDocument.redo();
      else readerDocument.undo();
      void readerDocument.flush().catch(reason => setError(String(reason)));
      return;
    }
    const turnBy = pageTurns[event.key];
    if (
      turnBy &&
      paged() &&
      !readerKeyBlocked(event, event.key === ' ') &&
      window.getSelection()?.isCollapsed !== false
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void turn(event.key === ' ' && event.shiftKey ? -1 : turnBy);
      return;
    }
    if (readerKeyBlocked(event)) return;
    // Escape first clears a selection (selectionKey prevents it); the next one leaves full screen.
    if (
      event.key === 'f' ||
      (event.key === 'Escape' &&
        props.immersive &&
        !event.defaultPrevented &&
        !selection() &&
        window.getSelection()?.isCollapsed !== false)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setImmersive(event.key === 'f' ? !props.immersive : false);
      return;
    }
    const key = event.key,
      moving = key === 'j' || key === 'k' || key === 's',
      resizing = '][}{'.includes(key) && key.length === 1;
    if ((!moving && !resizing) || (moving && selection()) || (resizing && !selection() && !keyboardPending)) return;
    if (moving && !window.getSelection()?.isCollapsed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const epoch = generation,
      token = keyboardVersion;
    keyboardPending++;
    keyboardQueue = keyboardQueue
      .then(async () => {
        if (disposed || epoch !== generation || token !== keyboardVersion || !props.active || popup() || editing())
          return;
        if (key === 's' && !selection()) await selectSentence();
        else if ((key === 'j' || key === 'k') && !selection()) await moveCursor(key === 'j' ? 1 : -1);
        else if (resizing && selection())
          await resizeSelection(key === ']' || key === '}', key === ']' || key === '[' ? 'sentence' : 'passage');
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        keyboardPending--;
      });
  };

  const selectionKey = (event: KeyboardEvent) => {
    if (readerKeyBlocked(event) || (!selection() && !keyboardPending)) return;
    const key = event.key.toLowerCase();
    const color = /^[1-5]$/.test(key) ? highlightColors[Number(key) - 1] : undefined;
    if (key === 'h' || key === 'n' || color) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const epoch = generation,
        token = keyboardVersion;
      keyboardQueue = keyboardQueue.then(async () => {
        if (!disposed && epoch === generation && token === keyboardVersion && props.active && !popup())
          await highlight(key === 'n', color);
      });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      keyboardVersion++;
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    }
  };

  onMount(() => {
    document.addEventListener('selectionchange', selected);
    document.addEventListener('keydown', selectionKey, true);
    document.addEventListener('keydown', readerKey, true);
    document.addEventListener('keydown', trackBeside, true);
    document.addEventListener('keyup', trackBeside, true);
    document.addEventListener('pointerdown', pointerDown, true);
    const hidden = () => {
      if (document.visibilityState === 'hidden') void savePosition();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', savePosition);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', savePosition);
    });
    // Folding, unfolding and the sidebar change the page; keep the passage being read in view.
    let pageSize = '',
      resizeFrame = 0;
    const resizer = new ResizeObserver(() => {
      // A hidden or collapsing pane has no page to lay out; wait for its real size.
      if (!scroll.clientWidth || !scroll.clientHeight) return;
      const size = `${scroll.clientWidth}x${scroll.clientHeight}`;
      if (size === pageSize) return;
      pageSize = size;
      if (!paged() || loading() || !chunk()) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        void relayoutPages();
      });
    });
    resizer.observe(scroll);
    // Reader settings change the measure without resizing the pane. Fitting the margin changes the width the probe
    // reports, so it runs a frame later (see `deferred`).
    fitMargin();
    const marginLater = deferred(fitMargin);
    const marginFitter = new ResizeObserver(marginLater);
    marginFitter.observe(scroll);
    marginFitter.observe(probe);
    onCleanup(() => {
      marginFitter.disconnect();
      marginLater.cancel();
    });
    onCleanup(() => {
      resizer.disconnect();
      cancelAnimationFrame(resizeFrame);
    });
    const initialView = { ...props.view },
      target = { ...props.target };
    void (async () => {
      const value = await api.source(target.sourceId, requests.signal);
      if (disposed) return;
      setSource(value);
      const id = initialView.snapshotId ?? target.snapshotId ?? value.source.current_snapshot_id;
      if (!id) throw new Error('No snapshot available.');
      switchSnapshot(id);
      let ordinal =
        initialView.ordinal >= 0
          ? initialView.ordinal
          : value.position?.snapshot_id === id
            ? value.position.passage_ordinal
            : 0;
      let citation: Citation | undefined;
      await loadPage(ordinal);
      if (target.citationId) {
        citation = (
          await api.highlights(
            { source_id: target.sourceId, unprocessed: false, limit: Number.MAX_SAFE_INTEGER },
            requests.signal,
          )
        ).rows.find(row => row.citation.id === target.citationId)?.citation;
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
      await jump(ordinal, {
        offset: target.at || citation || initialView.ordinal < 0 ? 0 : initialView.offset,
        character: citation?.start.offset,
        reveal: !!citation,
        titlePage: ordinal === 0 && initialView.ordinal < 0 && !target.at && !citation,
      });
      if (citation) flashTimer = window.setTimeout(() => setFlash(null), 1500);
      setLoading(false);
    })().catch(reason => {
      if (!disposed) {
        restoring = false;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  });
  onCleanup(() => {
    void savePosition();
    disposed = true;
    requests.abort();
    readerDocument.release();
    setLinkedCitation(null);
    clearTimeout(reportTimer);
    clearTimeout(positionTimer);
    clearTimeout(flashTimer);
    clearTimeout(inkTimer);
    document.removeEventListener('selectionchange', selected);
    document.removeEventListener('keydown', selectionKey, true);
    document.removeEventListener('keydown', readerKey, true);
    document.removeEventListener('keydown', trackBeside, true);
    document.removeEventListener('keyup', trackBeside, true);
    document.removeEventListener('pointerdown', pointerDown, true);
  });
  createEffect(
    on(
      () => props.active,
      active => {
        if (!active) void savePosition();
      },
      { defer: true },
    ),
  );

  const passageView: ReaderPassageView = {
    api: props.workshop.api,
    active: () => props.active,
    version,
    snapshot,
    source,
    currentSnapshot,
    details,
    title,
    titleCover,
    creators,
    year,
    contents,
    sections,
    openings,
    absorbed,
    quotesAreText,
    cursor,
    citations,
    highlightNotes,
    ordinals,
    passages,
    flashId: () => flash()?.id ?? null,
    inkId: ink,
    onJumpTo: at => {
      void jumpTo(at);
    },
    onNote: (at, anchor) => {
      void note(at, anchor);
    },
    onCitation: clickedCitation,
    onHighlightNote: row => {
      void openHighlightNote(row);
    },
    onOpenSection: (entry, begin) => {
      void openSection(entry, begin);
    },
  };

  /** The toolbar outlives the selection by one exit fade, showing the selection it last had. The iOS app has none: its system selection menu carries the colours and Annotate (edit-menu.ts). */
  const nativeMenu = nativeEditMenu();
  const toolbar = createRetained(() => (props.active && !popup() && !nativeMenu ? selection() : null));
  if (nativeMenu) {
    let offered: SelectionToolbar | null = null;
    createEffect(() => {
      const value = props.active && !popup() && !composing() && !editing() ? selection() : null;
      if (value && !value.blockedReason) {
        offered = value;
        showEditMenu();
      } else hideEditMenu();
    });
    onCleanup(
      onEditMenu(tap => {
        if (!props.active) return;
        // The system may have collapsed the selection by the time its menu reports the tap; the selection it was shown for stands.
        if (!selection() && offered) setSelection(offered);
        void highlight(tap.kind === 'annotate', tap.kind === 'highlight' ? tap.color : null);
      }),
    );
    onCleanup(hideEditMenu);
  }
  function SelectionTools(shown: { current: SelectionToolbar | undefined; leaving: boolean }) {
    let element!: HTMLDivElement;
    const [placement, setPlacement] = createSignal({
      left: 0,
      top: 0,
      width: 0,
      visible: false,
      docked: false,
      capsule: false,
    });
    // A phone's panel is a capsule of the five colours and Annotate, with its other actions a page behind the chevron.
    const [more, setMore] = createSignal(false);
    createEffect(
      on(
        () => shown.current,
        () => setMore(false),
        { defer: true },
      ),
    );
    const blocked = () => editing() || !!shown.current?.blockedReason;
    const copy = () => {
      const text = shown.current?.quote;
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    };
    const place = () => {
      const value = shown.current;
      if (!element || !value) return;
      const viewport = scroll.getBoundingClientRect();
      if (!props.active || !viewport.width || !viewport.height) {
        setPlacement(previous => ({ ...previous, visible: false }));
        return;
      }
      const left = Math.max(0, viewport.left),
        right = Math.min(window.innerWidth, viewport.right);
      const top = Math.max(0, viewport.top),
        bottom = Math.min(window.innerHeight, viewport.bottom);
      const gap = parseFloat(getComputedStyle(element).getPropertyValue('--space-4'));
      // Touch screens dock the toolbar at the foot of the page, in thumb reach and clear of the system's own text menu
      // beside the selection, and at the head only when the selection runs down there. It keeps to the reading measure.
      // A phone's panel is the capsule the system's own menu is: over the selection, under it where there is no room above,
      // and at the foot above the reading tools where there is none under it either.
      if (matchesCoarsePointer()) {
        const height = element.offsetHeight;
        const tools = chromeOverlays() && !chromeHidden() ? header.getBoundingClientRect().top : bottom;
        const foot = Math.min(bottom, tools) - height - gap;
        if (isPhone()) {
          const width = element.offsetWidth,
            bar = navBar()?.getBoundingClientRect().bottom ?? top;
          const above = value.rect.top - height - gap,
            below = value.rect.bottom + gap;
          setPlacement({
            left: Math.max(left + gap, Math.min((value.rect.left + value.rect.right - width) / 2, right - width - gap)),
            top: above >= bar ? above : below <= foot ? below : foot,
            width: 0,
            visible: true,
            docked: true,
            capsule: true,
          });
          return;
        }
        const measure = (paged() ? pagedReader.frame : scroll.querySelector('.reader-list'))?.getBoundingClientRect();
        const measureLeft = Math.max(left, measure?.left ?? left),
          measureRight = Math.min(right, measure?.right ?? right);
        const width = Math.max(0, Math.min(measureRight - measureLeft, probe.getBoundingClientRect().width));
        setPlacement({
          left: (measureLeft + measureRight - width) / 2,
          top: value.rect.bottom > foot - gap ? top + gap : foot,
          width,
          visible: width > 0,
          docked: true,
          capsule: false,
        });
        return;
      }
      const width = Math.min(element.offsetWidth, right - left),
        height = element.offsetHeight;
      const rects = value.rects.filter(
        rect =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > left &&
          rect.left < right &&
          rect.bottom > top &&
          rect.top < bottom,
      );
      if (!rects.length) {
        setPlacement(previous => ({ ...previous, visible: false }));
        return;
      }
      // A range can cross columns. Its union is nearly page-height, so anchor beside an endpoint's actual line instead.
      const candidates = [rects.at(-1)!, rects[0]!]
        .flatMap(rect => {
          const x = Math.max(left, Math.min((rect.left + rect.right - width) / 2, right - width));
          return [
            { left: x, top: rect.top - height - gap },
            { left: x, top: rect.bottom + gap },
          ];
        })
        .filter(at => at.top >= top && at.top + height <= bottom);
      const overlap = (at: { left: number; top: number }) =>
        rects.reduce(
          (area, rect) =>
            area +
            Math.max(0, Math.min(at.left + width, rect.right) - Math.max(at.left, rect.left)) *
              Math.max(0, Math.min(at.top + height, rect.bottom) - Math.max(at.top, rect.top)),
          0,
        );
      const at = candidates.reduce(
        (best, at) => (overlap(at) < overlap(best) ? at : best),
        candidates[0] ?? { left, top },
      );
      setPlacement({ ...at, width: right - left, visible: true, docked: false, capsule: false });
    };
    createEffect(place);
    onMount(() => {
      const observer = new ResizeObserver(place);
      observer.observe(element);
      observer.observe(scroll);
      place();
      onCleanup(() => observer.disconnect());
    });
    return (
      <Portal>
        <div
          ref={element}
          class="reader-selection-toolbar"
          classList={{
            'reader-selection-docked': placement().docked && !placement().capsule,
            'reader-selection-capsule': placement().capsule,
            'reader-selection-leaving': shown.leaving,
          }}
          role="toolbar"
          aria-label="Highlight selection"
          inert={shown.leaving}
          style={{
            left: `${placement().left}px`,
            top: `${placement().top}px`,
            'max-width': placement().width ? `${placement().width}px` : undefined,
            width: placement().docked && !placement().capsule ? `${placement().width}px` : undefined,
            visibility: placement().visible ? 'visible' : 'hidden',
          }}
          onPointerDown={event => event.preventDefault()}
        >
          <Show
            when={isPhone()}
            fallback={
              <>
                <div class="reader-selection-actions">
                  <Button
                    icon="highlight"
                    disabled={blocked()}
                    onClick={() => {
                      void highlight(false);
                    }}
                  >
                    Highlight <kbd>H</kbd>
                  </Button>
                  <Button
                    disabled={blocked()}
                    onClick={() => {
                      void highlight(true);
                    }}
                  >
                    Highlight and annotate <kbd>N</kbd>
                  </Button>
                </div>
                <div class="reader-selection-actions">
                  <For each={highlightColors}>
                    {(color, index) => (
                      <Button
                        aria-label={`Highlight ${color}`}
                        title={`Highlight ${color} (${index() + 1})`}
                        disabled={blocked()}
                        onClick={() => {
                          void highlight(false, color);
                        }}
                      >
                        <span class={`highlight-color-dot highlight-color-${color}`} aria-hidden="true" />
                        <kbd>{index() + 1}</kbd>
                      </Button>
                    )}
                  </For>
                </div>
              </>
            }
          >
            <div class="reader-selection-actions">
              <Show
                when={!more()}
                fallback={
                  <>
                    <Button
                      class="reader-selection-page"
                      icon="left"
                      label="Colors and annotate"
                      onClick={() => setMore(false)}
                    />
                    <Button
                      disabled={blocked()}
                      onClick={() => {
                        void highlight(false);
                      }}
                    >
                      Highlight
                    </Button>
                    <Button onClick={copy}>Copy</Button>
                  </>
                }
              >
                <For each={highlightColors}>
                  {color => (
                    <Button
                      class="reader-selection-dot"
                      label={`Highlight ${color}`}
                      disabled={blocked()}
                      onClick={() => {
                        void highlight(false, color);
                      }}
                    >
                      <span class={`highlight-color-dot highlight-color-${color}`} aria-hidden="true" />
                    </Button>
                  )}
                </For>
                <Button
                  disabled={blocked()}
                  onClick={() => {
                    void highlight(true);
                  }}
                >
                  Annotate
                </Button>
                <Button
                  class="reader-selection-page"
                  icon="right"
                  label="Highlight and Copy"
                  onClick={() => setMore(true)}
                />
              </Show>
            </div>
          </Show>
          <Show when={shown.current?.blockedReason}>{reason => <p role="status">{reason()}</p>}</Show>
          <Show when={editError()}>
            <p class="error" role="alert">
              {editError()}
            </p>
          </Show>
        </div>
      </Portal>
    );
  }

  /** In Pages the toolbar and the foot span the spread; in Scroll they keep the reading measure. */
  const spreadWidth = () => (paged() && pageFrame().width ? `${pageFrame().width}px` : undefined);
  // Restoring the position waits on animation frames, which a held view transition never gives; so the reader marks
  // itself loading rather than pending, and the leaf turns to its nav bar while the text fades in where it lands.
  return (
    <div
      ref={readerRoot}
      class="reader-pane"
      classList={{
        'reader-chrome-hidden': chromeHides() && chromeHidden(),
        'reader-chrome-over': chromeOverlays(),
        'reader-loading': loading(),
      }}
      data-pane-loading={loading() ? '' : undefined}
      style={readerStyle()}
      onPointerDown={props.onActivate}
      onFocusIn={props.onActivate}
      onPointerMove={pointerMoved}
    >
      {/* The cover screen's navigation bar is the pane header (shell/App.tsx): the book as a glass title that opens the progress card, then Aa and ···. The reading tools are one capsule at the foot. */}
      <Show when={coverReading()}>
        <NavTitle
          title={title() || 'Reader'}
          glass
          detail={bookTime() ? <Figures text={bookTime()} /> : undefined}
          onClick={mapChapters().length ? anchor => setPopup({ kind: 'progress', anchor }) : undefined}
        />
        <NavEnd>
          <NavGroup label="Reading">
            <NavButton
              class="reader-settings-toggle reader-aa"
              label="Reader settings"
              aria-haspopup="dialog"
              aria-expanded={popup()?.kind === 'settings'}
              onClick={event => setPopup({ kind: 'settings', anchor: event.currentTarget })}
            >
              Aa
            </NavButton>
            <NavButton
              icon="more"
              label="Reader actions"
              aria-haspopup="menu"
              aria-expanded={popup()?.kind === 'actions'}
              onPointerDown={event => event.preventDefault()}
              onClick={event => {
                event.currentTarget.focus({ preventScroll: true });
                setPopup({ kind: 'actions', anchor: event.currentTarget });
              }}
            />
          </NavGroup>
        </NavEnd>
      </Show>
      <div
        ref={header}
        class="reader-header"
        role="toolbar"
        aria-label="Reading tools"
        style={{ 'max-width': spreadWidth() }}
        onFocusIn={onHeaderFocusIn}
      >
        <Show when={coverReading() && jumpReturn()}>
          {back => (
            <Button
              class="reader-return"
              icon="left"
              label={`Back to ${back().label}`}
              onClick={() => {
                void returnFromJump();
              }}
            />
          )}
        </Show>
        <Show when={noteReturn()}>
          <Button
            icon="left"
            label="Back to footnote reference"
            onClick={() => {
              void returnFromFootnote();
            }}
          />
        </Show>
        <Button
          class="reader-contents"
          icon="contents"
          label={coverReading() ? undefined : 'Contents'}
          aria-label={
            coverReading() ? `Contents. ${[chapterName(), whereTime()].filter(Boolean).join(', ')}` : undefined
          }
          aria-haspopup={textWidth() === null ? 'dialog' : undefined}
          disabled={!contents().length}
          onClick={event => {
            if (textWidth() !== null && margin?.isConnected) {
              setPopup(null);
              const entry =
                margin.querySelector<HTMLElement>('[aria-current]') ?? margin.querySelector<HTMLElement>('button');
              entry?.focus();
            } else {
              setQuery('');
              setPopup({ kind: 'contents', anchor: event.currentTarget });
            }
          }}
        >
          <Show
            when={coverReading()}
            fallback={
              <>
                <span>
                  <Show when={!loading() && currentSection()} fallback="Contents">
                    {entry => <SectionLabel title={entry().title} />}
                  </Show>
                </span>
                <Icon name="down" />
              </>
            }
          >
            <span class="reader-where">
              <span class="reader-where-name">
                <Show when={chapterName()} fallback="Contents">
                  <SectionLabel title={chapterEntry()!.title} />
                </Show>
              </span>
              <small>
                <Figures text={whereTime()} />
              </small>
            </span>
          </Show>
        </Button>
        <Button
          class="reader-highlights"
          icon="highlight"
          label="Highlights"
          aria-haspopup="dialog"
          disabled={!snapshot()}
          onClick={event => {
            setQuery('');
            setPopup({ kind: 'highlights', anchor: event.currentTarget });
          }}
        >
          <Show when={sourceHighlights().length}>
            <span class="reader-count">{sourceHighlights().length}</span>
          </Show>
        </Button>
        <Button
          icon="search"
          label="Find in source"
          aria-haspopup="dialog"
          disabled={!snapshot()}
          onClick={event => {
            setQuery('');
            setPopup({ kind: 'find', anchor: event.currentTarget });
          }}
        />
        <Show when={!coverReading()}>
          <Button
            class="reader-settings-toggle"
            label="Reader settings"
            aria-haspopup="dialog"
            onClick={event => setPopup({ kind: 'settings', anchor: event.currentTarget })}
          >
            Aa
          </Button>
          <Button
            class="reader-full-screen"
            icon={props.immersive ? 'contract' : 'expand'}
            label={props.immersive ? 'Exit full screen' : 'Full screen'}
            shortcut={props.immersive ? 'F or Esc' : 'F'}
            onClick={() => setImmersive(!props.immersive)}
          />
          <Button
            icon="more"
            label="Reader actions"
            aria-haspopup="menu"
            onPointerDown={event => event.preventDefault()}
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              setPopup({ kind: 'actions', anchor: event.currentTarget });
            }}
          />
        </Show>
        <Show when={coverReading()}>
          <div
            class="reader-track"
            role="progressbar"
            aria-label="Read in the book"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(position() * 100)}
          >
            <i style={{ width: `${position() * 100}%` }} />
          </div>
        </Show>
      </div>
      <Show when={error()}>
        <p class="reader-error error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={loading()}>
        <p class="reader-status" role="status">
          Loading…
        </p>
      </Show>
      <Show when={mergeMessage()}>
        <p class="reader-status" role="status">
          {mergeMessage()}
        </p>
      </Show>
      <div class="reader-measure-probe" aria-hidden="true">
        <div ref={probe} />
      </div>
      <div class="reader-body" style={{ '--reader-text-width': `${textWidth() ?? 0}px` }}>
        <Show when={textWidth() !== null && contents().length}>
          <nav ref={margin} class="reader-margin" aria-label="Contents">
            <For each={contents()}>
              {entry => (
                <Button
                  class="reader-margin-entry"
                  aria-current={entry === currentSection() ? 'location' : undefined}
                  style={{ '--level': Math.max(0, entry.level - 1) }}
                  onClick={() => {
                    void openSection(entry);
                  }}
                >
                  {contentsTitle(entry.title)}
                </Button>
              )}
            </For>
          </nav>
        </Show>
        <div
          ref={scroll}
          class="reader-scroll"
          classList={{ 'reader-paged': paged() }}
          style={{ '--reader-frame-width': `${pageFrame().width}px` }}
          tabIndex={0}
          aria-label="Source passages"
          onScroll={scrolled}
          onWheel={() => {
            userScroll = true;
          }}
          onTouchMove={() => {
            userScroll = true;
          }}
          onPointerDown={readerPointerDown}
          onPointerMove={readerPointerMove}
          onPointerUp={readerPointerUp}
          onPointerCancel={readerPointerCancel}
          onKeyDown={event => {
            if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key))
              userScroll = true;
          }}
        >
          <Show
            when={paged()}
            fallback={
              <ScrolledPassages
                view={passageView}
                totalSize={virtualizer.getTotalSize()}
                items={items}
                setTitleHeight={setTitleHeight}
                measure={element => virtualizer.measureElement(element)}
              />
            }
          >
            <PagedFlow
              view={passageView}
              loading={loading()}
              pageIndex={pageIndex()}
              pageCount={pageCount()}
              pageFrame={pageFrame()}
              chunk={chunk()}
              chunkOrdinals={chunkOrdinals()}
              total={total()}
              chapterName={chapterName()}
              chapterTitle={chapterEntry()?.title}
              bindFrame={element => pagedReader.bindFrame(element)}
              bindFlow={element => pagedReader.bindFlow(element)}
              onWheel={pageWheel}
              onScheduleCount={scheduleCount}
              onTurn={direction => {
                void turn(direction);
              }}
            />
          </Show>
        </div>
      </div>
      {/* The foot: the book map, and under it one line naming the chapter with its time left, then the book's share and time left, which opens the progress card. */}
      <div class="reader-foot" style={{ 'max-width': spreadWidth() }}>
        <div class="reader-map">
          <Show
            when={mapChapters().length}
            fallback={
              <div class="reader-progress-rule" aria-hidden="true">
                <span style={{ width: `${position() * 100}%` }} />
              </div>
            }
          >
            <BookMap
              chapters={mapChapters()}
              length={currentSnapshot()!.text_length}
              at={here()}
              highlights={marks()}
              label={`${formatProgress(position())} read`}
            />
          </Show>
        </div>
        <div class="reader-folio">
          <span class="reader-folio-name">
            <Show when={chapterName()}>
              <SectionLabel title={chapterEntry()!.title} />
            </Show>
          </span>
          <Show when={jumpReturn()}>
            {back => (
              <Button
                class="reader-folio-return"
                icon="left"
                onClick={() => {
                  void returnFromJump();
                }}
              >
                <span>Back to {back().label}</span>
              </Button>
            )}
          </Show>
          <span class="reader-folio-time" hidden={!!jumpReturn()}>
            <Show when={chapterLeft() !== null}>{atEnd() ? 'Finished' : `${timeLeft(chapterLeft()!)} left`}</Show>
            <Show when={paged() && !loading()}>
              {chapterLeft() !== null ? ' · ' : ''}p. {pageIndex() + 1} of {pageCount()}
            </Show>
          </span>
          <Button
            class="reader-folio-book"
            label="Reading progress"
            aria-haspopup="dialog"
            disabled={!mapChapters().length}
            title={!mapChapters().length ? 'No chapter positions available' : undefined}
            onClick={event => setPopup({ kind: 'progress', anchor: event.currentTarget })}
          >
            {formatProgress(position())}
            <Show when={bookLeft() !== null}> · {atEnd() ? 'Finished' : timeLeft(bookLeft()!)}</Show>
          </Button>
        </div>
      </div>
      <Show when={popup()}>
        {state => (
          <>
            <Show when={state().kind === 'settings'}>
              <ReaderSettingsPopup
                anchor={state().anchor}
                sheet={matchesCoarsePointer()}
                room={textRoom()}
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'progress'}>
              <ProgressCard
                anchor={state().anchor}
                sheet={coverReading()}
                chapters={mapChapters()}
                length={currentSnapshot()?.text_length ?? 0}
                at={here()}
                highlights={marks()}
                added={source()?.source.added_at ?? null}
                today={props.workshop.todayDate()}
                onDismiss={() => setPopup(null)}
                onJump={chapter => {
                  const entry = contents().find(value => value.start === chapter.start && value.ordinal !== null);
                  if (entry) void openSection(entry);
                  else setPopup(null);
                }}
              />
            </Show>
            <Show when={state().kind === 'actions'}>
              <Menu
                anchor={state().anchor}
                label="Reader actions"
                title="Reader actions"
                class="reader-more"
                items={readerActions()}
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'contents'}>
              <Picker
                class="reader-picker"
                anchor={state().anchor}
                placement={coverReading() ? 'sheet' : 'anchor'}
                label="Contents"
                title="Contents"
                prefix={coverReading() ? <Icon name="search" /> : undefined}
                placeholder="Find a section"
                autofocus={!matchesCoarsePointer()}
                query={query()}
                onQuery={setQuery}
                items={toc()}
                key={entry => entry.locator}
                initial={coverReading() ? undefined : Math.max(0, toc().indexOf(currentSection()!))}
                row={entry => (
                  <ReaderTocRow
                    entry={entry}
                    currentSection={currentSection()}
                    span={tocSpans().get(entry)}
                    here={here()}
                    coverReading={coverReading()}
                  />
                )}
                onPick={entry => {
                  void openSection(entry);
                }}
                empty="No sections"
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'highlights'}>
              <Picker
                class="reader-picker"
                anchor={state().anchor}
                placement={coverReading() ? 'sheet' : 'anchor'}
                label="Highlights"
                title="Highlights"
                prefix={coverReading() ? <Icon name="search" /> : undefined}
                placeholder="Find a highlight"
                autofocus={!matchesCoarsePointer()}
                query={query()}
                onQuery={setQuery}
                items={filteredHighlights()}
                key={row => row.citation.id}
                section={
                  coverReading()
                    ? (row: HighlightRow) => contentsTitle(highlightLocation(row.citation, sections())) || undefined
                    : undefined
                }
                row={row => (
                  <div class="reader-highlight-entry">
                    <span
                      class={`highlight-color-dot highlight-color-${row.citation.color ?? 'none'}`}
                      aria-hidden="true"
                    />
                    <span class="reader-highlight-quote">{row.citation.quote}</span>
                    <Show when={!coverReading()}>
                      <span class="reader-highlight-section">
                        {contentsTitle(highlightLocation(row.citation, sections()))}
                      </span>
                    </Show>
                  </div>
                )}
                busy={highlightsLoading()}
                error={highlightsError()}
                empty="No highlights"
                onPick={row => {
                  void jumpHighlight(row.citation);
                }}
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'menu'}>
              <Menu
                anchor={state().anchor}
                placement={coverReading() ? 'sheet' : 'anchor'}
                label="Actions for highlight"
                items={(() => {
                  const value = state();
                  return value.kind === 'menu' ? value.items : [];
                })()}
                header={(() => {
                  const value = state();
                  return value.kind === 'menu' && value.Header ? (
                    <value.Header onDismiss={() => setPopup(null)} />
                  ) : undefined;
                })()}
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'find'}>
              <ReaderSearchPopup
                anchor={state().anchor}
                coverReading={coverReading()}
                query={query()}
                onQuery={setQuery}
                hits={hits()}
                searching={searching()}
                searchError={searchError()}
                morePassages={morePassages()}
                onLoadMore={() => {
                  void loadSearchPage();
                }}
                sectionAt={sectionAt}
                onPick={hit => {
                  setPopup(null);
                  const back = hit.snapshot_id === snapshot() ? returnMark() : null;
                  switchSnapshot(hit.snapshot_id);
                  void jump(hit.passage.ordinal)
                    .then(moved => {
                      if (moved) offerReturn(back);
                    })
                    .catch(reason => {
                      restoring = false;
                      setError(reason instanceof Error ? reason.message : String(reason));
                    });
                }}
                onDismiss={() => setPopup(null)}
              />
            </Show>
            <Show when={state().kind === 'note'}>
              <Popup anchor={state().anchor} label="Footnote" class="reader-note" onDismiss={() => setPopup(null)}>
                <p>
                  {(() => {
                    const value = state();
                    return value.kind === 'note' ? (value.loading ? 'Loading…' : value.text) : '';
                  })()}
                </p>
                <Show
                  when={(() => {
                    const value = state();
                    return value.kind === 'note' && value.ordinal !== undefined ? value : null;
                  })()}
                >
                  {note => (
                    <Button
                      onClick={() => {
                        void openFootnote(note().ordinal!, note().locator!, note().anchor);
                      }}
                    >
                      Open footnote
                    </Button>
                  )}
                </Show>
              </Popup>
            </Show>
          </>
        )}
      </Show>
      <Show when={toolbar()}>
        <SelectionTools current={toolbar()?.value} leaving={!!toolbar()?.leaving} />
      </Show>
      <Show when={composing()} keyed>
        {draft => (
          <HighlightComposer
            workshop={props.workshop}
            draft={draft}
            onClose={() => {
              setComposing(null);
              drawInk(composedCitation);
            }}
          />
        )}
      </Show>
      <Show when={props.active && removedNotice()}>
        <div
          class="undo-toast reader-highlight-undo"
          role="status"
          onPointerEnter={() => setNoticeHeld(true)}
          onPointerLeave={() => setNoticeHeld(false)}
          onFocusIn={() => setNoticeHeld(true)}
          onFocusOut={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNoticeHeld(false);
          }}
        >
          <span>Highlight removed</span>
          <Button
            icon="undo"
            disabled={!actions.canUndo()}
            onClick={() => {
              void undoHighlight();
            }}
          >
            Undo
          </Button>
          <Button icon="close" label="Dismiss highlight removal notice" onClick={() => setRemovedNotice(false)} />
        </div>
      </Show>
      <actions.Popups />
    </div>
  );
}
