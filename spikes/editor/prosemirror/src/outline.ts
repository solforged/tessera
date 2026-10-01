import { Fragment, Schema } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import type { Node as DocumentBlock } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Caret, OutlineRow, Selection } from '@spike/shared';

// Flat preorder rows keep outline depth separate from text selection. Nested
// lists would put list wrappers between native selection positions and row IDs.
export const schema = new Schema({
  nodes: {
    doc: { content: 'row*' },
    row: {
      content: 'text*',
      group: 'block',
      attrs: { id: {}, depth: { default: 0 } },
      code: true,
      defining: true,
      whitespace: 'pre',
      parseDOM: [{
        tag: 'div[data-block-id]',
        getAttrs: element => ({
          id: element.getAttribute('data-block-id'),
          depth: Number(element.getAttribute('data-depth') ?? 0),
        }),
      }],
      toDOM: block => ['div', {
        class: 'outline-row',
        'data-block-id': block.attrs.id,
        'data-depth': block.attrs.depth,
        style: `--depth:${block.attrs.depth}`,
      }, 0],
    },
    text: { group: 'inline' },
  },
});

export function rowBlock(row: OutlineRow): DocumentBlock {
  return schema.nodes.row!.create({ id: row.id, depth: row.depth }, row.text ? schema.text(row.text) : undefined);
}

export function outline(doc: DocumentBlock): OutlineRow[] {
  const rows: OutlineRow[] = [];
  doc.forEach(block => rows.push({ id: block.attrs.id, depth: block.attrs.depth, text: block.textContent }));
  return rows;
}

export interface LocatedRow {
  block: DocumentBlock;
  index: number;
  before: number;
}

export function rowAt(doc: DocumentBlock, index: number): LocatedRow {
  let before = 0;
  for (let i = 0; i < index; i++) before += doc.child(i).nodeSize;
  return { block: doc.child(index), index, before };
}

export function caret(doc: DocumentBlock, position: number): Caret {
  const resolved = doc.resolve(position);
  if (resolved.depth === 1) return { id: resolved.parent.attrs.id, offset: resolved.parentOffset };
  const index = Math.min(resolved.index(0), doc.childCount - 1);
  const row = rowAt(doc, index);
  return { id: row.block.attrs.id, offset: Math.max(0, Math.min(row.block.content.size, position - row.before - 1)) };
}

export function selection(state: EditorState): Selection {
  return { anchor: caret(state.doc, state.selection.anchor), head: caret(state.doc, state.selection.head) };
}

function subtreeEnd(doc: DocumentBlock, index: number): number {
  const depth = doc.child(index).attrs.depth;
  let end = index + 1;
  while (end < doc.childCount && doc.child(end).attrs.depth > depth) end++;
  return end;
}

function boundary(doc: DocumentBlock, index: number): number {
  return index === doc.childCount ? doc.content.size : rowAt(doc, index).before;
}

function structural(view: EditorView, tr: Transaction): void {
  view.dispatch(closeHistory(tr).scrollIntoView());
  // The following text edit starts its own event, but shares this history stack.
  view.dispatch(closeHistory(view.state.tr));
}

export function deleteCrossSelection(state: EditorState): Transaction | null {
  const { $from, $to } = state.selection;
  if ($from.depth !== 1 || $to.depth !== 1 || $from.index(0) === $to.index(0)) return null;
  const first = rowAt(state.doc, $from.index(0));
  const last = rowAt(state.doc, $to.index(0));
  const end = subtreeEnd(state.doc, last.index);
  const merged = first.block.type.create(first.block.attrs, textContent(first.block.textContent.slice(0, $from.parentOffset) + last.block.textContent.slice($to.parentOffset)));
  const replacement = [merged];
  for (let index = last.index + 1; index < end; index++) {
    const child = state.doc.child(index);
    replacement.push(child.type.create({ ...child.attrs, depth: child.attrs.depth + first.block.attrs.depth - last.block.attrs.depth }, child.content));
  }
  const tr = state.tr.replaceWith(first.before, boundary(state.doc, end), replacement);
  return tr.setSelection(TextSelection.create(tr.doc, first.before + 1 + $from.parentOffset));
}

function textContent(text: string): DocumentBlock | undefined {
  return text ? schema.text(text) : undefined;
}

export function split(view: EditorView): boolean {
  if (!view.state.selection.empty) {
    const cross = deleteCrossSelection(view.state);
    view.dispatch((cross ?? view.state.tr.deleteSelection()).scrollIntoView());
  }
  const state = view.state;
  const resolved = state.selection.$head;
  if (resolved.depth !== 1) return false;
  const row = rowAt(state.doc, resolved.index(0));
  const offset = resolved.parentOffset;
  const end = boundary(state.doc, subtreeEnd(state.doc, row.index));
  const right = row.block.type.create({ id: crypto.randomUUID(), depth: row.block.attrs.depth }, textContent(row.block.textContent.slice(offset)));
  const tr = state.tr.delete(row.before + 1 + offset, row.before + 1 + row.block.content.size);
  const insertion = tr.mapping.map(end);
  tr.insert(insertion, right).setSelection(TextSelection.create(tr.doc, insertion + 1));
  structural(view, tr);
  return true;
}

export function backspace(view: EditorView): boolean {
  const state = view.state;
  const cross = deleteCrossSelection(state);
  if (cross) {
    structural(view, cross);
    return true;
  }
  if (!state.selection.empty || state.selection.$head.parentOffset !== 0) return false;
  const index = state.selection.$head.index(0);
  if (index === 0 || subtreeEnd(state.doc, index) !== index + 1) return true;
  const previous = rowAt(state.doc, index - 1);
  const current = state.doc.child(index);
  const merged = previous.block.type.create(previous.block.attrs, textContent(previous.block.textContent + current.textContent));
  const tr = state.tr.replaceWith(previous.before, boundary(state.doc, index + 1), merged);
  tr.setSelection(TextSelection.create(tr.doc, previous.before + 1 + previous.block.content.size));
  structural(view, tr);
  return true;
}

function selectedSubtree(state: EditorState): { row: LocatedRow; end: number; blocks: DocumentBlock[]; offset: number } {
  const row = rowAt(state.doc, state.selection.$head.index(0));
  const end = subtreeEnd(state.doc, row.index);
  const blocks: DocumentBlock[] = [];
  for (let index = row.index; index < end; index++) blocks.push(state.doc.child(index));
  return { row, end, blocks, offset: state.selection.$head.parentOffset };
}

export function indent(view: EditorView, direction: 1 | -1): boolean {
  const state = view.state;
  const { row, end, blocks, offset } = selectedSubtree(state);
  const depth = row.block.attrs.depth;
  let target = row.before;
  const tr = state.tr;
  if (direction === 1) {
    let previous = row.index - 1;
    while (previous >= 0 && state.doc.child(previous).attrs.depth > depth) previous--;
    if (previous < 0 || state.doc.child(previous).attrs.depth !== depth) return true;
  } else {
    if (depth === 0) return true;
    let parent = row.index - 1;
    while (parent >= 0 && state.doc.child(parent).attrs.depth >= depth) parent--;
    target = boundary(state.doc, subtreeEnd(state.doc, parent));
  }
  const replacement = blocks.map(block => block.type.create({ ...block.attrs, depth: block.attrs.depth + direction }, block.content));
  if (target === row.before) {
    tr.replaceWith(row.before, boundary(state.doc, end), replacement);
  } else {
    tr.delete(row.before, boundary(state.doc, end));
    target = tr.mapping.map(target);
    tr.insert(target, replacement);
  }
  tr.setSelection(TextSelection.create(tr.doc, target + 1 + offset));
  structural(view, tr);
  return true;
}

export function move(view: EditorView, direction: 1 | -1): boolean {
  const state = view.state;
  const { row, end, blocks, offset } = selectedSubtree(state);
  const depth = row.block.attrs.depth;
  let target: number;
  if (direction === -1) {
    let previous = row.index - 1;
    while (previous >= 0 && state.doc.child(previous).attrs.depth > depth) previous--;
    if (previous < 0 || state.doc.child(previous).attrs.depth !== depth) return true;
    target = boundary(state.doc, previous);
  } else {
    if (end === state.doc.childCount || state.doc.child(end).attrs.depth !== depth) return true;
    target = boundary(state.doc, subtreeEnd(state.doc, end));
  }
  const tr = state.tr.delete(row.before, boundary(state.doc, end));
  target = tr.mapping.map(target);
  tr.insert(target, Fragment.from(blocks));
  tr.setSelection(TextSelection.create(tr.doc, target + 1 + offset));
  structural(view, tr);
  return true;
}

export function vertical(view: EditorView, direction: 'up' | 'down', extend: boolean): boolean {
  const state = view.state;
  const headState = state.selection.empty ? state : state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.selection.head)));
  if (!view.endOfTextblock(direction, headState)) return false;
  const current = state.selection.$head.index(0);
  const index = current + (direction === 'up' ? -1 : 1);
  if (index < 0 || index >= state.doc.childCount) return true;
  const target = rowAt(state.doc, index);
  const currentCoords = view.coordsAtPos(state.selection.head);
  const edge = view.coordsAtPos(target.before + 1 + (direction === 'up' ? target.block.content.size : 0));
  const found = view.posAtCoords({ left: currentCoords.left, top: (edge.top + edge.bottom) / 2 });
  const head = Math.max(target.before + 1, Math.min(target.before + 1 + target.block.content.size, found?.pos ?? target.before + 1));
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, extend ? state.selection.anchor : head, head)).scrollIntoView());
  return true;
}
