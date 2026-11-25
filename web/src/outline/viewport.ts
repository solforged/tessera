import { batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { ViewState } from '../core/contract';
import type { PageDocument, WorkshopClient } from '../document/contract';
import type { PaneEditor } from './editor';
import { plainText } from './names';

export interface FoldMotionState {
  id: string;
  opening: boolean;
  afterIds: string[];
  beforeSize: number;
}

export interface OutlineViewportOptions {
  pageId: string;
  doc: PageDocument;
  workshop: WorkshopClient;
  active: () => boolean;
  reading: () => boolean;
  ids: Accessor<string[]>;
  indices: Accessor<Map<string, number>>;
  folds: Accessor<Set<string>>;
  setFolds: Setter<Set<string>>;
  editing: Accessor<string | null>;
  selected: Accessor<string | null>;
  composition: Accessor<boolean>;
  capabilitiesPopupId: () => string | undefined;
  viewport: Accessor<{ top: number; left: number; width: number; height: number; bottom: number }>;
  editingBarVisible: () => boolean;
  suppressCaretScroll: () => boolean;
  focusEpoch: () => number;
  disposed: () => boolean;
  initialReveal: string | undefined;
  initialScroll: ViewState['scroll'];
  hosts: Map<string, HTMLElement>;
  scroll: () => HTMLDivElement | undefined;
  list: () => HTMLDivElement | undefined;
  heading: () => HTMLDivElement | undefined;
  editingBar: () => HTMLDivElement | undefined;
  editor: () => PaneEditor | undefined;
  rowAnchor: (id: string) => HTMLElement | null;
  readingAnchor: (id: string) => HTMLElement | null;
  rowFocus: (id: string) => void;
  restoreFocus: () => void;
  report: () => void;
  scheduleReport: () => void;
}

export function createOutlineViewport(options: OutlineViewportOptions) {
  const [margin, setMargin] = createSignal(0);
  const [pendingReadAnchor, setPendingReadAnchor] = createSignal<ViewState['scroll']>(null);
  const [scrollAnchor, setScrollAnchor] = createSignal<ViewState['scroll']>(null);
  const [foldMotion, setFoldMotion] = createSignal<FoldMotionState>();
  const [sectionName, setSectionName] = createSignal('');
  const [longPage, setLongPage] = createSignal(false);
  const [scrolledAway, setScrolledAway] = createSignal(false);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let navigator: HTMLDivElement | undefined;
  let foldChildren: HTMLDivElement | undefined;
  let foldFollowing: HTMLDivElement | undefined;
  let foldEditor: HTMLDivElement | undefined;
  let foldFrame = 0;
  let foldAnimations: Animation[] = [];
  let settleFold: (() => void) | undefined;
  let scrollSettle = 0;
  let revealTimer = 0;
  let revealedReading: HTMLElement | null = null;
  let anchorFrame = 0;
  let scrollReveal: { id: string; epoch: number; caret: boolean } | null = null;
  let pendingOutlineReveal = options.initialReveal;
  let scrollingFrame = false;
  let scrollStable = 0;
  let previousScrollHeight = -1;
  let slideRemoval = false;

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get enabled() {
      return !options.reading();
    },
    get count() {
      return options.reading() ? 0 : options.ids().length;
    },
    getScrollElement: () => options.scroll() ?? null,
    // One unwrapped line, and constant: TanStack re-estimates every unmeasured row whenever any row resizes.
    estimateSize: () => 28,
    // A sheet moves between value rows in one edit. Sync reads must not reuse either row's old height.
    measureElement: element => element.offsetHeight,
    overscan: 8,
    get scrollMargin() {
      return margin();
    },
    get getItemKey() {
      const rows = options.ids();
      return (index: number) => rows[index]!;
    },
    get rangeExtractor() {
      const pinned = [
        options.editing(),
        scrollAnchor()?.id,
        options.capabilitiesPopupId(),
        ...(foldMotion()?.afterIds ?? []),
      ].flatMap(id => (id ? (options.indices().get(id) ?? []) : []));
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const result = defaultRangeExtractor(range);
        for (const index of pinned) if (!result.includes(index)) result.push(index);
        return result.sort((a, b) => a - b);
      };
    },
  });

  // Size changes and structural edits share the same anchor/reveal decision, never a second scroll writer.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = item => {
    const scroll = options.scroll();
    if (!scrollingFrame) {
      if (anchorFrame) scheduleScroll();
      else if (scroll && item.start < scroll.scrollTop) restoreAnchor(currentAnchor());
    }
    return false;
  };

  const virtualItems = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [String(item.key), item])));
  const [listHeight, setListHeight] = createSignal(virtualizer.getTotalSize());
  createEffect(() => {
    const height = virtualizer.getTotalSize();
    // Removing a sheet-bearing row must not publish a temporarily shorter sizer and clamp the browser's scrollTop.
    if (!anchorFrame && !scrollingFrame) setListHeight(height);
  });

  function currentAnchor(): ViewState['scroll'] {
    const scroll = options.scroll(),
      list = options.list();
    if (!scroll || !list) return null;
    const viewport = scroll.getBoundingClientRect();
    let anchor: ViewState['scroll'] = null;
    const rows = options.reading()
      ? scroll.querySelectorAll<HTMLElement>('[data-reading-id], [data-block-id]')
      : list.querySelectorAll<HTMLElement>('[data-block-id]');
    for (const candidate of rows) {
      const rect = candidate.getBoundingClientRect();
      const offset = rect.top - viewport.top;
      if (rect.bottom > viewport.top + 1 && (!anchor || offset < anchor.offset))
        anchor = { id: candidate.dataset.readingId ?? candidate.dataset.blockId!, offset };
    }
    return anchor;
  }

  function scrolled() {
    const scroll = options.scroll(),
      list = options.list(),
      heading = options.heading();
    if (scroll && list) {
      setLongPage(scroll.scrollHeight > scroll.clientHeight);
      const viewportTop = scroll.getBoundingClientRect().top;
      const titleBottom =
        heading?.querySelector<HTMLElement>('.outline-title')?.getBoundingClientRect().bottom ??
        heading?.querySelector('h1')?.getBoundingClientRect().bottom ??
        viewportTop + 25;
      // Reveal when the title leaves; retain the navigator until it returns 24px into view.
      setScrolledAway(previous => (previous ? titleBottom <= viewportTop + 24 : titleBottom < viewportTop));
      const top = viewportTop + (navigator?.offsetHeight ?? 0);
      const rows = [...list.querySelectorAll<HTMLElement>('[data-block-id]')]
        .map(row => ({ row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.top <= top);
      const row =
        rows.find(({ rect }) => rect.bottom > top)?.row ?? rows.sort((a, b) => b.rect.top - a.rect.top)[0]?.row;
      let id = row?.dataset.blockId;
      let holder: string | undefined, section: string | undefined;
      while (id && id !== options.pageId) {
        const block = options.doc.block(id);
        if (block?.position)
          holder = block.position.holder_id
            ? options.workshop.lookup(block.position.holder_id)()?.text
            : 'Unattributed';
        if (block?.heading && options.doc.outline.parentOf(id) === options.pageId)
          section = plainText(block.text, target => options.workshop.lookup(target));
        id = block?.parentId ?? undefined;
      }
      setSectionName([section ?? (holder ? 'Perspectives' : 'Opening'), holder].filter(Boolean).join(' · '));
    }
    clearTimeout(scrollSettle);
    scrollSettle = window.setTimeout(options.scheduleReport, 150);
  }

  function scheduleScroll() {
    if (options.disposed()) return;
    scrollStable = 0;
    if (!anchorFrame) anchorFrame = requestAnimationFrame(settleScroll);
  }

  function cancelScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    setScrollAnchor(null);
    scrollReveal = null;
    previousScrollHeight = -1;
    setListHeight(virtualizer.getTotalSize());
  }

  function measureRows() {
    const list = options.list();
    if (!list) return;
    scrollingFrame = true;
    // Refresh both sides of a sheet transfer before publishing their combined list height.
    batch(() => {
      for (const row of list.querySelectorAll<HTMLDivElement>('[data-index]')) {
        virtualizer.resizeItem(Number(row.dataset.index), row.offsetHeight);
      }
    });
    setListHeight(virtualizer.getTotalSize());
    scrollingFrame = false;
  }

  /** Moves everything in the pane from `distance` px away back to where it settled, over the interface duration. */
  function slideContent(distance: number) {
    const scroll = options.scroll();
    if (!scroll || reducedMotion.matches) return;
    const style = getComputedStyle(scroll);
    const time = style.getPropertyValue('--motion-ui').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    if (!duration) return;
    const timing: KeyframeAnimationOptions = { duration, easing: style.getPropertyValue('--motion-ease').trim() };
    for (const child of scroll.children)
      child.animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], timing);
  }

  function settleScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    const scroll = options.scroll();
    if (options.disposed() || !scroll) return;
    const before = scroll.scrollTop;
    measureRows();
    const bounds = scroll.getBoundingClientRect();
    const anchor = scrollAnchor();
    const row = anchor ? (options.reading() ? options.readingAnchor(anchor.id) : options.rowAnchor(anchor.id)) : null;
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    let offset = Math.max(
      0,
      Math.min(maximum, before + (row && anchor ? row.getBoundingClientRect().top - bounds.top - anchor.offset : 0)),
    );
    const request = scrollReveal;
    const valid =
      request &&
      options.active() &&
      options.focusEpoch() === request.epoch &&
      (request.caret ? options.editing() : options.selected()) === request.id;
    const editor = options.editor();
    const target = valid
      ? request.caret
        ? editor?.id === request.id && options.hosts.get(request.id)?.contains(editor.view.dom)
          ? editor.view.coordsAtPos(editor.view.state.selection.main.head)
          : null
        : options.rowAnchor(request.id)?.getBoundingClientRect()
      : null;
    if (target) {
      // Test the caret against the viewport it would have after anchoring, then make only one scroll write.
      const shift = offset - before;
      const editingBar = options.editingBar();
      const barTop = editingBar?.isConnected ? editingBar.getBoundingClientRect().top : options.viewport().bottom;
      const lineClearance = options.editingBarVisible() ? parseFloat(getComputedStyle(scroll).lineHeight) : 0;
      const bottom = Math.min(bounds.bottom, options.viewport().bottom, barTop) - lineClearance;
      if (target.top - shift < bounds.top) offset += target.top - shift - bounds.top;
      else if (target.bottom - shift > bottom)
        offset += Math.min(target.bottom - shift - bottom, target.top - shift - bounds.top);
      offset = Math.max(0, Math.min(maximum, offset));
    }
    if (Math.abs(offset - before) > 0.5) scroll.scrollTop = offset;
    if (slideRemoval) {
      slideRemoval = false;
      const clamped = before - scroll.scrollTop;
      if (clamped > 1) slideContent(-clamped);
    }
    // Reveal wins. Later measurements retain this resulting position, not the pre-reveal anchor offset.
    if (row && anchor) {
      const position = row.getBoundingClientRect().top - bounds.top;
      if (Math.abs(position - anchor.offset) > 0.5) setScrollAnchor({ id: anchor.id, offset: position });
    }
    scrollStable =
      scroll.scrollTop === before && scroll.scrollHeight === previousScrollHeight && (!valid || target)
        ? scrollStable + 1
        : 0;
    previousScrollHeight = scroll.scrollHeight;
    if (scrollStable < 2) anchorFrame = requestAnimationFrame(settleScroll);
    else {
      if (pendingOutlineReveal && !options.reading() && options.rowAnchor(pendingOutlineReveal)) {
        highlightReading(pendingOutlineReveal);
        pendingOutlineReveal = undefined;
      }
      cancelScroll();
      options.scheduleReport();
    }
  }

  createEffect(
    on(
      [options.viewport, options.editingBarVisible],
      () => {
        const id = options.editing(),
          editor = options.editor();
        if (options.suppressCaretScroll() || !id || !options.active() || !editor?.view.hasFocus) return;
        scrollReveal = { id, epoch: options.focusEpoch(), caret: true };
        scheduleScroll();
      },
      { defer: true },
    ),
  );

  function restoreAnchor(anchor: ViewState['scroll']) {
    if (
      !anchor ||
      options.disposed() ||
      (!options.indices().has(anchor.id) && !(options.reading() && options.readingAnchor(anchor.id)))
    )
      return;
    setScrollAnchor({ ...anchor });
    scheduleScroll();
  }

  function restoreInitialAnchor() {
    if (options.reading()) setPendingReadAnchor(options.initialScroll);
    else restoreAnchor(options.initialScroll);
  }

  function highlightReading(id: string) {
    clearTimeout(revealTimer);
    revealedReading?.classList.remove('reading-reveal');
    revealedReading = options.readingAnchor(id);
    revealedReading?.classList.add('reading-reveal');
    revealTimer = window.setTimeout(() => {
      revealedReading?.classList.remove('reading-reveal');
      revealedReading = null;
    }, 1500);
  }

  function anchored(change: () => void) {
    if (!scrollAnchor()) setScrollAnchor(currentAnchor());
    scheduleScroll();
    change();
  }

  // Only rendered static rows change groups; the active editor stays mounted.
  const foldGroups = createMemo(() => {
    const all = [...virtualItems().keys()].filter(id => id !== options.editing()),
      state = foldMotion();
    const groups = { before: [] as typeof all, children: [] as typeof all, after: [] as typeof all };
    const start = state ? options.indices().get(state.id) : undefined;
    if (!state || start === undefined) {
      groups.before = all;
      return groups;
    }
    const root = options.doc.outline.indexOf(state.id),
      end = options.doc.outline.subtreeEnd(root);
    for (const id of all) {
      const index = options.indices().get(id) ?? 0;
      const at = options.doc.outline.indexOf(id);
      groups[index <= start ? 'before' : at > root && at < end ? 'children' : 'after'].push(id);
    }
    return groups;
  });

  function finishFoldMotion() {
    cancelAnimationFrame(foldFrame);
    const settle = settleFold;
    settleFold = undefined;
    for (const animation of foldAnimations) animation.cancel();
    foldAnimations = [];
    batch(() => {
      settle?.();
      setFoldMotion(undefined);
    });
  }

  function fold(id = options.selected()) {
    const scroll = options.scroll();
    if (!id || options.composition() || !scroll) return;
    finishFoldMotion();
    const active = options.editing() ?? options.selected();
    if (!options.folds().has(id) && active && active !== id) {
      const at = options.doc.outline.indexOf(id);
      const child = options.doc.outline.indexOf(active);
      if (child > at && child < options.doc.outline.subtreeEnd(at)) options.rowFocus(id);
    }
    options.restoreFocus();
    const opening = options.folds().has(id);
    const change = () =>
      options.setFolds(previous => {
        const next = new Set(previous);
        opening ? next.delete(id) : next.add(id);
        return next;
      });
    const style = getComputedStyle(scroll);
    const time = style.getPropertyValue('--motion-ui').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    const parentIndex = options.indices().get(id);
    if (reducedMotion.matches || !duration || parentIndex === undefined || !options.hosts.has(id)) {
      anchored(change);
      options.report();
      options.scheduleReport();
      return;
    }
    const rootIndex = options.doc.outline.indexOf(id),
      subtreeEnd = options.doc.outline.subtreeEnd(rootIndex);
    const afterIds = [...virtualItems().keys()].filter(key => {
      const at = options.doc.outline.indexOf(key);
      return (options.indices().get(key) ?? 0) > parentIndex && (at <= rootIndex || at >= subtreeEnd);
    });
    const state: FoldMotionState = { id, opening, afterIds, beforeSize: virtualizer.getTotalSize() };
    const anchor = currentAnchor();
    settleFold = () => {
      if (!opening) change();
      restoreAnchor(anchor);
      options.report();
      options.scheduleReport();
    };
    batch(() => {
      setFoldMotion(state);
      if (opening) change();
    });
    // Retain only the rendered trailing rows while the newly visible children are measured.
    foldFrame = requestAnimationFrame(() => {
      foldFrame = requestAnimationFrame(() => {
        if (foldMotion() !== state || options.disposed() || !foldChildren || !foldFollowing) return;
        const parent = virtualItems().get(id);
        const children = foldGroups().children;
        if (!parent || !children.length) {
          finishFoldMotion();
          return;
        }
        const top = parent.end - margin();
        const next = foldGroups().after[0];
        const bottom = next
          ? virtualItems().get(next)!.start - margin()
          : Math.max(...children.map(child => virtualItems().get(child)!.end - margin()));
        const height = Math.max(0, bottom - top);
        const size = virtualizer.getTotalSize();
        const clipped = `inset(${top}px 0 ${Math.max(0, size - top)}px 0)`;
        const revealed = `inset(${top}px 0 ${Math.max(0, size - top - height)}px 0)`;
        const shift = opening ? size - state.beforeSize : height;
        const timing: KeyframeAnimationOptions = {
          duration,
          easing: style.getPropertyValue('--motion-ease').trim(),
          fill: 'both',
        };
        const following = opening
          ? [{ transform: `translateY(${-shift}px)` }, { transform: 'translateY(0)' }]
          : [{ transform: 'translateY(0)' }, { transform: `translateY(${-shift}px)` }];
        foldAnimations = [
          foldChildren.animate(
            opening
              ? [
                  { clipPath: clipped, opacity: 0 },
                  { clipPath: revealed, opacity: 1 },
                ]
              : [
                  { clipPath: revealed, opacity: 1 },
                  { clipPath: clipped, opacity: 0 },
                ],
            timing,
          ),
          foldFollowing.animate(following, timing),
        ];
        const activeEditing = options.editing();
        if (activeEditing && state.afterIds.includes(activeEditing) && foldEditor)
          foldAnimations.push(foldEditor.animate(following, timing));
        const clamp = opening
          ? 0
          : Math.max(0, scroll.scrollTop - Math.max(0, scroll.scrollHeight - shift - scroll.clientHeight));
        if (clamp > 0)
          for (const child of scroll.children)
            foldAnimations.push(
              child.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${clamp}px)` }], timing),
            );
        foldAnimations[0]!.id = 'outline-fold-content';
        foldAnimations[1]!.id = 'outline-fold-following';
        foldAnimations[0]!.onfinish = () => {
          if (foldMotion() === state) finishFoldMotion();
        };
      });
    });
  }

  reducedMotion.addEventListener('change', finishFoldMotion);
  onCleanup(() => {
    finishFoldMotion();
    reducedMotion.removeEventListener('change', finishFoldMotion);
    clearTimeout(scrollSettle);
    clearTimeout(revealTimer);
    revealedReading?.classList.remove('reading-reveal');
    cancelScroll();
  });

  return {
    margin,
    setMargin,
    pendingReadAnchor,
    setPendingReadAnchor,
    scrollAnchor,
    setScrollAnchor,
    foldMotion,
    foldGroups,
    sectionName,
    longPage,
    scrolledAway,
    virtualizer,
    virtualItems,
    listHeight,
    get navigatorHeight() {
      return navigator?.offsetHeight ?? 0;
    },
    bindNavigator(element: HTMLDivElement) {
      navigator = element;
    },
    bindFoldChildren(element: HTMLDivElement) {
      foldChildren = element;
    },
    bindFoldFollowing(element: HTMLDivElement) {
      foldFollowing = element;
    },
    bindFoldEditor(element: HTMLDivElement) {
      foldEditor = element;
    },
    hasAnchorFrame: () => !!anchorFrame,
    requestReveal(id: string, epoch: number, caret: boolean) {
      scrollReveal = { id, epoch, caret };
      scheduleScroll();
    },
    markSlideRemoval(value: boolean) {
      slideRemoval = value;
    },
    currentAnchor,
    scrolled,
    scheduleScroll,
    cancelScroll,
    settleScroll,
    restoreAnchor,
    restoreInitialAnchor,
    highlightReading,
    anchored,
    finishFoldMotion,
    fold,
  };
}
