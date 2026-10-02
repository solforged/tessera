import { batch, createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { api } from '../api/client';
import type { Block, NotebookInfo } from '../api/types';
import { createNotebookClient } from '../document';
import type { NotebookClient, PageDocument } from '../document/contract';
import { OutlinePane } from '../outline/OutlinePane';
import { TablePane } from '../table/TablePane';
import { copyQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { Calendar, localDate } from './Calendar';
import { createCommandRegistry } from './commands';
import type { CommandRegistry, OpenTarget, PaneId, TableViewState, ViewState } from './contract';
import { Palette } from './Palette';

type HistoryEntry = { target: OpenTarget; view: ViewState | TableViewState };
type PaneSession = { entries: HistoryEntry[]; index: number; generation: number };
type SavedNavigation = { pinned?: string[]; recent?: string[]; vim?: boolean; panes?: Partial<Record<PaneId, HistoryEntry>>; active?: PaneId };
type VimMode = 'insert' | 'normal' | 'visual' | 'outline' | null;
const vimLabels: Record<Exclude<VimMode, null>, string> = { insert: 'Insert', normal: 'Normal', visual: 'Visual', outline: 'Outline' };
type PopupState = { kind: 'search' | 'commands' | 'calendar' | 'new' | 'delete'; anchor: HTMLElement; pane: PaneId } | null;
const paneIds: PaneId[] = ['main', 'side'];

/** Views are snapshots: fold arrays and caret/scroll objects never alias history. */
function copyView(view: ViewState): ViewState {
  return { ...view, folds: view.folds ? [...view.folds] : null, caret: view.caret ? { ...view.caret } : null, scroll: view.scroll ? { ...view.scroll } : null };
}

function pageIdOf(current: HistoryEntry | undefined): string | undefined {
  return current?.target.kind === 'page' ? current.target.pageId : undefined;
}
function snapshotView(view: ViewState | TableViewState): ViewState | TableViewState {
  return 'query' in view ? { query: copyQuery(view.query), scroll: view.scroll } : copyView(view);
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
  const [views, { refetch: refetchViews }] = createResource(async () => {
    try { return await api.views(); } catch (reason) { reportError(reason); return []; }
  });
  createEffect(() => { if ((notebook.lastChange()?.views ?? []).length) void refetchViews(); });
  const [sessions, setSessions] = createSignal<Record<PaneId, PaneSession>>({ main: { entries: [], index: -1, generation: 0 }, side: { entries: [], index: -1, generation: 0 } });
  const [active, setActive] = createSignal<PaneId>('main');
  const [vim, setVim] = createSignal(false);
  const [vimModes, setVimModes] = createSignal<Record<PaneId, VimMode>>({ main: null, side: null });
  const narrowQuery = window.matchMedia('(max-width: 479px)');
  const [narrow, setNarrow] = createSignal(narrowQuery.matches);
  const [sidebar, setSidebar] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const toggleSidebar = () => {
    if (window.innerWidth >= 1048) setSidebarCollapsed(value => !value);
    else setSidebar(value => !value);
  };
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [pinned, setPinned] = createSignal<string[]>([]);
  const [recent, setRecent] = createSignal<string[]>([]);
  const [navigationId, setNavigationId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [offlineUnavailable, setOfflineUnavailable] = createSignal(false);
  const [deleted, setDeleted] = createSignal<{ id: string; title: string } | null>(null);
  const [date, setDate] = createSignal(localDate(new Date()));
  let searchButton!: HTMLButtonElement;
  let commandsButton!: HTMLButtonElement;
  let newButton!: HTMLButtonElement;
  const entry = (pane: PaneId) => sessions()[pane].entries[sessions()[pane].index];
  const split = () => sessions().main.index >= 0 && sessions().side.index >= 0;
  const activeRoot = () => notebook.roots().find(root => root.id === pageIdOf(entry(active())));
  const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const remember = (id: string) => setRecent(values => [id, ...values.filter(value => value !== id)].slice(0, 10));
  let focusEpoch = 0;
  const focusPane = (pane: PaneId) => {
    const epoch = ++focusEpoch;
    requestAnimationFrame(() => {
      if (epoch !== focusEpoch) return;
      const root = document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"]`);
      if (!root) return;
      setActive(pane);
      const editor = root.querySelector<HTMLElement>('.cm-content');
      (editor?.getClientRects().length ? editor : root.querySelector<HTMLElement>('.outline-pane, .table-pane'))?.focus({ preventScroll: true });
    });
  };
  const open = (target: OpenTarget, beside = false, owner = active()) => {
    const pane: PaneId = beside ? owner === 'main' ? 'side' : 'main' : owner;
    const current = entry(pane);
    const samePage = target.kind === 'page' && current?.target.kind === 'page' && current.target.pageId === target.pageId && 'zoom' in current.view && current.view.zoom === (target.blockId ?? null);
    if (!beside || !samePage) {
      const view: ViewState | TableViewState = target.kind === 'table'
        ? { query: copyQuery(target.query), scroll: 0 }
        : { zoom: target.blockId ?? null, caret: target.blockId ? { id: target.blockId, offset: 0 } : null, scroll: null, folds: null, showArchived: false };
      setSessions(values => {
        const previous = values[pane];
        const next = { entries: [...previous.entries.slice(0, previous.index + 1), { target, view }], index: previous.index + 1, generation: previous.generation + 1 };
        return { ...values, [pane]: next };
      });
    }
    setActive(pane); setSidebar(false);
    if (target.kind === 'page') {
      remember(target.pageId);
      const root = notebook.roots().find(block => block.id === target.pageId); if (root?.kind === 'journal') setDate(root.text);
    }
    focusPane(pane);
  };
  const changeView = (pane: PaneId, view: ViewState | TableViewState, restore = false) => setSessions(values => {
    const session = values[pane]; const current = session.entries[session.index]; if (!current) return values;
    if ('zoom' in view && 'zoom' in current.view && view.zoom !== current.view.zoom) {
      const entries = [...session.entries.slice(0, session.index + 1), { target: current.target, view: copyView(view) }];
      return { ...values, [pane]: { entries, index: session.index + 1, generation: session.generation + (restore ? 1 : 0) } };
    }
    const entries = [...session.entries];
    entries[session.index] = { target: current.target.kind === 'table' && 'query' in view ? { ...current.target, query: copyQuery(view.query), typeId: view.query.type } : current.target, view: snapshotView(view) };
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
    setSessions(values => ({ ...values, [pane]: { ...values[pane], index, generation: values[pane].generation + 1 } }));
    setActive(pane); const pageId = pageIdOf(session.entries[index]); if (pageId) remember(pageId);
    const root = notebook.roots().find(block => block.id === pageId); if (root?.kind === 'journal') setDate(root.text);
    focusPane(pane);
  };
  const today = async () => { try { open({ kind: 'page', pageId: await notebook.today() }); setDate(localDate(new Date())); } catch (reason) { reportError(reason); } };
  const journal = async (value: string) => { try { open({ kind: 'page', pageId: await notebook.journal(value) }); setDate(value); } catch (reason) { reportError(reason); } };
  const shiftDate = (delta: number) => { const next = new Date(`${date()}T12:00:00`); next.setDate(next.getDate() + delta); void journal(localDate(next)); };
  const toggleVim = () => {
    const pane = active();
    setVim(value => !value);
    focusPane(pane);
  };
  const switchPane = () => {
    if (!split()) return;
    const pane = active() === 'main' ? 'side' : 'main';
    setActive(pane);
    focusPane(pane);
  };
  const closePane = (pane: PaneId) => {
    if (!split()) return;
    setSessions(values => ({ ...values, [pane]: { entries: [], index: -1, generation: values[pane].generation + 1 } }));
    setActive(pane === 'main' ? 'side' : 'main');
    focusPane(pane === 'main' ? 'side' : 'main');
  };
  const pin = (id: string) => setPinned(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  const showPalette = (kind: 'search' | 'commands') => {
    const fallback = kind === 'search' ? searchButton : commandsButton;
    const compact = document.querySelector<HTMLButtonElement>(`.compact-toolbar button[aria-label="${kind === 'search' ? 'Search notebook' : 'Commands'}"]`);
    const anchor = fallback.getClientRects().length ? fallback : compact;
    if (anchor) setPopup({ kind, anchor, pane: active() });
  };
  const chooseDate = () => {
    const anchor = document.querySelector<HTMLButtonElement>('.journal-date');
    if (!anchor) return;
    if (!anchor.getClientRects().length) {
      if (window.innerWidth < 1048) setSidebar(true); else setSidebarCollapsed(false);
    }
    requestAnimationFrame(() => setPopup({ kind: 'calendar', anchor, pane: active() }));
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
    if (current) open(current.target.kind === 'table' && 'query' in current.view ? { ...current.target, query: copyQuery(current.view.query) } : current.target, true, pane);
  };
  const deletePage = async (pane: PaneId) => {
    const pageId = pageIdOf(entry(pane)); if (!pageId) return;
    const root = notebook.roots().find(block => block.id === pageId);
    const title = notebook.lookup(pageId)()?.text ?? root?.text ?? 'Page';
    try {
      await notebook.deletePage(pageId);
      setDeleted({ id: pageId, title }); setPopup(null);
      const remaining = notebook.roots().find(block => block.id !== pageId);
      const previousDay = new Date(`${localDate(new Date())}T12:00:00`);
      previousDay.setDate(previousDay.getDate() - 1);
      // Do not recreate a deleted journal date: that would prevent restoring its IDs.
      const replacement = remaining?.id ?? (root?.kind === 'journal' && root.text === localDate(new Date()) ? await notebook.journal(localDate(previousDay)) : await notebook.today());
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
        if (Array.isArray(stored.recent)) setRecent([...new Set(stored.recent)].filter(value => typeof value === 'string').slice(0, 10));
        setVim(stored.vim === true);
      });
      const restored: Record<PaneId, PaneSession> = { main: { entries: [], index: -1, generation: 0 }, side: { entries: [], index: -1, generation: 0 } };
      for (const pane of paneIds) {
        const saved = stored.panes?.[pane];
        if (!saved?.target || !saved.view) continue;
        let current: HistoryEntry;
        if (saved.target.kind === 'table' && 'query' in saved.view) {
          current = { target: { ...saved.target, query: copyQuery(saved.view.query) }, view: snapshotView(saved.view) };
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
        const root = notebook.roots().find(root => root.id === pageIdOf(restored[pane].entries[0]));
        if (root?.kind === 'journal') setDate(root.text);
      } else await today();
      setNavigationId(notebookInfo.id);
    })().catch(reportError);
  });
  createEffect(() => {
    const id = navigationId(); if (!id) return;
    const panes: Partial<Record<PaneId, HistoryEntry>> = {};
    for (const pane of paneIds) { const current = entry(pane); if (current) panes[pane] = current; }
    try { localStorage.setItem(`tessera.navigation.${id}`, JSON.stringify({ pinned: pinned(), recent: recent(), vim: vim(), panes, active: active() })); } catch { /* Storage-denied browsers keep preferences for this tab. */ }
  });
  const unregister = commands.register([
    { id: 'shell.search', title: 'Search notebook', section: 'Navigation', keys: ['⌃⇧F'], run: () => showPalette('search') },
    { id: 'shell.commands', title: 'Show Commands', section: 'Navigation', keys: ['⌃⇧P'], run: () => showPalette('commands') },
    { id: 'shell.today', title: 'Open today’s journal', section: 'Navigation', keys: ['⌃⇧J'], run: () => { void today(); } },
    { id: 'shell.previous-day', title: 'Previous journal day', section: 'Navigation', run: () => shiftDate(-1) },
    { id: 'shell.next-day', title: 'Next journal day', section: 'Navigation', run: () => shiftDate(1) },
    { id: 'shell.calendar', title: 'Choose journal date', section: 'Navigation', run: chooseDate },
    { id: 'shell.back', title: 'Back', section: 'Navigation', keys: ['⌃⇧H'], disabledReason: () => sessions()[active()].index <= 0 ? 'No earlier page in this pane' : undefined, run: () => travel(active(), -1) },
    { id: 'shell.forward', title: 'Forward', section: 'Navigation', keys: ['⌃⇧L'], disabledReason: () => sessions()[active()].index >= sessions()[active()].entries.length - 1 ? 'No later page in this pane' : undefined, run: () => travel(active(), 1) },
    { id: 'shell.page-beside', title: 'Open page beside', section: 'Navigation', run: () => openPageBeside() },
    { id: 'shell.switch', title: 'Switch panes', section: 'View', keys: ['⌃⇧]'], disabledReason: () => !split() ? 'Open a second pane first' : undefined, run: switchPane },
    { id: 'shell.close', title: 'Close active pane', section: 'View', keys: ['⌃⇧X'], disabledReason: () => !split() ? 'Only one pane is open' : undefined, run: () => closePane(active()) },
    { id: 'shell.new', title: 'New page', section: 'Page', run: () => {
      const compact = document.querySelector<HTMLButtonElement>('.compact-toolbar button[aria-label="New page"]');
      const anchor = newButton.getClientRects().length ? newButton : compact;
      if (anchor) setPopup({ kind: 'new', anchor, pane: active() });
    } },
    { id: 'shell.pin', title: 'Pin / unpin page', section: 'Page', run: () => { const root = activeRoot(); if (root) pin(root.id); } },
    { id: 'shell.delete', title: 'Delete page', section: 'Page', run: () => { const anchor = document.querySelector<HTMLButtonElement>(`[data-pane="${active()}"] .page-menu-button`); if (anchor) setPopup({ kind: 'delete', anchor, pane: active() }); } },
    { id: 'shell.restore-page', title: 'Undo page deletion', section: 'Page', disabledReason: () => deleted() ? undefined : 'No deleted page to restore', run: () => { void restorePage(); } },
    { id: 'shell.review-conflict', title: 'Review notebook conflict', section: 'Editing', disabledReason: () => notebook.conflictedPages().length ? undefined : 'No conflicting blocks', run: reviewConflict },
    { id: 'shell.retry', title: 'Retry saving', section: 'Editing', disabledReason: () => notebook.saveState() === 'saved' && notebook.connection() === 'live' ? 'All changes are saved' : undefined, run: () => notebook.retry() },
    { id: 'shell.copy-unsaved', title: 'Copy unsaved text', section: 'Editing', disabledReason: () => notebook.localPersistence() === 'failed' || notebook.rejectedText() ? undefined : 'Local recovery storage is working', run: () => { void navigator.clipboard.writeText(notebook.rejectedText() || notebook.unsavedText()).catch(reportError); } },
    { id: 'shell.dismiss-rejected', title: 'Dismiss rejected changes', section: 'Editing', disabledReason: () => notebook.rejectedText() ? undefined : 'No rejected changes', run: () => notebook.dismissRejected() },
    { id: 'shell.vim', title: 'Toggle Vim', section: 'Vim', run: toggleVim },
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
  return <div class={`app ${split() ? 'is-split' : ''} ${sidebar() ? 'sidebar-expanded' : ''} ${sidebarCollapsed() ? 'sidebar-collapsed' : ''}`} onPointerDown={() => { focusEpoch++; }}>
    <aside class="sidebar" aria-label="Notebook navigation">
      <div class="notebook-heading"><span class="notebook-name" title={info()?.path}>{info()?.path.split('/').filter(Boolean).at(-1) ?? 'Tessera'}</span><Button icon="sidebar" label="Collapse sidebar" onClick={toggleSidebar} /></div>
      <nav class="primary-navigation">
        <Button ref={searchButton} icon="search" onClick={() => showPalette('search')}>Search <kbd>⌃⇧F</kbd></Button>
        <Button ref={commandsButton} icon="command" onClick={() => showPalette('commands')}>Commands <kbd>⌃⇧P</kbd></Button>
        <Button icon="calendar" onClick={() => { void today(); }}>Today <kbd>⌃⇧J</kbd></Button>
      </nav>
      <div class="journal-navigation"><Button icon="left" label="Previous journal day" onClick={() => shiftDate(-1)} /><Button class="journal-date" onClick={event => setPopup({ kind: 'calendar', anchor: event.currentTarget, pane: active() })}>{date()}</Button><Button icon="right" label="Next journal day" onClick={() => shiftDate(1)} /></div>
      <PageList title="Pinned" roots={pinnedRoots()} notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} />
      <section class="page-list"><h2>Views</h2><For each={views() ?? []}>{view => <Button icon="table" class={entry(active())?.target.kind === 'table' && (entry(active())!.target as Extract<OpenTarget, { kind: 'table' }>).viewId === view.id ? 'selected' : ''} onClick={event => open({ kind: 'table', typeId: view.query.type, viewId: view.id, query: copyQuery(view.query) }, event.metaKey)}>{view.name}</Button>}</For></section>
      <PageList title="Recent" roots={recentRoots()} notebook={notebook} activeId={pageIdOf(entry(active()))} onOpen={open} />
      <Button ref={newButton} class="new-page-button" icon="plus" onClick={event => setPopup({ kind: 'new', anchor: event.currentTarget, pane: active() })}>New page</Button>
      <Button class="vim-toggle" aria-pressed={vim()} onClick={toggleVim}>Vim {vim() ? 'on' : 'off'}</Button>
    </aside>
    <main class="workspace">
      <div class="compact-toolbar">
        <Button icon="sidebar" label="Toggle sidebar" aria-expanded={sidebar()} onClick={toggleSidebar} />
        <Button icon="search" label="Search notebook" shortcut="⌃⇧F" onClick={event => setPopup({ kind: 'search', anchor: event.currentTarget, pane: active() })} />
        <Button icon="command" label="Commands" shortcut="⌃⇧P" onClick={event => setPopup({ kind: 'commands', anchor: event.currentTarget, pane: active() })} />
        <Button icon="calendar" label="Today" shortcut="⌃⇧J" onClick={() => { void today(); }} />
        <Button icon="plus" label="New page" onClick={event => setPopup({ kind: 'new', anchor: event.currentTarget, pane: active() })} />
        <Button aria-pressed={vim()} label={vim() ? `Turn Vim off · ${vimLabels[vimModes()[active()] ?? 'outline']} mode` : 'Turn Vim on'} onClick={toggleVim}>{vim() ? narrow() ? `Vim: ${vimLabels[vimModes()[active()] ?? 'outline']}` : 'Vim on' : 'Vim off'}</Button>
      </div>
      <Show when={split()}><div class="pane-tabs" role="tablist" aria-label="Working panes"><For each={paneIds}>{pane => <Button role="tab" aria-selected={active() === pane} onClick={() => { if (active() !== pane) switchPane(); }}>{pane === 'main' ? 'Pane 1' : 'Pane 2'} · {rootById().get(pageIdOf(entry(pane)) ?? '')?.text ?? (entry(pane)?.target.kind === 'table' ? 'Table' : 'Loading…')}</Button>}</For></div></Show>
      <Show when={error()}><div class="shell-error" role="alert"><Icon name="warning" /><span>{error()}</span><Button onClick={() => { if (offlineUnavailable()) { location.reload(); return; } setError(''); void today(); }}>Retry</Button></div></Show>
      <div class="panes"><For each={paneIds}>{pane => <Show when={entry(pane)}>
        <Pane pane={pane} session={() => sessions()[pane]} active={active() === pane} split={split()} notebook={notebook} commands={commands} vim={vim()} vimMode={vimModes()[pane]} onVimMode={mode => setVimModes(values => ({ ...values, [pane]: mode }))} pinned={pinned().includes(pageIdOf(entry(pane)) ?? '')}
          onActivate={() => setActive(pane)}
          onOpen={(target, beside) => open(target, beside, pane)}
          onPageBeside={() => openPageBeside(pane)}
          onViewChange={view => changeView(pane, view)}
          onTargetChange={target => changeTarget(pane, target)}
          onTravel={delta => travel(pane, delta)}
          onClose={() => closePane(pane)}
          onSwitch={switchPane}
          onPin={() => { const id = pageIdOf(entry(pane)); if (id) pin(id); }}
          onRename={() => runOutline('rename', pane)}
          onDelete={anchor => setPopup({ kind: 'delete', anchor, pane })}
          onArchived={() => { runOutline('show-archived', pane); focusPane(pane); }}
          onRestoreView={view => changeView(pane, view, true)}
          onReview={reviewConflict}
        />
      </Show>}</For></div>
      <Show when={!entry('main') && !entry('side') && !error()}><div class="startup-state">Opening today’s journal…</div></Show>
    </main>
    <Show keyed when={popup()}>{state => <>
      <Show when={state.kind === 'search' || state.kind === 'commands'}>
        <Palette anchor={state.anchor} pane={state.pane} mode={state.kind === 'commands' ? 'commands' : 'search'} commands={commands} notebook={notebook} onDismiss={() => setPopup(null)} onRestoreFocus={() => { if (!popup() && active() === state.pane) focusPane(state.pane); }} onOpen={(target, beside) => open(target, beside, state.pane)} />
      </Show>
      <Show when={state.kind === 'calendar'}>
        <Calendar anchor={state.anchor} date={date()} onDismiss={() => setPopup(null)} onSelect={value => { void journal(value); }} />
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
    </>}</Show>
    <Show when={deleted()}>{value => <div class="undo-toast" role="status"><Icon name="trash" /><span>“{value().title}” deleted</span><Button icon="undo" onClick={() => { void restorePage(); }}>Undo</Button><Button icon="close" label="Dismiss deletion notification" onClick={() => setDeleted(null)} /></div>}</Show>
  </div>;
}

function PageList(props: { title: string; roots: Block[]; notebook: NotebookClient; activeId?: string; onOpen(target: OpenTarget, beside?: boolean): void }) {
  return <section class="page-list"><h2>{props.title}</h2><Show when={props.roots.length} fallback={<p class="sidebar-empty">{props.title === 'Pinned' ? 'No pinned pages' : 'No recent pages'}</p>}><For each={props.roots}>{root => <Button class={root.id === props.activeId ? 'selected' : ''} icon={root.kind === 'journal' ? 'calendar' : 'page'} title={props.notebook.lookup(root.id)()?.text ?? root.text} onClick={event => props.onOpen({ kind: 'page', pageId: root.id }, event.shiftKey)}>{props.notebook.lookup(root.id)()?.text ?? root.text}</Button>}</For></Show></section>;
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

function Pane(props: { pane: PaneId; session: Accessor<PaneSession>; active: boolean; split: boolean; notebook: NotebookClient; commands: CommandRegistry; vim: boolean; vimMode: VimMode; onVimMode(mode: VimMode): void; pinned: boolean; onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void; onTargetChange(target: OpenTarget): void; onPageBeside(): void; onViewChange(view: ViewState | TableViewState): void; onTravel(delta: number): void; onClose(): void; onSwitch(): void; onPin(): void; onRename(): void; onDelete(anchor: HTMLElement): void; onArchived(): void; onRestoreView(view: ViewState): void; onReview(): void }) {
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
  const breadcrumbs = createMemo(() => {
    const page = doc(); const zoom = 'zoom' in current().view ? outlineView().zoom : null; if (!page || !zoom) return [];
    const result = []; let block = page.block(zoom);
    while (block && block.id !== page.pageId) { result.unshift(block); block = block.parentId ? page.block(block.parentId) : undefined; }
    return result;
  });
  const status = () => {
    const state = doc()?.saveState();
    return state === 'conflict' ? 'Conflict · Both versions kept' : state === 'error' ? 'Couldn’t save · Local changes kept' : state === 'offline' ? 'Offline' : state === 'saved' ? 'Saved' : 'Saving…';
  };
  const undo = (redo: boolean) => {
    const caret = redo ? doc()?.redo() : doc()?.undo(); if (caret) props.onRestoreView({ ...outlineView(), caret });
  };
  const items = (): MenuItem[] => [
    { label: 'Rename', icon: 'edit', disabledReason: root()?.kind === 'journal' ? 'Journal dates cannot be renamed' : undefined, action: props.onRename },
    { label: props.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: props.onPin },
    { label: 'Open page beside', icon: 'panes', action: props.onPageBeside },
    ...(props.split ? [
      { label: 'Switch panes', icon: 'panes' as const, shortcut: '⌃⇧]', action: props.onSwitch },
      { label: 'Close pane', icon: 'close' as const, shortcut: '⌃⇧X', action: props.onClose },
    ] : []),
    { label: 'Undo', icon: 'undo', shortcut: '⌘Z', disabledReason: !doc()?.canUndo() ? 'Nothing to undo' : undefined, action: () => undo(false) },
    { label: 'Redo', icon: 'redo', shortcut: '⌘⇧Z', disabledReason: !doc()?.canRedo() ? 'Nothing to redo' : undefined, action: () => undo(true) },
    { label: outlineView().showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', action: props.onArchived },
    { label: 'Delete', icon: 'trash', danger: true, action: () => props.onDelete(menuButton) },
  ];
  return <section class={`pane ${props.active ? 'active' : ''}`} data-pane={props.pane} aria-label={props.pane === 'main' ? 'Pane 1' : 'Pane 2'} onPointerDown={props.onActivate} onFocusIn={props.onActivate}>
    <header class="pane-header">
      <div class="pane-navigation"><Button icon="left" label="Back" shortcut="⌃⇧H" disabled={props.session().index <= 0} onClick={() => props.onTravel(-1)} /><Button icon="right" label="Forward" shortcut="⌃⇧L" disabled={props.session().index >= props.session().entries.length - 1} onClick={() => props.onTravel(1)} /></div>
      <Show when={pageId()}>
        <nav class="pane-breadcrumbs" aria-label="Page breadcrumbs"><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: null })}>{root()?.text ?? 'Loading…'}</Button><For each={breadcrumbs()}>{block => <><span class="breadcrumb-separator">/</span><Button onClick={() => props.onRestoreView({ ...outlineView(), zoom: block.id })}>{block.text || 'Empty block'}</Button></>}</For></nav>
        <span class="pane-save-state" title={doc()?.saveMessage()}><Icon name={doc()?.saveState() === 'saved' ? 'check' : doc()?.saveState() === 'offline' ? 'offline' : doc()?.saveState() === 'error' || doc()?.saveState() === 'conflict' ? 'warning' : 'saving'} />{status()}</span>
        <Show when={props.vim}><span class="vim-mode">Vim: {vimLabels[props.vimMode ?? 'outline']}</span></Show>
      </Show>
      <Show when={!pageId()}><span class="pane-breadcrumbs">Table</span></Show>
      <Show when={!props.split}><Button class="pane-secondary" icon="panes" label="Open page beside" onClick={props.onPageBeside} /></Show>
      <Show when={pageId()}><Button ref={menuButton} class="page-menu-button" icon="more" label="Page menu" aria-expanded={!!menu()} onClick={event => setMenu(value => value ? null : event.currentTarget)} /></Show>
      <Show when={props.split}><Button class="pane-secondary" icon="close" label="Close pane" shortcut="⌃⇧X" onClick={props.onClose} /></Show>
    </header>
    <Show when={props.active}><GlobalBanner notebook={props.notebook} onReview={props.onReview} /></Show>
    <Show when={!props.active && (doc()?.saveState() === 'error' || doc()?.saveState() === 'conflict')}><div class="pane-error" role="alert">{doc()?.saveMessage()}</div></Show>
    <div class="pane-content"><Show keyed when={props.session().generation}>{generation => <Show when={current().target.kind === 'table'} fallback={<OutlinePane pane={props.pane} pageId={pageId()!} view={copyView(outlineView())} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} active={props.active} onActivate={() => { if (generation === props.session().generation && document.activeElement?.closest('.pane')?.getAttribute('data-pane') === props.pane) props.onActivate(); }} vim={props.vim} onVimMode={props.onVimMode} commands={props.commands} notebook={props.notebook} />}>
      <TablePane pane={props.pane} target={current().target as Extract<OpenTarget, { kind: 'table' }>} view={snapshotView(current().view) as TableViewState} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={(target, beside) => { if (generation === props.session().generation) props.onOpen(target, beside); }} onTargetChange={target => { if (generation === props.session().generation) props.onTargetChange(target); }} onViewChange={view => { if (generation === props.session().generation) props.onViewChange(view); }} />
    </Show>}</Show></div>
    <Show when={menu()}>{anchor => <Menu anchor={anchor()} label="Page actions" items={items()} onDismiss={() => setMenu(null)} />}</Show>
  </section>;
}
