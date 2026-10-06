import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, onCleanup, onMount, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { EditorView } from '@codemirror/view';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { Block, FieldDefinition, TaskStatus, WorkSession } from '../api/types';
import { api } from '../api/client';
import type { BlockState, Caret, Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import type { Command, OutlinePaneProps, ViewState } from '../shell/contract';
import { fieldEntryId } from '../table/query';
import { ProjectControls } from '../projects/ProjectControls';
import { parseCardText } from '../review/card-text';
import { DatePicker } from '../tasks/DatePicker';
import { dateSuggestions, dateTokenAt, newTask, planDateToken, removeToken } from '../tasks/quick-date';
import type { DateSuggestion, DateToken } from '../tasks/quick-date';
import { JournalAgenda } from '../tasks/JournalAgenda';
import { RepeatPopup, TaskControls, TaskStatusButton, priorities, priorityLabel, statusIcons, statusLabels, statuses } from '../tasks/TaskControls';
import { WorkSessions } from '../tasks/WorkSessions';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { IconName } from '../ui/Icon';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText, offsetAtPoint } from './BlockText';
import { textTokens } from '../document/text-tokens';
import { boundaryDeletion } from '../document/outline-mechanics';
import { PaneEditor } from './editor';
import { createOutlineCapabilities } from './capabilities';
import type { CapabilityPopup } from './capabilities';
import { initialRow, inlineFieldValue, orderedRange, selectedText, selectionIds, selectionRoots, visibleIds } from './visibility';
import { completeReferences } from './completion';
import { nextClozeNumber, rankSlash, slashTokenAt } from './slash';
import type { SlashEntry, SlashToken } from './slash';
import { TypePill } from './references';
import { CitationChip, SourceHeader } from './SourceHeader';
import { CardSummary } from './CardSummary';
import { createFieldEntryConversion, createSourceFieldResets } from './source-fields';
import './outline.css';

interface Completion { from: number; to: number; query: string; manual?: { blockId: string; anchor: HTMLElement } }
interface MenuState { anchor: HTMLElement; items: MenuItem[]; label: string }
/** A slash-menu row: a block verb (`run`) or syntax that replaces the token (`insert`), or both. */
interface SlashItem extends SlashEntry {
  section: string;
  icon: IconName;
  keys?: string;
  when?(block: BlockState | undefined): boolean;
  insert?(text: string): { text: string; caret: number };
  run?(id: string): void;
}
interface RowRange { anchor: string; head: string }
interface WorkHistory { sessions: WorkSession[]; active: WorkSession | null; source: Block | null }
type CompletionRow = { kind: 'block'; block: Block } | { kind: 'field'; field: FieldDefinition };
const storedFolds = new Map<string, Set<string>>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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
  const [dateCompletion, setDateCompletion] = createSignal<(DateToken & { id: string }) | null>(null);
  const [dateIndex, setDateIndex] = createSignal(0);
  const [slashCompletion, setSlashCompletion] = createSignal<(SlashToken & { id: string }) | null>(null);
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [conflicts, setConflicts] = createSignal(new Set<string>());
  const [editedConflicts, setEditedConflicts] = createSignal(new Set<string>());
  const [margin, setMargin] = createSignal(0);
  let scroll!: HTMLDivElement;
  let list!: HTMLDivElement;
  let heading!: HTMLDivElement;
  let titleInput: HTMLInputElement | undefined;
  let completionList: HTMLDivElement | undefined;
  let slashList: HTMLDivElement | undefined;
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
  const [createdFields, setCreatedFields] = createSignal<FieldDefinition[]>([]);
  const [fields] = createResource(() => props.notebook.changeSequence(), () => api.fields());
  const definitions = createMemo(() => {
    const result = new Map<string, FieldDefinition>((fields.error ? [] : fields()?.fields ?? []).map(field => [field.id, field]));
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
  const sourceResets = createSourceFieldResets({ doc, notebook: props.notebook, definitions: definitionsById, caret, onError: setMessage });

  const contextDate = () => doc.root()?.kind === 'journal' ? doc.root()!.text : props.notebook.todayDate();
  const rowAnchor = (id: string) => id === props.pageId ? heading ?? null : hosts.get(id)?.closest<HTMLElement>('[data-block-id]') ?? null;
  const capabilities = createOutlineCapabilities({ doc, notebook: props.notebook, contextDate, caret, anchor: rowAnchor, onOpen: props.onOpen });
  /** `@` offers dates; choosing one makes the block a task scheduled (or, after `@due`, due) that day and removes the token. */
  const dateRows = createMemo<DateSuggestion[]>(() => { const state = dateCompletion(); return state ? dateSuggestions(state.query, contextDate()) : []; });
  /** `@d…` hints at the deadline form before it is typed out. */
  const offerDeadline = createMemo(() => { const state = dateCompletion(); return !!state && state.field === 'scheduled' && 'due'.startsWith(state.query.toLowerCase()); });
  createEffect(() => { if (dateCompletion() && editing() !== dateCompletion()!.id) setDateCompletion(null); });
  createEffect(() => { if (slashCompletion() && editing() !== slashCompletion()!.id) setSlashCompletion(null); });
  let dismissedDate: { id: string; from: number } | null = null;
  let dismissedSlash: { id: string; from: number } | null = null;
  /** One trigger at a time: a slash command being typed wins over an `@` before it. */
  function updateTriggers(text: string, at: Caret) {
    const idle = textRange() || composition();
    if (dismissedSlash && (dismissedSlash.id !== at.id || text[dismissedSlash.from] !== '/')) dismissedSlash = null;
    const slash = idle ? null : slashTokenAt(text, at.offset);
    if (slash && dismissedSlash?.from !== slash.from) {
      if (slashCompletion()?.query !== slash.query) setSlashIndex(0);
      setSlashCompletion({ ...slash, id: at.id });
      setDateCompletion(null);
      return;
    }
    setSlashCompletion(null);
    if (dismissedDate && (dismissedDate.id !== at.id || text[dismissedDate.from] !== '@')) dismissedDate = null;
    const token = idle ? null : dateTokenAt(text, at.offset);
    if (!token || dismissedDate?.from === token.from) { setDateCompletion(null); return; }
    if (dateCompletion()?.query !== token.query || dateCompletion()?.field !== token.field) setDateIndex(0);
    setDateCompletion({ ...token, id: at.id });
  }
  function dismissDate() {
    const state = dateCompletion();
    if (state) dismissedDate = { id: state.id, from: state.from };
    setDateCompletion(null);
  }
  /** Replaces the live token in the editor with `next`, keeping the document and caret in step. */
  function rewriteEditing(id: string, next: { text: string; caret: number }): boolean {
    if (!editor || editor.id !== id) return false;
    const result = doc.edit({ kind: 'text', id, text: next.text }, caret());
    if (!result.ok) { capabilities.failure(id, result.reason); return false; }
    editor.sync(next.text);
    editor.view.dispatch({ selection: { anchor: next.caret } });
    setCaret({ id, offset: next.caret });
    return true;
  }
  function chooseDate(index = dateIndex()) {
    const state = dateCompletion();
    const id = editing();
    if (!state || !editor || id !== state.id || editor.id !== id) return;
    const text = editor.view.state.doc.toString();
    if (offerDeadline() && index === dateRows().length) {
      const typed = '@due ';
      if (rewriteEditing(id, { text: text.slice(0, state.from) + typed + text.slice(state.to), caret: state.from + typed.length })) updateTriggers(editor.view.state.doc.toString(), { id, offset: state.from + typed.length });
      return;
    }
    const choice = dateRows()[index] ?? null;
    const plan = planDateToken(text, state, choice, doc.block(id)?.task ?? null);
    setDateCompletion(null);
    const result = doc.edit({ kind: 'planTask', id, text: plan.text, value: plan.value }, caret());
    if (!result.ok) { capabilities.failure(id, result.reason); return; }
    editor.sync(plan.text);
    editor.view.dispatch({ selection: { anchor: plan.caret } });
    setCaret({ id, offset: plan.caret });
    void doc.flush().catch(reason => capabilities.failure(id, reason));
    if (!choice) capabilities.open(id, state.field === 'deadline' ? 'deadline' : 'schedule');
    scheduleReport();
  }
  function dateKey(event: KeyboardEvent) {
    if (!dateCompletion()) return false;
    const count = dateRows().length + (offerDeadline() ? 2 : 1);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setDateIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { chooseDate(); return true; }
    if (event.key === 'Escape') { dismissDate(); return true; }
    return false;
  }
  const slashRows = createMemo<SlashItem[]>(() => {
    const state = slashCompletion();
    if (!state) return [];
    const block = doc.block(state.id);
    return rankSlash(slashItems().filter(item => !item.when || item.when(block)), state.query);
  });
  function dismissSlash() {
    const state = slashCompletion();
    if (state) dismissedSlash = { id: state.id, from: state.from };
    setSlashCompletion(null);
  }
  /** Removes `/query` (or swaps it for the item's syntax), then runs the item on the block. */
  function chooseSlash(index = slashIndex()) {
    const state = slashCompletion();
    const id = editing();
    const item = slashRows()[index];
    if (!state || !item || !editor || id !== state.id || editor.id !== id) return;
    const text = editor.view.state.doc.toString();
    const insertion = item.insert?.(text);
    const next = insertion
      ? { text: text.slice(0, state.from) + insertion.text + text.slice(state.to), caret: state.from + insertion.caret }
      : removeToken(text, state);
    setSlashCompletion(null);
    if (!rewriteEditing(id, next)) return;
    if (insertion) { updateCompletion(next.text, { id, offset: next.caret }); updateTriggers(next.text, { id, offset: next.caret }); }
    void doc.flush().catch(reason => capabilities.failure(id, reason));
    item.run?.(id);
    scheduleReport();
  }
  createEffect(() => { slashIndex(); slashRows(); requestAnimationFrame(() => slashList?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })); });
  function slashKey(event: KeyboardEvent) {
    if (!slashCompletion()) return false;
    const count = slashRows().length;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) { setSlashIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab') && count && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { chooseSlash(); return true; }
    if (event.key === 'Escape') { dismissSlash(); return true; }
    return false;
  }
  /** Typing `[] ` or `[ ] ` at the start of a plain block makes it a task. */
  function taskPrefix(text: string, at: Caret): boolean {
    const prefix = /^\[ ?\] /.exec(text)?.[0];
    if (!prefix || at.offset !== prefix.length || composition() || doc.block(at.id)?.task) return false;
    const rest = text.slice(prefix.length);
    const result = doc.edit({ kind: 'planTask', id: at.id, text: rest, value: newTask() }, caret());
    if (!result.ok) { setMessage(result.reason); return true; }
    queueMicrotask(() => { if (editor?.id !== at.id) return; editor.sync(rest); editor.view.dispatch({ selection: { anchor: 0 } }); });
    setCaret({ id: at.id, offset: 0 });
    void doc.flush().catch(reason => capabilities.failure(at.id, reason));
    return true;
  }

  const commitFieldEntry = createFieldEntryConversion({
    doc, notebook: props.notebook, disposed: () => disposed, composing: composition, caret, focusEpoch: () => focusEpoch,
    onStart: () => setCompletion(null),
    onField: field => setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]),
    onCommitted: (id, next, epoch, focus) => {
      setMessage('');
      setFolds(previous => { const next = new Set(previous); next.delete(id); return next; });
      if (next && focusEpoch === epoch) {
        setSelected(next.id);
        setCaret(next);
        setRowRange(null);
        setTextRange(null);
        setEditing(next.id);
        if (focus && props.active) queueMicrotask(() => editAt(next.id, next.offset, true, true, false));
      }
      scheduleReport();
    },
    onError: setMessage,
  });

  const unfoldedIds = createMemo(() => visibleIds(doc, zoom(), folds(), showArchived()));
  // Per-row memos keep ordinary typing from rebuilding the page's visible list.
  const fieldCandidates = mapArray(unfoldedIds, id => ({ id, value: createMemo(() => inlineFieldValue(doc, id, definitionsById())) }));
  const inlineFields = createMemo(() => {
    const visible = new Set(unfoldedIds());
    const retained = new Set([editing(), selected(), rowRange()?.anchor, rowRange()?.head, textRange()?.anchor.id, textRange()?.head.id]);
    const result = new Set<string>();
    for (const candidate of fieldCandidates()) {
      const value = candidate.value();
      if (value && visible.has(value) && !retained.has(candidate.id)) result.add(candidate.id);
    }
    return result;
  });
  const ids = createMemo(() => visibleIds(doc, zoom(), folds(), showArchived(), inlineFields()));
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
      const pinned = [editing(), capabilities.popup()?.id].flatMap(id => id ? indices().get(id) ?? [] : []);
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const result = defaultRangeExtractor(range);
        for (const index of pinned) if (!result.includes(index)) result.push(index);
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
    if (caret()?.id !== id) setCaret({ id, offset: 0 });
    props.onVimMode(props.vim ? 'outline' : null);
    scroll.focus({ preventScroll: true });
    virtualizer.scrollToIndex(indices().get(id) ?? 0, { align: 'auto' });
    scheduleReport();
  }
  function apply(intent: Edit, keepEditing = editing() !== null) {
    if (disposed || composition()) return;
    const rearrange = intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move';
    if (intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move') intent = { ...intent, zoomRoot: zoom() };
    const before = intent.kind === 'delete' ? ids() : [];
    const firstSelected = selectedIds()[0];
    const previousSelected = selected();
    const epoch = focusEpoch;
    let result: EditResult | undefined;
    measure('structural', () => anchored(() => { result = doc.edit(intent, caret()); }));
    if (!result || !result.ok) { setMessage(result && !result.ok ? result.reason : 'The edit could not be applied.'); return; }
    setMessage('');
    setTextRange(null);
    if (!rearrange) setRowRange(null);
    const next = result.caret;
    if (next) queueMicrotask(() => {
      if (disposed || !props.active || focusEpoch !== epoch) return;
      if (keepEditing) editAt(next.id, next.offset, true, true, false);
      else if (rearrange) scroll.focus({ preventScroll: true });
      else rowFocus(next.id);
    });
    else if (previousSelected && !doc.block(previousSelected)) {
      const remaining = new Set(ids());
      const at = before.indexOf(firstSelected ?? '');
      let neighbor: string | undefined;
      for (let index = at - 1; index >= 0 && !neighbor; index--) if (remaining.has(before[index]!)) neighbor = before[index];
      for (let index = at + 1; index < before.length && !neighbor; index++) if (remaining.has(before[index]!)) neighbor = before[index];
      neighbor ??= ids()[0];
      setEditing(null);
      if (neighbor) rowFocus(neighbor);
      else { setSelected(null); setCaret(null); }
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
  function replaceSelection(text: string, mode: 'text' | 'paste' | 'split', range = activeRange(), selectionBefore?: TextRange) {
    if (!range) return;
    const visible = selectionIds(ids(), range);
    apply({ kind: 'replaceRange', range, selectionBefore, between: visible.slice(1, -1), text, mode, zoomRoot: zoom() }, true);
  }
  function deleteTextRange() { if (textRange()) replaceSelection('', 'text'); }
  function fold(id = selected()) {
    if (!id || composition()) return;
    const active = editing() ?? selected();
    if (!folds().has(id) && active && active !== id) {
      const at = doc.outline.indexOf(id);
      const child = doc.outline.indexOf(active);
      if (child > at && child < doc.outline.subtreeEnd(at)) rowFocus(id);
    }
    anchored(() => setFolds(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }));
    report();
    scheduleReport();
  }
  function zoomTo(id: string | null) {
    if (composition()) return;
    if (editing() && commitFieldEntry(editing()!)) return;
    const previous = zoom();
    setZoom(id);
    setRowRange(null);
    setTextRange(null);
    setEditing(null);
    setSelected(null);
    setCaret(null);
    scroll.scrollTop = 0;
    const target = previous && indices().has(previous) ? previous : ids()[0];
    if (target) rowFocus(target);
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
  function backspace(view: EditorView, forward = false) {
    if (textRange()) { deleteTextRange(); return true; }
    const id = editing();
    if (!id) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) { replaceSelection('', 'text'); return true; }
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
      if (editor?.id !== id) return;
      let target = offset;
      if (vertical) {
        const edge = editor.view.coordsAtPos(offset);
        if (edge) {
          const line = editor.view.moveToLineBoundary(editor.view.state.selection.main, false, true);
          const start = editor.view.coordsAtPos(line.head);
          if (start) target = editor.view.posAtCoords({ x: start.left + column, y: (edge.top + edge.bottom) / 2 }) ?? offset;
        }
      }
      if (vertical || event.shiftKey) editor.view.dispatch({ selection: { anchor: event.shiftKey ? anchor.id === id ? anchor.offset : direction > 0 ? 0 : editor.view.state.doc.length : target, head: target } });
      if (event.shiftKey) setTextRange({ anchor, head: { id, offset: target } });
    });
    return true;
  }
  function popupKey(event: KeyboardEvent) {
    if (!completion()) return false;
    const count = completionRows().length + (canCreate() ? 1 : 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setCompletionIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (event.key === 'Enter') { void chooseCompletion(); return true; }
    if (event.key === 'Escape') { dismissCompletion(); return true; }
    return false;
  }
  function editorKey(event: KeyboardEvent, view: EditorView) {
    if (slashKey(event) || dateKey(event) || popupKey(event)) return true;
    if (commonKey(event)) return true;
    if (event.key === 'Escape' && (!props.vim || editor?.mode() === 'normal')) { if (editing()) rowFocus(editing()!); return true; }
    if (props.vim && editor?.mode() !== 'insert') {
      if (event.key === ' ' && editor?.mode() === 'normal' && editing() && !event.metaKey && !event.ctrlKey && !event.altKey) { leaderMenu(editing()!); return true; }
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
    if (event.metaKey && event.code === 'Period') { event.shiftKey ? zoomOut() : selected() && zoomTo(selected()); return true; }
    const id = editing() ?? selected();
    if (id && !rowRange() && !textRange() && event.metaKey && event.shiftKey && event.key === 'Enter' && !event.altKey && !event.ctrlKey) {
      if (!event.repeat) statusMenu(id);
      return true;
    }
    if (id && !rowRange() && !textRange() && (event.altKey || event.metaKey) && event.key === 'Enter' && !(event.altKey && event.metaKey) && !event.ctrlKey && !event.shiftKey) {
      if (!event.repeat) capabilities.invoke(capabilities.toggle(id));
      return true;
    }
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { apply({ kind: 'move', ids: roots(), direction: event.key === 'ArrowUp' ? 'up' : 'down' }); return true; }
    return false;
  }
  function clearSelection() {
    focusEpoch++;
    focusRequest = null;
    setEditing(null);
    setSelected(null);
    setCaret(null);
    setRowRange(null);
    setTextRange(null);
    rowKey = '';
    scheduleReport();
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

  /** Escape closes the completion; it stays closed while the same `[[` query is under the caret, and reopens once the text changes. */
  let dismissedCompletion: { id: string; from: number; query: string } | null = null;
  function dismissCompletion() {
    const state = completion();
    if (state && !state.manual && editor) dismissedCompletion = { id: editor.id, from: state.from, query: state.query };
    setCompletion(null);
  }
  function updateCompletion(text: string, at: Caret) {
    if (completion()?.manual) return;
    const prefix = text.slice(0, at.offset);
    const from = prefix.lastIndexOf('[[');
    if (from < 0 || prefix.slice(from + 2).includes(']') || prefix[from - 1] === '#' || prefix.slice(from + 2).includes('\n')) { setCompletion(null); return; }
    const next = { from, to: at.offset, query: prefix.slice(from + 2) };
    if (dismissedCompletion && dismissedCompletion.id === at.id && dismissedCompletion.from === from && dismissedCompletion.query === next.query) return;
    dismissedCompletion = null;
    if (completion()?.query !== next.query) setCompletionIndex(0);
    setCompletion(next);
  }
  const [matches] = createResource(() => {
    const state = completion();
    return state ? { query: state.query, manual: !!state.manual } : false;
  }, async state => state.manual
    ? completeReferences(props.notebook, state.query, [])
    : { rows: await api.complete(state.query), canCreate: false });
  const completionRows = createMemo<CompletionRow[]>(() => {
    const query = completion()?.query.toLowerCase() ?? '';
    if (completion()?.manual) return (matches.error ? [] : matches()?.rows ?? []).filter(block => block.kind === 'page').map(block => ({ kind: 'block', block }));
    const matchingFields = definitions().filter(field => field.name.toLowerCase().includes(query));
    const byId = new Map(matchingFields.map(field => [field.id, field]));
    const rows: CompletionRow[] = (matches.error ? [] : matches()?.rows ?? []).map(block => {
      const field = byId.get(block.id);
      byId.delete(block.id);
      return field ? { kind: 'field', field } : { kind: 'block', block };
    });
    for (const field of byId.values()) rows.push({ kind: 'field', field });
    return rows;
  });
  const canCreate = createMemo(() => !!completion()?.query.trim() && !matches.loading && !matches.error
    && (completion()?.manual ? !!matches()?.canCreate : !fields.loading && !fields.error && completionRows().length === 0));
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
    const source = editing();
    if (!state || !editor || !source) return;
    const selectionBefore = activeRange() ?? undefined;
    setCompletion(null);
    replaceSelection(`[[${id}]]`, 'text', { anchor: { id: source, offset: state.from }, head: { id: source, offset: state.to } }, selectionBefore);
  }
  async function chooseCompletion(index = completionIndex()) {
    const row = completionRows()[index];
    const state = completion();
    if (state?.manual) {
      if (matches.loading || matches.error) return;
      const title = row?.kind === 'block' ? row.block.text : canCreate() ? state.query.trim() : null;
      if (title) {
        const result = doc.addType(state.manual.blockId, title);
        if (!result.ok) setMessage(result.reason);
        setCompletion(null);
      }
      return;
    }
    if (row?.kind === 'field') { insertReference(row.field.id); return; }
    if (matches.loading || matches.error) return;
    if (row) { insertReference(row.block.id); return; }
    if (canCreate()) {
      try { const id = await props.notebook.createPage(completion()!.query.trim()); insertReference(id); }
      catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }
  }
  function caretRect(offset: number): DOMRect | null {
    const rect = editor?.view.coordsAtPos(offset);
    return rect ? new DOMRect(rect.left, rect.top, Math.max(1, rect.right - rect.left), rect.bottom - rect.top) : null;
  }
  function completionAnchor(): DOMRect | null {
    const manual = completion()?.manual;
    if (manual) return manual.anchor.getBoundingClientRect();
    return editor ? caretRect(editor.view.state.selection.main.head) : null;
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
    { id: 'task-root', title: 'Task', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.task) capabilities.invoke(capabilities.status(props.pageId, 'todo'));
      capabilities.open(props.pageId, 'task');
    } },
    { id: 'project-root', title: 'Project', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.project) capabilities.invoke(capabilities.edit(props.pageId, { kind: 'project', id: props.pageId, value: { status: 'active', outcome: '', deadline: null } }));
      capabilities.open(props.pageId, 'project');
    } },
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
    { id: 'zoom', title: 'Zoom into block', section: 'Navigation', keys: ['⌘.', 'Space z'], run: () => selected() && zoomTo(selected()) },
    { id: 'zoom-out', title: 'Zoom out', section: 'Navigation', keys: ['⌘⇧.'], disabledReason: () => zoom() ? undefined : 'Already at the page root.', run: zoomOut },
    { id: 'open-beside', title: 'Open selected target beside', section: 'Navigation', keys: ['⌃⇧O'], run: () => openSelected(true) },
    { id: 'copy-reference', title: 'Copy block reference', section: 'Editing', run: () => selected() && copy(`[[${selected()}]]`) },
    { id: 'make-task', title: 'Make task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? 'Already a task.' : undefined, run: () => selected() && capabilities.invoke(capabilities.status(selected()!, 'todo')) },
    { id: 'remove-task', title: 'Remove task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.invoke(capabilities.status(selected()!, null)) },
    { id: 'toggle-task', title: 'Toggle task', section: 'Outline', keys: ['⌘Enter'], run: () => selected() && capabilities.invoke(capabilities.toggle(selected()!)) },
    { id: 'task-status', title: 'Set task status…', section: 'Outline', keys: ['⌘⇧Enter', 'Space t'], run: () => selected() && statusMenu(selected()!) },
    { id: 'plan-task', title: 'Plan task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.open(selected()!, 'task') },
    { id: 'schedule-task', title: 'Schedule task', section: 'Outline', keys: ['Space s', '@'], run: () => selected() && openPlanning(selected()!, 'schedule') },
    { id: 'deadline-task', title: 'Set deadline', section: 'Outline', keys: ['Space d', '@due'], run: () => selected() && openPlanning(selected()!, 'deadline') },
    { id: 'priority-task', title: 'Set priority', section: 'Outline', keys: ['Space p'], run: () => selected() && priorityMenu(selected()!) },
    { id: 'repeat-task', title: 'Repeat task', section: 'Outline', keys: ['Space r'], run: () => selected() && openPlanning(selected()!, 'repeat') },
    { id: 'clock', title: 'Clock in / out', section: 'Outline', keys: ['Space w'], run: () => selected() && capabilities.invoke(capabilities.clock(selected()!)) },
    { id: 'work-sessions', title: 'Work sessions', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.open(selected()!, 'work') },
    { id: 'add-card', title: 'Add card', section: 'Editing', keys: ['Space c', '>>'], run: () => selected() && addCard(selected()!) },
    { id: 'leader', title: 'Show leader keys', section: 'Editing', keys: ['Space'], run: () => selected() && leaderMenu(selected()!) },
    { id: 'make-project', title: 'Make project', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.project ? 'Already a project.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'project', id: selected()!, value: { status: 'active', outcome: '', deadline: null } })) },
    { id: 'project', title: 'Project', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.open(selected()!, 'project') },
    { id: 'project-actions', title: 'Show actions', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.showActions(selected()!) },
    { id: 'review-cards', title: 'Review cards', section: 'View', run: () => props.onOpen({ kind: 'review' }, false) },
    { id: 'card-source', title: 'Show card source', section: 'Navigation', run: () => selected() && capabilities.source(selected()!) },
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
  /** Sections: Block, Move, Select. Pure navigation stays in the command palette and the shortcut list. */
  function blockMenu(id: string, anchor: HTMLElement) {
    if (!selectedSet().has(id)) rowFocus(id);
    const item = (commandId: string, options: { icon?: IconName; section?: string; danger?: boolean } = {}): MenuItem => {
      const command = commandDefinitions.find(candidate => candidate.id === commandId)!;
      return { ...options, label: command.title, shortcut: command.keys?.[0], disabledReason: command.disabledReason?.(), action: command.run };
    };
    const entry = doc.block(id);
    setMenu({ anchor, label: 'Block actions', items: [
      ...sourceResets(id),
      ...(entry?.citations.length ? [{ label: 'Remove citation', action: () => apply({ kind: 'uncite', id, citationIds: entry.citations.map(citation => citation.id) }, false) }] : []),
      { label: 'Add type…', icon: 'tag', action: () => { setCompletionIndex(0); setCompletion({ from: 0, to: 0, query: '', manual: { blockId: id, anchor } }); } },
      item('zoom', { icon: 'bullet' }),
      item('open-beside', { icon: 'panes' }),
      item('copy-reference', { icon: 'copy' }),
      { label: doc.block(id)?.task ? 'Remove task' : 'Make task', section: 'Task', action: () => capabilities.invoke(capabilities.status(id, doc.block(id)?.task ? null : 'todo')) },
      item('toggle-task'),
      item('task-status'),
      ...(doc.block(id)?.task ? [
        { label: 'Plan task', action: () => capabilities.open(id, 'task', anchor) },
        { ...item('schedule-task'), action: () => capabilities.open(id, 'schedule', anchor) },
        { label: 'Work sessions', action: () => capabilities.open(id, 'work', anchor) },
      ] : []),
      ...(doc.block(id)?.project ? [
        { label: 'Project', section: 'Project', action: () => capabilities.open(id, 'project', anchor) },
        { label: 'Show actions', action: () => capabilities.showActions(id) },
      ] : [{ label: 'Make project', section: 'Project', action: () => capabilities.invoke(capabilities.edit(id, { kind: 'project', id, value: { status: 'active', outcome: '', deadline: null } })) }]),
      { label: 'Review cards', section: 'Cards', action: () => props.onOpen({ kind: 'review' }, false) },
      { label: 'Show card source', action: () => capabilities.source(id) },
      item('insert-below', { section: 'Move', icon: 'plus' }),
      item('indent', { icon: 'right' }),
      item('outdent', { icon: 'left' }),
      item('move-up', { icon: 'up' }),
      item('move-down', { icon: 'down' }),
      item('select', { section: 'Select', icon: 'select' }),
      item('select-all'),
      item('archive', { section: 'Block', icon: 'archive' }),
      item('delete', { icon: 'trash', danger: true }),
    ] });
  }
  /** Keyboard menus hand focus back to the row or editor that opened them before their action runs. */
  function keyboardMenu(id: string, label: string, items: MenuItem[]) {
    const anchor = rowAnchor(id);
    if (!anchor) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const refocus = () => { if (prior?.isConnected) prior.focus({ preventScroll: true }); };
    setMenu({ anchor, label, items: items.map(item => ({ ...item, action: () => { refocus(); item.action(); } })) });
  }
  function statusMenu(id: string) {
    const task = doc.block(id)?.task;
    keyboardMenu(id, 'Task status', [
      ...statuses.map((status): MenuItem => ({ label: statusLabels[status], icon: task?.status === status ? 'check' : undefined, action: () => capabilities.invoke(capabilities.status(id, status)) })),
      ...(task ? [{ label: 'Remove task', icon: 'close' as const, action: () => capabilities.invoke(capabilities.status(id, null)) }] : []),
    ]);
  }
  function priorityMenu(id: string) {
    const current = doc.block(id)?.task?.priority ?? null;
    keyboardMenu(id, 'Priority', priorities.map((priority): MenuItem => ({ label: priorityLabel(priority), icon: current === priority ? 'check' : undefined, action: () => {
      const task = doc.block(id)?.task ?? newTask();
      capabilities.invoke(capabilities.edit(id, { kind: 'task', id, value: { ...task, priority } }));
    } })));
  }
  function openPlanning(id: string, kind: 'schedule' | 'deadline' | 'repeat') {
    capabilities.ensureTask(id);
    capabilities.open(id, kind);
  }
  function openProject(id: string) {
    if (!doc.block(id)?.project) capabilities.invoke(capabilities.edit(id, { kind: 'project', id, value: { status: 'active', outcome: '', deadline: null } }));
    capabilities.open(id, 'project');
  }
  /** Appends ` >> ` and edits the back of the card. */
  function addCard(id: string) {
    const front = (doc.block(id)?.text ?? '').trimEnd();
    const text = `${front}${front ? ' ' : ''}>> `;
    if (editor?.id === id && editing() === id) { if (rewriteEditing(id, { text, caret: text.length })) editAt(id, text.length, true); return; }
    const result = doc.edit({ kind: 'text', id, text }, caret());
    if (!result.ok) { setMessage(result.reason); return; }
    editAt(id, text.length, true);
  }
  /** Space on a selected row (or in Vim normal mode): one more letter acts on the block. */
  function leaderMenu(id: string) {
    const leader = (key: string, label: string, run: () => void, section?: string): MenuItem => ({ key, shortcut: key, label, section, action: run });
    keyboardMenu(id, 'Leader keys', [
      leader('t', 'Status…', () => statusMenu(id), 'Task'),
      leader('s', 'Schedule…', () => openPlanning(id, 'schedule')),
      leader('d', 'Deadline…', () => openPlanning(id, 'deadline')),
      leader('p', 'Priority…', () => priorityMenu(id)),
      leader('r', 'Repeat…', () => openPlanning(id, 'repeat')),
      leader('w', doc.block(id)?.task ? 'Clock in / out' : 'Clock in', () => capabilities.invoke(capabilities.clock(id))),
      leader('c', 'Add card', () => addCard(id), 'Block'),
      leader('z', 'Zoom in', () => zoomTo(id)),
    ]);
  }
  /** The slash menu: block verbs from the command list plus syntax inserts; each row shows its faster key. */
  function slashItems(): SlashItem[] {
    const keys = (commandId: string) => commandDefinitions.find(command => command.id === commandId)?.keys?.[0];
    const status = (value: TaskStatus, aliases: string[]): SlashItem => ({ id: `status-${value}`, title: statusLabels[value], aliases, section: 'Task', icon: statusIcons[value], keys: value === 'todo' || value === 'done' ? keys('toggle-task') : undefined, run: id => capabilities.invoke(capabilities.status(id, value)) });
    return [
      status('todo', ['task', 'checkbox']),
      status('doing', ['start', 'in progress']),
      status('waiting', ['blocked', 'hold']),
      status('done', ['complete', 'finish']),
      status('cancelled', ['cancel']),
      { id: 'schedule', title: 'Schedule', aliases: ['date', 'scheduled', 'when'], section: 'Task', icon: 'calendar', keys: '@', run: id => openPlanning(id, 'schedule') },
      { id: 'deadline', title: 'Deadline', aliases: ['due'], section: 'Task', icon: 'warning', keys: '@due', run: id => openPlanning(id, 'deadline') },
      { id: 'priority', title: 'Priority', aliases: ['important', 'urgent'], section: 'Task', icon: 'up', keys: keys('priority-task'), run: priorityMenu },
      { id: 'repeat', title: 'Repeat', aliases: ['recur', 'recurring', 'every'], section: 'Task', icon: 'redo', keys: keys('repeat-task'), run: id => openPlanning(id, 'repeat') },
      { id: 'clock', title: 'Clock in / out', aliases: ['timer', 'start work', 'stop work'], section: 'Task', icon: 'saving', keys: keys('clock'), run: id => capabilities.invoke(capabilities.clock(id)) },
      { id: 'remove-task', title: 'Remove task', aliases: ['plain'], section: 'Task', icon: 'close', when: block => !!block?.task, run: id => capabilities.invoke(capabilities.status(id, null)) },
      { id: 'project', title: 'Project', aliases: ['outcome'], section: 'Project', icon: 'pin', run: openProject },
      ...([1, 2, 3] as const).map((level): SlashItem => ({ id: `heading-${level}`, title: `Heading ${level}`, aliases: [`h${level}`], section: 'Text', icon: 'edit', keys: '#'.repeat(level), run: id => apply({ kind: 'heading', id, level }) })),
      { id: 'heading-normal', title: 'Normal text', aliases: ['paragraph'], section: 'Text', icon: 'edit', when: block => !!block?.heading, run: id => apply({ kind: 'heading', id, level: null }) },
      { id: 'reference', title: 'Reference', aliases: ['link', 'page', 'mention'], section: 'Text', icon: 'link', keys: '[[', insert: () => ({ text: '[[', caret: 2 }) },
      { id: 'type', title: 'Type', aliases: ['tag', 'supertag'], section: 'Text', icon: 'tag', keys: '#', insert: () => ({ text: '#', caret: 1 }) },
      { id: 'card', title: 'Card', aliases: ['flashcard', 'question'], section: 'Cards', icon: 'right', keys: '>>', insert: () => ({ text: '>> ', caret: 3 }) },
      { id: 'reversible-card', title: 'Reversible card', aliases: ['both ways', 'flashcard'], section: 'Cards', icon: 'panes', keys: '<>', insert: () => ({ text: '<> ', caret: 3 }) },
      { id: 'cloze', title: 'Cloze', aliases: ['blank', 'fill in', 'flashcard'], section: 'Cards', icon: 'select', keys: '{{c1::}}', insert: text => { const cloze = `{{c${nextClozeNumber(text)}::}}`; return { text: cloze, caret: cloze.length - 2 }; } },
      { id: 'zoom', title: 'Zoom in', aliases: ['focus'], section: 'Block', icon: 'bullet', keys: '⌘.', run: id => zoomTo(id) },
      { id: 'copy-reference', title: 'Copy reference', aliases: ['link'], section: 'Block', icon: 'copy', run: id => copy(`[[${id}]]`) },
    ];
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
    const clearOutsideRows = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (scroll.contains(target) && !target.closest('[data-block-id], button, input, [role="menu"], [role="dialog"]')) clearSelection();
    };
    scroll.addEventListener('mousedown', clearOutsideRows);
    onCleanup(() => scroll.removeEventListener('mousedown', clearOutsideRows));
    scroll.addEventListener('paste', paste, true);
    scroll.addEventListener('beforeinput', beforeInput, true);
    onCleanup(() => { scroll.removeEventListener('copy', copy, true); scroll.removeEventListener('cut', cut, true); scroll.removeEventListener('paste', paste, true); scroll.removeEventListener('beforeinput', beforeInput, true); cancelAnimationFrame(compositionFrame); });
    editor = new PaneEditor({
      key: editorKey,
      label: id => props.notebook.lookup(id)()?.text,
      blur: () => { if (editor?.id && editing() === editor.id) commitFieldEntry(editor.id, false); },
      text: (text, at) => measure('typing', () => {
        if (compositionSelection) return;
        const heading = /^(#{1,3}) $/.exec(text);
        if (heading && !composition()) {
          const result = doc.edit({ kind: 'text', id: at.id, text: '', heading: heading[1]!.length as 1 | 2 | 3 }, caret());
          if (!result.ok) setMessage(result.reason);
          else { queueMicrotask(() => editor?.sync('')); setCaret({ id: at.id, offset: 0 }); }
        } else if (taskPrefix(text, at)) return;
        else { const result = doc.edit({ kind: 'text', id: at.id, text }, caret()); if (!result.ok) setMessage(result.reason); }
        updateCompletion(text, at);
        updateTriggers(text, at);
      }),
      selection: at => {
        if (compositionSelection || textRange() && textRange()!.head.id !== at.id) return;
        focusEpoch++;
        setCaret(at);
        setTextRange(previous => previous && previous.head.id === at.id ? { anchor: previous.anchor, head: at } : previous);
        if (editor) { const text = editor.view.state.doc.toString(); updateCompletion(text, at); updateTriggers(text, at); }
        scheduleReport();
      },
      composition: composing,
      mode: mode => { if (editing()) props.onVimMode(props.vim ? mode : null); },
    });
    editor.configure(props.vim);
    editor.configureFields(id => definitionsById().get(id)?.name);
    const observer = new ResizeObserver(() => { setMargin(list.offsetTop); });
    observer.observe(scroll.querySelector('.outline-heading')!);
    setMargin(list.offsetTop);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerEnd);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('mousemove', pointerMove); document.removeEventListener('mouseup', pointerEnd); });
  });
  createEffect(() => { const enabled = props.vim; if (editor) { editor.configure(enabled); props.onVimMode(enabled ? editing() ? editor.mode() : 'outline' : null); } });
  createEffect(() => { const definitions = definitionsById(); editor?.configureFields(id => definitions.get(id)?.name); });
  createEffect(() => {
    if (doc.status() !== 'ready' || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      const saved = initial.caret;
      if (doc.root()?.kind !== 'journal') {
        const id = saved && doc.block(saved.id) && indices().has(saved.id) ? saved.id : initialRow(ids(), id => doc.block(id));
        setEditing(null);
        setSelected(id);
        setCaret(id ? { id, offset: id === saved?.id ? saved.offset : 0 } : null);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
        if (initial.scroll) requestAnimationFrame(() => restoreAnchor(initial.scroll));
        return;
      }
      let first: Caret | null = saved && doc.block(saved.id) && indices().has(saved.id) ? saved : null;
      if (!saved) {
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
      } else if (!first) {
        // A page that opens on a field keeps it inline: select the value row instead of editing the reference.
        const id = ids()[0];
        if (id && inlineFields().has(doc.outline.parentOf(id))) setSelected(id);
        else first = id ? { id, offset: 0 } : null;
      }
      if (first) editAt(first.id, first.offset, !props.vim, !initial.scroll, false);
      if (initial.scroll) requestAnimationFrame(() => restoreAnchor(initial.scroll));
    }
  });
  createEffect(() => { const id = editing(); const text = id ? doc.block(id)?.text : undefined; if (text !== undefined && editor?.id === id) queueMicrotask(() => { if (editor?.id === id) editor.sync(text); }); });
  createEffect(() => {
    const id = editing();
    const text = id ? doc.block(id)?.text : undefined;
    if (text === undefined) return;
    for (const token of textTokens(text)) if (token.kind === 'reference') props.notebook.lookup(token.id!)();
    queueMicrotask(() => { if (!disposed && editor?.id === id) editor.refreshLabels(); });
  });
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

  function WorkPopup(propsWork: { state: CapabilityPopup }) {
    const state = propsWork.state;
    const load = async () => {
      await doc.flush();
      const [sessions, active] = await Promise.all([props.notebook.api.workSessions(state.id), props.notebook.api.activeWorkSession()]);
      const source = active ? await props.notebook.api.block(active.block_id) : null;
      return { sessions, active, source };
    };
    const [history, { refetch, mutate }] = createResource(() => props.notebook.changeSequence(), load);
    const [shown, setShown] = createSignal<WorkHistory>();
    createEffect(() => { if (!history.error) { const value = history(); if (value) setShown(value); } });
    const another = () => shown()?.active && shown()!.active!.block_id !== state.id;
    async function start() {
      const startedAt = Date.now();
      await capabilities.run(state.id, async () => {
        const current = await load();
        mutate(current);
        if (current.active) throw new Error(current.active.block_id === state.id ? 'Work is already running on this task.' : 'Work is already running on another task.');
        await capabilities.save({ kind: 'startWork', id: state.id, startedAt });
        await refetch();
      });
    }
    async function change(kind: 'stopWork' | 'workNote', sessionId: string, note: string) {
      const session = shown()?.sessions.find(session => session.id === sessionId) ?? (shown()?.active?.id === sessionId ? shown()?.active : null);
      if (!session || session.block_id !== state.id) throw new Error('The work session is no longer available.');
      await capabilities.edit(state.id, kind === 'stopWork'
        ? { kind, id: state.id, session, endedAt: Date.now(), note }
        : { kind, id: state.id, session, note });
      await refetch();
    }
    return <Popup anchor={state.anchor} label="Work sessions" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
      <Show when={history.loading}><p class="outline-capability-notice" role="status">Loading work sessions…</p></Show>
      <Show when={history.error}><p class="error" role="alert">{String(history.error)} <Button onClick={() => { void refetch(); }}>Retry</Button></p></Show>
      <Show when={another() && shown()?.source}>{source => <div class="outline-running-task">
        <span>Work is running on</span>
        <BlockText text={source().text} notebook={props.notebook} onOpen={props.onOpen} />
        <Button onClick={event => props.onOpen({ kind: 'page', pageId: source().page_id, blockId: source().id }, event.shiftKey)}>Open running task</Button>
      </div>}</Show>
      <Show when={shown()}>{value => <WorkSessions sessions={value().sessions} active={value().active?.block_id === state.id ? value().active : null}
        disabled={history.loading || !!history.error || capabilities.busy(state.id)}
        onStart={start} onStop={(id, note) => change('stopWork', id, note)} onEdit={(id, note) => change('workNote', id, note)} />}</Show>
      <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
    </Popup>;
  }

  function TaskSummary(propsTask: { id: string }) {
    return <Show when={doc.block(propsTask.id)?.task}>{task => <Button class="outline-planning" label="Plan task" disabled={capabilities.busy(propsTask.id)} aria-haspopup="dialog" onClick={event => capabilities.open(propsTask.id, 'task', event.currentTarget)}>
      <Show when={task().scheduled}><span aria-label={`Scheduled: ${task().scheduled}${task().scheduled_time ? ` ${task().scheduled_time}` : ''}`}>Scheduled {task().scheduled} {task().scheduled_time}</span></Show>
      <Show when={task().deadline}><span aria-label={`Deadline: ${task().deadline}${task().deadline_time ? ` ${task().deadline_time}` : ''}`}>Deadline {task().deadline} {task().deadline_time}</span></Show>
      <Show when={task().priority}><span>Priority: {task().priority}</span></Show>
      <Show when={task().repeater}>{repeat => <span aria-label={`Repeat: ${repeat().mode}, every ${repeat().every} ${repeat().unit}`}>Repeat {repeat().every} {repeat().unit}</span>}</Show>
      <Show when={!task().scheduled && !task().deadline && !task().priority && !task().repeater}>Plan task</Show>
    </Button>}</Show>;
  }

  function Row(propsRow: { id: string; item: Accessor<VirtualItem> }) {
    const id = () => propsRow.id;
    const block = () => doc.block(id());
    const children = () => doc.outline.children(id()).length > 0;
    const field = createMemo(() => definitionsById().get(fieldEntryId(block()?.text ?? '') ?? ''));
    const parent = () => doc.outline.parentOf(id());
    const valueField = createMemo(() => definitionsById().get(fieldEntryId(doc.block(parent())?.text ?? '') ?? ''));
    const inline = () => inlineFields().has(parent());
    const depth = () => (inline() ? doc.outline.depth(parent()) : doc.outline.depth(id())) - baseDepth();
    const pill = () => valueField()?.kind === 'choice' || valueField()?.kind === 'instance';
    const cardText = createMemo(() => block()?.text ?? '');
    const cards = createMemo(() => parseCardText(cardText()));
    let row!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(row));
    onCleanup(() => { const host = hosts.get(id()); if (host && row.contains(host)) hosts.delete(id()); });
    return <div ref={row} id={`outline-${props.pane}-${id()}`} data-index={propsRow.item().index} data-block-id={id()} role="treeitem" aria-level={depth() + 1}
      aria-expanded={children() ? !folds().has(id()) : undefined} aria-selected={selectedSet().has(id())}
      class="outline-row" classList={{ 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field(), 'inline-field-value': inline(), 'choice-value': pill() }}
      style={{ transform: `translateY(${propsRow.item().start - margin()}px)`, '--depth': depth() }}>
      <button type="button" class="row-menu icon-button" aria-label="Block actions" onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children() }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name={folds().has(id()) ? 'right' : 'down'} /></button>
      <Show when={!inline()}><button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()) }} aria-label="Zoom into block" onClick={() => zoomTo(id())}><Icon name="bullet" /></button></Show>
      <Show when={inline()}><button type="button" class="outline-field-label" title={valueField()?.name} onClick={() => { const entry = parent(); setSelected(entry); editAt(entry, 0, true); }}><Icon name="field" /><span>{valueField()?.name}</span></button></Show>
      <Show when={block()?.task}><TaskStatusButton task={block()?.task ?? null} disabled={capabilities.busy(id())} onChange={status => capabilities.status(id(), status)} /></Show>
      <div class="outline-body" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }} onMouseDown={event => pointerStart(event, id(), event.currentTarget)}>
        <div class="outline-source-line"><div class="outline-source">
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id()}><div class="static-text"><span classList={{ 'outline-value-pill': pill() }}><BlockText text={block()?.text ?? ''} cards field={field()} notebook={props.notebook} onOpen={props.onOpen} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /></span><Show when={!block()?.text && ids().length === 1}><span class="empty-block">Start writing</span></Show></div></Show>
        <For each={block()?.manual_types ?? []}>{title => <TypePill title={title} notebook={props.notebook} onOpen={props.onOpen} onRemove={() => { const result = doc.removeType(id(), title); if (!result.ok) setMessage(result.reason); }} />}</For>
        </div>
        <Show when={block()?.task || block()?.project || cards().cards.length || block()?.citations.length}><span class="outline-capability-metadata">
          <TaskSummary id={id()} />
          <Show when={block()?.project}><Button class="outline-planning" label="Project" aria-haspopup="dialog" onClick={event => capabilities.open(id(), 'project', event.currentTarget)}>Project</Button></Show>
          <Show when={cards().cards.length}><CardSummary blockId={id()} cards={cards().cards} notebook={props.notebook} onOpen={props.onOpen} /></Show>
          <For each={block()?.citations}>{citation => <CitationChip citation={citation} notebook={props.notebook} onOpen={props.onOpen} />}</For>
        </span></Show>
        </div>
        <For each={block()?.citations}>{citation => <Show when={block()?.text.trim() !== citation.quote.trim()}>
          <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
        </Show>}</For>
        <For each={cards().problems}>{problem => <p class="outline-card-problem" role="alert">{problem.message}</p>}</For>
        <Show when={capabilities.busy(id()) || (block()?.pending && (block()?.task || block()?.project))}><span class="outline-capability-notice" role="status">{doc.saveState() === 'offline' ? 'Waiting to save' : 'Saving…'}</span></Show>
        <Show when={capabilities.error(id())}><p class="outline-capability-error" role="alert">{capabilities.error(id())}</p></Show>
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

  function Related(propsRelated: { title: string; rows: { block: Block; page: Block }[] }) {
    return <details class="related-section" onToggle={event => setRelatedOpen(previous => {
      const next = new Set(previous);
      event.currentTarget.open ? next.add(propsRelated.title) : next.delete(propsRelated.title);
      return next;
    })}><summary>{propsRelated.title} <span>{related.error ? 'Unavailable' : related.loading && !related() ? 'Loading…' : propsRelated.rows.length}</span></summary>
      <Show when={!related.error} fallback={<p role="alert">Couldn't load related blocks.</p>}>
      <For each={propsRelated.rows}>{result => {
        const live = props.notebook.lookup(result.block.id);
        return <div class="related-block"><div class="related-open" role="link" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey); }} onClick={event => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey)}>
          <span class="related-breadcrumb"><BlockBreadcrumb block={result.block} notebook={props.notebook} /></span>
          <BlockText text={live()?.text ?? result.block.text} notebook={props.notebook} onOpen={props.onOpen} />
        </div><button type="button" class="text-button" onClick={() => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, true)}>Open beside</button></div>;
      }}</For>
      </Show>
    </details>;
  }

  return <div ref={scroll} class="outline-pane" data-pane={props.pane} tabIndex={0} role="tree" aria-label="Page outline" aria-owns={[...virtualItems().keys()].map(id => `outline-${props.pane}-${id}`).join(' ')} onFocusIn={props.onActivate} onFocusOut={report} onKeyDown={structuralKey} onWheel={() => { anchorEpoch++; cancelAnimationFrame(anchorFrame); }} onScroll={scheduleReport}>
    <div ref={heading} class="outline-heading">
      <Show when={zoom()}><nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs"><button type="button" onClick={() => zoomTo(null)}>{doc.root()?.text}</button><For each={breadcrumbs()}>{id => <><Icon name="right" /><button type="button" onClick={() => zoomTo(id)}>{doc.block(id)?.text || 'Empty block'}</button></>}</For></nav></Show>
      <div class="outline-title-row">
      <Show when={renaming()} fallback={<h1><button class="outline-title" type="button" disabled={doc.root()?.kind !== 'page'} onClick={rename}>{doc.root()?.text || 'Loading…'}</button></h1>}>
        <input ref={titleInput} class="title-input" aria-label="Page title" value={title()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commitTitle(); } if (event.key === 'Escape') { setRenaming(false); setMessage(''); } }} />
        <button type="button" onClick={commitTitle}>Save title</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
      </Show>
      <Show when={doc.root()?.kind === 'page'}><div class="outline-header-actions"><Button icon="table" label="Table" shortcut="⌘⇧T" onClick={event => openTable(event.metaKey)}>Table<Show when={!type.error && (type()?.members ?? 0) > 0}><span class="table-member-count">{type()?.members}</span></Show></Button></div></Show>
      </div>
      <Show when={doc.root()?.source}><SourceHeader doc={doc} notebook={props.notebook} definitions={definitionsById()} resetItems={sourceResets} onOpen={props.onOpen} onError={setMessage} /></Show>
      <Show when={doc.root()?.task || doc.root()?.project || doc.root()?.citations.length}><div class="outline-root-capabilities outline-capability-metadata">
        <Show when={doc.root()?.task}>
          <TaskStatusButton task={doc.root()?.task ?? null} disabled={capabilities.busy(props.pageId)} onChange={status => capabilities.status(props.pageId, status)} />
          <TaskSummary id={props.pageId} />
          <Button class="outline-planning" onClick={event => capabilities.open(props.pageId, 'work', event.currentTarget)}>Work sessions</Button>
        </Show>
        <Show when={doc.root()?.project}><Button class="outline-planning" onClick={event => capabilities.open(props.pageId, 'project', event.currentTarget)}>Project</Button></Show>
        <For each={doc.root()?.citations}>{citation => <CitationChip citation={citation} notebook={props.notebook} onOpen={props.onOpen} />}</For>
      </div></Show>
      <For each={doc.root()?.citations}>{citation => <Show when={doc.root()?.text.trim() !== citation.quote.trim()}>
        <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
      </Show>}</For>
      <Show when={capabilities.busy(props.pageId) || (doc.root()?.pending && (doc.root()?.task || doc.root()?.project))}><p class="outline-capability-notice" role="status">{doc.saveState() === 'offline' ? 'Waiting to save' : 'Saving…'}</p></Show>
      <Show when={capabilities.error(props.pageId)}><p class="outline-capability-error" role="alert">{capabilities.error(props.pageId)}</p></Show>
      <Show when={showArchived()}><p class="archive-notice">Showing archived blocks <button type="button" class="text-button" onClick={() => { setShowArchived(false); scheduleReport(); }}>Hide archived</button></p></Show>
      <Show when={message()}><p class="outline-message" role="alert">{message()} <button class="text-button" type="button" onClick={() => setMessage('')}>Dismiss</button></p></Show>
      <Show when={doc.status() === 'error' || doc.status() === 'missing'}><p role="alert">{doc.statusMessage()}</p></Show>
      <Show when={doc.root()?.kind === 'journal'}><JournalAgenda date={doc.root()!.text} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} /></Show>
    </div>
    <div ref={list} class="outline-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      <For each={[...virtualItems().keys()].filter(id => id !== editing())}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</Show>
    </div>
    <Show when={doc.status() === 'ready' && ids().length === 0}><button type="button" class="add-first-block" onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}><Icon name="plus" />Add a block</button></Show>
    <Show when={doc.status() === 'ready' && (related.error || (related()?.backlinks.length ?? 0) + (related()?.tagged.length ?? 0) > 0)}><div class="related-sections">
      <Show when={related.error || related()?.backlinks.length}><Related title="Backlinks" rows={related.error ? [] : related()?.backlinks ?? []} /></Show>
      <Show when={related.error || related()?.tagged.length}><Related title="Tagged blocks" rows={related.error ? [] : related()?.tagged ?? []} /></Show>
    </div></Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.label} items={state.items} onDismiss={() => setMenu(null)} />}</Show>
    <Show keyed when={capabilities.popup()}>{state => <>
      {state.kind === 'task' && <Popup anchor={state.anchor} label="Task" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
        <Show when={doc.block(state.id)?.task} fallback={<p class="outline-capability-notice">Task removed.</p>}>{task => <TaskControls task={task()} contextDate={contextDate()} disabled={capabilities.busy(state.id)} onChange={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value })} />}</Show>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
      {state.kind === 'schedule' && <Show when={doc.block(state.id)?.task}>{task => <DatePicker anchor={state.anchor} label="Schedule task" value={task().scheduled} time={task().scheduled_time} contextDate={contextDate()} marks={task().deadline ? { [task().deadline!]: 'Deadline' } : undefined} onDismiss={() => capabilities.dismiss(state)}
        onSelect={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), scheduled: value.date, scheduled_time: value.date ? value.time : null } })} />}</Show>}
      {state.kind === 'deadline' && <Show when={doc.block(state.id)?.task}>{task => <DatePicker anchor={state.anchor} label="Deadline" value={task().deadline} time={task().deadline_time} contextDate={contextDate()} marks={task().scheduled ? { [task().scheduled!]: 'Scheduled' } : undefined} onDismiss={() => capabilities.dismiss(state)}
        onSelect={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), deadline: value.date, deadline_time: value.date ? value.time : null, warning_days: value.date ? task().warning_days : null } })} />}</Show>}
      {state.kind === 'repeat' && <Show when={doc.block(state.id)?.task}>{task => <RepeatPopup anchor={state.anchor} value={task().repeater} disabled={capabilities.busy(state.id)} onDismiss={() => capabilities.dismiss(state)}
        onSave={repeater => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), repeater } })} />}</Show>}
      {state.kind === 'project' && <Popup anchor={state.anchor} label="Project" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
        <ProjectControls project={doc.block(state.id)?.project ?? null} contextDate={contextDate()} disabled={capabilities.busy(state.id)} onChange={value => capabilities.edit(state.id, { kind: 'project', id: state.id, value })} />
        <Show when={doc.block(state.id)?.project}><Button onClick={event => capabilities.showActions(state.id, event.shiftKey)}>Show actions</Button></Show>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
      {state.kind === 'work' && <WorkPopup state={state} />}
      {state.kind === 'complete' && <Popup anchor={state.anchor} label="Stop work and complete?" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
        <p>Stop work and complete?</p>
        <div class="outline-capability-actions"><Button class="bordered" disabled={capabilities.busy(state.id)} onClick={() => capabilities.invoke(capabilities.complete(state))}>Stop and complete</Button><Button onClick={() => capabilities.dismiss(state)}>Cancel</Button></div>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
    </>}</Show>
    <Show when={completion()}><Popup anchor={completionAnchor} width={480} class="picker" label={completion()?.manual ? 'Add type…' : 'Reference completion'} role={completion()?.manual ? 'dialog' : 'listbox'} onDismiss={dismissCompletion} autofocus={!!completion()?.manual}>
      <Show when={completion()?.manual}><div class="picker-query"><Icon name="tag" class="picker-prefix" /><input class="picker-input" aria-label="Type title" placeholder="Type title" value={completion()?.query ?? ''} onInput={event => { setCompletion(state => state ? { ...state, query: event.currentTarget.value } : null); setCompletionIndex(0); }} onKeyDown={event => { if (!event.isComposing && popupKey(event)) { event.preventDefault(); event.stopPropagation(); } }} /></div></Show>
      <div ref={completionList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <Show when={matches.loading}><p class="empty-state">Searching…</p></Show>
        <Show when={matches.error}><p class="error" role="alert">Couldn't load completion.</p></Show>
        <For each={completionRows()}>{(row, index) => <div role="option" aria-selected={completionIndex() === index()} class="picker-row" classList={{ selected: completionIndex() === index() }} onClick={() => void chooseCompletion(index())}>
          <Show when={row.kind === 'block' ? row.block : null}>{block => <><Icon name={block().kind === 'journal' ? 'calendar' : block().kind === 'page' ? 'page' : 'bullet'} /><span class="picker-text">{block().text || 'Empty block'}</span><Show when={block().kind === 'block'}><span class="picker-meta"><BlockBreadcrumb block={block()} notebook={props.notebook} /></span></Show></>}</Show>
          <Show when={row.kind === 'field' ? row.field : null}>{field => <><Icon name="field" /><span class="picker-text">{field().name}</span><span class="picker-meta">Field</span></>}</Show>
        </div>}</For>
        <Show when={canCreate()}><div role="option" aria-selected={completionIndex() === completionRows().length} class="picker-row" classList={{ selected: completionIndex() === completionRows().length }} onClick={() => void chooseCompletion(completionRows().length)}><Icon name="plus" /><span class="picker-text">Create page “{completion()?.query}”</span></div></Show>
        <Show when={!matches.loading && !matches.error && !canCreate() && !completionRows().length}><p class="empty-state">No matching blocks.</p></Show>
      </div>
    </Popup></Show>
    <Show when={dateCompletion()}><Popup anchor={() => caretRect(dateCompletion()?.from ?? 0)} width={320} class="picker" label={dateCompletion()?.field === 'deadline' ? 'Deadline' : 'Schedule task'} role="listbox" onDismiss={dismissDate}>
      <div class="picker-list" onMouseDown={event => event.preventDefault()}>
        <Show when={dateCompletion()?.field === 'deadline'}><div class="picker-section">Deadline</div></Show>
        <For each={dateRows()}>{(row, index) => <div role="option" aria-selected={dateIndex() === index()} class="picker-row" classList={{ selected: dateIndex() === index() }} onClick={() => chooseDate(index())}>
          <Icon name={dateCompletion()?.field === 'deadline' ? 'warning' : 'calendar'} /><span class="picker-text">{row.label}</span><span class="picker-meta">{row.date}</span>
        </div>}</For>
        <Show when={!dateRows().length && !offerDeadline()}><p class="empty-state">No matching date</p></Show>
        <Show when={offerDeadline()}><div role="option" aria-selected={dateIndex() === dateRows().length} class="picker-row" classList={{ selected: dateIndex() === dateRows().length }} onClick={() => chooseDate(dateRows().length)}>
          <Icon name="warning" /><span class="picker-text">Deadline…</span><span class="picker-meta"><kbd>@due</kbd></span>
        </div></Show>
        <div role="option" aria-selected={dateIndex() === dateRows().length + (offerDeadline() ? 1 : 0)} class="picker-row" classList={{ selected: dateIndex() === dateRows().length + (offerDeadline() ? 1 : 0) }} onClick={() => chooseDate(dateRows().length + (offerDeadline() ? 1 : 0))}>
          <Icon name="more" /><span class="picker-text">Pick a date…</span>
        </div>
      </div>
    </Popup></Show>
    <Show when={slashCompletion()}><Popup anchor={() => caretRect(slashCompletion()?.from ?? 0)} width={320} class="picker" label="Commands" role="listbox" onDismiss={dismissSlash}>
      <div ref={slashList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <For each={slashRows()}>{(row, index) => <>
          <Show when={index() === 0 || slashRows()[index() - 1]!.section !== row.section}><div class="picker-section">{row.section}</div></Show>
          <div role="option" aria-selected={slashIndex() === index()} class="picker-row" classList={{ selected: slashIndex() === index() }} onClick={() => chooseSlash(index())}>
            <Icon name={row.icon} /><span class="picker-text">{row.title}</span><Show when={row.keys}><span class="picker-meta"><kbd>{row.keys}</kbd></span></Show>
          </div>
        </>}</For>
        <Show when={!slashRows().length}><p class="empty-state">No matching command. Escape keeps the text.</p></Show>
      </div>
    </Popup></Show>
  </div>;
}
