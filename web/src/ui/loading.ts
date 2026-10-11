import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import type { NotebookClient } from '../document/contract';

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
 */
export function createSettledChanges(notebook: Pick<NotebookClient, 'changeSequence' | 'lastChange'>): () => number {
  const [settled, setSettled] = createSignal(0);
  createEffect(on(() => [notebook.changeSequence(), notebook.lastChange()], () => {
    const timer = setTimeout(() => setSettled(value => value + 1), slowLoadDelay);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  return settled;
}

/**
 * Signal equality for API results: a background refetch that returns the same data keeps the old value,
 * so nothing downstream re-renders. Results are plain JSON, so their serialisations compare them exactly.
 */
export function sameData<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
