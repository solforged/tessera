import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { phoneQuery } from '../ui/phone';

/** Whether the phone layout applies, following the window as it changes. */
export function createPhone(): Accessor<boolean> {
  const query = window.matchMedia(phoneQuery);
  const [phone, setPhone] = createSignal(query.matches);
  const change = () => setPhone(query.matches);
  query.addEventListener('change', change);
  onCleanup(() => query.removeEventListener('change', change));
  return phone;
}

/** A sideways drag must travel this far, and mostly sideways, to change the day. */
export const swipeDistance = 56;
/** The strip at the screen's left edge belongs to the shell's back gesture. */
export const swipeEdge = 24;

/** The day a finger's drag moves to: a swipe left reads on to the next day, a swipe right back to the one before. */
export function daySwipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < swipeDistance || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

/** Day-to-day swiping on one element, nowhere else, so rows below keep their own swipes. Returns its cleanup. */
export function installDaySwipe(element: HTMLElement, step: (days: -1 | 1) => void): () => void {
  let start: { id: number; x: number; y: number } | undefined;
  const begin = (event: TouchEvent) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch && touch.clientX > swipeEdge ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : undefined;
  };
  const cancel = () => { start = undefined; };
  const end = (event: TouchEvent) => {
    const current = start;
    start = undefined;
    const touch = current && [...event.changedTouches].find(value => value.identifier === current.id);
    if (!current || !touch) return;
    const days = daySwipeStep(touch.clientX - current.x, touch.clientY - current.y);
    if (days) step(days);
  };
  element.addEventListener('touchstart', begin, { passive: true });
  element.addEventListener('touchend', end, { passive: true });
  element.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    element.removeEventListener('touchstart', begin);
    element.removeEventListener('touchend', end);
    element.removeEventListener('touchcancel', cancel);
  };
}
