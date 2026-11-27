import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Block, Type, View, WorkshopInfo } from '../api/types';
import { mac } from '../core/beside';
import type { WorkshopClient } from '../document/contract';
import { createWorkshopClient, type Workshop } from '../workflows/workshop';
import { bindSyncApi } from '../sync/state';
import { displayTitle } from '../outline/names';
import { ReferencePreviews } from '../outline/ReferencePreview';
import { builtInTagReason } from '../outline/PageMerge';
import { copyTaskQuery, createTaskQuery } from '../tasks/query';
import { copyQuery, typeQuery } from '../table/query';
import { fieldLabel } from '../fields/kinds';
import { querySources } from '../table/attributes';
import { deskTarget } from '../desk/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { installInputModality } from '../ui/input-modality';
import { dismissNotice, showNotice as showToast } from '../ui/Notice';
import { Popup, type PopupAnchor } from '../ui/Popup';
import { crossfade, navigatePane, reflowPanes } from '../ui/pane-motion';
import { installTabRule } from '../ui/tab-rule';
import { isNarrow, isPhone, isTabbed, isVirtualKeyboardOpen, matchesReducedMotion } from '../ui/viewport';
import { createVisualViewport } from '../ui/visual-viewport';
import { pendingCaretInput } from '../ui/pending-caret';
import { Calendar } from '../tasks/Calendar';
import { localDate } from '../tasks/MonthGrid';
import { createCommandRegistry } from './commands';
import { deskCounts } from '../workflows/desk-counts';
import type {
  Command,
  HistoryEntry,
  OpenTarget,
  PagePresentation,
  PaneHistory,
  PaneId,
  PaneSession,
  PaneView,
  PhoneTab,
  RevisitsViewState,
  ViewState,
} from '../core/contract';
import {
  activatePhoneTab,
  adoptPhoneTab,
  collapsePhoneLanding,
  passiveHistory,
  phoneTabs,
  popPhoneTab,
  pushPhoneEntry,
} from './phone-navigation';
import { installPhoneGestures } from './phone-gestures';
import { Palette } from './Palette';
import { DeletedPages } from './DeletedPages';
import { Shortcuts } from './Shortcuts';
import { installDisclosureMotion } from './disclosure';
import { createRetained } from '../core/retained';
import { installOpenedFiles } from '../library/opened-files';
import { installQuickCapture } from './quick-capture';
import { installHomeShortcuts } from './home-shortcuts';
import { besideSlot, insertPane, journalTurn, MAX_PANES, paneCapacity, revealedStart, windowStart } from './pane-row';
import { paneModules } from './pane-modules';
import { copyView, pageIdOf, paneLabel, snapshotView } from './pane-state';
import type { VimMode } from './pane-state';
import { GlobalBanner } from './GlobalBanner';
import { WorkshopContext, type WorkshopShell } from './context';
import { Pane } from './Pane';
import { PaneDivider } from './PaneDivider';
import { createPaneDragGuide } from './pane-drag';
import { SidebarNav } from './SidebarNav';
import { blankCapture, createEvent } from '../create/request';
import { resumeLinkImports } from '../create/link-import';
import type { CreateOptions, CreateRequest } from '../create/request';
import type { CreateNotice } from '../create/CreateSlip';
import { creatableKinds, kindNoun } from '../create/kinds';
import { installLinkDrop } from '../create/link-drop';
import { SyncCover, SyncLifecycle, SyncMark, currentHealth } from '../sync/SyncStatus';
import { WorkshopOpening, registerWorkshopCommands } from '../settings/notebooks';
import { kindLabel, noteIndex } from '../notes/kinds';
import { DEMO } from '../core/mode';
import type { ContextChip } from '../agent/AgentDock';
import { AgentMarks } from '../agent/marks';
import { createAgentSession } from '../agent/session';
import type { ContextRef } from '../api/types';

const CreateSlip = lazy(() => import('../create/CreateSlip').then(module => ({ default: module.CreateSlip })));
const AgentDock = lazy(() => import('../agent/AgentDock').then(module => ({ default: module.AgentDock })));

/** How long the deletion toast stays when nothing rests on it. */
const UNDO_TOAST_MS = 8000;

function HolderDeletionImpact(props: { workshop: WorkshopClient; pageId: string | undefined }) {
  const [count] = createResource(
    () => (props.pageId ? ([props.pageId, props.workshop.changed('inquiry')] as const) : false),
    async ([holder]) => {
      const result = await props.workshop.api.positions({ holder });
      return result.rows.filter(row => row.block.page.id !== holder).length;
    },
  );
  return (
    <div>
      <Show when={count.error}>
        <p class="muted">Could not load holder attribution impact.</p>
      </Show>
      <Show when={count()}>
        {total => (
          <p class="muted">
            {total()} {total() === 1 ? 'perspective keeps' : 'perspectives keep'} this holder’s last-known name, marked
            Deleted holder. Use Change holder there to repair the attribution.
          </p>
        )}
      </Show>
    </div>
  );
}

/** How many Back and Forward steps each side of a pane's current entry are kept across a reload. */
const SAVED_HISTORY = 10;
type SavedNavigation = {
  pinned?: string[];
  pinnedViews?: string[];
  pagePresentations?: Record<string, PagePresentation>;
  pageStyles?: Record<string, 'bullets' | 'prose'>;
  recent?: string[];
  vim?: boolean;
  panes?: Record<PaneId, HistoryEntry>;
  histories?: Record<PaneId, PaneHistory>;
  phone?: Record<PaneId, { tab: PhoneTab; stacks: Partial<Record<PhoneTab, PaneHistory>> }>;
  order?: PaneId[];
  widths?: Record<PaneId, number>;
  active?: PaneId;
};
type PopupState = {
  kind: 'search' | 'commands' | 'calendar' | 'new-view' | 'delete' | 'restore-pages' | 'layout' | 'shortcuts';
  anchor: HTMLElement;
  pane: PaneId;
  date?: string;
  source?: boolean;
} | null;
const emptySession = (): PaneSession => ({ entries: [], index: -1, generation: 0 });
let paneSequence = 0;
const newPaneId = (): PaneId => `pane-${Date.now().toString(36)}-${++paneSequence}`;
/** Kinds that list things: a list fills the pane at its right and keeps focus, so the next row is one key away. */
const listKinds: Partial<Record<OpenTarget['kind'], true>> = { library: true, index: true, table: true };

function targetFromView(entry: HistoryEntry): OpenTarget {
  const { target, view } = entry;
  if (target.kind === 'index' && 'noteQuery' in view)
    return { ...target, query: view.noteQuery ? copyQuery(view.noteQuery) : undefined, viewId: view.viewId };
  if (target.kind === 'table' && 'query' in view && !('mode' in view))
    return { ...target, query: copyQuery(view.query), typeId: view.query.type };
  if (target.kind === 'agenda' && 'mode' in view)
    return {
      kind: 'agenda',
      date: view.date,
      mode: view.mode,
      viewId: view.viewId ?? undefined,
      query: copyTaskQuery(view.query),
    };
  if (target.kind === 'review' && 'deckId' in view) return { kind: 'review', deckId: view.deckId ?? undefined };
  if (target.kind === 'revisits') return { kind: 'revisits', revisitId: (view as RevisitsViewState).revisitId };
  if (target.kind === 'library' && 'tab' in view)
    return { kind: 'library', tab: view.tab, collection: view.collection ?? undefined };
  // A jump not yet performed (no position reported) survives a reload.
  if (target.kind === 'reader' && 'ordinal' in view)
    return view.ordinal < 0
      ? { ...target, snapshotId: view.snapshotId ?? target.snapshotId }
      : { kind: 'reader', sourceId: target.sourceId, snapshotId: view.snapshotId ?? undefined };
  if (target.kind === 'page' && 'zoom' in view)
    return { kind: 'page', pageId: target.pageId, blockId: view.zoom ?? undefined };
  return target;
}

export function App(props: { onWorkshop?(workshop: Workshop): void } = {}) {
  installTabRule();
  const identityKey = `tessera.identity.${location.origin}`;
  let cachedIdentity: WorkshopInfo | undefined;
  try {
    const value = JSON.parse(localStorage.getItem(identityKey) ?? 'null') as WorkshopInfo | null;
    if (value && typeof value.id === 'string' && typeof value.path === 'string') cachedIdentity = value;
  } catch {
    /* A first offline visit has no cached workshop identity. */
  }
  const workshop = createWorkshopClient({ workshopId: cachedIdentity?.id });
  bindSyncApi(workshop.api);
  onCleanup(() => {
    void workshop.dispose();
  });
  props.onWorkshop?.(workshop);
  const commands = createCommandRegistry();
  const [info] = createResource(async () => {
    try {
      const value = await workshop.api.workshop();
      try {
        localStorage.setItem(identityKey, JSON.stringify(value));
      } catch {
        /* Drafts remain in IndexedDB even if this recovery hint cannot persist. */
      }
      return value;
    } catch {
      return cachedIdentity;
    }
  });
  const [views] = createResource(
    () => (workshop.connection() === 'live' ? workshop.changed('views') : false),
    async () => {
      try {
        return await workshop.api.views();
      } catch (reason) {
        reportError(reason);
        return [];
      }
    },
  );
  const [sessions, setSessions] = createSignal<Record<PaneId, PaneSession>>({ main: emptySession() });
  /** The panes left to right; the first is 'main' until it closes. */
  const [order, setOrder] = createSignal<PaneId[]>(['main']);
  /** Relative widths from dragging dividers; a pane without one takes 1. */
  const [weights, setWeights] = createSignal<Record<PaneId, number>>({});
  const [active, setActive] = createSignal<PaneId>('main');
  const vim = workshop.vim;
  const [vimModes, setVimModes] = createSignal<Record<PaneId, VimMode>>({});
  const narrow = isNarrow;
  const cover = isPhone;
  const [sidebar, setSidebar] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const sidebarVisible = () => !cover() && (narrow() ? sidebar() : !sidebarCollapsed());
  const toggleSidebar = () => {
    if (cover()) open({ kind: 'directory' });
    else if (narrow()) setSidebar(value => !value);
    else setSidebarCollapsed(value => !value);
  };
  /** Below the desktop breakpoint the sidebar is a modal overlay: it takes focus, the scrim covers the panes, Escape closes it. */
  const overlayOpen = () => !cover() && narrow() && sidebar();
  // Android resizes the WebView; browsers can resize only the visual viewport.
  const viewport = createVisualViewport();
  const keyboard = () => isVirtualKeyboardOpen(viewport().height);
  // Long-pressing Library in the bottom nav lists the types in use, each opening its table.
  const [typesMenu, setTypesMenu] = createSignal<{ anchor: HTMLElement; types: Type[] } | null>(null);
  const [questionsMenu, setQuestionsMenu] = createSignal<HTMLElement>();
  const showTypes = async (anchor: HTMLElement) => {
    try {
      setTypesMenu({ anchor, types: await workshop.api.types() });
    } catch (reason) {
      reportError(reason);
    }
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
  const [deleted, setDeleted] = createSignal<{
    pages: { id: string; title: string }[];
    label: string;
    reopen: boolean;
  } | null>(null);
  const [retainedDeletions] = createResource(
    () => workshop.changed('pages'),
    () => workshop.api.deletedPages(),
  );
  const [deletionUndoSequence, setDeletionUndoSequence] = createSignal<number | null>(null);
  createEffect(() => {
    const sequence = deletionUndoSequence();
    if (sequence !== null && (workshop.changeSequence() !== sequence || workshop.saveState() !== 'saved'))
      setDeletionUndoSequence(null);
  });
  /** Notices share the deletion toast's lifetime and pause while hovered or focused (ui/Notice.tsx). */
  const showNotice = (value: CreateNotice) => {
    showToast({ text: value.message, action: value.actions, duration: UNDO_TOAST_MS, onError: reportError });
  };
  const todayDate = () => workshop.todayDate();
  const counts = deskCounts(workshop, todayDate);
  let searchButton!: HTMLButtonElement;
  let sidebarToggle!: HTMLButtonElement;
  let sidebarElement!: HTMLElement;
  const entry = (pane: PaneId) => {
    const session = sessions()[pane];
    return session?.entries[session.index];
  };
  const split = () => order().length > 1;
  const activeRoot = () => workshop.roots().find(root => root.id === pageIdOf(entry(active())));
  const journalDate = (pane: PaneId) => {
    if (pendingJournals[pane]) return pendingJournals[pane]!.date;
    const root = workshop.roots().find(root => root.id === pageIdOf(entry(pane)));
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
    return (navigationRequests[pane] = (navigationRequests[pane] ?? 0) + 1);
  };
  onCleanup(() => {
    pendingCaretInput.cancel();
    for (const pane of order()) cancelNavigation(pane);
  });
  const focusPane = (pane: PaneId) => {
    const epoch = ++focusEpoch;
    const deadline = performance.now() + 2000;
    // Where focus sat when navigation began (the sidebar button, or nothing): the only places a retry may take it from.
    const origin = document.activeElement;
    // A lazy pane has no content while its module loads and its data resolves: retry each frame until it has settled
    // (its pending and loading markers clear) or two seconds pass. A press, a key or a newer focusPane cancels the
    // retries, and so does focus landing anywhere else: a retry never pulls focus from where the user moved it.
    const typed = () => {
      if (epoch === focusEpoch) focusEpoch++;
    };
    window.addEventListener('keydown', typed, true);
    const stop = () => window.removeEventListener('keydown', typed, true);
    const attempt = () => {
      if (epoch !== focusEpoch) {
        stop();
        return;
      }
      const retry = () => {
        if (performance.now() < deadline) requestAnimationFrame(attempt);
        else stop();
      };
      const root = document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"]`);
      if (!root) {
        retry();
        return;
      }
      setActive(pane);
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== origin && !root.contains(focused)) {
        stop();
        return;
      }
      const settled = !root.querySelector('[data-pane-pending], [data-pane-loading]');
      if (!root.contains(document.activeElement)) {
        const editor = cover() ? null : root.querySelector<HTMLElement>('.cm-content');
        const target = editor?.getClientRects().length
          ? editor
          : (root.querySelector<HTMLElement>('.review-card') ??
            root.querySelector<HTMLElement>(
              '.outline-pane, .table-pane, .research-desk, .fields-pane, .field-page-pane, .settings-pane, .agenda-pane, .review-pane, .notes-review, .library-pane, .index-pane, .directory-pane',
            ));
        if (!target) {
          retry();
          return;
        }
        if (!target.hasAttribute('tabindex') && !target.isContentEditable) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
      if (!settled || !root.contains(document.activeElement)) retry();
      else stop();
    };
    requestAnimationFrame(attempt);
  };
  /**
   * Opens `target` in `owner`, or beside it: in the pane right of `owner`, or in a new pane there. `insertAt` opens a
   * new pane at that position in the row instead, as a drop between panes does. `turn` is the way the leaf turns:
   * forward from the right, or back from the left, as for an earlier journal day.
   */
  const open = (
    target: OpenTarget,
    beside = false,
    owner = active(),
    restore?: PaneView,
    insertAt?: number,
    turn: 'forward' | 'back' = 'forward',
  ) => {
    beside = beside && canOpenBeside(owner);
    const slot =
      insertAt !== undefined
        ? { index: insertAt, existing: null }
        : beside
          ? besideSlot(order(), owner)
          : { index: -1, existing: owner };
    const pane: PaneId = slot.existing ?? newPaneId();
    // Explicit editing requests activate their destination, even when a list reuses a folded neighbour.
    const keepFocus =
      beside &&
      !!slot.existing &&
      !(target.kind === 'page' && target.caretId) &&
      !!listKinds[entry(owner)?.target.kind ?? 'page'];
    const request = cancelNavigation(pane);
    if (target.kind === 'page' && target.caretId) pendingCaretInput.begin(pane, target.caretId);
    else pendingCaretInput.cancel();
    if (target.kind === 'agenda' && target.viewId && !target.query) {
      void workshop.api
        .taskView(target.viewId)
        .then(saved => {
          if (request === navigationRequests[pane])
            open(
              { ...target, query: saved.query, date: target.date ?? saved.query.context_date },
              beside,
              owner,
              restore,
              insertAt,
              turn,
            );
        })
        .catch(reason => {
          if (request === navigationRequests[pane]) reportError(reason);
        });
      return;
    }
    const current = entry(pane);
    if (target.kind === 'review' && current?.target.kind === 'review' && 'deckId' in current.view) {
      // One-shot requests keep the open review in place so the pane can handle or confirm them.
      const next =
        restore && 'deckId' in restore
          ? { ...restore }
          : target.blockId || target.start
            ? { ...current.view, blockId: target.blockId, start: target.start }
            : { deckId: target.deckId ?? null, sessionId: null, selection: null, scroll: 0 };
      if (restore || target.blockId || target.start || next.deckId !== current.view.deckId) changeView(pane, next);
      if (keepFocus) {
        setActive(owner);
        reveal(pane, owner);
        focusPane(owner);
      } else {
        setActive(pane);
        setSidebar(false);
        focusPane(pane);
      }
      return;
    }
    // Explicit caret, reading and journal ledger requests rebuild even when the same page is already open beside.
    const samePage =
      target.kind === 'page' &&
      !target.caretId &&
      !target.readAt &&
      !target.revealId &&
      !target.editOcclusion &&
      !target.journalPeriod &&
      current?.target.kind === 'page' &&
      current.target.pageId === target.pageId &&
      'zoom' in current.view &&
      current.view.zoom === (target.blockId ?? null);
    if (!beside || !samePage) {
      const date = target.kind === 'agenda' ? (target.date ?? target.query?.context_date ?? todayDate()) : '';
      const view: PaneView = restore
        ? snapshotView(restore)
        : target.kind === 'table'
          ? { query: copyQuery(target.query), scroll: 0 }
          : target.kind === 'agenda'
            ? {
                date,
                mode: target.mode ?? (target.query || target.viewId ? 'tasks' : 'agenda'),
                query: { ...(target.query ? copyTaskQuery(target.query) : createTaskQuery(date)), context_date: date },
                viewId: target.viewId ?? null,
                scroll: 0,
              }
            : target.kind === 'review'
              ? {
                  deckId: target.deckId ?? null,
                  sessionId: null,
                  selection: null,
                  scroll: 0,
                  ...(target.blockId ? { blockId: target.blockId } : {}),
                  ...(target.start ? { start: target.start } : {}),
                }
              : target.kind === 'revisits'
                ? { scroll: 0, revisitId: target.revisitId }
                : target.kind === 'index'
                  ? { scroll: 0, noteQuery: target.query ? copyQuery(target.query) : undefined, viewId: target.viewId }
                  : target.kind === 'directory' ||
                      target.kind === 'fields' ||
                      target.kind === 'field' ||
                      target.kind === 'cards' ||
                      target.kind === 'settings' ||
                      target.kind === 'history' ||
                      target.kind === 'compare' ||
                      target.kind === 'spread'
                    ? { scroll: 0 }
                    : target.kind === 'library'
                      ? {
                          view: null,
                          tab: target.collection ? 'collections' : (target.tab ?? 'inbox'),
                          collection: target.collection ?? null,
                          text: '',
                          sort: 'added',
                          filters: { people: [], decades: [], years: [], publishers: [], languages: [] },
                          group: 'none',
                          unprocessedOnly: true,
                          colors: [],
                          tags: [],
                          scroll: 0,
                        }
                      : target.kind === 'reader'
                        ? { snapshotId: target.snapshotId ?? null, ordinal: -1, offset: 0 }
                        : target.revealId
                          ? {
                              zoom: null,
                              caret: null,
                              scroll: { id: target.revealId, offset: 0 },
                              folds: null,
                              showArchived: false,
                              projection: 'outline',
                              reveal: target.revealId,
                            }
                          : target.readAt
                            ? {
                                zoom: null,
                                caret: { id: target.readAt, offset: 0 },
                                scroll: { id: target.readAt, offset: 0 },
                                folds: null,
                                showArchived: false,
                                projection: 'read',
                                reveal: target.readAt,
                              }
                            : {
                                zoom: target.blockId ?? null,
                                caret:
                                  target.caretId || target.blockId
                                    ? { id: target.caretId ?? target.blockId!, offset: target.caretOffset ?? 0 }
                                    : null,
                                scroll: null,
                                folds: null,
                                showArchived: false,
                                projection: target.caretId ? 'outline' : pagePresentations()[target.pageId]?.projection,
                                ...(target.caretId ? { edit: true } : {}),
                                ...(target.editOcclusion && target.blockId ? { editOcclusion: target.blockId } : {}),
                              };
      // Editing needs its live caret now, not after the outgoing view-transition snapshot.
      const arriveAtTarget = () => {
        batch(() => {
          if (target.kind === 'page' && target.readAt)
            setPagePresentations(values => ({
              ...values,
              [target.pageId]: { ...values[target.pageId], projection: 'read' },
            }));
          setSessions(values => {
            const previous = values[pane] ?? emptySession();
            const next = cover()
              ? pushPhoneEntry(previous, { target, view })
              : {
                  ...previous,
                  entries: [...previous.entries.slice(0, previous.index + 1), { target, view }],
                  index: previous.index + 1,
                  generation: previous.generation + 1,
                };
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
      else navigatePane(pane, turn, arriveAtTarget, target.kind === 'page' ? target.pageId : undefined);
    } else if (revealedStart(order(), fit(), start(), pane, keepFocus ? owner : undefined) !== start())
      reflowPanes(arrive);
    else arrive();
    function arrive() {
      setSidebar(false);
      if (target.kind === 'page') remember(target.pageId);
      if (keepFocus) {
        setActive(owner);
        reveal(pane, owner);
        focusPane(owner);
        return;
      }
      setActive(pane);
      reveal(pane);
      // The outline owns explicit editing focus; a region focus while it loads would swallow buffered typing.
      if (target.kind === 'page' && target.caretId) ++focusEpoch;
      else focusPane(pane);
    }
  };
  const changeView = (pane: PaneId, view: PaneView, restore = false) =>
    setSessions(values => {
      const session = values[pane];
      const current = session?.entries[session.index];
      if (!session || !current) return values;
      if ('zoom' in view && 'zoom' in current.view && view.zoom !== current.view.zoom) {
        const entries = [
          ...session.entries.slice(0, session.index + 1),
          { target: current.target, view: copyView(view) },
        ];
        return {
          ...values,
          [pane]: { ...session, entries, index: session.index + 1, generation: session.generation + (restore ? 1 : 0) },
        };
      }
      const entries = [...session.entries];
      entries[session.index] = { target: targetFromView({ target: current.target, view }), view: snapshotView(view) };
      return { ...values, [pane]: { ...session, entries, generation: session.generation + (restore ? 1 : 0) } };
    });
  const changeTarget = (pane: PaneId, target: OpenTarget) =>
    setSessions(values => {
      const session = values[pane];
      if (!session) return values;
      const entries = [...session.entries];
      entries[session.index] = { ...entries[session.index]!, target };
      return { ...values, [pane]: { ...session, entries } };
    });
  const travel = (pane: PaneId, delta: number, interactive = false) => {
    const session = sessions()[pane];
    if (!session) return;
    const index = session.index + delta;
    if (index < 0 || index >= session.entries.length) return;
    pendingCaretInput.cancel();
    cancelNavigation(pane);
    const arrive = () => {
      // A second Back pressed before the first turn applied steps from where the first one lands.
      const latest = sessions()[pane];
      if (!latest) return;
      const next = latest.index + delta;
      if (next < 0 || next >= latest.entries.length) return;
      const restored = cover() ? passiveHistory(latest) : latest;
      setSessions(values => ({ ...values, [pane]: { ...restored, index: next, generation: latest.generation + 1 } }));
      setActive(pane);
      const pageId = pageIdOf(latest.entries[next]);
      if (pageId) remember(pageId);
      focusPane(pane);
    };
    if (interactive) arrive();
    else
      navigatePane(
        pane,
        delta < 0 ? 'back' : 'forward',
        arrive,
        pageIdOf(session.entries[index]) ?? pageIdOf(session.entries[session.index]),
      );
  };
  const journal = async (
    value: string | null,
    owner = active(),
    beside = false,
    journalPeriod?: Extract<OpenTarget, { kind: 'page' }>['journalPeriod'],
  ) => {
    beside = beside && canOpenBeside(owner);
    const pane: PaneId = beside ? (besideSlot(order(), owner).existing ?? `${owner}:beside`) : owner;
    // An earlier day than the one showing turns back, as Back does.
    const showing = workshop.roots().find(root => root.id === pageIdOf(entry(owner)));
    const turn = journalTurn(
      pendingJournals[owner]?.date ?? (showing?.kind === 'journal' ? showing.text : undefined),
      value ?? todayDate(),
    );
    const request = cancelNavigation(pane);
    const controller = new AbortController();
    pendingJournals[pane] = { date: value ?? todayDate(), controller };
    try {
      const pageId =
        value === null ? await workshop.today(controller.signal) : await workshop.journal(value, controller.signal);
      if (request === navigationRequests[pane])
        open(
          { kind: 'page', pageId, ...(journalPeriod ? { journalPeriod } : {}) },
          beside,
          owner,
          undefined,
          undefined,
          turn,
        );
    } catch (reason) {
      if (request === navigationRequests[pane]) reportError(reason);
    } finally {
      if (request === navigationRequests[pane]) delete pendingJournals[pane];
    }
  };
  const today = (pane = active(), beside = false) => journal(null, pane, beside);
  const shiftDate = (delta: number, pane = active()) => {
    const next = new Date(`${journalDate(pane)}T12:00:00`);
    next.setDate(next.getDate() + delta);
    void journal(localDate(next), pane);
  };
  const scrollPaneTop = () => {
    if (!cover()) return;
    const content = document.querySelector<HTMLElement>(`.pane[data-pane="${CSS.escape(active())}"] > .pane-content`);
    if (!content) return;
    const scrollers = [...content.querySelectorAll<HTMLElement>('*')].filter(
      element =>
        element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight &&
        /auto|scroll/.test(getComputedStyle(element).overflowY),
    );
    scrollers.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    scrollers[0]?.scrollTo({
      top: 0,
      behavior: matchesReducedMotion() ? 'instant' : 'smooth',
    });
  };
  const phoneTabFor = (session: PaneSession | undefined): PhoneTab => {
    if (session?.tab) return session.tab;
    for (let index = session?.index ?? -1; index >= 0; index--) {
      const target = session!.entries[index]!.target;
      if (target.kind === 'library' || target.kind === 'reader') return 'library';
      if (target.kind === 'agenda' || target.kind === 'review') return target.kind;
      if (
        target.kind === 'page' &&
        workshop.roots().some(root => root.id === target.pageId && root.kind === 'journal' && root.text === todayDate())
      )
        return 'today';
    }
    return 'today';
  };
  let phoneToday: { date: string; id: Promise<string> } | undefined;
  const phoneRoot = async (tab: PhoneTab): Promise<HistoryEntry> => {
    if (tab === 'today') {
      if (phoneToday?.date !== todayDate()) phoneToday = { date: todayDate(), id: workshop.today() };
      return {
        target: { kind: 'page', pageId: await phoneToday.id },
        view: { zoom: null, caret: null, scroll: null, folds: null, showArchived: false },
      };
    }
    if (tab === 'agenda') {
      const date = todayDate();
      return {
        target: { kind: 'agenda', date },
        view: { date, mode: 'agenda', query: createTaskQuery(date), viewId: null, scroll: 0 },
      };
    }
    if (tab === 'review')
      return { target: { kind: 'review' }, view: { deckId: null, sessionId: null, selection: null, scroll: 0 } };
    return {
      target: { kind: 'library' },
      view: {
        view: null,
        tab: 'inbox',
        collection: null,
        text: '',
        sort: 'added',
        filters: { people: [], decades: [], years: [], publishers: [], languages: [] },
        group: 'none',
        unprocessedOnly: true,
        colors: [],
        tags: [],
        scroll: 0,
      },
    };
  };
  const preparePhone = async (pane: PaneId) => {
    const session = sessions()[pane];
    // Initial Today opens through a deferred view transition. Adopt only after
    // that entry arrives, rather than seeding a root ahead of its pending push.
    if (!session?.entries[session.index] || session.tab) return;
    const tab = phoneTabFor(session),
      root = await phoneRoot(tab);
    setSessions(values =>
      values[pane] && !values[pane].tab ? { ...values, [pane]: adoptPhoneTab(values[pane], tab, root) } : values,
    );
  };
  let tabRequest = 0;
  /** A tab tap restores the tab's stack, or pops it when already there; `toRoot` always lands on the tab's root. */
  const selectPhoneTab = async (tab: PhoneTab, toRoot = false) => {
    const pane = active(),
      request = ++tabRequest;
    pendingCaretInput.cancel();
    const navigationRequest = cancelNavigation(pane);
    ++focusEpoch;
    await preparePhone(pane);
    const root = await phoneRoot(tab);
    if (!cover() || request !== tabRequest || pane !== active() || navigationRequest !== navigationRequests[pane])
      return;
    const session = sessions()[pane];
    if (!session) return;
    if (session.tab === tab && session.index === 0) {
      scrollPaneTop();
      return;
    }
    const switched = session.tab === tab ? popPhoneTab(session) : activatePhoneTab(session, tab, root);
    setSessions(values => ({ ...values, [pane]: passiveHistory(toRoot ? popPhoneTab(switched) : switched) }));
    setSidebar(false);
  };
  createEffect(() => {
    if (cover() && navigationId()) for (const pane of order()) void preparePhone(pane).catch(reportError);
  });
  onMount(() =>
    installPhoneGestures({
      cover,
      canBack: () => (sessions()[active()]?.index ?? 0) > 0 && entry(active())?.target.kind !== 'reader',
      back: () => travel(active(), -1, true),
      scrollTop: scrollPaneTop,
    }),
  );
  const paneElement = (pane: PaneId) => document.querySelector<HTMLElement>(`.pane[data-pane="${CSS.escape(pane)}"]`);
  /**
   * Makes `pane` the active one and brings it into view. Where the row is tabs, the pane on show swaps with a fade;
   * where a folded pane is revealed, the row glides; a pane already in view just takes focus.
   */
  const showPane = (pane: PaneId) => {
    const from = paneElement(active());
    const show = () => {
      setActive(pane);
      reveal(pane);
      focusPane(pane);
    };
    if (tabbed() && from) crossfade(from, show, () => paneElement(pane));
    else if (revealedStart(order(), fit(), start(), pane) !== start()) reflowPanes(show);
    else show();
  };
  /** Moves focus to the next pane in the row, wrapping at its end. */
  const switchPane = () => {
    if (!split()) return;
    const panes = order();
    showPane(panes[(panes.indexOf(active()) + 1) % panes.length]!);
  };
  /** Forgets a pane that left the row. Its state goes after the row has unmounted it. */
  const dropPane = (pane: PaneId) => {
    cancelNavigation(pane);
    setOrder(values => values.filter(value => value !== pane));
    const without = <T,>(values: Record<PaneId, T>) => {
      const { [pane]: _, ...rest } = values;
      return rest;
    };
    queueMicrotask(() =>
      batch(() => {
        setSessions(without);
        setWeights(without);
        setVimModes(without);
      }),
    );
  };
  /** Closing a pane hands focus to the pane that was left of it, or right of it when it was first. */
  const closePane = (pane: PaneId) => {
    if (!split()) return;
    reflowPanes(() => {
      // The drop runs after the transition starts: a second close in the same tick finds the row already down to one pane.
      const panes = order(),
        at = panes.indexOf(pane);
      if (panes.length < 2 || at < 0) return;
      const next = panes[at > 0 ? at - 1 : 1]!;
      dropPane(pane);
      setActive(next);
      reveal(next);
      focusPane(next);
    });
  };
  // Panes the window cannot fit fold into spines; `start` is the first pane shown. Below 840 px the row becomes tabs.
  const tabbed = isTabbed;
  const [rowWidth, setRowWidth] = createSignal(0);
  /** Opening beside must leave room for the source and destination; existing narrow panes still fold as before. */
  const canOpenBeside = (owner: PaneId) => {
    const count = Math.min(MAX_PANES, order().length + (besideSlot(order(), owner).existing ? 0 : 1));
    return !tabbed() && paneCapacity(rowWidth(), count) >= 2;
  };
  const besideReason = (owner: PaneId) => (canOpenBeside(owner) ? undefined : 'Needs a wider window');
  const [start, setStart] = createSignal(0);
  const fit = () => (tabbed() ? order().length : paneCapacity(rowWidth(), order().length));
  const shown = (pane: PaneId) => {
    const at = order().indexOf(pane);
    return tabbed() || (at >= start() && at < start() + fit());
  };
  /** Scrolls the row so `pane` shows, then `keep` if it can stay in view too. */
  const reveal = (pane: PaneId, keep?: PaneId) => setStart(revealedStart(order(), fit(), start(), pane, keep));
  // A narrower window or a closed pane keeps the active pane in view.
  createEffect(() => {
    const panes = order(),
      width = fit(),
      at = panes.indexOf(active());
    setStart(value => windowStart(panes.length, width, value, Math.max(0, at)));
  });
  // Full screen belongs to one reader pane. It ends when that pane shows something else or the other pane takes over.
  const [immersive, setImmersive] = createSignal<PaneId | null>(null);
  const [syncAnchor, setSyncAnchor] = createSignal<HTMLElement | null>(null);
  createEffect(() => {
    const pane = immersive();
    if (pane && (active() !== pane || entry(pane)?.target.kind !== 'reader')) setImmersive(null);
  });
  const immerse = (pane: PaneId, on: boolean) => {
    if (on) setActive(pane);
    setImmersive(on ? pane : null);
  };
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
    else if (!pane && previous && history.state?.tesseraImmersive) {
      popping = true;
      history.back();
    }
    return pane;
  }, null);
  const historyMoved = () => {
    if (popping) {
      popping = false;
      if (immersive()) history.pushState({ tesseraImmersive: true }, '');
      return;
    }
    if (!history.state?.tesseraImmersive) setImmersive(null);
  };
  window.addEventListener('popstate', historyMoved);
  onCleanup(() => window.removeEventListener('popstate', historyMoved));
  const pin = (id: string) =>
    setPinned(values => (values.includes(id) ? values.filter(value => value !== id) : [...values, id]));
  const pinView = (id: string) =>
    setPinnedViews(values => (values.includes(id) ? values.filter(value => value !== id) : [...values, id]));
  const openView = (view: View, beside = false, owner = active()) =>
    open(
      view.query.note_kind && view.query.note_view?.layout === 'index'
        ? { kind: 'index', key: view.query.note_kind, viewId: view.id, query: copyQuery(view.query) }
        : { kind: 'table', typeId: view.query.type, viewId: view.id, query: copyQuery(view.query) },
      beside,
      owner,
    );
  const showPalette = (kind: 'search' | 'commands') => {
    // One surface at a time: a draft slip keeps its text and takes the focus back, an untouched one makes way.
    if (creation()) {
      if (createDirty()) {
        refocusDraft();
        return;
      }
      setCreation(undefined);
    }
    setPopup({ kind, anchor: kind === 'search' ? searchButton : document.body, pane: active() });
  };
  /**
   * What was open when the current press began. A popup anchored to the page dismisses on that press, before its
   * opener's click runs, so the click alone cannot tell a second click on the opener from a first.
   */
  let pressedPopup: { state: PopupState; at: number } | undefined;
  /** An opener's click toggles its popup: a second click closes what the first opened instead of rebuilding it. */
  const toggleOpener = (kind: NonNullable<PopupState>['kind'], anchor: HTMLElement, open: () => void) => {
    const press = pressedPopup && performance.now() - pressedPopup.at < 600 ? pressedPopup : undefined;
    pressedPopup = undefined;
    const current = press ? press.state : popup();
    if (current?.kind === kind && current.anchor === anchor) setPopup(null);
    else open();
  };
  const chooseDate = (
    pane = active(),
    anchor: HTMLElement = document.querySelector<HTMLButtonElement>(`[data-pane="${pane}"] .journal-date`) ??
      searchButton,
  ) => {
    setPopup({ kind: 'calendar', anchor, pane, date: journalDate(pane) });
  };
  const runOutline = (suffix: string, pane = active()) =>
    commands
      .list()
      .find(command => command.id === `outline.${pane}.${suffix}`)
      ?.run();
  const reviewConflict = () => {
    const conflicted = workshop.conflictedPages();
    const pageId = conflicted.includes(pageIdOf(entry(active())) ?? '') ? pageIdOf(entry(active())) : conflicted[0];
    if (!pageId) return;
    const pane = order().find(owner => pageIdOf(entry(owner)) === pageId) ?? active();
    if (pageIdOf(entry(pane)) === pageId) setActive(pane);
    else open({ kind: 'page', pageId }, false, pane);
    requestAnimationFrame(() => runOutline('review-conflict', pane));
  };
  const openPageBeside = (pane = active()) => {
    if (!canOpenBeside(pane)) return;
    const current = entry(pane);
    if (current) open(targetFromView(current), true, pane, current.view);
  };
  const deletePage = async (pane: PaneId) => {
    const pageId = pageIdOf(entry(pane));
    if (!pageId) return;
    const title =
      workshop.lookup(pageId)()?.text ?? workshop.roots().find(block => block.id === pageId)?.text ?? 'Note';
    try {
      await deletePages([{ id: pageId, title }], undefined, true);
      setPopup(null);
    } catch (reason) {
      reportError(reason);
    }
  };
  /** Delete pages in one undoable step, and move panes showing them, or reading their sources, to another page. Undo reopens a page deleted from its own menu. */
  const deletePages = async (
    pages: { id: string; title: string }[],
    label = pages.length === 1 ? `“${pages[0]!.title}”` : `${pages.length} notes`,
    reopen = false,
  ) => {
    const capabilities = await Promise.all(pages.map(page => workshop.api.capabilities(page.id)));
    for (let index = 0; index < pages.length; index++) {
      const reason = builtInTagReason(pages[index]!.title, capabilities[index], 'delete');
      if (reason) throw new Error(reason);
    }
    const ids = new Set(pages.map(page => page.id)),
      roots = workshop.roots(),
      done: typeof pages = [];
    try {
      for (const page of pages) {
        await workshop.deletePage(page.id);
        done.push(page);
      }
    } finally {
      if (done.length) {
        const message = `${done.length === pages.length ? label : `${done.length} notes`} deleted`;
        setDeleted({ pages: done, label: done.length === pages.length ? label : `${done.length} notes`, reopen });
        showNotice({ message, actions: [{ label: 'Undo', run: restorePage }] });
        const remaining = workshop.roots().find(block => !ids.has(block.id));
        const previousDay = new Date(`${todayDate()}T12:00:00`);
        previousDay.setDate(previousDay.getDate() - 1);
        const deletedToday = roots.some(
          root => ids.has(root.id) && root.kind === 'journal' && root.text === todayDate(),
        );
        // Do not recreate a deleted journal date: that would prevent restoring its IDs.
        const replacement = async () =>
          remaining?.id ?? (deletedToday ? await workshop.journal(localDate(previousDay)) : await workshop.today());
        for (const owner of order()) {
          const current = entry(owner);
          if (
            ids.has(pageIdOf(current) ?? '') ||
            (current?.target.kind === 'reader' && ids.has(current.target.sourceId))
          )
            open({ kind: 'page', pageId: await replacement() }, false, owner);
        }
        setDeletionUndoSequence(workshop.changeSequence());
      }
    }
  };
  const [deleteCapabilities] = createResource(
    () => {
      const state = popup();
      const id = state?.kind === 'delete' ? pageIdOf(entry(state.pane)) : undefined;
      return id ? ([id, workshop.changeSequence()] as const) : false;
    },
    ([id]) => workshop.api.capabilities(id),
  );
  const deleteDisabledReason = (pane: PaneId) => {
    const id = pageIdOf(entry(pane));
    const title = workshop.lookup(id ?? '')()?.text ?? rootById().get(id ?? '')?.text ?? '';
    return deleteCapabilities.error
      ? String(deleteCapabilities.error)
      : !deleteCapabilities()
        ? 'Note is still loading.'
        : builtInTagReason(title, deleteCapabilities(), 'delete');
  };
  const restorePage = async () => {
    const latest = retainedDeletions.error ? undefined : retainedDeletions()?.[0]?.block;
    const value =
      deleted() ??
      (latest ? { pages: [{ id: latest.id, title: latest.text }], label: `“${latest.text}”`, reopen: true } : null);
    if (!value) return;
    setDeletionUndoSequence(null);
    try {
      for (const page of value.pages) await workshop.restorePage(page.id);
      batch(() => {
        setDeleted(null);
        dismissNotice();
      });
      if (value.reopen) open({ kind: 'page', pageId: value.pages[0]!.id });
    } catch (reason) {
      reportError(reason);
    }
  };
  const [creation, setCreation] = createSignal<{
    request: CreateRequest;
    anchor?: PopupAnchor;
    pane: PaneId;
    options?: CreateOptions;
  }>();
  const [createDirty, setCreateDirty] = createSignal(false);
  // Opening cancels a pane refocus still pending from a slip that just closed, which would take the new slip's focus.
  const openCreate = (request: CreateRequest, anchor?: PopupAnchor, options?: CreateOptions) => {
    focusEpoch++;
    setPopup(null);
    setTypesMenu(null);
    setCreateDirty(false);
    setCreation({ request, anchor, pane: active(), options });
  };
  /** A shortcut or widget tap while a draft is open returns to that draft; only a request carrying text replaces it. */
  const quickCreate = (request: CreateRequest) => {
    if (!creation() || !createDirty() || request.text) {
      openCreate(request);
      return;
    }
    refocusDraft();
  };
  const refocusDraft = () => {
    const field = document.querySelector<HTMLElement>('.create-slip textarea, .create-slip input:not([type="file"])');
    if (field) {
      field.blur();
      field.focus();
    }
  };
  /** Saving or Escape leaves focus where the slip opened from. */
  const closeCreate = () => {
    setCreation(undefined);
    queueMicrotask(() => {
      if (document.activeElement === document.body) focusPane(active());
    });
  };
  onMount(() => {
    onCleanup(installLinkDrop(openCreate));
    resumeLinkImports(workshop);
    const requested = (event: Event) => {
      if (event instanceof CustomEvent && event.detail) openCreate(event.detail as CreateRequest);
    };
    window.addEventListener(createEvent, requested);
    onCleanup(() => window.removeEventListener(createEvent, requested));
    const nativeOpen = (event: Event) => {
      const target = event instanceof CustomEvent ? event.detail : undefined;
      if (
        !target ||
        target.kind !== 'page' ||
        typeof target.pageId !== 'string' ||
        (target.caretId !== undefined && typeof target.caretId !== 'string') ||
        (target.blockId !== undefined && typeof target.blockId !== 'string')
      )
        return;
      open({
        kind: 'page',
        pageId: target.pageId,
        ...(target.caretId ? { caretId: target.caretId } : {}),
        ...(target.blockId ? { blockId: target.blockId } : {}),
        ...(typeof target.caretOffset === 'number' && Number.isFinite(target.caretOffset)
          ? { caretOffset: target.caretOffset }
          : {}),
      });
    };
    window.addEventListener('tessera-open', nativeOpen);
    onCleanup(() => window.removeEventListener('tessera-open', nativeOpen));
    // A breakpoint crossing switches layout modes; it is not a gesture, so the shell changes at once rather than easing through.
    let layoutTimer = 0;
    const layoutSwitched = () => {
      document.documentElement.dataset.layoutSwitching = '';
      clearTimeout(layoutTimer);
      layoutTimer = window.setTimeout(() => delete document.documentElement.dataset.layoutSwitching, 100);
    };
    onCleanup(() => {
      clearTimeout(layoutTimer);
      delete document.documentElement.dataset.layoutSwitching;
    });
    createEffect(
      on(
        [narrow, cover, tabbed],
        () => {
          layoutSwitched();
          if (cover()) setSidebar(false);
        },
        { defer: true },
      ),
    );
    onCleanup(installDisclosureMotion());
    onCleanup(installInputModality());
    // Popups that dismiss on the press that starts a click leave the opener's click unable to see what was open.
    const onPress = () => {
      pressedPopup = { state: popup(), at: performance.now() };
    };
    const onPressKey = () => {
      pressedPopup = undefined;
    };
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onPressKey, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onPressKey, true);
    });
    // Page deletion navigates away from its document. While it remains the
    // latest action, recover it before the replacement outline consumes Undo.
    const onPageUndo = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        deletionUndoSequence() === null ||
        !deleted() ||
        !(mac ? event.metaKey : event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLocaleLowerCase() !== 'z' ||
        document.querySelector('dialog:modal, .popup:not(.reference-preview), .popup.reference-preview:focus-within')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void restorePage();
    };
    window.addEventListener('keydown', onPageUndo, true);
    onCleanup(() => window.removeEventListener('keydown', onPageUndo, true));
    const onKey = (event: KeyboardEvent) => {
      // A modal dialog (image viewer, annotation composer, occlusion editor) owns the keyboard; shell chords would run behind it.
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog:modal')) return;
      // The keys sheet is a popup, which stops shell chords; its own chord closes it.
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === '/' || event.code === 'Slash') &&
        popup()?.kind === 'shortcuts'
      ) {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) setPopup(null);
        return;
      }
      if (document.querySelector('.popup:not(.reference-preview), .popup.reference-preview:focus-within')) return;
      if (event.key === 'Escape' && overlayOpen()) {
        event.preventDefault();
        event.stopPropagation();
        setSidebar(false);
        return;
      }
      // Native menu accelerators dispatch these commands themselves, including in full screen.
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        (event.code === 'KeyN' || event.key.toLocaleLowerCase() === 'n')
      ) {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) openCreate({ kind: event.altKey ? 'question' : 'note', text: '', into: { kind: 'page' } });
        return;
      }
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLocaleLowerCase() === 'e'
      ) {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) openCreate(blankCapture());
        return;
      }
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === '/' || event.code === 'Slash')
      ) {
        if (document.documentElement.dataset.windowControls) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) setPopup({ kind: 'shortcuts', anchor: document.body, pane: active() });
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
      event.preventDefault();
      event.stopPropagation();
    };
    // Reserved shell chords precede CodeMirror's macOS Ctrl+Shift Emacs bindings.
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
    // Prefetching after startup keeps first paint lean without delaying the first open of each pane.
    const prefetch = () => {
      for (const load of Object.values(paneModules)) void load().catch(() => undefined);
    };
    const idle =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(prefetch, { timeout: 4000 })
        : window.setTimeout(prefetch, 2000);
    onCleanup(() => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
      else clearTimeout(idle);
    });
  });
  let initializing = false;
  createEffect(() => {
    if (info.loading || initializing) return;
    initializing = true;
    const workshopInfo = info();
    void (async () => {
      if (!workshopInfo && !navigator.onLine) {
        setOfflineUnavailable(true);
        setError('Workshop unavailable offline · Open this workshop online once.');
        return;
      }
      await workshop.ready;
      if (workshop.connection() === 'offline' && !workshop.roots().length) {
        setOfflineUnavailable(true);
        setError('Workshop unavailable offline · Open this workshop online once.');
        return;
      }
      if (!workshopInfo) {
        await today();
        return;
      }
      let stored: SavedNavigation = {};
      try {
        stored = JSON.parse(localStorage.getItem(`tessera.navigation.${workshopInfo.id}`) ?? '{}') ?? {};
      } catch {
        /* Navigation preferences are optional; document durability is IndexedDB. */
      }
      batch(() => {
        if (Array.isArray(stored.pinned)) setPinned(stored.pinned.filter(value => typeof value === 'string'));
        if (Array.isArray(stored.pinnedViews))
          setPinnedViews(stored.pinnedViews.filter(value => typeof value === 'string'));
        if (stored.pagePresentations && typeof stored.pagePresentations === 'object')
          setPagePresentations(
            Object.fromEntries(
              Object.entries(stored.pagePresentations)
                .filter(([, value]) => value && ['read', 'outline', 'compare', undefined].includes(value.projection))
                .map(([id, value]) => [
                  id,
                  {
                    projection: value.projection,
                    bullets: typeof value.bullets === 'boolean' ? value.bullets : undefined,
                  },
                ]),
            ),
          );
        else if (stored.pageStyles && typeof stored.pageStyles === 'object')
          setPagePresentations(
            Object.fromEntries(
              Object.entries(stored.pageStyles)
                .filter(([, style]) => style === 'bullets' || style === 'prose')
                .map(([id, style]) => [id, { bullets: style === 'bullets' }]),
            ),
          );
        if (Array.isArray(stored.recent))
          setRecent([...new Set(stored.recent)].filter(value => typeof value === 'string').slice(0, 10));
      });
      const restored: Record<PaneId, PaneSession> = {},
        restoredOrder: PaneId[] = [];
      const restoreEntry = async (saved: HistoryEntry | undefined): Promise<HistoryEntry | undefined> => {
        if (!saved?.target || !saved.view) return;
        let current: HistoryEntry;
        if (saved.target.kind === 'table' && 'query' in saved.view && !('mode' in saved.view)) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'agenda' && 'mode' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'review' && 'deckId' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (
          saved.target.kind === 'revisits' &&
          'scroll' in saved.view &&
          typeof saved.view.scroll === 'number'
        ) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (
          (saved.target.kind === 'directory' ||
            saved.target.kind === 'fields' ||
            saved.target.kind === 'field' ||
            saved.target.kind === 'cards' ||
            saved.target.kind === 'settings' ||
            saved.target.kind === 'history' ||
            saved.target.kind === 'compare' ||
            saved.target.kind === 'index' ||
            saved.target.kind === 'spread') &&
          'scroll' in saved.view &&
          typeof saved.view.scroll === 'number'
        ) {
          current = {
            target: targetFromView(saved),
            view:
              saved.target.kind === 'compare' || saved.target.kind === 'index'
                ? snapshotView(saved.view)
                : { scroll: saved.view.scroll },
          };
        } else if (
          (saved.target.kind === 'library' && 'tab' in saved.view) ||
          (saved.target.kind === 'reader' && 'ordinal' in saved.view)
        ) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'page' && 'zoom' in saved.view) {
          const savedId = saved.target.pageId;
          const exists = workshop.roots().some(root => root.id === savedId);
          current = exists
            ? { target: targetFromView(saved), view: { ...copyView(saved.view), reveal: undefined } }
            : {
                target: { kind: 'page', pageId: await workshop.today() },
                view: { zoom: null, caret: null, scroll: null, folds: null, showArchived: false },
              };
        } else return;
        return current;
      };
      // Before the row, navigation saved two slots without an order.
      const savedOrder = Array.isArray(stored.order)
        ? stored.order.filter(value => typeof value === 'string')
        : Object.keys(stored.panes ?? {});
      for (const pane of savedOrder.slice(0, MAX_PANES)) {
        const current = await restoreEntry(stored.panes?.[pane]);
        if (!current) continue;
        let session: PaneSession = { entries: [current], index: 0, generation: 1 };
        // Each pane's Back and Forward survive a reload, so a split returns as it was left.
        const savedHistory = stored.histories?.[pane];
        if (
          !cover() &&
          savedHistory &&
          Array.isArray(savedHistory.entries) &&
          Number.isInteger(savedHistory.index) &&
          savedHistory.index >= 0 &&
          savedHistory.index < savedHistory.entries.length
        ) {
          const entries = await Promise.all(
            savedHistory.entries.map((saved, at) => (at === savedHistory.index ? current : restoreEntry(saved))),
          );
          if (entries.every(value => value))
            session = { entries: entries as HistoryEntry[], index: savedHistory.index, generation: 1 };
        }
        const savedPhone = stored.phone?.[pane];
        if (cover() && savedPhone && phoneTabs.includes(savedPhone.tab)) {
          const stacks: Partial<Record<PhoneTab, PaneHistory>> = {};
          for (const tab of phoneTabs) {
            const stack = savedPhone.stacks?.[tab];
            if (
              !stack ||
              !Array.isArray(stack.entries) ||
              !Number.isInteger(stack.index) ||
              stack.index < 0 ||
              stack.index >= stack.entries.length
            )
              continue;
            const entries = await Promise.all(stack.entries.map(restoreEntry));
            if (entries.some(entry => !entry)) continue;
            stacks[tab] = collapsePhoneLanding({ entries: entries as HistoryEntry[], index: stack.index }, tab);
          }
          const currentStack = stacks[savedPhone.tab];
          if (currentStack) {
            delete stacks[savedPhone.tab];
            session = { ...session, ...currentStack, tab: savedPhone.tab, tabs: stacks };
          }
        }
        restored[pane] = cover() ? passiveHistory(session) : session;
        restoredOrder.push(pane);
      }
      if (restoredOrder.length) {
        const pane = stored.active && restored[stored.active] ? stored.active : restoredOrder[0]!;
        const widths = Object.fromEntries(
          Object.entries(stored.widths ?? {}).filter(
            ([id, value]) => restored[id] && typeof value === 'number' && value > 0,
          ),
        );
        batch(() => {
          setSessions(restored);
          setOrder(restoredOrder);
          setWeights(widths);
          setActive(pane);
        });
      } else await today();
      setNavigationId(workshopInfo.id);
    })().catch(reportError);
  });
  installOpenedFiles(
    () => navigationId() !== null,
    () => open({ kind: 'library', tab: 'inbox' }, false, order()[0]),
    reportError,
  );
  // ⌘E, the desktop menu and global shortcut, and Android's launcher shortcuts and share sheet.
  installQuickCapture(() => navigationId() !== null, quickCreate);
  // The iOS app icon's quick actions: capture like ⌘E, or show a tab from its top.
  installHomeShortcuts(
    () => navigationId() !== null,
    shortcut => {
      if (shortcut === 'capture') {
        quickCreate(blankCapture());
        return;
      }
      setPopup(null);
      if (cover()) void selectPhoneTab(shortcut, true).catch(reportError);
      else if (shortcut === 'today') void today().catch(reportError);
      else open({ kind: shortcut });
    },
  );
  // Caret and scroll reports change navigation on most keystrokes; storage writes trail them off the input path.
  let navigationWrite: { key: string; value: unknown } | null = null;
  let navigationTimer = 0;
  const writeNavigation = () => {
    clearTimeout(navigationTimer);
    const pending = navigationWrite;
    navigationWrite = null;
    if (pending)
      try {
        localStorage.setItem(pending.key, JSON.stringify(pending.value));
      } catch {
        /* Storage-denied browsers keep preferences for this tab. */
      }
  };
  window.addEventListener('pagehide', writeNavigation);
  onCleanup(() => {
    window.removeEventListener('pagehide', writeNavigation);
    writeNavigation();
  });
  createEffect(() => {
    const id = navigationId();
    if (!id) return;
    const panes: Record<PaneId, HistoryEntry> = {};
    const phone: NonNullable<SavedNavigation['phone']> = {};
    const histories: Record<PaneId, PaneHistory> = {};
    const saved = (value: HistoryEntry): HistoryEntry =>
      value.target.kind === 'page' && 'zoom' in value.view
        ? { target: targetFromView(value), view: { ...copyView(value.view), reveal: undefined } }
        : value;
    for (const pane of order()) {
      const current = entry(pane);
      if (current) panes[pane] = saved(current);
      const session = sessions()[pane];
      if (session?.tab)
        phone[pane] = {
          tab: session.tab,
          stacks: { ...session.tabs, [session.tab]: { entries: session.entries, index: session.index } },
        };
      else if (session && session.entries.length > 1) {
        // A window around the current entry keeps the stored navigation small.
        const from = Math.max(0, session.index - SAVED_HISTORY),
          to = Math.min(session.entries.length, session.index + SAVED_HISTORY + 1);
        histories[pane] = { entries: session.entries.slice(from, to).map(saved), index: session.index - from };
      }
    }
    navigationWrite = {
      key: `tessera.navigation.${id}`,
      value: {
        pinned: pinned(),
        pinnedViews: pinnedViews(),
        pagePresentations: pagePresentations(),
        recent: recent(),
        vim: vim(),
        panes,
        histories,
        phone,
        order: order(),
        widths: weights(),
        active: active(),
      },
    };
    clearTimeout(navigationTimer);
    navigationTimer = window.setTimeout(writeNavigation, 500);
  });
  const unregister = commands.register([
    {
      id: 'shell.search',
      title: 'Find or create',
      section: 'Navigation',
      keys: ['⌃⇧F'],
      run: () => showPalette('search'),
    },
    {
      id: 'shell.commands',
      title: 'Show commands',
      section: 'Navigation',
      keys: ['⌃⇧P'],
      run: () => showPalette('commands'),
    },
    {
      id: 'shell.shortcuts',
      title: 'Keys and syntax',
      section: 'Navigation',
      keys: ['⌘/'],
      keywords: ['shortcuts', 'keyboard', 'help', 'cheat sheet'],
      run: () => setPopup({ kind: 'shortcuts', anchor: document.body, pane: active() }),
    },
    { id: 'shell.settings', title: 'Open settings', section: 'Navigation', run: () => open({ kind: 'settings' }) },
    { id: 'shell.history', title: 'Open history', section: 'Navigation', run: () => open({ kind: 'history' }) },
    {
      id: 'shell.today',
      title: 'Open today’s journal',
      section: 'Navigation',
      keys: ['⌃⇧J'],
      run: () => {
        void today();
      },
    },
    {
      id: 'shell.capture',
      title: 'Add to today',
      section: 'Create',
      keys: ['⌘E'],
      keywords: ['capture', 'quick atom', 'quick note', 'inbox', 'journal'],
      run: () => openCreate(blankCapture()),
    },
    { id: 'shell.fields', title: 'Open fields', section: 'Navigation', run: () => open({ kind: 'fields' }) },
    {
      id: 'shell.agenda',
      title: 'Open agenda',
      section: 'Navigation',
      run: () => open({ kind: 'agenda', date: journalDate(active()) }),
    },
    { id: 'shell.revisits', title: 'Open revisits', section: 'Navigation', run: () => open({ kind: 'revisits' }) },
    { id: 'shell.review', title: 'Open review', section: 'Navigation', run: () => open({ kind: 'review' }) },
    { id: 'shell.library', title: 'Open library', section: 'Navigation', run: () => open({ kind: 'library' }) },
    {
      id: 'shell.research-desk',
      title: 'Open research desk',
      section: 'Navigation',
      run: (beside = false) => open(deskTarget(), beside),
    },
    {
      id: 'shell.import-book',
      title: 'Import book',
      section: 'Navigation',
      run: () => open({ kind: 'library', tab: 'inbox', add: true }),
    },
    { id: 'shell.previous-day', title: 'Previous journal day', section: 'Navigation', run: () => shiftDate(-1) },
    { id: 'shell.next-day', title: 'Next journal day', section: 'Navigation', run: () => shiftDate(1) },
    { id: 'shell.calendar', title: 'Choose journal date', section: 'Navigation', run: () => chooseDate() },
    {
      id: 'shell.back',
      title: 'Back',
      section: 'Navigation',
      keys: ['⌃⇧H'],
      disabledReason: () => ((sessions()[active()]?.index ?? 0) <= 0 ? 'No earlier note in this pane' : undefined),
      run: () => travel(active(), -1),
    },
    {
      id: 'shell.forward',
      title: 'Forward',
      section: 'Navigation',
      keys: ['⌃⇧L'],
      disabledReason: () => {
        const session = sessions()[active()];
        return !session || session.index >= session.entries.length - 1 ? 'No later note in this pane' : undefined;
      },
      run: () => travel(active(), 1),
    },
    {
      id: 'shell.page-beside',
      title: 'Open active view beside',
      section: 'Navigation',
      keys: ['⌃⇧O'],
      disabledReason: () => besideReason(active()),
      run: () => openPageBeside(),
    },
    {
      id: 'shell.switch',
      title: 'Next pane',
      section: 'View',
      keys: ['⌃⇧]'],
      disabledReason: () => (!split() ? 'Open a second pane first' : undefined),
      run: switchPane,
    },
    {
      id: 'shell.agent',
      title: 'Show or hide the agent',
      section: 'View',
      keys: ['⌃⇧A'],
      disabledReason: () => (DEMO ? 'The agent needs the Tessera app' : undefined),
      run: () => toggleDock(),
    },
    {
      id: 'shell.close',
      title: 'Close active pane',
      section: 'View',
      keys: ['⌃⇧X'],
      disabledReason: () => (!split() ? 'Only one pane is open' : undefined),
      run: () => closePane(active()),
    },
    {
      id: 'shell.new',
      title: 'New note',
      section: 'Create',
      keys: document.documentElement.dataset.windowControls ? ['⌘N'] : undefined,
      keywords: ['page', 'note', 'create'],
      run: () => openCreate({ kind: 'note', text: '', into: { kind: 'page' } }),
    },
    {
      id: 'create.question',
      title: 'New question',
      section: 'Create',
      keys: ['⌥⌘N'],
      keywords: ['ask', 'inquiry'],
      run: () => openCreate({ kind: 'question', text: '' }),
    },
    {
      id: 'create.project',
      title: 'New project',
      section: 'Create',
      run: () => openCreate({ kind: 'project', text: '' }),
    },
    {
      id: 'create.task',
      title: 'New task',
      section: 'Create',
      keywords: ['todo'],
      run: () => openCreate({ kind: 'task', text: '', into: { kind: 'journal' } }),
    },
    {
      id: 'create.card',
      title: 'New card',
      section: 'Create',
      keywords: ['flashcard', 'review'],
      run: () => openCreate({ kind: 'card', text: '', into: { kind: 'journal' } }),
    },
    {
      id: 'create.source',
      title: 'Add source',
      section: 'Create',
      keywords: ['book', 'article', 'paper', 'library', 'import', 'isbn'],
      run: () => openCreate({ kind: 'source', text: '' }),
    },
    {
      id: 'shell.new-spread',
      title: 'New spread',
      section: 'Page',
      run: (beside = false) => open({ kind: 'spread', noteIds: [] }, beside),
    },
    {
      id: 'shell.new-view',
      title: 'New view…',
      section: 'View',
      run: () => setPopup({ kind: 'new-view', anchor: searchButton, pane: active() }),
    },
    {
      id: 'shell.pin',
      title: 'Pin / unpin note',
      section: 'Page',
      run: () => {
        const root = activeRoot();
        if (root) pin(root.id);
      },
    },
    {
      id: 'shell.delete',
      title: 'Delete note',
      section: 'Page',
      run: () => {
        const anchor = document.querySelector<HTMLButtonElement>(`[data-pane="${active()}"] .page-menu-button`);
        if (anchor) setPopup({ kind: 'delete', anchor, pane: active() });
      },
    },
    {
      id: 'shell.restore-page',
      title: 'Undo note deletion',
      section: 'Page',
      disabledReason: () =>
        deleted()
          ? undefined
          : retainedDeletions.error
            ? 'Could not read deleted notes'
            : retainedDeletions.loading
              ? 'Loading deleted notes…'
              : retainedDeletions()?.length
                ? undefined
                : 'No deleted note to restore',
      run: () => {
        void restorePage();
      },
    },
    {
      id: 'shell.deleted-pages',
      title: 'Restore deleted note…',
      section: 'Page',
      run: () => setPopup({ kind: 'restore-pages', anchor: searchButton, pane: active() }),
    },
    {
      id: 'shell.review-conflict',
      title: 'Review workshop conflict',
      section: 'Editing',
      disabledReason: () => (workshop.conflictedPages().length ? undefined : 'No conflicting notes'),
      run: reviewConflict,
    },
    {
      id: 'shell.retry',
      title: 'Retry saving',
      section: 'Editing',
      disabledReason: () =>
        workshop.saveState() === 'saved' && workshop.connection() === 'live' ? 'All changes are saved' : undefined,
      run: () => workshop.retry(),
    },
    {
      id: 'shell.copy-unsaved',
      title: 'Copy unsaved text',
      section: 'Editing',
      disabledReason: () =>
        workshop.localPersistence() === 'failed' || workshop.rejectedText()
          ? undefined
          : 'Local recovery storage is working',
      run: () => {
        void navigator.clipboard.writeText(workshop.rejectedText() || workshop.unsavedText()).catch(reportError);
      },
    },
    {
      id: 'shell.dismiss-rejected',
      title: 'Dismiss rejected changes',
      section: 'Editing',
      disabledReason: () => (workshop.rejectedText() ? undefined : 'No rejected changes'),
      run: () => workshop.dismissRejected(),
    },
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
      if (!command || command.disabledReason?.() || document.querySelector('dialog:modal')) return;
      // The native chord for the keys sheet toggles it.
      if (id === 'shell.shortcuts' && popup()?.kind === 'shortcuts') {
        setPopup(null);
        return;
      }
      setPopup(null);
      setTypesMenu(null);
      command.run();
    };
    window.addEventListener('tessera-command', onCommand);
    onCleanup(() => window.removeEventListener('tessera-command', onCommand));
  });
  createEffect(() => {
    const unregisterViews = commands.register(
      (views() ?? []).map(view => ({
        id: `shell.view.${view.id}`,
        title: `Open view: ${view.name}`,
        section: 'Navigation' as const,
        run: () => openView(view),
      })),
    );
    onCleanup(unregisterViews);
  });
  createEffect(() => {
    onCleanup(
      commands.register(
        creatableKinds(index()?.kinds ?? []).map(kind => ({
          id: `create.type:${kind.key}`,
          title: `New ${kindNoun(kind)}`,
          section: 'Create' as const,
          run: () => openCreate({ kind: `type:${kind.key}`, text: '', lockKind: true }),
        })),
      ),
    );
  });
  registerWorkshopCommands(commands, workshop, reportError);
  const rootById = createMemo(() => new Map(workshop.roots().map(root => [root.id, root])));
  const pinnedRoots = () =>
    pinned()
      .map(id => rootById().get(id))
      .filter((root): root is Block => !!root);
  // The Today row is today's journal day; Recent keeps the other atoms you opened, so one page is never two selected rows.
  const recentRoots = () =>
    recent()
      .filter(id => !pinned().includes(id))
      .map(id => rootById().get(id))
      .filter((root): root is Block => !!root && !(root.kind === 'journal' && root.text === todayDate()))
      .slice(0, 10);
  const index = noteIndex(workshop);
  const [destinationTypes] = createResource(
    () => workshop.changed('types'),
    () => workshop.api.types(),
  );
  const goToCommand = (id: string, title: string, action: (beside: boolean, pane: PaneId) => void): Command => ({
    id: `shell.go-to.${id}`,
    title,
    section: 'Go to',
    run: (beside = false) => action(beside, active()),
    capture: () => {
      const pane = active();
      return { id: `shell.go-to.${id}`, title, section: 'Go to', run: (beside = false) => action(beside, pane) };
    },
  });
  createEffect(() => {
    const destinations: Command[] = [
      goToCommand('highlights', 'Highlights', (beside, pane) =>
        open({ kind: 'library', tab: 'highlights' }, beside, pane),
      ),
      goToCommand('unfiled', 'Unfiled', (beside, pane) => open({ kind: 'index', key: 'unfiled' }, beside, pane)),
      goToCommand('sources', 'Sources', (beside, pane) => open({ kind: 'index', key: 'source' }, beside, pane)),
      goToCommand('agenda-week', 'Agenda week', (beside, pane) =>
        open({ kind: 'agenda', date: todayDate(), mode: 'week' }, beside, pane),
      ),
      goToCommand('agenda-tasks', 'Agenda tasks', (beside, pane) =>
        open({ kind: 'agenda', date: todayDate(), mode: 'tasks' }, beside, pane),
      ),
      ...(['week', 'month', 'quarter', 'year'] as const).map(period =>
        goToCommand(period, `This ${period}`, (beside, pane) => {
          void journal(null, pane, beside, period);
        }),
      ),
    ];
    for (const type of index() ? (destinationTypes() ?? []) : []) {
      const key = index()!.kinds.find(kind => kind.type_id === type.page.id)?.key ?? `type:${type.page.id}`;
      destinations.push(
        goToCommand(`index.${type.page.id}`, `${type.page.text} index`, (beside, pane) =>
          open({ kind: 'index', key }, beside, pane),
        ),
        goToCommand(`table.${type.page.id}`, `${type.page.text} table`, (beside, pane) =>
          open({ kind: 'table', typeId: type.page.id, viewId: null, query: typeQuery(type.page.id) }, beside, pane),
        ),
      );
    }
    onCleanup(commands.register(destinations));
  });
  const activeTypeId = () => {
    const target = entry(active())?.target;
    return target?.kind === 'table' && !target.viewId ? target.typeId : null;
  };
  /** The note kind a pane shows: its index, its Table mode, or the type behind its table, fields or cards. */
  const indexKind = (pane: PaneId) => {
    const target = entry(pane)?.target;
    return target?.kind === 'index'
      ? index()?.kinds.find(kind => kind.key === target.key)
      : target?.kind === 'table' && !target.typeId && target.query.note_kind
        ? index()?.kinds.find(kind => kind.key === target.query.note_kind)
        : (target?.kind === 'fields' || target?.kind === 'cards' || target?.kind === 'table') && target.typeId
          ? index()?.kinds.find(kind => kind.type_id === target.typeId)
          : undefined;
  };
  const [fieldNames] = createResource(
    () => (order().some(pane => entry(pane)?.target.kind === 'field') ? workshop.changed('fields') : false),
    async () => {
      try {
        return await workshop.api.fields();
      } catch (reason) {
        reportError(reason);
        return undefined;
      }
    },
  );
  const fieldName = (id: string) => {
    const field = fieldNames()?.fields.find(field => field.id === id);
    return field ? fieldLabel({ name: workshop.lookup(id)()?.text ?? field.name, built_in: field.built_in }) : '…';
  };
  // A table pane is named for its saved view, else its type, and an index pane for its kind, rather than the generic label.
  const paneTitle = (pane: PaneId) => {
    const target = entry(pane)?.target;
    if (target?.kind === 'field') return `Fields / ${fieldName(target.fieldId)}`;
    if (target?.kind === 'index') {
      const kind = indexKind(pane);
      return views()?.find(view => view.id === target.viewId)?.name ?? (kind && kindLabel(kind));
    }
    if (target?.kind === 'fields' && target.typeId) {
      const kind = indexKind(pane);
      return kind ? kindLabel(kind) : rootById().get(target.typeId)?.text;
    }
    if (target?.kind === 'cards') {
      const kind = indexKind(pane);
      return `${kind ? kindLabel(kind) : (rootById().get(target.typeId)?.text ?? 'Tag')} / Cards${target.applyId ? ' / Apply' : ''}`;
    }
    if (target?.kind !== 'table') return undefined;
    const kind = indexKind(pane);
    return (
      (views() ?? []).find(view => view.id === target.viewId)?.name ??
      (kind ? kindLabel(kind) : rootById().get(target.typeId ?? '')?.text)
    );
  };
  const paneName = (pane: PaneId) => {
    const page = rootById().get(pageIdOf(entry(pane)) ?? '');
    return page
      ? page.kind === 'page'
        ? displayTitle(page.text, id => workshop.lookup(id))
        : page.text
      : (paneTitle(pane) ?? paneLabel(entry(pane)?.target));
  };
  let paneRow!: HTMLDivElement;
  onMount(() => {
    // The width drives how many panes fit, which re-lays out the observed row: write it on the next frame, not inside the observer's delivery.
    let frame = 0;
    const observer = new ResizeObserver(([item]) => {
      const width = item!.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRowWidth(width));
    });
    observer.observe(paneRow);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });
  const { guide, dragChip } = createPaneDragGuide({
    paneRow: () => paneRow,
    workshop,
    order,
    active,
    tabbed,
    fit,
    rowWidth,
    canOpenBeside,
    open,
    addDockContext: (ref, title) => addDockContext(ref, title),
  });
  // The agent dock: its thread, the pages it reads (the panes in view, less any left out, plus dropped links) and
  // the rows it changed, which outline rows mark through AgentMarks.
  const agentSession = createAgentSession(() => navigationId() ?? undefined, workshop.api);
  const agentMarks = {
    mark: (id: string) => agentSession.marks().get(id),
    undo: (seq: number) => agentSession.undo(seq),
  };
  const [dock, setDock] = createSignal(!DEMO && localStorage.getItem('tessera.agent.dock') === 'open');
  function toggleDock(show = !dock()) {
    if (DEMO) return;
    setDock(show);
    try {
      localStorage.setItem('tessera.agent.dock', show ? 'open' : 'closed');
    } catch {
      /* The dock keeps its state for this tab. */
    }
  }
  /** The dock stays mounted through its exit, while its column closes. */
  const dockHeld = createRetained(() => dock() || undefined);
  // Closing the dock while the caret is in it hands the caret back to the panes.
  createEffect(
    on(
      dock,
      open => {
        if (!open && document.querySelector('.agent-dock')?.contains(document.activeElement)) focusPane(active());
      },
      { defer: true },
    ),
  );
  // The narrow sidebar is modal: focus moves into it on open and returns to its toggle on close.
  createEffect(
    on(
      overlayOpen,
      open => {
        if (open) {
          (
            sidebarElement.querySelector<HTMLElement>('.button.selected') ??
            sidebarElement.querySelector<HTMLElement>('.button')
          )?.focus({ preventScroll: true });
          return;
        }
        if (sidebar() || cover()) return;
        const focused = document.activeElement;
        if (!focused || focused === document.body || sidebarElement.contains(focused))
          sidebarToggle.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );
  const [dockExcluded, setDockExcluded] = createSignal<ReadonlySet<string>>(new Set());
  const [dockExtra, setDockExtra] = createSignal<ContextChip[]>([]);
  const contextKey = (ref: ContextRef) => `${ref.page_id}:${ref.block_id ?? ''}`;
  function addDockContext(ref: ContextRef, title: string) {
    const key = contextKey(ref);
    setDockExtra(values =>
      values.some(chip => chip.key === key) ? values : [...values, { key, ref, title, extra: true }],
    );
    setDockExcluded(values => {
      const next = new Set(values);
      next.delete(key);
      return next;
    });
  }
  const dockChips = createMemo(() => {
    const chips: ContextChip[] = [];
    for (const pane of order()) {
      if (tabbed() ? pane !== active() : !shown(pane)) continue;
      const current = entry(pane);
      const target = current?.target;
      const pageId = target?.kind === 'page' ? target.pageId : target?.kind === 'reader' ? target.sourceId : undefined;
      if (!pageId || !current) continue;
      const zoom = target?.kind === 'page' && 'zoom' in current.view ? current.view.zoom : null;
      const ref: ContextRef = zoom ? { page_id: pageId, block_id: zoom } : { page_id: pageId };
      chips.push({ key: contextKey(ref), ref, title: paneName(pane), extra: false });
    }
    return [...chips, ...dockExtra()].filter(
      (chip, index, all) => all.findIndex(other => other.key === chip.key) === index,
    );
  });
  /** Brings an agent change into view: the pane showing its page, scrolled to the block, or that page opened beside. */
  function showAgentEdit(pageId: string, blockId?: string) {
    const pane = order().find(value => pageIdOf(entry(value)) === pageId);
    const at = blockId ? { scroll: { id: blockId, offset: 0 }, reveal: blockId } : {};
    if (pane) {
      const view = entry(pane)!.view as ViewState;
      setActive(pane);
      reveal(pane);
      if (blockId) changeView(pane, { ...view, ...at }, true);
      focusPane(pane);
    } else
      open(
        { kind: 'page', pageId },
        true,
        active(),
        blockId ? ({ zoom: null, caret: null, folds: null, showArchived: false, ...at } as ViewState) : undefined,
      );
    if (!blockId) return;
    let frames = 0;
    const flash = () => {
      const row = document.querySelector<HTMLElement>(`.panes > .pane [data-block-id="${CSS.escape(blockId)}"]`);
      if (!row) {
        if (++frames < 60) requestAnimationFrame(flash);
        return;
      }
      row.classList.remove('agent-flash');
      void row.offsetWidth;
      row.classList.add('agent-flash');
    };
    requestAnimationFrame(flash);
  }
  // The sidebar and the phone's Index share rows, with opens owned by the pane showing them.
  const renderNavigation = (owner: Accessor<PaneId>, directory = false) => (
    <SidebarNav
      owner={owner}
      directory={directory}
      workshop={workshop}
      todayDate={todayDate}
      counts={counts}
      activeEntry={() => entry(active())}
      activeRoot={activeRoot}
      journalDate={journalDate}
      index={index}
      views={views}
      pinnedRoots={pinnedRoots}
      pinnedViews={pinnedViews}
      recentRoots={recentRoots}
      onToday={(pane, beside) => {
        void today(pane, beside);
      }}
      onOpen={(target, beside, pane) => open(target, beside, pane)}
      onOpenView={(view, beside, pane) => openView(view, beside, pane)}
      onPinView={pinView}
      onNewView={(anchor, pane) => setPopup({ kind: 'new-view', anchor, pane })}
      onQuestionsMenu={anchor => setQuestionsMenu(anchor)}
      onError={reportError}
    />
  );
  // Getters, not a snapshot: each pane reads these the way it read Solid props.
  const shell: WorkshopShell = {
    get workshop() {
      return workshop;
    },
    get commands() {
      return commands;
    },
    get vim() {
      return vim();
    },
    get split() {
      return split();
    },
    get pagePresentations() {
      return pagePresentations();
    },
    fieldName,
    get noteKinds() {
      return index()?.kinds;
    },
    get atomCount() {
      return index()?.notes;
    },
    get directoryReady() {
      return !!index() && !views.loading;
    },
    onCreate: openCreate,
    onPagePresentation(id, value) {
      setPagePresentations(previous => ({ ...previous, [id]: value }));
    },
    onDeleteSources(sources) {
      return deletePages(sources, sources.length === 1 ? undefined : `${sources.length} sources`);
    },
  };
  return (
    <WorkshopContext.Provider value={shell}>
      <AgentMarks.Provider value={agentMarks}>
        <div
          class={`app ${split() ? 'is-split' : ''} ${sidebar() ? 'sidebar-expanded' : ''} ${sidebarCollapsed() ? 'sidebar-collapsed' : ''} ${dock() ? 'has-dock' : ''} ${immersive() ? 'is-immersive' : ''} ${keyboard() ? 'keyboard-open' : ''} ${entry(active())?.target.kind === 'reader' ? 'is-reading' : ''} ${currentHealth()?.cover ? 'has-sync-cover' : ''}`}
          style={{
            '--visual-viewport-height': `${viewport().height}px`,
            '--visual-viewport-top': `${viewport().top}px`,
            '--visual-viewport-bottom-gap': `${Math.max(0, window.innerHeight - viewport().bottom)}px`,
          }}
          onPointerDown={() => {
            focusEpoch++;
          }}
        >
          <header class="global-rail" aria-label="Global navigation" data-tauri-drag-region="deep">
            <div class="rail-start">
              <Button
                ref={sidebarToggle}
                icon="sidebar"
                label="Toggle sidebar"
                aria-expanded={sidebarVisible()}
                onClick={toggleSidebar}
              />
              <span class="wordmark" title={info()?.path}>
                Tessera
              </span>
              <SyncMark open={!!syncAnchor()} onOpen={setSyncAnchor} />
            </div>
            <div class="rail-finder" role="group" aria-label="Find and commands">
              <Button
                ref={searchButton}
                class="global-search"
                icon="search"
                label="Find or create"
                shortcut="⌃⇧F"
                aria-haspopup="dialog"
                aria-expanded={popup()?.kind === 'search'}
                onClick={() => toggleOpener('search', searchButton, () => showPalette('search'))}
              >
                <span>Find or create…</span>
                <kbd>⌃⇧F</kbd>
              </Button>
              <Button
                class="global-commands"
                icon="command"
                label="Commands"
                shortcut="⌃⇧P"
                aria-haspopup="dialog"
                aria-expanded={popup()?.kind === 'commands'}
                onClick={() => toggleOpener('commands', document.body, () => showPalette('commands'))}
              />
            </div>
            <div class="rail-end">
              <Show when={!DEMO}>
                <Button icon="agent" label="Agent" shortcut="⌃⇧A" aria-pressed={dock()} onClick={() => toggleDock()} />
              </Show>
              <Button
                icon="panes"
                label="Layout"
                aria-haspopup="menu"
                aria-expanded={popup()?.kind === 'layout'}
                onClick={event => {
                  const anchor = event.currentTarget;
                  toggleOpener('layout', anchor, () => setPopup({ kind: 'layout', anchor, pane: active() }));
                }}
              />
            </div>
          </header>
          <aside
            ref={sidebarElement}
            class="sidebar"
            aria-label="Workshop navigation"
            aria-hidden={!sidebarVisible()}
            inert={!sidebarVisible()}
          >
            {renderNavigation(active)}
          </aside>
          {/* The scrim stays mounted below the desktop breakpoint, so it fades out with the sidebar instead of vanishing. */}
          <Show when={!cover() && narrow()}>
            <div class="sidebar-shade" aria-hidden="true" onClick={() => setSidebar(false)} />
          </Show>
          <main class="workspace" inert={overlayOpen()}>
            <Show when={split()}>
              <div class="pane-tabs">
                <div class="pane-tab-strip mode-tabs tab-strip" role="tablist" aria-label="Working panes">
                  <For each={order()}>
                    {(pane, position) => (
                      <>
                        <Button
                          role="tab"
                          aria-selected={active() === pane}
                          onClick={() => {
                            if (active() !== pane) showPane(pane);
                          }}
                        >
                          <span class="pane-tab-number">{position() + 1}</span>
                          <span class="pane-tab-title">{paneName(pane)}</span>
                        </Button>
                        <Button
                          class="pane-tab-close"
                          icon="close"
                          label={`Close ${paneName(pane)}`}
                          shortcut={active() === pane ? '⌃⇧X' : undefined}
                          onClick={() => closePane(pane)}
                        />
                      </>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={error()}>
              <div class="shell-error" role="alert">
                <Icon name="warning" />
                <span>{error()}</span>
                <Button
                  onClick={() => {
                    if (offlineUnavailable()) {
                      location.reload();
                      return;
                    }
                    setError('');
                    void today();
                  }}
                >
                  Retry
                </Button>
              </div>
            </Show>
            <GlobalBanner workshop={workshop} onReview={reviewConflict} />
            <div ref={paneRow} class="panes">
              <For each={order()}>
                {(pane, position) => (
                  <>
                    <Show when={!shown(pane)}>
                      <button
                        type="button"
                        class="pane-spine"
                        data-spine={pane}
                        aria-label={`Show pane ${position() + 1}, ${paneName(pane)}`}
                        title={paneName(pane)}
                        onClick={() => showPane(pane)}
                      >
                        <span class="pane-spine-number">{position() + 1}</span>
                        <span class="pane-spine-title">{paneName(pane)}</span>
                      </button>
                    </Show>
                    <Show when={!tabbed() && shown(pane) && position() > start()}>
                      <PaneDivider
                        left={order()[position() - 1]!}
                        right={pane}
                        follows={!!listKinds[entry(order()[position() - 1]!)?.target.kind ?? 'page']}
                        weights={weights()}
                        onResize={(left, right) =>
                          setWeights(values => ({ ...values, [order()[position() - 1]!]: left, [pane]: right }))
                        }
                        onReset={() => reflowPanes(() => setWeights({}))}
                      />
                    </Show>
                    <Show when={entry(pane)}>
                      <Pane
                        pane={pane}
                        number={position() + 1}
                        folded={!shown(pane)}
                        grow={weights()[pane] ?? 1}
                        neighbour={position() < order().length - 1}
                        session={() => sessions()[pane]!}
                        active={active() === pane}
                        immersive={immersive() === pane}
                        onImmersive={on => immerse(pane, on)}
                        vimMode={vimModes()[pane] ?? null}
                        onVimMode={mode => setVimModes(values => ({ ...values, [pane]: mode }))}
                        pinned={pinned().includes(pageIdOf(entry(pane)) ?? '')}
                        title={paneTitle(pane)}
                        noteKind={indexKind(pane)}
                        besideReason={besideReason(pane)}
                        renderDirectory={() => renderNavigation(() => pane, true)}
                        onActivate={() => setActive(pane)}
                        onOpen={(target, beside) => open(target, beside, pane)}
                        onPageBeside={() => openPageBeside(pane)}
                        onViewChange={view => changeView(pane, view)}
                        onTargetChange={target => changeTarget(pane, target)}
                        onTravel={delta => travel(pane, delta)}
                        onClose={() => closePane(pane)}
                        onChooseDate={anchor => toggleOpener('calendar', anchor, () => chooseDate(pane, anchor))}
                        onShiftDate={delta => shiftDate(delta, pane)}
                        onPin={() => {
                          const id = pageIdOf(entry(pane));
                          if (id) pin(id);
                        }}
                        onRename={() => runOutline('rename', pane)}
                        onDelete={(anchor, source) => setPopup({ kind: 'delete', anchor, pane, source })}
                        onArchived={() => {
                          runOutline('show-archived', pane);
                          focusPane(pane);
                        }}
                        onRestoreView={view => changeView(pane, view, true)}
                      />
                    </Show>
                  </>
                )}
              </For>
              <Show when={guide()}>
                {value => (
                  <div
                    class="pane-guide"
                    classList={{ 'pane-guide-new': value().fresh }}
                    style={{ left: `${value().left}px`, width: `${value().width}px` }}
                    aria-hidden="true"
                  >
                    <span>{value().label}</span>
                  </div>
                )}
              </Show>
            </div>
            <Show when={!order().some(pane => entry(pane)) && !error()}>
              <div class="startup-state">Opening today’s journal…</div>
            </Show>
            <Show when={dragChip()}>
              {chip => (
                <div
                  class="pane-drag-chip"
                  style={{ transform: `translate(${chip().x + 14}px, ${chip().y + 14}px)` }}
                  aria-hidden="true"
                >
                  {chip().label}
                </div>
              )}
            </Show>
          </main>
          <Show when={dockHeld()}>
            {held => (
              <AgentDock
                leaving={held().leaving}
                workshop={workshop}
                session={agentSession}
                chips={dockChips()}
                excluded={dockExcluded()}
                onToggleChip={key =>
                  setDockExcluded(values => {
                    const next = new Set(values);
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })
                }
                onRemoveChip={key => setDockExtra(values => values.filter(chip => chip.key !== key))}
                onShow={showAgentEdit}
                onOpen={(target, beside) => open(target, beside)}
                onSettings={() => open({ kind: 'settings', section: 'agent' }, true)}
                onClose={() => toggleDock(false)}
              />
            )}
          </Show>
          <SyncLifecycle
            workshop={workshop}
            anchor={syncAnchor()}
            onClose={() => setSyncAnchor(null)}
            onDevices={deviceId => open({ kind: 'settings', section: 'devices', deviceId })}
          />
          <SyncCover open={!!syncAnchor()} onOpen={setSyncAnchor} />
          <nav class="bottom-nav" aria-label="Workshop">
            <div class="bottom-tabs glass">
              <Button
                icon="today"
                class={phoneTabFor(sessions()[active()]) === 'today' ? 'selected' : ''}
                aria-current={phoneTabFor(sessions()[active()]) === 'today' ? 'page' : undefined}
                onClick={() => {
                  void selectPhoneTab('today').catch(reportError);
                }}
              >
                <span>Today</span>
              </Button>
              <Button
                icon="agenda"
                class={phoneTabFor(sessions()[active()]) === 'agenda' ? 'selected' : ''}
                aria-current={phoneTabFor(sessions()[active()]) === 'agenda' ? 'page' : undefined}
                onClick={() => {
                  void selectPhoneTab('agenda').catch(reportError);
                }}
              >
                <span>Agenda</span>
                <Show when={counts()?.overdue}>
                  {count => (
                    <span class="bottom-nav-badge" aria-label={`${count()} overdue`}>
                      {count()}
                    </span>
                  )}
                </Show>
              </Button>
              <Button
                icon="review"
                class={phoneTabFor(sessions()[active()]) === 'review' ? 'selected' : ''}
                aria-current={phoneTabFor(sessions()[active()]) === 'review' ? 'page' : undefined}
                onClick={() => {
                  void selectPhoneTab('review').catch(reportError);
                }}
              >
                <span>Review</span>
              </Button>
              {/* Long press lists the types, but Library itself is a destination, so it announces as one. */}
              <Button
                icon="library"
                class={phoneTabFor(sessions()[active()]) === 'library' ? 'selected' : ''}
                aria-current={phoneTabFor(sessions()[active()]) === 'library' ? 'page' : undefined}
                onClick={() => {
                  void selectPhoneTab('library').catch(reportError);
                }}
                onContextMenu={event => {
                  event.preventDefault();
                  void showTypes(event.currentTarget);
                }}
              >
                <span>Library</span>
              </Button>
            </div>
            <Button
              icon="search"
              label="Find"
              class={`bottom-find glass ${popup()?.kind === 'search' ? 'selected' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={popup()?.kind === 'search'}
              onClick={event => {
                const anchor = event.currentTarget;
                toggleOpener('search', anchor, () => setPopup({ kind: 'search', anchor, pane: active() }));
              }}
            />
          </nav>
          <Show when={questionsMenu()}>
            {anchor => (
              <Menu
                anchor={anchor()}
                label="Questions"
                onDismiss={() => setQuestionsMenu(undefined)}
                items={[
                  {
                    label: 'Open research desk',
                    icon: 'panes',
                    action: () => {
                      setQuestionsMenu(undefined);
                      open(deskTarget());
                    },
                  },
                ]}
              />
            )}
          </Show>
          <Show when={typesMenu()}>
            {state => (
              <Menu
                anchor={state().anchor}
                label="Tags"
                onDismiss={() => setTypesMenu(null)}
                items={[
                  {
                    label: 'Library',
                    icon: 'library',
                    checked: entry(active())?.target.kind === 'library',
                    action: () => open({ kind: 'library' }),
                  },
                  ...state().types.map(type => ({
                    section: 'Tags',
                    label: type.page.text,
                    icon: 'table' as const,
                    checked: activeTypeId() === type.page.id,
                    action: () =>
                      open({
                        kind: 'table',
                        typeId: type.page.id,
                        viewId: null,
                        query: { type: type.page.id, text: null, filters: [], sort: [], limit: null },
                      }),
                  })),
                ]}
              />
            )}
          </Show>
          <Show keyed when={popup()}>
            {state => (
              <>
                <Show when={state.kind === 'search' || state.kind === 'commands'}>
                  <Palette
                    anchor={state.anchor}
                    pane={state.pane}
                    mode={state.kind === 'commands' ? 'commands' : 'search'}
                    commands={commands}
                    workshop={workshop}
                    noteKinds={index()?.kinds ?? []}
                    onDismiss={() => setPopup(null)}
                    onRestoreFocus={() => {
                      if (!popup() && active() === state.pane) focusPane(state.pane);
                    }}
                    onOpen={(target, beside) => open(target, beside, state.pane)}
                    onCreate={openCreate}
                    onNotice={showNotice}
                  />
                </Show>
                <Show when={state.kind === 'calendar'}>
                  <Calendar
                    workshop={workshop}
                    anchor={state.anchor}
                    date={state.date ?? journalDate(state.pane)}
                    today={todayDate()}
                    onToday={() => {
                      void today(state.pane);
                    }}
                    onDismiss={() => setPopup(null)}
                    onSelect={value => {
                      void journal(value, state.pane);
                    }}
                  />
                </Show>
                <Show when={state.kind === 'shortcuts'}>
                  <Shortcuts commands={commands} onDismiss={() => setPopup(null)} />
                </Show>
                <Show when={state.kind === 'new-view'}>
                  <Menu
                    anchor={state.anchor}
                    label="New view source"
                    header={<div class="table-popup-heading">Choose a source</div>}
                    items={querySources.map(source => ({
                      label: source.name,
                      action: () => {
                        setPopup(null);
                        open(
                          {
                            kind: 'table',
                            typeId: null,
                            viewId: null,
                            query: { ...typeQuery(null), source: source.key },
                          },
                          false,
                          state.pane,
                        );
                      },
                    }))}
                    onDismiss={() => setPopup(null)}
                  />
                </Show>
                <Show when={state.kind === 'restore-pages'}>
                  <DeletedPages
                    anchor={state.anchor}
                    workshop={workshop}
                    onDismiss={() => setPopup(null)}
                    onRestored={id => {
                      setPopup(null);
                      open({ kind: 'page', pageId: id }, false, state.pane);
                    }}
                  />
                </Show>
                <Show when={state.kind === 'delete'}>
                  <Popup
                    anchor={state.anchor}
                    placement={cover() ? 'sheet' : 'anchor'}
                    label="Delete note"
                    title="Delete note"
                    onDismiss={() => setPopup(null)}
                    width={300}
                    fitContent
                  >
                    <p>
                      Delete “
                      {workshop.lookup(pageIdOf(entry(state.pane)) ?? '')()?.text ??
                        rootById().get(pageIdOf(entry(state.pane)) ?? '')?.text}
                      ” and {state.source ? 'its highlights' : 'all its notes'}?
                    </p>
                    <HolderDeletionImpact workshop={workshop} pageId={pageIdOf(entry(state.pane))} />
                    <p class="muted">Undo this deletion, or use Restore deleted note in Commands after reloading.</p>
                    <div class="popup-actions">
                      <Button onClick={() => setPopup(null)}>Cancel</Button>
                      <Button
                        icon="trash"
                        class="danger bordered"
                        disabled={!!deleteDisabledReason(state.pane)}
                        title={deleteDisabledReason(state.pane)}
                        onClick={() => {
                          void deletePage(state.pane);
                        }}
                      >
                        Delete note
                      </Button>
                    </div>
                  </Popup>
                </Show>
                <Show when={state.kind === 'layout'}>
                  <Menu
                    anchor={state.anchor}
                    label="Layout"
                    onDismiss={() => setPopup(null)}
                    items={[
                      {
                        label: 'Open active view beside',
                        icon: 'panes',
                        shortcut: '⌃⇧O',
                        disabledReason: entry(state.pane) ? besideReason(state.pane) : 'No view is open',
                        action: () => openPageBeside(state.pane),
                      },
                      {
                        label: 'Next pane',
                        icon: 'panes',
                        shortcut: '⌃⇧]',
                        disabledReason: split() ? undefined : 'Open a second pane first',
                        action: switchPane,
                      },
                      {
                        label: 'Even pane widths',
                        icon: 'panes',
                        disabledReason: !split()
                          ? 'Open a second pane first'
                          : Object.keys(weights()).length
                            ? undefined
                            : 'Panes are already even',
                        action: () => reflowPanes(() => setWeights({})),
                      },
                      {
                        label: 'Close active pane',
                        icon: 'close',
                        shortcut: '⌃⇧X',
                        disabledReason: split() ? undefined : 'Only one pane is open',
                        action: () => closePane(state.pane),
                      },
                      {
                        section: 'Navigation',
                        label: sidebarVisible() ? 'Hide sidebar' : 'Show sidebar',
                        icon: 'sidebar',
                        action: toggleSidebar,
                      },
                    ]}
                  />
                </Show>
              </>
            )}
          </Show>
          <Show keyed when={creation()}>
            {state => (
              <CreateSlip
                workshop={workshop}
                request={state.request}
                anchor={state.anchor}
                defaultBeside={state.options?.defaultBeside}
                onDismiss={closeCreate}
                onCreated={state.options?.onCreated}
                onOpen={(target, beside) =>
                  state.options?.onOpen ? state.options.onOpen(target, beside) : open(target, beside, state.pane)
                }
                onNotice={showNotice}
                onDraft={setCreateDirty}
              />
            )}
          </Show>
          <ReferencePreviews
            workshop={workshop}
            navigationKey={`${active()}:${order()
              .map(pane => sessions()[pane]?.generation ?? 0)
              .join(':')}`}
            onOpen={(target, beside, pane) => open(target, beside, pane ?? active())}
          />
          <WorkshopOpening />
        </div>
      </AgentMarks.Provider>
    </WorkshopContext.Provider>
  );
}
