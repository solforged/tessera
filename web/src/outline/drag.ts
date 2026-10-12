import { createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { OutlineReader } from '../document/contract';
import type { OutlineContext } from './context';

export interface OutlineDrop {
  parentId: string;
  after: string | null;
  depth: number;
  anchorId: string;
  edge: 'before' | 'after' | 'child';
}

/** Resolve a pointer's depth and row edge without crossing the zoom or moved subtrees. */
export function outlineDrop(outline: OutlineReader, pageId: string, ids: readonly string[], targetId: string, depth: number, before: boolean, zoomRoot: string | null = null): OutlineDrop | null {
  const target = outline.indexOf(targetId);
  if (!ids.length || target < 0) return null;
  const zoomStart = zoomRoot ? outline.indexOf(zoomRoot) : -1;
  if (zoomRoot && zoomStart < 0) return null;
  const zoomEnd = zoomRoot ? outline.subtreeEnd(zoomStart) : outline.size();
  if (target <= zoomStart || target >= zoomEnd) return null;
  const ranges = ids.map(id => {
    const start = outline.indexOf(id);
    return { start, end: start < 0 ? start : outline.subtreeEnd(start) };
  });
  if (ranges.some(range => range.start <= zoomStart || range.start >= zoomEnd)) return null;
  const moved = (id: string) => {
    const index = outline.indexOf(id);
    return index >= 0 && ranges.some(range => index >= range.start && index < range.end);
  };
  if (moved(targetId)) return null;
  const minimum = zoomRoot ? outline.depth(zoomRoot) + 1 : 0;
  depth = Math.max(minimum, Math.min(outline.depth(targetId) + 1, depth));
  let anchorId = targetId;
  if (depth > outline.depth(targetId)) return { parentId: targetId, after: null, depth, anchorId, edge: 'child' };
  while (outline.depth(anchorId) > depth) anchorId = outline.parentOf(anchorId);
  if (moved(anchorId)) return null;
  const parentId = outline.parentOf(anchorId);
  if (moved(parentId) || parentId !== pageId && outline.indexOf(parentId) < 0) return null;
  const siblings = outline.children(parentId);
  let index = siblings.indexOf(anchorId) - (before ? 1 : 0);
  while (index >= 0 && moved(siblings[index]!)) index--;
  return { parentId, after: siblings[index] ?? null, depth, anchorId, edge: before ? 'before' : 'after' };
}

export interface OutlineDropIndicator extends OutlineDrop { top: number; left: number }
export interface OutlineDrag {
  start(event: PointerEvent, id: string): void;
  dragging: Accessor<boolean>;
  indicator: Accessor<OutlineDropIndicator | null>;
}
interface Gesture {
  pointerId: number;
  id: string;
  ids: string[];
  zoomRoot: string | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
  cancelled: boolean;
}

/** Pointer events also work in WKWebView, unlike native HTML drag and drop. */
export function createOutlineDrag(context: Pick<OutlineContext,
  | 'doc' | 'scroll' | 'zoom' | 'baseDepth' | 'selectedSet' | 'coveredSet'
  | 'roots' | 'rowFocus' | 'editing' | 'composition' | 'setMenu' | 'setFolds' | 'apply'
  | 'ids' | 'virtualizer' | 'margin'
>): OutlineDrag {
  const [dragging, setDragging] = createSignal(false);
  const [indicator, setIndicator] = createSignal<OutlineDropIndicator | null>(null);
  let gesture: Gesture | null = null;
  let frame = 0;
  let previousFrame = 0;
  let suppressClick = false;
  let clickTimer = 0;
  let visibleIds: readonly string[] | null = null;
  const visibleBounds = new Map<string, { first: number; last: number }>();

  function update() {
    const state = gesture;
    if (!state || !state.dragging || state.cancelled || context.zoom() !== state.zoomRoot) { setIndicator(null); return; }
    const scroll = context.scroll;
    const viewport = scroll.getBoundingClientRect();
    if (state.x < viewport.left || state.x > viewport.right || state.y < viewport.top || state.y > viewport.bottom) { setIndicator(null); return; }
    const rows = Array.from(scroll.querySelectorAll<HTMLElement>('.outline-row[data-block-id]'));
    let target: HTMLElement | null = null;
    let distance = Infinity;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      const next = Math.max(rect.top - state.y, state.y - rect.bottom, 0);
      if (next < distance) { target = row; distance = next; }
    }
    const list = target?.closest<HTMLElement>('.outline-list');
    const body = target?.querySelector<HTMLElement>('.outline-body');
    if (!target || !list || !body) { setIndicator(null); return; }
    const targetId = target.dataset.blockId!;
    const targetDepth = context.doc.outline.depth(targetId);
    const indent = Number.parseFloat(getComputedStyle(target).getPropertyValue('--indent-width'));
    const bodyLeft = body.getBoundingClientRect().left;
    const depth = targetDepth + Math.round((state.x - bodyLeft) / indent);
    const rect = target.getBoundingClientRect();
    const destination = outlineDrop(context.doc.outline, context.doc.pageId, state.ids, targetId, depth, state.y < rect.top + rect.height / 2, state.zoomRoot);
    if (!destination) { setIndicator(null); return; }
    const visible = context.ids();
    if (visible !== visibleIds) {
      visibleIds = visible;
      visibleBounds.clear();
      for (let index = 0; index < visible.length; index++) {
        let id = visible[index]!;
        while (id !== context.doc.pageId) {
          const bounds = visibleBounds.get(id);
          if (bounds) bounds.last = index;
          else visibleBounds.set(id, { first: index, last: index });
          id = context.doc.outline.parentOf(id);
        }
      }
    }
    const bounds = visibleBounds.get(destination.anchorId);
    const item = bounds ? context.virtualizer.measurementsCache[destination.edge === 'after' ? bounds.last : bounds.first] : undefined;
    if (!item) { setIndicator(null); return; }
    const listRect = list.getBoundingClientRect();
    setIndicator({ ...destination, top: (destination.edge === 'before' ? item.start : item.end) - context.margin(),
      left: bodyLeft - listRect.left + (destination.depth - targetDepth) * indent });
  }

  function tick(time: number) {
    const state = gesture;
    if (!state?.dragging || state.cancelled) return;
    const scroll = context.scroll;
    const rect = scroll.getBoundingClientRect();
    const elapsed = previousFrame ? Math.min(32, time - previousFrame) : 16;
    previousFrame = time;
    if (state.x >= rect.left && state.x <= rect.right) {
      const edge = Math.min(48, rect.height / 4);
      const speed = state.y < rect.top + edge ? -Math.min(1, (rect.top + edge - state.y) / edge)
        : state.y > rect.bottom - edge ? Math.min(1, (state.y - rect.bottom + edge) / edge) : 0;
      if (speed) scroll.scrollTop += speed * elapsed * .75;
    }
    update();
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(frame);
    previousFrame = 0;
    if (gesture && context.scroll.hasPointerCapture(gesture.pointerId)) context.scroll.releasePointerCapture(gesture.pointerId);
    gesture = null;
    setDragging(false);
    setIndicator(null);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
  }

  function move(event: PointerEvent) {
    const state = gesture;
    if (!state || event.pointerId !== state.pointerId || state.cancelled) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.dragging) {
      if (Math.hypot(state.x - state.startX, state.y - state.startY) < 6) return;
      state.dragging = true;
      context.scroll.setPointerCapture(state.pointerId);
      context.setMenu(null);
      if (context.editing() || !context.selectedSet().has(state.id) && !context.coveredSet().has(state.id)) context.rowFocus(state.id);
      context.scroll.focus({ preventScroll: true });
      setDragging(true);
      frame = requestAnimationFrame(tick);
    }
    event.preventDefault();
    event.stopPropagation();
    update();
  }

  function end(event: PointerEvent) {
    const state = gesture;
    if (!state || event.pointerId !== state.pointerId) return;
    if (state.dragging) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => { suppressClick = false; }, 0);
      state.x = event.clientX;
      state.y = event.clientY;
      update();
      const destination = indicator();
      if (!state.cancelled && destination) {
        const result = context.apply({ kind: 'moveTo', ids: state.ids, parentId: destination.parentId, after: destination.after }, false);
        if (result?.ok && destination.edge === 'child') context.setFolds(previous => { const next = new Set(previous); next.delete(destination.parentId); return next; });
      }
    }
    stop();
  }

  function cancel(event: Event) {
    if (event instanceof PointerEvent && event.pointerId !== gesture?.pointerId) return;
    stop();
  }
  function key(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !gesture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    gesture.cancelled = true;
    gesture.dragging = true;
    cancelAnimationFrame(frame);
    setDragging(false);
    setIndicator(null);
  }
  function click(event: MouseEvent) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function start(event: PointerEvent, id: string) {
    if (!event.isPrimary || event.button !== 0 || context.composition()) return;
    stop();
    suppressClick = false;
    const ids = context.selectedSet().has(id) || context.coveredSet().has(id) ? context.roots() : [id];
    const zoomRoot = context.zoom();
    const minimum = context.baseDepth();
    if (!ids.length || ids.some(id => context.doc.outline.depth(id) < minimum || id === zoomRoot)) return;
    gesture = { pointerId: event.pointerId, id, ids, zoomRoot, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, dragging: false, cancelled: false };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
  }

  onMount(() => window.addEventListener('click', click, true));
  onCleanup(() => { stop(); clearTimeout(clickTimer); window.removeEventListener('click', click, true); });
  return { start, dragging, indicator };
}
