import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { Caret } from '../core/contract';
import type { PageDocument, TextRange } from '../document/contract';
import { mapTextOffset } from '../document/text-patch';
import type { RowRange } from './context';
import type { PaneEditor } from './editor';
import { selectionRoots } from './visibility';

export interface OutlineSelectionOptions {
  initialCaret: Caret | null;
  doc: PageDocument;
  ids: Accessor<string[]>;
  indices: Accessor<Map<string, number>>;
  disposed: () => boolean;
  active: () => boolean;
  vim: () => boolean;
  onVimMode: (mode: 'normal' | 'insert' | 'visual' | 'outline' | null) => void;
  editor: () => PaneEditor | undefined;
  scroll: () => HTMLDivElement | undefined;
  bumpFocusEpoch: () => number;
  clearFocusRequest: () => void;
  clearCompletion: () => void;
  resetRowKey: () => void;
  scheduleReport: () => void;
  replaceSelection: (text: string, mode: 'text' | 'paste' | 'split', range?: TextRange | null) => void;
}

export function createOutlineSelection(options: OutlineSelectionOptions) {
  // A parked caret belongs to the source text in which it was recorded, not a later normalized spelling.
  const [rememberedCaret, setRememberedCaret] = createSignal({
    at: options.initialCaret,
    text: options.initialCaret ? options.doc.block(options.initialCaret.id)?.text : undefined,
  });
  const caret = createMemo(() => {
    const { at, text } = rememberedCaret();
    const current = at ? options.doc.block(at.id)?.text : undefined;
    return at && text !== undefined && current !== undefined && text !== current
      ? { id: at.id, offset: mapTextOffset(text, current, at.offset) }
      : at;
  });
  const setCaret: Setter<Caret | null> = value => {
    const at = typeof value === 'function' ? value(caret()) : value;
    setRememberedCaret({ at, text: at ? options.doc.block(at.id)?.text : undefined });
    return at;
  };

  const [editing, setEditing] = createSignal<string | null>(options.initialCaret?.id ?? null);
  const [editorFocused, setEditorFocused] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(options.initialCaret?.id ?? null);
  const [rowRange, setRowRange] = createSignal<RowRange | null>(null);
  const [textRange, setTextRange] = createSignal<TextRange | null>(null);
  const [composition, setComposition] = createSignal(false);

  let compositionSelection: {
    range: TextRange;
    id: string;
    original: string;
    from: number;
    to: number;
    committed?: string;
  } | null = null;
  let compositionFrame = 0;

  onCleanup(() => cancelAnimationFrame(compositionFrame));

  const selectedIds = createMemo(() => {
    const range = rowRange();
    if (!range) return selected() ? [selected()!] : [];
    const a = options.indices().get(range.anchor) ?? -1;
    const b = options.indices().get(range.head) ?? -1;
    return a < 0 || b < 0 ? [] : options.ids().slice(Math.min(a, b), Math.max(a, b) + 1);
  });
  const selectedSet = createMemo(() => new Set(selectedIds()));

  // Rows under a selected block move, copy and delete with it, so they read as selected too.
  // Field values hang under hidden field entries, so walk every ancestor, not just the parent.
  const coveredSet = createMemo(() => {
    const covered = new Set<string>();
    if (!rowRange()) return covered;
    const selection = selectedSet();
    for (const id of options.ids()) {
      if (selection.has(id)) continue;
      // parentOf returns the root for the root itself, so stop at that fixed point.
      for (
        let child = id, parent = options.doc.outline.parentOf(id);
        parent !== child;
        child = parent, parent = options.doc.outline.parentOf(parent)
      ) {
        if (selection.has(parent)) {
          covered.add(id);
          break;
        }
      }
    }
    return covered;
  });

  function roots() {
    return selectionRoots(options.doc, selectedIds());
  }

  function visibleNeighbor(id: string, before: readonly string[]) {
    const visible = options.indices();
    if (visible.has(id)) return id;
    const at = before.indexOf(id);
    for (let index = at - 1; index >= 0; index--) if (visible.has(before[index]!)) return before[index]!;
    for (let index = at + 1; index < before.length; index++) if (visible.has(before[index]!)) return before[index]!;
    const current = selected();
    return current && visible.has(current) ? current : (options.ids()[0] ?? null);
  }

  /** Hidden or deleted targets leave ownership on the outline, even when no rows remain. */
  function selectSurvivor(id: string, before: readonly string[]) {
    const next = visibleNeighbor(id, before);
    options.bumpFocusEpoch();
    options.clearFocusRequest();
    batch(() => {
      options.clearCompletion();
      setEditing(null);
      setRowRange(null);
      setTextRange(null);
      setSelected(next);
      setCaret(next ? { id: next, offset: 0 } : null);
    });
    options.onVimMode(options.vim() ? 'outline' : null);
    if (options.active()) options.scroll()?.focus({ preventScroll: true });
    options.scheduleReport();
  }

  function clearSelection() {
    options.bumpFocusEpoch();
    options.clearFocusRequest();
    setEditing(null);
    setSelected(null);
    setCaret(null);
    setRowRange(null);
    setTextRange(null);
    options.resetRowKey();
    options.scheduleReport();
  }

  function activeRange(): TextRange | null {
    const across = textRange();
    if (across) return across;
    const id = editing() ?? selected();
    if (!id || !options.doc.block(id)) return null;
    const editor = options.editor();
    if (editing() === id && editor?.id === id) {
      const selection = editor.view.state.selection.main;
      return { anchor: { id, offset: selection.anchor }, head: { id, offset: selection.head } };
    }
    const at = { id, offset: caret()?.id === id ? caret()!.offset : 0 };
    return { anchor: at, head: at };
  }

  function restoreSelection(range: TextRange) {
    const editor = options.editor();
    if (!editor || editor.id !== range.head.id) return;
    const anchor =
      range.anchor.id === range.head.id
        ? range.anchor.offset
        : options.doc.outline.indexOf(range.anchor.id) < options.doc.outline.indexOf(range.head.id)
          ? 0
          : editor.view.state.doc.length;
    setTextRange(range.anchor.id === range.head.id ? null : range);
    editor.view.dispatch({ selection: { anchor, head: range.head.offset } });
  }

  function composing(active: boolean, committed?: string) {
    const editor = options.editor();
    if (active && textRange() && editor) {
      const selection = editor.view.state.selection.main;
      compositionSelection = {
        range: textRange()!,
        id: editor.id,
        original: editor.view.state.doc.toString(),
        from: selection.from,
        to: selection.to,
      };
    }
    setComposition(active);
    if (!active && compositionSelection) {
      const snapshot = compositionSelection;
      snapshot.committed = committed;
      cancelAnimationFrame(compositionFrame);
      compositionFrame = requestAnimationFrame(() => {
        const currentEditor = options.editor();
        if (options.disposed() || compositionSelection !== snapshot || currentEditor?.id !== snapshot.id) return;
        const text = currentEditor.view.state.doc.toString();
        compositionSelection = null;
        if (snapshot.committed || text !== snapshot.original) {
          const suffix = snapshot.original.length - snapshot.to;
          options.replaceSelection(
            snapshot.committed || text.slice(snapshot.from, Math.max(snapshot.from, text.length - suffix)),
            'text',
            snapshot.range,
          );
        } else restoreSelection(snapshot.range);
      });
    }
  }

  return {
    caret,
    setCaret,
    editing,
    setEditing,
    editorFocused,
    setEditorFocused,
    selected,
    setSelected,
    rowRange,
    setRowRange,
    textRange,
    setTextRange,
    composition,
    get hasCompositionSelection() {
      return !!compositionSelection;
    },
    selectedIds,
    selectedSet,
    coveredSet,
    roots,
    selectSurvivor,
    clearSelection,
    activeRange,
    restoreSelection,
    composing,
  };
}
