import type { Caret, OutlineRow, Selection } from '@spike/shared';
import type { OutlineReader } from './outline-index';

export type Operation =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'splice'; at: number; remove: number; rows: OutlineRow[] }
  | { kind: 'depth'; at: number; count: number; delta: number }
  | { kind: 'move'; from: number; count: number; to: number };
export interface Command {
  forward: Operation[];
  inverse: Operation[];
  before: Selection;
  after: Selection;
}
export const caretSelection = (caret: Caret): Selection => ({ anchor: caret, head: caret });

export function split(rows: OutlineReader, selection: Selection, id: string): Command {
  const index = rows.indexOf(selection.head.id);
  const row = rows.at(index);
  const at = rows.subtreeEnd(index);
  const offset = selection.head.offset;
  return {
    forward: [{ kind: 'text', id: row.id, text: row.text.slice(0, offset) }, { kind: 'splice', at, remove: 0, rows: [{ id, depth: row.depth, text: row.text.slice(offset) }] }],
    inverse: [{ kind: 'splice', at, remove: 1, rows: [] }, { kind: 'text', id: row.id, text: row.text }],
    before: selection, after: caretSelection({ id, offset: 0 }),
  };
}
export function merge(rows: OutlineReader, selection: Selection): Command | null {
  const index = rows.indexOf(selection.head.id);
  if (index <= 0 || rows.subtreeEnd(index) !== index + 1) return null;
  const row = rows.at(index);
  const previous = rows.at(index - 1);
  return {
    forward: [{ kind: 'text', id: previous.id, text: previous.text + row.text }, { kind: 'splice', at: index, remove: 1, rows: [] }],
    inverse: [{ kind: 'splice', at: index, remove: 0, rows: [row] }, { kind: 'text', id: previous.id, text: previous.text }],
    before: selection, after: caretSelection({ id: previous.id, offset: previous.text.length }),
  };
}
export function indent(rows: OutlineReader, selection: Selection, out: boolean): Command | null {
  const at = rows.indexOf(selection.head.id);
  const row = rows.at(at);
  if (out ? row.depth === 0 : at === 0) return null;
  if (!out) {
    const previous = rows.previousBoundary(at, row.depth);
    if (previous < 0 || rows.at(previous).depth !== row.depth) return null;
  }
  const end = rows.subtreeEnd(at);
  const count = end - at;
  const delta = out ? -1 : 1;
  const forward: Operation[] = [{ kind: 'depth', at, count, delta }];
  const inverse: Operation[] = [{ kind: 'depth', at, count, delta: -delta }];
  if (out) {
    const to = rows.nextBoundary(end, row.depth - 1) - count;
    if (to !== at) {
      forward.push({ kind: 'move', from: at, count, to });
      inverse.unshift({ kind: 'move', from: to, count, to: at });
    }
  }
  return { forward, inverse, before: selection, after: caretSelection(selection.head) };
}
export function move(rows: OutlineReader, selection: Selection, down: boolean): Command | null {
  const from = rows.indexOf(selection.head.id);
  const end = rows.subtreeEnd(from);
  const count = end - from;
  const depth = rows.at(from).depth;
  let to: number;
  if (down) {
    if (end >= rows.length || rows.at(end).depth !== depth) return null;
    to = rows.subtreeEnd(end) - count;
  } else {
    to = rows.previousBoundary(from, depth);
    if (to < 0 || rows.at(to).depth !== depth) return null;
  }
  return { forward: [{ kind: 'move', from, count, to }], inverse: [{ kind: 'move', from: to, count, to: from }], before: selection, after: caretSelection(selection.head) };
}
export function deleteSelection(rows: OutlineReader, selection: Selection): Command | null {
  let first = rows.indexOf(selection.anchor.id);
  let last = rows.indexOf(selection.head.id);
  let start = selection.anchor.offset;
  let finish = selection.head.offset;
  if (first > last || (first === last && start > finish)) {
    [first, last] = [last, first];
    [start, finish] = [finish, start];
  }
  if (first < 0 || last < 0) return null;
  const initial = rows.at(first);
  const final = rows.at(last);
  const end = rows.subtreeEnd(last);
  const children = rows.slice(last + 1, end).map(row => ({ ...row, depth: row.depth + initial.depth - final.depth }));
  const at = first + 1;
  const removed = rows.slice(at, end);
  return {
    forward: [{ kind: 'text', id: initial.id, text: initial.text.slice(0, start) + final.text.slice(finish) }, { kind: 'splice', at, remove: removed.length, rows: children }],
    inverse: [{ kind: 'splice', at, remove: children.length, rows: removed }, { kind: 'text', id: initial.id, text: initial.text }],
    before: selection, after: caretSelection({ id: initial.id, offset: start }),
  };
}
