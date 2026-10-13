import { createSignal } from 'solid-js';
import type { Accessor, Signal } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { BatchSubtree, Block } from '../api/types';

export interface LiveSubtree {
  value: Accessor<BatchSubtree | undefined>;
  error: Accessor<string>;
  release(): void;
}
type Entry = {
  value: Signal<BatchSubtree | undefined>;
  error: Signal<string>;
  holds: number;
  dependencies: string[];
};

/** Mounted embeds share one microtask-batched read; publications invalidate only
 * trees containing the changed block or its parent. No page documents are opened. */
export class SubtreeCache {
  private entries = new Map<string, Entry>();
  private dependents = new Map<string, Set<string>>();
  private pending = new Set<string>();
  private scheduled = false;
  private closed = false;
  constructor(private api: ApiClient, private seed: (block: Block) => void) {}
  watch(id: string): LiveSubtree {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { value: createSignal<BatchSubtree>(), error: createSignal(''), holds: 0, dependencies: [] };
      this.entries.set(id, entry);
      this.index(id, entry, [id]);
      this.request(id);
    }
    entry.holds++;
    let released = false;
    return { value: entry.value[0], error: entry.error[0], release: () => {
      if (released) return;
      released = true;
      if (--entry.holds === 0) { this.index(id, entry, []); this.entries.delete(id); this.pending.delete(id); }
    } };
  }
  changed(block: Block | null, id: string) {
    for (const target of this.dependents.get(id) ?? []) this.request(target);
    if (block?.parent_id) for (const target of this.dependents.get(block.parent_id) ?? []) this.request(target);
  }
  private index(id: string, entry: Entry, dependencies: string[]) {
    for (const key of entry.dependencies) {
      const targets = this.dependents.get(key);
      targets?.delete(id);
      if (!targets?.size) this.dependents.delete(key);
    }
    entry.dependencies = dependencies;
    for (const key of dependencies) {
      let targets = this.dependents.get(key);
      if (!targets) this.dependents.set(key, targets = new Set());
      targets.add(id);
    }
  }
  private request(id: string) {
    if (this.closed) return;
    this.pending.add(id);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { void this.load(); });
  }
  private async load() {
    const ids = [...this.pending].slice(0, 256);
    const entries = new Map(ids.map(id => [id, this.entries.get(id)]));
    for (const id of ids) this.pending.delete(id);
    try {
      const result = await this.api.subtrees(ids);
      if (this.closed) return;
      for (const tree of result.trees) {
        const entry = this.entries.get(tree.id);
        if (!entry || entry !== entries.get(tree.id)) continue;
        if (tree.page) this.seed(tree.page);
        for (const row of tree.rows) this.seed(row.block);
        this.index(tree.id, entry, [tree.id, ...(tree.page ? [tree.page.id] : []), ...tree.rows.map(row => row.block.id)]);
        entry.value[1](tree);
        entry.error[1]('');
      }
    } catch (reason) {
      if (!this.closed) for (const [id, entry] of entries) if (entry && this.entries.get(id) === entry) entry.error[1](reason instanceof Error ? reason.message : String(reason));
    } finally {
      this.scheduled = false;
      if (this.pending.size) this.request(this.pending.values().next().value!);
    }
  }
  dispose() { this.closed = true; this.entries.clear(); this.dependents.clear(); this.pending.clear(); }
}
