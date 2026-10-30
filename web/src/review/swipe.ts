import type { Grade } from '../api/types';
import { haptic } from '../ui/haptics';

export type SwipeGrade = Extract<Grade, 'again' | 'good'>;
export type SwipeAxis = 'x' | 'y' | null;

/** How far a touch travels before it says which way it is going. */
export const axisSlop = 10;
/** A touch this close to the screen's edge belongs to the shell's back gesture. */
export const edgeGuard = 24;

/** A third of the card's width, and never less than 80 px, before a release grades. */
export function commitDistance(width: number): number {
  return Math.max(80, width / 3);
}

/**
 * Which way a drag is going once it has moved: horizontal only when it clearly leads, so a thumb scrolling a tall card
 * or drifting sideways never grades. `null` while it is still inside the slop.
 */
export function lockAxis(dx: number, dy: number): SwipeAxis {
  const across = Math.abs(dx), down = Math.abs(dy);
  if (Math.max(across, down) < axisSlop) return null;
  return across > down * 1.5 ? 'x' : 'y';
}

/** Right is Good and left is Again, once the drag has travelled the commit distance. Hard and Easy have no gesture. */
export function swipeGrade(dx: number, width: number): SwipeGrade | null {
  if (Math.abs(dx) < commitDistance(width)) return null;
  return dx > 0 ? 'good' : 'again';
}

export interface SwipeOptions {
  /** False holds the gesture shut (the answer is hidden, a write is in flight, the layout is not a phone). */
  enabled(): boolean;
  /** The drag's travel and the grade a release would give right now. */
  onDrag(dx: number, armed: SwipeGrade | null): void;
  onCommit(grade: SwipeGrade, dx: number): void;
  /** A drag released short of the threshold, or interrupted. */
  onCancel(): void;
}

/**
 * Lets a thumb grade a card by dragging it sideways. The first move decides the axis: a vertical drag is handed to the
 * scroller (the element sets `touch-action: pan-y`), a horizontal one is followed with a light haptic where a release
 * would commit. Returns its cleanup.
 */
export function attachSwipe(element: HTMLElement, options: SwipeOptions): () => void {
  let drag: { id: number; x: number; y: number; dx: number; locked: boolean } | null = null;
  let armed: SwipeGrade | null = null;

  const end = (commit: boolean) => {
    const current = drag;
    drag = null;
    if (!current?.locked) return;
    const grade = armed;
    armed = null;
    if (commit && grade) options.onCommit(grade, current.dx); else options.onCancel();
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType === 'mouse' || !options.enabled()) return;
    if (event.clientX < edgeGuard || event.clientX > window.innerWidth - edgeGuard) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, locked: false };
    armed = null;
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!options.enabled()) { end(false); return; }
    const dx = event.clientX - drag.x;
    if (!drag.locked) {
      const axis = lockAxis(dx, event.clientY - drag.y);
      if (axis === null) return;
      if (axis === 'y') { drag = null; return; }
      drag.locked = true;
      element.setPointerCapture(event.pointerId);
    }
    drag.dx = dx;
    const next = swipeGrade(dx, element.clientWidth);
    if (next && next !== armed) haptic('light');
    armed = next;
    options.onDrag(dx, next);
  };
  const up = (event: PointerEvent) => { if (drag && event.pointerId === drag.id) end(true); };
  const cancel = (event: PointerEvent) => { if (drag && event.pointerId === drag.id) end(false); };

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', cancel);
  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', cancel);
  };
}
