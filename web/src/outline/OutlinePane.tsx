import { For, Show, createEffect, createMemo, createResource, createRoot, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { EditorView } from '@codemirror/view';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { Block, FieldDefinition } from '../api/types';
import { api } from '../api/client';
import type { Caret, Edit, EditResult, NotebookClient, PageDocument, TextRange } from '../document/contract';
import type { Command, OutlinePaneProps, ViewState } from '../shell/contract';
import { fieldEntryId, fieldEntryText, matchFieldEntry } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText, offsetAtPoint, textTokens } from './BlockText';
import { PaneEditor } from './editor';
import { orderedRange, selectedText, selectionIds, selectionRoots, visibleIds } from './visibility';
import './outline.css';

interface Completion { from: number; to: number; query: string }
interface MenuState { anchor: HTMLElement; items: MenuItem[]; label: string }
interface RowRange { anchor: string; head: string }
type CompletionRow = { kind: 'block'; block: Block } | { kind: 'field'; field: FieldDefinition };
const storedFolds = new Map<string, Set<string>>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const fieldCreations = new WeakMap<NotebookClient, Map<string, Promise<FieldDefinition>>>();

function documentReady(doc: PageDocument): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  createRoot(dispose => {
    createEffect(() => {
      const status = doc.status();
      if (status === 'loading') return;
      const message = doc.statusMessage();
      dispose();
      if (status === 'ready') resolve();
      else reject(new Error(message));
    });
  });
  return promise;
}

function ensureField(notebook: NotebookClient, name: string): Promise<FieldDefinition> {
  const pending = fieldCreations.get(notebook) ?? new Map<string, Promise<FieldDefinition>>();
  fieldCreations.set(notebook, pending);
  const key = name.toLowerCase();
  const existing = pending.get(key);
  if (existing) return existing;
  const creation = (async () => {
    const result = await api.fields();
    const definition = result.fields.find(field => field.name.toLowerCase() === key);
    if (definition) return definition;
    const fieldsDoc = notebook.open(result.page_id);
    try {
      await documentReady(fieldsDoc);
      // An empty page is seeded with one blank block on load; name it instead of adding a sibling.
      let blank: string | undefined;
      for (const id of fieldsDoc.outline.children(result.page_id)) {
        const block = fieldsDoc.block(id);
        if (!block || block.archived) continue;
        if (block.text.toLowerCase() === key) return { id, name: block.text, kind: 'text' as const, revision: block.revision, options: [] };
        if (!block.text.trim() && !blank) blank = id;
      }
      const written = blank
        ? fieldsDoc.edit({ kind: 'text', id: blank, text: name })
        : fieldsDoc.edit({ kind: 'insert', parentId: result.page_id, after: fieldsDoc.outline.children(result.page_id).at(-1) ?? null, text: name });
      if (!written.ok) throw new Error(written.reason);
      return { id: blank ?? written.created[0]!, name, kind: 'text' as const, revision: 0, options: [] };
    } finally { fieldsDoc.release(); }
  })();
  pending.set(key, creation);
  void creation.then(() => pending.delete(key), () => pending.delete(key));
  return creation;
}

export function OutlinePane(props: OutlinePaneProps) {
  return <Show keyed when={props.pageId}>{pageId => <Pane {...props} pageId={pageId} />}</Show>;
}

function Pane(props: OutlinePaneProps) {
  const doc: PageDocument = props.notebook.open(props.pageId);
  const initial = untrack(() => props.view);
  const [zoom, setZoom] = createSignal(initial.zoom);
  const [folds, setFolds] = createSignal(new Set(initial.folds ?? storedFolds.get(`${props.pane}:${props.pageId}`) ?? []));
  const [showArchived, setShowArchived] = createSignal(initial.showArchived);
  const [caret, setCaret] = createSignal<Caret | null>(initial.caret);
  const [editing, setEditing] = createSignal<string | null>(initial.caret?.id ?? null);
  const [selected, setSelected] = createSignal<string | null>(initial.caret?.id ?? null);
  const [rowRange, setRowRange] = createSignal<RowRange | null>(null);
  const [textRange, setTextRange] = createSignal<TextRange | null>(null);
  const [composition, setComposition] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [completion, setCompletion] = createSignal<Completion | null>(null);
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [conflicts, setConflicts] = createSignal(new Set<string>());
  const [editedConflicts, setEditedConflicts] = createSignal(new Set<string>());
  const [margin, setMargin] = createSignal(0);
  let scroll!: HTMLDivElement;
  let list!: HTMLDivElement;
  let titleInput: HTMLInputElement | undefined;
  let completionList: HTMLDivElement | undefined;
  const hosts = new Map<string, HTMLElement>();
  let editor: PaneEditor | undefined;
  let rowKey = '';
  let restoring = true;
  let disposed = false;
  let focusEpoch = 0;
  let focusRequest: { id: string; offset: number; insert: boolean; epoch: number } | null = null;
  let reportingFrame = 0;
  let anchorFrame = 0;
  let anchorEpoch = 0;
  let drag: { anchor: Caret; moved: boolean; native: boolean } | null = null;
  let compositionSelection: { range: TextRange; id: string; original: string; from: number; to: number; committed?: string } | null = null;
  let compositionFrame = 0;
  const pendingFieldEntries = new Set<string>();
  const [createdFields, setCreatedFields] = createSignal<FieldDefinition[]>([]);
  const [fields] = createResource(() => props.notebook.changeSequence(), () => api.fields());
  const definitions = createMemo(() => {
    const result = new Map((fields.error ? [] : fields()?.fields ?? []).map(field => [field.id, field]));
    for (const field of createdFields()) if (!result.has(field.id)) result.set(field.id, field);
    return [...result.values()].filter(field => {
      const block = props.notebook.lookup(field.id)();
      return block !== null && !block?.archived;
    });
  });
  const definitionsById = createMemo(() => new Map(definitions().map(field => [field.id, field])));
  const [type] = createResource(
    () => doc.root()?.kind === 'page' ? [props.pageId, props.notebook.changeSequence()] as const : false,
    ([pageId]) => api.type(pageId),
  );

  function commitFieldEntry(id: string, focus = true): boolean {
    if (disposed || composition()) return false;
    if (pendingFieldEntries.has(id)) return true;
    const original = doc.block(id)?.text;
    if (original === undefined) return false;
    const match = matchFieldEntry(original);
    if (!match) return false;
    pendingFieldEntries.add(id);
    const before = caret()?.id === id ? { ...caret()! } : { id, offset: original.length };
    const epoch = focusEpoch;
    const heldDoc = props.notebook.open(props.pageId);
    setCompletion(null);
    void (async () => {
      try {
        const field = await ensureField(props.notebook, match.name);
        if (!disposed) setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]);
        if (heldDoc.block(id)?.text !== original) return;
        let result: EditResult;
        // The existing paste transaction rewrites the label and inserts a
        // first child atomically. Literal leading whitespace needs two edits.
        if (match.value === match.value.trimStart()) {
          result = heldDoc.edit({
            kind: 'replaceRange', range: { anchor: { id, offset: 0 }, head: { id, offset: original.length } },
            between: [], text: `${fieldEntryText(field.id)}\n  ${match.value}`, mode: 'paste',
          }, before);
        } else {
          result = heldDoc.edit({ kind: 'text', id, text: fieldEntryText(field.id) }, before);
          if (result.ok) {
            result = heldDoc.edit({ kind: 'insert', parentId: id, after: null, text: match.value }, before);
            if (result.ok && result.caret) result = { ...result, caret: { ...result.caret, offset: match.value.length } };
          }
        }
        if (!result.ok) throw new Error(result.reason);
        if (disposed) return;
        setMessage('');
        setFolds(previous => { const next = new Set(previous); next.delete(id); return next; });
        if (result.caret && focusEpoch === epoch) {
          const next = result.caret;
          setSelected(next.id);
          setCaret(next);
          setRowRange(null);
          setTextRange(null);
          setEditing(next.id);
          if (focus && props.active) queueMicrotask(() => editAt(next.id, next.offset, true, true, false));
        }
        scheduleReport();
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        pendingFieldEntries.delete(id);
        heldDoc.release();
      }
    })();
    return true;
  }

  const ids = createMemo(() => {
    doc.outline.version();
    return visibleIds(doc, zoom(), folds(), showArchived());
  });
  const indices = createMemo(() => new Map(ids().map((id, index) => [id, index])));
  const baseDepth = createMemo(() => zoom() ? doc.outline.depth(zoom()!) : 0);
  const selectedIds = createMemo(() => {
    const range = rowRange();
    if (!range) return selected() ? [selected()!] : [];
    const a = indices().get(range.anchor) ?? -1;
    const b = indices().get(range.head) ?? -1;
    return a < 0 || b < 0 ? [] : ids().slice(Math.min(a, b), Math.max(a, b) + 1);
  });
  const selectedSet = createMemo(() => new Set(selectedIds()));
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return ids().length; },
    getScrollElement: () => scroll,
    estimateSize: () => 32,
    overscan: 8,
    get scrollMargin() { return margin(); },
    get getItemKey() { const rows = ids(); return (index: number) => rows[index]!; },
    get rangeExtractor() {
      const active = indices().get(editing() ?? '');
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const result = defaultRangeExtractor(range);
        if (active !== undefined && !result.includes(active)) result.push(active);
        return result.sort((a, b) => a - b);
      };
    },
  });
  const virtualItems = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [String(item.key), item])));

  function currentAnchor(): ViewState['scroll'] {
    if (!scroll || !list) return null;
    const viewport = scroll.getBoundingClientRect();
    let anchor: ViewState['scroll'] = null;
    for (const candidate of list.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const rect = candidate.getBoundingClientRect();
      const offset = rect.top - viewport.top;
      if (rect.bottom > viewport.top + 1 && (!anchor || offset < anchor.offset)) anchor = { id: candidate.dataset.blockId!, offset };
    }
    return anchor;
  }
  function report() {
    if (restoring || disposed) return;
    props.onViewChange({ zoom: zoom(), folds: [...folds()], showArchived: showArchived(), caret: caret(), scroll: currentAnchor() });
  }
  function scheduleReport() {
    cancelAnimationFrame(reportingFrame);
    reportingFrame = requestAnimationFrame(report);
  }
  function restoreAnchor(anchor: ViewState['scroll']) {
    if (!anchor || !indices().has(anchor.id) || disposed) return;
    const epoch = ++anchorEpoch;
    cancelAnimationFrame(anchorFrame);
    virtualizer.scrollToIndex(indices().get(anchor.id)!, { align: 'start', behavior: 'auto' });
    let stable = 0;
    let previousHeight = -1;
    const correct = () => {
      if (disposed || epoch !== anchorEpoch || !indices().has(anchor.id)) return;
      const row = hosts.get(anchor.id)?.closest<HTMLElement>('[data-block-id]');
      if (!row) { virtualizer.scrollToIndex(indices().get(anchor.id)!, { align: 'start' }); anchorFrame = requestAnimationFrame(correct); return; }
      const delta = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
      const before = scroll.scrollTop;
      if (Math.abs(delta) > .5) scroll.scrollTop += delta;
      const clamped = scroll.scrollTop === before && Math.abs(delta) > .5 && previousHeight === scroll.scrollHeight;
      stable = Math.abs(delta) <= .5 || clamped ? stable + 1 : 0;
      previousHeight = scroll.scrollHeight;
      if (stable < 2) anchorFrame = requestAnimationFrame(correct);
      else scheduleReport();
    };
    anchorFrame = requestAnimationFrame(correct);
  }
  function anchored(change: () => void) {
    const anchor = currentAnchor();
    change();
    requestAnimationFrame(() => restoreAnchor(anchor));
  }
  function measure(label: 'typing' | 'structural', change: () => void) {
    const start = performance.now();
    change();
    const handler = performance.now() - start;
    document.dispatchEvent(new CustomEvent('outline-handler', { detail: { kind: label, handler, start } }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent('outline-latency', { detail: { kind: label, handler, start, frame: performance.now() - start } }));
    }));
  }
  function attach(id: string, host: HTMLElement) {
    hosts.set(id, host);
    if (editing() === id) queueMicrotask(() => mountEditor(id));
  }
  function mountEditor(id: string) {
    const host = hosts.get(id);
    const block = doc.block(id);
    if (disposed || !host || !block || !editor || editing() !== id) return;
    const request = focusRequest?.id === id && focusRequest.epoch === focusEpoch ? focusRequest : null;
    if (focusRequest?.id === id) focusRequest = null;
    if (!request && editor.id === id && host.contains(editor.view.dom)) { editor.sync(block.text); return; }
    const offset = request?.offset ?? (caret()?.id === id ? caret()!.offset : 0);
    const popupFocused = document.activeElement?.closest('[role="dialog"], [role="menu"], [role="listbox"]');
    editor.mount(host, id, block.text, offset, request?.insert ?? !props.vim, !!request && props.active && !popupFocused && !renaming());
    virtualizer.measureElement(host.closest<HTMLDivElement>('[data-index]')!);
  }
  function editAt(id: string, offset = 0, insert = !props.vim, reveal = true, activate = true) {
    if (disposed || composition() || !indices().has(id)) return;
    const previous = editing();
    if (previous && previous !== id && commitFieldEntry(previous)) return;
    if (activate) props.onActivate();
    offset = Math.max(0, Math.min(offset, doc.block(id)?.text.length ?? 0));
    setSelected(id);
    setRowRange(null);
    setCaret({ id, offset });
    focusRequest = { id, offset, insert, epoch: ++focusEpoch };
    setEditing(id);
    const requestEpoch = focusEpoch;
    const index = indices().get(id)!;
    const host = hosts.get(id);
    const row = host?.closest<HTMLElement>('[data-block-id]');
    const viewport = scroll.getBoundingClientRect();
    if (reveal && (!row || row.getBoundingClientRect().top < viewport.top || row.getBoundingClientRect().bottom > viewport.bottom)) virtualizer.scrollToIndex(index, { align: 'auto' });
    queueMicrotask(() => mountEditor(id));
    if (reveal) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed || !props.active || editing() !== id || focusEpoch !== requestEpoch) return;
      const mounted = hosts.get(id)?.closest<HTMLElement>('[data-block-id]');
      if (!mounted) return;
      const bounds = scroll.getBoundingClientRect();
      const target = mounted.getBoundingClientRect();
      if (target.top < bounds.top) scroll.scrollTop += target.top - bounds.top;
      else if (target.bottom > bounds.bottom) scroll.scrollTop += Math.min(target.bottom - bounds.bottom, target.top - bounds.top);
    }));
    scheduleReport();
  }
  function rowFocus(id: string, extend = false) {
    if (disposed || composition() || !indices().has(id)) return;
    const previous = editing();
    if (previous && commitFieldEntry(previous)) return;
    focusEpoch++;
    focusRequest = null;
    props.onActivate();
    setCompletion(null);
    setEditing(null);
    setTextRange(null);
    const anchor = rowRange()?.anchor ?? selected() ?? id;
    setRowRange(extend ? { anchor, head: id } : null);
    setSelected(id);
    setCaret({ id, offset: 0 });
    props.onVimMode(props.vim ? 'outline' : null);
    scroll.focus({ preventScroll: true });
    virtualizer.scrollToIndex(indices().get(id) ?? 0, { align: 'auto' });
    scheduleReport();
  }
  function apply(intent: Edit, keepEditing = editing() !== null) {
    if (disposed || composition()) return;
    const epoch = focusEpoch;
    let result: EditResult | undefined;
    measure('structural', () => anchored(() => { result = doc.edit(intent, caret()); }));
    if (!result || !result.ok) { setMessage(result && !result.ok ? result.reason : 'The edit could not be applied.'); return; }
    setMessage('');
    setTextRange(null);
    setRowRange(null);
    const next = result.caret;
    if (next) queueMicrotask(() => { if (!disposed && props.active && focusEpoch === epoch) keepEditing ? editAt(next.id, next.offset, true, true, false) : rowFocus(next.id); });
    else if (selected() && !doc.block(selected()!)) {
      const first = ids()[0];
      setEditing(null);
      setSelected(first ?? null);
      setCaret(first ? { id: first, offset: 0 } : null);
    }
    scheduleReport();
  }
  function roots() { return selectionRoots(doc, selectedIds()); }
  function restoreSelection(range: TextRange) {
    if (!editor || editor.id !== range.head.id) return;
    const anchor = range.anchor.id === range.head.id ? range.anchor.offset
      : doc.outline.indexOf(range.anchor.id) < doc.outline.indexOf(range.head.id) ? 0 : editor.view.state.doc.length;
    setTextRange(range.anchor.id === range.head.id ? null : range);
    editor.view.dispatch({ selection: { anchor, head: range.head.offset } });
  }
  function undo(redo = false) {
    if (disposed || composition()) return;
    const result = redo ? doc.redo() : doc.undo();
    const epoch = focusEpoch;
    setMessage('');
    setTextRange(null);
    setRowRange(null);
    if (result) queueMicrotask(() => {
      if (disposed || !props.active || focusEpoch !== epoch) return;
      const target = result.range?.head ?? result;
      editAt(target.id, target.offset, !props.vim, true, false);
      if (result.range) queueMicrotask(() => { if (!disposed && props.active && editing() === target.id) restoreSelection(result.range!); });
    });
  }
  function activeRange(): TextRange | null {
    const across = textRange();
    if (across) return across;
    const id = editing() ?? selected();
    if (!id || !doc.block(id)) return null;
    if (editing() === id && editor?.id === id) {
      const selection = editor.view.state.selection.main;
      return { anchor: { id, offset: selection.anchor }, head: { id, offset: selection.head } };
    }
    const at = { id, offset: caret()?.id === id ? caret()!.offset : 0 };
    return { anchor: at, head: at };
  }
  function replaceSelection(text: string, mode: 'text' | 'paste' | 'split', range = activeRange()) {
    if (!range) return;
    const visible = selectionIds(ids(), range);
    apply({ kind: 'replaceRange', range, between: visible.slice(1, -1), text, mode, zoomRoot: zoom() }, true);
  }
  function deleteTextRange() { if (textRange()) replaceSelection('', 'text'); }
  function fold(id = selected()) {
    if (!id || composition()) return;
    anchored(() => setFolds(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }));
    report();
    scheduleReport();
  }
  function zoomTo(id: string | null) {
    if (composition()) return;
    if (editing() && commitFieldEntry(editing()!)) return;
    setZoom(id);
    setRowRange(null);
    setTextRange(null);
    setEditing(null);
    setSelected(null);
    setCaret(null);
    scroll.scrollTop = 0;
    const first = ids()[0];
    if (first) rowFocus(first);
    report();
    scheduleReport();
  }
  function zoomOut() {
    const id = zoom();
    if (id) zoomTo(doc.outline.parentOf(id) === props.pageId ? null : doc.outline.parentOf(id));
  }
  function horizontal(direction: 'left' | 'right') {
    const id = selected();
    if (!id) return;
    if (direction === 'left') {
      if (doc.outline.children(id).length && !folds().has(id)) fold(id);
      else { const parent = doc.outline.parentOf(id); if (indices().has(parent)) rowFocus(parent); }
    } else if (folds().has(id)) fold(id);
    else { const child = doc.outline.children(id)[0]; if (child && indices().has(child)) rowFocus(child); }
  }
  function adjacent(direction: number, extend = false) {
    const index = indices().get(selected() ?? '') ?? 0;
    const id = ids()[Math.max(0, Math.min(ids().length - 1, index + direction))];
    if (id) rowFocus(id, extend);
  }
  function split(_view: EditorView) {
    if (editing() && commitFieldEntry(editing()!)) return;
    replaceSelection('', 'split');
  }
  function backspace(view: EditorView) {
    if (textRange()) { deleteTextRange(); return true; }
    const id = editing();
    if (!id || view.state.selection.main.head !== 0 || !view.state.selection.main.empty) return false;
    const block = doc.block(id)!;
    if (block.heading) apply({ kind: 'heading', id, level: null });
    else if (doc.outline.depth(id) > 0) apply({ kind: 'outdent', ids: [id] });
    else {
      const siblings = doc.outline.children(props.pageId);
      const previous = siblings[siblings.indexOf(id) - 1];
      if (previous) apply({ kind: 'merge', sourceId: id, destinationId: previous });
    }
    return true;
  }
  function crossArrow(event: KeyboardEvent, view: EditorView) {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    const head = view.state.selection.main.head;
    const rect = view.coordsAtPos(head);
    const first = view.coordsAtPos(0);
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
    if (event.shiftKey) queueMicrotask(() => {
      if (editor?.id !== id) return;
      editor.view.dispatch({ selection: { anchor: anchor.id === id ? anchor.offset : direction > 0 ? 0 : editor.view.state.doc.length, head: offset } });
    });
    return true;
  }
  function popupKey(event: KeyboardEvent) {
    if (!completion()) return false;
    const count = completionRows().length + (canCreate() ? 1 : 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setCompletionIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (event.key === 'Enter') { void chooseCompletion(); return true; }
    if (event.key === 'Escape') { setCompletion(null); return true; }
    return false;
  }
  function editorKey(event: KeyboardEvent, view: EditorView) {
    if (popupKey(event)) return true;
    if (commonKey(event)) return true;
    if (event.key === 'Escape' && (!props.vim || editor?.mode() === 'normal')) { if (editing()) rowFocus(editing()!); return true; }
    if (props.vim && editor?.mode() !== 'insert') {
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
    if (event.key === 'Delete' && textRange()) { deleteTextRange(); return true; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (!event.shiftKey) setTextRange(null);
      return crossArrow(event, view);
    }
    return false;
  }
  function commonKey(event: KeyboardEvent) {
    if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 't') { openTable(false); return true; }
    if (event.metaKey && event.key.toLowerCase() === 'z') { undo(event.shiftKey); return true; }
    if (event.metaKey && event.key === 'Enter') { event.shiftKey ? zoomOut() : selected() && zoomTo(selected()); return true; }
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { apply({ kind: 'move', ids: roots(), direction: event.key === 'ArrowUp' ? 'up' : 'down' }); return true; }
    return false;
  }
  function structuralKey(event: KeyboardEvent) {
    if (!event.defaultPrevented && !event.isComposing && !composition() && props.active && event.metaKey && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      openTable(false);
      return;
    }
    if (event.target === scroll && !event.isComposing && !composition()) {
      if (textRange() && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); replaceSelection(event.key, 'text'); return; }
      if (editing() && editor?.id === editing()) {
        editor.view.focus();
        if (editorKey(event, editor.view) || editor.forwardVim(event)) { event.preventDefault(); return; }
        const selection = editor.view.state.selection.main;
        if (event.key === 'Backspace' || event.key === 'Delete') {
          let from = selection.from, to = selection.to;
          if (selection.empty && event.key === 'Backspace') for (const segment of graphemes.segment(editor.view.state.doc.sliceString(0, from))) from = segment.index;
          else if (selection.empty) { const next = graphemes.segment(editor.view.state.doc.sliceString(to))[Symbol.iterator]().next(); to += next.value?.segment.length ?? 0; }
          editor.view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
          event.preventDefault();
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { editor.view.dispatch(editor.view.state.replaceSelection(event.key)); event.preventDefault(); }
        return;
      }
    }
    if (event.target !== scroll || event.isComposing || composition()) return;
    let handled = false;
    if (textRange() && (event.key === 'Backspace' || event.key === 'Delete')) { deleteTextRange(); handled = true; }
    if (!handled) handled = commonKey(event);
    if (!handled && event.key === 'ArrowDown') { adjacent(1, event.shiftKey); handled = true; }
    if (!handled && event.key === 'ArrowUp') { adjacent(-1, event.shiftKey); handled = true; }
    if (!handled && event.key === 'ArrowLeft') { horizontal('left'); handled = true; }
    if (!handled && event.key === 'ArrowRight') { horizontal('right'); handled = true; }
    if (!handled && event.key === 'Enter' && selected()) { props.vim ? zoomTo(selected()) : editAt(selected()!, 0, true); handled = true; }
    if (!handled && event.key === 'Backspace') { props.vim ? zoomOut() : apply({ kind: 'delete', ids: roots() }, false); handled = true; }
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
    if (['i', 'a', 'I', 'A'].includes(key) && selected()) { const id = selected()!; editAt(id, key === 'A' || key === 'a' ? doc.block(id)!.text.length : 0, true); return true; }
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

  function updateCompletion(text: string, at: Caret) {
    const prefix = text.slice(0, at.offset);
    const from = prefix.lastIndexOf('[[');
    if (from < 0 || prefix.slice(from + 2).includes(']') || prefix[from - 1] === '#' || prefix.slice(from + 2).includes('\n')) { setCompletion(null); return; }
    const next = { from, to: at.offset, query: prefix.slice(from + 2) };
    if (completion()?.query !== next.query) setCompletionIndex(0);
    setCompletion(next);
  }
  const [matches] = createResource(() => completion()?.query, query => api.complete(query));
  const completionRows = createMemo<CompletionRow[]>(() => {
    const query = completion()?.query.toLowerCase() ?? '';
    const matchingFields = definitions().filter(field => field.name.toLowerCase().includes(query));
    const byId = new Map(matchingFields.map(field => [field.id, field]));
    const rows: CompletionRow[] = (matches.error ? [] : matches() ?? []).map(block => {
      const field = byId.get(block.id);
      byId.delete(block.id);
      return field ? { kind: 'field', field } : { kind: 'block', block };
    });
    for (const field of byId.values()) rows.push({ kind: 'field', field });
    return rows;
  });
  const canCreate = createMemo(() => !!completion()?.query.trim() && !matches.loading && !matches.error && !fields.loading && !fields.error && completionRows().length === 0);
  createEffect(() => {
    completionIndex();
    completionRows();
    if (!completion()) return;
    requestAnimationFrame(() => {
      if (completionList?.isConnected) completionList.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  });
  function insertReference(id: string) {
    const state = completion();
    if (!state || !editor) return;
    setCompletion(null);
    editor.view.dispatch({ changes: { from: state.from, to: state.to, insert: `[[${id}]]` }, selection: { anchor: state.from + id.length + 4 } });
    setCompletion(null);
    editor.view.focus();
  }
  async function chooseCompletion(index = completionIndex()) {
    const row = completionRows()[index];
    if (row?.kind === 'field') { insertReference(row.field.id); return; }
    if (matches.loading || matches.error) return;
    if (row) { insertReference(row.block.id); return; }
    if (canCreate()) {
      try { const id = await props.notebook.createPage(completion()!.query.trim()); insertReference(id); }
      catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }
  }
  function completionAnchor(): DOMRect | null {
    const rect = editor?.view.coordsAtPos(editor.view.state.selection.main.head);
    return rect ? new DOMRect(rect.left, rect.top, Math.max(1, rect.right - rect.left), rect.bottom - rect.top) : null;
  }

  function rename() { if (doc.root()?.kind !== 'page') return; setTitle(doc.root()!.text); setRenaming(true); queueMicrotask(() => { titleInput?.focus(); titleInput?.select(); }); }
  function commitTitle() {
    const result = doc.rename(title());
    if (result.ok) { setRenaming(false); setMessage(''); }
    else { setMessage(result.reason); titleInput?.focus(); }
  }
  function openTable(beside: boolean) {
    if (doc.root()?.kind !== 'page') return;
    if (editing()) commitFieldEntry(editing()!, false);
    props.onOpen({ kind: 'table', typeId: props.pageId, viewId: null, query: { type: props.pageId, text: null, filters: [], sort: [], limit: null } }, beside);
  }
  function openSelected(beside: boolean) {
    const id = selected();
    if (!id) return;
    const reference = textTokens(doc.block(id)?.text ?? '').find(token => token.kind === 'reference');
    const target = reference?.id ? props.notebook.lookup(reference.id)() : null;
    props.onOpen(target ? { kind: 'page', pageId: target.page_id, blockId: target.kind === 'block' ? target.id : undefined } : { kind: 'page', pageId: props.pageId, blockId: id }, beside);
  }
  function copy(text: string) { void navigator.clipboard.writeText(text).catch(error => setMessage(`Couldn't copy: ${String(error)}`)); }
  function referenceMenu(id: string, anchor: HTMLElement) {
    const block = props.notebook.lookup(id)();
    const open = (beside: boolean) => block && props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? id : undefined }, beside);
    setMenu({ anchor, label: 'Reference actions', items: [
      { label: 'Open here', icon: 'link', disabledReason: block ? undefined : 'The reference is unresolved.', action: () => open(false) },
      { label: 'Open beside', icon: 'panes', disabledReason: block ? undefined : 'The reference is unresolved.', action: () => open(true) },
      { label: 'Copy reference', icon: 'copy', action: () => copy(`[[${id}]]`) },
    ] });
  }
  const commandDefinitions: Command[] = [
    { id: 'rename', title: 'Rename page', section: 'Page', disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal dates cannot be renamed.', run: rename },
    { id: 'open-table', title: 'Open as table', section: 'Page', keys: ['⌘⇧T'], disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal days cannot be opened as tables.', run: () => openTable(false) },
    { id: 'previous-row', title: 'Select previous block', section: 'Navigation', keys: ['↑', 'k'], run: () => adjacent(-1) },
    { id: 'next-row', title: 'Select next block', section: 'Navigation', keys: ['↓', 'j'], run: () => adjacent(1) },
    { id: 'parent', title: 'Fold children / select parent', section: 'Navigation', keys: ['←', 'h'], run: () => horizontal('left') },
    { id: 'child', title: 'Unfold children / select first child', section: 'Navigation', keys: ['→', 'l'], run: () => horizontal('right') },
    { id: 'first-row', title: 'Select first block', section: 'Navigation', keys: ['gg'], run: () => ids()[0] && rowFocus(ids()[0]!) },
    { id: 'last-row', title: 'Select last block', section: 'Navigation', keys: ['G'], run: () => ids().at(-1) && rowFocus(ids().at(-1)!) },
    { id: 'extend-up', title: 'Extend block selection up', section: 'Outline', keys: ['⇧↑'], run: () => adjacent(-1, true) },
    { id: 'extend-down', title: 'Extend block selection down', section: 'Outline', keys: ['⇧↓'], run: () => adjacent(1, true) },
    { id: 'edit', title: 'Edit block', section: 'Editing', keys: ['Enter', 'i'], run: () => selected() && editAt(selected()!, caret()?.offset ?? 0, true) },
    { id: 'split', title: 'Split block', section: 'Editing', keys: ['Enter'], run: () => editing() && editor && split(editor.view) },
    { id: 'newline', title: 'Insert newline', section: 'Editing', keys: ['⇧Enter'], run: () => editor?.view.dispatch(editor.view.state.replaceSelection('\n')) },
    { id: 'insert-below', title: 'Insert block below', section: 'Editing', keys: ['o'], run: () => selected() && apply({ kind: 'insert', parentId: doc.outline.parentOf(selected()!), after: selected() }, true) },
    { id: 'insert-above', title: 'Insert block above', section: 'Editing', keys: ['O'], run: () => { const id = selected(); if (!id) return; const parentId = doc.outline.parentOf(id); const siblings = doc.outline.children(parentId); apply({ kind: 'insert', parentId, after: siblings[siblings.indexOf(id) - 1] ?? null }, true); } },
    { id: 'indent', title: 'Indent blocks', section: 'Outline', keys: ['Tab', '>>'], run: () => apply({ kind: 'indent', ids: roots() }) },
    { id: 'outdent', title: 'Outdent blocks', section: 'Outline', keys: ['⇧Tab', '<<'], run: () => apply({ kind: 'outdent', ids: roots() }) },
    { id: 'move-up', title: 'Move blocks up', section: 'Outline', keys: ['⌥↑'], run: () => apply({ kind: 'move', ids: roots(), direction: 'up' }) },
    { id: 'move-down', title: 'Move blocks down', section: 'Outline', keys: ['⌥↓'], run: () => apply({ kind: 'move', ids: roots(), direction: 'down' }) },
    { id: 'select', title: 'Select blocks', section: 'Outline', keys: ['V', '⇧↑/↓'], run: () => selected() && rowFocus(selected()!, true) },
    { id: 'select-all', title: 'Select all visible blocks', section: 'Outline', run: () => { const first = ids()[0]; const last = ids().at(-1); if (first && last) { rowFocus(last); setRowRange({ anchor: first, head: last }); } } },
    { id: 'fold', title: 'Fold / unfold children', section: 'View', keys: ['←/→', 'h/l'], run: () => fold() },
    { id: 'zoom', title: 'Zoom into block', section: 'Navigation', keys: ['⌘Enter'], run: () => selected() && zoomTo(selected()) },
    { id: 'zoom-out', title: 'Zoom out', section: 'Navigation', keys: ['⌘⇧Enter'], disabledReason: () => zoom() ? undefined : 'Already at the page root.', run: zoomOut },
    { id: 'open-beside', title: 'Open selected target beside', section: 'Navigation', keys: ['⌃⇧O'], run: () => openSelected(true) },
    { id: 'copy-reference', title: 'Copy block reference', section: 'Editing', run: () => selected() && copy(`[[${selected()}]]`) },
    { id: 'archive', title: 'Archive / unarchive block', section: 'Outline', run: () => selected() && apply({ kind: 'archive', id: selected()!, archived: !doc.block(selected()!)?.archived }, false) },
    { id: 'show-archived', title: 'Show / hide archived blocks', section: 'View', run: () => { anchored(() => setShowArchived(value => !value)); scheduleReport(); } },
    { id: 'delete', title: 'Delete selected subtrees', section: 'Outline', keys: ['Backspace', 'dd'], run: () => apply({ kind: 'delete', ids: roots() }, false) },
    { id: 'undo', title: 'Undo', section: 'Editing', keys: ['⌘Z', 'u'], disabledReason: () => doc.canUndo() ? undefined : 'Nothing to undo.', run: () => undo() },
    { id: 'redo', title: 'Redo', section: 'Editing', keys: ['⌘⇧Z', '⌃R'], disabledReason: () => doc.canRedo() ? undefined : 'Nothing to redo.', run: () => undo(true) },
    { id: 'review-conflict', title: 'Review conflict', section: 'Editing', disabledReason: () => {
      doc.outline.version();
      for (let index = 0; index < doc.outline.size(); index++) if (doc.block(doc.outline.idAt(index))?.conflict) return undefined;
      return 'No conflicting blocks.';
    }, run: () => {
      for (let index = 0; index < doc.outline.size(); index++) {
        const id = doc.outline.idAt(index);
        if (!doc.block(id)?.conflict) continue;
        setConflicts(previous => new Set([...previous, id]));
        if (!indices().has(id)) { setFolds(new Set<string>()); setShowArchived(true); setZoom(null); }
        editAt(id, 0, false);
        break;
      }
    } },
    ...([null, 1, 2, 3] as const).map(level => ({ id: `heading-${level ?? 'normal'}`, title: level ? `Heading ${level}` : 'Normal text', section: 'Editing' as const, run: () => selected() && apply({ kind: 'heading', id: selected()!, level }) })),
  ];
  const commands = commandDefinitions.map(command => ({ ...command, id: `outline.${props.pane}.${command.id}`, disabledReason: () => !props.active ? 'This pane is not active.' : command.disabledReason?.() ?? (command.section !== 'Page' && !['zoom-out', 'show-archived', 'undo', 'redo'].includes(command.id) && !selected() ? 'Select a block first.' : undefined) }));
  const unregister = props.commands.register(commands);
  function blockMenu(id: string, anchor: HTMLElement) {
    if (!selectedSet().has(id)) rowFocus(id);
    setMenu({ anchor, label: 'Block actions', items: commands.filter(command => command.section !== 'Page').map(command => ({ label: command.title, shortcut: command.keys?.[0], disabledReason: command.disabledReason?.(), danger: command.id.endsWith('.delete'), action: command.run })) });
  }

  function selectedOffsets(id: string): [number, number] | null {
    const range = textRange();
    if (!range || !selectionIds(ids(), range).includes(id)) return null;
    const [start, end] = orderedRange(doc, range);
    return [id === start.id ? start.offset : 0, id === end.id ? end.offset : doc.block(id)?.text.length ?? 0];
  }
  function pointerStart(event: MouseEvent, id: string, element: HTMLElement) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    if (event.shiftKey) { event.preventDefault(); rowFocus(id, true); return; }
    if (editing() && editing() !== id && commitFieldEntry(editing()!)) { event.preventDefault(); return; }
    const text = doc.block(id)?.text ?? '';
    const native = editor?.id === id && editor.view.dom.contains(event.target as Node);
    const offset = native ? editor!.view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? 0 : offsetAtPoint(element, text, event.clientX, event.clientY);
    drag = { anchor: { id, offset }, moved: false, native };
    setTextRange(null);
    if (!native) { event.preventDefault(); editAt(id, offset, true); }
  }
  function pointerMove(event: MouseEvent) {
    if (!drag || !(event.buttons & 1)) return;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-block-id]');
    const id = element?.dataset.blockId;
    if (!element || !id || !scroll.contains(element) || id === drag.anchor.id && drag.native && !drag.moved) return;
    const body = element.querySelector<HTMLElement>('.outline-body')!;
    const offset = editing() === id && editor?.id === id ? editor.view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? 0 : offsetAtPoint(body, doc.block(id)?.text ?? '', event.clientX, event.clientY);
    if (!drag.moved && id === drag.anchor.id && offset === drag.anchor.offset) return;
    drag.moved = true;
    const range = { anchor: drag.anchor, head: { id, offset } };
    setTextRange(range);
    if (editor?.id === id && editing() === id) restoreSelection(range);
    event.preventDefault();
    if (event.clientY > scroll.getBoundingClientRect().bottom - 24) scroll.scrollTop += 24;
    else if (event.clientY < scroll.getBoundingClientRect().top + 24) scroll.scrollTop -= 24;
  }
  function pointerEnd() {
    if (drag?.moved && textRange()) {
      const range = textRange()!;
      if (editing() && editing() !== range.head.id && commitFieldEntry(editing()!)) { drag = null; return; }
      editAt(range.head.id, range.head.offset, true, false);
      setTextRange(range);
      queueMicrotask(() => { if (!disposed && props.active) restoreSelection(range); });
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
    if (!textRange() || !textInputTarget(event) || composition() || compositionSelection || event.isComposing) return;
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
      if (event.data === null) return;
      event.preventDefault(); event.stopImmediatePropagation(); replaceSelection(event.data, 'text');
    } else if (event.inputType.startsWith('delete')) {
      event.preventDefault(); event.stopImmediatePropagation(); deleteTextRange();
    }
  }
  function composing(active: boolean, committed?: string) {
    if (active && textRange() && editor) {
      const selection = editor.view.state.selection.main;
      compositionSelection = { range: textRange()!, id: editor.id, original: editor.view.state.doc.toString(), from: selection.from, to: selection.to };
    }
    setComposition(active);
    if (!active && compositionSelection) {
      const snapshot = compositionSelection;
      snapshot.committed = committed;
      cancelAnimationFrame(compositionFrame);
      compositionFrame = requestAnimationFrame(() => {
        if (disposed || compositionSelection !== snapshot || editor?.id !== snapshot.id) return;
        const text = editor.view.state.doc.toString();
        compositionSelection = null;
        if (snapshot.committed || text !== snapshot.original) {
          const suffix = snapshot.original.length - snapshot.to;
          replaceSelection(snapshot.committed || text.slice(snapshot.from, Math.max(snapshot.from, text.length - suffix)), 'text', snapshot.range);
        } else restoreSelection(snapshot.range);
      });
    }
  }

  const [relatedOpen, setRelatedOpen] = createSignal(new Set<string>());
  const [relatedVersion, setRelatedVersion] = createSignal(0);
  let relatedTimer: number | undefined;
  createEffect(() => {
    props.notebook.changeSequence();
    window.clearTimeout(relatedTimer);
    if (!relatedOpen().size) return;
    relatedTimer = window.setTimeout(() => setRelatedVersion(value => value + 1), 500);
  });
  onCleanup(() => window.clearTimeout(relatedTimer));
  const [related] = createResource(() => `${props.pageId}:${relatedVersion()}`, async () => {
    const [backlinks, tagged] = await Promise.all([api.backlinks(props.pageId), api.members(props.pageId)]);
    return { backlinks: backlinks.map(item => ({ block: item.source, page: item.page })), tagged };
  });
  const breadcrumbs = createMemo(() => {
    doc.outline.version();
    const path: string[] = [];
    let id = zoom();
    while (id && id !== props.pageId) { path.unshift(id); const parent = doc.outline.parentOf(id); if (parent === id) break; id = parent; }
    return path;
  });

  onMount(() => {
    const copy = (event: ClipboardEvent) => clipboard(event);
    const cut = (event: ClipboardEvent) => clipboard(event, true);
    scroll.addEventListener('copy', copy, true);
    scroll.addEventListener('cut', cut, true);
    scroll.addEventListener('paste', paste, true);
    scroll.addEventListener('beforeinput', beforeInput, true);
    onCleanup(() => { scroll.removeEventListener('copy', copy, true); scroll.removeEventListener('cut', cut, true); scroll.removeEventListener('paste', paste, true); scroll.removeEventListener('beforeinput', beforeInput, true); cancelAnimationFrame(compositionFrame); });
    editor = new PaneEditor({
      key: editorKey,
      blur: () => { if (editor?.id && editing() === editor.id) commitFieldEntry(editor.id, false); },
      text: (text, at) => measure('typing', () => {
        if (compositionSelection) return;
        const heading = /^(#{1,3}) $/.exec(text);
        if (heading && !composition()) {
          const result = doc.edit({ kind: 'text', id: at.id, text: '', heading: heading[1]!.length as 1 | 2 | 3 }, caret());
          if (!result.ok) setMessage(result.reason);
          else { queueMicrotask(() => editor?.sync('')); setCaret({ id: at.id, offset: 0 }); }
        } else { const result = doc.edit({ kind: 'text', id: at.id, text }, caret()); if (!result.ok) setMessage(result.reason); }
        updateCompletion(text, at);
      }),
      selection: at => {
        if (compositionSelection || textRange() && textRange()!.head.id !== at.id) return;
        focusEpoch++;
        setCaret(at);
        setTextRange(previous => previous && previous.head.id === at.id ? { anchor: previous.anchor, head: at } : previous);
        if (editor) updateCompletion(editor.view.state.doc.toString(), at);
        scheduleReport();
      },
      composition: composing,
      mode: mode => { if (editing()) props.onVimMode(props.vim ? mode : null); },
    });
    editor.configure(props.vim);
    const observer = new ResizeObserver(() => { setMargin(list.offsetTop); });
    observer.observe(scroll.querySelector('.outline-heading')!);
    setMargin(list.offsetTop);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerEnd);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('mousemove', pointerMove); document.removeEventListener('mouseup', pointerEnd); });
  });
  createEffect(() => { const enabled = props.vim; if (editor) { editor.configure(enabled); props.onVimMode(enabled ? editing() ? editor.mode() : 'outline' : null); } });
  createEffect(() => {
    if (doc.status() !== 'ready' || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      const saved = initial.caret;
      let first: Caret | null = saved && doc.block(saved.id) && indices().has(saved.id) ? saved : null;
      if (!saved && doc.root()?.kind === 'journal') {
        const siblings = doc.outline.children(props.pageId);
        let empty: string | undefined;
        for (let index = siblings.length - 1; index >= 0; index--) {
          const id = siblings[index]!;
          if (doc.block(id)?.text === '' && !doc.block(id)?.archived) { empty = id; break; }
        }
        if (empty) first = { id: empty, offset: 0 };
        else {
          const result = doc.edit({ kind: 'insert', parentId: props.pageId, after: siblings.at(-1) ?? null }, null);
          if (result.ok) first = result.caret;
          else setMessage(result.reason);
        }
      } else if (!first) { const id = ids()[0]; first = id ? { id, offset: 0 } : null; }
      if (first) editAt(first.id, first.offset, !props.vim, !initial.scroll, false);
      if (initial.scroll) requestAnimationFrame(() => restoreAnchor(initial.scroll));
    }
  });
  createEffect(() => { const id = editing(); const text = id ? doc.block(id)?.text : undefined; if (text !== undefined && editor?.id === id) queueMicrotask(() => { if (editor?.id === id) editor.sync(text); }); });
  createEffect(() => {
    const visible = ids();
    const id = editing();
    if (id && !visible.includes(id) && !composition()) { setEditing(null); const first = visible[0] ?? null; setSelected(first); setCaret(first ? { id: first, offset: 0 } : null); }
  });
  createEffect(() => { storedFolds.set(`${props.pane}:${props.pageId}`, new Set(folds())); });
  onCleanup(() => {
    if (editing()) commitFieldEntry(editing()!, false);
    disposed = true;
    unregister();
    doc.release();
    editor?.destroy();
    cancelAnimationFrame(reportingFrame);
    cancelAnimationFrame(anchorFrame);
  });

  function Row(propsRow: { id: string; item: Accessor<VirtualItem> }) {
    const id = () => propsRow.id;
    const block = () => doc.block(id());
    const children = () => doc.outline.children(id()).length > 0;
    const field = createMemo(() => definitionsById().get(fieldEntryId(block()?.text ?? '') ?? ''));
    let row!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(row));
    onCleanup(() => { const host = hosts.get(id()); if (host && row.contains(host)) hosts.delete(id()); });
    return <div ref={row} id={`outline-${props.pane}-${id()}`} data-index={propsRow.item().index} data-block-id={id()} role="treeitem" aria-level={doc.outline.depth(id()) - baseDepth() + 1}
      aria-expanded={children() ? !folds().has(id()) : undefined} aria-selected={selectedSet().has(id())}
      class="outline-row" classList={{ 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field() }}
      style={{ transform: `translateY(${propsRow.item().start - margin()}px)`, '--depth': doc.outline.depth(id()) - baseDepth() }}>
      <button type="button" class="row-menu icon-button" aria-label="Block actions" onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children() }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name={folds().has(id()) ? 'right' : 'down'} /></button>
      <button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()) }} aria-label="Zoom into block" onClick={() => zoomTo(id())}><Icon name="bullet" /></button>
      <div class="outline-body" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }} onMouseDown={event => pointerStart(event, id(), event.currentTarget)}>
        <Show when={field() && editing() === id()}><Icon name="field" class="field-entry-icon" /></Show>
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id()}><div class="static-text"><BlockText text={block()?.text ?? ''} field={field()} notebook={props.notebook} onOpen={props.onOpen} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /><Show when={!block()?.text}><span class="empty-block">Empty block</span></Show></div></Show>
        <Show when={block()?.archived}><span class="archive-badge">Archived</span> <button class="text-button" type="button" onClick={() => apply({ kind: 'archive', id: id(), archived: false }, false)}>Unarchive</button></Show>
        <Show when={block()?.conflict}><button type="button" class="conflict-label" onClick={() => setConflicts(previous => { const next = new Set(previous); next.has(id()) ? next.delete(id()) : next.add(id()); return next; })}><Icon name="warning" />Conflict</button></Show>
        <Show when={block()?.conflict && conflicts().has(id())}><div class="conflict-panel">
          <strong>Your version</strong><pre>{block()?.text}</pre><strong>Notebook version</strong><pre>{block()?.conflict?.remoteText}</pre>
          <div class="conflict-actions"><button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use yours</button><button type="button" onClick={() => doc.resolveConflict(id(), 'theirs')}>Use notebook</button>
            <Show when={!editedConflicts().has(id())} fallback={<button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use edited text</button>}><button type="button" onClick={() => { setEditedConflicts(previous => new Set([...previous, id()])); editAt(id(), 0, true); }}>Edit merged text</button></Show></div>
        </div></Show>
      </div>
    </div>;
  }

  function Related(propsRelated: { title: string; rows: { block: Block; page: Block }[]; empty: string }) {
    return <details class="related-section" onToggle={event => setRelatedOpen(previous => {
      const next = new Set(previous);
      event.currentTarget.open ? next.add(propsRelated.title) : next.delete(propsRelated.title);
      return next;
    })}><summary>{propsRelated.title} <span>{related.error ? 'Unavailable' : related.loading && !related() ? 'Loading…' : propsRelated.rows.length}</span></summary>
      <Show when={!related.error} fallback={<p role="alert">Couldn't load related blocks.</p>}>
      <Show when={propsRelated.rows.length} fallback={<p class="empty-state">{propsRelated.empty}</p>}><For each={propsRelated.rows}>{result => {
        const live = props.notebook.lookup(result.block.id);
        return <div class="related-block"><div class="related-open" role="link" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey); }} onClick={event => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey)}>
          <span class="related-breadcrumb"><BlockBreadcrumb block={result.block} notebook={props.notebook} /></span>
          <BlockText text={live()?.text ?? result.block.text} notebook={props.notebook} onOpen={props.onOpen} />
        </div><button type="button" class="text-button" onClick={() => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, true)}>Open beside</button></div>;
      }}</For></Show>
      </Show>
    </details>;
  }

  return <div ref={scroll} class="outline-pane" data-pane={props.pane} tabIndex={0} role="tree" aria-label="Page outline" aria-owns={[...virtualItems().keys()].map(id => `outline-${props.pane}-${id}`).join(' ')} onFocusIn={props.onActivate} onFocusOut={report} onKeyDown={structuralKey} onWheel={() => { anchorEpoch++; cancelAnimationFrame(anchorFrame); }} onScroll={scheduleReport}>
    <div class="outline-heading">
      <Show when={zoom()}><nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs"><button type="button" onClick={() => zoomTo(null)}>{doc.root()?.text}</button><For each={breadcrumbs()}>{id => <><Icon name="right" /><button type="button" onClick={() => zoomTo(id)}>{doc.block(id)?.text || 'Empty block'}</button></>}</For></nav></Show>
      <div class="outline-title-row">
      <Show when={renaming()} fallback={<h1><button class="outline-title" type="button" disabled={doc.root()?.kind !== 'page'} onClick={rename}>{doc.root()?.text || 'Loading…'}</button></h1>}>
        <input ref={titleInput} class="title-input" aria-label="Page title" value={title()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commitTitle(); } if (event.key === 'Escape') { setRenaming(false); setMessage(''); } }} />
        <button type="button" onClick={commitTitle}>Save title</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
      </Show>
      <Show when={doc.root()?.kind === 'page'}><div class="outline-header-actions"><Button icon="table" label="Table" shortcut="⌘⇧T" onClick={event => openTable(event.metaKey)}>Table<Show when={!type.error && (type()?.members ?? 0) > 0}><span class="table-member-count">{type()?.members}</span></Show></Button></div></Show>
      </div>
      <Show when={showArchived()}><p class="archive-notice">Showing archived blocks <button type="button" class="text-button" onClick={() => { setShowArchived(false); scheduleReport(); }}>Hide archived</button></p></Show>
      <Show when={message()}><p class="outline-message" role="alert">{message()} <button class="text-button" type="button" onClick={() => setMessage('')}>Dismiss</button></p></Show>
      <Show when={doc.status() === 'error' || doc.status() === 'missing'}><p role="alert">{doc.statusMessage()}</p></Show>
    </div>
    <div ref={list} class="outline-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      <For each={[...virtualItems().keys()].filter(id => id !== editing())}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</Show>
    </div>
    <Show when={doc.status() === 'ready' && ids().length === 0}><button type="button" class="add-first-block" onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}><Icon name="plus" />Add a block</button></Show>
    <Show when={doc.status() === 'ready'}><div class="related-sections">
      <Related title="Backlinks" rows={related.error ? [] : related()?.backlinks ?? []} empty="No blocks link to this page." />
      <Related title="Tagged blocks" rows={related.error ? [] : related()?.tagged ?? []} empty="No blocks are tagged with this page." />
    </div></Show>
    <Show when={menu()}>{state => <Menu anchor={state().anchor} label={state().label} items={state().items} onDismiss={() => setMenu(null)} />}</Show>
    <Show when={completion()}><Popup anchor={completionAnchor} label="Reference completion" role="listbox" onDismiss={() => setCompletion(null)} autofocus={false}>
      <div ref={completionList} class="reference-completion" onMouseDown={event => event.preventDefault()}>
        <Show when={matches.loading}><p>Searching…</p></Show>
        <Show when={matches.error}><p role="alert">Couldn't load completion.</p></Show>
        <For each={completionRows()}>{(row, index) => <button type="button" role="option" aria-selected={completionIndex() === index()} classList={{ 'completion-selected': completionIndex() === index() }} onClick={() => void chooseCompletion(index())}>
          <Show when={row.kind === 'block' ? row.block : null}>{block => <><span class="completion-context"><BlockBreadcrumb block={block()} notebook={props.notebook} /></span>{block().text || 'Empty block'}</>}</Show>
          <Show when={row.kind === 'field' ? row.field : null}>{field => <>{field().name}<span class="completion-field-suffix">Field</span></>}</Show>
        </button>}</For>
        <Show when={canCreate()}><button type="button" role="option" aria-selected={completionIndex() === 0} onClick={() => void chooseCompletion()}><Icon name="plus" />Create page “{completion()?.query}”</button></Show>
        <Show when={!matches.loading && !matches.error && !canCreate() && !completionRows().length}><p>No matching blocks.</p></Show>
      </div>
    </Popup></Show>
  </div>;
}
