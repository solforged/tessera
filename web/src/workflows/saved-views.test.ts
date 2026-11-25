import { describe, expect, mock, test } from 'bun:test';
import type * as Solid from 'solid-js';
import type { Operation, Topic } from '../api/types';

// Dynamic imports are intentional here: mock Solid's SSR boundary before loading its consumers.
const browserEntry = 'solid-js/dist/solid.js';
const solid = (await import(browserEntry)) as typeof Solid;
mock.module('solid-js', () => solid);
const { createRoot, createSignal } = await import('solid-js');
const { createTopicQuery } = await import('../ui/loading');
const { createSavedViewController } = await import('./saved-view-controller');

function fakeWorkshop() {
  const [seq, setSeq] = createSignal(0);
  const topicSignals = new Map<Topic, ReturnType<typeof createSignal<number>>>();
  const signalFor = (topic: Topic) => {
    let entry = topicSignals.get(topic);
    if (!entry) {
      entry = createSignal(0);
      topicSignals.set(topic, entry);
    }
    return entry;
  };
  const committed: { operations: Operation[]; reason?: string }[] = [];
  return {
    committed,
    changeSequence: seq,
    changed: (topic: Topic) => signalFor(topic)[0](),
    bump(topic?: Topic) {
      setSeq(value => value + 1);
      if (topic) signalFor(topic)[1](value => value + 1);
    },
    async commit(operations: Operation[], reason?: string) {
      committed.push({ operations, reason });
      setSeq(value => value + 1);
      signalFor('views')[1](value => value + 1);
      return {};
    },
  };
}

describe('createTopicQuery', () => {
  test('aborts superseded fetches, serves warm cache entries and isolates topics', async () => {
    const workshop = fakeWorkshop();
    const cache = new Map<string, { label: string }>();
    const signals: AbortSignal[] = [];
    const resolvers = new Map<string, (value: { label: string }) => void>();
    const [key, setKey] = createSignal<string | null>('inbox');

    let dispose!: () => void;
    const query = createRoot(d => {
      dispose = d;
      return createTopicQuery({
        workshop,
        topics: ['library'],
        key,
        cache,
        cacheKey: value => value,
        fetcher: (value, signal) => {
          signals.push(signal);
          return new Promise<{ label: string }>(resolve => {
            resolvers.set(value, resolve);
          });
        },
      });
    });

    try {
      await Promise.resolve();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);

      // Switching keys aborts the in-flight request for 'inbox'.
      setKey('reading');
      await Promise.resolve();
      expect(signals).toHaveLength(2);
      expect(signals[0]!.aborted).toBe(true);

      resolvers.get('reading')!({ label: 'Reading books' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(query.data()).toEqual({ label: 'Reading books' });

      // Unrelated topic commits do not trigger a refetch.
      workshop.bump('tasks');
      await Promise.resolve();
      expect(signals).toHaveLength(2);

      // Disabling clears data; re-selecting 'reading' seeds immediately from the warm cache.
      setKey(null);
      await Promise.resolve();
      expect(query.data()).toBeUndefined();
      setKey('reading');
      await Promise.resolve();
      expect(query.data()).toEqual({ label: 'Reading books' });
      expect(signals).toHaveLength(3);
    } finally {
      dispose();
      expect(signals.at(-1)!.aborted).toBe(true);
    }
  });
});

describe('createSavedViewController', () => {
  test('saves, deletes with undo retention and restores saved views', async () => {
    const workshop = fakeWorkshop();
    type Item = { id: string; name: string; revision: number; query: { text: string } };
    const store = new Map<string, Item>([['v1', { id: 'v1', name: 'Active', revision: 1, query: { text: 'open' } }]]);
    const [viewId, setViewId] = createSignal<string | null>('v1');

    let dispose!: () => void;
    const controller = createRoot(d => {
      dispose = d;
      return createSavedViewController<Item, { text: string }>({
        workshop,
        topic: 'views',
        viewId,
        deleteUndoMs: 50,
        list: async () => [...store.values()],
        get: async id => {
          const found = store.get(id);
          if (!found) throw new Error('Missing view');
          return found;
        },
        saveOperation: ({ id, baseRevision, name, query }) => ({
          op: 'save_view',
          id,
          base_revision: baseRevision,
          name,
          query: query as never,
        }),
        deleteOperation: ({ id, baseRevision }) => ({
          op: 'delete_view',
          id,
          base_revision: baseRevision,
        }),
      });
    });

    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(controller.views().map(item => item.name)).toEqual(['Active']);
      expect(controller.saved()?.name).toBe('Active');

      // Save a new view.
      store.set('v2', { id: 'v2', name: 'Archive', revision: 1, query: { text: 'done' } });
      const createdId = await controller.save({
        id: 'v2',
        name: '  Archive  ',
        query: { text: 'done' },
        reason: 'Save view',
      });
      expect(createdId).toBe('v2');
      expect(workshop.committed.at(-1)?.operations[0]).toMatchObject({
        op: 'save_view',
        id: 'v2',
        base_revision: null,
        name: 'Archive',
      });

      // Delete 'v1' and verify undo window + restore.
      const v1 = store.get('v1')!;
      store.delete('v1');
      setViewId(null);
      const removed = await controller.remove(v1, 'Delete view');
      expect(removed).toBe(true);
      expect(controller.deleted()?.id).toBe('v1');

      store.set('v1', v1);
      const restored = await controller.undoDelete('Restore view');
      expect(restored?.id).toBe('v1');
      expect(controller.deleted()).toBeNull();
    } finally {
      dispose();
    }
  });
});
