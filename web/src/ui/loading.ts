import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import type { ChangeEvent, Topic } from '../api/types';

/** Loading notices wait this long, so fast local reads never flash a message before their content. */
export const slowLoadDelay = 300;

/** True once `waiting` has held for `slowLoadDelay`; false again as soon as it stops. */
export function createSlowFlag(waiting: () => boolean): () => boolean {
  const [slow, setSlow] = createSignal(false);
  createEffect(() => {
    setSlow(false);
    if (!waiting()) return;
    const timer = setTimeout(() => setSlow(true), slowLoadDelay);
    onCleanup(() => clearTimeout(timer));
  });
  return slow;
}

/**
 * A counter that ticks once committed changes pause for `slowLoadDelay`. Views that refetch summaries after edits
 * read it instead of `changeSequence`, so typing costs one refresh per pause rather than one per saved keystroke.
 * With `topics`, only changes to those topics count.
 */
export function createSettledChanges(
  workshop: {
    changeSequence(): number;
    lastChange(): ChangeEvent | null;
    changed(topic: Topic): number;
  },
  topics?: readonly Topic[],
): () => number {
  const [settled, setSettled] = createSignal(0);
  createEffect(
    on(
      () =>
        topics ? topics.map(topic => workshop.changed(topic)) : [workshop.changeSequence(), workshop.lastChange()],
      () => {
        const timer = setTimeout(() => setSettled(value => value + 1), slowLoadDelay);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );
  return settled;
}

/**
 * Signal equality for API results: a background refetch that returns the same data keeps the old value,
 * so nothing downstream re-renders. Results are plain JSON, so their serialisations compare them exactly.
 */
export function sameData<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
