import { createSignal } from 'solid-js';
import type { OutlineReader } from './contract';

export interface OutlineRow { id: string; parentId: string; depth: number }
interface Item {
  row: OutlineRow;
  priority: number;
  left: Item | null;
  right: Item | null;
  parent: Item | null;
  size: number;
  minimumDepth: number;
}
function update(item: Item) {
  item.size = 1 + (item.left?.size ?? 0) + (item.right?.size ?? 0);
  item.minimumDepth = Math.min(item.row.depth, item.left?.minimumDepth ?? Infinity, item.right?.minimumDepth ?? Infinity);
}
function merge(left: Item | null, right: Item | null): Item | null {
  if (!left) { if (right) right.parent = null; return right; }
  if (!right) { left.parent = null; return left; }
  if (left.priority < right.priority) {
    left.right = merge(left.right, right);
    if (left.right) left.right.parent = left;
    left.parent = null;
    update(left);
    return left;
  }
  right.left = merge(left, right.left);
  if (right.left) right.left.parent = right;
  right.parent = null;
  update(right);
  return right;
}
function split(root: Item | null, count: number): [Item | null, Item | null] {
  if (!root) return [null, null];
  const leftSize = root.left?.size ?? 0;
  if (count <= leftSize) {
    const [left, remaining] = split(root.left, count);
    root.left = remaining;
    if (remaining) remaining.parent = root;
    root.parent = null;
    update(root);
    return [left, root];
  }
  const [remaining, right] = split(root.right, count - leftSize - 1);
  root.right = remaining;
  if (remaining) remaining.parent = root;
  root.parent = null;
  update(root);
  return [root, right];
}
function visit(root: Item | null, action: (item: Item) => void) {
  if (!root) return;
  visit(root.left, action);
  action(root);
  visit(root.right, action);
}
function refresh(root: Item | null) {
  if (!root) return;
  refresh(root.left);
  refresh(root.right);
  update(root);
}

/** Adapted from spike 2's implicit treap. Text does not live in the index. */
export class OutlineIndex implements OutlineReader {
  private tree: Item | null = null;
  private byId = new Map<string, Item>();
  private childIds = new Map<string, string[]>();
  private change = createSignal(0);
  version = this.change[0];
  constructor(private rootId: string) {}
  size() { this.version(); return this.tree?.size ?? 0; }
  idAt(index: number) { this.version(); return this.at(index).id; }
  depth(id: string) { this.version(); return this.byId.get(id)?.row.depth ?? -1; }
  parentOf(id: string) { this.version(); return this.byId.get(id)?.row.parentId ?? this.rootId; }
  children(id: string): readonly string[] { this.version(); return this.childIds.get(id) ?? []; }
  at(index: number): OutlineRow {
    let item = this.tree;
    while (item) {
      const left = item.left?.size ?? 0;
      if (index === left) return item.row;
      if (index < left) item = item.left;
      else { index -= left + 1; item = item.right; }
    }
    throw new RangeError('Outline index is out of range');
  }
  indexOf(id: string) {
    this.version();
    let item = this.byId.get(id);
    if (!item) return -1;
    let index = item.left?.size ?? 0;
    while (item.parent) {
      if (item === item.parent.right) index += 1 + (item.parent.left?.size ?? 0);
      item = item.parent;
    }
    return index;
  }
  slice(start: number, end: number): OutlineRow[] {
    const rows: OutlineRow[] = [];
    const collect = (item: Item | null, base: number) => {
      if (!item || base >= end || base + item.size <= start) return;
      const position = base + (item.left?.size ?? 0);
      collect(item.left, base);
      if (position >= start && position < end) rows.push({ ...item.row });
      collect(item.right, position + 1);
    };
    collect(this.tree, 0);
    return rows;
  }
  /** Visits rows in order without copying them, for walks over the whole page. Callers must not mutate rows. */
  each(start: number, end: number, visit: (row: Readonly<OutlineRow>) => void) {
    const walk = (item: Item | null, base: number) => {
      if (!item || base >= end || base + item.size <= start) return;
      const position = base + (item.left?.size ?? 0);
      walk(item.left, base);
      if (position >= start && position < end) visit(item.row);
      walk(item.right, position + 1);
    };
    walk(this.tree, 0);
  }
  subtreeEnd(index: number) {
    this.version();
    const start = index + 1;
    const depth = this.at(index).depth;
    const find = (item: Item | null, base: number): number => {
      if (!item || base + item.size <= start || item.minimumDepth > depth) return -1;
      const position = base + (item.left?.size ?? 0);
      const left = find(item.left, base);
      if (left >= 0) return left;
      if (position >= start && item.row.depth <= depth) return position;
      return find(item.right, position + 1);
    };
    const found = find(this.tree, 0);
    return found < 0 ? this.size() : found;
  }
  previousSibling(id: string): string | null {
    const siblings = this.children(this.parentOf(id));
    return siblings[siblings.indexOf(id) - 1] ?? null;
  }
  replace(rows: OutlineRow[]) {
    const old = this.slice(0, this.size());
    if (old.length === rows.length && old.every((row, i) => row.id === rows[i]!.id && row.parentId === rows[i]!.parentId && row.depth === rows[i]!.depth)) return;
    this.byId.clear();
    this.childIds.clear();
    this.tree = this.build(rows);
    this.changed();
  }
  splice(at: number, remove: number, rows: OutlineRow[]) {
    const [before, rest] = split(this.tree, at);
    const [removed, after] = split(rest, remove);
    visit(removed, item => {
      this.byId.delete(item.row.id);
      const siblings = this.childIds.get(item.row.parentId);
      if (siblings) siblings.splice(siblings.indexOf(item.row.id), 1);
    });
    this.tree = merge(merge(before, this.build(rows)), after);
    this.reorderParents(new Set(rows.map(row => row.parentId)));
    this.changed();
  }
  move(id: string, parentId: string, after: string | null) {
    const from = this.indexOf(id);
    const end = this.subtreeEnd(from);
    const rows = this.slice(from, end);
    const depth = parentId === this.rootId ? 0 : this.depth(parentId) + 1;
    const delta = depth - rows[0]!.depth;
    this.splice(from, end - from, []);
    rows[0]!.parentId = parentId;
    for (const row of rows) row.depth += delta;
    const to = after ? this.subtreeEnd(this.indexOf(after)) : parentId === this.rootId ? 0 : this.indexOf(parentId) + 1;
    this.splice(to, 0, rows);
  }
  private changed() { this.change[1](value => value + 1); }
  private reorderParents(parents: Set<string>) {
    for (const parent of parents) this.childIds.get(parent)?.sort((a, b) => this.indexOf(a) - this.indexOf(b));
  }
  private build(rows: OutlineRow[]): Item | null {
    const stack: Item[] = [];
    let root: Item | null = null;
    for (const row of rows) {
      let priority = 2166136261;
      for (let i = 0; i < row.id.length; i++) priority = Math.imul(priority ^ row.id.charCodeAt(i), 16777619);
      priority ^= priority >>> 16;
      priority = Math.imul(priority, 0x7feb352d);
      priority ^= priority >>> 15;
      priority = Math.imul(priority, 0x846ca68b);
      priority = (priority ^ priority >>> 16) >>> 0;
      const item: Item = { row, priority, left: null, right: null, parent: null, size: 1, minimumDepth: row.depth };
      let last: Item | null = null;
      while (stack.length && stack[stack.length - 1]!.priority > priority) last = stack.pop()!;
      if (last) { item.left = last; last.parent = item; }
      if (stack.length) {
        const parent = stack[stack.length - 1]!;
        parent.right = item;
        item.parent = parent;
      } else root = item;
      stack.push(item);
      this.byId.set(row.id, item);
      const children = this.childIds.get(row.parentId) ?? [];
      children.push(row.id);
      this.childIds.set(row.parentId, children);
    }
    refresh(root);
    return root;
  }
}
