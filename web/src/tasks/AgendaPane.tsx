import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { Agenda, DateRange, FieldDefinition, ProjectRecord, TaskFilter, TaskPriority, TaskQuery, TaskQueryResult, TaskSelection, TaskStatus, TaskView } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { AgendaViewState, OpenTarget, PaneId } from '../shell/contract';
import { SourceQueryControls } from '../table/SourceQueryControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { DatePicker } from './DatePicker';
import { TaskSourceRows, documentReady } from './JournalAgenda';
import { parseTaskDate } from './date-input';
import { dateSuggestions, dateTokenAt, newTask, planDateToken } from './quick-date';
import { copyTaskQuery, createTaskQuery, refreshedTaskQuery, taskQueriesEqual, taskRange } from './query';
import { WeekCalendar } from './WeekCalendar';
import { shiftCalendarDate } from './week-calendar';
import './agenda.css';

export interface AgendaPaneProps {
  pane: PaneId;
  view: AgendaViewState;
  notebook: NotebookClient;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: AgendaViewState): void;
}

type AgendaPopup =
  | { kind: 'menu'; anchor: HTMLElement; label: string; items: MenuItem[] }
  | { kind: 'date'; anchor: HTMLElement }
  | { kind: 'range'; anchor: HTMLElement; field: 'scheduled' | 'deadline'; edge: keyof DateRange }
  | { kind: 'views' | 'projects'; anchor: HTMLElement }
  | { kind: 'name'; anchor: HTMLElement; action: 'create' | 'rename'; id: string; saved: TaskView | null }
  | { kind: 'delete'; anchor: HTMLElement; saved: TaskView };
const selectionLabels: Record<TaskSelection, string> = { unfinished: 'Unfinished', unfinished_or_recent: 'Unfinished or recently completed', all: 'All' };
const statusLabels: Record<TaskStatus, string> = { todo: 'Todo', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
const statuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
const priorityLabels = { high: 'High', medium: 'Medium', low: 'Low' };
type ProjectChoice = { id: string | null; name: string };

export function AgendaPane(props: AgendaPaneProps) {
  const [view, setView] = createSignal<AgendaViewState>({ ...props.view, query: copyTaskQuery(props.view.query) });
  const query = createMemo(() => view().query, view().query, { equals: taskQueriesEqual });
  const date = createMemo(() => view().date);
  const mode = createMemo(() => view().mode);
  const viewId = createMemo(() => view().viewId);
  const [agenda, setAgenda] = createSignal<Agenda>();
  const [tasks, setTasks] = createSignal<TaskQueryResult>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  const [fields, setFields] = createSignal<FieldDefinition[]>([]);
  const [projects, setProjects] = createSignal<ProjectRecord[]>([]);
  const [metadataLoading, setMetadataLoading] = createSignal(true);
  const [metadataError, setMetadataError] = createSignal('');
  const [views, setViews] = createSignal<TaskView[]>([]);
  const [viewsLoading, setViewsLoading] = createSignal(true);
  const [viewsError, setViewsError] = createSignal('');
  const [saved, setSaved] = createSignal<TaskView | null>(null);
  const [latestSaved, setLatestSaved] = createSignal<TaskView | null>(null);
  const [savedLoading, setSavedLoading] = createSignal(false);
  const [savedError, setSavedError] = createSignal('');
  const [popup, setPopup] = createSignal<AgendaPopup | null>(null);
  const [pickerSearch, setPickerSearch] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [commandError, setCommandError] = createSignal('');
  const [draft, setDraft] = createSignal('');
  const [recentInput, setRecentInput] = createSignal(String(query().filter.recent_days));
  const [limitInput, setLimitInput] = createSignal(query().limit === null ? '' : String(query().limit));
  let scroll!: HTMLDivElement;
  let restoredScroll = false;
  let requested: { mode: AgendaViewState['mode']; date: string; query: TaskQuery } | null = null;
  createEffect(on(() => props.view, next => {
    const previous = view();
    if (next.date !== previous.date || next.mode !== previous.mode || next.viewId !== previous.viewId || !taskQueriesEqual(next.query, previous.query)) {
      if (next.viewId !== previous.viewId) { setSaved(null); setLatestSaved(null); }
      setView({ ...next, query: copyTaskQuery(next.query) });
      setRecentInput(String(next.query.filter.recent_days)); setLimitInput(next.query.limit === null ? '' : String(next.query.limit));
      if (scroll) scroll.scrollTop = next.scroll;
    }
  }, { defer: true }));
  createEffect(on(() => query().filter.recent_days, value => setRecentInput(String(value)), { defer: true }));
  createEffect(on(() => query().limit, value => setLimitInput(value === null ? '' : String(value)), { defer: true }));
  const filterError = createMemo(() => {
    const recent = Number(recentInput()); const limit = Number(limitInput());
    if (query().filter.selection === 'unfinished_or_recent' && (!Number.isInteger(recent) || recent < 1 || recent > 3660)) return 'Recent days must be between 1 and 3660.';
    if (limitInput() && (!Number.isInteger(limit) || limit < 1 || limit > 2000)) return 'Result limit must be between 1 and 2000, or empty.';
    return '';
  });
  const hasInputDraft = createMemo(() => Number(recentInput()) !== query().filter.recent_days || (limitInput() === '' ? null : Number(limitInput())) !== query().limit);
  const dirty = createMemo(() => !!saved() && (hasInputDraft() || !taskQueriesEqual(query(), saved()!.query)));
  const remoteChanged = createMemo(() => dirty() && !!latestSaved() && latestSaved()!.revision !== saved()!.revision);
  const update = (patch: Partial<AgendaViewState>) => {
    const next = { ...view(), ...patch, scroll: patch.scroll ?? scroll?.scrollTop ?? view().scroll };
    next.query = copyTaskQuery({ ...next.query, context_date: next.date });
    setView(next);
    props.onViewChange({ ...next, query: copyTaskQuery(next.query) });
    if (patch.scroll !== undefined && scroll) scroll.scrollTop = patch.scroll;
  };
  const updateFilter = (patch: Partial<TaskFilter>) => update({ query: { ...query(), filter: { ...query().filter, ...patch } } });

  createEffect(() => {
    const currentMode = mode(); const currentDate = date(); const value = copyTaskQuery(query());
    props.notebook.changeSequence(); refresh();
    let current = true;
    setLoading(true); setError('');
    if (currentMode === 'week') {
      setLoading(false);
      requested = null;
      return;
    }
    if (!requested || requested.mode !== currentMode || requested.date !== currentDate || !taskQueriesEqual(requested.query, value)) {
      setAgenda(undefined); setTasks(undefined);
    }
    requested = { mode: currentMode, date: currentDate, query: value };
    const timer = setTimeout(() => {
      const load = currentMode === 'agenda' ? props.notebook.api.agenda(currentDate) : props.notebook.api.taskQuery(value);
      void load.then(result => {
        if (!current) return;
        if ('items' in result) setAgenda(result); else setTasks(result);
        setLoading(false);
        if (!restoredScroll) {
          restoredScroll = true;
          requestAnimationFrame(() => { if (current && scroll) scroll.scrollTop = props.view.scroll; });
        }
      }).catch(reason => {
        if (current) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      });
    }, currentMode === 'tasks' ? 150 : 0);
    onCleanup(() => { current = false; clearTimeout(timer); });
  });
  createEffect(() => {
    props.notebook.changeSequence(); refresh();
    let current = true;
    setMetadataLoading(true); setMetadataError('');
    void Promise.all([props.notebook.api.fields(), props.notebook.api.projects()]).then(([definitions, records]) => {
      if (current) { setFields(definitions.fields); setProjects(records); setMetadataLoading(false); }
    }).catch(reason => {
      if (current) { setMetadataError(reason instanceof Error ? reason.message : String(reason)); setMetadataLoading(false); }
    });
    onCleanup(() => { current = false; });
  });
  createEffect(() => {
    props.notebook.changeSequence(); props.notebook.lastChange(); refresh();
    let current = true;
    setViewsLoading(true); setViewsError('');
    void props.notebook.api.taskViews().then(result => {
      if (current) { setViews(result); setViewsLoading(false); }
    }).catch(reason => {
      if (current) { setViewsError(reason instanceof Error ? reason.message : String(reason)); setViewsLoading(false); }
    });
    onCleanup(() => { current = false; });
  });
  createEffect(() => {
    const id = viewId();
    props.notebook.changeSequence(); props.notebook.lastChange(); refresh();
    let current = true;
    setSavedError('');
    if (!id) { setSaved(null); setLatestSaved(null); setSavedLoading(false); return; }
    setSavedLoading(true);
    void props.notebook.api.taskView(id).then(next => {
      if (!current) return;
      const previous = saved();
      const value = hasInputDraft() ? copyTaskQuery(query()) : refreshedTaskQuery(query(), previous, next);
      batch(() => {
        setLatestSaved(next);
        // Keep a dirty draft's original revision: a later save must not silently overwrite a remote edit.
        if (!previous || previous.id !== next.id || !hasInputDraft() && taskQueriesEqual(query(), previous.query)) setSaved(next);
        if (!taskQueriesEqual(value, query())) update({ query: value, date: value.context_date });
        setSavedLoading(false);
      });
    }).catch(reason => {
      if (current) { setLatestSaved(null); setSavedError(reason instanceof Error ? reason.message : String(reason)); setSavedLoading(false); }
    });
    onCleanup(() => { current = false; });
  });
  const projectChoices = createMemo((): ProjectChoice[] => {
    const needle = pickerSearch().trim().toLocaleLowerCase();
    return [{ id: null, name: 'Any project' }, ...projects().map(project => ({
      id: project.block_id,
      name: props.notebook.lookup(project.block_id)()?.text || project.state.outcome || project.block_id,
    })).filter(project => project.name.toLocaleLowerCase().includes(needle))];
  });
  const viewChoices = createMemo(() => views().filter(value => value.name.toLocaleLowerCase().includes(pickerSearch().trim().toLocaleLowerCase())));
  const selectView = (value: TaskView | null) => {
    batch(() => {
      setSaved(value); setLatestSaved(value); setPopup(null);
      const next = value ? copyTaskQuery(value.query) : createTaskQuery(date());
      update({ viewId: value?.id ?? null, query: next, date: next.context_date, mode: 'tasks', scroll: 0 });
      setRecentInput(String(next.filter.recent_days)); setLimitInput(next.limit === null ? '' : String(next.limit));
    });
  };
  const discard = () => {
    const value = latestSaved();
    if (value) {
      setSaved(value);
      update({ query: copyTaskQuery(value.query), date: value.query.context_date });
      setRecentInput(String(value.query.filter.recent_days)); setLimitInput(value.query.limit === null ? '' : String(value.query.limit));
    }
  };
  const saveView = async (name: string, id: string, previous: TaskView | null, rename: boolean) => {
    if (busy()) return;
    if (!rename && filterError()) throw new Error(filterError());
    setBusy(true); setCommandError('');
    const value = copyTaskQuery(rename ? previous!.query : query());
    try {
      await props.notebook.commit([{ op: 'save_task_view', id, base_revision: previous?.revision ?? null, name: name.trim(), query: value }], rename ? 'Rename task view' : 'Save task view');
      batch(() => {
        setSaved(null); setLatestSaved(null); setPopup(null);
        update({ viewId: id });
        setRefresh(value => value + 1);
      });
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally { setBusy(false); }
  };
  const deleteView = async (value: TaskView) => {
    if (busy()) return;
    setBusy(true); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'delete_task_view', id: value.id, base_revision: value.revision }], 'Delete task view');
      batch(() => { setSaved(null); setLatestSaved(null); update({ viewId: null }); setPopup(null); setRefresh(value => value + 1); });
    } catch (reason) { setCommandError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const viewMenu = (anchor: HTMLElement) => {
    const value = saved();
    setPopup({ kind: 'menu', anchor, label: 'Task view actions', items: [
      { label: 'Save as view…', disabledReason: filterError() || undefined, action: () => setPopup({ kind: 'name', anchor, action: 'create', id: ulid(), saved: null }) },
      ...(value ? [
        { label: 'Save changes', disabledReason: filterError() || (!dirty() ? 'No changes.' : undefined), action: () => { void saveView(value.name, value.id, value, false).catch(() => {}); } },
        { label: 'Rename…', action: () => setPopup({ kind: 'name', anchor, action: 'rename', id: value.id, saved: value }) },
        { label: 'Discard changes', disabledReason: !latestSaved() ? 'Saved view is unavailable.' : !dirty() && !filterError() ? 'No changes.' : undefined, action: discard },
        { label: 'Delete view…', icon: 'trash' as const, danger: true, action: () => setPopup({ kind: 'delete', anchor, saved: value }) },
      ] : []),
    ] });
  };
  const rows = createMemo(() => mode() === 'agenda' ? agenda()?.items ?? [] : tasks()?.rows ?? []);
  const total = createMemo(() => mode() === 'agenda' ? agenda()?.items.length ?? 0 : tasks()?.total ?? 0);
  const previousDate = createMemo(() => shiftCalendarDate(date(), mode() === 'week' ? -7 : -1));
  const nextDate = createMemo(() => shiftCalendarDate(date(), mode() === 'week' ? 7 : 1));
  const changeDay = (input: string) => {
    const parsed = parseTaskDate(input, date());
    if (parsed.ok && parsed.date) update({ date: parsed.date, scroll: 0 });
    else if (!parsed.ok) setError(parsed.error);
  };
  /** Captures into today's journal, scheduled for the displayed day unless a trailing `@date` says otherwise. */
  const addTask = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft(''); setCommandError('');
    const token = dateTokenAt(text, text.length);
    const choice = token?.query ? dateSuggestions(token.query, date())[0] : undefined;
    const plan = token && choice ? planDateToken(text, token, choice, null) : { text, value: { ...newTask(), scheduled: date() } };
    let doc: PageDocument | undefined;
    try {
      const pageId = await props.notebook.journal(props.notebook.todayDate());
      doc = props.notebook.open(pageId);
      await documentReady(doc);
      const last = doc.outline.children(pageId).at(-1);
      const reuse = last && !doc.block(last)?.text && !doc.block(last)?.task && !doc.outline.children(last).length ? last : null;
      let id = reuse;
      if (!id) {
        const inserted = doc.edit({ kind: 'insert', parentId: pageId, after: last ?? null });
        if (!inserted.ok) throw new Error(inserted.reason);
        id = inserted.created[0]!;
      }
      const planned = doc.edit({ kind: 'planTask', id, text: plan.text.trim(), value: plan.value });
      if (!planned.ok) throw new Error(planned.reason);
      await doc.flush();
      setRefresh(value => value + 1);
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : String(reason));
      if (!draft()) setDraft(text);
    } finally { doc?.release(); }
  };

  return <div ref={scroll} class="agenda-pane" data-pane={props.pane} aria-label="Agenda and tasks" tabIndex={props.active ? 0 : -1} onFocusIn={props.onActivate} onPointerDown={props.onActivate} onScroll={() => props.onViewChange({ ...view(), query: copyTaskQuery(query()), scroll: scroll.scrollTop })}>
    <div class="agenda-content" classList={{ 'agenda-content-week': mode() === 'week' }}>
      <header class="agenda-toolbar">
        <div class="agenda-modes mode-tabs" role="group" aria-label="Task display">
          <Button aria-pressed={mode() === 'agenda'} disabled={busy()} onClick={() => update({ mode: 'agenda', scroll: 0 })}>Agenda</Button>
          <Button aria-pressed={mode() === 'week'} disabled={busy()} onClick={() => update({ mode: 'week', scroll: 0 })}>Week</Button>
          <Button aria-pressed={mode() === 'tasks'} disabled={busy()} onClick={() => update({ mode: 'tasks', scroll: 0 })}>Tasks</Button>
        </div>
        <div class="agenda-date" role="group" aria-label="Displayed date">
          <Button icon="left" label={mode() === 'week' ? 'Previous week' : 'Previous day'} disabled={busy() || !previousDate()} onClick={() => { const previous = previousDate(); if (previous) changeDay(previous); }} />
          <Button class="agenda-date-button" disabled={busy()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'date'} onClick={event => setPopup({ kind: 'date', anchor: event.currentTarget })}>{date()}</Button>
          <Button icon="right" label={mode() === 'week' ? 'Next week' : 'Next day'} disabled={busy() || !nextDate()} onClick={() => { const next = nextDate(); if (next) changeDay(next); }} />
          <Button disabled={busy()} onClick={() => update({ date: props.notebook.todayDate(), scroll: 0 })}>Today</Button>
        </div>
      </header>
      <Show when={mode() === 'tasks'}>
        <div class="agenda-toolbar">
          <Button class="bordered" disabled={busy()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'views'} onClick={event => { setPickerSearch(''); setPopup({ kind: 'views', anchor: event.currentTarget }); }}>{viewId() ? saved()?.name ?? (savedLoading() ? 'Loading view…' : 'Unavailable view') : 'Unsaved task query'}<Icon name="down" /></Button>
          <Button icon="more" label="Task view actions" disabled={busy() || !!viewId() && savedLoading()} onClick={event => viewMenu(event.currentTarget)} />
          <Show when={saved()}><span class="agenda-message">{dirty() ? 'Unsaved changes' : 'Saved view'}</span></Show>
          <Show when={dirty()}><Button disabled={busy() || !!filterError()} onClick={() => { const value = saved()!; void saveView(value.name, value.id, value, false).catch(() => {}); }}>Save changes</Button></Show>
        </div>
        <Show when={remoteChanged()}><p class="agenda-message" role="status">The saved view changed elsewhere. Your draft is unchanged. Discard changes to load the saved version, or save as another view.</p></Show>
        <Show when={viewsError() || savedError()}><div class="agenda-error" role="alert"><span>{viewsError() || savedError()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry views</Button></div></Show>
        <div class="agenda-filters" role="group" aria-label="Task filters">
          <Button class="bordered" disabled={busy()} aria-haspopup="menu" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Task selection', items: (['unfinished', 'unfinished_or_recent', 'all'] as TaskSelection[]).map(selection => ({ label: selectionLabels[selection], icon: query().filter.selection === selection ? 'check' as const : undefined, action: () => updateFilter({ selection }) })) })}>{selectionLabels[query().filter.selection]}<Icon name="down" /></Button>
          <Show when={query().filter.selection === 'unfinished_or_recent'}><label class="agenda-number">Recent days<input class="input" type="number" min="1" max="3660" step="1" disabled={busy()} value={recentInput()} onInput={event => { const text = event.currentTarget.value; setRecentInput(text); const value = Number(text); if (Number.isInteger(value) && value >= 1 && value <= 3660) updateFilter({ recent_days: value }); }} /></label></Show>
          <Button class="bordered" disabled={busy()} aria-haspopup="menu" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Task statuses', items: [
            { label: 'Any status', icon: !query().filter.statuses.length ? 'check' : undefined, action: () => updateFilter({ statuses: [] }) },
            ...statuses.map(status => ({ label: statusLabels[status], icon: query().filter.statuses.includes(status) ? 'check' as const : undefined, action: () => updateFilter({ statuses: query().filter.statuses.includes(status) ? query().filter.statuses.filter(value => value !== status) : [...query().filter.statuses, status] }) })),
          ] })}>{query().filter.statuses.length ? query().filter.statuses.map(status => statusLabels[status]).join(', ') : 'Any status'}<Icon name="down" /></Button>
          <Button class="bordered" disabled={busy()} aria-haspopup="menu" onClick={event => setPopup({ kind: 'menu', anchor: event.currentTarget, label: 'Task priority', items: ([null, 'high', 'medium', 'low'] as (TaskPriority | null)[]).map(priority => ({ label: priority ? priorityLabels[priority] : 'Any priority', icon: query().filter.priority === priority ? 'check' as const : undefined, action: () => updateFilter({ priority }) })) })}>{query().filter.priority ? priorityLabels[query().filter.priority!] : 'Any priority'}<Icon name="down" /></Button>
          <Button class="bordered" disabled={busy()} aria-haspopup="dialog" onClick={event => { setPickerSearch(''); setPopup({ kind: 'projects', anchor: event.currentTarget }); }}>{query().filter.project_id ? props.notebook.lookup(query().filter.project_id!)()?.text || projects().find(project => project.block_id === query().filter.project_id)?.state.outcome || 'Selected project' : 'Any project'}<Icon name="down" /></Button>
          <For each={['scheduled', 'deadline'] as const}>{field => <div class="agenda-date-range" role="group" aria-label={field === 'scheduled' ? 'Scheduled range' : 'Deadline range'}><span>{field === 'scheduled' ? 'Scheduled' : 'Deadline'}</span>
            <For each={['from', 'through'] as const}>{edge => <Button class="bordered" disabled={busy()} aria-haspopup="dialog" label={`${field === 'scheduled' ? 'Scheduled' : 'Deadline'} ${edge}: ${query().filter[field]?.[edge] ?? 'Any date'}`} onClick={event => setPopup({ kind: 'range', anchor: event.currentTarget, field, edge })}>{edge === 'from' ? 'From' : 'Through'} {query().filter[field]?.[edge] ?? 'any date'}</Button>}</For>
          </div>}</For>
          <label class="agenda-number">Result limit<input class="input" type="number" min="1" max="2000" step="1" placeholder="Default" disabled={busy()} value={limitInput()} onInput={event => { const text = event.currentTarget.value; setLimitInput(text); const value = Number(text); if (!text || Number.isInteger(value) && value >= 1 && value <= 2000) update({ query: { ...query(), limit: text ? value : null } }); }} /></label>
        </div>
        <SourceQueryControls query={query().source} types={props.notebook.roots()} fields={fields()} disabled={busy()} onChange={source => update({ query: { ...query(), source } })} />
        <Show when={filterError()}><p class="agenda-error" role="alert">{filterError()}</p></Show>
        <Show when={metadataLoading()}><p class="agenda-message" role="status">Loading source filters…</p></Show>
        <Show when={metadataError()}><div class="agenda-error" role="alert"><span>{metadataError()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry filters</Button></div></Show>
      </Show>
      <Show when={busy() || props.notebook.commandState() !== 'saved'}><p class="agenda-message" role="status">{props.notebook.commandMessage() || (busy() ? 'Saving task view…' : props.notebook.commandState())}</p></Show>
      <Show when={commandError()}><p class="agenda-error" role="alert">{commandError()}</p></Show>
      <Show when={mode() === 'agenda'}>
        <form class="agenda-add" onSubmit={event => { event.preventDefault(); void addTask(); }}>
          <Icon name="plus" />
          <input class="input" aria-label="New task" placeholder={`Add a task for ${date()} · @ picks another day`} value={draft()} onInput={event => setDraft(event.currentTarget.value)} />
        </form>
      </Show>
      <Show when={mode() === 'week'}><WeekCalendar date={date()} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <Show when={mode() !== 'week'}>
      <section class="agenda-results" aria-label={mode() === 'agenda' ? `Agenda for ${date()}` : 'Task results'} aria-busy={loading()}>
        <Show when={loading()}><p class="agenda-message" role="status">Loading {mode() === 'agenda' ? 'agenda' : 'tasks'}…</p></Show>
        <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
        <Show when={!loading() && !error()}>
          <Show when={mode() !== 'agenda' || rows().length || total()}><p class="agenda-count" role="status">{rows().length} of {total()} {mode() === 'agenda' ? 'agenda item' : 'task'}{total() === 1 ? '' : 's'}</p></Show>
          <Show when={!rows().length}><p class="agenda-message">{mode() === 'agenda' ? 'Nothing planned' : 'No tasks match these filters.'}</p></Show>
        </Show>
        <TaskSourceRows rows={rows()} date={date()} pageId={props.notebook.roots().find(root => root.kind === 'journal' && root.text === date())?.id} notebook={props.notebook} disabled={busy() || loading() || !!error()} onOpen={props.onOpen} onChanged={() => setRefresh(value => value + 1)} />
      </section>
      </Show>
      <Show keyed when={popup()}>{state => {
        const dismiss = () => { if (!busy() && popup() === state) setPopup(null); };
        if (state.kind === 'menu') return <Menu anchor={state.anchor} label={state.label} items={state.items} onDismiss={dismiss} />;
        if (state.kind === 'date') return <DatePicker notebook={props.notebook} anchor={state.anchor} label="Displayed date" value={date()} contextDate={date()} onDismiss={dismiss} onSelect={value => { if (!value.date) throw new Error('Choose a displayed date.'); update({ date: value.date, scroll: 0 }); }} />;
        if (state.kind === 'range') return <DatePicker notebook={props.notebook} anchor={state.anchor} label={`${state.field === 'scheduled' ? 'Scheduled' : 'Deadline'} ${state.edge}`} value={query().filter[state.field]?.[state.edge] ?? null} contextDate={date()} onDismiss={dismiss} onSelect={value => update({ query: taskRange(query(), state.field, state.edge, value.date) })} />;
        if (state.kind === 'projects') return <Picker<ProjectChoice> anchor={state.anchor} label="Project" query={pickerSearch()} onQuery={setPickerSearch} placeholder="Find a project" items={projectChoices()} key={item => item.id ?? 'any'} busy={metadataLoading()} error={metadataError()} onDismiss={dismiss} onPick={item => { updateFilter({ project_id: item.id }); dismiss(); }} row={item => <><Icon name={query().filter.project_id === item.id ? 'check' : 'page'} /><span class="picker-text">{item.name}</span></>} empty="No matching projects." />;
        if (state.kind === 'views') return <Picker<TaskView | null> anchor={state.anchor} label="Saved task views" query={pickerSearch()} onQuery={setPickerSearch} placeholder="Find a task view" items={[null, ...viewChoices()]} key={item => item?.id ?? 'unsaved'} busy={viewsLoading()} error={viewsError()} onDismiss={dismiss} onPick={selectView} row={item => <><Icon name={viewId() === (item?.id ?? null) ? 'check' : 'page'} /><span class="picker-text">{item?.name ?? 'New task query'}</span></>} empty="No matching task views." />;
        if (state.kind === 'name') return <TaskViewNamePopup anchor={state.anchor} name={state.saved?.name ?? ''} rename={state.action === 'rename'} busy={busy()} onDismiss={dismiss} onSave={name => saveView(name, state.id, state.saved, state.action === 'rename')} />;
        if (state.kind === 'delete') return <Popup anchor={state.anchor} label="Delete task view?" onDismiss={dismiss}><p>Delete “{state.saved.name}”? Tasks are not deleted.</p><Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show><div class="popup-actions"><Button disabled={busy()} onClick={dismiss}>Cancel</Button><Button class="bordered danger" disabled={busy()} onClick={() => { void deleteView(state.saved); }}>Delete view</Button></div></Popup>;
      }}</Show>
    </div>
  </div>;
}

function TaskViewNamePopup(props: { anchor: HTMLElement; name: string; rename: boolean; busy: boolean; onDismiss(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = createSignal(props.name);
  const [error, setError] = createSignal('');
  const submit = async () => {
    if (props.busy || !name().trim()) return;
    setError('');
    try { await props.onSave(name()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <Popup anchor={props.anchor} label={props.rename ? 'Rename task view' : 'Save as task view'} onDismiss={props.onDismiss}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}><input class="input" aria-label="Task view name" placeholder="View name" value={name()} maxlength={120} disabled={props.busy} onInput={event => setName(event.currentTarget.value)} />
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button disabled={props.busy} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={props.busy || !name().trim()}>Save</Button></div>
    </form>
  </Popup>;
}
