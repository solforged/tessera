import { haptic } from '../ui/haptics';

/** A task row's phone swipe: a swipe right completes; a swipe left shows Pick date and Tomorrow, and a full swipe left
 * commits Tomorrow. The decisions are pure functions of the finger's travel, so they can be tested; `attachRowSwipe` is the
 * gesture that feeds them. */

/** How far the finger travels, in px, before the gesture picks its axis. */
export const AXIS_LOCK = 10;
/** A swipe must be this much more horizontal than vertical to be a swipe; anything steeper is the page scrolling. */
export const HORIZONTAL_BIAS = 1.5;
/** A touch that starts this close to the left edge belongs to the shell's back gesture (shell/phone-gestures.ts). */
export const EDGE_BACK = 24;
/** The revealed Pick date and Tomorrow buttons: each is 82 px wide, 6 px apart, 8 px in from the row's right edge. */
export const ACTION_WIDTH = 82;
export const ACTION_GAP = 6;
export const ACTION_INSET = 8;
/** A release past this much of the row's width commits: Done to the right, Tomorrow to the left. */
export const DONE_COMMIT = 0.32;
export const TOMORROW_COMMIT = 0.55;
/** A release this far left, or a flick (px per ms) past `FLICK_FROM`, leaves the buttons showing. */
export const REVEAL_FROM = 40;
export const FLICK = 0.5;
export const FLICK_FROM = 16;

export type SwipeAxis = 'pending' | 'horizontal' | 'vertical';
export type SwipeCommit = 'done' | 'tomorrow';

/** What a row offers to the swipe, read when a touch starts. */
export interface SwipeLayout {
  /** The row's width. */
  width: number;
  /** A swipe right completes the task. */
  done: boolean;
  /** A swipe left shows Pick date. */
  trailing: boolean;
  /** The trailing buttons include Tomorrow, which a full swipe commits. */
  tomorrow: boolean;
}

/** The width the trailing buttons take: Pick date alone, or Pick date and Tomorrow. */
export function actionsWidth(layout: Pick<SwipeLayout, 'tomorrow'>): number {
  return ACTION_INSET + ACTION_WIDTH + (layout.tomorrow ? ACTION_GAP + ACTION_WIDTH : 0);
}

/** Which way a touch is going once it has moved `AXIS_LOCK`. A touch that is not clearly sideways is the page scrolling, so
 * the swipe never takes a gesture the scroller might want. */
export function lockAxis(dx: number, dy: number): SwipeAxis {
  const x = Math.abs(dx), y = Math.abs(dy);
  if (x < AXIS_LOCK && y < AXIS_LOCK) return 'pending';
  return x >= AXIS_LOCK && x > y * HORIZONTAL_BIAS ? 'horizontal' : 'vertical';
}

/** Where the row's face sits for a finger `raw` px from where the row rests (left is negative): free where the swipe has
 * an action, and with growing resistance where it has none. */
export function swipeOffset(raw: number, layout: SwipeLayout): number {
  const resist = (distance: number) => Math.min(28, distance * 0.25);
  if (raw >= 0) return layout.done ? Math.min(raw, layout.width) : resist(raw);
  if (!layout.trailing) return -resist(-raw);
  const open = actionsWidth(layout);
  if (-raw <= open) return raw;
  // Past the buttons: a full swipe follows the finger to the edge; without Tomorrow the row stops short of it.
  return layout.tomorrow ? Math.max(raw, -layout.width) : -(open + Math.min(28, (-raw - open) * 0.25));
}

/** The action a release at this offset would commit, if any. The haptic marks each change of this answer. */
export function commitAt(offset: number, layout: SwipeLayout): SwipeCommit | null {
  if (layout.done && offset >= layout.width * DONE_COMMIT) return 'done';
  if (layout.tomorrow && offset <= -layout.width * TOMORROW_COMMIT) return 'tomorrow';
  return null;
}

export type SwipeRelease = { kind: 'commit'; action: SwipeCommit } | { kind: 'open' } | { kind: 'close' };

/** What a release does: commit, leave the buttons showing, or put the row back. `velocity` is the finger's, in px per ms,
 * positive to the right. */
export function releaseSwipe(offset: number, velocity: number, layout: SwipeLayout): SwipeRelease {
  const action = commitAt(offset, layout);
  if (action) return { kind: 'commit', action };
  if (!layout.trailing || offset >= 0) return { kind: 'close' };
  const shown = -offset;
  return shown >= REVEAL_FROM || (velocity <= -FLICK && shown >= FLICK_FROM) ? { kind: 'open' } : { kind: 'close' };
}

export interface RowSwipeOptions {
  /** What the row offers right now; null while it offers nothing (a saving or finished row). */
  layout(): SwipeLayout | null;
  /** A full swipe, released past its threshold. */
  onCommit(action: SwipeCommit): void;
}

export interface RowSwipe {
  /** Puts the row back at rest, with the glide unless `instant`. */
  reset(instant?: boolean): void;
  /** Leaves the face where it is, parked past the row's edge, for a commit that carries the row away. */
  carryOff(direction: 1 | -1): void;
  destroy(): void;
}

/** The row that is showing its buttons: one at a time. */
let opened: RowSwipe | null = null;

/**
 * Wires the swipe onto a row. The row keeps `--swipe-x` (px, negative to the left) and these attributes, which the stylesheet
 * reads: `data-swiping` while the finger is down, `data-swipe-open` while the buttons rest open and `data-swipe-commit`
 * (`done` or `tomorrow`) while a release would commit. Touch only: it uses pointer events with the row's `touch-action: pan-y`,
 * so the page scrolls vertically as ever and a vertical start never becomes a swipe.
 */
export function attachRowSwipe(row: HTMLElement, options: RowSwipeOptions): RowSwipe {
  let gesture: { id: number; x: number; y: number; axis: SwipeAxis; layout: SwipeLayout; base: number; offset: number; lastX: number; lastTime: number; velocity: number; commit: SwipeCommit | null } | null = null;
  let rest = 0;
  let open = false;
  let swallow = 0;
  const set = (offset: number) => row.style.setProperty('--swipe-x', `${offset}px`);
  const mark = (commit: SwipeCommit | null) => commit ? row.setAttribute('data-swipe-commit', commit) : row.removeAttribute('data-swipe-commit');

  // While the buttons are showing, a touch outside the row, or the page scrolling, puts the row back.
  const outside = (event: Event) => { if (!(event.target instanceof Node) || !row.contains(event.target)) controller.reset(); };
  const watching = (on: boolean) => {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', outside, true);
    document[method]('scroll', outside, true);
  };
  const settle = (offset: number, resting: boolean) => {
    rest = offset; open = resting;
    row.toggleAttribute('data-swipe-open', resting);
    set(offset);
    if (resting) { opened = controller; watching(true); }
    else { if (opened === controller) opened = null; watching(false); }
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || gesture) return;
    if (event.target instanceof Element && event.target.closest('.agenda-swipe button, input, textarea, [contenteditable="true"]')) return;
    if (!open && event.clientX <= EDGE_BACK) return;
    if (document.querySelector('.popup, .popup-exit, .context-layer')) return;
    const layout = options.layout();
    if (!layout) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: 'pending', layout, base: rest, offset: rest, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0, commit: null };
  };
  const move = (event: PointerEvent) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (current.axis === 'pending') {
      current.axis = lockAxis(dx, dy);
      if (current.axis === 'vertical') { gesture = null; return; }
      if (current.axis === 'horizontal') {
        row.toggleAttribute('data-swiping', true);
        try { row.setPointerCapture(event.pointerId); } catch { /* The touch already ended. */ }
      }
    }
    if (current.axis !== 'horizontal') return;
    const elapsed = Math.max(1, event.timeStamp - current.lastTime);
    current.velocity = 0.6 * current.velocity + 0.4 * ((event.clientX - current.lastX) / elapsed);
    current.lastX = event.clientX; current.lastTime = event.timeStamp;
    current.offset = swipeOffset(current.base + dx, current.layout);
    set(current.offset);
    const commit = commitAt(current.offset, current.layout);
    if (commit !== current.commit) { current.commit = commit; mark(commit); haptic('light'); }
  };
  const finish = (event: PointerEvent) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    gesture = null;
    row.toggleAttribute('data-swiping', false);
    mark(null);
    if (current.axis !== 'horizontal') return;
    // The release may still produce a click on whatever lies under the finger; the swipe has used it up.
    window.clearTimeout(swallow);
    swallow = window.setTimeout(() => { swallow = 0; }, 400);
    if (event.type === 'pointercancel') { controller.reset(); return; }
    const outcome = releaseSwipe(current.offset, current.velocity, current.layout);
    if (outcome.kind === 'commit') { options.onCommit(outcome.action); return; }
    if (outcome.kind === 'open') settle(-actionsWidth(current.layout), true);
    else settle(0, false);
  };
  // A tap on an open row's face only closes it; the swipe's own release does not act on what lies under the finger.
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !row.contains(event.target) || event.target.closest('.agenda-swipe')) return;
    if (!swallow && !open) return;
    event.preventDefault(); event.stopPropagation();
    if (!swallow) controller.reset();
  };

  const controller: RowSwipe = {
    reset(instant) {
      gesture = null;
      row.toggleAttribute('data-swiping', !!instant);
      mark(null);
      settle(0, false);
      if (instant) requestAnimationFrame(() => row.toggleAttribute('data-swiping', false));
    },
    carryOff(direction) {
      mark(null);
      settle(direction * row.clientWidth, false);
    },
    destroy() {
      watching(false);
      if (opened === controller) opened = null;
      window.clearTimeout(swallow);
      row.removeEventListener('pointerdown', down);
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', finish);
      row.removeEventListener('pointercancel', finish);
      window.removeEventListener('click', click, true);
    },
  };
  row.addEventListener('pointerdown', down);
  row.addEventListener('pointermove', move);
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
  window.addEventListener('click', click, true);
  return controller;
}
