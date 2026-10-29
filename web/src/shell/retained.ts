import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { motionMilliseconds } from './motion';

export type Retained<T> = { value: T; leaving: boolean };

/**
 * Keeps a surface mounted through its exit animation. `source` is what the surface shows, or a falsy value once it
 * should go; the result stays set, with `leaving` true, for one `--motion-ui` after that so the surface can play an
 * exit before it unmounts. Use it where a bare `<Show>` would remove the surface in one frame.
 */
export function createRetained<T>(source: () => T | undefined | null | false, milliseconds = () => motionMilliseconds()) {
  const initial = untrack(source);
  const [held, setHeld] = createSignal<Retained<T> | undefined>(initial ? { value: initial, leaving: false } : undefined);
  createEffect(() => {
    const value = source();
    if (value) { setHeld({ value, leaving: false }); return; }
    const current = untrack(held);
    if (!current) return;
    if (!current.leaving) setHeld({ value: current.value, leaving: true });
    const wait = milliseconds();
    if (wait <= 0) { setHeld(undefined); return; }
    const timer = setTimeout(() => setHeld(undefined), wait);
    onCleanup(() => clearTimeout(timer));
  });
  return held;
}
