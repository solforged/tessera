import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, onCleanup, onMount, untrack } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { FieldDefinition } from '../api/types';
import { api } from '../api/client';
import type { Caret, Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import { depthStops } from '../shell/contract';
import type { Depth, OutlinePaneProps, ViewState } from '../shell/contract';
import { fieldEntryId } from '../table/query';
import { setLinkedCitation } from '../library/highlights';
import { pageSigla } from '../library/sigla';
import { sourceReadingOrder } from '../library/source-order';
import type { OutlineIndex } from '../document/outline-index';
import { JournalAgenda } from '../tasks/JournalAgenda';
import { JournalResurface } from '../tasks/JournalResurface';
import { TaskStatusButton } from '../tasks/TaskControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { BlockText, isStableReference, plainText } from './BlockText';
import { textTokens } from '../document/text-tokens';
import { PaneEditor } from './editor';
import { createOutlineCapabilities } from './capabilities';
import { inlineFieldValue, selectionIds, selectionRoots, visibleIds } from './visibility';
import type { DepthFilter } from './visibility';
import { CitationChip, SourceHeader } from './SourceHeader';
import { GLOSS_FIELD, glossEntry, isGistName, isGlossName } from './gloss';
import { positionSource as sharedPositionSource } from './perspectives';
import { Apparatus } from './Apparatus';
import { createFieldEntryConversion, createSourceFieldResets } from './source-fields';
import { sourceFieldName } from './source';
import { createOutlineCompletions } from './completions';
import { createOutlineCommands } from './commands';
import { createOutlineKeyboard } from './keyboard';
import { createOutlineInteractions } from './interactions';
import { createOutlineRows } from './Row';
import { createOutlineRelated } from './Related';
import { createCapabilityPopups } from './CapabilityPopups';
import type { MenuState, OutlineContext, RowRange } from './context';
import './outline.css';

const storedFolds = new Map<string, Set<string>>();

export function OutlinePane(props: OutlinePaneProps) {
  return <Show keyed when={props.pageId}>{pageId => <Pane {...props} pageId={pageId} />}</Show>;
}

function Pane(props: OutlinePaneProps) {
  const doc: PageDocument = props.notebook.open(props.pageId);
  const initial = untrack(() => props.view);
  const [zoom, setZoom] = createSignal(initial.zoom);
  const [folds, setFolds] = createSignal(new Set(initial.folds ?? storedFolds.get(`${props.pane}:${props.pageId}`) ?? []));
  const [showArchived, setShowArchived] = createSignal(initial.showArchived);
  const [depth, setDepth] = createSignal<Depth>(initial.depth ?? 'full');
  const [caret, setCaret] = createSignal<Caret | null>(initial.caret);
  const [editing, setEditing] = createSignal<string | null>(initial.caret?.id ?? null);
  const [selected, setSelected] = createSignal<string | null>(initial.caret?.id ?? null);
  const [rowRange, setRowRange] = createSignal<RowRange | null>(null);
  const [textRange, setTextRange] = createSignal<TextRange | null>(null);
  const [composition, setComposition] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [conflicts, setConflicts] = createSignal(new Set<string>());
  const [editedConflicts, setEditedConflicts] = createSignal(new Set<string>());
  const [margin, setMargin] = createSignal(0);
  let scroll!: HTMLDivElement;
  let list!: HTMLDivElement;
  let heading!: HTMLDivElement;
  let titleInput: HTMLInputElement | undefined;
  const hosts = new Map<string, HTMLElement>();
  let editor: PaneEditor | undefined;
  let restoring = true;
  let disposed = false;
  let focusEpoch = 0;
  let focusRequest: { id: string; offset: number; insert: boolean; epoch: number } | null = null;
  let reportingFrame = 0;
  let scrollSettle = 0;
  let anchorFrame = 0;
  let anchorEpoch = 0;
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
  }, undefined, {
    // Fields refetch after every committed change; unchanged definitions must not reconfigure the editor or re-scan rows.
    equals: (a, b) => a.length === b.length && a.every((field, index) => { const other = b[index]!; return field.id === other.id && field.revision === other.revision && field.name === other.name && field.kind === other.kind && JSON.stringify(field.options) === JSON.stringify(other.options); }),
  });
  const definitionsById = createMemo(() => new Map(definitions().map(field => [field.id, field])));
  const definitionsByName = createMemo(() => new Map(definitions().map(field => [field.name.toLowerCase(), field])));
  const glossId = createMemo(() => doc.root()?.kind === 'page' ? glossEntry(doc, id => isGlossName(definitionsById().get(id)?.name)) : null);
  const depthFilter = createMemo<DepthFilter | undefined>(() => doc.root()?.kind === 'page' && depth() !== 'full'
    ? { stop: depth(), gloss: glossId(), position: id => !!doc.block(id)?.position, gist: id => isGistName(definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '')?.name) } : undefined);
  const [type] = createResource(
    () => doc.root()?.kind === 'page' ? [props.pageId, props.notebook.changeSequence()] as const : false,
    ([pageId]) => api.type(pageId),
  );
  const sourceResets = createSourceFieldResets({ doc, notebook: props.notebook, definitions: definitionsById, caret, onError: setMessage });

  const contextDate = () => doc.root()?.kind === 'journal' ? doc.root()!.text : props.notebook.todayDate();
  const rowAnchor = (id: string) => id === props.pageId ? heading ?? null : hosts.get(id)?.closest<HTMLElement>('[data-block-id]') ?? null;
  const capabilities = createOutlineCapabilities({ doc, notebook: props.notebook, contextDate, caret, anchor: rowAnchor, onOpen: props.onOpen });

  const fieldConversion = createFieldEntryConversion({
    doc, notebook: props.notebook, disposed: () => disposed, composing: composition, caret, focusEpoch: () => focusEpoch,
    known: name => definitionsByName().get(name.toLowerCase()),
    onStart: () => setCompletion(null),
    onField: field => setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]),
    onCommitted: (id, next, epoch, focus, field) => {
      setMessage('');
      setFolds(previous => { const next = new Set(previous); next.delete(id); return next; });
      if (next && focusEpoch === epoch) {
        setSelected(next.id);
        setCaret(next);
        setRowRange(null);
        setTextRange(null);
        setEditing(next.id);
        if (focus && props.active) queueMicrotask(() => { editAt(next.id, next.offset, true, true, false); offerValue(next.id, field); });
      }
      scheduleReport();
    },
    onError: setMessage,
  });
  /** Leaving a block converts `Name::` shorthand and links hand-typed `[[Title]]`; true when a field conversion started. */
  function commitFieldEntry(id: string, focus = true) {
    linkTitles(id);
    return fieldConversion.shorthand(id, focus);
  }
  /** As in Roam, `[[Title]]` typed by hand links the page with that exact title, or a new one, once the block is left. */
  const linking = new Set<string>();
  function linkTitles(id: string) {
    const text = doc.block(id)?.text;
    if (!text?.includes('[[') || linking.has(id)) return;
    const titles = [...new Set(textTokens(text).flatMap(token => token.kind === 'reference' && !isStableReference(token) && token.id!.trim() ? [token.id!.trim()] : []))];
    if (!titles.length) return;
    linking.add(id);
    void (async () => {
      try {
        const targets = new Map<string, string>();
        for (const title of titles) {
          const key = title.toLocaleLowerCase();
          const found = (await api.complete(title, 20)).find(block => block.kind !== 'block' && block.text.toLocaleLowerCase() === key);
          // A date names a journal; one that does not exist yet stays as typed rather than becoming a page.
          const target = found?.id ?? (/^\d{4}-\d{2}-\d{2}$/.test(title) ? null : await props.notebook.createPage(title));
          if (target) targets.set(key, target);
        }
        const current = doc.block(id)?.text;
        if (disposed || editing() === id || !current) return;
        const next = textTokens(current).map(token => {
          const target = token.kind === 'reference' && !isStableReference(token) ? targets.get(token.id!.trim().toLocaleLowerCase()) : undefined;
          return target ? `[[${target}${token.alias !== undefined ? `|${token.alias}` : ''}]]` : current.slice(token.start, token.end);
        }).join('');
        if (next === current) return;
        const result = doc.edit({ kind: 'text', id, text: next }, caret());
        if (!result.ok) setMessage(result.reason);
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error));
      } finally { linking.delete(id); }
    })();
  }

  const unfoldedIds = createMemo(() => {
    const visible = visibleIds(doc, zoom(), folds(), showArchived(), undefined, depthFilter());
    return doc.root()?.source && !zoom() ? sourceReadingOrder(doc, visible, definitionsById()) : visible;
  });
  const unfoldedSet = createMemo(() => new Set(unfoldedIds()));
  // Only field entries can fold their value inline. Field entries come from structural edits (shorthand
  // conversion inserts the value), which rebuild this list; reading text untracked keeps typing out of it.
  const fieldEntries = createMemo(() => {
    const visible = unfoldedIds(); const definitions = definitionsById();
    return definitions.size ? untrack(() => visible.filter(id => definitions.has(fieldEntryId(doc.block(id)?.text ?? '') ?? ''))) : [];
  });
  // Per-entry memos keep ordinary typing from rebuilding the page's visible list.
  const fieldCandidates = mapArray(fieldEntries, id => ({ id, value: createMemo(() => inlineFieldValue(doc, id, definitionsById())) }));
  const inlineFields = createMemo(() => {
    const visible = unfoldedSet();
    const retained = new Set([editing(), selected(), rowRange()?.anchor, rowRange()?.head, textRange()?.anchor.id, textRange()?.head.id]);
    const result = new Set<string>();
    for (const candidate of fieldCandidates()) {
      const value = candidate.value();
      if (value && visible.has(value) && !retained.has(candidate.id)) result.add(candidate.id);
    }
    return result;
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) });
  // Inline entries only drop out of the unfolded list, so selection changes never re-walk the outline.
  const ids = createMemo(() => { const inline = inlineFields(); const visible = unfoldedIds(); return inline.size ? visible.filter(id => !inline.has(id)) : visible; });
  const indices = createMemo(() => new Map(ids().map((id, index) => [id, index])));
  const baseDepth = createMemo(() => zoom() ? doc.outline.depth(zoom()!) : 0);
  const positionSource = (id: string) => sharedPositionSource(doc, id, fieldId => definitionsById().get(fieldId)?.name);
  /** Perspectives on this page filed under it, as opposed to under a question or another subject. */
  const localPositions = createMemo(() => { let count = 0; (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => { if (doc.block(row.id)?.position?.subject_id === props.pageId) count++; }); return count; });
  // Sources cited or named by positions on this page, in order of first appearance, give the sigla shown in
  // the margin. A source page's own highlights need no mark.
  const citedSources = createMemo(() => {
    const seen: string[] = [];
    const add = (id: string | null | undefined) => { if (id && id !== props.pageId && !seen.includes(id)) seen.push(id); };
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => {
      const block = doc.block(row.id);
      if (block?.position) add(positionSource(row.id));
      for (const citation of block?.citations ?? []) add(citation.source_id);
    });
    return seen;
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  const [siglumRecords] = createResource(() => citedSources().length ? citedSources() : false, ids => Promise.all(ids.map(id =>
    api.source(id).then(view => ({ id, siglum: view.source.siglum, basis: view.source.siglum_basis, authored: view.source.siglum_authored }), () => null))));
  const sigla = createMemo(() => pageSigla((siglumRecords.error ? [] : siglumRecords() ?? []).filter(record => record !== null)));
  const [sourceHighlights] = createResource(() => doc.root()?.source ? [props.pageId, props.notebook.changeSequence()] as const : false,
    ([source_id]) => props.notebook.api.highlights({ source_id, limit: 100000 }));
  const filedElsewhere = createMemo(() => (sourceHighlights()?.rows ?? []).filter(row => row.block.page.id !== props.pageId)
    .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset));
  const sourceDetails = createMemo(() => {
    const fields = new Map<string, string>();
    let firstHighlight: string | undefined;
    let highlightCount = 0;
    if (!doc.root()?.source || zoom()) return { fields, firstHighlight, highlightCount };
    highlightCount = sourceHighlights()?.total ?? 0;
    for (const id of unfoldedIds().filter(id => doc.outline.parentOf(id) === props.pageId)) {
      const block = doc.block(id);
      if (!block || block.archived && !showArchived()) continue;
      const name = sourceFieldName(block.text, definitionsById());
      if (name) fields.set(id, name);
      else if (block.citations.some(citation => citation.source_id === props.pageId)) firstHighlight ??= id;
    }
    return { fields, firstHighlight: highlightCount ? firstHighlight : undefined, highlightCount };
  });
  const selectedIds = createMemo(() => {
    const range = rowRange();
    if (!range) return selected() ? [selected()!] : [];
    const a = indices().get(range.anchor) ?? -1;
    const b = indices().get(range.head) ?? -1;
    return a < 0 || b < 0 ? [] : ids().slice(Math.min(a, b), Math.max(a, b) + 1);
  });
  const selectedSet = createMemo(() => new Set(selectedIds()));
  // Rows under a selected block move, copy and delete with it, so they read as selected too.
  // Field values hang under hidden field entries, so walk every ancestor, not just the parent.
  const coveredSet = createMemo(() => {
    const covered = new Set<string>();
    if (!rowRange()) return covered;
    const selection = selectedSet();
    for (const id of ids()) {
      if (selection.has(id)) continue;
      // parentOf returns the root for the root itself, so stop at that fixed point.
      for (let child = id, parent = doc.outline.parentOf(id); parent !== child; child = parent, parent = doc.outline.parentOf(parent)) {
        if (selection.has(parent)) { covered.add(id); break; }
      }
    }
    return covered;
  });
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return ids().length; },
    getScrollElement: () => scroll,
    // One unwrapped line, and constant: TanStack re-estimates every unmeasured row whenever any row resizes.
    estimateSize: () => 28,
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
    props.onViewChange({ zoom: zoom(), folds: [...folds()], showArchived: showArchived(), depth: depth(), caret: caret(), scroll: currentAnchor() });
  }
  function scheduleReport() {
    cancelAnimationFrame(reportingFrame);
    reportingFrame = requestAnimationFrame(report);
  }
  /** Measuring the scroll anchor forces layout, so a scroll reports once it settles rather than every frame. */
  function scrolled() {
    clearTimeout(scrollSettle);
    scrollSettle = window.setTimeout(scheduleReport, 150);
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
  /** Moves the depth dial. Rows that leave the list stop being edited or selected; the rest keep their place. */
  function setStop(stop: Depth) {
    if (composition() || depthReason() || stop === depth()) return;
    if (editing() && commitFieldEntry(editing()!)) return;
    anchored(() => setDepth(stop));
    const visible = indices();
    if (editing() && !visible.has(editing()!)) setEditing(null);
    if (selected() && !visible.has(selected()!)) { setSelected(null); setCaret(null); }
    setRowRange(null);
    setTextRange(null);
    report();
    scheduleReport();
  }
  const depthReason = () => doc.root()?.kind !== 'page' ? 'Only titled pages have depth.' : zoom() ? 'Zoom out to change depth.' : undefined;
  const stepDepth = (delta: 1 | -1) => { const next = depthStops[depthStops.indexOf(depth()) + delta]; if (next) setStop(next); };
  const depthTitles: Record<Depth, string> = { gloss: 'Show the gloss only', opening: 'Show the opening', perspectives: 'Show perspectives', full: 'Show the full page' };
  /** Edits the gloss, adding the entry as the page's first block when there is none. */
  function addGloss() {
    const existing = glossId();
    if (existing) {
      if (zoom()) zoomTo(null);
      const value = doc.outline.children(existing)[0];
      if (value) editAt(value, doc.block(value)?.text.length ?? 0, true);
      return;
    }
    const result = doc.edit({ kind: 'insert', parentId: props.pageId, after: null, text: '' }, caret());
    if (!result.ok) { setMessage(result.reason); return; }
    fieldConversion.entry(result.created[0]!, GLOSS_FIELD, 0, true);
  }
  function clearSelection() {
    focusEpoch++;
    focusRequest = null;
    setEditing(null);
    setSelected(null);
    setCaret(null);
    setRowRange(null);
    setTextRange(null);
    resetRowKey();
    scheduleReport();
  }

  function rename() { if (doc.root()?.kind !== 'page') return; setTitle(doc.root()!.text); setRenaming(true); queueMicrotask(() => { titleInput?.focus(); titleInput?.select(); }); }
  function commitTitle() {
    const result = doc.rename(title());
    if (result.ok) { setRenaming(false); setMessage(''); }
    else { setMessage(result.reason); titleInput?.focus(); }
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

  const breadcrumbs = createMemo(() => {
    doc.outline.version();
    const path: string[] = [];
    let id = zoom();
    while (id && id !== props.pageId) { path.unshift(id); const parent = doc.outline.parentOf(id); if (parent === id) break; id = parent; }
    return path;
  });

  // Factories share the pane's owner. Keep signals callable and late-mounted state behind getters;
  // forwarding callbacks connect factories without reading another factory before it is initialized.
  const context: OutlineContext = {
    contextDate,
    editing,
    textRange,
    composition,
    caret,
    get editor() { return editor; },
    doc,
    capabilities,
    setCaret,
    scheduleReport,
    setMessage,
    get disposed() { return disposed; },
    rowAnchor,
    editAt,
    props,
    replaceSelection,
    fields,
    definitionsById,
    definitions,
    activeRange,
    fieldConversion,
    get commandDefinitions() { return commandDefinitions; },
    openPlanning: (id, kind) => openPlanning(id, kind),
    priorityMenu: (id) => priorityMenu(id),
    openProject: (id) => openProject(id),
    investigationItems: (id) => investigationItems(id),
    apply,
    zoomTo,
    copy: (text) => copy(text),
    commitFieldEntry,
    selected,
    setMenu,
    rename,
    addGloss,
    localPositions,
    depthTitles,
    depthReason,
    setStop,
    depth,
    stepDepth,
    get heading() { return heading; },
    adjacent: (direction, extend) => adjacent(direction, extend),
    horizontal: (direction) => horizontal(direction),
    ids,
    rowFocus,
    split: (view) => split(view),
    roots,
    setRowRange,
    fold,
    zoom,
    zoomOut,
    anchored,
    setShowArchived,
    undo,
    setConflicts,
    indices,
    setFolds,
    setZoom,
    selectedSet,
    sourceResets,
    get setCompletionIndex() { return setCompletionIndex; },
    get setCompletion() { return setCompletion; },
    rewriteEditing: (id, next) => rewriteEditing(id, next),
    folds,
    inlineFields,
    setSelected,
    deleteTextRange,
    setTextRange,
    afterReference: (event, view) => afterReference(event, view),
    slashKey: (event) => slashKey(event),
    dateKey: (event) => dateKey(event),
    popupKey: (event) => popupKey(event),
    leaderMenu: (id) => leaderMenu(id),
    openTable: (beside) => openTable(beside),
    rowRange,
    statusMenu: (id) => statusMenu(id),
    get scroll() { return scroll; },
    clearSelection,
    restoreSelection,
    selectedIds,
    get compositionSelection() { return !!compositionSelection; },
    baseDepth,
    positionSource,
    sourceDetails,
    virtualizer,
    hosts,
    coveredSet,
    glossId,
    margin,
    sigla,
    blockMenu: (id, anchor) => blockMenu(id, anchor),
    pointerStart: (event, id, element) => pointerStart(event, id, element),
    attach,
    referenceMenu: (id, anchor) => referenceMenu(id, anchor),
    selectedOffsets: (id) => selectedOffsets(id),
    conflicts,
    editedConflicts,
    setEditedConflicts,
  };
  const { setCompletion, setCompletionIndex, offerValue, updateCompletion, updateTriggers, taskPrefix, rewriteEditing, afterReference, slashKey, dateKey, popupKey, CompletionPopups } = createOutlineCompletions(context);
  const { openTable, investigationItems, commandDefinitions, unregister, blockMenu, statusMenu, priorityMenu, openPlanning, openProject, leaderMenu, referenceMenu, copy } = createOutlineCommands(context);
  const { horizontal, adjacent, split, editorKey, structuralKey, resetRowKey } = createOutlineKeyboard(context);
  const { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput } = createOutlineInteractions(context);
  const { Row, TaskSummary, QuestionSummary } = createOutlineRows(context);
  const { related, apparatus, holders, linkedPages, Related } = createOutlineRelated(context);
  const { CapabilityPopups } = createCapabilityPopups(context);

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
    editor.configureFields(id => definitionsById().get(id)?.name, name => definitionsByName().get(name.toLowerCase())?.kind);
    const observer = new ResizeObserver(() => { setMargin(list.offsetTop); });
    observer.observe(scroll.querySelector('.outline-heading')!);
    setMargin(list.offsetTop);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerEnd);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('mousemove', pointerMove); document.removeEventListener('mouseup', pointerEnd); });
  });
  createEffect(() => { const enabled = props.vim; if (editor) { editor.configure(enabled); props.onVimMode(enabled ? editing() ? editor.mode() : 'outline' : null); } });
  createEffect(() => { const byId = definitionsById(), byName = definitionsByName(); editor?.configureFields(id => byId.get(id)?.name, name => byName.get(name.toLowerCase())?.kind); });
  createEffect(() => {
    if (doc.status() !== 'ready' || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      const saved = initial.caret;
      if (doc.root()?.kind !== 'journal') {
        const id = saved && doc.block(saved.id) && indices().has(saved.id) ? saved.id : null;
        if (id && initial.edit) {
          editAt(id, saved!.offset, !props.vim, !initial.scroll, true);
          scheduleReport();
          if (initial.scroll) requestAnimationFrame(() => restoreAnchor(initial.scroll));
          return;
        }
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
    setLinkedCitation(null);
    unregister();
    doc.release();
    editor?.destroy();
    cancelAnimationFrame(reportingFrame);
    clearTimeout(scrollSettle);
    cancelAnimationFrame(anchorFrame);
  });

  return <div ref={scroll} class="outline-pane" classList={{ 'has-apparatus': apparatus(), 'has-sigla': sigla().size > 0 }} data-pane={props.pane} tabIndex={0} role="tree" aria-label="Page outline" aria-owns={[...virtualItems().keys()].map(id => `outline-${props.pane}-${id}`).join(' ')} onFocusIn={props.onActivate} onFocusOut={report} onKeyDown={structuralKey} onWheel={() => { anchorEpoch++; cancelAnimationFrame(anchorFrame); }} onScroll={scrolled}>
    <Show when={apparatus()}><Apparatus notebook={props.notebook} holders={holders()} linked={linkedPages()} sources={citedSources().flatMap(id => sigla().has(id) ? [{ id, siglum: sigla().get(id)! }] : [])} onOpen={props.onOpen} /></Show>
    <div ref={heading} class="outline-heading">
      <Show when={zoom()}><nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs"><button type="button" onClick={() => zoomTo(null)}>{doc.root()?.text}</button><For each={breadcrumbs()}>{id => <><Icon name="right" /><button type="button" onClick={() => zoomTo(id)}>{plainText(doc.block(id)?.text ?? '', reference => props.notebook.lookup(reference)) || 'Empty block'}</button></>}</For></nav></Show>
      <div class="outline-title-row">
      <Show when={renaming()} fallback={<h1><button class="outline-title" type="button" disabled={doc.root()?.kind !== 'page'} onClick={rename}>{doc.root()?.text || 'Loading…'}</button></h1>}>
        <input ref={titleInput} class="title-input" aria-label="Page title" value={title()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commitTitle(); } if (event.key === 'Escape') { setRenaming(false); setMessage(''); } }} />
        <button type="button" onClick={commitTitle}>Save title</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
      </Show>
      <Show when={doc.root()?.kind === 'page' && !doc.root()?.source}><div class="outline-header-actions"><Button icon="table" label="Table" shortcut="⌘⇧T" onClick={event => openTable(event.metaKey)}>Table<Show when={!type.error && (type()?.members ?? 0) > 0}><span class="table-member-count">{type()?.members}</span></Show></Button></div></Show>
      </div>
      <Show when={doc.root()?.source}><SourceHeader doc={doc} notebook={props.notebook} resetItems={sourceResets} onOpen={props.onOpen} onError={setMessage} onDelete={props.onDelete} /></Show>
      <Show when={doc.root()?.task || doc.root()?.project || doc.root()?.question || doc.root()?.citations.length}><div class="outline-root-capabilities outline-capability-metadata">
        <Show when={doc.root()?.task}>
          <TaskStatusButton task={doc.root()?.task ?? null} disabled={capabilities.busy(props.pageId)} onChange={status => capabilities.status(props.pageId, status)} />
          <TaskSummary id={props.pageId} />
          <Button class="outline-planning" onClick={event => capabilities.open(props.pageId, 'work', event.currentTarget)}>Work sessions</Button>
        </Show>
        <Show when={doc.root()?.project}><Button class="outline-planning" onClick={event => capabilities.open(props.pageId, 'project', event.currentTarget)}>Project</Button></Show>
        <QuestionSummary id={props.pageId} />
        <For each={doc.root()?.citations}>{citation => <CitationChip citation={citation} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />}</For>
      </div></Show>
      <For each={doc.root()?.citations}>{citation => <Show when={doc.root()?.text.trim() !== citation.quote.trim()}>
        <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
      </Show>}</For>
      <Show when={capabilities.error(props.pageId)}><p class="outline-capability-error" role="alert">{capabilities.error(props.pageId)}</p></Show>
      <Show when={showArchived()}><p class="archive-notice">Showing archived blocks <button type="button" class="text-button" onClick={() => { setShowArchived(false); scheduleReport(); }}>Hide archived</button></p></Show>
      <Show when={message()}><p class="outline-message" role="alert">{message()} <button class="text-button" type="button" onClick={() => setMessage('')}>Dismiss</button></p></Show>
      <Show when={doc.status() === 'error' || doc.status() === 'missing'}><p role="alert">{doc.statusMessage()}</p></Show>
      <Show when={doc.status() === 'ready' && depth() === 'gloss' && !zoom() && !glossId()}>
        <p class="empty-state">No gloss yet. Choose Gloss in the page menu to write a one-line summary.</p>
      </Show>
      <Show when={doc.root()?.kind === 'journal'}>
        <JournalAgenda date={doc.root()!.text} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />
        <JournalResurface date={doc.root()!.text} notebook={props.notebook} onOpen={props.onOpen} />
      </Show>
    </div>
    <div ref={list} class="outline-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      <For each={[...virtualItems().keys()].filter(id => id !== editing())}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</Show>
    </div>
    <Show when={doc.root()?.source && !zoom() && !sourceDetails().firstHighlight}><div class="outline-list"><div class="outline-highlights-label">Highlights <span>{sourceHighlights()?.total ?? 0}</span></div></div></Show>
    <Show when={doc.root()?.source && !zoom() && filedElsewhere().length}><section class="related-sections source-elsewhere" aria-label="Filed elsewhere">
      <h3 class="outline-highlights-label">Filed elsewhere <span>{filedElsewhere().length}</span></h3>
      <For each={filedElsewhere()}>{row => <Button class="library-highlight" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id }, event.shiftKey)}>
        <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} />
        <span class="library-highlight-meta">¶{row.citation.ordinal + 1} · {row.block.page.text}</span>
      </Button>}</For>
    </section></Show>
    <Show when={sourceHighlights.error}><p class="library-error" role="alert">{String(sourceHighlights.error)}</p></Show>
    <Show when={doc.status() === 'ready' && ids().length === 0 && depthFilter() === undefined}><button type="button" class="add-first-block" onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}><Icon name="plus" />Add a block</button></Show>
    <Show when={doc.status() === 'ready' && (related.error || (related()?.backlinks.length ?? 0) + (related()?.tagged.length ?? 0) + (related()?.held.length ?? 0) + (related()?.about.length ?? 0) > 0)}><div class="related-sections">
      <Show when={related()?.held.length}><Related title="Perspectives held" rows={related()?.held ?? []} /></Show>
      <Show when={related()?.about.length}><Related title="Perspectives filed elsewhere" rows={related()?.about ?? []} /></Show>
      <Show when={related.error || related()?.backlinks.length}><Related title="Backlinks" rows={related.error ? [] : related()?.backlinks ?? []} /></Show>
      <Show when={related.error || related()?.tagged.length}><Related title="Tagged blocks" rows={related.error ? [] : related()?.tagged ?? []} /></Show>
    </div></Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.label} items={state.items} onDismiss={() => setMenu(null)} />}</Show>
    <CapabilityPopups />
    <CompletionPopups />
  </div>;
}
