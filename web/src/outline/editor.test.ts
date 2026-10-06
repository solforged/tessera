import { expect, test } from 'bun:test';
import { Compartment, EditorState } from '@codemirror/state';
import { fieldEntryExtension } from './editor';

test('known whole-field references keep raw copy text and reject interior carets', () => {
  for (const text of ['[[area]]', '  [[area|Alias]]  ']) {
    const state = EditorState.create({ doc: text, extensions: fieldEntryExtension(id => id === 'area' ? 'Area' : undefined) });
    const left = state.update({ selection: { anchor: 1 } }).state;
    const right = state.update({ selection: { anchor: text.length - 1 } }).state;
    expect(left.selection.main.head).toBe(0);
    expect(right.selection.main.head).toBe(text.length);
    const selected = state.update({ selection: { anchor: 0, head: text.length } }).state;
    expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe(text);
    expect(selected.doc.toString()).toBe(text);
  }
});

test('unknown references and references within prose remain ordinary editable text', () => {
  for (const text of ['[[unknown]]', 'About [[area]]', '[[area]] and more']) {
    const state = EditorState.create({ doc: text, extensions: fieldEntryExtension(id => id === 'area' ? 'Area' : undefined) });
    expect(state.update({ selection: { anchor: 3 } }).state.selection.main.head).toBe(3);
  }
});

test('resolver reconfiguration updates atomic eligibility without rewriting the field text', () => {
  const resolver = new Compartment();
  const text = '[[area]]';
  const state = EditorState.create({ doc: text, extensions: resolver.of(fieldEntryExtension(() => 'Area')) });
  const renamed = state.update({ effects: resolver.reconfigure(fieldEntryExtension(() => 'Subject area')), selection: { anchor: 2 } }).state;
  expect(renamed.selection.main.head).toBe(0);
  expect(renamed.doc.toString()).toBe(text);
  const removed = renamed.update({ effects: resolver.reconfigure(fieldEntryExtension(() => undefined)), selection: { anchor: 2 } }).state;
  expect(removed.selection.main.head).toBe(2);
  expect(removed.doc.toString()).toBe(text);
});
