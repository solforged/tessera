import type { Caret } from '../document/contract';
import { offsetAtPoint } from './BlockText';
import { orderedRange, selectedText, selectionIds } from './visibility';
import type { OutlineContext } from './context';

export function createOutlineInteractions(context: Pick<OutlineContext,
  | 'textRange' | 'ids' | 'doc' | 'editing' | 'editor'
  | 'rowFocus' | 'commitFieldEntry' | 'setTextRange' | 'editAt' | 'scroll'
  | 'restoreSelection' | 'disposed' | 'props' | 'composition' | 'activeRange'
  | 'rowRange' | 'selectedIds' | 'replaceSelection' | 'apply' | 'roots'
  | 'compositionSelection' | 'deleteTextRange'
>) {
  const {
    textRange, ids, doc, editing, rowFocus, commitFieldEntry,
    setTextRange, editAt, restoreSelection, props, composition, activeRange,
    rowRange, selectedIds, replaceSelection, apply, roots, deleteTextRange,
  } = context;
  let drag: { anchor: Caret; moved: boolean; native: boolean } | null = null;
  function selectedOffsets(id: string): [number, number] | null {
    const range = textRange();
    if (!range || !selectionIds(ids(), range).includes(id)) return null;
    const [start, end] = orderedRange(doc, range);
    return [id === start.id ? start.offset : 0, id === end.id ? end.offset : doc.block(id)?.text.length ?? 0];
  }
  function pointerStart(event: MouseEvent, id: string, element: HTMLElement) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    // Shift-click inside the block being edited extends its text selection; elsewhere it selects rows.
    if (event.shiftKey && editing() === id && context.editor?.id === id) return;
    if (event.shiftKey) { event.preventDefault(); rowFocus(id, true); return; }
    if (editing() && editing() !== id && commitFieldEntry(editing()!)) { event.preventDefault(); return; }
    const text = doc.block(id)?.text ?? '';
    const native = context.editor?.id === id && context.editor.view.dom.contains(event.target as Node);
    const offset = native ? context.editor!.view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? 0 : offsetAtPoint(element, text, event.clientX, event.clientY);
    drag = { anchor: { id, offset }, moved: false, native };
    setTextRange(null);
    if (!native) { event.preventDefault(); editAt(id, offset, true); }
  }
  function pointerMove(event: MouseEvent) {
    if (!drag || !(event.buttons & 1)) return;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-block-id]');
    const id = element?.dataset.blockId;
    if (!element || !id || !context.scroll.contains(element) || id === drag.anchor.id && drag.native && !drag.moved) return;
    const body = element.querySelector<HTMLElement>('.outline-body')!;
    const offset = editing() === id && context.editor?.id === id ? context.editor.view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? 0 : offsetAtPoint(body, doc.block(id)?.text ?? '', event.clientX, event.clientY);
    if (!drag.moved && id === drag.anchor.id && offset === drag.anchor.offset) return;
    drag.moved = true;
    const range = { anchor: drag.anchor, head: { id, offset } };
    setTextRange(range);
    if (context.editor?.id === id && editing() === id) restoreSelection(range);
    event.preventDefault();
    if (event.clientY > context.scroll.getBoundingClientRect().bottom - 24) context.scroll.scrollTop += 24;
    else if (event.clientY < context.scroll.getBoundingClientRect().top + 24) context.scroll.scrollTop -= 24;
  }
  function pointerEnd() {
    if (drag?.moved && textRange()) {
      const range = textRange()!;
      if (editing() && editing() !== range.head.id && commitFieldEntry(editing()!)) { drag = null; return; }
      editAt(range.head.id, range.head.offset, true, false);
      setTextRange(range);
      queueMicrotask(() => { if (!context.disposed && props.active) restoreSelection(range); });
    }
    drag = null;
  }
  function textInputTarget(event: Event) { return !(event.target instanceof Element) || !event.target.closest('input, textarea'); }
  function clipboard(event: ClipboardEvent, cut = false) {
    if (!textInputTarget(event) || composition()) return;
    const range = activeRange();
    const rows = rowRange();
    const hasText = range && (range.anchor.id !== range.head.id || range.anchor.offset !== range.head.offset);
    if (!hasText && !rows) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const payload = hasText ? selectedText(doc, ids(), range!) : selectedIds().map(id => doc.block(id)?.text ?? '').join('\n');
    event.clipboardData?.setData('text/plain', payload);
    if (cut) hasText ? replaceSelection('', 'text', range) : apply({ kind: 'delete', ids: roots() }, false);
  }
  function paste(event: ClipboardEvent) {
    if (!textInputTarget(event) || composition()) return;
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined || !activeRange()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    replaceSelection(text, 'paste');
  }
  function beforeInput(event: InputEvent) {
    if (!textRange() || !textInputTarget(event) || composition() || context.compositionSelection || event.isComposing) return;
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
      if (event.data === null) return;
      event.preventDefault(); event.stopImmediatePropagation(); replaceSelection(event.data, 'text');
    } else if (event.inputType.startsWith('delete')) {
      event.preventDefault(); event.stopImmediatePropagation(); deleteTextRange();
    }
  }
  return { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput };
}
