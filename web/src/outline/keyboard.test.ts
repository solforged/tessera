import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { createOutlineKeyboard } from './keyboard';

function navigationHarness(texts: string[], origins = texts.map(() => 100)) {
  let row = 0;
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
    textRange: () => null,
    rowRange: () => null,
    setTextRange: () => {},
    forgetReferenceSpace: () => false,
    slashKey: () => false,
    dateKey: () => false,
    popupKey: () => false,
  } as unknown as Parameters<typeof createOutlineKeyboard>[0]);
  return {
    keyboard,
    position: () => ({ row, offset: state.selection.main.head }),
    remount: (offset = state.selection.main.head) => { state = EditorState.create({ doc: texts[row], selection: EditorSelection.cursor(offset) }); },
    press: async (key: string) => {
      const handled = keyboard.editorKey({ key, code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false } as KeyboardEvent, view);
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
