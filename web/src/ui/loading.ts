import { batch, createEffect, createSignal, on, onCleanup, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
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

export interface TopicQuerySource {
  changeSequence(): number;
  changed(topic: Topic): number;
}

export interface TopicQueryOptions<K, T> {
  workshop: TopicQuerySource;
  /** Topics whose commits invalidate this query; omit to refresh on every workshop change. */
  topics?: readonly Topic[];
  /** Query key; returning `false`, `null` or `undefined` disables fetching and clears `data` unless `keepPrevious` is set. */
  key: () => K | false | null | undefined;
  /** Async reader receiving the active key and an `AbortSignal` cancelled when superseded or disposed. */
  fetcher: (key: K, signal: AbortSignal) => Promise<T>;
  /** Initial value before the first fetch settles. */
  initial?: T;
  /** Optional warm cache keyed by `cacheKey(key)` so revisiting a tab or filter renders immediately while revalidating. */
  cache?: Map<string, T>;
  cacheKey?: (key: K) => string;
  /** Keep the previous value when `key()` becomes disabled. */
  keepPrevious?: boolean;
  /** Optional debounce delay in milliseconds (e.g. 0 on first load, 150 on search edits). */
  delay?: (key: K, previousKey: K | undefined, hasData: boolean) => number;
  /** Equality check for settled values; defaults to `sameData`. */
  equals?: false | ((prev: T, next: T) => boolean);
  /** Optional hook called inside `batch` whenever a fetch resolves. */
  onSuccess?: (value: T, key: K) => void;
  /** Optional hook called when a non-aborted fetch rejects. */
  onError?: (message: string, reason: unknown) => void;
}

export interface TopicQueryResult<T> {
  data: Accessor<T | undefined>;
  loading: Accessor<boolean>;
  error: Accessor<string>;
  setError: Setter<string>;
  mutate: Setter<T | undefined>;
  refresh: () => void;
}

/**
 * Reactive async query resource keyed by `key()` and workshop `topics`, with `AbortController` cancellation,
 * optional warm-cache seeding and optional debounce.
 */
export function createTopicQuery<K, T>(options: TopicQueryOptions<K, T>): TopicQueryResult<T> {
  const compare = options.equals || sameData;
  const [data, setData] = createSignal<T | undefined>(options.initial, {
    equals:
      options.equals === false
        ? false
        : (a, b) => {
            if (a === undefined || b === undefined) return a === b;
            return compare(a, b);
          },
  });
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [version, setVersion] = createSignal(0);
  let previousKey: K | undefined;
  let generation = 0;

  createEffect(() => {
    const activeKey = options.key();
    if (options.topics?.length) {
      for (const topic of options.topics) options.workshop.changed(topic);
    } else {
      options.workshop.changeSequence();
    }
    version();

    const current = ++generation;
    if (activeKey === false || activeKey === null || activeKey === undefined) {
      batch(() => {
        if (!options.keepPrevious) setData(undefined);
        setLoading(false);
        setError('');
      });
      return;
    }

    const cacheId = untrack(() =>
      options.cache ? (options.cacheKey ? options.cacheKey(activeKey) : JSON.stringify(activeKey)) : undefined,
    );
    if (options.cache && cacheId !== undefined && options.cache.has(cacheId) && untrack(data) === undefined) {
      setData(() => options.cache!.get(cacheId));
    }

    const waitMs = options.delay ? untrack(() => options.delay!(activeKey, previousKey, data() !== undefined)) : 0;
    previousKey = activeKey;

    const controller = new AbortController();
    setLoading(true);
    setError('');

    const run = () => {
      void options.fetcher(activeKey, controller.signal).then(
        result => {
          if (controller.signal.aborted || current !== generation) return;
          if (options.cache && cacheId !== undefined) options.cache.set(cacheId, result);
          batch(() => {
            setData(() => result);
            setError('');
            setLoading(false);
            options.onSuccess?.(result, activeKey);
          });
        },
        reason => {
          if (controller.signal.aborted || current !== generation) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          batch(() => {
            setError(message);
            setLoading(false);
            options.onError?.(message, reason);
          });
        },
      );
    };

    if (waitMs > 0) {
      const timer = setTimeout(run, waitMs);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    } else {
      run();
      onCleanup(() => controller.abort());
    }
  });

  return {
    data,
    loading,
    error,
    setError,
    mutate: setData,
    refresh: () => setVersion(value => value + 1),
  };
}
