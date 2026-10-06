import { describe, expect, test } from 'bun:test';
import { Compartment, EditorState } from '@codemirror/state';
import { fieldEntryExtension, referenceDecorations } from './editor';

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

// The existing Bun suite has no DOM implementation. Exercise the same builder
// used by the ViewPlugin, then cover EditorView interactions in browser smoke.
function decorations(text: string, head: number, titles: Record<string, string> = {}) {
  const ranges: { from: number; to: number; label: string }[] = [];
  referenceDecorations(text, head, id => titles[id]).between(0, text.length, (from, to, decoration) => {
    ranges.push({ from, to, label: decoration.spec.widget.label });
  });
  return ranges;
}

describe('editor reference decorations', () => {
  test('uses aliases then looked-up titles then IDs without changing the raw ranges', () => {
    const text = '[[author|Ada]] [[title]] [[missing]]';
    expect(decorations(text, text.length, { author: 'Ignored', title: 'Readable title' })).toEqual([
      { from: 0, to: 14, label: 'Ada' },
      { from: 15, to: 24, label: 'Readable title' },
      { from: 25, to: 36, label: 'missing' },
    ]);
  });
  test('reveals only the reference containing the selection head', () => {
    expect(decorations('[[one]] [[two]]', 3)).toEqual([{ from: 8, to: 15, label: 'two' }]);
    expect(decorations('[[one]] [[two]]', 11)).toEqual([{ from: 0, to: 7, label: 'one' }]);
  });
  test('keeps token endpoints atomic in prose', () => {
    for (const head of [4, 14]) expect(decorations('See [[author]]', head, { author: 'Author' })).toEqual([{ from: 4, to: 14, label: 'Author' }]);
  });
  test('leaves whole field entries to the field widget', () => {
    expect(decorations('[[author]]', 0, { author: 'Author' })).toEqual([]);
  });
  test('leaves plain text tags and URLs undecorated', () => {
    expect(decorations('Text #tag https://example.org', 0)).toEqual([]);
    expect(decorations('By [[author|]]', 0, { author: 'Author' })[0]?.label).toBe('Author');
  });
  test('leaves multiline references raw because plugin replacements cannot span lines', () => {
    expect(decorations('By [[author|First\nSecond]]', 0)).toEqual([]);
  });
  test('rebuilds labels when a lookup changes', () => {
    expect(decorations('By [[author]]', 0)[0]?.label).toBe('author');
    expect(decorations('By [[author]]', 0, { author: 'Author' })[0]?.label).toBe('Author');
  });
});
