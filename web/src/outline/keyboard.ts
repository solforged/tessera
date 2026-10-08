import type { EditorView } from '@codemirror/view';
import { matchFieldEntry } from '../table/query';
import { textTokens } from '../document/text-tokens';
import { boundaryDeletion } from '../document/outline-mechanics';
import type { OutlineContext } from './context';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function createOutlineKeyboard(context: Pick<OutlineContext,
  | 'selected' | 'doc' | 'folds' | 'fold' | 'inlineFields'
  | 'setSelected' | 'indices' | 'rowFocus' | 'ids' | 'editing'
  | 'commitFieldEntry' | 'replaceSelection' | 'textRange' | 'deleteTextRange' | 'apply'
  | 'editAt' | 'setTextRange' | 'editor' | 'props' | 'afterReference'
  | 'slashKey' | 'dateKey' | 'popupKey' | 'leaderMenu' | 'undo'
  | 'openTable' | 'zoomOut' | 'zoomTo' | 'rowRange' | 'statusMenu'
  | 'capabilities' | 'roots' | 'composition' | 'scroll' | 'depthReason'
  | 'stepDepth' | 'clearSelection' | 'caret' | 'setRowRange'
>) {
  const {
    selected, doc, folds, fold, inlineFields, setSelected,
    indices, rowFocus, ids, editing, commitFieldEntry, replaceSelection,
    textRange, deleteTextRange, apply, editAt, setTextRange, props,
    afterReference, slashKey, dateKey, popupKey, leaderMenu, undo,
    openTable, zoomOut, zoomTo, rowRange, statusMenu, capabilities,
    roots, composition, depthReason, stepDepth, clearSelection, caret,
    setRowRange,
  } = context;
  let rowKey = '';
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
  function split(_view: EditorView) {
    if (editing() && commitFieldEntry(editing()!)) return;
    replaceSelection('', 'split');
  }
  function backspace(view: EditorView, forward = false) {
    if (textRange()) { deleteTextRange(); return true; }
    const id = editing();
    if (!id) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) { replaceSelection('', 'text'); return true; }
    // An empty `[[]]` or `(())` left by the bracket pairing goes in one Backspace, as it arrived.
    const pair = !forward && selection.head >= 2 ? view.state.doc.sliceString(selection.head - 2, selection.head + 2) : '';
    if (pair === '[[]]' || pair === '(())') { replaceSelection('', 'text', { anchor: { id, offset: selection.head - 2 }, head: { id, offset: selection.head + 2 } }); return true; }
    const token = textTokens(view.state.doc.toString()).find(token => token.kind === 'reference' &&
      (forward ? selection.head >= token.start && selection.head < token.end : selection.head > token.start && selection.head <= token.end));
    if (token) {
      const at = { id, offset: selection.head };
      replaceSelection('', 'text', { anchor: { id, offset: token.start }, head: { id, offset: token.end } }, { anchor: at, head: at });
      return true;
    }
    if (selection.head !== (forward ? view.state.doc.length : 0)) return false;
    const row = indices().get(id) ?? 0;
    const previous = ids()[row - 1] ?? null;
    const intent = boundaryDeletion(doc, id, forward ? 'forward' : 'backward', previous, inlineFields());
    if (intent?.kind === 'delete') {
      const neighbor = previous ?? ids()[row + 1];
      apply(intent);
      if (!doc.block(id) && neighbor) editAt(neighbor, doc.block(neighbor)?.text.length ?? 0, true);
    } else if (intent) apply(intent);
    return true;
  }
  function crossArrow(event: KeyboardEvent, view: EditorView) {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    const head = view.state.selection.main.head;
    const rect = view.coordsAtPos(head);
    const first = view.coordsAtPos(0);
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const lineStart = vertical ? view.coordsAtPos(view.moveToLineBoundary(view.state.selection.main, false, true).head) : null;
    const column = rect && lineStart ? rect.left - lineStart.left : 0;
    const last = view.coordsAtPos(view.state.doc.length);
    const boundary = event.key === 'ArrowLeft' ? head === 0 : event.key === 'ArrowRight' ? head === view.state.doc.length
      : direction < 0 ? !!rect && !!first && rect.top <= first.top + 2 : !!rect && !!last && rect.bottom >= last.bottom - 2;
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
          const line = context.editor.view.moveToLineBoundary(context.editor.view.state.selection.main, false, true);
          const start = context.editor.view.coordsAtPos(line.head);
          if (start) target = context.editor.view.posAtCoords({ x: start.left + column, y: (edge.top + edge.bottom) / 2 }) ?? offset;
        }
      }
      if (vertical || event.shiftKey) context.editor.view.dispatch({ selection: { anchor: event.shiftKey ? anchor.id === id ? anchor.offset : direction > 0 ? 0 : context.editor.view.state.doc.length : target, head: target } });
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
    if (afterReference(event, view) || slashKey(event) || dateKey(event) || popupKey(event) || fieldKey(event, view)) return true;
    if (commonKey(event)) return true;
    if (event.key === 'Escape' && (!props.vim || context.editor?.mode() === 'normal')) { if (editing()) rowFocus(editing()!); return true; }
    if (props.vim && context.editor?.mode() !== 'insert') {
      if (event.key === ' ' && context.editor?.mode() === 'normal' && editing() && !event.metaKey && !event.ctrlKey && !event.altKey) { leaderMenu(editing()!); return true; }
      if (event.key === 'u') { undo(); return true; }
      if (event.ctrlKey && event.key.toLowerCase() === 'r') { undo(true); return true; }
      return false;
    }
    if (event.key === 'Enter') {
      if (event.shiftKey) replaceSelection('\n', 'text');
      else split(view);
      return true;
    }
    if (event.key === 'Tab') { apply({ kind: event.shiftKey ? 'outdent' : 'indent', ids: [editing()!] }); return true; }
    if (event.key === 'Backspace') return backspace(view);
    if (event.key === 'Delete') return backspace(view, true);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (!event.shiftKey) setTextRange(null);
      return crossArrow(event, view);
    }
    return false;
  }
  function commonKey(event: KeyboardEvent) {
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
      if (textRange() && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); replaceSelection(event.key, 'text'); return; }
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
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { context.editor.view.dispatch(context.editor.view.state.replaceSelection(event.key)); event.preventDefault(); }
        return;
      }
    }
    if (event.target !== context.scroll || event.isComposing || composition()) return;
    let handled = false;
    if (textRange() && (event.key === 'Backspace' || event.key === 'Delete')) { deleteTextRange(); handled = true; }
    if (!handled) handled = commonKey(event);
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
    if (!handled && event.key === 'Enter' && selected()) { props.vim ? zoomTo(selected()) : editAt(selected()!, caret()?.id === selected() ? caret()!.offset : 0, true); handled = true; }
    if (!handled && event.key === 'Backspace') { props.vim ? zoomOut() : apply({ kind: 'delete', ids: roots() }, false); handled = true; }
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
    if (key === 'u') { undo(); return true; }
    if (event.ctrlKey && key.toLowerCase() === 'r') { undo(true); return true; }
    return false;
  }
  return { horizontal, adjacent, split, editorKey, structuralKey, resetRowKey: () => { rowKey = ""; } };
}
