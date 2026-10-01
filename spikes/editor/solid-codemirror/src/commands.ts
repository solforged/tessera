import type { Caret, OutlineRow, Selection } from '@spike/shared';
import type { OutlineReader } from '../../react-codemirror/src/outline-index';

export type Operation =
  | { kind: 'text'; id: string; before: string; after: string }
  | { kind: 'depth'; index: number; count: number; delta: number }
  | { kind: 'splice'; index: number; before: OutlineRow[]; after: OutlineRow[] }
  | { kind: 'move'; from: number; count: number; to: number };
export interface Change { operations: Operation[]; before: Selection; after: Selection }
export function collapsed(caret: Caret): Selection { return { anchor: { ...caret }, head: { ...caret } }; }
export function inverse(operation: Operation): Operation {
  if (operation.kind === 'depth') return { ...operation, delta: -operation.delta };
  if (operation.kind === 'move') return { ...operation, from: operation.to, to: operation.from };
  if (operation.kind === 'text') return { ...operation, before: operation.after, after: operation.before };
  return { ...operation, before: operation.after, after: operation.before };
}
export function split(rows: OutlineReader, selection: Selection, freshId: string): Change {
  const index = rows.indexOf(selection.head.id);
  const row = rows.at(index);
  const offset = selection.head.offset;
  return {
    operations: [{ kind: 'text', id: row.id, before: row.text, after: row.text.slice(0, offset) }, { kind: 'splice', index: rows.subtreeEnd(index), before: [], after: [{ id: freshId, text: row.text.slice(offset), depth: row.depth }] }],
    before: selection, after: collapsed({ id: freshId, offset: 0 }),
  };
}
export function merge(rows: OutlineReader, selection: Selection): Change | null {
  const index = rows.indexOf(selection.head.id);
  if (index <= 0 || rows.subtreeEnd(index) !== index + 1) return null;
  const row = rows.at(index);
  const previous = rows.at(index - 1);
  return {
    operations: [{ kind: 'text', id: previous.id, before: previous.text, after: previous.text + row.text }, { kind: 'splice', index, before: [row], after: [] }],
    before: selection, after: collapsed({ id: previous.id, offset: previous.text.length }),
  };
}
export function indent(rows: OutlineReader, selection: Selection, outdent: boolean): Change | null {
  const index = rows.indexOf(selection.head.id);
  const row = rows.at(index);
  if (outdent ? row.depth === 0 : index === 0) return null;
  if (!outdent) {
    const previous = rows.previousBoundary(index, row.depth);
    if (previous < 0 || rows.at(previous).depth !== row.depth) return null;
  }
  const end = rows.subtreeEnd(index);
  const count = end - index;
  const operations: Operation[] = [{ kind: 'depth', index, count, delta: outdent ? -1 : 1 }];
  if (outdent) {
    const to = rows.nextBoundary(end, row.depth - 1) - count;
    if (to !== index) operations.push({ kind: 'move', from: index, count, to });
  }
  return { operations, before: selection, after: collapsed(selection.head) };
}
export function move(rows: OutlineReader, selection: Selection, direction: -1 | 1): Change | null {
  const from = rows.indexOf(selection.head.id);
  const end = rows.subtreeEnd(from);
  const count = end - from;
  const depth = rows.at(from).depth;
  let to: number;
  if (direction === 1) {
    if (end >= rows.length || rows.at(end).depth !== depth) return null;
    to = rows.subtreeEnd(end) - count;
  } else {
    to = rows.previousBoundary(from, depth);
    if (to < 0 || rows.at(to).depth !== depth) return null;
  }
  return { operations: [{ kind: 'move', from, count, to }], before: selection, after: collapsed(selection.head) };
}
export function deleteSelection(rows: OutlineReader, selection: Selection): Change | null {
  let first = rows.indexOf(selection.anchor.id);
  let last = rows.indexOf(selection.head.id);
  let start = selection.anchor.offset;
  let finish = selection.head.offset;
  if (first > last || first === last && start > finish) { [first, last] = [last, first]; [start, finish] = [finish, start]; }
  if (first < 0 || last < 0) return null;
  const initial = rows.at(first);
  const final = rows.at(last);
  const end = rows.subtreeEnd(last);
  const children = rows.slice(last + 1, end).map(row => ({ ...row, depth: row.depth + initial.depth - final.depth }));
  return {
    operations: [{ kind: 'text', id: initial.id, before: initial.text, after: initial.text.slice(0, start) + final.text.slice(finish) }, { kind: 'splice', index: first + 1, before: rows.slice(first + 1, end), after: children }],
    before: selection, after: collapsed({ id: initial.id, offset: start }),
  };
}
