import { EditorSelection } from '@codemirror/state';
import { Direction } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import type { PageDocument } from '../document/contract';
import { referenceBeside } from '../document/text-tokens';
import { boundaryDeletion } from '../document/outline-mechanics';
import type { OutlineContext } from './context';
import { applyBracketInput, graphemeBoundary } from './editor';

/** Only an additional blank leaf value is disposable; the entry's first value is always kept. */
export function emptyExtraValuePrevious(doc: Pick<PageDocument, 'block' | 'outline' | 'isArchived'>, id: string, definitions: ReadonlyMap<string, unknown>): string | null {
  const block = doc.block(id);
  if (!block || block.text.trim() || doc.outline.children(id).length) return null;
  const parent = doc.outline.parentOf(id);
  if (!definitions.has(fieldEntryId(doc.block(parent)?.text ?? '') ?? '')) return null;
  const values = doc.outline.children(parent).filter(value => !doc.isArchived(value));
  const index = values.indexOf(id);
  return index > 0 ? values[index - 1]! : null;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function createOutlineKeyboard(context: Pick<OutlineContext,
  | 'selected' | 'doc' | 'folds' | 'fold' | 'inlineFields'
  | 'setSelected' | 'indices' | 'rowFocus' | 'ids' | 'editing'
  | 'commitFieldEntry' | 'replaceSelection' | 'textRange' | 'deleteTextRange' | 'apply'
  | 'editAt' | 'setTextRange' | 'editor' | 'props' | 'forgetReferenceSpace'
  | 'slashKey' | 'dateKey' | 'popupKey' | 'leaderMenu' | 'undo'
  | 'openTable' | 'zoomOut' | 'zoomTo' | 'zoom' | 'rowRange' | 'statusMenu'
  | 'capabilities' | 'roots' | 'composition' | 'scroll' | 'depthReason'
  | 'stepDepth' | 'clearSelection' | 'caret' | 'setRowRange' | 'makeCloze'
  | 'definitionsById' | 'setMessage'
>, fillingKey: (event: KeyboardEvent, id: string) => boolean = () => false) {
  const {
    selected, doc, folds, fold, inlineFields, setSelected,
    indices, rowFocus, ids, editing, commitFieldEntry, replaceSelection,
    textRange, deleteTextRange, apply, editAt, setTextRange, props,
    forgetReferenceSpace, slashKey, dateKey, popupKey, leaderMenu, undo,
    openTable, zoomOut, zoomTo, zoom, rowRange, statusMenu, capabilities,
    roots, composition, depthReason, stepDepth, clearSelection, caret,
    setRowRange,
  } = context;
  let rowKey = '';
  // The editor remounts when a row changes, so its selection cannot own a cross-row navigation goal.
  let preferredX: number | undefined;
  function resetVerticalGoal() { preferredX = undefined; }
  function clearNavigationRange(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    if (editing() || !event.shiftKey) setRowRange(null);
    if (!event.shiftKey) setTextRange(null);
  }
  function pruneEmptyValue(id: string): string | null {
    const previous = emptyExtraValuePrevious(doc, id, context.definitionsById());
    if (!previous) return null;
    // The document only coalesces text edits, so this structural cleanup is a separate undo step.
    const result = doc.edit({ kind: 'delete', ids: [id] });
    if (!result.ok) { context.setMessage(result.reason); return null; }
    return previous;
  }
  function horizontal(direction: 'left' | 'right') {
    const id = selected();
    if (!id) return;
    if (direction === 'left') {
      if (doc.outline.children(id).length && !folds().has(id)) fold(id);
      else { const parent = doc.outline.parentOf(id); if (inlineFields().has(parent)) setSelected(parent); if (indices().has(parent)) rowFocus(parent); }
    } else if (folds().has(id)) fold(id);
    else { const child = doc.outline.children(id)[0]; if (child && indices().has(child)) rowFocus(child); }
  }
  function adjacent(direction: number, extend = false) {
    const index = indices().get(selected() ?? '');
    const id = index === undefined
      ? direction > 0 ? ids()[0] : ids().at(-1)
      : ids()[Math.max(0, Math.min(ids().length - 1, index + direction))];
    if (id) rowFocus(id, extend);
  }
  function split(view: EditorView) {
    if (editing() && commitFieldEntry(editing()!)) return;
    if (!textRange()) {
      const selection = view.state.selection.main;
      const text = view.state.doc.toString();
      const head = graphemeBoundary(text, selection.head, selection.empty || selection.head > selection.anchor);
      const anchor = selection.empty ? head : graphemeBoundary(text, selection.anchor, selection.anchor > selection.head);
      if (head !== selection.head || anchor !== selection.anchor) view.dispatch({ selection: EditorSelection.range(anchor, head) });
    }
    replaceSelection('', 'split');
  }
  function backspace(view: EditorView, forward = false, wholeGrapheme = true) {
    if (textRange()) { deleteTextRange(); return true; }
    const id = editing();
    if (!id) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) { replaceSelection('', 'text'); return true; }
    // An empty `[[]]` or `(())` left by the bracket pairing goes in one Backspace, as it arrived.
    const pair = !forward && selection.head >= 2 ? view.state.doc.sliceString(selection.head - 2, selection.head + 2) : '';
    if (pair === '[[]]' || pair === '(())') { replaceSelection('', 'text', { anchor: { id, offset: selection.head - 2 }, head: { id, offset: selection.head + 2 } }); return true; }
    const token = referenceBeside(view.state.doc.toString(), selection.head, forward ? 'forward' : 'backward');
    if (token) {
      const at = { id, offset: selection.head };
      replaceSelection('', 'text', { anchor: { id, offset: token.start }, head: { id, offset: token.end } }, { anchor: at, head: at });
      return true;
    }
    if (selection.head !== (forward ? view.state.doc.length : 0)) {
      if (!wholeGrapheme) return false;
      const text = view.state.doc.toString();
      const segment = graphemes.segment(text).containing(forward ? selection.head : selection.head - 1)!;
      const from = segment.index, to = from + segment.segment.length;
      view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete' });
      return true;
    }
    const row = indices().get(id) ?? 0;
    const previous = ids()[row - 1] ?? null;
    const intent = boundaryDeletion(doc, id, forward ? 'forward' : 'backward', previous, inlineFields(), zoom());
    if (intent?.kind === 'delete') {
      const neighbor = previous ?? ids()[row + 1];
      apply(intent);
      if (!doc.block(id) && neighbor) editAt(neighbor, doc.block(neighbor)?.text.length ?? 0, true);
    } else if (intent) apply(intent);
    return true;
  }
  function crossArrow(event: KeyboardEvent, view: EditorView) {
    // Let the editor collapse its own selection before considering a neighboring row.
    if (!event.shiftKey && !view.state.selection.main.empty) return false;
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    const head = view.state.selection.main.head;
    const rect = view.coordsAtPos(head);
    const first = view.coordsAtPos(0);
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    if (vertical && preferredX === undefined) preferredX = rect?.left;
    const x = vertical ? preferredX : undefined;
    if (vertical && x !== undefined) {
      const selection = view.state.selection.main;
      const goal = x - view.contentDOM.getBoundingClientRect().left;
      if (selection.goalColumn !== goal) view.dispatch({ selection: EditorSelection.range(selection.anchor, selection.head, goal) });
    }
    const last = view.coordsAtPos(view.state.doc.length);
    if (!vertical) {
      const selection = view.state.selection.main;
      // Line-boundary commands can attach an LTR start/end association to an RTL edge.
      // Probe the actual bidi span, rather than treating that association as a row exit.
      const cursor = EditorSelection.cursor(head, 0, selection.bidiLevel ?? undefined);
      const forward = (event.key === 'ArrowRight') === (view.textDirectionAt(head) === Direction.LTR);
      let target = view.moveByChar(cursor, forward);
      if (target.head !== head) {
        const line = view.state.doc.lineAt(head);
        // CM represents a visual line end with a logical endpoint sentinel. Resolve it
        // back to the displayed edge before the next key or an insertion uses the offset.
        if (target.bidiLevel === null && (target.head === line.from || target.head === line.to)) {
          target = view.moveToLineBoundary(target, forward, true);
        }
        view.dispatch({
          selection: event.shiftKey ? EditorSelection.range(selection.anchor, target.head, undefined, target.bidiLevel ?? undefined, target.assoc) : target,
          scrollIntoView: true,
          userEvent: 'select.keyboard',
        });
        return true;
      }
    }
    const boundary = !vertical || (direction < 0 ? !!rect && !!first && rect.top <= first.top + 2 : !!rect && !!last && rect.bottom >= last.bottom - 2);
    if (!boundary) return false;
    const index = indices().get(editing() ?? '') ?? -1;
    const id = ids()[index + direction];
    if (!id) return false;
    if (editing() && commitFieldEntry(editing()!)) return true;
    const offset = direction < 0 ? (doc.block(id)?.text.length ?? 0) : 0;
    const anchor = textRange()?.anchor ?? { id: editing()!, offset: view.state.selection.main.anchor };
    editAt(id, offset, true);
    setTextRange(event.shiftKey ? { anchor, head: { id, offset } } : null);
    queueMicrotask(() => {
      if (context.editor?.id !== id) return;
      let target = offset;
      if (vertical) {
        const edge = context.editor.view.coordsAtPos(offset);
        if (edge) {
          if (x !== undefined) target = context.editor.view.posAtCoords({ x, y: (edge.top + edge.bottom) / 2 }) ?? offset;
        }
      }
      target = graphemeBoundary(context.editor.view.state.doc.toString(), target, direction > 0);
      if (vertical || event.shiftKey) {
        const targetView = context.editor.view;
        const goal = vertical && x !== undefined ? x - targetView.contentDOM.getBoundingClientRect().left : undefined;
        const start = event.shiftKey ? anchor.id === id ? anchor.offset : direction > 0 ? 0 : targetView.state.doc.length : target;
        targetView.dispatch({ selection: EditorSelection.range(start, target, goal), userEvent: 'select.keyboard' });
      }
      if (event.shiftKey) setTextRange({ anchor, head: { id, offset: target } });
    });
    return true;
  }
  /** Space right after `Name::`, or Tab anywhere in the name, makes the entry at once with the caret in its value. */
  function fieldKey(event: KeyboardEvent, view: EditorView) {
    if (event.key !== ' ' && event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || props.vim && context.editor?.mode() !== 'insert') return false;
    const id = editing();
    const selection = view.state.selection.main;
    const text = view.state.doc.toString();
    if (!id || !selection.empty || !matchFieldEntry(text)) return false;
    const nameEnd = text.indexOf('::') + 2;
    if (event.key === ' ' ? selection.head !== nameEnd : selection.head > nameEnd) return false;
    return commitFieldEntry(id);
  }
  function editorKey(event: KeyboardEvent, view: EditorView) {
    const selection = view.state.selection.main;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' || event.altKey || event.metaKey || event.ctrlKey) {
      resetVerticalGoal();
      if (selection.goalColumn !== undefined) view.dispatch({ selection: EditorSelection.range(selection.anchor, selection.head) });
    }
    if (forgetReferenceSpace(event) || slashKey(event) || dateKey(event) || popupKey(event) || fieldKey(event, view)) return true;
    if (commonKey(event)) return true;
    if (editing() && fillingKey(event, editing()!)) return true;
    clearNavigationRange(event);
    if (event.key === 'Escape' && (!props.vim || context.editor?.mode() === 'normal')) { const id = editing(); if (id) rowFocus(pruneEmptyValue(id) ?? id); return true; }
    if (props.vim && context.editor?.mode() !== 'insert') {
      if (event.key === ' ' && context.editor?.mode() === 'normal' && editing() && !event.metaKey && !event.ctrlKey && !event.altKey) { leaderMenu(editing()!); return true; }
      if (context.editor?.vimUndoKey(event)) { undo(); return true; }
      if (event.ctrlKey && event.key.toLowerCase() === 'r') { undo(true); return true; }
      return false;
    }
    if (event.key === 'Enter') {
      if (event.shiftKey) replaceSelection('\n', 'text');
      else split(view);
      return true;
    }
    if (event.key === 'Tab') { apply({ kind: event.shiftKey ? 'outdent' : 'indent', ids: [editing()!] }); return true; }
    if (event.key === 'Backspace') return backspace(view, false, !event.altKey && !event.metaKey && !event.ctrlKey);
    if (event.key === 'Delete') return backspace(view, true, !event.altKey && !event.metaKey && !event.ctrlKey);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.altKey && !event.metaKey && !event.ctrlKey) {
      return crossArrow(event, view);
    }
    return false;
  }
  function commonKey(event: KeyboardEvent) {
    if (event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') { context.makeCloze(); return true; }
    if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 't') { openTable(false); return true; }
    if (event.metaKey && event.key.toLowerCase() === 'z') { undo(event.shiftKey); return true; }
    const id = editing() ?? selected();
    if (event.metaKey && event.code === 'Period') { if (id) event.shiftKey ? zoomOut() : zoomTo(id); return true; }
    if (id && !rowRange() && !textRange() && event.metaKey && event.shiftKey && event.key === 'Enter' && !event.altKey && !event.ctrlKey) {
      if (!event.repeat) statusMenu(id);
      return true;
    }
    if (id && !rowRange() && !textRange() && (event.altKey || event.metaKey) && event.key === 'Enter' && !(event.altKey && event.metaKey) && !event.ctrlKey && !event.shiftKey) {
      if (!event.repeat) capabilities.invoke(capabilities.toggle(id));
      return true;
    }
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { if (id) apply({ kind: 'move', ids: roots(), direction: event.key === 'ArrowUp' ? 'up' : 'down' }); return true; }
    return false;
  }
  function structuralKey(event: KeyboardEvent) {
    if (!event.defaultPrevented && !event.isComposing && !composition() && props.active && event.metaKey && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      openTable(false);
      return;
    }
    if (event.target === context.scroll && !event.isComposing && !composition()) {
      if (textRange() && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const range = textRange()!;
        const from = Math.min(range.anchor.offset, range.head.offset), to = Math.max(range.anchor.offset, range.head.offset);
        if (range.anchor.id === range.head.id && context.editor?.id === range.anchor.id && applyBracketInput(context.editor.view, from, to, event.key)) { setTextRange(null); return; }
        replaceSelection(event.key, 'text');
        return;
      }
      if (editing() && context.editor?.id === editing()) {
        context.editor.view.focus();
        if (editorKey(event, context.editor.view) || context.editor.forwardVim(event)) { event.preventDefault(); return; }
        const selection = context.editor.view.state.selection.main;
        if (event.key === 'Backspace' || event.key === 'Delete') {
          let from = selection.from, to = selection.to;
          if (selection.empty && event.key === 'Backspace') for (const segment of graphemes.segment(context.editor.view.state.doc.sliceString(0, from))) from = segment.index;
          else if (selection.empty) { const next = graphemes.segment(context.editor.view.state.doc.sliceString(to))[Symbol.iterator]().next(); to += next.value?.segment.length ?? 0; }
          context.editor.view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
          event.preventDefault();
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          if (!applyBracketInput(context.editor.view, selection.from, selection.to, event.key)) context.editor.view.dispatch(context.editor.view.state.replaceSelection(event.key));
          event.preventDefault();
        }
        return;
      }
    }
    if (event.target !== context.scroll || event.isComposing || composition()) return;
    let handled = false;
    if (!editing() && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
      const first = ids()[0], last = ids().at(-1);
      if (first && last) { rowFocus(last); setRowRange({ anchor: first, head: last }); }
      event.preventDefault();
      return;
    }
    if (textRange() && (event.key === 'Backspace' || event.key === 'Delete')) { deleteTextRange(); handled = true; }
    if (!handled) handled = commonKey(event);
    if (!handled && selected() && !rowRange() && !textRange()) handled = fillingKey(event, selected()!);
    if (!handled) clearNavigationRange(event);
    if (!handled && (event.key === '[' || event.key === ']') && !event.metaKey && !event.ctrlKey && !event.altKey && !depthReason()) { stepDepth(event.key === '[' ? -1 : 1); handled = true; }
    if (!handled && !selected() && !textRange()) {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(event.key)) {
        adjacent(event.key === 'ArrowDown' || event.key === 'j' ? 1 : -1);
        event.preventDefault();
      } else if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'].includes(event.key) || event.key.length === 1 && !event.metaKey && !event.ctrlKey) event.preventDefault();
      return;
    }
    if (!handled && event.key === 'Tab') { apply({ kind: event.shiftKey ? 'outdent' : 'indent', ids: roots() }, false); handled = true; }
    if (!handled && event.key === 'Escape') { clearSelection(); handled = true; }
    if (!handled && event.key === 'ArrowDown') { adjacent(1, event.shiftKey); handled = true; }
    if (!handled && event.key === 'ArrowUp') { adjacent(-1, event.shiftKey); handled = true; }
    if (!handled && event.key === 'ArrowLeft') { horizontal('left'); handled = true; }
    if (!handled && event.key === 'ArrowRight') { horizontal('right'); handled = true; }
    if (!handled && !props.vim && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'j' || event.key === 'k') { adjacent(event.key === 'j' ? 1 : -1, !!rowRange()); handled = true; }
      else if (event.key === 'i' && selected()) { const id = selected()!; editAt(id, caret()?.id === id ? caret()!.offset : 0, true); handled = true; }
    }
    if (!handled && event.key === 'Enter' && selected()) { props.vim ? zoomTo(selected()) : editAt(selected()!, caret()?.id === selected() ? caret()!.offset : 0, true); handled = true; }
    if (!handled && (event.key === 'Backspace' || event.key === 'Delete')) { props.vim && !rowRange() && event.key === 'Backspace' ? zoomOut() : apply({ kind: 'delete', ids: roots() }, false); handled = true; }
    if (!handled && event.key === ' ' && selected() && !rowRange() && !textRange() && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { rowKey = ''; leaderMenu(selected()!); handled = true; }
    if (!handled && props.vim && !event.metaKey && !event.altKey) handled = vimStructural(event);
    if (handled) event.preventDefault();
  }
  function vimStructural(event: KeyboardEvent): boolean {
    const key = event.key;
    const previous = rowKey;
    rowKey = '';
    if (key === 'j' || key === 'k') { adjacent(key === 'j' ? 1 : -1, !!rowRange()); return true; }
    if (key === 'h' || key === 'l') { horizontal(key === 'h' ? 'left' : 'right'); return true; }
    if (key === 'G' || (key === 'g' && previous === 'g')) { const id = key === 'G' ? ids().at(-1) : ids()[0]; if (id) rowFocus(id); return true; }
    if ((key === '>' && previous === '>') || (key === '<' && previous === '<')) { apply({ kind: key === '>' ? 'indent' : 'outdent', ids: roots() }, false); return true; }
    if (key === 'd' && (previous === 'd' || rowRange())) { apply({ kind: 'delete', ids: roots() }, false); return true; }
    if (['g', '>', '<', 'd'].includes(key)) { rowKey = key; return true; }
    if (key === 'V' && selected()) { setRowRange({ anchor: selected()!, head: selected()! }); return true; }
    if (key === 'Escape') { setRowRange(null); setTextRange(null); return true; }
    if (['i', 'a', 'I', 'A'].includes(key) && selected()) { const id = selected()!; editAt(id, key === 'A' || key === 'a' ? doc.block(id)!.text.length : key === 'i' && caret()?.id === id ? caret()!.offset : 0, true); return true; }
    if ((key === 'o' || key === 'O') && selected()) {
      const id = selected()!;
      const parentId = doc.outline.parentOf(id);
      const siblings = doc.outline.children(parentId);
      apply({ kind: 'insert', parentId, after: key === 'o' ? id : siblings[siblings.indexOf(id) - 1] ?? null }, true);
      return true;
    }
    if (key === 'u' && !event.ctrlKey && !event.shiftKey && !previous && !rowRange() && !textRange()) { undo(); return true; }
    if (event.ctrlKey && key.toLowerCase() === 'r') { undo(true); return true; }
    return false;
  }
  return { horizontal, adjacent, split, editorKey, structuralKey, pruneEmptyValue, resetVerticalGoal, resetRowKey: () => { rowKey = ""; } };
}
