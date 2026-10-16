import { describe, expect, test } from 'bun:test';
import { Compartment, EditorState } from '@codemirror/state';
import { PendingEditorRange, emphasisChange, fieldDraftDecorations, fieldEntryExtension, graphemeBoundary, graphemeSelection, pairInput, pairSelection, referenceDecorations, vimUndoKey } from './editor';
import type { NameMatch } from '../api/types';

test('emphasis wraps and unwraps selected source, including combined bold and italic', () => {
  expect(emphasisChange('a word z', 2, 6, '**')).toEqual({ from: 2, to: 6, insert: '**word**', anchor: 4, head: 8 });
  expect(emphasisChange('a **word** z', 4, 8, '**')).toEqual({ from: 2, to: 10, insert: 'word', anchor: 2, head: 6 });
  expect(emphasisChange('a **word** z', 2, 10, '**')).toEqual({ from: 2, to: 10, insert: 'word', anchor: 2, head: 6 });
  expect(emphasisChange('**word**', 2, 6, '*').insert).toBe('*word*');
  expect(emphasisChange('***word***', 3, 7, '*')).toEqual({ from: 2, to: 8, insert: 'word', anchor: 2, head: 6 });
  expect(emphasisChange('text', 4, 4, '*')).toEqual({ from: 4, to: 4, insert: '**', anchor: 5, head: 5 });
});

test('a pending accepted reference excludes burst continuation and Backspace corrections', () => {
  let state = EditorState.create({ doc: 'See [[Accepted]] ', selection: { anchor: 17 } });
  const pending = new PendingEditorRange({ from: 4, to: 16 });
  for (const insert of ['s', 'u', 'f', 'f', 'i', 'x']) {
    const update = state.update(state.replaceSelection(insert));
    pending.map(update.changes);
    state = update.state;
  }
  const correction = state.update({ changes: { from: state.doc.length - 1, to: state.doc.length } });
  pending.map(correction.changes);
  state = correction.state;
  expect(pending.range).toEqual({ from: 4, to: 16 });
  const replacement = state.update({ changes: { ...pending.range!, insert: '[[stable-id]]' } }).state;
  expect(replacement.doc.toString()).toBe('See [[stable-id]] suffi');
  expect(replacement.selection.main.head).toBe(replacement.doc.length);
});

test('pending reference ranges follow outside edits but reject edits to the accepted token', () => {
  const state = EditorState.create({ doc: 'See [[Accepted]] ' });
  const pending = new PendingEditorRange({ from: 4, to: 16 });
  pending.map(state.update({ changes: { from: 0, insert: 'Please ' } }).changes);
  expect(pending.range).toEqual({ from: 11, to: 23 });
  const changed = EditorState.create({ doc: 'Please See [[Accepted]] ' }).update({ changes: { from: 15, to: 16, insert: 'X' } });
  pending.map(changed.changes);
  expect(pending.range).toBeNull();
});

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

describe('extended grapheme selection boundaries', () => {
  for (const cluster of ['क्षि', '👍🏽', 'e\u0301', '👨‍👩‍👧‍👦', '🇮🇳']) {
    test(`navigation and selections keep ${cluster} intact`, () => {
      const text = `A${cluster}B`, end = 1 + cluster.length;
      const state = EditorState.create({ doc: text, selection: { anchor: 1 }, extensions: graphemeSelection });
      expect(state.update({ selection: { anchor: 2 } }).state.selection.main.head).toBe(end);
      const right = EditorState.create({ doc: text, selection: { anchor: end }, extensions: graphemeSelection });
      expect(right.update({ selection: { anchor: end - 1 } }).state.selection.main.head).toBe(1);
      const range = state.update({ selection: { anchor: 2, head: text.length } }).state.selection.main;
      expect([range.from, range.to]).toEqual([1, text.length]);
      expect(graphemeBoundary(text, 2, false)).toBe(1);
      expect(graphemeBoundary(text, 2, true)).toBe(end);
    });
  }

  test('composition text is not rewritten while it is being authored', () => {
    const state = EditorState.create({ doc: 'AB', selection: { anchor: 1 }, extensions: graphemeSelection });
    const next = state.update({ changes: { from: 1, insert: 'क्' }, selection: { anchor: 2 } }).state;
    expect(next.doc.toString()).toBe('Aक्B');
    expect(next.selection.main.head).toBe(2);
  });
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
  test('citation widgets retain locators and distinguish source citations from plain links', () => {
    const text = '[[source|span|3.12]] [[source]] [[ordinary|span|4]] [[source||5]]';
    const widgets: { label: string; locator?: string; citation: boolean }[] = [];
    referenceDecorations(text, text.length, id => id === 'source' ? 'Source title' : 'Ordinary', () => false, undefined, undefined, id => id === 'source')
      .between(0, text.length, (_from, _to, decoration) => {
        const widget = decoration.spec.widget;
        widgets.push({ label: widget.label, locator: widget.token.locator, citation: widget.citation });
      });
    expect(widgets).toEqual([
      { label: 'span', locator: '3.12', citation: true },
      { label: 'Source title', locator: undefined, citation: false },
      { label: 'span', locator: '4', citation: false },
      { label: 'Source title', locator: '5', citation: true },
    ]);
  });
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
  test('labels a whole-text reference that is not a field, such as a chosen option', () => {
    const ranges: string[] = [];
    referenceDecorations('[[option]]', 10, id => id === 'option' ? 'Architecture' : undefined, () => false).between(0, 10, (_from, _to, decoration) => { ranges.push(decoration.spec.widget.label); });
    expect(ranges).toEqual(['Architecture']);
  });
  test('leaves plain text tags and URLs undecorated', () => {
    expect(decorations('Text #tag https://example.org', 0)).toEqual([]);
    expect(decorations('By [[author|]]', 0, { author: 'Author' })[0]?.label).toBe('Author');
  });
  test('leaves multiline references raw because plugin replacements cannot span lines', () => {
    expect(decorations('By [[author|First\nSecond]]', 0)).toEqual([]);
  });
  test('marks shared title references but not stable references and exposes raw source under the caret', () => {
    const text = '[[Pliny]] [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]';
    const matches = [{ page: { id: 'elder' }, alias: 'Pliny' }, { page: { id: 'younger' }, alias: 'Pliny' }] as NameMatch[];
    const widgets: { label: string; ambiguous: boolean }[] = [];
    referenceDecorations(text, text.length, () => undefined, () => false, () => matches).between(0, text.length, (_from, _to, decoration) => { widgets.push({ label: decoration.spec.widget.label, ambiguous: decoration.spec.widget.ambiguous }); });
    expect(widgets).toEqual([{ label: 'Pliny', ambiguous: true }, { label: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ambiguous: false }]);
    const exposed: string[] = [];
    referenceDecorations('[[Pliny]]', 3, () => undefined, () => false, () => matches).between(0, 9, (_from, _to, decoration) => { exposed.push(decoration.spec.widget.label); });
    expect(exposed).toEqual([]);
  });
});

/** Types `keys` one character at a time, as the input handler would, and marks the caret with `|`. */
function typed(keys: string, doc = '', caret = doc.length) {
  for (const key of keys) {
    const paired = pairInput(doc, caret, key);
    const insert = paired ? paired.insert : key;
    doc = doc.slice(0, caret) + insert + doc.slice(caret);
    caret = paired ? paired.caret : caret + 1;
  }
  return `${doc.slice(0, caret)}|${doc.slice(caret)}`;
}
/** Types `keys` over a selection, as the input handler would, and marks a caret with `|`. */
function typedOver(keys: string, doc: string, from: number, to: number) {
  let anchor = from, head = to;
  for (const key of keys) {
    const start = Math.min(anchor, head), end = Math.max(anchor, head);
    const selected = start === end ? null : pairSelection(doc, start, end, key);
    const paired = start === end ? pairInput(doc, start, key) : null;
    if (selected) {
      doc = doc.slice(0, start) + selected.before + doc.slice(start, end) + selected.after + doc.slice(end);
      anchor = selected.anchor;
      head = selected.head;
    } else if (paired) {
      doc = doc.slice(0, start) + paired.insert + doc.slice(end);
      anchor = head = paired.caret;
    } else {
      doc = doc.slice(0, start) + key + doc.slice(end);
      anchor = head = start + key.length;
    }
  }
  const caret = head;
  return `${doc.slice(0, caret)}|${doc.slice(caret)}`;
}

describe('bracket pairing', () => {
  test('a second opener closes the pair with the caret inside', () => {
    expect(typed('See [[')).toBe('See [[|]]');
    expect(typed('See ((')).toBe('See ((|))');
    expect(typed('#[[')).toBe('#[[|]]');
  });
  test('single brackets, task shorthand and a third opener stay plain', () => {
    expect(typed('[] ')).toBe('[] |');
    expect(typed('[ ] ')).toBe('[ ] |');
    expect(typed('a (b)')).toBe('a (b)|');
    expect(typed('[', '[[]]', 2)).toBe('[[[|]]');
  });
  test('typed closers step over the paired ones, so typing the whole token by hand matches the source', () => {
    expect(typed('[[Page]] next')).toBe('[[Page]] next|');
    expect(typed('((a+b)*c)')).toBe('((a+b)*c)|');
  });
  test('a closer outside an open pair is ordinary text', () => {
    expect(typed(']', '[[a]]x]', 6)).toBe('[[a]]x]|]');
  });
  test('the first opener stays in front of a selection so the second can surround it', () => {
    expect(pairSelection('See hello next', 4, 9, '[')).toEqual({ before: '[', after: '', anchor: 5, head: 10 });
    expect(pairSelection('See hello next', 4, 9, '(')).toEqual({ before: '(', after: '', anchor: 5, head: 10 });
    expect(typedOver('[[', 'See hello next', 4, 9)).toBe('See [[hello|]] next');
    expect(typedOver('((', 'See hello next', 4, 9)).toBe('See ((hello|)) next');
    expect(typedOver('[[', '  #tag name', 3, 11)).toBe('  #[[tag name|]]');
  });
  test('one input of the whole opener surrounds the selection at once', () => {
    expect(pairSelection('hello', 0, 5, '[[')).toEqual({ before: '[[', after: ']]', anchor: 7, head: 7 });
    expect(pairSelection('hello', 0, 5, '((')).toEqual({ before: '((', after: '))', anchor: 7, head: 7 });
  });
  test('a selection already inside one bracket upgrades without an extra closer', () => {
    expect(typedOver('[', '[hello]', 1, 6)).toBe('[[hello|]]');
    expect(typedOver('[', '[hello]]', 1, 6)).toBe('[[hello|]]');
    expect(typedOver('(', '(expr)', 1, 5)).toBe('((expr|))');
  });
  test('a third opener and any other key still replace the selection', () => {
    expect(pairSelection('[[hello', 2, 7, '[')).toBeNull();
    expect(typedOver('[', '[[hello', 2, 7)).toBe('[[[|');
    expect(typedOver('[x', 'hello', 0, 5)).toBe('[x|');
    expect(typedOver(']', 'hello', 0, 5)).toBe(']|');
    expect(pairSelection('hello', 0, 5, 'a')).toBeNull();
  });
});

test('notebook undo leaves visual lowercase, control motions and pending Vim commands alone', () => {
  const event = { key: 'u', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  const state = {
    insertMode: false, visualMode: false,
    inputState: { keyBuffer: [] as string[], prefixRepeat: [] as string[], motionRepeat: [] as string[], operator: null, motion: null },
  };
  expect(vimUndoKey(event, state)).toBe(true);
  expect(vimUndoKey(event, { ...state, visualMode: true })).toBe(false);
  expect(vimUndoKey(event, { ...state, insertMode: true })).toBe(false);
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
    expect(vimUndoKey({ ...event, [modifier]: true }, state)).toBe(false);
  }
  for (const pending of [
    { keyBuffer: ['g'] }, { keyBuffer: ['r'] }, { prefixRepeat: ['2'] },
    { motionRepeat: ['2'] }, { operator: 'delete' }, { motion: 'find' }, { registerName: 'a' },
  ]) expect(vimUndoKey(event, { ...state, inputState: { ...state.inputState, ...pending } })).toBe(false);
  expect(vimUndoKey(event, { ...state, exMode: true })).toBe(false);
  expect(vimUndoKey(event, { ...state, expectLiteralNext: true })).toBe(false);
  expect(vimUndoKey(event, undefined)).toBe(false);
});

/** The draft mark's range and the hint text, if any. */
function draft(text: string, kinds: Record<string, 'text' | 'date'> = {}): { name: [number, number] | null; hint: string | null } {
  let name: [number, number] | null = null;
  let hint: string | null = null;
  fieldDraftDecorations(text, value => kinds[value.toLowerCase()]).between(0, text.length, (from, to, decoration) => {
    if (decoration.spec.class === 'field-draft-name') name = [from, to];
    else if (decoration.spec.widget?.hint) hint = decoration.spec.widget.hint;
  });
  return { name, hint };
}

describe('field shorthand drafts', () => {
  test('mark the name as a label while it is typed and say when the field is new', () => {
    expect(draft('mood::')).toEqual({ name: [0, 6], hint: 'New field' });
    expect(draft('mood:: calm')).toEqual({ name: [0, 6], hint: 'New text field' });
    expect(draft('rating:: 4')).toEqual({ name: [0, 8], hint: 'New number field' });
    expect(draft('qualifies:: [[01M4W27DSHYJGWZF9VHNQBM1A0]]')).toEqual({ name: [0, 11], hint: 'New relation field' });
  });
  test('name a known field kind until a value is typed', () => {
    expect(draft('Published::', { published: 'date' })).toEqual({ name: [0, 11], hint: 'Date' });
    expect(draft('Published:: 2026', { published: 'date' })).toEqual({ name: [0, 11], hint: null });
  });
  test('leave prose, card syntax and converted entries alone', () => {
    for (const text of ['Plain prose', 'Front >> Back::x', '{{c1::answer}}', '[[field]]', '::query']) expect(draft(text)).toEqual({ name: null, hint: null });
  });
});
