import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { HighlightSection } from '../library/highlights';
import { Button } from '../ui/Button';
import { contentsTitle } from './openings';
import { pageChunk } from './paged';
import type { PageChunk } from './paged';
import { ReaderPassageContent, ReaderTitlePage, SectionLabel } from './ScrolledPassages';
import type { ReaderPassageView } from './ScrolledPassages';

/** The gutter between columns, and between one page and the next. */
export const PAGE_GAP = 48;
export const pageTurns: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  PageDown: 1,
  PageUp: -1,
  ' ': 1,
};

/** A place in the paged flow: a passage and a character offset into its text. */
export type PageAnchor = { ordinal: number; offset: number };

/** A length token in px or a duration token in ms (minified CSS writes some in seconds); reduced motion sets the durations to zero. */
export function cssValue(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    number = parseFloat(value) || 0;
  return /\ds$/.test(value) ? number * 1000 : number;
}

/** Text nodes of a passage in reading order, each with its offset into the passage's text. */
export function passageText(row: HTMLElement) {
  const nodes: { node: Text; start: number }[] = [],
    walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let start = 0;
  // SHOW_TEXT yields only Text nodes.
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.length) nodes.push({ node, start });
    start += node.length;
  }
  return nodes;
}

export function characterRect(node: Text, index: number): DOMRect | undefined {
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range.getClientRects()[0];
}

export interface PagedReaderOptions {
  pageSize: number;
  paged: Accessor<boolean>;
  version: Accessor<number>;
  total: Accessor<number>;
  sections: Accessor<HighlightSection[]>;
  editing: Accessor<boolean>;
  disposed: () => boolean;
  generation: () => number;
  nextJumpToken: () => number;
  jumpVersion: () => number;
  isRestoring: () => boolean;
  setRestoring: (value: boolean) => void;
  markUserTurn: () => void;
  clearSelectionAndCursor: () => void;
  dismissingTap: () => boolean;
  toggleChrome: () => void;
  scroll: () => HTMLDivElement | undefined;
  probe: () => HTMLDivElement | undefined;
  loadPage: (from: number) => Promise<void> | undefined;
  report: () => void;
  schedulePosition: () => void;
}

export function createPagedReader(options: PagedReaderOptions) {
  const [chunk, setChunk] = createSignal<PageChunk | null>(null);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [pageCount, setPageCount] = createSignal(1);
  const [pageFrame, setPageFrame] = createSignal({ width: 0, columns: 1 });
  const chunkOrdinals = createMemo(() => {
    const value = chunk();
    return value ? Array.from({ length: value.last - value.first + 1 }, (_, index) => value.first + index) : [];
  });

  let frame: HTMLDivElement | undefined;
  let flow: HTMLDivElement | undefined;
  let pointerStart: { x: number; y: number; touch: boolean } | null = null;
  let wheelTotal = 0;
  let lastWheel = 0;
  let lastTurn = 0;
  let countFrame = 0;
  /** A finger dragging the page sideways in Pages: its offset and speed, once it has moved far enough to tell a swipe from a scroll. */
  let drag: { axis: 'x' | 'y' | null; offset: number; time: number; velocity: number } | null = null;
  /** A page sliding into place; `done` turns the frame to its page in the same frame the flow lets go. */
  let slide: { animation: Animation; done(): void } | null = null;
  let pageAnchor: PageAnchor = { ordinal: 0, offset: 0 };

  onCleanup(() => cancelAnimationFrame(countFrame));

  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const pageStride = () => pageFrame().width + PAGE_GAP;
  const motionEase = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--motion-ease').trim() || 'ease-out';

  function endSlide() {
    const value = slide;
    if (!value) return;
    slide = null;
    value.animation.cancel();
    value.done();
  }

  function slideFlow(element: HTMLElement | undefined, keyframes: Keyframe[], duration: number, done: () => void) {
    endSlide();
    if (flow) flow.style.transform = '';
    if (frame) frame.style.transform = '';
    if (!element || duration <= 0) {
      done();
      return;
    }
    const value = { animation: element.animate(keyframes, { duration, easing: motionEase(), fill: 'forwards' }), done };
    slide = value;
    value.animation.onfinish = () => {
      if (slide === value) endSlide();
    };
  }

  function settle(from: number, element = flow) {
    if (from)
      slideFlow(
        element,
        [{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }],
        cssValue('--motion-ui'),
        () => {},
      );
  }

  function layoutPages() {
    const scrollEl = options.scroll(),
      probeEl = options.probe();
    if (!scrollEl || !probeEl) return;
    const style = getComputedStyle(scrollEl);
    const available = Math.floor(
      scrollEl.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    );
    const em = parseFloat(getComputedStyle(probeEl).fontSize),
      measure = probeEl.getBoundingClientRect().width;
    const columns = available >= 2 * 22 * em + PAGE_GAP ? 2 : 1;
    setPageFrame({ width: Math.floor(Math.min(available, columns * measure + (columns - 1) * PAGE_GAP)), columns });
  }

  function applyPage(index: number) {
    endSlide();
    if (!drag) {
      if (flow) flow.style.transform = '';
      if (frame) frame.style.transform = '';
    }
    setPageIndex(index);
    if (frame) frame.scrollLeft = index * pageStride();
  }

  function countPages() {
    if (!frame?.isConnected) return;
    const count = Math.max(1, Math.round((frame.scrollWidth + PAGE_GAP) / pageStride()));
    setPageCount(count);
    applyPage(Math.min(pageIndex(), count - 1));
  }

  const scheduleCount = () => {
    cancelAnimationFrame(countFrame);
    countFrame = requestAnimationFrame(countPages);
  };

  createEffect(
    on(
      options.version,
      () => {
        if (options.paged()) scheduleCount();
      },
      { defer: true },
    ),
  );

  function firstOnPage(): PageAnchor | null {
    if (!frame?.isConnected) return null;
    const view = frame.getBoundingClientRect(),
      past = (rect: DOMRect | undefined) => !!rect && rect.right > view.left + 1;
    for (const row of frame.querySelectorAll<HTMLElement>('[data-passage-id]')) {
      const rects = [...row.getClientRects()].filter(rect => rect.width);
      if (!rects.some(rect => past(rect) && rect.left < view.right - 1)) continue;
      const ordinal = Number(row.dataset.ordinal);
      if (rects[0]!.left > view.left - 1) return { ordinal, offset: 0 };
      for (const { node, start } of passageText(row)) {
        if (!past(characterRect(node, node.length - 1))) continue;
        let low = 0,
          high = node.length - 1;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (past(characterRect(node, middle))) high = middle;
          else low = middle + 1;
        }
        return { ordinal, offset: start + low };
      }
      return { ordinal, offset: 0 };
    }
    return null;
  }

  function pageOf(anchor: PageAnchor) {
    const row = frame?.querySelector<HTMLElement>(`[data-ordinal="${anchor.ordinal}"]`);
    if (!frame || !row) return 0;
    let rect = row.getClientRects()[0];
    if (anchor.offset)
      for (const { node, start } of passageText(row)) {
        if (anchor.offset < start + node.length) {
          rect = characterRect(node, anchor.offset - start) ?? rect;
          break;
        }
      }
    if (!rect) return 0;
    const { columns } = pageFrame(),
      x = rect.left - frame.getBoundingClientRect().left + frame.scrollLeft;
    return Math.max(0, Math.floor(Math.floor((x + 8) / (pageStride() / columns)) / columns));
  }

  async function showPassage(anchor: PageAnchor, stale: () => boolean, edge?: 'last') {
    const target = pageChunk(options.sections(), options.total(), anchor.ordinal);
    for (
      let from = Math.floor(target.first / options.pageSize) * options.pageSize;
      from <= target.last;
      from += options.pageSize
    )
      await options.loadPage(from);
    await document.fonts.ready;
    if (stale()) return;
    layoutPages();
    const current = chunk();
    if (current?.first !== target.first || current.last !== target.last) setChunk(target);
    await nextFrame();
    await nextFrame();
    if (stale() || !frame) return;
    countPages();
    applyPage(edge === 'last' ? pageCount() - 1 : Math.min(pageOf(anchor), pageCount() - 1));
  }

  async function relayoutPages() {
    const token = options.nextJumpToken(),
      epoch = options.generation(),
      anchor = pageAnchor,
      stale = () => options.disposed() || epoch !== options.generation() || token !== options.jumpVersion();
    options.setRestoring(true);
    await showPassage(anchor, stale);
    if (stale()) return;
    options.setRestoring(false);
    options.report();
  }

  async function revealPassage(ordinal: number, offset = 0) {
    pageAnchor = { ordinal, offset };
    const value = chunk();
    if (value && ordinal >= value.first && ordinal <= value.last) applyPage(pageOf(pageAnchor));
    else await showPassage(pageAnchor, options.disposed);
  }

  async function turn(direction: 1 | -1, from = 0) {
    endSlide();
    const value = chunk(),
      next = pageIndex() + direction,
      within = next >= 0 && next < pageCount();
    if (!value || options.isRestoring() || options.editing()) {
      settle(from, within ? flow : frame);
      return;
    }
    options.markUserTurn();
    lastTurn = performance.now();
    options.clearSelectionAndCursor();
    const turned = () => {
      pageAnchor = firstOnPage() ?? pageAnchor;
      options.report();
      options.schedulePosition();
    };
    if (within) {
      const to = -direction * pageStride(),
        left = Math.abs(to - from) / pageStride();
      slideFlow(
        flow,
        [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        cssValue('--motion-page') * Math.max(0.5, left),
        () => {
          applyPage(next);
          turned();
        },
      );
      return;
    }
    const ordinal = direction > 0 ? value.last + 1 : value.first - 1;
    if (ordinal < 0 || ordinal >= options.total()) {
      settle(from, frame);
      return;
    }
    const token = options.nextJumpToken(),
      epoch = options.generation(),
      shift = -direction * cssValue('--space-24'),
      fade = cssValue('--motion-fast');
    options.setRestoring(true);
    if (frame) frame.style.transform = '';
    const leaving =
      frame && fade
        ? frame.animate(
            [
              { transform: `translateX(${from}px)`, opacity: 1 },
              { transform: `translateX(${from + shift}px)`, opacity: 0 },
            ],
            { duration: fade, easing: motionEase(), fill: 'forwards' },
          )
        : null;
    try {
      await Promise.all([options.loadPage(ordinal), leaving?.finished.catch(() => undefined)]);
      await showPassage(
        { ordinal, offset: 0 },
        () => options.disposed() || epoch !== options.generation() || token !== options.jumpVersion(),
        direction < 0 ? 'last' : undefined,
      );
    } finally {
      if (token === options.jumpVersion()) options.setRestoring(false);
      leaving?.cancel();
    }
    if (options.disposed() || token !== options.jumpVersion()) return;
    const arrive = cssValue('--motion-ui');
    if (frame && arrive)
      frame.animate(
        [
          { transform: `translateX(${-shift}px)`, opacity: 0 },
          { transform: 'translateX(0)', opacity: 1 },
        ],
        { duration: arrive, easing: motionEase() },
      );
    turned();
  }

  function readerPointerDown(event: PointerEvent) {
    options.markUserTurn();
    drag = null;
    if (options.dismissingTap()) {
      pointerStart = null;
      return;
    }
    pointerStart = { x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse' };
    if (pointerStart.touch && options.paged() && frame?.isConnected) {
      endSlide();
      drag = { axis: null, offset: 0, time: event.timeStamp, velocity: 0 };
    }
  }

  function readerPointerMove(event: PointerEvent) {
    const value = drag,
      start = pointerStart;
    if (!value || !start || !flow || !frame) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (!value.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      value.axis =
        Math.abs(dx) > 1.5 * Math.abs(dy) &&
        window.getSelection()?.isCollapsed !== false &&
        !options.isRestoring() &&
        !options.editing()
          ? 'x'
          : 'y';
    }
    if (value.axis !== 'x') return;
    if (window.getSelection()?.isCollapsed === false) {
      drag = null;
      settle(value.offset, flow.style.transform ? flow : frame);
      return;
    }
    const next = pageIndex() + (dx < 0 ? 1 : -1),
      within = next >= 0 && next < pageCount();
    const give = cssValue('--space-48');
    const offset = within
      ? Math.max(-pageStride(), Math.min(pageStride(), dx))
      : Math.sign(dx) * give * (1 - Math.exp(-Math.abs(dx) / (2 * give)));
    value.velocity = (offset - value.offset) / Math.max(1, event.timeStamp - value.time);
    value.offset = offset;
    value.time = event.timeStamp;
    (within ? flow : frame).style.transform = `translateX(${offset}px)`;
    (within ? frame : flow).style.transform = '';
  }

  function readerPointerUp(event: PointerEvent) {
    const start = pointerStart,
      value = drag;
    pointerStart = null;
    drag = null;
    if (start && value?.axis === 'x') {
      const dx = event.clientX - start.x,
        flick = Math.abs(value.velocity) > 0.3 && Math.abs(dx) > 24 && Math.sign(value.velocity) === Math.sign(dx);
      if (flick || Math.abs(dx) > pageStride() / 4) void turn(dx < 0 ? 1 : -1, value.offset);
      else settle(value.offset, flow?.style.transform ? flow : frame);
      return;
    }
    if (!start?.touch || window.getSelection()?.isCollapsed === false) return;
    const sheet = options.paged() && frame?.isConnected ? frame : undefined;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (
      Math.abs(dx) > 8 ||
      Math.abs(dy) > 8 ||
      (event.target instanceof Element && event.target.closest('button, a, .reader-highlight'))
    )
      return;
    const scrollEl = options.scroll();
    if (sheet && scrollEl) {
      const bounds = sheet.getBoundingClientRect(),
        target = cssValue('--touch-target');
      const note = [...scrollEl.querySelectorAll<HTMLButtonElement>('.reader-highlight-note')].find(button => {
        const rect = button.getBoundingClientRect();
        if (
          rect.right <= bounds.left ||
          rect.left >= bounds.right ||
          rect.bottom <= bounds.top ||
          rect.top >= bounds.bottom
        )
          return false;
        const x = Math.max(0, (target - rect.width) / 2),
          y = Math.max(0, (target - rect.height) / 2);
        return (
          event.clientX >= rect.left - x &&
          event.clientX <= rect.right + x &&
          event.clientY >= rect.top - y &&
          event.clientY <= rect.bottom + y
        );
      });
      if (note) {
        event.preventDefault();
        note.click();
        return;
      }
    }
    if (sheet) {
      const rect = sheet.getBoundingClientRect(),
        x = event.clientX - rect.left;
      if (x < rect.width / 6) {
        void turn(-1);
        return;
      }
      if (x > (rect.width * 5) / 6) {
        void turn(1);
        return;
      }
    }
    options.toggleChrome();
  }

  function readerPointerCancel() {
    pointerStart = null;
    if (drag?.axis === 'x') settle(drag.offset, flow?.style.transform ? flow : frame);
    drag = null;
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

  return {
    chunk,
    setChunk: setChunk as Setter<PageChunk | null>,
    pageIndex,
    pageCount,
    pageFrame,
    chunkOrdinals,
    get frame() {
      return frame;
    },
    bindFrame(element: HTMLDivElement) {
      frame = element;
    },
    bindFlow(element: HTMLDivElement) {
      flow = element;
    },
    get pageAnchor() {
      return pageAnchor;
    },
    setPageAnchor(anchor: PageAnchor) {
      pageAnchor = anchor;
    },
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
  };
}

export function PagedFlow(props: {
  view: ReaderPassageView;
  loading: boolean;
  pageIndex: number;
  pageCount: number;
  pageFrame: { width: number; columns: number };
  chunk: PageChunk | null;
  chunkOrdinals: number[];
  total: number;
  chapterName: string;
  chapterTitle: string | undefined;
  bindFrame(element: HTMLDivElement): void;
  bindFlow(element: HTMLDivElement): void;
  onWheel(event: WheelEvent): void;
  onScheduleCount(): void;
  onTurn(direction: 1 | -1): void;
}) {
  return (
    <>
      <div
        class="reader-running-head"
        classList={{
          'reader-running-head-quiet':
            props.loading ||
            (props.pageIndex === 0 &&
              (props.view.openings().has(props.chunk?.first ?? -1) ||
                (props.chunk?.first === 0 && !!props.view.title()))),
        }}
        aria-hidden="true"
        style={{
          width: props.pageFrame.width ? `${props.pageFrame.width}px` : '100%',
          'grid-template-columns': `repeat(${props.pageFrame.columns}, minmax(0, 1fr))`,
          'column-gap': `${PAGE_GAP}px`,
        }}
      >
        <Show when={props.pageFrame.columns === 2}>
          <span>
            <i class="reader-section-title">{contentsTitle(props.view.title())}</i>
          </span>
        </Show>
        <span>
          <Show
            when={props.chapterName}
            fallback={
              props.pageFrame.columns === 2 ? (
                ''
              ) : (
                <i class="reader-section-title">{contentsTitle(props.view.title())}</i>
              )
            }
          >
            <SectionLabel title={props.chapterTitle!} />
          </Show>
        </span>
      </div>
      <div
        ref={props.bindFrame}
        class="reader-page-frame"
        style={{ width: `${props.pageFrame.width}px` }}
        onWheel={props.onWheel}
      >
        <div
          ref={props.bindFlow}
          class="reader-flow"
          style={{ 'column-count': props.pageFrame.columns, 'column-gap': `${PAGE_GAP}px` }}
        >
          <Show when={props.chunk?.first === 0 && props.view.title()}>
            <div class="reader-title-block reader-page-title">
              <ReaderTitlePage view={props.view} />
            </div>
          </Show>
          <For each={props.chunkOrdinals}>
            {ordinal => (
              <ReaderPassageContent view={props.view} ordinal={ordinal} onImageLoad={props.onScheduleCount} />
            )}
          </For>
        </div>
      </div>
      <Button
        class="reader-page-edge reader-page-edge-previous"
        icon="left"
        label="Previous page"
        disabled={props.pageIndex === 0 && !props.chunk?.first}
        onClick={() => props.onTurn(-1)}
      />
      <Button
        class="reader-page-edge reader-page-edge-next"
        icon="right"
        label="Next page"
        disabled={props.pageIndex >= props.pageCount - 1 && (props.chunk?.last ?? 0) >= props.total - 1}
        onClick={() => props.onTurn(1)}
      />
    </>
  );
}
