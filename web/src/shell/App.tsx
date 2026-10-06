import { batch, createEffect, createMemo, createResource, createSignal, For, lazy, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { Accessor } from 'solid-js';
import { api } from '../api/client';
import type { Block, NotebookInfo, View } from '../api/types';
import { createNotebookClient } from '../document';
import type { NotebookClient, PageDocument } from '../document/contract';
import { OutlinePane } from '../outline/OutlinePane';
import { plainText } from '../outline/BlockText';
import { ReferencePreviews } from '../outline/ReferencePreview';
import { copyTaskQuery, createTaskQuery } from '../tasks/query';
import { copyQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { Calendar } from './Calendar';
import { localDate } from '../ui/MonthGrid';
import { createCommandRegistry } from './commands';
import { deskCounts, shortDay } from './desk-counts';
import { depthLabels, depthStops } from './contract';
import type { AgendaViewState, CommandRegistry, CompareViewState, Depth, FieldsViewState, LibraryViewState, OpenTarget, PaneId, ReaderViewState, ReviewViewState, SettingsViewState, TableViewState, ViewState } from './contract';
import { Palette } from './Palette';

// Panes other than the outline load on demand and are prefetched once the app is idle.
const paneModules = {
  table: () => import('../table/TablePane'),
  fields: () => import('../fields/FieldsPane'),
  settings: () => import('../settings/SettingsPane'),
  agenda: () => import('../tasks/AgendaPane'),
  review: () => import('../review/ReviewPane'),
  library: () => import('../library/LibraryPane'),
  reader: () => import('../reader/ReaderPane'),
  compare: () => import('../compare/ComparePane'),
};
const TablePane = lazy(() => paneModules.table().then(module => ({ default: module.TablePane })));
const FieldsPane = lazy(() => paneModules.fields().then(module => ({ default: module.FieldsPane })));
const SettingsPane = lazy(() => paneModules.settings().then(module => ({ default: module.SettingsPane })));
const AgendaPane = lazy(() => paneModules.agenda().then(module => ({ default: module.AgendaPane })));
const ReviewPane = lazy(() => paneModules.review().then(module => ({ default: module.ReviewPane })));
const LibraryPane = lazy(() => paneModules.library().then(module => ({ default: module.LibraryPane })));
const ReaderPane = lazy(() => paneModules.reader().then(module => ({ default: module.ReaderPane })));
const ComparePane = lazy(() => paneModules.compare().then(module => ({ default: module.ComparePane })));

type PaneView = ViewState | TableViewState | FieldsViewState | SettingsViewState | AgendaViewState | ReviewViewState | LibraryViewState | ReaderViewState | CompareViewState;
type HistoryEntry = { target: OpenTarget; view: PaneView };
type PaneSession = { entries: HistoryEntry[]; index: number; generation: number };
type PageStyle = 'bullets' | 'prose';
type SavedNavigation = { pinned?: string[]; pinnedViews?: string[]; pageStyles?: Record<string, PageStyle>; recent?: string[]; vim?: boolean; panes?: Partial<Record<PaneId, HistoryEntry>>; active?: PaneId };
type VimMode = 'insert' | 'normal' | 'visual' | 'outline' | null;
const vimLabels: Record<Exclude<VimMode, null>, string> = { insert: 'Insert', normal: 'Normal', visual: 'Visual', outline: 'Outline' };
type PopupState = { kind: 'search' | 'commands' | 'calendar' | 'new' | 'delete' | 'layout'; anchor: HTMLElement; pane: PaneId; date?: string } | null;
const paneIds: PaneId[] = ['main', 'side'];
const SAVE_NOTICE_DELAY = 1000;

/** Views are snapshots: fold arrays and caret/scroll objects never alias history. */
function copyView(view: ViewState): ViewState {
  return { ...view, folds: view.folds ? [...view.folds] : null, caret: view.caret ? { ...view.caret } : null, scroll: view.scroll ? { ...view.scroll } : null };
}

function pageIdOf(current: HistoryEntry | undefined): string | undefined {
  return current?.target.kind === 'page' ? current.target.pageId : undefined;
}
/** Header and tab text for panes that are not pages. */
function paneLabel(target: OpenTarget | undefined): string {
  return target?.kind === 'table' ? 'Table' : target?.kind === 'fields' ? 'Fields' : target?.kind === 'settings' ? 'Settings' : target?.kind === 'agenda' ? 'Agenda' : target?.kind === 'review' ? 'Review' : target?.kind === 'library' ? 'Library' : target?.kind === 'reader' ? 'Reader' : target?.kind === 'compare' ? 'Compare' : 'Loading…';
}
function snapshotView(view: PaneView): PaneView {
  if ('mode' in view) return { ...view, query: copyTaskQuery(view.query) };
  if ('deckId' in view) return { ...view, selection: view.selection ?? null };
  if ('tab' in view) return { ...view, view: view.view ?? null, colors: [...view.colors ?? []], tags: [...view.tags ?? []] };
  if ('ordinal' in view) return { ...view };
  return 'query' in view ? { query: copyQuery(view.query), scroll: view.scroll } : 'zoom' in view ? copyView(view) : { scroll: view.scroll };
}
function targetFromView(entry: HistoryEntry): OpenTarget {
  const { target, view } = entry;
  if (target.kind === 'table' && 'query' in view && !('mode' in view)) return { ...target, query: copyQuery(view.query), typeId: view.query.type };
  if (target.kind === 'agenda' && 'mode' in view) return { kind: 'agenda', date: view.date, viewId: view.viewId ?? undefined, query: copyTaskQuery(view.query) };
  if (target.kind === 'review' && 'deckId' in view) return { kind: 'review', deckId: view.deckId ?? undefined };
  if (target.kind === 'library' && 'tab' in view) return { kind: 'library', tab: view.tab };
  // A jump not yet performed (no position reported) survives a reload.
  if (target.kind === 'reader' && 'ordinal' in view) return view.ordinal < 0 ? { ...target, snapshotId: view.snapshotId ?? target.snapshotId } : { kind: 'reader', sourceId: target.sourceId, snapshotId: view.snapshotId ?? undefined };
  if (target.kind === 'page' && 'zoom' in view) return { kind: 'page', pageId: target.pageId, blockId: view.zoom ?? undefined };
  return target;
}

export function App() {
  const identityKey = `tessera.identity.${location.origin}`;
  let cachedIdentity: NotebookInfo | undefined;
  try {
    const value = JSON.parse(localStorage.getItem(identityKey) ?? 'null') as NotebookInfo | null;
    if (value && typeof value.id === 'string' && typeof value.path === 'string') cachedIdentity = value;
  } catch { /* A first offline visit has no cached notebook identity. */ }
  const notebook = createNotebookClient({ notebookId: cachedIdentity?.id });
  onCleanup(() => { void notebook.dispose(); });
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
  const [sessions, setSessions] = createSignal<Record<PaneId, PaneSession>>({ main: { entries: [], index: -1, generation: 0 }, side: { entries: [], index: -1, generation: 0 } });
  const [active, setActive] = createSignal<PaneId>('main');
  const vim = notebook.vim;
  const [vimModes, setVimModes] = createSignal<Record<PaneId, VimMode>>({ main: null, side: null });
  const narrowQuery = window.matchMedia('(max-width: 1047px)');
  const [narrow, setNarrow] = createSignal(narrowQuery.matches);
  const [sidebar, setSidebar] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const sidebarVisible = () => narrow() ? sidebar() : !sidebarCollapsed();
  const toggleSidebar = () => {
    if (narrow()) setSidebar(value => !value);
    else setSidebarCollapsed(value => !value);
  };
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [pinned, setPinned] = createSignal<string[]>([]);
  const [pinnedViews, setPinnedViews] = createSignal<string[]>([]);
  // Pages whose display differs from their kind's default: journal days show bullets, titled pages prose.
  const [pageStyles, setPageStyles] = createSignal<Record<string, PageStyle>>({});
  const [recent, setRecent] = createSignal<string[]>([]);
  const [navigationId, setNavigationId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [offlineUnavailable, setOfflineUnavailable] = createSignal(false);
  const [deleted, setDeleted] = createSignal<{ id: string; title: string } | null>(null);
  const todayDate = () => notebook.todayDate();
  const counts = deskCounts(notebook, todayDate);
  let searchButton!: HTMLButtonElement;
  const entry = (pane: PaneId) => sessions()[pane].entries[sessions()[pane].index];
  const split = () => sessions().main.index >= 0 && sessions().side.index >= 0;
  const activeRoot = () => notebook.roots().find(root => root.id === pageIdOf(entry(active())));
  const journalDate = (pane: PaneId) => {
    const root = notebook.roots().find(root => root.id === pageIdOf(entry(pane)));
    return root?.kind === 'journal' ? root.text : todayDate();
  };
  const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const remember = (id: string) => setRecent(values => [id, ...values.filter(value => value !== id)].slice(0, 10));
  let focusEpoch = 0;
  const navigationRequests: Record<PaneId, number> = { main: 0, side: 0 };
  const focusPane = (pane: PaneId) => {
    const epoch = ++focusEpoch;
    requestAnimationFrame(() => {
      if (epoch !== focusEpoch) return;
      const root = document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"]`);
      if (!root) return;
      setActive(pane);
      const editor = root.querySelector<HTMLElement>('.cm-content');
      (editor?.getClientRects().length ? editor : root.querySelector<HTMLElement>('.review-card') ?? root.querySelector<HTMLElement>('.outline-pane, .table-pane, .fields-pane, .settings-pane, .agenda-pane, .review-pane'))?.focus({ preventScroll: true });
    });
  };
  const open = (target: OpenTarget, beside = false, owner = active(), restore?: PaneView) => {
    const pane: PaneId = beside ? owner === 'main' ? 'side' : 'main' : owner;
    const request = ++navigationRequests[pane];
    if (target.kind === 'agenda' && target.viewId && !target.query) {
      void notebook.api.taskView(target.viewId).then(saved => {
        if (request === navigationRequests[pane]) open({ ...target, query: saved.query, date: target.date ?? saved.query.context_date }, beside, owner, restore);
      }).catch(reason => { if (request === navigationRequests[pane]) reportError(reason); });
      return;
    }
    const current = entry(pane);
    if (target.kind === 'review' && current?.target.kind === 'review' && 'deckId' in current.view) {
      const next = restore && 'deckId' in restore ? { ...restore } : { deckId: target.deckId ?? null, sessionId: null, selection: null, scroll: 0 };
      if (restore || next.deckId !== current.view.deckId) changeView(pane, next);
      setActive(pane); setSidebar(false); focusPane(pane);
      return;
    }
    // An explicit caret target still needs the view rebuilt even when the same zoom is already open beside.
    const samePage = target.kind === 'page' && !target.caretId && current?.target.kind === 'page' && current.target.pageId === target.pageId && 'zoom' in current.view && current.view.zoom === (target.blockId ?? null);
    if (!beside || !samePage) {
      const date = target.kind === 'agenda' ? target.date ?? target.query?.context_date ?? todayDate() : '';
      const view: PaneView = restore ? snapshotView(restore) : target.kind === 'table'
        ? { query: copyQuery(target.query), scroll: 0 }
        : target.kind === 'agenda' ? { date, mode: target.query || target.viewId ? 'tasks' : 'agenda', query: { ...(target.query ? copyTaskQuery(target.query) : createTaskQuery(date)), context_date: date }, viewId: target.viewId ?? null, scroll: 0 }
          : target.kind === 'review' ? { deckId: target.deckId ?? null, sessionId: null, selection: null, scroll: 0 }
            : target.kind === 'fields' || target.kind === 'settings' || target.kind === 'compare' ? { scroll: 0 }
              : target.kind === 'library' ? { view: null, tab: target.tab ?? 'inbox', text: '', sort: 'added', unprocessedOnly: true, colors: [], tags: [], scroll: 0 }
                : target.kind === 'reader' ? { snapshotId: target.snapshotId ?? null, ordinal: -1, offset: 0 }
                  : { zoom: target.blockId ?? null, caret: target.blockId ? { id: target.caretId ?? target.blockId, offset: target.caretOffset ?? 0 } : null, scroll: null, folds: null, showArchived: false, ...(target.blockId && target.caretId ? { edit: true } : {}) };
      setSessions(values => {
        const previous = values[pane];
        const next = { entries: [...previous.entries.slice(0, previous.index + 1), { target, view }], index: previous.index + 1, generation: previous.generation + 1 };
        return { ...values, [pane]: next };
      });
    }
    setActive(pane); setSidebar(false);
    if (target.kind === 'page') remember(target.pageId);
    focusPane(pane);
  };
  const changeView = (pane: PaneId, view: PaneView, restore = false) => setSessions(values => {
    const session = values[pane]; const current = session.entries[session.index]; if (!current) return values;
    if ('zoom' in view && 'zoom' in current.view && view.zoom !== current.view.zoom) {
      const entries = [...session.entries.slice(0, session.index + 1), { target: current.target, view: copyView(view) }];
      return { ...values, [pane]: { entries, index: session.index + 1, generation: session.generation + (restore ? 1 : 0) } };
    }
    const entries = [...session.entries];
    entries[session.index] = { target: targetFromView({ target: current.target, view }), view: snapshotView(view) };
    return { ...values, [pane]: { ...session, entries, generation: session.generation + (restore ? 1 : 0) } };
  });
  const changeTarget = (pane: PaneId, target: OpenTarget) => setSessions(values => {
    const session = values[pane]; const entries = [...session.entries];
    entries[session.index] = { ...entries[session.index]!, target };
    return { ...values, [pane]: { ...session, entries } };
  });
  const travel = (pane: PaneId, delta: number) => {
    const session = sessions()[pane]; const index = session.index + delta;
    if (index < 0 || index >= session.entries.length) return;
    navigationRequests[pane]++;
    setSessions(values => ({ ...values, [pane]: { ...values[pane], index, generation: values[pane].generation + 1 } }));
    setActive(pane); const pageId = pageIdOf(session.entries[index]); if (pageId) remember(pageId);
    focusPane(pane);
  };
  const today = async (pane = active(), beside = false) => { try { open({ kind: 'page', pageId: await notebook.today() }, beside, pane); } catch (reason) { reportError(reason); } };
  const journal = async (value: string, pane = active()) => { try { open({ kind: 'page', pageId: await notebook.journal(value) }, false, pane); } catch (reason) { reportError(reason); } };
  const shiftDate = (delta: number, pane = active()) => { const next = new Date(`${journalDate(pane)}T12:00:00`); next.setDate(next.getDate() + delta); void journal(localDate(next), pane); };
  const switchPane = () => {
    if (!split()) return;
    const pane = active() === 'main' ? 'side' : 'main';
    setActive(pane);
    focusPane(pane);
  };
  const closePane = (pane: PaneId) => {
    if (!split()) return;
    navigationRequests[pane]++;
    setSessions(values => ({ ...values, [pane]: { entries: [], index: -1, generation: values[pane].generation + 1 } }));
    setActive(pane === 'main' ? 'side' : 'main');
    focusPane(pane === 'main' ? 'side' : 'main');
  };
  const pin = (id: string) => setPinned(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  const pinView = (id: string) => setPinnedViews(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  const openView = (view: View, beside = false) => open({ kind: 'table', typeId: view.query.type, viewId: view.id, query: copyQuery(view.query) }, beside);
  const showPalette = (kind: 'search' | 'commands') => setPopup({ kind, anchor: kind === 'search' ? searchButton : document.body, pane: active() });
  const chooseDate = (pane = active(), anchor: HTMLElement = document.querySelector<HTMLButtonElement>(`[data-pane="${pane}"] .journal-date`) ?? searchButton) => {
    setPopup({ kind: 'calendar', anchor, pane, date: journalDate(pane) });
  };
  const runOutline = (suffix: string, pane = active()) => commands.list().find(command => command.id === `outline.${pane}.${suffix}`)?.run();
  const reviewConflict = () => {
    const conflicted = notebook.conflictedPages();
    const pageId = conflicted.includes(pageIdOf(entry(active())) ?? '') ? pageIdOf(entry(active())) : conflicted[0];
    if (!pageId) return;
    const pane = paneIds.find(owner => pageIdOf(entry(owner)) === pageId) ?? active();
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
    const root = notebook.roots().find(block => block.id === pageId);
    const title = notebook.lookup(pageId)()?.text ?? root?.text ?? 'Page';
    try {
      await notebook.deletePage(pageId);
      setDeleted({ id: pageId, title }); setPopup(null);
      const remaining = notebook.roots().find(block => block.id !== pageId);
      const previousDay = new Date(`${todayDate()}T12:00:00`);
      previousDay.setDate(previousDay.getDate() - 1);
      // Do not recreate a deleted journal date: that would prevent restoring its IDs.
      const replacement = remaining?.id ?? (root?.kind === 'journal' && root.text === todayDate() ? await notebook.journal(localDate(previousDay)) : await notebook.today());
      for (const owner of paneIds) if (pageIdOf(entry(owner)) === pageId) open({ kind: 'page', pageId: replacement }, false, owner);
    } catch (reason) { reportError(reason); }
  };
  const restorePage = async () => {
    const value = deleted(); if (!value) return;
    try { await notebook.restorePage(value.id); setDeleted(null); open({ kind: 'page', pageId: value.id }); } catch (reason) { reportError(reason); }
  };
  onMount(() => {
    const onNarrow = () => setNarrow(narrowQuery.matches);
    narrowQuery.addEventListener('change', onNarrow);
    onCleanup(() => narrowQuery.removeEventListener('change', onNarrow));
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey || document.querySelector('.popup')) return;
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
        if (stored.pageStyles && typeof stored.pageStyles === 'object') setPageStyles(Object.fromEntries(Object.entries(stored.pageStyles).filter(([, style]) => style === 'bullets' || style === 'prose')));
        if (Array.isArray(stored.recent)) setRecent([...new Set(stored.recent)].filter(value => typeof value === 'string').slice(0, 10));
      });
      const restored: Record<PaneId, PaneSession> = { main: { entries: [], index: -1, generation: 0 }, side: { entries: [], index: -1, generation: 0 } };
      for (const pane of paneIds) {
        const saved = stored.panes?.[pane];
        if (!saved?.target || !saved.view) continue;
        let current: HistoryEntry;
        if (saved.target.kind === 'table' && 'query' in saved.view && !('mode' in saved.view)) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'agenda' && 'mode' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'review' && 'deckId' in saved.view) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if ((saved.target.kind === 'fields' || saved.target.kind === 'settings' || saved.target.kind === 'compare') && 'scroll' in saved.view && typeof saved.view.scroll === 'number') {
          current = { target: saved.target, view: { scroll: saved.view.scroll } };
        } else if ((saved.target.kind === 'library' && 'tab' in saved.view) || (saved.target.kind === 'reader' && 'ordinal' in saved.view)) {
          current = { target: targetFromView(saved), view: snapshotView(saved.view) };
        } else if (saved.target.kind === 'page' && 'zoom' in saved.view) {
          const savedId = saved.target.pageId;
          const exists = notebook.roots().some(root => root.id === savedId);
          current = exists ? { target: saved.target, view: copyView(saved.view) } : { target: { kind: 'page', pageId: await notebook.today() }, view: { zoom: null, caret: null, scroll: null, folds: null, showArchived: false } };
        } else continue;
        restored[pane] = { entries: [current], index: 0, generation: 1 };
      }
      if (restored.main.index >= 0 || restored.side.index >= 0) {
        const pane = stored.active && restored[stored.active]?.index >= 0 ? stored.active : restored.main.index >= 0 ? 'main' : 'side';
        batch(() => { setActive(pane); setSessions(restored); });
      } else await today();
      setNavigationId(notebookInfo.id);
    })().catch(reportError);
  });
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
    const panes: Partial<Record<PaneId, HistoryEntry>> = {};
    for (const pane of paneIds) { const current = entry(pane); if (current) panes[pane] = current; }
    navigationWrite = { key: `tessera.navigation.${id}`, value: { pinned: pinned(), pinnedViews: pinnedViews(), pageStyles: pageStyles(), recent: recent(), vim: vim(), panes, active: active() } };
    clearTimeout(navigationTimer);
    navigationTimer = window.setTimeout(writeNavigation, 500);
  });
  const unregister = commands.register([
    { id: 'shell.search', title: 'Find or create', section: 'Navigation', keys: ['⌃⇧F'], run: () => showPalette('search') },
    { id: 'shell.commands', title: 'Show commands', section: 'Navigation', keys: ['⌃⇧P'], run: () => showPalette('commands') },
    { id: 'shell.settings', title: 'Open settings', section: 'Navigation', run: () => open({ kind: 'settings' }) },
    { id: 'shell.today', title: 'Open today’s journal', section: 'Navigation', keys: ['⌃⇧J'], run: () => { void today(); } },
    { id: 'shell.fields', title: 'Open fields', section: 'Navigation', run: () => open({ kind: 'fields' }) },
    { id: 'shell.agenda', title: 'Open agenda', section: 'Navigation', run: () => open({ kind: 'agenda', date: journalDate(active()) }) },
    { id: 'shell.review', title: 'Open review', section: 'Navigation', run: () => open({ kind: 'review' }) },
    { id: 'shell.library', title: 'Open library', section: 'Navigation', run: () => open({ kind: 'library' }) },
    { id: 'shell.previous-day', title: 'Previous journal day', section: 'Navigation', run: () => shiftDate(-1) },
    { id: 'shell.next-day', title: 'Next journal day', section: 'Navigation', run: () => shiftDate(1) },
    { id: 'shell.calendar', title: 'Choose journal date', section: 'Navigation', run: () => chooseDate() },
    { id: 'shell.back', title: 'Back', section: 'Navigation', keys: ['⌃⇧H'], disabledReason: () => sessions()[active()].index <= 0 ? 'No earlier page in this pane' : undefined, run: () => travel(active(), -1) },
    { id: 'shell.forward', title: 'Forward', section: 'Navigation', keys: ['⌃⇧L'], disabledReason: () => sessions()[active()].index >= sessions()[active()].entries.length - 1 ? 'No later page in this pane' : undefined, run: () => travel(active(), 1) },
    { id: 'shell.page-beside', title: 'Open active view beside', section: 'Navigation', run: () => openPageBeside() },
    { id: 'shell.switch', title: 'Switch panes', section: 'View', keys: ['⌃⇧]'], disabledReason: () => !split() ? 'Open a second pane first' : undefined, run: switchPane },
    { id: 'shell.close', title: 'Close active pane', section: 'View', keys: ['⌃⇧X'], disabledReason: () => !split() ? 'Only one pane is open' : undefined, run: () => closePane(active()) },
    { id: 'shell.new', title: 'New page', section: 'Page', run: () => setPopup({ kind: 'new', anchor: searchButton, pane: active() }) },
    { id: 'shell.pin', title: 'Pin / unpin page', section: 'Page', run: () => { const root = activeRoot(); if (root) pin(root.id); } },
    { id: 'shell.delete', title: 'Delete page', section: 'Page', run: () => { const anchor = document.querySelector<HTMLButtonElement>(`[data-pane="${active()}"] .page-menu-button`); if (anchor) setPopup({ kind: 'delete', anchor, pane: active() }); } },
    { id: 'shell.restore-page', title: 'Undo page deletion', section: 'Page', disabledReason: () => deleted() ? undefined : 'No deleted page to restore', run: () => { void restorePage(); } },
    { id: 'shell.review-conflict', title: 'Review notebook conflict', section: 'Editing', disabledReason: () => notebook.conflictedPages().length ? undefined : 'No conflicting blocks', run: reviewConflict },
    { id: 'shell.retry', title: 'Retry saving', section: 'Editing', disabledReason: () => notebook.saveState() === 'saved' && notebook.connection() === 'live' ? 'All changes are saved' : undefined, run: () => notebook.retry() },
    { id: 'shell.copy-unsaved', title: 'Copy unsaved text', section: 'Editing', disabledReason: () => notebook.localPersistence() === 'failed' || notebook.rejectedText() ? undefined : 'Local recovery storage is working', run: () => { void navigator.clipboard.writeText(notebook.rejectedText() || notebook.unsavedText()).catch(reportError); } },
    { id: 'shell.dismiss-rejected', title: 'Dismiss rejected changes', section: 'Editing', disabledReason: () => notebook.rejectedText() ? undefined : 'No rejected changes', run: () => notebook.dismissRejected() },
    { id: 'shell.sidebar', title: 'Toggle sidebar', section: 'View', run: toggleSidebar },
  ]);
  onCleanup(unregister);
  createEffect(() => {
    const unregisterViews = commands.register((views() ?? []).map(view => ({
      id: `shell.view.${view.id}`, title: `Open view: ${view.name}`, section: 'Navigation' as const,
      run: () => open({ kind: 'table', typeId: view.query.type, viewId: view.id, query: copyQuery(view.query) }),
    })));
    onCleanup(unregisterViews);
  });
  const rootById = createMemo(() => new Map(notebook.roots().map(root => [root.id, root])));
  const pinnedRoots = () => pinned().map(id => rootById().get(id)).filter((root): root is Block => !!root);
  const recentRoots = () => recent().filter(id => !pinned().includes(id)).map(id => rootById().get(id)).filter((root): root is Block => !!root).slice(0, 10);
  const pinnedViewList = createMemo(() => (views() ?? []).filter(view => pinnedViews().includes(view.id)));
  const otherViews = createMemo(() => (views() ?? []).filter(view => !pinnedViews().includes(view.id)));
  const activeViewId = () => { const target = entry(active())?.target; return target?.kind === 'table' ? target.viewId ?? undefined : undefined; };
  // Sidebar sections carry rubric numerals counted over the sections actually shown.
  const sectionNumber = (section: 'pinned' | 'views' | 'recent') => {
    const shown = [...pinnedRoots().length || pinnedViewList().length ? ['pinned'] : [], ...otherViews().length ? ['views'] : [], 'recent'];
    return String(shown.indexOf(section) + 1).padStart(2, '0');
  };
  return <div class={`app ${split() ? 'is-split' : ''} ${sidebar() ? 'sidebar-expanded' : ''} ${sidebarCollapsed() ? 'sidebar-collapsed' : ''}`} onPointerDown={() => { focusEpoch++; }}>
    <header class="global-rail" aria-label="Global navigation">
      <div class="rail-start">
        <Button icon="sidebar" label="Toggle sidebar" aria-expanded={sidebarVisible()} onClick={toggleSidebar} />
        <span class="wordmark" title={info()?.path}>Tessera</span>
      </div>
      <div class="rail-finder" role="group" aria-label="Find and commands">
        <Button ref={searchButton} class="global-search" icon="find" label="Find or create" shortcut="⌃⇧F" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'search'} onClick={() => showPalette('search')}><span>Find or create…</span><kbd>⌃⇧F</kbd></Button>
        <Button class="global-commands" icon="command" label="Commands" shortcut="⌃⇧P" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'commands'} onClick={() => showPalette('commands')} />
      </div>
      <div class="rail-end">
        <Button icon="panes" label="Layout" aria-haspopup="menu" aria-expanded={popup()?.kind === 'layout'} onClick={event => setPopup({ kind: 'layout', anchor: event.currentTarget, pane: active() })} />
      </div>
    </header>
    <aside class="sidebar" aria-label="Notebook navigation" aria-hidden={!sidebarVisible()} inert={!sidebarVisible()}>
      <nav class="primary-navigation" aria-label="Notebook">
        <Button icon="today" title="Today (⌃⇧J)" class={activeRoot()?.kind === 'journal' && activeRoot()?.text === todayDate() ? 'selected' : ''} onClick={event => { void today(active(), event.shiftKey); }}><span>Today</span><span class="desk-count">{shortDay(todayDate())}</span></Button>
        <Button icon="agenda" class={entry(active())?.target.kind === 'agenda' ? 'selected' : ''} onClick={event => open({ kind: 'agenda', date: journalDate(active()) }, event.shiftKey)}><span>Agenda</span><Show when={counts()?.planned}>{planned => <span class={`desk-count ${counts()!.overdue ? 'late' : ''}`} title={counts()!.overdue ? `${planned()} to do today · ${counts()!.overdue} overdue` : `${planned()} to do today`}>{planned()}</span>}</Show></Button>
        <Button icon="review" class={entry(active())?.target.kind === 'review' ? 'selected' : ''} onClick={event => open({ kind: 'review' }, event.shiftKey)}><span>Review</span><Show when={counts()?.cards}>{cards => <span class="desk-count" title={`${cards()} ${cards() === 1 ? 'card' : 'cards'} due`}>{cards()}</span>}</Show></Button>
        <Button icon="library" class={entry(active())?.target.kind === 'library' ? 'selected' : ''} onClick={event => open({ kind: 'library' }, event.shiftKey)}><span>Library</span><Show when={counts()?.highlights}>{highlights => <span class="desk-count" title={`${highlights()} unprocessed ${highlights() === 1 ? 'highlight' : 'highlights'}`}>{highlights()}</span>}</Show></Button>
      </nav>
      <Show when={pinnedRoots().length || pinnedViewList().length}><section class="page-list" aria-label="Pinned">
        <h2><span class="section-number">{sectionNumber('pinned')}</span>Pinned<span class="section-rule" /><span class="section-count">{pinnedRoots().length + pinnedViewList().length}</span></h2>
        <PageLinks roots={pinnedRoots()} notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} />
        <ViewLinks views={pinnedViewList()} pinned activeId={activeViewId()} onOpen={openView} onPin={pinView} />
      </section></Show>
      <Show when={otherViews().length}><section class="page-list" aria-label="Saved views">
        <h2><span class="section-number">{sectionNumber('views')}</span>Views<span class="section-rule" /><span class="section-count">{otherViews().length}</span></h2>
        <ViewLinks views={otherViews()} pinned={false} activeId={activeViewId()} onOpen={openView} onPin={pinView} />
      </section></Show>
      <details class="page-list" open>
        <summary><span class="section-number">{sectionNumber('recent')}</span>Recent<span class="section-rule" /><Icon name="down" /></summary>
        <Show when={recentRoots().length} fallback={<p class="sidebar-empty">Pages you open appear here</p>}><PageLinks roots={recentRoots()} sourceIcons notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} /></Show>
      </details>
      <div class="sidebar-foot">
        <Button icon="settings" class={entry(active())?.target.kind === 'settings' ? 'selected' : ''} onClick={event => open({ kind: 'settings' }, event.shiftKey)}><span>Settings</span></Button>
        <Button icon="field" label="Fields" class={`icon-only ${entry(active())?.target.kind === 'fields' ? 'selected' : ''}`} onClick={event => open({ kind: 'fields' }, event.shiftKey)} />
      </div>
    </aside>
    <main class="workspace">
      <Show when={split()}><div class="pane-tabs" role="tablist" aria-label="Working panes"><For each={paneIds}>{pane => <Button role="tab" aria-selected={active() === pane} onClick={() => { if (active() !== pane) switchPane(); }}>{pane === 'main' ? 'Pane 1' : 'Pane 2'} · {rootById().get(pageIdOf(entry(pane)) ?? '')?.text ?? paneLabel(entry(pane)?.target)}</Button>}</For></div></Show>
      <Show when={error()}><div class="shell-error" role="alert"><Icon name="warning" /><span>{error()}</span><Button onClick={() => { if (offlineUnavailable()) { location.reload(); return; } setError(''); void today(); }}>Retry</Button></div></Show>
      <GlobalBanner notebook={notebook} onReview={reviewConflict} />
      <div class="panes"><For each={paneIds}>{pane => <Show when={entry(pane)}>
        <Pane pane={pane} session={() => sessions()[pane]} active={active() === pane} split={split()} notebook={notebook} commands={commands} vim={vim()} vimMode={vimModes()[pane]} onVimMode={mode => setVimModes(values => ({ ...values, [pane]: mode }))} pinned={pinned().includes(pageIdOf(entry(pane)) ?? '')} pageStyles={pageStyles()}
          onPageStyle={(id, style, fallback) => setPageStyles(({ [id]: _, ...rest }) => style === fallback ? rest : { ...rest, [id]: style })}
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
          onDelete={anchor => setPopup({ kind: 'delete', anchor, pane })}
          onArchived={() => { runOutline('show-archived', pane); focusPane(pane); }}
          onRestoreView={view => changeView(pane, view, true)}
        />
      </Show>}</For></div>
      <Show when={!entry('main') && !entry('side') && !error()}><div class="startup-state">Opening today’s journal…</div></Show>
    </main>
    <Show keyed when={popup()}>{state => <>
      <Show when={state.kind === 'search' || state.kind === 'commands'}>
        <Palette anchor={state.anchor} pane={state.pane} mode={state.kind === 'commands' ? 'commands' : 'search'} commands={commands} notebook={notebook} onDismiss={() => setPopup(null)} onRestoreFocus={() => { if (!popup() && active() === state.pane) focusPane(state.pane); }} onOpen={(target, beside) => open(target, beside, state.pane)} />
      </Show>
      <Show when={state.kind === 'calendar'}>
        <Calendar notebook={notebook} anchor={state.anchor} date={state.date ?? journalDate(state.pane)} today={todayDate()} onToday={() => { void today(state.pane); }} onDismiss={() => setPopup(null)} onSelect={value => { void journal(value, state.pane); }} />
      </Show>
      <Show when={state.kind === 'new'}>
        <NewPage anchor={state.anchor} notebook={notebook} onDismiss={() => setPopup(null)} onOpen={id => { setPopup(null); open({ kind: 'page', pageId: id }, false, state.pane); }} />
      </Show>
      <Show when={state.kind === 'delete'}>
        <Popup anchor={state.anchor} label="Delete page" onDismiss={() => setPopup(null)} width={300}>
          <p>Delete “{notebook.lookup(pageIdOf(entry(state.pane)) ?? '')()?.text ?? rootById().get(pageIdOf(entry(state.pane)) ?? '')?.text}” and all its blocks?</p>
          <p class="muted">You can undo this deletion.</p>
          <div class="popup-actions"><Button onClick={() => setPopup(null)}>Cancel</Button><Button icon="trash" class="danger bordered" onClick={() => { void deletePage(state.pane); }}>Delete page</Button></div>
        </Popup>
      </Show>
      <Show when={state.kind === 'layout'}>
        <Menu anchor={state.anchor} label="Layout" onDismiss={() => setPopup(null)} items={[
          { label: 'Open active view beside', icon: 'panes', shortcut: '⌃⇧O', disabledReason: entry(state.pane) ? undefined : 'No view is open', action: () => openPageBeside(state.pane) },
          { label: 'Switch panes', icon: 'panes', shortcut: '⌃⇧]', disabledReason: split() ? undefined : 'Open a second pane first', action: switchPane },
          { label: 'Close active pane', icon: 'close', shortcut: '⌃⇧X', disabledReason: split() ? undefined : 'Only one pane is open', action: () => closePane(state.pane) },
          { section: 'Navigation', label: sidebarVisible() ? 'Hide sidebar' : 'Show sidebar', icon: 'sidebar', action: toggleSidebar },
        ]} />
      </Show>
    </>}</Show>
    <ReferencePreviews notebook={notebook} onOpen={(target, beside, pane) => open(target, beside, pane ?? active())} />
    <Show when={deleted()}>{value => <div class="undo-toast" role="status"><Icon name="trash" /><span>“{value().title}” deleted</span><Button icon="undo" onClick={() => { void restorePage(); }}>Undo</Button><Button icon="close" label="Dismiss deletion notification" onClick={() => setDeleted(null)} /></div>}</Show>
  </div>;
}

function PageLinks(props: { roots: Block[]; sourceIcons?: boolean; notebook: NotebookClient; activeId?: string; onOpen(target: OpenTarget, beside?: boolean): void }) {
  // Roots arrive as fresh objects whenever any root changes; keying rows by id keeps them mounted.
  const byId = createMemo(() => new Map(props.roots.map(root => [root.id, root])));
  const ids = createMemo(() => props.roots.map(root => root.id), undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  return <For each={ids()}>{id => {
    const root = () => byId().get(id)!;
    const title = () => props.notebook.lookup(id)()?.text ?? root().text;
    // A page gains a source only on ingest, so one lookup per mounted row is enough.
    const [capabilities] = createResource(() => props.sourceIcons && root().kind === 'page' ? id : false, id => props.notebook.api.capabilities(id));
    return <Button class={id === props.activeId ? 'selected' : ''} icon={root().kind === 'journal' ? 'today' : capabilities.error || !capabilities()?.source ? 'page' : capabilities()!.source!.format === 'article' ? 'article' : 'book'} title={title()} onClick={event => props.onOpen({ kind: 'page', pageId: id }, event.shiftKey)}><span>{title()}</span></Button>;
  }}</For>;
}

function ViewLinks(props: { views: View[]; pinned: boolean; activeId?: string; onOpen(view: View, beside: boolean): void; onPin(id: string): void }) {
  return <For each={props.views}>{view => <div class="sidebar-view">
    <Button class={`view-link ${view.id === props.activeId ? 'selected' : ''}`} icon="table" title={view.name} onClick={event => props.onOpen(view, event.shiftKey)}><span>{view.name}</span></Button>
    <Button class="view-pin" icon="pin" label={`${props.pinned ? 'Unpin' : 'Pin'} view ${view.name}`} aria-pressed={props.pinned} onClick={() => props.onPin(view.id)} />
  </div>}</For>;
}

function NewPage(props: { anchor: HTMLElement; notebook: NotebookClient; onDismiss(): void; onOpen(id: string): void }) {
  const [title, setTitle] = createSignal(''); const [error, setError] = createSignal(''); const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    if (!title().trim() || busy()) return;
    setBusy(true); setError('');
    try { props.onOpen(await props.notebook.createPage(title().trim())); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  return <Popup anchor={props.anchor} label="New page" onDismiss={props.onDismiss} width={320}><form onSubmit={event => { event.preventDefault(); void submit(); }}><label for="new-page-title">Page title</label><input id="new-page-title" class="input" value={title()} onInput={event => setTitle(event.currentTarget.value)} placeholder="Name your page" /><Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={!title().trim() || busy()}>{busy() ? 'Creating…' : 'Create page'}</Button></div></form></Popup>;
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

function Pane(props: { pane: PaneId; session: Accessor<PaneSession>; active: boolean; split: boolean; notebook: NotebookClient; commands: CommandRegistry; vim: boolean; vimMode: VimMode; onVimMode(mode: VimMode): void; pinned: boolean; pageStyles: Record<string, PageStyle>; onPageStyle(id: string, style: PageStyle, fallback: PageStyle): void; onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void; onTargetChange(target: OpenTarget): void; onPageBeside(): void; onViewChange(view: PaneView): void; onTravel(delta: number): void; onClose(): void; onChooseDate(anchor: HTMLElement): void; onShiftDate(delta: number): void; onPin(): void; onRename(): void; onDelete(anchor: HTMLElement): void; onArchived(): void; onRestoreView(view: ViewState): void }) {
  const current = () => props.session().entries[props.session().index]!;
  const pageId = createMemo(() => pageIdOf(current()));
  const outlineView = () => current().view as ViewState;
  const [doc, setDoc] = createSignal<PageDocument>();
  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  let menuButton!: HTMLButtonElement;
  createEffect(() => {
    const id = pageId(); setDoc(undefined); if (!id) return;
    const document = props.notebook.open(id); setDoc(document);
    onCleanup(() => document.release());
  });
  const root = () => doc()?.root();
  const defaultStyle = (): PageStyle => root()?.kind === 'journal' ? 'bullets' : 'prose';
  const pageStyle = (): PageStyle | undefined => { const id = pageId(); return id && root() ? props.pageStyles[id] ?? defaultStyle() : undefined; };
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
  const saveState = () => { const state = doc()?.saveState(); return state === 'queued' || state === 'saving' && !slowSave() ? 'saved' : state; };
  const status = () => {
    const state = saveState();
    return state === 'conflict' ? 'Conflict · Both versions kept' : state === 'error' ? 'Couldn’t save · Local changes kept' : state === 'offline' ? 'Offline' : 'Saving…';
  };
  const undo = (redo: boolean) => {
    const caret = redo ? doc()?.redo() : doc()?.undo(); if (caret) props.onRestoreView({ ...outlineView(), caret });
  };
  const rootCapability = (kind: 'task' | 'project' | 'question') => props.commands.list().find(command => command.id === `outline.${props.pane}.${kind}-root`)?.run();
  const outlineCommand = (id: string) => props.commands.list().find(command => command.id === `outline.${props.pane}.${id}`);
  const depth = (): Depth => outlineView().depth ?? 'full';
  // The dial shows on titled pages at their top level; a zoomed page always shows in full.
  const showDial = () => root()?.kind === 'page' && !outlineView().zoom;
  // Journal days leave out what only titled pages can do (rename, gloss, compare, question) rather than listing it disabled.
  const titled = () => root()?.kind !== 'journal';
  const items = (): MenuItem[] => [
    ...(titled() ? [{ label: 'Rename', icon: 'edit', action: props.onRename } satisfies MenuItem] : []),
    { label: props.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: props.onPin },
    { label: 'Open page beside', icon: 'panes', action: props.onPageBeside },
    { label: pageStyle() === 'prose' ? 'Show bullets' : 'Hide bullets', icon: 'bullet', disabledReason: root() ? undefined : 'Page is still loading', action: () => props.onPageStyle(pageId()!, pageStyle() === 'prose' ? 'bullets' : 'prose', defaultStyle()) },
    ...(titled() ? [
      { label: 'Gloss', icon: 'edit', disabledReason: root() ? undefined : 'Page is still loading', action: () => outlineCommand('gloss')?.run() },
      { label: 'Compare perspectives', icon: 'compare', disabledReason: outlineCommand('compare')?.disabledReason?.()?.replace(/\.$/, ''), action: () => outlineCommand('compare')?.run() },
    ] satisfies MenuItem[] : []),
    { label: root()?.task ? 'Task' : 'Make task', icon: 'check', disabledReason: root() ? undefined : 'Page is still loading', action: () => rootCapability('task') },
    { label: root()?.project ? 'Project' : 'Make project', icon: 'flag', disabledReason: root() ? undefined : 'Page is still loading', action: () => rootCapability('project') },
    ...(titled() ? [{ label: root()?.question ? 'Question' : 'Make question', icon: 'question-open', disabledReason: root() ? undefined : 'Page is still loading', action: () => rootCapability('question') } satisfies MenuItem] : []),
    { label: 'Undo', icon: 'undo', shortcut: '⌘Z', disabledReason: !doc()?.canUndo() ? 'Nothing to undo' : undefined, action: () => undo(false) },
    { label: 'Redo', icon: 'redo', shortcut: '⌘⇧Z', disabledReason: !doc()?.canRedo() ? 'Nothing to redo' : undefined, action: () => undo(true) },
    { label: outlineView().showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', action: props.onArchived },
    { label: 'Delete', icon: 'trash', danger: true, action: () => props.onDelete(menuButton) },
  ];
  // The place or kind the pane shows, in the same glyphs the sidebar uses.
  const kindIcon = (): IconName => {
    if (pageId()) return root()?.kind === 'journal' ? 'today' : root()?.source ? 'library' : 'page';
    const kind = current().target.kind;
    return kind === 'agenda' ? 'agenda' : kind === 'review' ? 'review' : kind === 'library' || kind === 'reader' ? 'library' : kind === 'table' ? 'table' : kind === 'fields' ? 'field' : kind === 'settings' ? 'settings' : kind === 'compare' ? 'compare' : 'page';
  };
  return <section class={`pane ${props.active ? 'active' : ''}`} data-pane={props.pane} data-page-style={pageStyle()} aria-label={props.pane === 'main' ? 'Pane 1' : 'Pane 2'} onPointerDown={props.onActivate} onFocusIn={props.onActivate}>
    <header class="pane-header">
      <div class="pane-navigation"><Button icon="left" label="Back" shortcut="⌃⇧H" disabled={props.session().index <= 0} onClick={() => props.onTravel(-1)} /><Button icon="right" label="Forward" shortcut="⌃⇧L" disabled={props.session().index >= props.session().entries.length - 1} onClick={() => props.onTravel(1)} /></div>
      <Icon class="pane-kind" name={kindIcon()} />
      <Show when={pageId()}>
        <nav class="pane-breadcrumbs" aria-label="Page breadcrumbs"><Show when={root()?.source && !breadcrumbs().length}><Button onClick={event => props.onOpen({ kind: 'library' }, event.shiftKey)}>Library</Button><span class="breadcrumb-separator">/</span></Show><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: null })}>{root()?.text ?? 'Loading…'}</Button><For each={breadcrumbs()}>{block => <><span class="breadcrumb-separator">/</span><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: block.id })}>{plainText(block.text, id => props.notebook.lookup(id)) || 'Empty block'}</Button></>}</For></nav>
        <Show when={root()?.kind === 'journal'}><nav class="journal-navigation" aria-label="Journal navigation">
          <Button icon="left" label="Previous journal day" onClick={() => props.onShiftDate(-1)} />
          <Button class="journal-date" icon="calendar" label="Choose journal date" aria-haspopup="dialog" onClick={event => props.onChooseDate(event.currentTarget)} />
          <Button icon="right" label="Next journal day" onClick={() => props.onShiftDate(1)} />
        </nav></Show>
        <Show when={showDial()}><div class="depth-dial" role="group" aria-label="Depth">
          <For each={depthStops}>{stop => <button type="button" class="depth-stop" aria-pressed={depth() === stop} title={`${depthLabels[stop]} (${stop === 'gloss' ? '[' : stop === 'full' ? ']' : '[ ]'})`} onClick={() => outlineCommand(`depth-${stop}`)?.run()}><Icon name={`depth-${stop}`} /><span class="visually-hidden">{depthLabels[stop]}</span></button>}</For>
          <span class="depth-label" aria-hidden="true">{depthLabels[depth()]}</span>
        </div></Show>
        <span class="pane-save-state" data-state={saveState()} title={doc()?.saveMessage()}><Show when={saveState() !== 'saved'} fallback={<><span class="save-dot" /><span class="visually-hidden">Saved</span></>}><Icon name={saveState() === 'offline' ? 'offline' : saveState() === 'error' || saveState() === 'conflict' ? 'warning' : 'saving'} />{status()}</Show></span>
        <Show when={props.vim}><span class="vim-mode" title="Vim mode">{vimLabels[props.vimMode ?? 'outline']}</span></Show>
      </Show>
      <Show when={!pageId()}><Show when={current().target.kind === 'reader' ? current().target as Extract<OpenTarget, { kind: 'reader' }> : undefined} fallback={<span class="pane-breadcrumbs">{paneLabel(current().target)}</span>}>{target =>
        <nav class="pane-breadcrumbs" aria-label="Source breadcrumbs"><Button onClick={event => props.onOpen({ kind: 'library' }, event.shiftKey)}>Library</Button><span class="breadcrumb-separator">/</span><Button onClick={event => props.onOpen({ kind: 'page', pageId: target().sourceId }, event.shiftKey)}>{props.notebook.lookup(target().sourceId)()?.text ?? 'Reader'}</Button></nav>
      }</Show></Show>
      <Show when={pageId()}><Button ref={menuButton} class="page-menu-button" icon="more" label="Page menu" aria-expanded={!!menu()} onClick={event => setMenu(value => value ? null : event.currentTarget)} /></Show>
      <Show when={props.split}><Button class="pane-secondary" icon="close" label="Close pane" shortcut="⌃⇧X" onClick={props.onClose} /></Show>
    </header>
    <Show when={doc()?.saveState() === 'error' || doc()?.saveState() === 'conflict'}><div class="pane-error" role="alert">{doc()?.saveMessage()}</div></Show>
    <div class="pane-content"><Show keyed when={props.session().generation}>{generation => <Switch fallback={<OutlinePane pane={props.pane} pageId={pageId()!} view={copyView(outlineView())} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} active={props.active} onActivate={() => { if (generation === props.session().generation && document.activeElement?.closest('.pane')?.getAttribute('data-pane') === props.pane) props.onActivate(); }} vim={props.vim} onVimMode={props.onVimMode} commands={props.commands} notebook={props.notebook} />}>
      <Match when={current().target.kind === 'table'}><TablePane pane={props.pane} target={current().target as Extract<OpenTarget, { kind: 'table' }>} view={snapshotView(current().view) as TableViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onTargetChange={target => { if (generation === props.session().generation) props.onTargetChange(target); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'fields'}><FieldsPane view={snapshotView(current().view) as FieldsViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'settings'}><SettingsPane pane={props.pane} view={snapshotView(current().view) as SettingsViewState} notebook={props.notebook} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'compare' ? current().target as Extract<OpenTarget, { kind: 'compare' }> : undefined}>{target => <ComparePane subjectId={target().subjectId} view={snapshotView(current().view) as CompareViewState} notebook={props.notebook} onActivate={props.onActivate} onOpen={(next, beside) => { if (generation === props.session().generation) props.onOpen(next, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} />}</Match>
      <Match when={current().target.kind === 'agenda'}><AgendaPane pane={props.pane} view={snapshotView(current().view) as AgendaViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'review'}><ReviewPane pane={props.pane} view={snapshotView(current().view) as ReviewViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'library'}><LibraryPane pane={props.pane} view={snapshotView(current().view) as LibraryViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
      <Match when={current().target.kind === 'reader'}><ReaderPane pane={props.pane} target={current().target as Extract<OpenTarget, { kind: 'reader' }>} view={snapshotView(current().view) as ReaderViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} /></Match>
    </Switch>}</Show></div>
    <Show when={menu()}>{anchor => <Menu anchor={anchor()} label="Page actions" items={items()} onDismiss={() => setMenu(null)} />}</Show>
  </section>;
}
