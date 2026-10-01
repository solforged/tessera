import type { OutlineRow } from '@spike/shared';

interface Item {
  row: OutlineRow;
  priority: number;
  left: Item | null;
  right: Item | null;
  parent: Item | null;
  size: number;
  minimumDepth: number;
}
export interface OutlineReader {
  readonly length: number;
  at(index: number): OutlineRow;
  get(id: string): OutlineRow | undefined;
  indexOf(id: string): number;
  slice(start: number, end: number): OutlineRow[];
  subtreeEnd(index: number): number;
  previousBoundary(before: number, depth: number): number;
  nextBoundary(start: number, depth: number): number;
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

/** Implicit treap: keyed lookup/rank and subtree boundaries do not scan the page. */
export class OutlineIndex implements OutlineReader {
  private root: Item | null = null;
  private byId = new Map<string, Item>();
  constructor(rows: OutlineRow[]) { this.root = this.build(rows); }
  get length() { return this.root?.size ?? 0; }
  get(id: string) { return this.byId.get(id)?.row; }
  at(index: number): OutlineRow {
    let item = this.root;
    while (item) {
      const left = item.left?.size ?? 0;
      if (index === left) return item.row;
      if (index < left) item = item.left;
      else { index -= left + 1; item = item.right; }
    }
    throw new RangeError('Outline index is out of range');
  }
  indexOf(id: string) {
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
      if (position >= start && position < end) rows.push(item.row);
      collect(item.right, position + 1);
    };
    collect(this.root, 0);
    return rows;
  }
  subtreeEnd(index: number) { return this.nextBoundary(index + 1, this.at(index).depth); }
  nextBoundary(start: number, depth: number): number {
    const find = (item: Item | null, base: number): number => {
      if (!item || base + item.size <= start || item.minimumDepth > depth) return -1;
      const position = base + (item.left?.size ?? 0);
      const left = find(item.left, base);
      if (left >= 0) return left;
      if (position >= start && item.row.depth <= depth) return position;
      return find(item.right, position + 1);
    };
    const found = find(this.root, 0);
    return found < 0 ? this.length : found;
  }
  previousBoundary(before: number, depth: number): number {
    const find = (item: Item | null, base: number): number => {
      if (!item || base >= before || item.minimumDepth > depth) return -1;
      const position = base + (item.left?.size ?? 0);
      const right = find(item.right, position + 1);
      if (right >= 0) return right;
      if (position < before && item.row.depth <= depth) return position;
      return find(item.left, base);
    };
    return find(this.root, 0);
  }
  setText(id: string, text: string): OutlineRow {
    const item = this.byId.get(id)!;
    item.row = { ...item.row, text };
    return item.row;
  }
  splice(at: number, remove: number, rows: OutlineRow[]) {
    const [before, rest] = split(this.root, at);
    const [removed, after] = split(rest, remove);
    visit(removed, item => this.byId.delete(item.row.id));
    this.root = merge(merge(before, this.build(rows)), after);
  }
  move(from: number, count: number, to: number) {
    if (from === to) return;
    const [before, rest] = split(this.root, from);
    const [segment, after] = split(rest, count);
    const [left, right] = split(merge(before, after), to);
    this.root = merge(merge(left, segment), right);
  }
  shiftDepth(from: number, count: number, delta: number): OutlineRow[] {
    const [before, rest] = split(this.root, from);
    const [segment, after] = split(rest, count);
    const changed: OutlineRow[] = [];
    visit(segment, item => { item.row = { ...item.row, depth: item.row.depth + delta }; changed.push(item.row); });
    refresh(segment);
    this.root = merge(merge(before, segment), after);
    return changed;
  }
  toArray(): OutlineRow[] {
    const rows: OutlineRow[] = [];
    visit(this.root, item => rows.push(item.row));
    return rows;
  }
  ids(): string[] {
    const ids: string[] = [];
    visit(this.root, item => ids.push(item.row.id));
    return ids;
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
      }
      else root = item;
      stack.push(item);
      this.byId.set(row.id, item);
    }
    refresh(root);
    return root;
  }
}
