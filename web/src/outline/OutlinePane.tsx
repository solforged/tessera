import { CardSummary } from './CardSummary';
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, mapArray, onCleanup, onMount, untrack } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { Block, FieldDefinition } from '../api/types';
import { api } from '../api/client';
import type { Caret, Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import { depthStops } from '../shell/contract';
import type { Depth, OutlinePaneProps, ViewState } from '../shell/contract';
import { fieldEntryId } from '../table/query';
import { setLinkedCitation } from '../library/highlights';
import { createTemplateCache, startingTemplateFor } from '../fields/templates';
import { TemplateEditor } from '../fields/TemplateEditor';
import { pageSigla } from '../library/sigla';
import { sourceReadingOrder } from '../library/source-order';
import { PersonWorks } from '../library/PersonWorks';
import { NoteAliases, NoteEyebrow, NoteLine } from '../notes/NoteHeader';
import type { OutlineIndex } from '../document/outline-index';
import { JournalHeader } from '../tasks/JournalHeader';
import { JournalResurface } from '../tasks/JournalResurface';
import { TaskStatusButton } from '../tasks/TaskControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { BlockText, plainText } from './BlockText';
import { isStableReference, textTokens } from '../document/text-tokens';
import { PaneEditor } from './editor';
import { createOutlineCapabilities } from './capabilities';
import { inlineFieldValues, selectionIds, selectionRoots, survivingZoomPath, visibleIds } from './visibility';
import type { DepthFilter } from './visibility';
import { CitationChip, SourceHeader } from './SourceHeader';
import { SourceDetails } from './SourceDetails';
import { GLOSS_FIELD, glossEntry, isGistName, isGlossName } from './gloss';
import { positionSource as sharedPositionSource } from './perspectives';
import { Apparatus } from './Apparatus';
import { createFieldEntryConversion, createSourceFieldResets, ensureField } from './source-fields';
import { sourceFieldName } from './source';
import { createOutlineCompletions } from './completions';
import { headingPrefix } from './completion';
import { createOutlineCommands } from './commands';
import { createOutlineKeyboard } from './keyboard';
import { createOutlineInteractions } from './interactions';
import { createOutlineRows } from './Row';
import { createOutlineDrag } from './drag';
import { createOutlineRelated } from './Related';
import { createFieldSheet } from './field-sheet';
import { createCapabilityPopups } from './CapabilityPopups';
import type { MenuState, OutlineContext, RowRange } from './context';
import { PageMergeConfirmation, pageMergeDisabledReason } from './PageMerge';
import { foldName, nameMenuItems, resolveName } from './names';
import { titleTargets, typedTitles, withLinkedTitles } from './link-titles';
import './outline.css';

const storedFolds = new Map<string, Set<string>>();

export function OutlinePane(props: OutlinePaneProps) {
  return <Show keyed when={props.pageId}>{pageId => <Pane {...props} pageId={pageId} />}</Show>;
}

function Pane(props: OutlinePaneProps) {
  const doc: PageDocument = props.notebook.open(props.pageId);
  const initial = untrack(() => props.view);
  const journalPeriod = untrack(() => props.journalPeriod);
  const [zoomTarget, setZoom] = createSignal(initial.zoom);
  let previousZoomTarget: string | null = null;
  let previousZoomPath: string[] = [];
  const breadcrumbs = createMemo(() => {
    doc.outline.version();
    const target = zoomTarget();
    if (doc.status() !== 'ready') return target ? [target] : [];
    const path = survivingZoomPath(doc, target, target === previousZoomTarget ? previousZoomPath : []);
    previousZoomTarget = target;
    previousZoomPath = path;
    return path;
  });
  const zoom = createMemo(() => breadcrumbs().at(-1) ?? null);
  createEffect(() => { if (doc.status() === 'ready' && zoomTarget() !== zoom()) setZoom(zoom()); });
  const [folds, setFolds] = createSignal(new Set(initial.folds ?? storedFolds.get(`${props.pane}:${props.pageId}`) ?? []));
  const [foldMotion, setFoldMotion] = createSignal<{ id: string; opening: boolean; afterIds: string[]; beforeSize: number }>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let foldChildren!: HTMLDivElement, foldFollowing!: HTMLDivElement, foldEditor!: HTMLDivElement;
  let foldFrame = 0;
  let foldAnimations: Animation[] = [];
  let settleFold: (() => void) | undefined;
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
  const [mergeTarget, setMergeTarget] = createSignal<{ page: Block; from: { id: string; text: string }; anchor: HTMLElement }>();
  const titleCollision = createMemo(() => {
    const value = title().trim().toLocaleLowerCase();
    return renaming() && value ? props.notebook.roots().find(page => page.id !== props.pageId && page.kind === 'page' && page.text.toLocaleLowerCase() === value) : undefined;
  });
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
  let focusRestoresPending = 0;
  let reportingFrame = 0;
  let scrollSettle = 0;
  let anchorFrame = 0;
  const [scrollAnchor, setScrollAnchor] = createSignal<ViewState['scroll']>(null);
  let scrollReveal: { id: string; epoch: number; caret: boolean } | null = null;
  let scrollingFrame = false;
  let scrollStable = 0;
  let previousScrollHeight = -1;
  let compositionSelection: { range: TextRange; id: string; original: string; from: number; to: number; committed?: string } | null = null;
  let compositionFrame = 0;
  const [createdFields, setCreatedFields] = createSignal<FieldDefinition[]>([]);
  const live = createMemo(() => props.notebook.connection() === 'live');
  const [fields] = createResource(() => [props.notebook.changeSequence(), live()] as const, () => api.fields());
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
  const templates = createTemplateCache(() => fields.error ? undefined : fields(), props.notebook.lastChange);
  const glossId = createMemo(() => doc.root()?.kind === 'page' ? glossEntry(doc, id => isGlossName(definitionsById().get(id)?.name)) : null);
  const depthFilter = createMemo<DepthFilter | undefined>(() => doc.root()?.kind === 'page' && depth() !== 'full'
    ? { stop: depth(), gloss: glossId(), position: id => !!doc.block(id)?.position, gist: id => isGistName(definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '')?.name) } : undefined);
  const [type] = createResource(
    () => doc.root()?.kind === 'page' ? [props.pageId, props.notebook.changeSequence(), live()] as const : false,
    ([pageId]) => api.type(pageId),
  );
  const [editingNames] = createResource(() => {
    const id = editing();
    const names = id ? [...new Set(textTokens(doc.block(id)?.text ?? '').flatMap(token => token.kind === 'reference' && !isStableReference(token) ? [token.id!] : []))] : [];
    return names.length ? [names.join('\u0000'), props.notebook.changeSequence()] as const : false;
  }, async ([names]) => new Map(await Promise.all(names.split('\u0000').map(async name => [foldName(name), await resolveName(props.notebook, name)] as const))));
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
  /** A hand-typed name links only when one page owns it; ambiguous names wait for a choice. */
  const linking = new Set<string>();
  function linkTitles(id: string) {
    const titles = typedTitles(doc.block(id)?.text ?? '');
    if (!titles.length || linking.has(id)) return;
    linking.add(id);
    void (async () => {
      try {
        const targets = await titleTargets(props.notebook, titles);
        const current = doc.block(id)?.text;
        if (disposed || editing() === id || !current) return;
        const next = withLinkedTitles(current, targets);
        if (next === current) return;
        const result = doc.edit({ kind: 'text', id, text: next }, caret());
        if (!result.ok) setMessage(result.reason);
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error));
      } finally { linking.delete(id); }
    })();
  }

  const [sourceFieldsVisible, setSourceFieldsVisible] = createSignal(!!initial.caret);
  const [sourceDetailsOpen, setSourceDetailsOpen] = createSignal(false);
  const [sourceColors, setSourceColors] = createSignal<string[]>([]);
  const [sourceGrouped, setSourceGrouped] = createSignal(true);
  const unfoldedIds = createMemo(() => {
    const visible = visibleIds(doc, zoom(), folds(), showArchived(), undefined, depthFilter());
    if (!doc.root()?.source || zoom()) return visible;
    // Field definitions distinguish source metadata from ordinary outline rows; never guess while loading.
    if (!fields.error && !fields()) return [];
    const roots = new Map<string, string>();
    const colors = sourceColors(), showFields = sourceFieldsVisible();
    const shown = visible.filter(id => {
      const parent = doc.outline.parentOf(id), root = parent === props.pageId ? id : roots.get(parent) ?? id;
      roots.set(id, root);
      const block = doc.block(root);
      if (sourceFieldName(block?.text ?? '', definitionsById())) return showFields;
      const citation = block?.citations.find(value => value.source_id === props.pageId);
      return !citation || !colors.length || !!citation.color && colors.includes(citation.color);
    });
    return sourceReadingOrder(doc, shown, definitionsById());
  });
  const unfoldedSet = createMemo(() => new Set(unfoldedIds()));
  // Only field entries can fold their values inline. Field entries come from structural edits (shorthand
  // conversion inserts the value), which rebuild this list; reading text untracked keeps typing out of it.
  const fieldEntries = createMemo(() => {
    const visible = unfoldedIds(); const definitions = definitionsById();
    return definitions.size ? untrack(() => visible.filter(id => definitions.has(fieldEntryId(doc.block(id)?.text ?? '') ?? ''))) : [];
  });
  // Per-entry memos keep ordinary typing from rebuilding the page's visible list.
  const fieldCandidates = mapArray(fieldEntries, id => ({ id, values: createMemo(() => inlineFieldValues(doc, id, definitionsById()), undefined, { equals: (a, b) => a === b || !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]) }) }));
  const inlineFields = createMemo(() => {
    const visible = unfoldedSet();
    const retained = new Set([editing(), selected(), rowRange()?.anchor, rowRange()?.head, textRange()?.anchor.id, textRange()?.head.id]);
    const result = new Set<string>();
    for (const candidate of fieldCandidates()) {
      const values = candidate.values();
      // Hidden archived values do not keep the rest from lining up; an entry whose values are all hidden shows as empty.
      if (values?.some(value => visible.has(value)) && values.every(value => visible.has(value) || doc.isArchived(value)) && !retained.has(candidate.id)) result.add(candidate.id);
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
  const [sourceHighlights] = createResource(() => doc.root()?.source && !zoom() ? [props.pageId, props.notebook.changeSequence(), live()] as const : false,
    ([source_id]) => props.notebook.api.highlights({ source_id, limit: 100000 }));
  const [sourceHeaderReady, setSourceHeaderReady] = createSignal(false);
  // Mount the designed structure for measurement, but reveal it and its portaled dock together.
  // Keep settled resources visible during background refreshes, and paint nothing before the first load:
  // the title's "Loading…" placeholder otherwise flashes for a frame on every page open.
  const sourceReady = () => doc.status() !== 'loading' && (!doc.root()?.source || sourceHeaderReady()
    && !!(fields.error || fields()) && (!!zoom() || !!(sourceHighlights.error || sourceHighlights())));
  const filedElsewhere = createMemo(() => (sourceHighlights.error ? [] : sourceHighlights()?.rows ?? []).filter(row => row.block.page.id !== props.pageId && (!sourceColors().length || !!row.color && sourceColors().includes(row.color)))
    .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset));
  const sourceDetails = createMemo(() => {
    const fields = new Map<string, string>();
    // The first highlight under each chapter of the contents, in reading order, carries that chapter's title.
    const chapters = new Map<string, string>();
    if (!doc.root()?.source || zoom()) return { fields, chapters };
    const counts = new Map<string, number>();
    for (const row of sourceHighlights.error ? [] : sourceHighlights()?.rows ?? []) {
      const title = row.citation.chapter_title;
      if (row.block.page.id === props.pageId && title && (!sourceColors().length || !!row.color && sourceColors().includes(row.color))) counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    let chapter: string | null | undefined;
    for (const id of unfoldedIds().filter(id => doc.outline.parentOf(id) === props.pageId)) {
      const block = doc.block(id);
      if (!block || block.archived && !showArchived()) continue;
      const name = sourceFieldName(block.text, definitionsById());
      const citation = name ? undefined : block.citations.find(value => value.source_id === props.pageId);
      if (name) fields.set(id, name);
      else if (citation) {
        const title = citation.chapter_title ?? null;
        if (sourceGrouped() && title && title !== chapter) chapters.set(id, `${title}${counts.has(title) ? ` · ${counts.get(title)}` : ''}`);
        chapter = title;
      }
    }
    return { fields, chapters };
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
    // A sheet moves between value rows in one edit. Sync reads must not reuse either row's old height.
    measureElement: element => element.offsetHeight,
    overscan: 8,
    get scrollMargin() { return margin(); },
    get getItemKey() { const rows = ids(); return (index: number) => rows[index]!; },
    get rangeExtractor() {
      const pinned = [editing(), scrollAnchor()?.id, capabilities.popup()?.id, ...(foldMotion()?.afterIds ?? [])].flatMap(id => id ? indices().get(id) ?? [] : []);
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const result = defaultRangeExtractor(range);
        for (const index of pinned) if (!result.includes(index)) result.push(index);
        return result.sort((a, b) => a - b);
      };
    },
  });
  // Size changes and structural edits share the same anchor/reveal decision, never a second scroll writer.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = item => {
    if (!scrollingFrame) {
      if (anchorFrame) scheduleScroll();
      else if (scroll && item.start < scroll.scrollTop) restoreAnchor(currentAnchor());
    }
    return false;
  };
  const virtualItems = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [String(item.key), item])));
  const [listHeight, setListHeight] = createSignal(virtualizer.getTotalSize());
  createEffect(() => {
    const height = virtualizer.getTotalSize();
    // Removing a sheet-bearing row must not publish a temporarily shorter sizer and clamp the browser's scrollTop.
    if (!anchorFrame && !scrollingFrame) setListHeight(height);
  });

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
  function scheduleScroll() {
    if (disposed) return;
    scrollStable = 0;
    if (!anchorFrame) anchorFrame = requestAnimationFrame(settleScroll);
  }
  function cancelScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    setScrollAnchor(null);
    scrollReveal = null;
    previousScrollHeight = -1;
    setListHeight(virtualizer.getTotalSize());
  }
  function measureRows() {
    scrollingFrame = true;
    // Refresh both sides of a sheet transfer before publishing their combined list height.
    batch(() => {
      for (const row of list.querySelectorAll<HTMLDivElement>('[data-index]')) {
        virtualizer.resizeItem(Number(row.dataset.index), row.offsetHeight);
      }
    });
    setListHeight(virtualizer.getTotalSize());
    scrollingFrame = false;
  }
  function settleScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    if (disposed) return;
    const before = scroll.scrollTop;
    measureRows();
    const bounds = scroll.getBoundingClientRect();
    const anchor = scrollAnchor();
    const row = anchor && indices().has(anchor.id) ? rowAnchor(anchor.id) : null;
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    let offset = Math.max(0, Math.min(maximum, before + (row && anchor ? row.getBoundingClientRect().top - bounds.top - anchor.offset : 0)));
    const request = scrollReveal;
    const valid = request && props.active && focusEpoch === request.epoch && (request.caret ? editing() : selected()) === request.id;
    const target = valid ? request.caret
      ? editor?.id === request.id && hosts.get(request.id)?.contains(editor.view.dom) ? editor.view.coordsAtPos(editor.view.state.selection.main.head) : null
      : rowAnchor(request.id)?.getBoundingClientRect() : null;
    if (target) {
      // Test the caret against the viewport it would have after anchoring, then make only one scroll write.
      const shift = offset - before;
      if (target.top - shift < bounds.top) offset += target.top - shift - bounds.top;
      else if (target.bottom - shift > bounds.bottom) offset += Math.min(target.bottom - shift - bounds.bottom, target.top - shift - bounds.top);
      offset = Math.max(0, Math.min(maximum, offset));
    }
    if (Math.abs(offset - before) > .5) scroll.scrollTop = offset;
    // Reveal wins. Later measurements retain this resulting position, not the pre-reveal anchor offset.
    if (row && anchor) {
      const position = row.getBoundingClientRect().top - bounds.top;
      if (Math.abs(position - anchor.offset) > .5) setScrollAnchor({ id: anchor.id, offset: position });
    }
    scrollStable = scroll.scrollTop === before && scroll.scrollHeight === previousScrollHeight && (!valid || target) ? scrollStable + 1 : 0;
    previousScrollHeight = scroll.scrollHeight;
    if (scrollStable < 2) anchorFrame = requestAnimationFrame(settleScroll);
    else { cancelScroll(); scheduleReport(); }
  }
  function restoreAnchor(anchor: ViewState['scroll']) {
    if (!anchor || !indices().has(anchor.id) || disposed) return;
    setScrollAnchor({ ...anchor });
    scheduleScroll();
  }
  function anchored(change: () => void) {
    if (!scrollAnchor()) setScrollAnchor(currentAnchor());
    scheduleScroll();
    change();
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
    const same = editor.id === id;
    if (!request && same && host.contains(editor.view.dom)) { editor.sync(block.text); followText(id); return; }
    const offset = request?.offset ?? (caret()?.id === id ? caret()!.offset : 0);
    const popupFocused = document.activeElement?.closest('[role="dialog"], [role="menu"], [role="listbox"]');
    editor.mount(host, id, block.text, offset, request?.insert ?? !props.vim, !!request && props.active && !popupFocused && !renaming());
    if (same) followText(id);
    // Publishing the inserted row's height and revealing its caret must finish before the same paint.
    if (anchorFrame) settleScroll();
    else virtualizer.measureElement(host.closest<HTMLDivElement>('[data-index]')!);
  }
  /**
   * An edit applied through the document (Backspace over a pair or a reference, a chosen completion) reaches
   * the editor without its update hooks, so the pickers follow the new text here instead of going stale.
   */
  function followText(id: string) {
    if (!editor || editor.id !== id || composition()) return;
    const text = editor.view.state.doc.toString();
    const at = { id, offset: editor.view.state.selection.main.head };
    updateCompletion(text, at);
    updateTriggers(text, at);
  }
  /** Structural commands reveal folded destinations before restoring the caret. */
  function revealRow(id: string) {
    if (!doc.block(id)) return;
    // Settle a deferred closing fold before unfolding, so its completion cannot hide the target again.
    finishFoldMotion();
    const ancestors: string[] = [];
    for (let child = id, parent = doc.outline.parentOf(id); parent !== child; child = parent, parent = doc.outline.parentOf(parent)) {
      if (folds().has(parent)) ancestors.push(parent);
    }
    if (ancestors.length) setFolds(previous => { const next = new Set(previous); for (const parent of ancestors) next.delete(parent); return next; });
  }
  function visibleNeighbor(id: string, before: readonly string[]) {
    const visible = indices();
    if (visible.has(id)) return id;
    const at = before.indexOf(id);
    for (let index = at - 1; index >= 0; index--) if (visible.has(before[index]!)) return before[index]!;
    for (let index = at + 1; index < before.length; index++) if (visible.has(before[index]!)) return before[index]!;
    const current = selected();
    return current && visible.has(current) ? current : ids()[0] ?? null;
  }
  /** Hidden or deleted targets leave ownership on the outline, even when no rows remain. */
  function selectSurvivor(id: string, before: readonly string[]) {
    const next = visibleNeighbor(id, before);
    focusEpoch++;
    focusRequest = null;
    batch(() => {
      setCompletion(null);
      setEditing(null);
      setRowRange(null);
      setTextRange(null);
      setSelected(next);
      setCaret(next ? { id: next, offset: 0 } : null);
    });
    props.onVimMode(props.vim ? 'outline' : null);
    if (props.active) scroll.focus({ preventScroll: true });
    scheduleReport();
  }
  function restoreFocus() {
    if (disposed || !props.active || composition() || renaming()) return;
    const id = editing();
    if (id && indices().has(id) && editor?.id === id && editor.view.dom.isConnected) editor.view.focus();
    else scroll.focus({ preventScroll: true });
  }
  function editAt(id: string, offset = 0, insert = !props.vim, reveal = true, activate = true) {
    if (disposed || composition()) return;
    revealRow(id);
    if (!indices().has(id)) { selectSurvivor(id, ids()); return; }
    const previous = editing();
    if (previous && previous !== id && doc.block(previous) && commitFieldEntry(previous)) return;
    if (activate) props.onActivate();
    offset = Math.max(0, Math.min(offset, doc.block(id)?.text.length ?? 0));
    setSelected(id);
    setRowRange(null);
    setCaret({ id, offset });
    focusRequest = { id, offset, insert, epoch: ++focusEpoch };
    if (reveal) { scrollReveal = { id, epoch: focusEpoch, caret: true }; scheduleScroll(); }
    setEditing(id);
    queueMicrotask(() => mountEditor(id));
    scheduleReport();
  }
  function rowFocus(id: string, extend = false) {
    if (disposed || composition()) return;
    if (!indices().has(id)) { selectSurvivor(id, ids()); return; }
    const previous = editing();
    if (previous && doc.block(previous) && commitFieldEntry(previous)) return;
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
    scrollReveal = { id, epoch: focusEpoch, caret: false };
    scheduleScroll();
    scheduleReport();
  }
  function apply(intent: Edit, keepEditing = editing() !== null): EditResult | undefined {
    if (disposed || composition()) return undefined;
    const rearrange = intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move' || intent.kind === 'moveTo';
    if (intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move') intent = { ...intent, zoomRoot: zoom() };
    const before = ids();
    const previousCaret = caret();
    const selection = rowRange() ?? (selected() && !editing() ? { anchor: selected()!, head: selected()! } : undefined);
    const epoch = focusEpoch;
    let result: EditResult | undefined;
    focusRestoresPending++;
    measure('structural', () => anchored(() => { result = doc.edit(intent, previousCaret ? { ...previousCaret, selection } : null); }));
    if (!result || !result.ok) { focusRestoresPending--; setMessage(result && !result.ok ? result.reason : 'The edit could not be applied.'); return result; }
    setMessage('');
    setTextRange(null);
    if (!rearrange) setRowRange(null);
    const next = result.caret;
    if (next && keepEditing) revealRow(next.id);
    if (next) queueMicrotask(() => {
      try {
        if (disposed || !props.active || focusEpoch !== epoch) return;
        if (!indices().has(next.id)) selectSurvivor(next.id, before);
        else if (keepEditing) editAt(next.id, next.offset, true, true, false);
        else if (rearrange) scroll.focus({ preventScroll: true });
        else rowFocus(next.id);
      } finally { focusRestoresPending--; }
    });
    else {
      focusRestoresPending--;
      if (selected() && !indices().has(selected()!)) selectSurvivor(selected()!, before);
    }
    scheduleReport();
    return result;
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
    const before = ids();
    focusRestoresPending++;
    const result = redo ? doc.redo() : doc.undo();
    if (!result) focusRestoresPending--;
    if (result) {
      revealRow(result.selection?.anchor ?? result.range?.anchor.id ?? result.id);
      revealRow(result.selection?.head ?? result.range?.head.id ?? result.id);
    }
    const epoch = focusEpoch;
    setMessage(doc.historyMessage());
    setTextRange(null);
    setRowRange(null);
    if (result) queueMicrotask(() => {
      try {
        if (disposed || !props.active || focusEpoch !== epoch) return;
        const target = result.range?.head ?? result;
        if (result.selection) {
          const anchor = result.selection.anchor, head = result.selection.head;
          if (!indices().has(anchor) || !indices().has(head)) { selectSurvivor(head, before); return; }
          focusEpoch++;
          focusRequest = null;
          batch(() => {
            setCompletion(null);
            setEditing(null);
            setSelected(head);
            setCaret({ id: head, offset: result.offset });
            setRowRange(anchor === head ? null : { anchor, head });
          });
          props.onVimMode(props.vim ? 'outline' : null);
          scroll.focus({ preventScroll: true });
          scheduleReport();
        } else if (!indices().has(target.id)) selectSurvivor(target.id, before);
        else {
          editAt(target.id, target.offset, !props.vim, true, false);
          if (result.range) queueMicrotask(() => { if (!disposed && props.active && editing() === target.id) restoreSelection(result.range!); });
        }
      } finally { focusRestoresPending--; }
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
    const parent = doc.outline.parentOf(range.anchor.id);
    const fieldEntry = mode === 'split' && definitionsById().has(fieldEntryId(doc.block(parent)?.text ?? '') ?? '') ? parent : null;
    apply({ kind: 'replaceRange', range, selectionBefore, between: visible.slice(1, -1), text, mode, zoomRoot: zoom(), fieldEntry }, true);
  }
  function deleteTextRange() { if (textRange()) replaceSelection('', 'text'); }
  function finishFoldMotion() {
    cancelAnimationFrame(foldFrame);
    const settle = settleFold;
    settleFold = undefined;
    for (const animation of foldAnimations) animation.cancel();
    foldAnimations = [];
    batch(() => { settle?.(); setFoldMotion(undefined); });
  }
  function fold(id = selected()) {
    if (!id || composition()) return;
    finishFoldMotion();
    const active = editing() ?? selected();
    if (!folds().has(id) && active && active !== id) {
      const at = doc.outline.indexOf(id);
      const child = doc.outline.indexOf(active);
      if (child > at && child < doc.outline.subtreeEnd(at)) rowFocus(id);
    }
    restoreFocus();
    const opening = folds().has(id);
    const change = () => setFolds(previous => { const next = new Set(previous); opening ? next.delete(id) : next.add(id); return next; });
    const style = getComputedStyle(scroll);
    const time = style.getPropertyValue('--motion-ui').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    const parentIndex = indices().get(id);
    if (reducedMotion.matches || !duration || parentIndex === undefined || !hosts.has(id)) {
      anchored(change); report(); scheduleReport();
      return;
    }
    const rootIndex = doc.outline.indexOf(id), subtreeEnd = doc.outline.subtreeEnd(rootIndex);
    const afterIds = [...virtualItems().keys()].filter(key => {
      const at = doc.outline.indexOf(key);
      return (indices().get(key) ?? 0) > parentIndex && (at <= rootIndex || at >= subtreeEnd);
    });
    const state = { id, opening, afterIds, beforeSize: virtualizer.getTotalSize() };
    const anchor = currentAnchor();
    settleFold = () => {
      if (!opening) change();
      restoreAnchor(anchor);
      report(); scheduleReport();
    };
    batch(() => { setFoldMotion(state); if (opening) change(); });
    // Retain only the rendered trailing rows while the newly visible children are measured.
    foldFrame = requestAnimationFrame(() => { foldFrame = requestAnimationFrame(() => {
      if (foldMotion() !== state || disposed) return;
      const parent = virtualItems().get(id);
      const children = foldGroups().children;
      if (!parent || !children.length) { finishFoldMotion(); return; }
      const top = parent.end - margin();
      const next = foldGroups().after[0];
      const bottom = next ? virtualItems().get(next)!.start - margin()
        : Math.max(...children.map(child => virtualItems().get(child)!.end - margin()));
      const height = Math.max(0, bottom - top);
      const size = virtualizer.getTotalSize();
      const clipped = `inset(${top}px 0 ${Math.max(0, size - top)}px 0)`;
      const revealed = `inset(${top}px 0 ${Math.max(0, size - top - height)}px 0)`;
      const shift = opening ? size - state.beforeSize : height;
      const timing: KeyframeAnimationOptions = { duration, easing: style.getPropertyValue('--motion-ease').trim(), fill: 'both' };
      const following = opening ? [{ transform: `translateY(${-shift}px)` }, { transform: 'translateY(0)' }]
        : [{ transform: 'translateY(0)' }, { transform: `translateY(${-shift}px)` }];
      foldAnimations = [
        foldChildren.animate(opening ? [{ clipPath: clipped, opacity: 0 }, { clipPath: revealed, opacity: 1 }]
          : [{ clipPath: revealed, opacity: 1 }, { clipPath: clipped, opacity: 0 }], timing),
        foldFollowing.animate(following, timing),
      ];
      // The editor's row stays mounted outside the motion groups; below the subtree its own group moves with them.
      const active = editing();
      if (active && state.afterIds.includes(active)) foldAnimations.push(foldEditor.animate(following, timing));
      // Closing near the end shortens the page, so the browser clamps scrollTop when the rows go. Slide the
      // page down by that clamp during the motion, or the settled rows snap down a frame after it ends.
      const clamp = opening ? 0 : Math.max(0, scroll.scrollTop - Math.max(0, scroll.scrollHeight - shift - scroll.clientHeight));
      if (clamp > 0) for (const child of scroll.children) foldAnimations.push(child.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${clamp}px)` }], timing));
      foldAnimations[0]!.id = 'outline-fold-content';
      foldAnimations[1]!.id = 'outline-fold-following';
      foldAnimations[0]!.onfinish = () => { if (foldMotion() === state) finishFoldMotion(); };
    }); });
  }
  function zoomTo(id: string | null) {
    if (composition()) return;
    finishFoldMotion();
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
    const before = caret();
    const epoch = focusEpoch;
    void (async () => {
      try {
        const field = definitionsByName().get(GLOSS_FIELD.toLowerCase()) ?? await ensureField(props.notebook, GLOSS_FIELD);
        if (disposed) return;
        setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]);
        const result = doc.edit({ kind: 'addFieldEntries', parentId: props.pageId, after: null, entries: [{ fieldId: field.id, value: '' }] }, before);
        if (!result.ok) { setMessage(result.reason); return; }
        if (result.caret && props.active && focusEpoch === epoch) editAt(result.caret.id, result.caret.offset, true, true, false);
      } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); }
    })();
  }
  /** Aliases are ordinary field values; a new one always opens for editing. */
  function addAlias() {
    void (async () => {
      try {
        const field = await ensureField(props.notebook, 'Aliases');
        setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]);
        if (disposed) return;
        if (zoom()) zoomTo(null);
        if (depth() !== 'full') setStop('full');
        const entry = doc.outline.children(props.pageId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === field.id);
        if (entry) setFolds(previous => { const next = new Set(previous); next.delete(entry); return next; });
        const result = entry
          ? doc.edit({ kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text: '' }, caret())
          : doc.edit({ kind: 'addFieldEntries', parentId: props.pageId, after: glossId(), entries: [{ fieldId: field.id, value: '' }] }, caret());
        if (!result.ok) { setMessage(result.reason); return; }
        if (result.caret) editAt(result.caret.id, result.caret.offset, true);
      } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); }
    })();
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
  function closeTitle() {
    focusEpoch++;
    focusRequest = null;
    batch(() => {
      setRenaming(false);
      setEditing(null);
      setCompletion(null);
      setTextRange(null);
      setMessage('');
    });
    props.onVimMode(props.vim ? 'outline' : null);
    if (props.active) scroll.focus({ preventScroll: true });
    scheduleReport();
  }
  function commitTitle() {
    const collision = titleCollision();
    if (collision && titleInput) {
      const reason = pageMergeDisabledReason(doc.root());
      if (reason) { setMessage(reason); return; }
      setMessage('');
      setMergeTarget({ page: collision, from: { id: props.pageId, text: doc.root()!.text }, anchor: titleInput });
      return;
    }
    const result = doc.rename(title());
    if (result.ok) closeTitle();
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
    restoreFocus,
    props,
    replaceSelection,
    fields,
    definitionsById,
    definitions,
    templateFor: templates.templateFor,
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
    addAlias,
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
    forgetReferenceSpace: (event) => forgetReferenceSpace(event),
    slashKey: (event) => slashKey(event),
    dateKey: (event) => dateKey(event),
    popupKey: (event) => popupKey(event),
    leaderMenu: (id) => leaderMenu(id),
    makeCloze: () => makeCloze(),
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
  const { setCompletion, setCompletionIndex, offerValue, updateCompletion, updateTriggers, taskPrefix, rewriteEditing, referenceInput, forgetReferenceSpace, slashKey, dateKey, popupKey, CompletionPopups } = createOutlineCompletions(context);
  const { openTable, investigationItems, commandDefinitions, unregister, blockMenu, statusMenu, priorityMenu, openPlanning, openProject, leaderMenu, makeCloze, referenceMenu, copy } = createOutlineCommands(context);
  const { horizontal, adjacent, split, editorKey, structuralKey, resetRowKey, resetVerticalGoal } = createOutlineKeyboard(context);
  const { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput } = createOutlineInteractions(context);
  const fieldSheet = createFieldSheet(context, { offerValue, onField: field => setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]) });
  const drag = createOutlineDrag(context);
  const { related, relatedError, apparatus, holders, linkedPages, Related, Backlinks, UnlinkedMentions, mentionsAvailable, ReferenceCount } = createOutlineRelated(context);
  const { Row, TaskSummary, QuestionSummary } = createOutlineRows(context, fieldSheet, drag, ReferenceCount);
  const { CapabilityPopups } = createCapabilityPopups(context);

  onMount(() => {
    const copy = (event: ClipboardEvent) => clipboard(event);
    const cut = (event: ClipboardEvent) => clipboard(event, true);
    scroll.addEventListener('copy', copy, true);
    scroll.addEventListener('cut', cut, true);
    const clearOutsideRows = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!scroll.contains(target) || target.closest('[data-block-id], button, input, [role="menu"], [role="dialog"]')) return;
      const belowRows = (target === scroll || target === list) && event.clientY >= list.getBoundingClientRect().bottom;
      if (event.button !== 0 || !belowRows || doc.status() !== 'ready' || depthFilter() !== undefined) { clearSelection(); return; }
      event.preventDefault();
      setTextRange(null);
      props.onActivate();
      const parentId = zoom() ?? props.pageId;
      const last = doc.outline.children(parentId).at(-1);
      if (last && doc.block(last)?.text === '' && !doc.isArchived(last) && doc.outline.children(last).length === 0) editAt(last, 0, true);
      else apply({ kind: 'insert', parentId, after: last ?? null }, true);
    };
    scroll.addEventListener('mousedown', clearOutsideRows);
    onCleanup(() => scroll.removeEventListener('mousedown', clearOutsideRows));
    document.addEventListener('pointerdown', resetVerticalGoal, true);
    onCleanup(() => document.removeEventListener('pointerdown', resetVerticalGoal, true));
    scroll.addEventListener('paste', paste, true);
    scroll.addEventListener('beforeinput', beforeInput, true);
    onCleanup(() => { scroll.removeEventListener('copy', copy, true); scroll.removeEventListener('cut', cut, true); scroll.removeEventListener('paste', paste, true); scroll.removeEventListener('beforeinput', beforeInput, true); cancelAnimationFrame(compositionFrame); });
    editor = new PaneEditor({
      key: editorKey,
      input: referenceInput,
      label: id => /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) ? props.notebook.lookup(id)()?.text : undefined,
      nameMatches: name => editingNames.error ? undefined : editingNames()?.get(foldName(name)),
      referenceMenu: (token, anchor) => {
        const matches = editingNames.error ? undefined : editingNames()?.get(foldName(token.id!));
        if (editor?.id && matches && matches.length > 1) setMenu({ anchor, label: 'Choose a page', header: <div class="menu-section">“{token.id}” names {matches.length} pages</div>, items: nameMenuItems(props.notebook, editor.id, token, matches, setMessage) });
      },
      blur: () => { if (editor?.id && editing() === editor.id) commitFieldEntry(editor.id, false); },
      text: (text, at) => measure('typing', () => {
        resetVerticalGoal();
        if (compositionSelection) return;
        const heading = headingPrefix(text, at.offset);
        if (heading && !composition()) {
          const result = doc.edit({ kind: 'text', id: at.id, text: heading.text, heading: heading.heading, caret: 0 }, caret());
          if (!result.ok) setMessage(result.reason);
          else {
            queueMicrotask(() => { if (editor?.id === at.id) { editor.sync(heading.text); editor.view.dispatch({ selection: { anchor: 0 } }); } });
            setCaret({ id: at.id, offset: 0 });
          }
          return;
        } else if (taskPrefix(text, at)) return;
        else { const result = doc.edit({ kind: 'text', id: at.id, text, caret: at.offset }, caret()); if (!result.ok) setMessage(result.reason); }
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
    if (doc.status() !== 'ready' || !sourceReady() || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      const saved = initial.caret;
      if (doc.root()?.kind !== 'journal') {
        const id = saved && doc.block(saved.id) && indices().has(saved.id) ? saved.id : null;
        if (id && initial.edit) {
          editAt(id, saved!.offset, !props.vim, !initial.scroll, true);
          scheduleReport();
          if (initial.scroll) restoreAnchor(initial.scroll);
          return;
        }
        setEditing(null);
        setSelected(id);
        setCaret(id ? { id, offset: id === saved?.id ? saved.offset : 0 } : null);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
        if (initial.scroll) restoreAnchor(initial.scroll);
        return;
      }
      if (journalPeriod) {
        setEditing(null); setSelected(null); setCaret(null);
        if (props.active) scroll.querySelector<HTMLButtonElement>('.journal-trail-segment[aria-expanded="true"]')?.focus({ preventScroll: true });
        scheduleReport();
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
      if (first && saved && !initial.edit) {
        setEditing(null);
        setSelected(first.id);
        setCaret(first);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
      } else if (first) editAt(first.id, first.offset, !props.vim, !initial.scroll, false);
      if (initial.scroll) restoreAnchor(initial.scroll);
    }
  });
  createEffect(() => {
    const id = editing(), text = id ? doc.block(id)?.text : undefined;
    if (text !== undefined && editor?.id === id) queueMicrotask(() => {
      if (editor?.id !== id) return;
      if (editor.view.state.doc.toString() !== text) resetVerticalGoal();
      editor.sync(text);
    });
  });
  createEffect(() => {
    const id = editing();
    const text = id ? doc.block(id)?.text : undefined;
    if (text === undefined) return;
    if (!editingNames.error) editingNames();
    for (const token of textTokens(text)) if (isStableReference(token)) props.notebook.lookup(token.id!)();
    queueMicrotask(() => { if (!disposed && editor?.id === id) editor.refreshLabels(); });
  });
  let previousVisible: string[] = [];
  createEffect(() => {
    if (!sourceReady()) return;
    const visible = ids(), before = previousVisible;
    previousVisible = visible;
    const id = editing() ?? selected();
    if (!id || visible.includes(id) || composition()) return;
    queueMicrotask(() => {
      if (disposed || composition() || focusRestoresPending || (editing() ?? selected()) !== id || indices().has(id)) return;
      selectSurvivor(id, before);
    });
  });
  createEffect(() => { storedFolds.set(`${props.pane}:${props.pageId}`, new Set(folds())); });
  onCleanup(() => {
    finishFoldMotion();
    reducedMotion.removeEventListener('change', finishFoldMotion);
    if (editing()) commitFieldEntry(editing()!, false);
    disposed = true;
    setLinkedCitation(null);
    unregister();
    doc.release();
    editor?.destroy();
    cancelAnimationFrame(reportingFrame);
    clearTimeout(scrollSettle);
    cancelScroll();
  });

  reducedMotion.addEventListener('change', finishFoldMotion);

  // A titled page at its top level wears the note header; sources keep their own, and the Fields page is not a note.
  const isNote = () => !zoom() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields';
  // Only rendered static rows change groups; the active editor stays mounted.
  const foldGroups = createMemo(() => {
    const all = [...virtualItems().keys()].filter(id => id !== editing()), state = foldMotion();
    const groups = { before: [] as typeof all, children: [] as typeof all, after: [] as typeof all };
    const start = state ? indices().get(state.id) : undefined;
    if (!state || start === undefined) { groups.before = all; return groups; }
    const root = doc.outline.indexOf(state.id), end = doc.outline.subtreeEnd(root);
    for (const id of all) {
      const index = indices().get(id) ?? 0;
      const at = doc.outline.indexOf(id);
      groups[index <= start ? 'before' : at > root && at < end ? 'children' : 'after'].push(id);
    }
    return groups;
  });
  return <div ref={scroll} class="outline-pane" classList={{ 'has-apparatus': apparatus(), 'has-sigla': sigla().size > 0, 'source-page': !!doc.root()?.source && !zoom(), 'outline-dragging': drag.dragging() }} style={{ visibility: sourceReady() ? undefined : 'hidden' }} aria-busy={!sourceReady()} data-pane={props.pane} tabIndex={0} role="tree" aria-label="Page outline" aria-owns={[...virtualItems().keys()].map(id => `outline-${props.pane}-${id}`).join(' ')} onFocusIn={props.onActivate} onFocusOut={report} onKeyDown={event => { finishFoldMotion(); structuralKey(event); }} onWheel={() => { finishFoldMotion(); cancelScroll(); }} onScroll={scrolled}>
    <Show when={apparatus()}><Apparatus notebook={props.notebook} holders={holders()} linked={linkedPages()} sources={citedSources().flatMap(id => sigla().has(id) ? [{ id, siglum: sigla().get(id)! }] : [])} onOpen={props.onOpen} /></Show>
    <Show when={sourceDetailsOpen() && doc.root()?.source}><SourceDetails notebook={props.notebook} pageId={props.pageId} onOpen={props.onOpen} onClose={() => setSourceDetailsOpen(false)} /></Show>
    <div ref={heading} class="outline-heading">
      <Show when={zoom()}><nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs"><button type="button" onClick={() => zoomTo(null)}>{doc.root()?.text}</button><For each={breadcrumbs()}>{id => <><Icon name="right" /><button type="button" onClick={() => zoomTo(id)}>{plainText(doc.block(id)?.text ?? '', reference => props.notebook.lookup(reference)) || 'Empty block'}</button></>}</For></nav></Show>
      <Show when={isNote()}><NoteEyebrow pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <Show when={!zoom() || !doc.root()?.source || renaming()}>
      <div class="outline-title-row">
      <Show when={renaming()} fallback={<h1><button class="outline-title" type="button" disabled={doc.root()?.kind !== 'page'} onClick={rename}>{doc.root()?.text || 'Loading…'}</button></h1>}>
        <input ref={titleInput} class="title-input" aria-label="Page title" value={title()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commitTitle(); } if (event.key === 'Escape') { event.preventDefault(); closeTitle(); } }} />
        <Show when={titleCollision()} fallback={<Button class="bordered" onClick={commitTitle}>Save title</Button>}>{page =>
          <Button class="bordered" disabled={!!pageMergeDisabledReason(doc.root())} title={pageMergeDisabledReason(doc.root())} onClick={event => { setMessage(''); setMergeTarget({ page: page(), from: { id: props.pageId, text: doc.root()!.text }, anchor: event.currentTarget }); }}>Merge into “{page().text}”</Button>
        }</Show><Button onClick={closeTitle}>Cancel</Button>
      </Show>
      <Show when={doc.root()?.kind === 'page' && !doc.root()?.source}><div class="outline-header-actions"><Button icon="table" label="Table" shortcut="⌘⇧T" onClick={event => openTable(event.metaKey)}>Table<Show when={!type.error && (type()?.members ?? 0) > 0}><span class="table-member-count">{type()?.members}</span></Show></Button></div></Show>
      </div>
      </Show>
      <Show when={isNote()}><NoteAliases doc={doc} notebook={props.notebook} /><NoteLine pageId={props.pageId} notebook={props.notebook} /></Show>
      <Show when={!zoom() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields' && !type.error && type()}>{value => <Show when={value().members || value().fields.length || startingTemplateFor(value().page.text, value().fields)}>
        <TemplateEditor type={value()} fields={definitions()} notebook={props.notebook} onError={setMessage} />
      </Show>}</Show>
      <Show when={doc.root()?.source}><SourceHeader doc={doc} notebook={props.notebook} resetItems={sourceResets} onOpen={props.onOpen} onError={setMessage} onDelete={props.onDelete}
        fields={definitions()} compact={!!zoom()} ready={sourceReady()} onReady={setSourceHeaderReady} onEditDetails={() => setSourceDetailsOpen(true)}
        highlights={zoom() || sourceHighlights.error ? undefined : sourceHighlights()} colors={sourceColors()} onColors={setSourceColors} grouped={sourceGrouped()} onGrouped={setSourceGrouped} fieldsVisible={sourceFieldsVisible()} onFieldsVisible={setSourceFieldsVisible} /></Show>
      <Show when={doc.root()?.templateCards}><CardSummary blockId={props.pageId} cards={[]} templateCount={doc.root()?.templateCards ?? 0} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <Show when={doc.root()?.task || doc.root()?.project || doc.root()?.question || doc.root()?.citations.length}><div class="outline-root-capabilities outline-capability-metadata">
        <Show when={doc.root()?.task}>
          <TaskStatusButton task={doc.root()?.task ?? null} disabled={capabilities.busy(props.pageId)} onRestoreFocus={restoreFocus} onChange={status => capabilities.status(props.pageId, status)} />
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
      <Show when={!zoom() && doc.root()?.kind === 'journal'}>
        <JournalHeader date={doc.root()!.text} journalPeriod={journalPeriod} notebook={props.notebook} onOpen={props.onOpen} />
      </Show>
      <fieldSheet.FieldSlots id={props.pageId} />
    </div>
    <div ref={list} class="outline-list" style={{ height: `${listHeight()}px` }}>
      <Show when={drag.indicator()}>{drop => <div class="outline-drop-indicator" aria-hidden="true" data-drop-depth={drop().depth - baseDepth()} data-drop-edge={drop().edge} style={{ top: `${drop().top}px`, left: `${drop().left}px` }} />}</Show>
      <For each={foldGroups().before}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      <div ref={foldChildren} class="outline-motion-group" style={{ opacity: foldMotion()?.opening ? 0 : undefined }}>
        <For each={foldGroups().children}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      </div>
      <div ref={foldFollowing} class="outline-motion-group" style={{ transform: foldMotion()?.opening ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)` : undefined }}>
        <For each={foldGroups().after}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      </div>
      <div ref={foldEditor} class="outline-motion-group" style={{ transform: foldMotion()?.opening && foldMotion()!.afterIds.includes(editing()!) ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)` : undefined }}>
        <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</Show>
      </div>
    </div>
    <Show when={doc.root()?.source && !zoom() && filedElsewhere().length}><section class="related-sections source-elsewhere" aria-label="Filed elsewhere">
      <h3 class="outline-highlights-label">Filed elsewhere <span>{filedElsewhere().length}</span></h3>
      <For each={filedElsewhere()}>{row => <Button class="library-highlight" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id }, event.shiftKey)}>
        <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} />
        <span class="library-highlight-meta">¶{row.citation.ordinal + 1} · {row.block.page.text}</span>
      </Button>}</For>
    </section></Show>
    <Show when={!zoom() && sourceHighlights.error}><p class="library-error" role="alert">{String(sourceHighlights.error)}</p></Show>
    <Show when={doc.root()?.source && fields.error}><p class="library-error" role="alert">{String(fields.error)}</p></Show>
    <Show when={doc.status() === 'ready' && ids().length === 0 && depthFilter() === undefined}><button type="button" class="add-first-block" onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}><Icon name="plus" />Add a block</button></Show>
    <Show when={!zoom() && doc.root()?.kind === 'journal'}><div class="related-sections journal-highlights"><JournalResurface date={doc.root()!.text} notebook={props.notebook} onOpen={props.onOpen} /></div></Show>
    <Show when={doc.status() === 'ready' && !zoom() && related()?.works.length}><PersonWorks pageId={props.pageId} rows={related()!.works} onOpen={props.onOpen} /></Show>
    <Show when={doc.status() === 'ready' && (mentionsAvailable() || relatedError() || (related()?.total ?? 0) + (related()?.tagged.length ?? 0) + (related()?.held.length ?? 0) + (related()?.about.length ?? 0) > 0)}><div class="related-sections">
      <Show when={related()?.held.length}><Related title="Perspectives held" rows={related()?.held ?? []} /></Show>
      <Show when={related()?.about.length}><Related title="Perspectives filed elsewhere" rows={related()?.about ?? []} /></Show>
      <Show when={relatedError() || related()?.total}><Backlinks /></Show>
      <Show when={mentionsAvailable()}><UnlinkedMentions /></Show>
      <Show when={relatedError() || related()?.tagged.length}><Related title="Tagged blocks" rows={relatedError() ? [] : related()?.tagged ?? []} /></Show>
    </div></Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.label} header={state.header} items={state.items} onDismiss={() => { setMenu(null); restoreFocus(); }} />}</Show>
    <Show keyed when={mergeTarget()}>{target => <PageMergeConfirmation anchor={target.anchor} notebook={props.notebook} from={target.from} into={target.page} onDismiss={() => setMergeTarget(undefined)} onMerged={id => { setMergeTarget(undefined); props.onOpen({ kind: 'page', pageId: id }, false); }} />}</Show>
    <CapabilityPopups />
    <CompletionPopups />
  </div>;
}
