import type { Caret } from '../document/contract';
import { BLOCK_CLIPBOARD_MIME, clipboardPasteRows, clipboardPlainText, clipboardText, clipboardUrl, externalLink, parseBlockClipboard } from '../document/clipboard';
import { offsetAtPoint } from './BlockText';
import { orderedRange, selectedText, selectionIds } from './visibility';
import type { OutlineContext } from './context';

export function createOutlineInteractions(context: Pick<OutlineContext,
  | 'textRange' | 'ids' | 'doc' | 'editing' | 'editor'
  | 'rowFocus' | 'commitFieldEntry' | 'setTextRange' | 'editAt' | 'scroll'
  | 'restoreSelection' | 'disposed' | 'props' | 'composition' | 'activeRange'
  | 'rowRange' | 'selected' | 'replaceSelection' | 'apply' | 'roots' | 'zoom' | 'setMessage'
  | 'compositionSelection' | 'deleteTextRange'
>) {
  const {
    textRange, ids, doc, editing, rowFocus, commitFieldEntry,
    setTextRange, editAt, restoreSelection, props, composition, activeRange,
    rowRange, selected, replaceSelection, apply, roots, deleteTextRange, zoom, setMessage,
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
    const rows = !editing() && (rowRange() || selected());
    const hasText = range && (range.anchor.id !== range.head.id || range.anchor.offset !== range.head.offset);
    if ((!hasText && !rows) || !event.clipboardData) return;
    const content = hasText ? null : doc.clipboard(roots(), cut);
    if (content && !content.blocks.length) return;
    event.clipboardData.setData('text/plain', content ? clipboardText(content) : selectedText(doc, ids(), range!));
    if (content) event.clipboardData.setData(BLOCK_CLIPBOARD_MIME, JSON.stringify(content));
    event.preventDefault();
    event.stopImmediatePropagation();
    if (cut) hasText ? replaceSelection('', 'text', range) : apply({ kind: 'delete', ids: roots() }, false);
  }
  function paste(event: ClipboardEvent) {
    if (!textInputTarget(event) || composition()) return;
    const data = event.clipboardData;
    const range = activeRange();
    if (!data || !range) return;
    const content = parseBlockClipboard(data.getData(BLOCK_CLIPBOARD_MIME));
    const text = clipboardPlainText(data);
    event.preventDefault();
    event.stopImmediatePropagation();
    const rows = content ? null : clipboardPasteRows(data);
    if (!content && rows === null) return;
    const replaceRoots = !editing() && (rowRange() || selected()) ? roots() : undefined;
    if (!content) {
      const url = text === null ? null : clipboardUrl(text.trim());
      if (!replaceRoots && url && range.anchor.id === range.head.id && range.anchor.offset !== range.head.offset) {
        const caption = selectedText(doc, ids(), range);
        if (!/[\r\n]/.test(caption)) { replaceSelection(externalLink(url, caption), 'text', range); return; }
      }
      apply({ kind: 'pasteRows', range, between: selectionIds(ids(), range).slice(1, -1), rows: rows!, replaceRoots, zoomRoot: zoom() }, true);
      return;
    }
    const intent = { kind: 'pasteBlocks' as const, range, between: selectionIds(ids(), range).slice(1, -1), content, replaceRoots, zoomRoot: zoom() };
    if (!content.cut) { apply(intent, true); return; }
    const anchorText = doc.block(range.anchor.id)?.text, headText = doc.block(range.head.id)?.text;
    void doc.prepareClipboard(content).then(ready => {
      if (context.disposed || !props.active || composition()) return;
      const current = activeRange();
      if (!current || current.anchor.id !== range.anchor.id || current.anchor.offset !== range.anchor.offset
        || current.head.id !== range.head.id || current.head.offset !== range.head.offset
        || doc.block(range.anchor.id)?.text !== anchorText || doc.block(range.head.id)?.text !== headText
        || replaceRoots && (editing() || roots().join('\u0000') !== replaceRoots.join('\u0000'))) {
        setMessage('The selection changed before paste. Try pasting again.');
        return;
      }
      apply({ ...intent, content: ready }, true);
    }).catch(error => { if (!context.disposed) setMessage(error instanceof Error ? error.message : String(error)); });
  }
  function beforeInput(event: InputEvent) {
    const range = textRange();
    if (!range || !textInputTarget(event) || composition() || context.compositionSelection || event.isComposing) return;
    // A selection inside the open block is the editor's. Leave it so `[[` can surround that text.
    if (range.anchor.id === range.head.id && context.editor?.id === range.anchor.id) {
      const selection = context.editor.view.state.selection.main;
      const from = Math.min(range.anchor.offset, range.head.offset), to = Math.max(range.anchor.offset, range.head.offset);
      if (selection.from === from && selection.to === to) { setTextRange(null); return; }
    }
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
      if (event.data === null) return;
      event.preventDefault(); event.stopImmediatePropagation(); replaceSelection(event.data, 'text');
    } else if (event.inputType.startsWith('delete')) {
      event.preventDefault(); event.stopImmediatePropagation(); deleteTextRange();
    }
  }
  return { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput };
}
