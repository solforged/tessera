import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { TextRange } from '../document/contract';
import { createOutlineKeyboard } from './keyboard';

function navigationHarness(texts: string[], origins = texts.map(() => 100)) {
  let row = 0;
  let textRange: TextRange | null = null;
  let state = EditorState.create({ doc: texts[row], selection: EditorSelection.cursor(10) });
  const view = {
    get state() { return state; },
    contentDOM: { getBoundingClientRect: () => ({ left: origins[row] }) },
    coordsAtPos: (offset: number) => ({ left: origins[row]! + offset * 10, right: origins[row]! + offset * 10, top: row * 30, bottom: row * 30 + 24 }),
    posAtCoords: ({ x }: { x: number }) => Math.max(0, Math.min(state.doc.length, Math.round((x - origins[row]!) / 10))),
    dispatch: (spec: TransactionSpec) => { state = state.update(spec).state; },
  } as unknown as EditorView;
  const editor = { id: String(row), view, mode: () => 'insert' };
  const keyboard = createOutlineKeyboard({
    editor,
    props: { vim: false },
    editing: () => editor.id,
    ids: () => texts.map((_, index) => String(index)),
    indices: () => new Map(texts.map((_, index) => [String(index), index])),
    doc: { block: (id: string) => ({ text: texts[Number(id)] }) },
    editAt: (id: string, offset: number) => {
      row = Number(id);
      editor.id = id;
      state = EditorState.create({ doc: texts[row], selection: EditorSelection.cursor(offset) });
    },
    commitFieldEntry: () => false,
    textRange: () => textRange,
    rowRange: () => null,
    setTextRange: (range: TextRange | null) => { textRange = range; },
    setRowRange: () => {},
    forgetReferenceSpace: () => false,
    slashKey: () => false,
    dateKey: () => false,
    popupKey: () => false,
  } as unknown as Parameters<typeof createOutlineKeyboard>[0]);
  return {
    keyboard,
    position: () => ({ row, offset: state.selection.main.head }),
    remount: (offset = state.selection.main.head) => { state = EditorState.create({ doc: texts[row], selection: EditorSelection.cursor(offset) }); },
    select: (anchor: number, head: number) => { state = state.update({ selection: EditorSelection.range(anchor, head) }).state; },
    setRange: (range: TextRange | null) => { textRange = range; },
    range: () => textRange,
    press: async (key: string, modifiers: Partial<KeyboardEvent> = {}) => {
      const handled = keyboard.editorKey({ key, code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers } as KeyboardEvent, view);
      await Promise.resolve();
      return handled;
    },
  };
}

describe('pane-owned vertical navigation goal', () => {
  test('survives a short row and selection remounts in both directions', async () => {
    const harness = navigationHarness(['abcdefghijabcdefghij', 'x', 'abcdefghijabcdefghij']);
    expect(await harness.press('ArrowDown')).toBe(true);
    expect(harness.position()).toEqual({ row: 1, offset: 1 });
    harness.remount();
    expect(await harness.press('ArrowDown')).toBe(true);
    expect(harness.position()).toEqual({ row: 2, offset: 10 });
    harness.remount();
    await harness.press('ArrowUp');
    expect(harness.position()).toEqual({ row: 1, offset: 1 });
    harness.remount();
    await harness.press('ArrowUp');
    expect(harness.position()).toEqual({ row: 0, offset: 10 });
  });

  test('a nonvertical key or the pointer/edit reset discards the old preferred x', async () => {
    for (const reset of ['key', 'pointer or edit']) {
      const harness = navigationHarness(['abcdefghijabcdefghij', 'x', 'abcdefghijabcdefghij']);
      await harness.press('ArrowDown');
      harness.remount();
      if (reset === 'key') await harness.press('Home');
      else harness.keyboard.resetVerticalGoal();
      await harness.press('ArrowDown');
      expect(harness.position()).toEqual({ row: 2, offset: 1 });
    }
  });

  test('keeps screen coordinates when the source has an inline-field gutter', async () => {
    const harness = navigationHarness(['abcdefghijabcdefghij', 'abcdefghijabcdefghij'], [220, 100]);
    harness.remount(5);
    await harness.press('ArrowDown');
    expect(harness.position()).toEqual({ row: 1, offset: 17 });
  });
});

describe('field filling after a picker commit', () => {
  test('Tab advances a selected value without changing its field ownership', () => {
    const scroll = {} as HTMLDivElement;
    const edits: string[] = [];
    const advances: string[] = [];
    let filling = true;
    const keyboard = createOutlineKeyboard({
      scroll, props: { active: true, vim: false },
      editing: () => null, selected: () => 'second-author',
      composition: () => false, textRange: () => null, rowRange: () => null,
      roots: () => ['second-author'],
      apply: (intent: { kind: string }) => { edits.push(intent.kind); },
    } as unknown as Parameters<typeof createOutlineKeyboard>[0], (event, id) => {
      if (!filling || event.key !== 'Tab') return false;
      advances.push(`${id}:${event.shiftKey ? 'previous' : 'next'}`);
      return true;
    });
    const tab = (shiftKey = false) => keyboard.structuralKey({
      target: scroll, key: 'Tab', shiftKey, preventDefault() {},
    } as unknown as KeyboardEvent);
    tab();
    tab(true);
    expect(advances).toEqual(['second-author:next', 'second-author:previous']);
    expect(edits).toEqual([]);
    filling = false;
    tab();
    tab(true);
    expect(edits).toEqual(['indent', 'outdent']);
  });
});

describe('native and cross-row selection ownership', () => {
  test('non-Shift navigation clears a cross-row range even with modifiers', async () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      for (const modifier of [{}, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        // Alt-Up/Down move the selected roots, rather than navigating the caret.
        if (modifier.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) continue;
        const harness = navigationHarness(['abcdefghijabcdefghij', 'next row']);
        harness.setRange({ anchor: { id: '1', offset: 1 }, head: { id: '0', offset: 10 } });
        await harness.press(key, modifier);
        expect(harness.range()).toBeNull();
      }
    }
  });

  test('a selected row collapses inside its editor instead of crossing to its neighbor', async () => {
    const harness = navigationHarness(['abcdefghijabcdefghij', 'next row']);
    harness.select(0, 20);
    expect(await harness.press('ArrowRight')).toBe(false);
    expect(harness.position()).toEqual({ row: 0, offset: 20 });
    harness.select(20, 0);
    expect(await harness.press('ArrowLeft')).toBe(false);
    expect(harness.position()).toEqual({ row: 0, offset: 0 });
  });

  test('Shift navigation retains the cross-row anchor', async () => {
    const harness = navigationHarness(['abcdefghijabcdefghij', 'next row']);
    const range = { anchor: { id: '1', offset: 1 }, head: { id: '0', offset: 10 } };
    harness.setRange(range);
    await harness.press('Home', { shiftKey: true, metaKey: true });
    expect(harness.range()).toEqual(range);
  });
});
