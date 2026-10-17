import { batch, createEffect, createMemo, createResource, createSignal, For, Index, lazy, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { api } from '../api/client';
import type { Block, IndexKind, NoteKind, NotebookInfo, Shelf, Type, View } from '../api/types';
import { createNotebookClient, type Notebook } from '../document';
import type { NotebookClient, PageDocument } from '../document/contract';
import { titleKey } from '../document/title-key';
import { OutlinePane } from '../outline/OutlinePane';
import { plainText } from '../outline/names';
import { isReadingSubject, localPositionCount } from '../outline/read-register';
import { ReferencePreviews } from '../outline/ReferencePreview';
import { createPageIcon } from '../outline/source';
import { PageMergePicker, pageMergeDisabledReason } from '../outline/PageMerge';
import { copyTaskQuery, createTaskQuery } from '../tasks/query';
import { copyQuery, typeQuery } from '../table/query';
import { querySources } from '../table/attributes';
import { deskTarget } from '../desk/query';
import '../desk/desk.css';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup, type PopupAnchor } from '../ui/Popup';
import { createPaneMotion, navigatePane, paneTargetIdentity } from '../ui/pane-motion';
import { installTabRule } from '../ui/tab-rule';
import { createVisualViewport } from '../ui/visual-viewport';
import { pendingCaretInput } from './pending-caret';
import { Calendar } from './Calendar';
import { localDate } from '../ui/MonthGrid';
import { createCommandRegistry } from './commands';
import { deskCounts, shortDay } from './desk-counts';
import { depthLabels, depthStops } from './contract';
import type { AgendaViewState, Command, CommandRegistry, CompareViewState, Depth, FieldsViewState, FieldViewState, IndexViewState, LibraryViewState, OpenTarget, PaneId, ReaderViewState, ReviewViewState, SettingsViewState, TableViewState, ViewState } from './contract';
import type { PagePresentation, PageProjection } from './contract';
import { Palette } from './Palette';
import { DeletedPages } from './DeletedPages';
import { installOpenedFiles } from '../library/opened-files';
import { installQuickCapture } from './quick-capture';
import { opensBeside } from './beside';
import { besideSlot, dividerRatio, insertPane, MAX_PANES, paneCapacity, windowStart } from './pane-row';
import { blankCapture } from '../create/request';
import type { CreateRequest } from '../create/request';
import { CreateSlip, type CreateNotice } from '../create/CreateSlip';
import { creatableKinds, kindNoun } from '../create/kinds';
import { installLinkDrop } from '../create/link-drop';
import { SyncCover, SyncLifecycle, SyncMark, currentHealth } from '../sync/SyncStatus';
import { NotebookOpening, knownNotebooks, registerNotebookCommands } from '../settings/notebooks';
import { NotebookSwitcher } from '../settings/NotebookSwitcher';
import { indexKindTarget, noteIndex, noteKindIcon, tagOnly } from '../notes/kinds';
import { DEMO } from '../demo/mode';
import { AgentDock } from '../agent/AgentDock';
import type { ContextChip } from '../agent/AgentDock';
import { AgentMarks } from '../agent/marks';
import { createAgentSession } from '../agent/session';
import type { ContextRef } from '../api/types';

/** How long the deletion toast stays when nothing rests on it. */
const UNDO_TOAST_MS = 8000;

function HolderDeletionImpact(props: { notebook: NotebookClient; pageId: string | undefined }) {
  const [count] = createResource(() => props.pageId ? [props.pageId, props.notebook.changeSequence()] as const : false, async ([holder]) => {
    const result = await props.notebook.api.positions({ holder });
    return result.rows.filter(row => row.block.page.id !== holder).length;
  });
  return <div><Show when={count.error}><p class="muted">Could not load holder attribution impact.</p></Show><Show when={count()}>{total => <p class="muted">{total()} {total() === 1 ? 'perspective keeps' : 'perspectives keep'} this holder’s last-known name, marked Deleted holder. Use Change holder there to repair the attribution.</p>}</Show></div>;
}

// Panes other than the outline load on demand and are prefetched once the app is idle.
const paneModules = {
  table: () => import('../table/TablePane'),
  fields: () => import('../fields/FieldsPane'),
  field: () => import('../fields/FieldPane'),
  cards: () => import('../fields/CardTemplatesPane'),
  settings: () => import('../settings/SettingsPane'),
  agenda: () => import('../tasks/AgendaPane'),
  review: () => import('../review/ReviewPane'),
  library: () => import('../library/LibraryPane'),
  reader: () => import('../reader/ReaderPane'),
  compare: () => import('../compare/ComparePane'),
  index: () => import('../notes/IndexPane'),
  spread: () => import('../notes/SpreadPane'),
};
const TablePane = lazy(() => paneModules.table().then(module => ({ default: module.TablePane })));
const FieldsPane = lazy(() => paneModules.fields().then(module => ({ default: module.FieldsPane })));
const FieldPane = lazy(() => paneModules.field().then(module => ({ default: module.FieldPane })));
const CardTemplatesPane = lazy(() => paneModules.cards().then(module => ({ default: module.CardTemplatesPane })));
const SettingsPane = lazy(() => paneModules.settings().then(module => ({ default: module.SettingsPane })));
const AgendaPane = lazy(() => paneModules.agenda().then(module => ({ default: module.AgendaPane })));
const ReviewPane = lazy(() => paneModules.review().then(module => ({ default: module.ReviewPane })));
const LibraryPane = lazy(() => paneModules.library().then(module => ({ default: module.LibraryPane })));
const ReaderPane = lazy(() => paneModules.reader().then(module => ({ default: module.ReaderPane })));
const ComparePane = lazy(() => paneModules.compare().then(module => ({ default: module.ComparePane })));
const IndexPane = lazy(() => paneModules.index().then(module => ({ default: module.IndexPane })));
const SpreadPane = lazy(() => paneModules.spread().then(module => ({ default: module.SpreadPane })));

type PaneView = ViewState | TableViewState | FieldsViewState | FieldViewState | SettingsViewState | AgendaViewState | ReviewViewState | LibraryViewState | ReaderViewState | CompareViewState | IndexViewState;
type HistoryEntry = { target: OpenTarget; view: PaneView };
type PaneSession = { entries: HistoryEntry[]; index: number; generation: number };
type SavedNavigation = { pinned?: string[]; pinnedViews?: string[]; pagePresentations?: Record<string, PagePresentation>; pageStyles?: Record<string, 'bullets' | 'prose'>; recent?: string[]; vim?: boolean; panes?: Record<PaneId, HistoryEntry>; order?: PaneId[]; widths?: Record<PaneId, number>; active?: PaneId };
type VimMode = 'insert' | 'normal' | 'visual' | 'outline' | null;
/** A drop replaces a pane, or inserts a new one at a position in the row. */
type DropZone = { replace: PaneId } | { insert: number };
const vimLabels: Record<Exclude<VimMode, null>, string> = { insert: 'Insert', normal: 'Normal', visual: 'Visual', outline: 'Blocks' };
type PopupState = { kind: 'search' | 'commands' | 'calendar' | 'new-view' | 'delete' | 'restore-pages' | 'layout'; anchor: HTMLElement; pane: PaneId; date?: string; source?: boolean } | null;
const emptySession = (): PaneSession => ({ entries: [], index: -1, generation: 0 });
let paneSequence = 0;
const newPaneId = (): PaneId => `pane-${Date.now().toString(36)}-${++paneSequence}`;
/** Kinds that list things: a list fills the pane at its right and keeps focus, so the next row is one key away. */
const listKinds: Partial<Record<OpenTarget['kind'], true>> = { library: true, index: true, table: true };
/** What a modifier-click or a drag can open: links, buttons and rows. */
const OPENABLE = 'a[href], button, [role="button"], [role="link"], [role="option"], [role="tab"], [data-reference], [data-open-page]';
/** Index rows take ⌘ and Shift for selection, so holding the modifier there previews nothing. */
const SELECTING = '.index-selectable, .index-queue-row, .index-source-row, .library-checkbox';
/** ⌘ on Apple keyboards, where Ctrl+E stays the editor's end of line; Ctrl elsewhere. */
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_NOTICE_DELAY = 1000;
/** The Index's finding-aid heads, in order; spreads follow under their own head. */
const shelves: readonly (readonly [Shelf, string])[] = [['notes', 'Notes'], ['sources', 'Sources'], ['work', 'Work'], ['tags', 'Tags'], ['loose', 'Loose']];

/** Views are snapshots: fold arrays and caret/scroll objects never alias history. */
function copyView(view: ViewState): ViewState {
  return { ...view, folds: view.folds ? [...view.folds] : null, caret: view.caret ? { ...view.caret } : null, scroll: view.scroll ? { ...view.scroll } : null, readDisclosures: view.readDisclosures ? [...view.readDisclosures] : undefined, compare: view.compare ? { ...view.compare, chosen: view.compare.chosen ? [...view.compare.chosen] : view.compare.chosen } : undefined };
}

function pageIdOf(current: HistoryEntry | undefined): string | undefined {
  return current?.target.kind === 'page' ? current.target.pageId : undefined;
}
/** Header and tab text for panes that are not pages. */
function paneLabel(target: OpenTarget | undefined): string {
  if (target?.kind === 'field') return 'Fields / Definition';
  if (target?.kind === 'cards') return 'Cards';
  if (target?.kind === 'spread') return 'Spread';
  if (target?.kind === 'table' && target.query.layout === 'desk') return 'Research desk';
  return target?.kind === 'table' ? 'Table' : target?.kind === 'fields' ? 'Fields' : target?.kind === 'settings' ? 'Settings' : target?.kind === 'agenda' ? 'Agenda' : target?.kind === 'review' ? 'Review' : target?.kind === 'library' ? 'Library' : target?.kind === 'reader' ? 'Reader' : target?.kind === 'compare' ? 'Compare' : target?.kind === 'index' ? 'Index' : 'Loading…';
}
function snapshotView(view: PaneView): PaneView {
  if ('mode' in view) return { ...view, query: copyTaskQuery(view.query) };
  if ('deckId' in view) return { ...view, selection: view.selection ?? null };
  if ('comparison' in view) return { ...view, chosen: view.chosen ? [...view.chosen] : null };
  // Library views saved before Browse lack filters and grouping.
  if ('tab' in view) return { ...view, view: view.view ?? null, colors: [...view.colors ?? []], tags: [...view.tags ?? []], group: view.group ?? 'year', filters: { people: [...view.filters?.people ?? []], decades: [...view.filters?.decades ?? []], years: [...view.filters?.years ?? []], publishers: [...view.filters?.publishers ?? []], languages: [...view.filters?.languages ?? []] } };
  if ('ordinal' in view) return { ...view };
  if ('noteQuery' in view) return { ...view, noteQuery: view.noteQuery ? copyQuery(view.noteQuery) : undefined };
  return 'query' in view ? { ...view, query: copyQuery(view.query), hiddenFields: view.hiddenFields ? [...view.hiddenFields] : undefined } : 'zoom' in view ? copyView(view) : { scroll: view.scroll };
}
function targetFromView(entry: HistoryEntry): OpenTarget {
  const { target, view } = entry;
  if (target.kind === 'index' && 'noteQuery' in view) return { ...target, query: view.noteQuery ? copyQuery(view.noteQuery) : undefined, viewId: view.viewId };
  if (target.kind === 'table' && 'query' in view && !('mode' in view)) return { ...target, query: copyQuery(view.query), typeId: view.query.type };
  if (target.kind === 'agenda' && 'mode' in view) return { kind: 'agenda', date: view.date, mode: view.mode, viewId: view.viewId ?? undefined, query: copyTaskQuery(view.query) };
  if (target.kind === 'review' && 'deckId' in view) return { kind: 'review', deckId: view.deckId ?? undefined, queue: view.queue, revisitId: view.revisitId };
  if (target.kind === 'library' && 'tab' in view) return { kind: 'library', tab: view.tab };
  // A jump not yet performed (no position reported) survives a reload.
  if (target.kind === 'reader' && 'ordinal' in view) return view.ordinal < 0 ? { ...target, snapshotId: view.snapshotId ?? target.snapshotId } : { kind: 'reader', sourceId: target.sourceId, snapshotId: view.snapshotId ?? undefined };
  if (target.kind === 'page' && 'zoom' in view) return { kind: 'page', pageId: target.pageId, blockId: view.zoom ?? undefined };
  return target;
}

export function App(props: { onNotebook?(notebook: Notebook): void } = {}) {
  installTabRule();
  const identityKey = `tessera.identity.${location.origin}`;
  let cachedIdentity: NotebookInfo | undefined;
  try {
    const value = JSON.parse(localStorage.getItem(identityKey) ?? 'null') as NotebookInfo | null;
    if (value && typeof value.id === 'string' && typeof value.path === 'string') cachedIdentity = value;
  } catch { /* A first offline visit has no cached notebook identity. */ }
  const notebook = createNotebookClient({ notebookId: cachedIdentity?.id });
  onCleanup(() => { void notebook.dispose(); });
  props.onNotebook?.(notebook);
  const commands = createCommandRegistry();
  const [info] = createResource(async () => {
    try {
      const value = await api.notebook();
      try { localStorage.setItem(identityKey, JSON.stringify(value)); } catch { /* Drafts remain in IndexedDB even if this recovery hint cannot persist. */ }
      return value;
    } catch {
      return cachedIdentity;
    }
  });
  const [views, { refetch: refetchViews }] = createResource(() => notebook.connection() === 'live', async () => {
    try { return await api.views(); } catch (reason) { reportError(reason); return []; }
  });
  createEffect(() => { if ((notebook.lastChange()?.views ?? []).length) void refetchViews(); });
  const [sessions, setSessions] = createSignal<Record<PaneId, PaneSession>>({ main: emptySession() });
  /** The panes left to right; the first is 'main' until it closes. */
  const [order, setOrder] = createSignal<PaneId[]>(['main']);
  /** Relative widths from dragging dividers; a pane without one takes 1. */
  const [weights, setWeights] = createSignal<Record<PaneId, number>>({});
  const [active, setActive] = createSignal<PaneId>('main');
  const vim = notebook.vim;
  const [vimModes, setVimModes] = createSignal<Record<PaneId, VimMode>>({});
  const narrowQuery = window.matchMedia('(max-width: 1047px)');
  const [narrow, setNarrow] = createSignal(narrowQuery.matches);
  const [sidebar, setSidebar] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const sidebarVisible = () => narrow() ? sidebar() : !sidebarCollapsed();
  const toggleSidebar = () => {
    if (narrow()) setSidebar(value => !value);
    else setSidebarCollapsed(value => !value);
  };
  // Android resizes the WebView; browsers can resize only the visual viewport.
  const viewport = createVisualViewport();
  const keyboard = () => viewport().height < screen.height * 0.7;
  // Long-pressing Library in the bottom nav lists the types in use, each opening its table.
  const [typesMenu, setTypesMenu] = createSignal<{ anchor: HTMLElement; types: Type[] } | null>(null);
  const [questionsMenu, setQuestionsMenu] = createSignal<HTMLElement>();
  const showTypes = async (anchor: HTMLElement) => {
    try { setTypesMenu({ anchor, types: await api.types() }); } catch (reason) { reportError(reason); }
  };
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [pinned, setPinned] = createSignal<string[]>([]);
  const [pinnedViews, setPinnedViews] = createSignal<string[]>([]);
  // Device-local defaults for new page visits, and the Outline's shared bullet option.
  const [pagePresentations, setPagePresentations] = createSignal<Record<string, PagePresentation>>({});
  const [recent, setRecent] = createSignal<string[]>([]);
  const [navigationId, setNavigationId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [offlineUnavailable, setOfflineUnavailable] = createSignal(false);
  const [deleted, setDeleted] = createSignal<{ pages: { id: string; title: string }[]; label: string; reopen: boolean } | null>(null);
  const [retainedDeletions] = createResource(() => notebook.changeSequence(), () => notebook.api.deletedPages());
  const [deletionUndoSequence, setDeletionUndoSequence] = createSignal<number | null>(null);
  createEffect(() => {
    const sequence = deletionUndoSequence();
    if (sequence !== null && (notebook.changeSequence() !== sequence || notebook.saveState() !== 'saved')) setDeletionUndoSequence(null);
  });
  /** Notices share the deletion toast's lifetime and pause while hovered or focused. */
  const [toastShown, setToastShown] = createSignal(false);
  const [toastHeld, setToastHeld] = createSignal(false);
  const [notice, setNotice] = createSignal<CreateNotice>();
  const [noticeBusy, setNoticeBusy] = createSignal(false);
  const showNotice = (value: CreateNotice) => batch(() => { setNotice(value); setToastHeld(false); setToastShown(true); });
  const noticeAction = async (action: NonNullable<CreateNotice['actions']>[number]) => {
    if (noticeBusy()) return;
    const current = notice();
    setNoticeBusy(true);
    try { await action.run(); if (notice() === current) setToastShown(false); }
    catch (reason) { reportError(reason); }
    finally { setNoticeBusy(false); }
  };
  createEffect(() => {
    notice();
    if (!toastShown() || toastHeld()) return;
    const timer = setTimeout(() => setToastShown(false), UNDO_TOAST_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const todayDate = () => notebook.todayDate();
  const counts = deskCounts(notebook, todayDate);
  let searchButton!: HTMLButtonElement;
  const entry = (pane: PaneId) => { const session = sessions()[pane]; return session?.entries[session.index]; };
  const split = () => order().length > 1;
  const activeRoot = () => notebook.roots().find(root => root.id === pageIdOf(entry(active())));
  const journalDate = (pane: PaneId) => {
    if (pendingJournals[pane]) return pendingJournals[pane]!.date;
    const root = notebook.roots().find(root => root.id === pageIdOf(entry(pane)));
    return root?.kind === 'journal' ? root.text : todayDate();
  };
  const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const remember = (id: string) => setRecent(values => [id, ...values.filter(value => value !== id)].slice(0, 10));
  let focusEpoch = 0;
  const navigationRequests: Record<PaneId, number> = {};
  const pendingJournals: Partial<Record<PaneId, { date: string; controller: AbortController }>> = {};
  const cancelNavigation = (pane: PaneId) => {
    pendingJournals[pane]?.controller.abort();
    delete pendingJournals[pane];
    return navigationRequests[pane] = (navigationRequests[pane] ?? 0) + 1;
  };
  onCleanup(() => { pendingCaretInput.cancel(); for (const pane of order()) cancelNavigation(pane); });
  const focusPane = (pane: PaneId) => {
    const epoch = ++focusEpoch;
    requestAnimationFrame(() => {
      if (epoch !== focusEpoch) return;
      const root = document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"]`);
      if (!root) return;
      setActive(pane);
      const editor = root.querySelector<HTMLElement>('.cm-content');
      (editor?.getClientRects().length ? editor : root.querySelector<HTMLElement>('.review-card') ?? root.querySelector<HTMLElement>('.outline-pane, .table-pane, .research-desk, .fields-pane, .field-page-pane, .settings-pane, .agenda-pane, .review-pane'))?.focus({ preventScroll: true });
    });
  };
  /**
   * Opens `target` in `owner`, or beside it: in the pane right of `owner`, or in a new pane there. `insertAt` opens a
   * new pane at that position in the row instead, as a drop between panes does.
   */
  const open = (target: OpenTarget, beside = false, owner = active(), restore?: PaneView, insertAt?: number) => {
    const slot = insertAt !== undefined ? { index: insertAt, existing: null } : beside ? besideSlot(order(), owner) : { index: -1, existing: owner };
    const pane: PaneId = slot.existing ?? newPaneId();
    // Explicit editing requests activate their destination, even when a list reuses a folded neighbour.
    const keepFocus = beside && !!slot.existing && !(target.kind === 'page' && target.caretId) && !!listKinds[entry(owner)?.target.kind ?? 'page'];
    const request = cancelNavigation(pane);
    if (target.kind === 'page' && target.caretId) pendingCaretInput.begin(pane, target.caretId);
    else pendingCaretInput.cancel();
    if (target.kind === 'agenda' && target.viewId && !target.query) {
      void notebook.api.taskView(target.viewId).then(saved => {
        if (request === navigationRequests[pane]) open({ ...target, query: saved.query, date: target.date ?? saved.query.context_date }, beside, owner, restore, insertAt);
      }).catch(reason => { if (request === navigationRequests[pane]) reportError(reason); });
      return;
    }
    const current = entry(pane);
    if (target.kind === 'review' && current?.target.kind === 'review' && 'deckId' in current.view) {
      // A block request keeps the open review in place so the pane can ask before leaving it.
      const next = restore && 'deckId' in restore ? { ...restore } : target.blockId ? { ...current.view, queue: 'cards' as const, blockId: target.blockId } : { deckId: target.deckId ?? null, sessionId: null, selection: null, scroll: 0, queue: target.queue ?? 'cards', revisitId: target.revisitId };
      if (restore || target.blockId || target.queue || next.deckId !== current.view.deckId) changeView(pane, next);
      if (keepFocus) { setActive(owner); reveal(pane, owner); focusPane(owner); } else { setActive(pane); setSidebar(false); focusPane(pane); }
      return;
    }
    // Explicit caret, reading and journal ledger requests rebuild even when the same page is already open beside.
    const samePage = target.kind === 'page' && !target.caretId && !target.readAt && !target.editOcclusion && !target.journalPeriod && current?.target.kind === 'page' && current.target.pageId === target.pageId && 'zoom' in current.view && current.view.zoom === (target.blockId ?? null);
    if (!beside || !samePage) {
      const date = target.kind === 'agenda' ? target.date ?? target.query?.context_date ?? todayDate() : '';
      const view: PaneView = restore ? snapshotView(restore) : target.kind === 'table'
        ? { query: copyQuery(target.query), scroll: 0 }
        : target.kind === 'agenda' ? { date, mode: target.mode ?? (target.query || target.viewId ? 'tasks' : 'agenda'), query: { ...(target.query ? copyTaskQuery(target.query) : createTaskQuery(date)), context_date: date }, viewId: target.viewId ?? null, scroll: 0 }
          : target.kind === 'review' ? { deckId: target.deckId ?? null, sessionId: null, selection: null, scroll: 0, queue: target.queue ?? 'cards', revisitId: target.revisitId, ...(target.blockId ? { blockId: target.blockId } : {}) }
            : target.kind === 'index' ? { scroll: 0, noteQuery: target.query ? copyQuery(target.query) : undefined, viewId: target.viewId }
              : target.kind === 'fields' || target.kind === 'field' || target.kind === 'cards' || target.kind === 'settings' || target.kind === 'compare' || target.kind === 'spread' ? { scroll: 0 }
              : target.kind === 'library' ? { view: null, tab: target.tab ?? 'inbox', text: '', sort: 'added', filters: { people: [], decades: [], years: [], publishers: [], languages: [] }, group: 'year', unprocessedOnly: true, colors: [], tags: [], scroll: 0 }
                : target.kind === 'reader' ? { snapshotId: target.snapshotId ?? null, ordinal: -1, offset: 0 }
                  : target.readAt ? { zoom: null, caret: { id: target.readAt, offset: 0 }, scroll: { id: target.readAt, offset: 0 }, folds: null, showArchived: false, projection: 'read', reveal: target.readAt }
                    : { zoom: target.blockId ?? null, caret: target.caretId || target.blockId ? { id: target.caretId ?? target.blockId!, offset: target.caretOffset ?? 0 } : null, scroll: null, folds: null, showArchived: false, projection: target.caretId ? 'outline' : pagePresentations()[target.pageId]?.projection, ...(target.caretId ? { edit: true } : {}), ...(target.editOcclusion && target.blockId ? { editOcclusion: target.blockId } : {}) };
      // Editing needs its live caret now, not after the outgoing view-transition snapshot.
      const arriveAtTarget = () => {
        batch(() => {
          if (target.kind === 'page' && target.readAt) setPagePresentations(values => ({ ...values, [target.pageId]: { ...values[target.pageId], projection: 'read' } }));
          setSessions(values => {
            const previous = values[pane] ?? emptySession();
            const next = { entries: [...previous.entries.slice(0, previous.index + 1), { target, view }], index: previous.index + 1, generation: previous.generation + 1 };
            return { ...values, [pane]: next };
          });
          if (!slot.existing) {
            const placed = insertPane(order(), slot.index, pane);
            setOrder(placed.order);
            if (placed.closed) dropPane(placed.closed);
          }
        });
        arrive();
      };
      if (target.kind === 'page' && target.caretId) arriveAtTarget();
      else navigatePane(pane, 'forward', arriveAtTarget, target.kind === 'page' ? target.pageId : undefined);
    } else arrive();
    function arrive() {
      setSidebar(false);
      if (target.kind === 'page') remember(target.pageId);
      if (keepFocus) { setActive(owner); reveal(pane, owner); focusPane(owner); return; }
      setActive(pane); reveal(pane);
      // The outline owns explicit editing focus; a region focus while it loads would swallow buffered typing.
      if (target.kind === 'page' && target.caretId) ++focusEpoch;
      else focusPane(pane);
    }
  };
  const changeView = (pane: PaneId, view: PaneView, restore = false) => setSessions(values => {
    const session = values[pane]; const current = session?.entries[session.index]; if (!session || !current) return values;
    if ('zoom' in view && 'zoom' in current.view && view.zoom !== current.view.zoom) {
      const entries = [...session.entries.slice(0, session.index + 1), { target: current.target, view: copyView(view) }];
      return { ...values, [pane]: { entries, index: session.index + 1, generation: session.generation + (restore ? 1 : 0) } };
    }
    const entries = [...session.entries];
    entries[session.index] = { target: targetFromView({ target: current.target, view }), view: snapshotView(view) };
    return { ...values, [pane]: { ...session, entries, generation: session.generation + (restore ? 1 : 0) } };
  });
  const changeTarget = (pane: PaneId, target: OpenTarget) => setSessions(values => {
    const session = values[pane]; if (!session) return values; const entries = [...session.entries];
    entries[session.index] = { ...entries[session.index]!, target };
    return { ...values, [pane]: { ...session, entries } };
  });
  const travel = (pane: PaneId, delta: number) => {
    const session = sessions()[pane]; if (!session) return; const index = session.index + delta;
    if (index < 0 || index >= session.entries.length) return;
    pendingCaretInput.cancel();
    cancelNavigation(pane);
    navigatePane(pane, delta < 0 ? 'back' : 'forward', () => {
      // A second Back pressed before the first turn applied steps from where the first one lands.
      const latest = sessions()[pane]; if (!latest) return; const next = latest.index + delta;
      if (next < 0 || next >= latest.entries.length) return;
      setSessions(values => ({ ...values, [pane]: { ...latest, index: next, generation: latest.generation + 1 } }));
      setActive(pane); const pageId = pageIdOf(latest.entries[next]); if (pageId) remember(pageId);
      focusPane(pane);
    }, pageIdOf(session.entries[index]) ?? pageIdOf(session.entries[session.index]));
  };
  const journal = async (value: string | null, owner = active(), beside = false, journalPeriod?: Extract<OpenTarget, { kind: 'page' }>['journalPeriod']) => {
    const pane: PaneId = beside ? besideSlot(order(), owner).existing ?? `${owner}:beside` : owner;
    const request = cancelNavigation(pane);
    const controller = new AbortController();
    pendingJournals[pane] = { date: value ?? todayDate(), controller };
    try {
      const pageId = value === null ? await notebook.today(controller.signal) : await notebook.journal(value, controller.signal);
      if (request === navigationRequests[pane]) open({ kind: 'page', pageId, ...(journalPeriod ? { journalPeriod } : {}) }, beside, owner);
    } catch (reason) {
      if (request === navigationRequests[pane]) reportError(reason);
    } finally {
      if (request === navigationRequests[pane]) delete pendingJournals[pane];
    }
  };
  const today = (pane = active(), beside = false) => journal(null, pane, beside);
  const shiftDate = (delta: number, pane = active()) => { const next = new Date(`${journalDate(pane)}T12:00:00`); next.setDate(next.getDate() + delta); void journal(localDate(next), pane); };
  /** Moves focus to the next pane in the row, wrapping at its end. */
  const switchPane = () => {
    if (!split()) return;
    const panes = order();
    const pane = panes[(panes.indexOf(active()) + 1) % panes.length]!;
    setActive(pane); reveal(pane);
    focusPane(pane);
  };
  /** Forgets a pane that left the row. Its state goes after the row has unmounted it. */
  const dropPane = (pane: PaneId) => {
    cancelNavigation(pane);
    setOrder(values => values.filter(value => value !== pane));
    const without = <T,>(values: Record<PaneId, T>) => { const { [pane]: _, ...rest } = values; return rest; };
    queueMicrotask(() => batch(() => { setSessions(without); setWeights(without); setVimModes(without); }));
  };
  /** Closing a pane hands focus to the pane that was left of it, or right of it when it was first. */
  const closePane = (pane: PaneId) => {
    if (!split()) return;
    const panes = order(), at = panes.indexOf(pane);
    const next = panes[at > 0 ? at - 1 : 1]!;
    dropPane(pane);
    setActive(next); reveal(next);
    focusPane(next);
  };
  // Panes the window cannot fit fold into spines; `start` is the first pane shown. Below 840 px the row becomes tabs.
  const tabbedQuery = window.matchMedia('(max-width: 839px)');
  const [tabbed, setTabbed] = createSignal(tabbedQuery.matches);
  const [rowWidth, setRowWidth] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const fit = () => tabbed() ? order().length : paneCapacity(rowWidth(), order().length);
  const shown = (pane: PaneId) => { const at = order().indexOf(pane); return tabbed() || at >= start() && at < start() + fit(); };
  /** Scrolls the row so `pane` shows, then `keep` if it can stay in view too. */
  const reveal = (pane: PaneId, keep?: PaneId) => {
    const panes = order(), count = panes.length, width = fit();
    let next = windowStart(count, width, start(), panes.indexOf(pane));
    if (keep) next = windowStart(count, width, next, panes.indexOf(keep));
    setStart(next);
  };
  // A narrower window or a closed pane keeps the active pane in view.
  createEffect(() => { const panes = order(), width = fit(), at = panes.indexOf(active()); setStart(value => windowStart(panes.length, width, value, Math.max(0, at))); });
  // Full screen belongs to one reader pane. It ends when that pane shows something else or the other pane takes over.
  const [immersive, setImmersive] = createSignal<PaneId | null>(null);
  const [syncAnchor, setSyncAnchor] = createSignal<HTMLElement | null>(null);
  createEffect(() => { const pane = immersive(); if (pane && (active() !== pane || entry(pane)?.target.kind !== 'reader')) setImmersive(null); });
  const immerse = (pane: PaneId, on: boolean) => { if (on) setActive(pane); setImmersive(on ? pane : null); };
  // A history entry lets the system Back gesture (Android) or the browser's back button leave full screen.
  // Leaving another way pops that entry; `history.back()` lands later, so toggles in between wait for it.
  // Full screen is not restored after a reload, so its retained history entry must not remain a live marker.
  if (history.state?.tesseraImmersive) {
    const { tesseraImmersive: _, ...state } = history.state;
    history.replaceState(Object.keys(state).length ? state : null, '');
  }
  let popping = false;
  createEffect<PaneId | null>(previous => {
    const pane = immersive();
    if (popping) return pane;
    if (pane && !previous) history.pushState({ tesseraImmersive: true }, '');
    else if (!pane && previous && history.state?.tesseraImmersive) { popping = true; history.back(); }
    return pane;
  }, null);
  const historyMoved = () => {
    if (popping) { popping = false; if (immersive()) history.pushState({ tesseraImmersive: true }, ''); return; }
    if (!history.state?.tesseraImmersive) setImmersive(null);
  };
  window.addEventListener('popstate', historyMoved);
  onCleanup(() => window.removeEventListener('popstate', historyMoved));
  const pin = (id: string) => setPinned(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  const pinView = (id: string) => setPinnedViews(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  const openView = (view: View, beside = false) => open(view.query.note_kind && view.query.note_view?.layout === 'index' ? { kind: 'index', key: view.query.note_kind, viewId: view.id, query: copyQuery(view.query) } : { kind: 'table', typeId: view.query.type, viewId: view.id, query: copyQuery(view.query) }, beside);
  const showPalette = (kind: 'search' | 'commands') => setPopup({ kind, anchor: kind === 'search' ? searchButton : document.body, pane: active() });
  const chooseDate = (pane = active(), anchor: HTMLElement = document.querySelector<HTMLButtonElement>(`[data-pane="${pane}"] .journal-date`) ?? searchButton) => {
    setPopup({ kind: 'calendar', anchor, pane, date: journalDate(pane) });
  };
  const runOutline = (suffix: string, pane = active()) => commands.list().find(command => command.id === `outline.${pane}.${suffix}`)?.run();
  const reviewConflict = () => {
    const conflicted = notebook.conflictedPages();
    const pageId = conflicted.includes(pageIdOf(entry(active())) ?? '') ? pageIdOf(entry(active())) : conflicted[0];
    if (!pageId) return;
    const pane = order().find(owner => pageIdOf(entry(owner)) === pageId) ?? active();
    if (pageIdOf(entry(pane)) === pageId) setActive(pane);
    else open({ kind: 'page', pageId }, false, pane);
    requestAnimationFrame(() => runOutline('review-conflict', pane));
  };
  const openPageBeside = (pane = active()) => {
    const current = entry(pane);
    if (current) open(targetFromView(current), true, pane, current.view);
  };
  const deletePage = async (pane: PaneId) => {
    const pageId = pageIdOf(entry(pane)); if (!pageId) return;
    const title = notebook.lookup(pageId)()?.text ?? notebook.roots().find(block => block.id === pageId)?.text ?? 'Page';
    try { await deletePages([{ id: pageId, title }], undefined, true); setPopup(null); } catch (reason) { reportError(reason); }
  };
  /** Delete pages in one undoable step, and move panes showing them, or reading their sources, to another page. Undo reopens a page deleted from its own menu. */
  const deletePages = async (pages: { id: string; title: string }[], label = pages.length === 1 ? `“${pages[0]!.title}”` : `${pages.length} pages`, reopen = false) => {
    const ids = new Set(pages.map(page => page.id)), roots = notebook.roots(), done: typeof pages = [];
    try { for (const page of pages) { await notebook.deletePage(page.id); done.push(page); } }
    finally {
      if (done.length) {
        const message = `${done.length === pages.length ? label : `${done.length} pages`} deleted`;
        setDeleted({ pages: done, label: done.length === pages.length ? label : `${done.length} pages`, reopen });
        showNotice({ message, actions: [{ label: 'Undo', run: restorePage }] });
        const remaining = notebook.roots().find(block => !ids.has(block.id));
        const previousDay = new Date(`${todayDate()}T12:00:00`);
        previousDay.setDate(previousDay.getDate() - 1);
        const deletedToday = roots.some(root => ids.has(root.id) && root.kind === 'journal' && root.text === todayDate());
        // Do not recreate a deleted journal date: that would prevent restoring its IDs.
        const replacement = async () => remaining?.id ?? (deletedToday ? await notebook.journal(localDate(previousDay)) : await notebook.today());
        for (const owner of order()) {
          const current = entry(owner);
          if (ids.has(pageIdOf(current) ?? '') || current?.target.kind === 'reader' && ids.has(current.target.sourceId)) open({ kind: 'page', pageId: await replacement() }, false, owner);
        }
        setDeletionUndoSequence(notebook.changeSequence());
      }
    }
  };
  const restorePage = async () => {
    const latest = retainedDeletions.error ? undefined : retainedDeletions()?.[0]?.block;
    const value = deleted() ?? (latest ? { pages: [{ id: latest.id, title: latest.text }], label: `“${latest.text}”`, reopen: true } : null);
    if (!value) return;
    setDeletionUndoSequence(null);
    try {
      for (const page of value.pages) await notebook.restorePage(page.id);
      batch(() => { setDeleted(null); setToastShown(false); });
      if (value.reopen) open({ kind: 'page', pageId: value.pages[0]!.id });
    } catch (reason) { reportError(reason); }
  };
  const [creation, setCreation] = createSignal<{ request: CreateRequest; anchor?: PopupAnchor; pane: PaneId }>();
  const openCreate = (request: CreateRequest, anchor?: PopupAnchor) => { setPopup(null); setTypesMenu(null); setCreation({ request, anchor, pane: active() }); };
  /** Saving or Escape leaves focus where the slip opened from. */
  const closeCreate = () => {
    setCreation(undefined);
    queueMicrotask(() => { if (document.activeElement === document.body) focusPane(active()); });
  };
  onMount(() => {
    onCleanup(installLinkDrop(openCreate));
    const nativeOpen = (event: Event) => {
      const target = event instanceof CustomEvent ? event.detail : undefined;
      if (!target || target.kind !== 'page' || typeof target.pageId !== 'string'
        || target.caretId !== undefined && typeof target.caretId !== 'string'
        || target.blockId !== undefined && typeof target.blockId !== 'string') return;
      open({ kind: 'page', pageId: target.pageId, ...(target.caretId ? { caretId: target.caretId } : {}), ...(target.blockId ? { blockId: target.blockId } : {}), ...(typeof target.caretOffset === 'number' && Number.isFinite(target.caretOffset) ? { caretOffset: target.caretOffset } : {}) });
    };
    window.addEventListener('tessera-open', nativeOpen);
    onCleanup(() => window.removeEventListener('tessera-open', nativeOpen));
    const onNarrow = () => setNarrow(narrowQuery.matches);
    narrowQuery.addEventListener('change', onNarrow);
    onCleanup(() => narrowQuery.removeEventListener('change', onNarrow));
    const onTabbed = () => setTabbed(tabbedQuery.matches);
    tabbedQuery.addEventListener('change', onTabbed);
    onCleanup(() => tabbedQuery.removeEventListener('change', onTabbed));
    // Page deletion navigates away from its document. While it remains the
    // latest action, recover it before the replacement outline consumes Undo.
    const onPageUndo = (event: KeyboardEvent) => {
      if (event.isComposing || deletionUndoSequence() === null || !deleted()
        || !(mac ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey
        || event.key.toLocaleLowerCase() !== 'z'
        || document.querySelector('.popup:not(.reference-preview), .popup.reference-preview:focus-within')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void restorePage();
    };
    window.addEventListener('keydown', onPageUndo, true);
    onCleanup(() => window.removeEventListener('keydown', onPageUndo, true));
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('.popup:not(.reference-preview), .popup.reference-preview:focus-within')) return;
      // Native menu accelerators dispatch these commands themselves, including in full screen.
      if ((mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && (event.code === 'KeyN' || event.key.toLocaleLowerCase() === 'n')) {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) openCreate({ kind: event.altKey ? 'question' : 'note', text: '', into: { kind: 'page' } });
        return;
      }
      if ((mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLocaleLowerCase() === 'e') {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) openCreate(blankCapture());
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'h') travel(active(), -1);
      else if (key === 'l') travel(active(), 1);
      else if (key === 'f') showPalette('search');
      else if (key === 'p') showPalette('commands');
      else if (key === 'j') void today();
      else if (key === 'o') openPageBeside();
      else if (key === ']' || event.code === 'BracketRight') switchPane();
      else if (key === 'x') closePane(active());
      else return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
    // Prefetching after startup keeps first paint lean without delaying the first open of each pane.
    const prefetch = () => { for (const load of Object.values(paneModules)) void load().catch(() => undefined); };
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(prefetch, { timeout: 4000 }) : window.setTimeout(prefetch, 2000);
    onCleanup(() => { if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle); else clearTimeout(idle); });
  });
  let initializing = false;
  createEffect(() => {
    if (info.loading || initializing) return;
    initializing = true;
    const notebookInfo = info();
    void (async () => {
      if (!notebookInfo && !navigator.onLine) { setOfflineUnavailable(true); setError('Notebook unavailable offline · Open this notebook online once.'); return; }
      await notebook.ready;
      if (notebook.connection() === 'offline' && !notebook.roots().length) { setOfflineUnavailable(true); setError('Notebook unavailable offline · Open this notebook online once.'); return; }
      if (!notebookInfo) { await today(); return; }
      let stored: SavedNavigation = {};
      try { stored = JSON.parse(localStorage.getItem(`tessera.navigation.${notebookInfo.id}`) ?? '{}') ?? {}; } catch { /* Navigation preferences are optional; document durability is IndexedDB. */ }
      batch(() => {
        if (Array.isArray(stored.pinned)) setPinned(stored.pinned.filter(value => typeof value === 'string'));
        if (Array.isArray(stored.pinnedViews)) setPinnedViews(stored.pinnedViews.filter(value => typeof value === 'string'));
        if (stored.pagePresentations && typeof stored.pagePresentations === 'object') setPagePresentations(Object.fromEntries(Object.entries(stored.pagePresentations).filter(([, value]) => value && ['read', 'outline', 'compare', undefined].includes(value.projection)).map(([id, value]) => [id, { projection: value.projection, bullets: typeof value.bullets === 'boolean' ? value.bullets : undefined }])));
        else if (stored.pageStyles && typeof stored.pageStyles === 'object') setPagePresentations(Object.fromEntries(Object.entries(stored.pageStyles).filter(([, style]) => style === 'bullets' || style === 'prose').map(([id, style]) => [id, { bullets: style === 'bullets' }])));
        if (Array.isArray(stored.recent)) setRecent([...new Set(stored.recent)].filter(value => typeof value === 'string').slice(0, 10));
      });
      const restored: Record<PaneId, PaneSession> = {}, restoredOrder: PaneId[] = [];
      // Before the row, navigation saved two slots, `main` and `side`, without an order; their key order is the row.
      const savedOrder = Array.isArray(stored.order) ? stored.order.filter(value => typeof value === 'string') : Object.keys(stored.panes ?? {});
      for (const pane of savedOrder.slice(0, MAX_PANES)) {
        const saved = stored.panes?.[pane];
        if (!saved?.target || !saved.view) continue;
        let current: HistoryEntry;
        if (saved.target.kind === 'table' && 'query' in saved.view && !('mode' in saved.view)) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'agenda' && 'mode' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'review' && 'deckId' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if ((saved.target.kind === 'fields' || saved.target.kind === 'field' || saved.target.kind === 'cards' || saved.target.kind === 'settings' || saved.target.kind === 'compare' || saved.target.kind === 'index' || saved.target.kind === 'spread') && 'scroll' in saved.view && typeof saved.view.scroll === 'number') {
          current = { target: targetFromView(saved), view: saved.target.kind === 'compare' || saved.target.kind === 'index' ? snapshotView(saved.view) : { scroll: saved.view.scroll } };
        } else if ((saved.target.kind === 'library' && 'tab' in saved.view) || (saved.target.kind === 'reader' && 'ordinal' in saved.view)) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'page' && 'zoom' in saved.view) {
          const savedId = saved.target.pageId;
          const exists = notebook.roots().some(root => root.id === savedId);
          current = exists ? { target: targetFromView(saved), view: { ...copyView(saved.view), reveal: undefined } } : { target: { kind: 'page', pageId: await notebook.today() }, view: { zoom: null, caret: null, scroll: null, folds: null, showArchived: false } };
        } else continue;
        restored[pane] = { entries: [current], index: 0, generation: 1 };
        restoredOrder.push(pane);
      }
      if (restoredOrder.length) {
        const pane = stored.active && restored[stored.active] ? stored.active : restoredOrder[0]!;
        const widths = Object.fromEntries(Object.entries(stored.widths ?? {}).filter(([id, value]) => restored[id] && typeof value === 'number' && value > 0));
        batch(() => { setSessions(restored); setOrder(restoredOrder); setWeights(widths); setActive(pane); });
      } else await today();
      setNavigationId(notebookInfo.id);
    })().catch(reportError);
  });
  installOpenedFiles(() => navigationId() !== null, () => open({ kind: 'library', tab: 'inbox' }, false, order()[0]), reportError);
  // ⌘E, the desktop menu and global shortcut, and Android's launcher shortcuts and share sheet.
  installQuickCapture(() => navigationId() !== null, openCreate);
  // Caret and scroll reports change navigation on most keystrokes; storage writes trail them off the input path.
  let navigationWrite: { key: string; value: unknown } | null = null;
  let navigationTimer = 0;
  const writeNavigation = () => {
    clearTimeout(navigationTimer);
    const pending = navigationWrite; navigationWrite = null;
    if (pending) try { localStorage.setItem(pending.key, JSON.stringify(pending.value)); } catch { /* Storage-denied browsers keep preferences for this tab. */ }
  };
  window.addEventListener('pagehide', writeNavigation);
  onCleanup(() => { window.removeEventListener('pagehide', writeNavigation); writeNavigation(); });
  createEffect(() => {
    const id = navigationId(); if (!id) return;
    const panes: Record<PaneId, HistoryEntry> = {};
    for (const pane of order()) {
      const current = entry(pane);
      if (current) panes[pane] = current.target.kind === 'page' && 'zoom' in current.view
        ? { target: targetFromView(current), view: { ...copyView(current.view), reveal: undefined } } : current;
    }
    navigationWrite = { key: `tessera.navigation.${id}`, value: { pinned: pinned(), pinnedViews: pinnedViews(), pagePresentations: pagePresentations(), recent: recent(), vim: vim(), panes, order: order(), widths: weights(), active: active() } };
    clearTimeout(navigationTimer);
    navigationTimer = window.setTimeout(writeNavigation, 500);
  });
  const unregister = commands.register([
    { id: 'shell.search', title: 'Find or create', section: 'Navigation', keys: ['⌃⇧F'], run: () => showPalette('search') },
    { id: 'shell.commands', title: 'Show commands', section: 'Navigation', keys: ['⌃⇧P'], run: () => showPalette('commands') },
    { id: 'shell.settings', title: 'Open settings', section: 'Navigation', run: () => open({ kind: 'settings' }) },
    { id: 'shell.today', title: 'Open today’s journal', section: 'Navigation', keys: ['⌃⇧J'], run: () => { void today(); } },
    { id: 'shell.capture', title: 'Add to today', section: 'Create', keys: ['⌘E'], keywords: ['capture', 'quick note', 'inbox', 'journal'], run: () => openCreate(blankCapture()) },
    { id: 'shell.fields', title: 'Open fields', section: 'Navigation', run: () => open({ kind: 'fields' }) },
    { id: 'shell.agenda', title: 'Open agenda', section: 'Navigation', run: () => open({ kind: 'agenda', date: journalDate(active()) }) },
    { id: 'shell.review', title: 'Open review', section: 'Navigation', run: () => open({ kind: 'review' }) },
    { id: 'shell.library', title: 'Open library', section: 'Navigation', run: () => open({ kind: 'library' }) },
    { id: 'shell.research-desk', title: 'Open research desk', section: 'Navigation', run: (beside = false) => open(deskTarget(), beside) },
    { id: 'shell.import-book', title: 'Import book', section: 'Navigation', run: () => open({ kind: 'library', tab: 'inbox', add: true }) },
    { id: 'shell.previous-day', title: 'Previous journal day', section: 'Navigation', run: () => shiftDate(-1) },
    { id: 'shell.next-day', title: 'Next journal day', section: 'Navigation', run: () => shiftDate(1) },
    { id: 'shell.calendar', title: 'Choose journal date', section: 'Navigation', run: () => chooseDate() },
    { id: 'shell.back', title: 'Back', section: 'Navigation', keys: ['⌃⇧H'], disabledReason: () => (sessions()[active()]?.index ?? 0) <= 0 ? 'No earlier page in this pane' : undefined, run: () => travel(active(), -1) },
    { id: 'shell.forward', title: 'Forward', section: 'Navigation', keys: ['⌃⇧L'], disabledReason: () => { const session = sessions()[active()]; return !session || session.index >= session.entries.length - 1 ? 'No later page in this pane' : undefined; }, run: () => travel(active(), 1) },
    { id: 'shell.page-beside', title: 'Open active view beside', section: 'Navigation', keys: ['⌃⇧O'], run: () => openPageBeside() },
    { id: 'shell.switch', title: 'Next pane', section: 'View', keys: ['⌃⇧]'], disabledReason: () => !split() ? 'Open a second pane first' : undefined, run: switchPane },
    { id: 'shell.agent', title: 'Show or hide the agent', section: 'View', keys: ['⌃⇧A'], disabledReason: () => DEMO ? 'The agent needs the Tessera app' : undefined, run: () => toggleDock() },
    { id: 'shell.close', title: 'Close active pane', section: 'View', keys: ['⌃⇧X'], disabledReason: () => !split() ? 'Only one pane is open' : undefined, run: () => closePane(active()) },
    { id: 'shell.new', title: 'New page', section: 'Create', keys: document.documentElement.dataset.windowControls ? ['⌘N'] : undefined, keywords: ['page', 'note', 'create'], run: () => openCreate({ kind: 'note', text: '', into: { kind: 'page' } }) },
    { id: 'create.question', title: 'New question', section: 'Create', keys: ['⌥⌘N'], keywords: ['ask', 'inquiry'], run: () => openCreate({ kind: 'question', text: '' }) },
    { id: 'create.project', title: 'New project', section: 'Create', run: () => openCreate({ kind: 'project', text: '' }) },
    { id: 'create.task', title: 'New task', section: 'Create', keywords: ['todo'], run: () => openCreate({ kind: 'task', text: '', into: { kind: 'journal' } }) },
    { id: 'create.card', title: 'New card', section: 'Create', keywords: ['flashcard', 'review'], run: () => openCreate({ kind: 'card', text: '', into: { kind: 'journal' } }) },
    { id: 'create.source', title: 'Add source', section: 'Create', keywords: ['book', 'article', 'paper', 'library', 'import', 'isbn'], run: () => openCreate({ kind: 'source', text: '' }) },
    { id: 'shell.new-spread', title: 'New spread', section: 'Page', run: (beside = false) => open({ kind: 'spread', noteIds: [] }, beside) },
    { id: 'shell.new-view', title: 'New view…', section: 'View', run: () => setPopup({ kind: 'new-view', anchor: searchButton, pane: active() }) },
    { id: 'shell.pin', title: 'Pin / unpin page', section: 'Page', run: () => { const root = activeRoot(); if (root) pin(root.id); } },
    { id: 'shell.delete', title: 'Delete page', section: 'Page', run: () => { const anchor = document.querySelector<HTMLButtonElement>(`[data-pane="${active()}"] .page-menu-button`); if (anchor) setPopup({ kind: 'delete', anchor, pane: active() }); } },
    { id: 'shell.restore-page', title: 'Undo page deletion', section: 'Page', disabledReason: () => deleted() ? undefined : retainedDeletions.error ? 'Could not read deleted pages' : retainedDeletions.loading ? 'Loading deleted pages…' : retainedDeletions()?.length ? undefined : 'No deleted page to restore', run: () => { void restorePage(); } },
    { id: 'shell.deleted-pages', title: 'Restore deleted page…', section: 'Page', run: () => setPopup({ kind: 'restore-pages', anchor: searchButton, pane: active() }) },
    { id: 'shell.review-conflict', title: 'Review notebook conflict', section: 'Editing', disabledReason: () => notebook.conflictedPages().length ? undefined : 'No conflicting blocks', run: reviewConflict },
    { id: 'shell.retry', title: 'Retry saving', section: 'Editing', disabledReason: () => notebook.saveState() === 'saved' && notebook.connection() === 'live' ? 'All changes are saved' : undefined, run: () => notebook.retry() },
    { id: 'shell.copy-unsaved', title: 'Copy unsaved text', section: 'Editing', disabledReason: () => notebook.localPersistence() === 'failed' || notebook.rejectedText() ? undefined : 'Local recovery storage is working', run: () => { void navigator.clipboard.writeText(notebook.rejectedText() || notebook.unsavedText()).catch(reportError); } },
    { id: 'shell.dismiss-rejected', title: 'Dismiss rejected changes', section: 'Editing', disabledReason: () => notebook.rejectedText() ? undefined : 'No rejected changes', run: () => notebook.dismissRejected() },
    { id: 'shell.sidebar', title: 'Toggle sidebar', section: 'View', run: toggleSidebar },
  ]);
  onCleanup(unregister);
  onMount(() => {
    // The native window and installed browser window share the shell's command registry.
    if (!DEMO && !document.documentElement.dataset.windowControls) return;
    const onCommand = (event: Event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (typeof id !== 'string') return;
      const command = commands.list().find(command => command.id === id);
      if (!command || command.disabledReason?.()) return;
      setPopup(null); setTypesMenu(null);
      command.run();
    };
    window.addEventListener('tessera-command', onCommand);
    onCleanup(() => window.removeEventListener('tessera-command', onCommand));
  });
  createEffect(() => {
    const unregisterViews = commands.register((views() ?? []).map(view => ({
      id: `shell.view.${view.id}`, title: `Open view: ${view.name}`, section: 'Navigation' as const,
      run: () => openView(view),
    })));
    onCleanup(unregisterViews);
  });
  createEffect(() => {
    onCleanup(commands.register(creatableKinds(index()?.kinds ?? []).map(kind => ({
      id: `create.type:${kind.key}`, title: `New ${kindNoun(kind)}`, section: 'Create' as const,
      run: () => openCreate({ kind: `type:${kind.key}`, text: '', lockKind: true }),
    }))));
  });
  registerNotebookCommands(commands, notebook, reportError);
  const rootById = createMemo(() => new Map(notebook.roots().map(root => [root.id, root])));
  const pinnedRoots = () => pinned().map(id => rootById().get(id)).filter((root): root is Block => !!root);
  const recentRoots = () => recent().filter(id => !pinned().includes(id)).map(id => rootById().get(id)).filter((root): root is Block => !!root).slice(0, 10);
  const pinnedViewList = createMemo(() => (views() ?? []).filter(view => pinnedViews().includes(view.id)));
  const otherViews = createMemo(() => (views() ?? []).filter(view => !pinnedViews().includes(view.id)));
  const index = noteIndex(notebook);
  const [destinationTypes] = createResource(() => notebook.changeSequence(), () => notebook.api.types());
  const goToCommand = (id: string, title: string, action: (beside: boolean, pane: PaneId) => void): Command => ({
    id: `shell.go-to.${id}`, title, section: 'Go to',
    run: (beside = false) => action(beside, active()),
    capture: () => {
      const pane = active();
      return { id: `shell.go-to.${id}`, title, section: 'Go to', run: (beside = false) => action(beside, pane) };
    },
  });
  createEffect(() => {
    const destinations: Command[] = [
      goToCommand('highlights', 'Highlights', (beside, pane) => open({ kind: 'library', tab: 'highlights' }, beside, pane)),
      goToCommand('unfiled', 'Unfiled', (beside, pane) => open({ kind: 'index', key: 'unfiled' }, beside, pane)),
      goToCommand('sources', 'Sources', (beside, pane) => open({ kind: 'index', key: 'source' }, beside, pane)),
      goToCommand('agenda-week', 'Agenda week', (beside, pane) => open({ kind: 'agenda', date: todayDate(), mode: 'week' }, beside, pane)),
      goToCommand('agenda-tasks', 'Agenda tasks', (beside, pane) => open({ kind: 'agenda', date: todayDate(), mode: 'tasks' }, beside, pane)),
      ...(['week', 'month', 'quarter', 'year'] as const).map(period => goToCommand(period, `This ${period}`, (beside, pane) => {
        void journal(null, pane, beside, period);
      })),
    ];
    for (const type of index() ? destinationTypes() ?? [] : []) {
      const key = index()!.kinds.find(kind => kind.type_id === type.page.id)?.key ?? `type:${type.page.id}`;
      destinations.push(
        goToCommand(`index.${type.page.id}`, `${type.page.text} index`, (beside, pane) => open({ kind: 'index', key }, beside, pane)),
        goToCommand(`table.${type.page.id}`, `${type.page.text} table`, (beside, pane) => open({ kind: 'table', typeId: type.page.id, viewId: null, query: typeQuery(type.page.id) }, beside, pane)),
      );
    }
    onCleanup(commands.register(destinations));
  });
  // Saved views sit under the kind whose type they list; views of any other type keep their own section.
  const viewInKind = (view: View, kind: NoteKind) => view.query.note_kind ? view.query.note_kind === kind.key : kind.type_id !== null && kind.type_id === view.query.type;
  const looseViews = createMemo(() => otherViews().filter(view => !index()?.kinds.some(kind => viewInKind(view, kind))));
  // A kind with notes, tagged blocks or saved views keeps its row on its shelf; an empty one folds into the Empty line.
  const listedKind = (kind: IndexKind) => !!(kind.count || kind.tagged_block_count) || otherViews().some(view => viewInKind(view, kind));
  const shelfKinds = createMemo(() => {
    const shelved: Partial<Record<Shelf, IndexKind[]>> = {};
    for (const kind of index()?.kinds ?? []) if (listedKind(kind)) (shelved[kind.shelf] ??= []).push(kind);
    return shelved;
  });
  const emptyKinds = createMemo(() => (index()?.kinds ?? []).filter(kind => !listedKind(kind)));
  const activeViewId = () => { const target = entry(active())?.target; return target?.kind === 'table' || target?.kind === 'index' ? target.viewId ?? undefined : undefined; };
  const activeTypeId = () => { const target = entry(active())?.target; return target?.kind === 'table' && !target.viewId ? target.typeId : null; };
  const activeKindKey = () => { const target = entry(active())?.target; return target?.kind === 'index' ? target.key : (target?.kind === 'fields' || target?.kind === 'cards') && target.typeId ? index()?.kinds.find(kind => kind.type_id === target.typeId)?.key : undefined; };
  /** The note kind a pane shows: its index, or the type behind its fields or cards. */
  const indexKind = (pane: PaneId) => { const target = entry(pane)?.target; return target?.kind === 'index' ? index()?.kinds.find(kind => kind.key === target.key) : (target?.kind === 'fields' || target?.kind === 'cards') && target.typeId ? index()?.kinds.find(kind => kind.type_id === target.typeId) : undefined; };
  // A table pane is named for its saved view, else its type, and an index pane for its kind, rather than the generic label.
  const paneTitle = (pane: PaneId) => {
    const target = entry(pane)?.target;
    if (target?.kind === 'field') return `Fields / ${notebook.lookup(target.fieldId)()?.text ?? 'Definition'}`;
    if (target?.kind === 'index') return views()?.find(view => view.id === target.viewId)?.name ?? indexKind(pane)?.plural;
    if (target?.kind === 'fields' && target.typeId) return rootById().get(target.typeId)?.text;
    if (target?.kind === 'cards') return `${rootById().get(target.typeId)?.text ?? 'Type'} / Cards${target.applyId ? ' / Apply' : ''}`;
    if (target?.kind !== 'table') return undefined;
    return (views() ?? []).find(view => view.id === target.viewId)?.name ?? rootById().get(target.typeId ?? '')?.text;
  };
  // Sidebar sections carry rubric numerals counted over the sections actually shown.
  const sectionNumber = (section: 'pinned' | 'index' | 'views' | 'recent') => {
    const shown = [...pinnedRoots().length || pinnedViewList().length ? ['pinned'] : [], ...index()?.kinds.length ? ['index'] : [], 'views', 'recent'];
    return String(shown.indexOf(section) + 1).padStart(2, '0');
  };
  const paneName = (pane: PaneId) => rootById().get(pageIdOf(entry(pane)) ?? '')?.text ?? paneTitle(pane) ?? paneLabel(entry(pane)?.target);
  // Where a click or a drop will open shows before it happens: a gilt frame over the pane it replaces, or a hatched
  // ghost where a new pane will stand. Holding the beside modifier over something openable shows it for a click.
  let paneRow!: HTMLDivElement;
  const [guide, setGuide] = createSignal<{ left: number; width: number; label: string; fresh: boolean } | null>(null);
  const [dragChip, setDragChip] = createSignal<{ x: number; y: number; label: string } | null>(null);
  onMount(() => {
    const observer = new ResizeObserver(([item]) => setRowWidth(item!.contentRect.width));
    observer.observe(paneRow);
    onCleanup(() => observer.disconnect());
  });
  const rowChild = (selector: string) => paneRow.querySelector<HTMLElement>(`:scope > ${selector}`);
  /** A new pane at `index` would add a pane, fold one into a spine, or close the one farthest from it. */
  const newPaneLabel = (index: number) => {
    const placed = insertPane(order(), index, '');
    const closed = placed.closed ? ` · pane ${order().indexOf(placed.closed) + 1} closes` : paneCapacity(rowWidth(), placed.order.length) < placed.order.length ? ' · one folds aside' : '';
    return `New pane ${index + 1}${closed}`;
  };
  /** The guide over `existing` (its spine when folded), or a ghost of a new pane at `index`. */
  const guideAt = (index: number, existing: PaneId | null, label: string) => {
    const row = paneRow.getBoundingClientRect();
    const element = existing && (rowChild(`.pane[data-pane="${CSS.escape(existing)}"]:not(.folded)`) ?? rowChild(`.pane-spine[data-spine="${CSS.escape(existing)}"]`));
    if (element) { const rect = element.getBoundingClientRect(); return { left: rect.left - row.left, width: rect.width, label, fresh: false }; }
    const width = row.width / (Math.min(fit(), order().length) + 1);
    const next = order()[index];
    const edge = next ? (rowChild(`.pane[data-pane="${CSS.escape(next)}"]:not(.folded)`) ?? rowChild(`.pane-spine[data-spine="${CSS.escape(next)}"]`))?.getBoundingClientRect().left : undefined;
    const left = edge === undefined ? row.width - width : Math.max(0, Math.min(row.width - width, edge - row.left - width / 2));
    return { left, width, label, fresh: true };
  };
  /** The pane a drop at (x, y) replaces, or the position a new pane takes when it lands on a pane's edge. */
  const dropAt = (x: number, y: number): DropZone | null => {
    if (tabbed()) return null;
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('.panes > .pane, .panes > .pane-spine');
    if (!element || element.parentElement !== paneRow) return null;
    const pane = element.dataset.pane ?? element.dataset.spine!;
    if (element.classList.contains('pane-spine')) return { replace: pane };
    const rect = element.getBoundingClientRect(), at = order().indexOf(pane), edge = Math.min(64, rect.width / 6);
    if (x < rect.left + edge) return { insert: at };
    if (x > rect.right - edge) return { insert: at + 1 };
    return { replace: pane };
  };
  const guideForDrop = (zone: DropZone) => 'replace' in zone
    ? guideAt(order().indexOf(zone.replace), zone.replace, `Open in pane ${order().indexOf(zone.replace) + 1}`)
    : guideAt(zone.insert, null, newPaneLabel(zone.insert));
  /** What a dragged row or reference opens: `data-open-page` (with `data-open-block`) or a rendered reference. */
  const dragTarget = (element: Element): { target: OpenTarget; label: string } | null => {
    const row = element.closest<HTMLElement>('[data-open-page]');
    if (row) return { target: { kind: 'page', pageId: row.dataset.openPage!, ...(row.dataset.openBlock ? { blockId: row.dataset.openBlock } : {}) }, label: row.dataset.openLabel ?? row.textContent?.trim() ?? '' };
    const reference = element.closest<HTMLElement>('.outline-reference[data-reference]');
    const block = reference && notebook.lookup(reference.dataset.reference!)();
    if (!reference || !block) return null;
    return { target: block.id === block.page_id ? { kind: 'page', pageId: block.id } : { kind: 'page', pageId: block.page_id, blockId: block.id }, label: reference.textContent?.trim() ?? '' };
  };
  onMount(() => {
    const modifier = mac ? 'Meta' : 'Control';
    let pointer: { x: number; y: number } | null = null, held = false, holdTimer = 0;
    let drag: { x: number; y: number; target: OpenTarget; label: string; moving: boolean } | null = null;
    const previewBeside = () => {
      if (!held || !pointer || drag?.moving || tabbed()) { if (!drag?.moving) setGuide(null); return; }
      const hit = document.elementFromPoint(pointer.x, pointer.y);
      // A pane's view transition covers the page and answers every hit test; look again once it has passed.
      if (hit === document.documentElement) { requestAnimationFrame(previewBeside); return; }
      const openable = hit?.closest(OPENABLE);
      const owner = openable && !openable.closest(`${SELECTING}, .global-rail, .pane-tabs, .panes > .pane-spine`)
        ? openable.closest<HTMLElement>('.panes > .pane')?.dataset.pane ?? (openable.closest('.sidebar') ? active() : undefined) : undefined;
      if (!owner) { setGuide(null); return; }
      const slot = besideSlot(order(), owner);
      setGuide(guideAt(slot.index, slot.existing, slot.existing ? `Opens in pane ${slot.index + 1}` : newPaneLabel(slot.index)));
    };
    const release = () => { clearTimeout(holdTimer); held = false; if (!drag?.moving) setGuide(null); };
    const keydown = (event: KeyboardEvent) => {
      if (drag?.moving && event.key === 'Escape') { event.preventDefault(); endDrag(); return; }
      if (event.key !== modifier || event.repeat) { release(); return; }
      if (event.shiftKey || event.altKey) return;
      clearTimeout(holdTimer);
      // A shortcut presses its letter within a moment; only a held modifier previews.
      holdTimer = window.setTimeout(() => { held = true; previewBeside(); }, 180);
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === modifier) release(); };
    const endDrag = () => {
      drag = null;
      document.documentElement.classList.remove('pane-dragging');
      document.querySelector('.agent-dock')?.classList.remove('drop-target');
      batch(() => { setGuide(null); setDragChip(null); });
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest('.cm-editor, input, textarea, [contenteditable="true"], .popup')) return;
      const found = dragTarget(element);
      drag = found ? { x: event.clientX, y: event.clientY, ...found, moving: false } : null;
    };
    const pointermove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!drag) { if (held) previewBeside(); return; }
      if (!drag.moving) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moving = true;
        document.documentElement.classList.add('pane-dragging');
        getSelection()?.removeAllRanges();
      }
      // Over the agent dock a drop adds the page to what the agent reads.
      const overDock = !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.agent-dock');
      document.querySelector('.agent-dock')?.classList.toggle('drop-target', overDock);
      const zone = overDock ? null : dropAt(event.clientX, event.clientY);
      batch(() => { setDragChip({ x: event.clientX, y: event.clientY, label: drag!.label }); setGuide(zone ? guideForDrop(zone) : null); });
    };
    const pointerup = (event: PointerEvent) => {
      if (!drag) return;
      const moved = drag.moving, target = drag.target, label = drag.label, zone = moved ? dropAt(event.clientX, event.clientY) : null;
      const toDock = moved && !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.agent-dock');
      endDrag();
      if (!moved) return;
      // The press that ends a drag is not also a click on whatever lies under it.
      const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }));
      if (toDock && target.kind === 'page') addDockContext({ page_id: target.pageId, ...(target.blockId ? { block_id: target.blockId } : {}) }, label);
      if (!zone) return;
      if ('replace' in zone) open(target, false, zone.replace);
      else open(target, false, active(), undefined, zone.insert);
    };
    // After a modifier-click the row may have changed under a still-held modifier.
    const click = () => { if (held) requestAnimationFrame(previewBeside); };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', release);
    window.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('pointermove', pointermove, { passive: true });
    window.addEventListener('pointerup', pointerup, true);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('click', click);
    onCleanup(() => {
      clearTimeout(holdTimer);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', release);
      window.removeEventListener('pointerdown', pointerdown, true);
      window.removeEventListener('pointermove', pointermove);
      window.removeEventListener('pointerup', pointerup, true);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('click', click);
    });
  });
  // The agent dock: its thread, the pages it reads (the panes in view, less any left out, plus dropped links) and
  // the rows it changed, which outline rows mark through AgentMarks.
  const agentSession = createAgentSession(() => navigationId() ?? undefined);
  const agentMarks = { mark: (id: string) => agentSession.marks().get(id), undo: (seq: number) => agentSession.undo(seq) };
  const [dock, setDock] = createSignal(!DEMO && localStorage.getItem('tessera.agent.dock') === 'open');
  function toggleDock(show = !dock()) {
    if (DEMO) return;
    setDock(show);
    try { localStorage.setItem('tessera.agent.dock', show ? 'open' : 'closed'); } catch { /* The dock keeps its state for this tab. */ }
  }
  const [dockExcluded, setDockExcluded] = createSignal<ReadonlySet<string>>(new Set());
  const [dockExtra, setDockExtra] = createSignal<ContextChip[]>([]);
  const contextKey = (ref: ContextRef) => `${ref.page_id}:${ref.block_id ?? ''}`;
  function addDockContext(ref: ContextRef, title: string) {
    const key = contextKey(ref);
    setDockExtra(values => values.some(chip => chip.key === key) ? values : [...values, { key, ref, title, extra: true }]);
    setDockExcluded(values => { const next = new Set(values); next.delete(key); return next; });
  }
  const dockChips = createMemo(() => {
    const chips: ContextChip[] = [];
    for (const pane of order()) {
      if (tabbed() ? pane !== active() : !shown(pane)) continue;
      const current = entry(pane); const target = current?.target;
      const pageId = target?.kind === 'page' ? target.pageId : target?.kind === 'reader' ? target.sourceId : undefined;
      if (!pageId || !current) continue;
      const zoom = target?.kind === 'page' && 'zoom' in current.view ? current.view.zoom : null;
      const ref: ContextRef = zoom ? { page_id: pageId, block_id: zoom } : { page_id: pageId };
      chips.push({ key: contextKey(ref), ref, title: paneName(pane), extra: false });
    }
    return [...chips, ...dockExtra()].filter((chip, index, all) => all.findIndex(other => other.key === chip.key) === index);
  });
  /** Brings an agent change into view: the pane showing its page, scrolled to the block, or that page opened beside. */
  function showAgentEdit(pageId: string, blockId?: string) {
    const pane = order().find(value => pageIdOf(entry(value)) === pageId);
    const at = blockId ? { scroll: { id: blockId, offset: 0 }, reveal: blockId } : {};
    if (pane) {
      const view = entry(pane)!.view as ViewState;
      setActive(pane); reveal(pane);
      if (blockId) changeView(pane, { ...view, ...at }, true);
      focusPane(pane);
    } else open({ kind: 'page', pageId }, true, active(), blockId ? { zoom: null, caret: null, folds: null, showArchived: false, ...at } as ViewState : undefined);
    if (!blockId) return;
    let frames = 0;
    const flash = () => {
      const row = document.querySelector<HTMLElement>(`.panes > .pane [data-block-id="${CSS.escape(blockId)}"]`);
      if (!row) { if (++frames < 60) requestAnimationFrame(flash); return; }
      row.classList.remove('agent-flash'); void row.offsetWidth; row.classList.add('agent-flash');
    };
    requestAnimationFrame(flash);
  }
  return <AgentMarks.Provider value={agentMarks}><div class={`app ${split() ? 'is-split' : ''} ${sidebar() ? 'sidebar-expanded' : ''} ${sidebarCollapsed() ? 'sidebar-collapsed' : ''} ${dock() ? 'has-dock' : ''} ${immersive() ? 'is-immersive' : ''} ${keyboard() ? 'keyboard-open' : ''} ${entry(active())?.target.kind === 'reader' ? 'is-reading' : ''} ${currentHealth()?.cover ? 'has-sync-cover' : ''}`} style={{ '--visual-viewport-height': `${viewport().height}px`, '--visual-viewport-top': `${viewport().top}px`, '--visual-viewport-bottom-gap': `${Math.max(0, window.innerHeight - viewport().bottom)}px` }} onPointerDown={() => { focusEpoch++; }}>
    <header class="global-rail" aria-label="Global navigation" data-tauri-drag-region="deep">
      <div class="rail-start">
        <Button icon="sidebar" label="Toggle sidebar" aria-expanded={sidebarVisible()} onClick={toggleSidebar} />
        <span class="wordmark" title={info()?.path}>Tessera</span>
        <SyncMark open={!!syncAnchor()} onOpen={setSyncAnchor} />
      </div>
      <div class="rail-finder" role="group" aria-label="Find and commands">
        <Button ref={searchButton} class="global-search" icon="find" label="Find or create" shortcut="⌃⇧F" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'search'} onClick={() => showPalette('search')}><span>Find or create…</span><kbd>⌃⇧F</kbd></Button>
        <Button class="global-commands" icon="command" label="Commands" shortcut="⌃⇧P" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'commands'} onClick={() => showPalette('commands')} />
      </div>
      <div class="rail-end">
        <Show when={!DEMO}><Button icon="agent" label="Agent" shortcut="⌃⇧A" aria-pressed={dock()} onClick={() => toggleDock()} /></Show>
        <Button icon="panes" label="Layout" aria-haspopup="menu" aria-expanded={popup()?.kind === 'layout'} onClick={event => setPopup({ kind: 'layout', anchor: event.currentTarget, pane: active() })} />
      </div>
    </header>
    <aside class="sidebar" aria-label="Notebook navigation" aria-hidden={!sidebarVisible()} inert={!sidebarVisible()}>
      {/* On the cover screen the rail is hidden, so the overlay carries the oculus, wordmark and notebook. */}
      <header class="sidebar-masthead">
        <span class="wordmark" title={info()?.path}>Tessera</span>
        <Button class="icon-only" icon="sidebar" label="Close sidebar" onClick={toggleSidebar} />
        {/* A notebook other than the default is named in the warning colour, as at the desktop foot. */}
        <span class="sidebar-masthead-notebook"><Show when={knownNotebooks()?.notebooks.find(entry => entry.current)}>{current => <><span class="sidebar-masthead-name" classList={{ 'sidebar-masthead-other': !current().default }}>{current().name}</span><Show when={index()}><span aria-hidden="true"> · </span></Show></>}</Show><Show when={index()}>{value => <span class="sidebar-masthead-count">{`${value().notes.toLocaleString()} ${value().notes === 1 ? 'note' : 'notes'}`}</span>}</Show></span>
      </header>
      <nav class="primary-navigation" aria-label="Notebook">
        <Button icon="today" title="Today (⌃⇧J)" class={activeRoot()?.kind === 'journal' && activeRoot()?.text === todayDate() ? 'selected' : ''} onClick={event => { void today(active(), opensBeside(event)); }}><span>Today</span><span class="desk-count">{shortDay(todayDate())}</span></Button>
        <Button icon="agenda" class={entry(active())?.target.kind === 'agenda' ? 'selected' : ''} onClick={event => open({ kind: 'agenda', date: journalDate(active()) }, opensBeside(event))}><span>Agenda</span><Show when={counts()?.planned}>{planned => <span class={`desk-count ${counts()!.overdue ? 'late' : ''}`} title={counts()!.overdue ? `${planned()} to do today · ${counts()!.overdue} overdue` : `${planned()} to do today`}>{planned()}</span>}</Show></Button>
        <Button icon="review" class={entry(active())?.target.kind === 'review' ? 'selected' : ''} aria-label={`Review · ${counts()?.cards ?? 0} cards · ${counts()?.revisits ?? 0} to revisit`} onClick={event => open({ kind: 'review' }, opensBeside(event))}><span>Review</span><Show when={(counts()?.cards ?? 0) + (counts()?.revisits ?? 0)}>{due => <span class="desk-count" title={`${counts()?.cards ?? 0} cards · ${counts()?.revisits ?? 0} to revisit`}>{due()}</span>}</Show></Button>
        <Button icon="library" class={entry(active())?.target.kind === 'library' ? 'selected' : ''} onClick={event => open({ kind: 'library' }, opensBeside(event))}><span>Library</span><Show when={counts()?.highlights}>{highlights => <span class="desk-count" title={`${highlights()} unprocessed ${highlights() === 1 ? 'highlight' : 'highlights'}`}>{highlights()}</span>}</Show></Button>
      </nav>
      <Show when={pinnedRoots().length || pinnedViewList().length}><section class="page-list" aria-label="Pinned">
        <h2><span class="section-number">{sectionNumber('pinned')}</span>Pinned<span class="section-rule" /><span class="section-count">{pinnedRoots().length + pinnedViewList().length}</span></h2>
        <PageLinks roots={pinnedRoots()} notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} />
        <ViewLinks views={pinnedViewList()} pinned activeId={activeViewId()} onOpen={openView} onPin={pinView} />
      </section></Show>
      <Show when={index()?.kinds.length}><section class="page-list index-list" aria-label="Index">
        <h2><span class="section-number">{sectionNumber('index')}</span><button type="button" class="index-directory-link" aria-current={activeKindKey() === 'all' ? 'page' : undefined} title="Open Index" onClick={event => open({ kind: 'index', key: 'all' }, opensBeside(event))}>Index</button><span class="section-rule" /><Show when={index()!.notes}>{notes => <span class="section-count" title={`${notes().toLocaleString()} ${notes() === 1 ? 'note' : 'notes'} filed`}>{notes().toLocaleString()}</span>}</Show></h2>
        {/* Kinds sit on shelves, as a finding aid's heads; kinds re-arrive as fresh objects after each change, so Index keeps rows mounted by position. */}
        <For each={shelves}>{([shelf, label]) => <Show when={shelfKinds()[shelf]?.length}>
          <h3 class="index-shelf">{label}</h3>
          <Index each={shelfKinds()[shelf] ?? []}>{kind => <>
            <div classList={{ 'index-question-heading': kind().key === 'question' }}>
            <Button class={`index-kind ${activeKindKey() === kind().key || tagOnly(kind()) && activeTypeId() === kind().type_id ? 'selected' : ''} ${kind().count || kind().tagged_block_count ? '' : 'empty'}`} icon={noteKindIcon(kind())} title={kind().plural} onClick={event => open(indexKindTarget(kind()), opensBeside(event))}><span>{kind().plural}</span><Show when={kind().count || kind().tagged_block_count}>{count => <span class="desk-count">{count().toLocaleString()}</span>}</Show></Button>
            <Show when={kind().key === 'question'}><Button icon="more" label="Questions menu" aria-haspopup="menu" onClick={event => setQuestionsMenu(event.currentTarget)} /></Show>
            </div>
            <Show when={otherViews().some(view => viewInKind(view, kind()))}><div class="index-views"><ViewLinks views={otherViews().filter(view => viewInKind(view, kind()))} pinned={false} activeId={activeViewId()} onOpen={openView} onPin={pinView} /></div></Show>
          </>}</Index>
        </Show>}</For>
        <Show when={index()?.spreads.length}>
          <h3 class="index-shelf">Spreads</h3>
          <For each={index()?.spreads}>{spread => <Button class={`index-kind ${pageIdOf(entry(active())) === spread.id ? 'selected' : ''}`} icon="panes" title={spread.title} onClick={event => open({ kind: 'page', pageId: spread.id }, opensBeside(event))}><span>{spread.title}</span></Button>}</For>
        </Show>
        {/* Built-in kinds with nothing filed fold into one faint line, so they stay discoverable without a row each. */}
        <Show when={emptyKinds().length}><p class="index-empties">Empty: <For each={emptyKinds()}>{(kind, position) => <>{position() ? ' · ' : ''}<button type="button" aria-current={activeKindKey() === kind.key ? 'page' : undefined} onClick={event => open(indexKindTarget(kind), opensBeside(event))}>{kind.plural}</button></>}</For></p></Show>
      </section></Show>
      <section class="page-list" aria-label="Saved views">
        <h2><span class="section-number">{sectionNumber('views')}</span>Views<span class="section-rule" /><span class="section-count">{looseViews().length || ''}</span></h2>
        <ViewLinks views={looseViews()} pinned={false} activeId={activeViewId()} onOpen={openView} onPin={pinView} />
        <Button icon="plus" onClick={event => setPopup({ kind: 'new-view', anchor: event.currentTarget, pane: active() })}>New view…</Button>
      </section>
      <details class="page-list" open>
        <summary><span class="section-number">{sectionNumber('recent')}</span>Recent<span class="section-rule" /><Icon name="down" /></summary>
        <Show when={recentRoots().length} fallback={<p class="sidebar-empty">Pages you open appear here</p>}><PageLinks roots={recentRoots()} sourceIcons notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} /></Show>
      </details>
      <div class="sidebar-foot">
        <NotebookSwitcher notebook={notebook} onOpen={target => open(target)} onError={reportError} />
        <Button icon="settings" label="Settings" class={`icon-only ${entry(active())?.target.kind === 'settings' ? 'selected' : ''}`} onClick={event => open({ kind: 'settings' }, opensBeside(event))} />
        <Button icon="field" label="Fields" class={`icon-only ${entry(active())?.target.kind === 'fields' && !(entry(active())?.target as Extract<OpenTarget, { kind: 'fields' }>).typeId ? 'selected' : ''}`} onClick={event => open({ kind: 'fields' }, opensBeside(event))} />
      </div>
    </aside>
    {/* The overlay sidebar covers the cover screen's own toggle; tapping beside it closes it. */}
    <Show when={narrow() && sidebar()}><div class="sidebar-shade" aria-hidden="true" onClick={() => setSidebar(false)} /></Show>
    <main class="workspace">
      <Show when={split()}><div class="pane-tabs"><div class="pane-tab-strip mode-tabs tab-strip" role="tablist" aria-label="Working panes"><For each={order()}>{(pane, position) => <><Button role="tab" aria-selected={active() === pane} onClick={() => { if (active() !== pane) { setActive(pane); focusPane(pane); } }}><span class="pane-tab-number">{position() + 1}</span><span class="pane-tab-title">{paneName(pane)}</span></Button><Button class="pane-tab-close" icon="close" label={`Close ${paneName(pane)}`} shortcut={active() === pane ? '⌃⇧X' : undefined} onClick={() => closePane(pane)} /></>}</For></div></div></Show>
      <Show when={error()}><div class="shell-error" role="alert"><Icon name="warning" /><span>{error()}</span><Button onClick={() => { if (offlineUnavailable()) { location.reload(); return; } setError(''); void today(); }}>Retry</Button></div></Show>
      <GlobalBanner notebook={notebook} onReview={reviewConflict} />
      <div ref={paneRow} class="panes"><For each={order()}>{(pane, position) => <>
        <Show when={!shown(pane)}><button type="button" class="pane-spine" data-spine={pane} aria-label={`Show pane ${position() + 1}, ${paneName(pane)}`} title={paneName(pane)} onClick={() => { setActive(pane); reveal(pane); focusPane(pane); }}>
          <span class="pane-spine-number">{position() + 1}</span><span class="pane-spine-title">{paneName(pane)}</span>
        </button></Show>
        <Show when={!tabbed() && shown(pane) && position() > start()}>
          <PaneDivider left={order()[position() - 1]!} right={pane} follows={!!listKinds[entry(order()[position() - 1]!)?.target.kind ?? 'page']} weights={weights()}
            onResize={(left, right) => setWeights(values => ({ ...values, [order()[position() - 1]!]: left, [pane]: right }))} onReset={() => setWeights({})} />
        </Show>
        <Show when={entry(pane)}>
        <Pane pane={pane} number={position() + 1} folded={!shown(pane)} grow={weights()[pane] ?? 1} neighbour={position() < order().length - 1} session={() => sessions()[pane]!} active={active() === pane} split={split()} immersive={immersive() === pane} onImmersive={on => immerse(pane, on)} notebook={notebook} commands={commands} vim={vim()} vimMode={vimModes()[pane] ?? null} onVimMode={mode => setVimModes(values => ({ ...values, [pane]: mode }))} pinned={pinned().includes(pageIdOf(entry(pane)) ?? '')} pagePresentations={pagePresentations()} title={paneTitle(pane)} noteKind={indexKind(pane)}
          noteKinds={index()?.kinds}
          onCreate={openCreate}
          sidebarOpen={sidebarVisible()} onSidebar={toggleSidebar}
          onPagePresentation={(id, value) => setPagePresentations(previous => ({ ...previous, [id]: value }))}
          onActivate={() => setActive(pane)}
          onOpen={(target, beside) => open(target, beside, pane)}
          onPageBeside={() => openPageBeside(pane)}
          onViewChange={view => changeView(pane, view)}
          onTargetChange={target => changeTarget(pane, target)}
          onTravel={delta => travel(pane, delta)}
          onClose={() => closePane(pane)}
          onChooseDate={anchor => chooseDate(pane, anchor)}
          onShiftDate={delta => shiftDate(delta, pane)}
          onPin={() => { const id = pageIdOf(entry(pane)); if (id) pin(id); }}
          onRename={() => runOutline('rename', pane)}
          onDelete={(anchor, source) => setPopup({ kind: 'delete', anchor, pane, source })}
          onDeleteSources={sources => deletePages(sources, sources.length === 1 ? undefined : `${sources.length} sources`)}
          onArchived={() => { runOutline('show-archived', pane); focusPane(pane); }}
          onRestoreView={view => changeView(pane, view, true)}
        />
        </Show>
      </>}</For>
        <Show when={guide()}>{value => <div class="pane-guide" classList={{ 'pane-guide-new': value().fresh }} style={{ left: `${value().left}px`, width: `${value().width}px` }} aria-hidden="true"><span>{value().label}</span></div>}</Show>
      </div>
      <Show when={!order().some(pane => entry(pane)) && !error()}><div class="startup-state">Opening today’s journal…</div></Show>
      <Show when={dragChip()}>{chip => <div class="pane-drag-chip" style={{ transform: `translate(${chip().x + 14}px, ${chip().y + 14}px)` }} aria-hidden="true">{chip().label}</div>}</Show>
    </main>
    <Show when={dock()}>
      <AgentDock notebook={notebook} session={agentSession} chips={dockChips()} excluded={dockExcluded()}
        onToggleChip={key => setDockExcluded(values => { const next = new Set(values); if (!next.delete(key)) next.add(key); return next; })}
        onRemoveChip={key => setDockExtra(values => values.filter(chip => chip.key !== key))}
        onShow={showAgentEdit} onOpen={(target, beside) => open(target, beside)}
        onSettings={() => open({ kind: 'settings', section: 'agent' }, true)} onClose={() => toggleDock(false)} />
    </Show>
    <SyncLifecycle notebook={notebook} anchor={syncAnchor()} onClose={() => setSyncAnchor(null)} onDevices={deviceId => open({ kind: 'settings', section: 'devices', deviceId })} />
    <SyncCover open={!!syncAnchor()} onOpen={setSyncAnchor} />
    <nav class="bottom-nav" aria-label="Notebook">
      <Button icon="today" class={activeRoot()?.kind === 'journal' && activeRoot()?.text === todayDate() ? 'selected' : ''} onClick={() => { void today(); }}><span>Today</span></Button>
      <Button icon="agenda" class={entry(active())?.target.kind === 'agenda' ? 'selected' : ''} onClick={() => open({ kind: 'agenda', date: journalDate(active()) })}><span>Agenda</span></Button>
      <Button icon="plus" class={creation() ? 'selected' : ''} aria-haspopup="dialog" aria-expanded={!!creation()} onClick={() => openCreate(blankCapture())}><span>New</span></Button>
      <Button icon="find" class={popup()?.kind === 'search' ? 'selected' : ''} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'search'} onClick={event => setPopup({ kind: 'search', anchor: event.currentTarget, pane: active() })}><span>Find</span></Button>
      <Button icon="review" class={entry(active())?.target.kind === 'review' ? 'selected' : ''} onClick={() => open({ kind: 'review' })}><span>Review</span></Button>
      <Button icon="library" class={entry(active())?.target.kind === 'library' || entry(active())?.target.kind === 'reader' ? 'selected' : ''} aria-haspopup="menu" aria-expanded={!!typesMenu()}
        onClick={() => open({ kind: 'library' })} onContextMenu={event => { event.preventDefault(); void showTypes(event.currentTarget); }}><span>Library</span></Button>
    </nav>
    <Show when={questionsMenu()}>{anchor => <Menu anchor={anchor()} label="Questions" onDismiss={() => setQuestionsMenu(undefined)} items={[
      { label: 'Open research desk', icon: 'panes', action: () => { setQuestionsMenu(undefined); open(deskTarget()); } },
    ]} />}</Show>
    <Show when={typesMenu()}>{state => <Menu anchor={state().anchor} label="Types" onDismiss={() => setTypesMenu(null)} items={[
      { label: 'Library', icon: 'library', checked: entry(active())?.target.kind === 'library', action: () => open({ kind: 'library' }) },
      ...state().types.map(type => ({ section: 'Types', label: type.page.text, icon: 'table' as const, checked: activeTypeId() === type.page.id,
        action: () => open({ kind: 'table', typeId: type.page.id, viewId: null, query: { type: type.page.id, text: null, filters: [], sort: [], limit: null } }) })),
    ]} />}</Show>
    <Show keyed when={popup()}>{state => <>
      <Show when={state.kind === 'search' || state.kind === 'commands'}>
        <Palette anchor={state.anchor} pane={state.pane} mode={state.kind === 'commands' ? 'commands' : 'search'} commands={commands} notebook={notebook} onDismiss={() => setPopup(null)} onRestoreFocus={() => { if (!popup() && active() === state.pane) focusPane(state.pane); }} onOpen={(target, beside) => open(target, beside, state.pane)} onCreate={openCreate} />
      </Show>
      <Show when={state.kind === 'calendar'}>
        <Calendar notebook={notebook} anchor={state.anchor} date={state.date ?? journalDate(state.pane)} today={todayDate()} onToday={() => { void today(state.pane); }} onDismiss={() => setPopup(null)} onSelect={value => { void journal(value, state.pane); }} />
      </Show>
      <Show when={state.kind === 'new-view'}>
        <Menu anchor={state.anchor} label="New view source" header={<div class="table-popup-heading">Choose a source</div>} items={querySources.map(source => ({ label: source.name, action: () => { setPopup(null); open({ kind: 'table', typeId: null, viewId: null, query: { ...typeQuery(null), source: source.key } }, false, state.pane); } }))} onDismiss={() => setPopup(null)} />
      </Show>
      <Show when={state.kind === 'restore-pages'}>
        <DeletedPages anchor={state.anchor} notebook={notebook} onDismiss={() => setPopup(null)} onRestored={id => { setPopup(null); open({ kind: 'page', pageId: id }, false, state.pane); }} />
      </Show>
      <Show when={state.kind === 'delete'}>
        <Popup anchor={state.anchor} label="Delete page" onDismiss={() => setPopup(null)} width={300} fitContent>
          <p>Delete “{notebook.lookup(pageIdOf(entry(state.pane)) ?? '')()?.text ?? rootById().get(pageIdOf(entry(state.pane)) ?? '')?.text}” and {state.source ? 'its highlights' : 'all its blocks'}?</p>
          <HolderDeletionImpact notebook={notebook} pageId={pageIdOf(entry(state.pane))} />
          <p class="muted">Undo this deletion, or use Restore deleted page in Commands after reloading.</p>
          <div class="popup-actions"><Button onClick={() => setPopup(null)}>Cancel</Button><Button icon="trash" class="danger bordered" onClick={() => { void deletePage(state.pane); }}>Delete page</Button></div>
        </Popup>
      </Show>
      <Show when={state.kind === 'layout'}>
        <Menu anchor={state.anchor} label="Layout" onDismiss={() => setPopup(null)} items={[
          { label: 'Open active view beside', icon: 'panes', shortcut: '⌃⇧O', disabledReason: entry(state.pane) ? undefined : 'No view is open', action: () => openPageBeside(state.pane) },
          { label: 'Next pane', icon: 'panes', shortcut: '⌃⇧]', disabledReason: split() ? undefined : 'Open a second pane first', action: switchPane },
          { label: 'Even pane widths', icon: 'panes', disabledReason: !split() ? 'Open a second pane first' : Object.keys(weights()).length ? undefined : 'Panes are already even', action: () => setWeights({}) },
          { label: 'Close active pane', icon: 'close', shortcut: '⌃⇧X', disabledReason: split() ? undefined : 'Only one pane is open', action: () => closePane(state.pane) },
          { section: 'Navigation', label: sidebarVisible() ? 'Hide sidebar' : 'Show sidebar', icon: 'sidebar', action: toggleSidebar },
        ]} />
      </Show>
    </>}</Show>
    <Show keyed when={creation()}>{state => <CreateSlip notebook={notebook} request={state.request} anchor={state.anchor} onDismiss={closeCreate} onOpen={(target, beside) => open(target, beside, state.pane)} onNotice={showNotice} />}</Show>
    <ReferencePreviews notebook={notebook} navigationKey={`${active()}:${order().map(pane => sessions()[pane]?.generation ?? 0).join(':')}`} onOpen={(target, beside, pane) => open(target, beside, pane ?? active())} />
    <Show when={toastShown() && notice()}>{value => <div class="undo-toast" role="status" onPointerEnter={() => setToastHeld(true)} onPointerLeave={() => setToastHeld(false)} onFocusIn={() => setToastHeld(true)} onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setToastHeld(false); }}><span>{value().message}</span><For each={value().actions}>{action => <Button disabled={noticeBusy()} onClick={() => void noticeAction(action)}>{action.label}</Button>}</For><Button icon="close" label="Dismiss notification" onClick={() => setToastShown(false)} /></div>}</Show>
    <NotebookOpening />
  </div></AgentMarks.Provider>;
}

function PageLinks(props: { roots: Block[]; sourceIcons?: boolean; notebook: NotebookClient; activeId?: string; onOpen(target: OpenTarget, beside?: boolean): void }) {
  // Roots arrive as fresh objects whenever any root changes; keying rows by id keeps them mounted.
  const byId = createMemo(() => new Map(props.roots.map(root => [root.id, root])));
  const ids = createMemo(() => props.roots.map(root => root.id), undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  return <For each={ids()}>{id => {
    const root = () => byId().get(id)!;
    const title = () => props.notebook.lookup(id)()?.text ?? root().text;
    const icon = createPageIcon(props.notebook, root, () => !!props.sourceIcons, 'today');
    return <Button class={id === props.activeId ? 'selected' : ''} icon={icon()} title={title()} data-open-page={id} data-open-label={title()} onClick={event => props.onOpen({ kind: 'page', pageId: id }, opensBeside(event))}><span>{title()}</span></Button>;
  }}</For>;
}

/**
 * The rule between two shown panes. Dragging it shares their width, snapping at a third, a half and two thirds;
 * arrow keys move it, and a double click evens the row. A list's rule carries an arrow toward the pane it fills.
 */
function PaneDivider(props: { left: PaneId; right: PaneId; follows: boolean; weights: Record<PaneId, number>; onResize(left: number, right: number): void; onReset(): void }) {
  const [snap, setSnap] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const total = () => (props.weights[props.left] ?? 1) + (props.weights[props.right] ?? 1);
  const share = () => (props.weights[props.left] ?? 1) / total();
  const pair = () => {
    const find = (pane: PaneId) => document.querySelector<HTMLElement>(`.panes > .pane[data-pane="${CSS.escape(pane)}"]`)?.getBoundingClientRect();
    const left = find(props.left), right = find(props.right);
    return left && right ? { start: left.left, width: right.right - left.left } : null;
  };
  const resize = (ratio: number, width: number, tolerance?: number) => {
    const next = dividerRatio(ratio, width, tolerance);
    setSnap(next.snap);
    props.onResize(total() * next.ratio, total() * (1 - next.ratio));
  };
  const pointerdown = (event: PointerEvent) => {
    const bounds = pair(); if (event.button !== 0 || !bounds) return;
    event.preventDefault();
    const divider = event.currentTarget as HTMLElement;
    divider.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (next: PointerEvent) => resize((next.clientX - bounds.start) / bounds.width, bounds.width);
    const end = () => { setDragging(false); setSnap(null); divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', end); divider.removeEventListener('pointercancel', end); };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
  };
  const keydown = (event: KeyboardEvent) => {
    const bounds = pair(); if (!bounds || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    resize(share() + (event.key === 'ArrowLeft' ? -0.05 : 0.05), bounds.width, 0);
  };
  return <div class="pane-divider" classList={{ dragging: dragging() }} role="separator" aria-orientation="vertical" aria-label="Resize panes" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share() * 100)} tabIndex={0}
    onPointerDown={pointerdown} onKeyDown={keydown} onDblClick={() => props.onReset()} onBlur={() => setSnap(null)}>
    <Show when={props.follows}><span class="pane-follows" title="The list opens its rows in the pane to its right"><Icon name="right" /></span></Show>
    <Show when={snap()}><span class="pane-snap">{snap()}</span></Show>
  </div>;
}

function ViewLinks(props: { views: View[]; pinned: boolean; activeId?: string; onOpen(view: View, beside: boolean): void; onPin(id: string): void }) {
  return <For each={props.views}>{view => <div class="sidebar-view">
    <Button class={`view-link ${view.id === props.activeId ? 'selected' : ''}`} icon="table" title={view.name} onClick={event => props.onOpen(view, opensBeside(event))}><span>{view.name}</span></Button>
    <Button class="view-pin" icon="pin" label={`${props.pinned ? 'Unpin' : 'Pin'} view ${view.name}`} aria-pressed={props.pinned} onClick={() => props.onPin(view.id)} />
  </div>}</For>;
}


function GlobalBanner(props: { notebook: NotebookClient; onReview(): void }) {
  const text = createMemo(() => {
    if (props.notebook.localPersistence() === 'failed') return 'Not saved locally · Keep this tab open';
    const state = props.notebook.saveState();
    if (state === 'error' || props.notebook.rejectedText()) return 'Couldn’t save · Local changes kept';
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (props.notebook.connection() === 'offline' || state === 'offline') {
      const count = props.notebook.queuedChanges();
      if (!count && (state === 'saving' || state === 'queued')) return 'Saving…';
      return count ? `Offline · ${count} changes queued locally` : 'Offline · All changes saved';
    }
    return '';
  });
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => { text(); props.notebook.rejectedText(); setCopyMessage(''); });
  return <Show when={text()}><div class={`save-banner ${props.notebook.saveState()}`} role="status">
    <Icon name={props.notebook.connection() === 'offline' ? 'offline' : 'warning'} /><span>{text()}</span>
    <Show when={props.notebook.conflictedPages().length}><Button onClick={props.onReview}>Review conflict</Button></Show>
    <Show when={props.notebook.saveState() === 'error' || props.notebook.connection() === 'offline'}><Button onClick={() => props.notebook.retry()}>Retry</Button></Show>
    <Show when={props.notebook.localPersistence() === 'failed' || props.notebook.rejectedText()}><Button onClick={() => { navigator.clipboard.writeText(props.notebook.rejectedText() || props.notebook.unsavedText()).then(() => setCopyMessage('Copied unsaved text'), () => setCopyMessage('Couldn’t copy · Select and copy your text manually')); }}>Copy unsaved text</Button></Show>
    <Show when={copyMessage()}><span>{copyMessage()}</span></Show>
    <Show when={props.notebook.saveMessage()}><details><summary>Details</summary>{props.notebook.saveMessage()}</details></Show>
    <Show when={props.notebook.rejectedText()}><div class="rejected-changes">
      <pre tabIndex={0} aria-label="Rejected changes kept locally">{props.notebook.rejectedText()}</pre>
      <Button onClick={() => props.notebook.dismissRejected()}>Dismiss</Button>
    </div></Show>
  </div></Show>;
}

function Pane(props: { pane: PaneId; number: number; folded: boolean; grow: number; neighbour: boolean; session: Accessor<PaneSession>; active: boolean; split: boolean; immersive: boolean; onImmersive(immersive: boolean): void; sidebarOpen: boolean; onSidebar(): void; notebook: NotebookClient; commands: CommandRegistry; vim: boolean; vimMode: VimMode; onVimMode(mode: VimMode): void; pinned: boolean; pagePresentations: Record<string, PagePresentation>; title?: string; noteKind?: IndexKind; noteKinds?: NoteKind[]; onPagePresentation(id: string, value: PagePresentation): void; onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void; onCreate(request: CreateRequest, anchor?: PopupAnchor): void; onTargetChange(target: OpenTarget): void; onPageBeside(): void; onViewChange(view: PaneView): void; onTravel(delta: number): void; onClose(): void; onChooseDate(anchor: HTMLElement): void; onShiftDate(delta: number): void; onPin(): void; onRename(): void; onDelete(anchor: HTMLElement, source?: boolean): void; onDeleteSources(sources: { id: string; title: string }[]): Promise<void>; onArchived(): void; onRestoreView(view: ViewState): void }) {
  const current = () => props.session().entries[props.session().index]!;
  const pageId = createMemo(() => pageIdOf(current()));
  const readerTarget = () => current().target.kind === 'reader' ? current().target as Extract<OpenTarget, { kind: 'reader' }> : undefined;
  // A reader keeps its source page open so the header's projection tabs can describe it.
  const docId = createMemo(() => pageId() ?? readerTarget()?.sourceId);
  const outlineView = () => current().view as ViewState;
  const [doc, setDoc] = createSignal<PageDocument>();
  const [pageKinds, setPageKinds] = createSignal<NoteKind[]>();
  const [librarySave, setLibrarySave] = createSignal<{ state: 'saved' | 'saving' | 'error'; message: string }>({ state: 'saved', message: '' });
  const paneGeneration = createMemo(() => props.session().generation);
  createEffect(() => { paneGeneration(); setLibrarySave({ state: 'saved', message: '' }); });
  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => { pageId(); setCopyMessage(''); });
  async function copyPage(reference: boolean) {
    const id = pageId();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(reference ? `[[${id}]]` : id);
      setCopyMessage(reference ? 'Copied reference' : 'Copied ID');
    } catch (error) {
      setCopyMessage(`Couldn't copy: ${String(error)}`);
    }
  }
  const [depthMenu, setDepthMenu] = createSignal<HTMLElement | null>(null);
  const [mergeFrom, setMergeFrom] = createSignal<{ id: string; text: string }>();
  let menuButton!: HTMLButtonElement;
  let content!: HTMLDivElement;
  const motionIdentity = createMemo(() => paneTargetIdentity(current().target));
  createPaneMotion(() => content, motionIdentity);
  createEffect(() => {
    const id = docId(); setDoc(undefined); setPageKinds(undefined); if (!id) return;
    const document = props.notebook.open(id); setDoc(document);
    onCleanup(() => document.release());
  });
  const root = () => doc()?.root();
  const presentation = () => props.pagePresentations[pageId() ?? ''] ?? {};
  // A source with a snapshot reads as its book: Read opens the reader, so its page itself always shows the outline.
  const readableSource = () => !!root()?.source?.current_snapshot_id;
  const defaultProjection = createMemo<PageProjection>(() => {
    const page = doc();
    return page && isReadingSubject(page) ? 'read' : 'outline';
  });
  const projection = createMemo<PageProjection>(() => {
    if (readerTarget()) return 'read';
    if (outlineView().zoom) return 'outline';
    const value = outlineView().projection ?? presentation().projection ?? defaultProjection();
    return value === 'read' && readableSource() ? 'outline' : value;
  });
  createEffect(() => {
    if (current().target.kind !== 'page' || doc()?.status() !== 'ready' || outlineView().projection !== undefined) return;
    props.onViewChange({ ...outlineView(), projection: presentation().projection ?? defaultProjection() });
  });
  const readSubject = () => {
    const zoom = outlineView().zoom;
    const subject = zoom && doc()?.block(zoom)?.position?.subject_id;
    return subject ? props.notebook.lookup(subject)() : undefined;
  };
  const projectionReason = (value: PageProjection) => {
    if (value !== 'read' || readerTarget()) return undefined;
    if (doc()?.status() !== 'ready') return doc()?.status() === 'missing' || doc()?.status() === 'error' ? 'The page is unavailable.' : 'Read is unavailable while the page is loading.';
    const zoom = outlineView().zoom;
    if (!zoom) return root()?.kind === 'page' ? undefined : 'Only titled pages have projections.';
    const block = doc()?.block(zoom);
    if (!block?.position) return 'This zoom is not a perspective. Open its page to use Read.';
    if (doc()?.isArchived(zoom)) return 'This perspective is archived. Restore it to use Read.';
    const subject = readSubject();
    if (subject === undefined) return 'The perspective’s subject is loading.';
    if (!subject || subject.archived) return 'The perspective’s subject is unavailable.';
    const page = subject.id === subject.page_id ? subject : props.notebook.lookup(subject.page_id)();
    if (page === undefined) return 'The perspective’s subject page is loading.';
    if (!page || page.archived) return 'The perspective’s subject page is unavailable.';
    if (page.kind !== 'page') return 'Read needs a titled subject. File this perspective under a concept or question.';
    return undefined;
  };
  const setProjection = (value: PageProjection, beside = false) => {
    const reader = readerTarget();
    if (reader) {
      if (value === 'read') return;
      const id = reader.sourceId, previous = props.session().entries[props.session().index - 1];
      props.onPagePresentation(id, { ...props.pagePresentations[id], projection: value });
      // The page the book was opened from is the way back to its outline.
      if (!beside && pageIdOf(previous) === id && !(previous!.view as ViewState).zoom && (previous!.view as ViewState).projection === value) props.onTravel(-1);
      else props.onOpen({ kind: 'page', pageId: id }, beside);
      return;
    }
    if (projectionReason(value)) return;
    const zoom = outlineView().zoom;
    if (value === 'read' && !zoom && readableSource()) {
      props.onViewChange({ ...outlineView(), projection: 'outline' });
      props.onOpen({ kind: 'reader', sourceId: pageId()! }, beside);
      return;
    }
    if (value === 'read' && zoom) {
      const subject = readSubject()!;
      if (subject.page_id !== pageId()) {
        props.onOpen({ kind: 'page', pageId: subject.page_id, readAt: zoom }, false);
        return;
      }
      batch(() => {
        props.onPagePresentation(pageId()!, { ...presentation(), projection: 'read' });
        props.onRestoreView({ ...outlineView(), projection: 'read', zoom: null, caret: { id: zoom, offset: 0 }, scroll: { id: zoom, offset: 0 }, reveal: zoom, edit: undefined });
      });
      return;
    }
    batch(() => {
      props.onViewChange({ ...outlineView(), projection: value });
      props.onPagePresentation(pageId()!, { ...presentation(), projection: value });
    });
  };
  const pageStyle = () => (presentation().bullets ?? root()?.kind === 'journal') ? 'bullets' : 'prose';
  const compareReason = () => {
    const page = doc();
    if (!readerTarget()) return outlineCommand('compare')?.disabledReason?.()?.replace(/\.$/, '');
    return page?.status() !== 'ready' ? 'Page is unavailable' : localPositionCount(page) < 2 ? 'Compare needs two perspectives on this page' : undefined;
  };
  // Journals and other untitled roots have no projections, so their zooms carry neither the tabs nor Read's reason.
  const projectionTabsShown = () => root()?.kind === 'page' || !!outlineView().zoom && !!doc()?.block(outlineView().zoom!)?.position;
  const ProjectionTabs = () => <div class="mode-tabs tab-strip page-projection-tabs" role="tablist" aria-label="Page projection"><For each={['read', 'outline', 'compare'] as const}>{value => <Button role="tab" aria-selected={projection() === value} disabled={value === 'read' ? !!projectionReason(value) : value === 'compare' && !!compareReason()} aria-describedby={value === 'read' && projectionReason(value) ? `read-reason-${props.pane}` : undefined} onClick={event => setProjection(value, opensBeside(event))}>{value === 'read' ? 'Read' : value === 'outline' ? 'Outline' : 'Compare'}</Button>}</For></div>;
  const breadcrumbs = createMemo(() => {
    const page = doc(); const zoom = 'zoom' in current().view ? outlineView().zoom : null; if (!page || !zoom) return [];
    const result = []; let block = page.block(zoom);
    while (block && block.id !== page.pageId) { result.unshift(block); block = block.parentId ? page.block(block.parentId) : undefined; }
    return result;
  });
  // Typing queues edits in the local outbox for at most a second before sending, and most sends are
  // acknowledged within milliseconds; announcing each one would flash the header on every keystroke.
  // Saving… appears only when a send stays unacknowledged for longer than SAVE_NOTICE_DELAY.
  const sending = createMemo(() => doc()?.saveState() === 'saving');
  const [slowSave, setSlowSave] = createSignal(false);
  createEffect(() => {
    if (!sending()) { setSlowSave(false); return; }
    const timer = setTimeout(() => setSlowSave(true), SAVE_NOTICE_DELAY);
    onCleanup(() => clearTimeout(timer));
  });
  const saveState = () => doc()?.saveState();
  const status = () => {
    const state = saveState();
    return state === 'conflict' ? 'Conflict · Both versions kept' : state === 'error' ? 'Couldn’t save · Local changes kept' : state === 'offline' ? 'Offline' : 'Saving…';
  };
  const rootCapability = (kind: 'task' | 'project') => outlineCommand(`${kind}-root`)?.run();
  const outlineCommand = (id: string) => props.commands.list().find(command => command.id === `outline.${props.pane}.${id}`);
  const depth = (): Depth => outlineView().depth ?? 'full';
  // The dial shows on titled pages at their top level; a zoomed page always shows in full.
  const showDial = () => root()?.kind === 'page' && !outlineView().zoom && projection() === 'outline';
  // Read and Compare keep the dial's place, unseen, so switching projection never slides the tabs under the pointer.
  const dialPlace = () => root()?.kind === 'page' && !outlineView().zoom;
  // Journal days leave out description and the titled-page-only choices.
  const titled = () => root()?.kind !== 'journal';
  const stream = createMemo(() => root()?.manual_types.some(title => title.toLocaleLowerCase() === 'stream'));
  const makeItems = (): MenuItem[] => [
    ...(!root()?.task ? [{ label: 'Task', icon: 'select', disabledReason: outlineCommand('task-root')?.disabledReason?.(), action: () => rootCapability('task') } satisfies MenuItem] : []),
    ...(!root()?.project ? [{ label: 'Project', icon: 'flag', disabledReason: outlineCommand('project-root')?.disabledReason?.(), action: () => rootCapability('project') } satisfies MenuItem] : []),
    ...(titled() && !stream() ? [{ label: 'Stream', icon: 'link', disabledReason: outlineCommand('stream-root')?.disabledReason?.(), action: () => outlineCommand('stream-root')?.run() } satisfies MenuItem] : []),
    ...(titled() && !root()?.question ? [{ label: 'Question', icon: 'question-open', disabledReason: root() ? undefined : 'Page is still loading', action: () => {
      const result = doc()?.edit({ kind: 'question', id: pageId()!, value: { unsettled: false, parked: false, accepted: null, review_on: null } });
      if (result && !result.ok) setCopyMessage(result.reason);
    } } satisfies MenuItem] : []),
  ];
  const items = (): MenuItem[] => [
    { label: 'Copy reference', icon: 'link', action: () => { void copyPage(true); } },
    ...(titled() ? [
      { label: 'Rename', icon: 'edit', divider: true, action: props.onRename },
      { label: 'Merge into…', icon: 'merge', disabledReason: pageMergeDisabledReason(root()), action: () => { const page = root(); if (page) setMergeFrom({ id: page.id, text: page.text }); } },
    ] satisfies MenuItem[] : []),
    { label: props.pinned ? 'Unpin' : 'Pin', icon: 'pin', divider: !titled(), action: props.onPin },
    { label: 'Open beside', icon: 'panes', action: props.onPageBeside },
    ...(titled() ? [{ label: 'Description…', icon: 'note', divider: true, submenu: () => ({ title: 'Description', items: [
      { label: 'Gloss', icon: 'edit', disabledReason: outlineCommand('gloss')?.disabledReason?.(), action: () => outlineCommand('gloss')?.run() },
      { label: 'Add alias', icon: 'edit', disabledReason: outlineCommand('alias')?.disabledReason?.(), action: () => outlineCommand('alias')?.run() },
    ] }) } satisfies MenuItem] : []),
    { label: 'Add field…', icon: 'field', divider: !titled(), disabledReason: outlineCommand('add-field-root')?.disabledReason?.(), action: () => outlineCommand('add-field-root')?.run() },
    { label: 'Types…', icon: 'tag', disabledReason: outlineCommand('types-root')?.disabledReason?.(), action: () => outlineCommand('types-root')?.run() },
    ...(makeItems().length ? [{ label: 'Make…', icon: 'plus', submenu: () => ({ title: 'Make', items: makeItems(), note: 'Each adds to this note and keeps its text.' }) } satisfies MenuItem] : []),
    ...(root()?.task ? [{ label: 'Task…', icon: 'select', disabledReason: outlineCommand('task-root')?.disabledReason?.(), action: () => rootCapability('task') } satisfies MenuItem] : []),
    ...(root()?.project ? [{ label: 'Project…', icon: 'flag', disabledReason: outlineCommand('project-root')?.disabledReason?.(), action: () => rootCapability('project') } satisfies MenuItem] : []),
    ...(root()?.question ? [{ label: 'Question…', icon: 'question-open', disabledReason: outlineCommand('question-root')?.disabledReason?.(), action: () => outlineCommand('question-root')?.run() } satisfies MenuItem] : []),
    ...(stream() ? [{ label: 'Stream…', icon: 'link', submenu: () => ({ title: 'Stream', items: [
      { label: 'Remove stream', icon: 'trash', danger: true, disabledReason: outlineCommand('stream-root')?.disabledReason?.(), action: () => outlineCommand('stream-root')?.run() },
    ] }) } satisfies MenuItem] : []),
    { label: 'Appearance…', icon: 'rows', divider: true, submenu: () => ({ title: 'Appearance', items: [
      ...(projection() === 'outline' ? [{ label: pageStyle() === 'prose' ? 'Show bullets' : 'Hide bullets', icon: 'bullet', disabledReason: root() ? undefined : 'Page is still loading', action: () => props.onPagePresentation(pageId()!, { ...presentation(), bullets: pageStyle() === 'prose' }) } satisfies MenuItem] : []),
      { label: outlineView().showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', action: props.onArchived },
    ] }) },
    { label: 'Delete page…', icon: 'trash', divider: true, danger: true, action: () => props.onDelete(menuButton) },
  ];
  // The place or kind the pane shows, in the same glyphs the sidebar uses.
  const kindIcon = (): IconName => {
    if (pageId()) {
      const page = root();
      if (page?.kind === 'journal') return 'today';
      if (page?.source) return 'library';
      if (page?.spread) return 'panes';
      if (page?.question) return noteKindIcon('question');
      if (page?.project) return noteKindIcon('project');
      const kind = pageKinds() ? pageKinds()!.find(kind => kind.type_id) : props.noteKinds?.find(kind => kind.type_id && page?.manual_types.some(title => titleKey(title) === titleKey(kind.name)));
      return kind ? noteKindIcon(kind) : 'page';
    }
    const target = current().target;
    if (target.kind === 'index') return noteKindIcon(props.noteKind ?? target.key);
    if (target.kind === 'spread') return 'panes';
    if ((target.kind === 'fields' || target.kind === 'cards') && target.typeId) return noteKindIcon(props.noteKind ?? `type:${target.typeId}`);
    const kind = target.kind;
    return kind === 'agenda' ? 'agenda' : kind === 'review' ? 'review' : kind === 'library' || kind === 'reader' ? 'library' : kind === 'table' ? 'table' : kind === 'fields' || kind === 'field' ? 'field' : kind === 'settings' ? 'settings' : kind === 'compare' ? 'compare' : 'page';
  };
  return <section class="pane" classList={{ active: props.active, immersive: props.immersive, folded: props.folded }} style={{ 'flex-grow': props.grow }} data-pane={props.pane} data-page-style={pageStyle()} aria-label={`Pane ${props.number}`} onPointerDown={props.onActivate} onFocusIn={props.onActivate}>
    <header class="pane-header">
      {/* The cover screen has no rail; its sidebar opens from here. */}
      <Button class="pane-sidebar" icon="sidebar" label="Notebook" aria-expanded={props.sidebarOpen} onClick={props.onSidebar} />
      <div class="pane-navigation"><Button icon="left" label="Back" shortcut="⌃⇧H" disabled={props.session().index <= 0} onClick={() => props.onTravel(-1)} /><Button icon="right" label="Forward" shortcut="⌃⇧L" disabled={props.session().index >= props.session().entries.length - 1} onClick={() => props.onTravel(1)} /></div>
      <Icon class="pane-kind" name={kindIcon()} />
      <Show when={props.split}><span class="pane-number" aria-hidden="true">{props.number}</span></Show>
      <Show when={pageId()}>
        <nav class="pane-breadcrumbs" aria-label="Page breadcrumbs" style={{ visibility: root() ? undefined : 'hidden' }}><Show when={root()?.source && !breadcrumbs().length}><Button class="breadcrumb-library" onClick={event => props.onOpen({ kind: 'library' }, opensBeside(event))}>Library</Button><span class="breadcrumb-separator">/</span></Show><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: null })}>{root()?.text ?? 'Loading…'}</Button><For each={breadcrumbs()}>{block => <><span class="breadcrumb-separator">/</span><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: block.id })}>{plainText(block.text, id => props.notebook.lookup(id), undefined, block.position?.deleted_holder) || 'Empty block'}</Button></>}</For></nav>
        <Show when={root()?.kind === 'journal'}><nav class="journal-navigation" aria-label="Journal navigation">
          <Button icon="left" label="Previous journal day" onClick={() => props.onShiftDate(-1)} />
          <Button class="journal-date" icon="calendar" label="Choose journal date" aria-haspopup="dialog" onClick={event => props.onChooseDate(event.currentTarget)} />
          <Button icon="right" label="Next journal day" onClick={() => props.onShiftDate(1)} />
        </nav></Show>
        <Show when={projectionTabsShown()}><ProjectionTabs /></Show>
        <Show when={dialPlace()}><div class="depth-dial" role="group" aria-label="Depth" data-held={showDial() ? undefined : ''}>
          <For each={depthStops}>{stop => <button type="button" class="depth-stop" aria-pressed={depth() === stop} title={`${depthLabels[stop]} (${stop === 'gloss' ? '[' : stop === 'full' ? ']' : '[ ]'})`}
            onClick={event => { if (depth() === stop && getComputedStyle(event.currentTarget.parentElement!.querySelector('.depth-label')!).display === 'none') setDepthMenu(event.currentTarget); else outlineCommand(`depth-${stop}`)?.run(); }}><Icon name={`depth-${stop}`} /><span class="visually-hidden">{depthLabels[stop]}</span></button>}</For>
          <span class="depth-label" aria-hidden="true">{depthLabels[depth()]}</span>
        </div></Show>
        <span class="pane-save-state" data-state={saveState()} title={doc()?.saveMessage()}><Show when={saveState() !== 'saved' && saveState() !== 'queued' && (saveState() !== 'saving' || slowSave())} fallback={<><span class="save-dot" /><span class="visually-hidden">{saveState() === 'saved' ? 'Saved' : 'Saving…'}</span></>}><Icon name={saveState() === 'offline' ? 'offline' : saveState() === 'error' || saveState() === 'conflict' ? 'warning' : 'saving'} />{status()}</Show></span>
        <Show when={props.vim && props.active}><span class="vim-mode" data-mode={props.vimMode ?? 'outline'} title={props.vimMode === 'insert' ? 'Vim: typing into the block' : props.vimMode === 'visual' ? 'Vim: selecting text' : props.vimMode === 'normal' ? 'Vim: commands inside the block' : 'Vim: moving between blocks'}>{vimLabels[props.vimMode ?? 'outline']}</span></Show>
      </Show>
      <Show when={!pageId() && current().target.kind !== 'field'}><Show when={current().target.kind === 'reader' ? current().target as Extract<OpenTarget, { kind: 'reader' }> : undefined} fallback={<span class="pane-breadcrumbs">{props.title ?? paneLabel(current().target)}</span>}>{target =>
        <nav class="pane-breadcrumbs" aria-label="Source breadcrumbs"><Button class="breadcrumb-library" onClick={event => props.onOpen({ kind: 'library' }, opensBeside(event))}>Library</Button><span class="breadcrumb-separator">/</span><Button onClick={event => props.onOpen({ kind: 'page', pageId: target().sourceId }, opensBeside(event))}>{props.notebook.lookup(target().sourceId)()?.text ?? 'Reader'}</Button></nav>
      }</Show><Show when={readerTarget() && root()?.kind === 'page'}><ProjectionTabs /></Show></Show>
      <Show when={current().target.kind === 'library'}>
        <span class="pane-save-state" data-state={librarySave().state} title={librarySave().message}>
          <Show when={librarySave().state !== 'saved'} fallback={<><span class="save-dot" /><span class="visually-hidden">Saved</span></>}>
            <Icon name={librarySave().state === 'error' ? 'warning' : 'saving'} />{librarySave().message || 'Saving…'}
          </Show>
        </span>
      </Show>
      <Show when={current().target.kind === 'field' ? current().target as Extract<OpenTarget, { kind: 'field' }> : undefined}>{target => <>
        <nav class="pane-breadcrumbs" aria-label="Field breadcrumbs"><Button onClick={event => props.onOpen({ kind: 'fields' }, opensBeside(event))}>Fields</Button><span class="breadcrumb-separator">/</span><Button onClick={event => props.onOpen({ kind: 'field', fieldId: target().fieldId }, opensBeside(event))}>{props.notebook.lookup(target().fieldId)()?.text ?? 'Definition'}</Button></nav>
        <Button disabled={!props.notebook.lookup(target().fieldId)()} onClick={event => { const field = props.notebook.lookup(target().fieldId)(); if (field) props.onOpen({ kind: 'page', pageId: field.page_id, blockId: field.id }, opensBeside(event)); }}>Blocks</Button>
      </>}</Show>
      <Show when={pageId()}><Button ref={menuButton} class="page-menu-button" icon="more" label="Page menu" aria-expanded={!!menu()} onClick={event => setMenu(value => value ? null : event.currentTarget)} /></Show>
      <Show when={props.split}><Button class="pane-secondary" icon="close" label="Close pane" shortcut="⌃⇧X" onClick={props.onClose} /></Show>
    </header>
    <Show when={pageId() && outlineView().zoom && projectionTabsShown() && projectionReason('read')}>{reason => <p class="page-projection-reason read-reason" id={`read-reason-${props.pane}`} role="status">{reason()}</p>}</Show>
    <Show when={doc()?.saveState() === 'error' || doc()?.saveState() === 'conflict'}><div class="pane-error" role="alert">{doc()?.saveMessage()}</div></Show>
    <Show when={copyMessage() && !menu()}><p class="page-projection-reason" role="status">{copyMessage()}</p></Show>
    <div ref={content} class="pane-content"><Show keyed when={props.session().generation}>{generation => <Switch fallback={<OutlinePane pane={props.pane} pageId={pageId()!} projection={projection()} onProjection={setProjection} projectionReason={projectionReason} journalPeriod={current().target.kind === 'page' ? (current().target as Extract<OpenTarget, { kind: 'page' }>).journalPeriod : undefined} view={copyView(outlineView())} onDelete={anchor => props.onDelete(anchor, true)} onNoteKinds={kinds => { if (generation === props.session().generation) setPageKinds(kinds); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} active={props.active} onActivate={() => { if (generation === props.session().generation && document.activeElement?.closest('.pane')?.getAttribute('data-pane') === props.pane) props.onActivate(); }} vim={props.vim} onVimMode={props.onVimMode} commands={props.commands} notebook={props.notebook} />}>
      <Match when={current().target.kind === 'table'}><TablePane pane={props.pane} neighbour={props.neighbour} target={current().target as Extract<OpenTarget, { kind: 'table' }>} view={snapshotView(current().view) as TableViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onTargetChange={target => { if (generation === props.session().generation) props.onTargetChange(target); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onDeletePages={props.onDeleteSources} /></Match>
      <Match when={current().target.kind === 'fields'}><FieldsPane typeId={(current().target as Extract<OpenTarget, { kind: 'fields' }>).typeId} view={snapshotView(current().view) as FieldsViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'field'}><FieldPane target={current().target as Extract<OpenTarget, { kind: 'field' }>} view={snapshotView(current().view) as FieldViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onTargetChange={target => { if (generation === props.session().generation) props.onTargetChange(target); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'cards' ? current().target as Extract<OpenTarget, { kind: 'cards' }> : undefined}>{target => <CardTemplatesPane typeId={target().typeId} applyId={target().applyId} view={snapshotView(current().view) as FieldsViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(next, beside) => { if (generation === props.session().generation) props.onOpen(next, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} />}</Match>
      <Match when={current().target.kind === 'settings' ? current().target as Extract<OpenTarget, { kind: 'settings' }> : undefined}>{target => <SettingsPane pane={props.pane} view={snapshotView(current().view) as SettingsViewState} section={target().section} deviceId={target().deviceId} notebook={props.notebook} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} />}</Match>
      <Match when={current().target.kind === 'compare' ? current().target as Extract<OpenTarget, { kind: 'compare' }> : undefined}>{target => <ComparePane subjectId={target().subjectId} view={snapshotView(current().view) as CompareViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(next, beside) => { if (generation === props.session().generation) props.onOpen(next, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} />}</Match>
      <Match when={current().target.kind === 'spread' ? current().target as Extract<OpenTarget, { kind: 'spread' }> : undefined}>{target => <SpreadPane noteIds={target().noteIds} notebook={props.notebook} onActivate={props.onActivate} onChange={noteIds => props.onTargetChange({ kind: 'spread', noteIds })} onOpen={(next, beside) => { if (generation === props.session().generation) props.onOpen(next, beside); }} />}</Match>
      <Match when={current().target.kind === 'index' ? current().target as Extract<OpenTarget, { kind: 'index' }> : undefined}>{target => <IndexPane kindKey={target().key} neighbour={props.neighbour} kind={props.noteKind} view={snapshotView(current().view) as IndexViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(next, beside) => { if (generation === props.session().generation) props.onOpen(next, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onDeletePages={props.onDeleteSources} onSpread={(noteIds, beside) => { if (generation === props.session().generation) props.onOpen({ kind: 'spread', noteIds }, beside); }} />}</Match>
      <Match when={current().target.kind === 'agenda'}><AgendaPane pane={props.pane} view={snapshotView(current().view) as AgendaViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'review'}><ReviewPane pane={props.pane} view={snapshotView(current().view) as ReviewViewState} notebook={props.notebook} commands={props.commands} active={props.active} onActivate={props.onActivate} onCreate={props.onCreate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'library'}><LibraryPane pane={props.pane} view={snapshotView(current().view) as LibraryViewState} notebook={props.notebook} active={props.active} neighbour={props.neighbour}
        add={(current().target as Extract<OpenTarget, { kind: 'library' }>).add}
        details={(current().target as Extract<OpenTarget, { kind: 'library' }>).details}
        onAddOpened={() => props.onTargetChange({ kind: 'library', tab: (current().target as Extract<OpenTarget, { kind: 'library' }>).tab })}
        onDetailsOpened={() => props.onTargetChange({ kind: 'library', tab: (current().target as Extract<OpenTarget, { kind: 'library' }>).tab })}
        onSaveState={(state, message) => { if (generation === props.session().generation) setLibrarySave({ state, message: message ?? '' }); }}
        onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }}
        onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onDeleteSources={props.onDeleteSources} /></Match>
      <Match when={current().target.kind === 'reader'}><ReaderPane pane={props.pane} target={current().target as Extract<OpenTarget, { kind: 'reader' }>} view={snapshotView(current().view) as ReaderViewState} notebook={props.notebook} active={props.active} immersive={props.immersive} onImmersive={props.onImmersive} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }}
        onBack={() => { if (props.session().index > 0) props.onTravel(-1); else props.onOpen({ kind: 'page', pageId: (current().target as Extract<OpenTarget, { kind: 'reader' }>).sourceId }, false); }} /></Match>
    </Switch>}</Show></div>
    <Show when={menu()}>{anchor => <Menu anchor={anchor()} label="Page actions" title="Page actions" context={root()?.text} items={items()} onDismiss={() => setMenu(null)} header={
      <Show when={props.notebook.roots().find(page => page.id === pageId())}>{page => <div class="page-menu-info">
        <b>{page().id}</b>
        <Button class="bordered" onClick={() => { void copyPage(false); }}>{copyMessage() === 'Copied ID' ? 'Copied' : 'Copy ID'}</Button>
        <span>Created {new Intl.DateTimeFormat('en-CA', { timeZone: props.notebook.settings()?.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(page().created_at)}</span>
        <Show when={copyMessage()}><span class={copyMessage().startsWith("Couldn't copy:") ? 'error' : 'visually-hidden'} role="status">{copyMessage()}</span></Show>
      </div>}</Show>
    } />}</Show>
    <Show when={depthMenu()}>{anchor => <Menu anchor={anchor()} label="Depth" onDismiss={() => setDepthMenu(null)}
      items={depthStops.map(stop => ({ label: depthLabels[stop], icon: `depth-${stop}` as const, checked: depth() === stop, action: () => outlineCommand(`depth-${stop}`)?.run() }))} />}</Show>
    <Show keyed when={mergeFrom()}>{from => <PageMergePicker anchor={menuButton} notebook={props.notebook} from={from} onDismiss={() => setMergeFrom(undefined)} onMerged={id => { setMergeFrom(undefined); props.onOpen({ kind: 'page', pageId: id }, false); }} />}</Show>
  </section>;
}
