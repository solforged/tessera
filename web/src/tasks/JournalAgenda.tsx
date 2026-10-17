import { For, Show, createEffect, createMemo, createRoot, createSignal, onCleanup } from 'solid-js';
import { ApiError } from '../api/client';
import type { AgendaItem, TaskRow, TaskState, TaskStatus, WorkSession } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { Menu } from '../ui/Menu';
import { DatePicker } from './DatePicker';
import { movableTo, rescheduleTasks } from './reschedule';
import { priorityLabel, priorityMenuItems, statusIcons, statusLabels, statusMenuItems } from './TaskControls';
import { agendaTaskTime, isFinished, relativeDate, taskFacts } from './task-labels';
import { PriorityBars } from './PriorityBars';
import { shiftCalendarDate } from './week-calendar';
import type { TaskSourceHistory } from './source-history';
import './agenda.css';

/** Resolves once an opened document has loaded; rejects when it is missing or failed. */
export function documentReady(doc: PageDocument): Promise<void> {
  const ready = Promise.withResolvers<void>();
  createRoot(dispose => {
    createEffect(() => {
      const status = doc.status();
      if (status === 'ready') { dispose(); ready.resolve(); }
      else if (status !== 'loading') { dispose(); ready.reject(new Error(doc.statusMessage())); }
    });
  });
  return ready.promise;
}

/** Agenda and task queries render the same canonical source, never journal copies. */
export function TaskSourceRows(props: {
  rows: readonly (TaskRow | AgendaItem)[];
  date: string;
  /** Omit the source page label for rows from this page. */
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  history?: TaskSourceHistory;
  /** Day view puts the clock in a fixed gutter and provenance at the trailing edge. */
  timetable?: boolean;
  /** Outline-sorted queries show each contiguous section without changing task order. */
  sections?: boolean;
  /** A lookahead group implies this plan date, while completion still uses the displayed date. */
  plannedDate?: string;
  /** Offers Today, Tomorrow and a date on unfinished rows, with the same keys. */
  plan?: boolean;
  /** The notebook clock while the displayed day is today: past timed rows fade under a now rule. */
  now?: string;
  /** Week keeps today's rule even when no row has a clock. */
  showNow?: boolean;
  /** Week's gutter names an untimed deadline and uses only this day's exact plan clock. */
  deadlineLabel?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const byId = createMemo(() => new Map(props.rows.map(row => [row.source.block.id, row])));
  const ids = createMemo(() => {
    const keys = [...byId().keys()];
    if (!props.now || !props.timetable) return keys;
    const times = new Map(keys.map(id => [id, agendaTaskTime(byId().get(id)!, props.plannedDate ?? props.date, !props.deadlineLabel) ?? '']));
    return keys.sort((left, right) => Number(!!times.get(right) && times.get(right)! < props.now!) - Number(!!times.get(left) && times.get(left)! < props.now!)
      || times.get(left)!.localeCompare(times.get(right)!));
  });
  // The now rule sits above the first row not yet due, once any row has a time; after the last when all are past.
  const nowAt = createMemo(() => {
    if (!props.now || !props.timetable) return null;
    const times = ids().map(id => agendaTaskTime(byId().get(id)!, props.plannedDate ?? props.date, !props.deadlineLabel));
    if (!props.showNow && !times.some(Boolean)) return null;
    const index = times.findIndex(time => !time || time >= props.now!);
    return index < 0 ? 'end' : ids()[index]!;
  });
  return <ul class="agenda-rows"><For each={ids()}>{(id, index) => {
    const initial = byId().get(id)!;
    const section = () => {
      if (!props.sections) return null;
      const row = byId().get(id);
      const previous = byId().get(ids()[index() - 1]!);
      return row && 'section_id' in row && row.section_id && (!previous || !('section_id' in previous) || previous.section_id !== row.section_id) ? row.section_text : null;
    };
    return <><Show when={section()}>{text => <li class="agenda-day-section"><h3 class="agenda-lookahead-date"><BlockText text={text()} notebook={props.notebook} interactive={false} /></h3></li>}</Show><TaskSourceRow row={byId().get(id) ?? initial} date={props.date} pageId={props.pageId} notebook={props.notebook} disabled={props.disabled} history={props.history} timetable={props.timetable} plannedDate={props.plannedDate} plan={props.plan} deadlineLabel={props.deadlineLabel} showNow={props.showNow} now={props.now} nowBefore={nowAt() === id} onOpen={props.onOpen} onChanged={props.onChanged} /></>;
  }}</For><Show when={nowAt() === 'end'}><li class="agenda-now agenda-now-end" aria-hidden="true"><Show when={props.showNow}><span>{props.now}</span></Show></li></Show></ul>;
}

/** The source button of the row `step` away, across sections of the same `[data-task-rows]` region. */
function siblingSource(row: HTMLElement, step: 1 | -1): HTMLElement | null {
  const scope = row.closest('[data-task-rows]') ?? row.parentElement!;
  const sources = [...scope.querySelectorAll<HTMLElement>('.agenda-row .agenda-source')];
  return sources[sources.findIndex(source => row.contains(source)) + step] ?? null;
}

function TaskSourceRow(props: {
  row: TaskRow | AgendaItem;
  date: string;
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  history?: TaskSourceHistory;
  timetable?: boolean;
  plannedDate?: string;
  plan?: boolean;
  deadlineLabel?: boolean;
  showNow?: boolean;
  /** The notebook clock while the displayed day is today. */
  now?: string;
  /** Draws the now rule above this row. */
  nowBefore?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [running, setRunning] = createSignal<{ anchor: HTMLElement; session: WorkSession; date: string; row: TaskRow | AgendaItem } | null>(null);
  const [picking, setPicking] = createSignal<HTMLElement | null>(null);
  const [menu, setMenu] = createSignal<{ kind: 'status' | 'priority'; anchor: HTMLElement } | null>(null);
  const historical = () => 'reasons' in props.row && props.row.reasons.includes('recently_completed');
  const unfinished = () => !historical() && !isFinished(props.row.task);
  const time = createMemo(() => props.timetable ? agendaTaskTime(props.row, props.plannedDate ?? props.date, !props.deadlineLabel) : 'time' in props.row ? props.row.time : null);
  const facts = createMemo(() => historical() ? [] : taskFacts(props.row.task, { date: props.plannedDate ?? props.date, today: props.notebook.todayDate(), listed: props.timetable || 'reasons' in props.row, timeShown: !!time() }));
  /** Opens the canonical source, runs one edit on its task block and saves it. */
  const editSource = async (row: TaskRow | AgendaItem, edit: (doc: PageDocument) => Promise<boolean | void>) => {
    if (busy() || props.disabled) return;
    item.querySelector<HTMLElement>('.agenda-source')?.focus({ preventScroll: true });
    setBusy(true); setError('');
    const doc = props.history ? null : props.notebook.open(row.source.page.id);
    try {
      if (props.history) { if (await props.history.edit(row, edit) === false) return; }
      else {
        await documentReady(doc!);
        if (await edit(doc!) === false) return;
        await doc!.flush();
      }
      setRunning(null);
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      doc?.release();
      setBusy(false);
    }
  };
  const complete = (anchor: HTMLElement, date: string, stopWork?: WorkSession, row = props.row) => editSource(row, async doc => {
    let active: WorkSession | null | undefined;
    if (props.notebook.connection() !== 'offline') {
      try { active = await props.notebook.api.activeWorkSession(); }
      catch (reason) { if (!(reason instanceof ApiError) || !reason.uncertain) throw reason; }
    }
    const source = doc.block(row.source.block.id);
    if (!source?.task || source.revision !== row.source.block.revision || isFinished(source.task)) {
      throw new Error('This task changed. Refresh or open its source before completing it.');
    }
    if (active?.block_id === source.id && (!stopWork || stopWork.id !== active.id || stopWork.revision !== active.revision)) {
      setRunning({ anchor, session: active, date, row });
      return false;
    }
    const stopping = active === undefined ? stopWork : active?.block_id === source.id ? stopWork : undefined;
    const result = doc.edit({ kind: 'completeTask', id: source.id, completedOn: date, ...(stopping ? { stopWork: stopping } : {}) });
    if (!result.ok) throw new Error(result.reason);
  });
  const reopen = () => editSource(props.row, async doc => {
    const source = doc.block(props.row.source.block.id);
    if (!source?.task || source.revision !== props.row.source.block.revision || !isFinished(source.task)) {
      throw new Error('This task changed. Refresh or open its source before reopening it.');
    }
    const result = doc.edit({ kind: 'task', id: source.id, value: { ...source.task, status: 'todo', completed_on: null } });
    if (!result.ok) throw new Error(result.reason);
  });
  const changeStatus = (status: TaskStatus | null, anchor: HTMLElement) => {
    if (status === props.row.task.status) return;
    if (status === 'done') { void complete(anchor, props.date); return; }
    const row = props.row;
    void editSource(row, async doc => {
      const source = doc.block(row.source.block.id);
      if (!source?.task || source.revision !== row.source.block.revision) throw new Error('This task changed. Refresh or open its source before changing its status.');
      const result = doc.edit({ kind: 'task', id: source.id, value: status === null ? null : { ...source.task, status, completed_on: null } });
      if (!result.ok) throw new Error(result.reason);
    });
  };
  const changePriority = (priority: TaskState['priority']) => {
    const row = props.row;
    if (priority === row.task.priority) return;
    void editSource(row, async doc => {
      const source = doc.block(row.source.block.id);
      if (!source?.task || source.revision !== row.source.block.revision) throw new Error('This task changed. Refresh or open its source before changing its priority.');
      const result = doc.edit({ kind: 'task', id: source.id, value: { ...source.task, priority } });
      if (!result.ok) throw new Error(result.reason);
    });
  };
  const today = () => props.notebook.todayDate();
  const tomorrow = () => shiftCalendarDate(today(), 1)!;
  const past = () => !!props.now && unfinished() && props.row.task.status !== 'doing' && !!time() && time()! < props.now;
  let item!: HTMLLIElement;
  onCleanup(() => {
    if (!item?.contains(document.activeElement)) return;
    const scope = item.closest<HTMLElement>('[data-task-rows]');
    const next = siblingSource(item, 1) ?? siblingSource(item, -1);
    if (next) next.focus({ preventScroll: true });
    else {
      const owner = item.closest<HTMLElement>('.agenda-pane') ?? scope;
      if (owner) { if (!owner.hasAttribute('tabindex')) owner.tabIndex = -1; owner.focus({ preventScroll: true }); }
    }
  });
  const reschedule = (date: string | null, time?: string | null) => {
    if (!date || busy() || props.disabled || !movableTo([props.row], date, time).length) return;
    // The row may leave this list; keep the keyboard, or the picker it opened, on the row after it.
    const next = item.contains(document.activeElement) || picking() ? siblingSource(item, 1) ?? siblingSource(item, -1) : null;
    setBusy(true); setError('');
    void rescheduleTasks(props.notebook, [props.row], date, `Reschedule task to ${relativeDate(date, today())}`, time)
      .then(() => { setPicking(null); props.onChanged(); next?.focus(); }, reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  /** On a focused row: j and k move, t today, m tomorrow, s a date, x complete, ⌥← and ⌥→ a day earlier or later. */
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || busy() || props.disabled || event.target instanceof HTMLInputElement || !(event.target instanceof Element) || event.target.closest('.popup')) return;
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter' && !historical()) {
      setMenu({ kind: 'status', anchor: item.querySelector<HTMLElement>('.agenda-status') ?? item });
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.metaKey || event.ctrlKey) return;
    const key = event.key.toLocaleLowerCase(), from = props.row.task.scheduled ?? props.date;
    if (!event.altKey && !event.shiftKey && (key === 'j' || key === 'k' || key === 'arrowdown' || key === 'arrowup')) siblingSource(item, key === 'j' || key === 'arrowdown' ? 1 : -1)?.focus();
    else if (!event.altKey && !event.shiftKey && key === 'p' && unfinished()) setMenu({ kind: 'priority', anchor: item.querySelector<HTMLElement>('.agenda-priority') ?? item });
    else if (!props.plan || !unfinished()) return;
    else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) reschedule(shiftCalendarDate(from, event.key === 'ArrowLeft' ? -1 : 1));
    else if (event.altKey || event.shiftKey) return;
    else if (key === 't') reschedule(today());
    else if (key === 'm') reschedule(tomorrow());
    else if (key === 's') setPicking(item.querySelector<HTMLElement>('.agenda-row-pick') ?? item);
    else if (key === 'x') { const button = item.querySelector<HTMLElement>('.agenda-status'); if (button) void complete(button, props.date); }
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <li ref={item} class="agenda-row" data-task-id={props.row.source.block.id} classList={{ 'agenda-row-timetable': props.timetable, 'agenda-row-past': past(), 'agenda-row-picking': !!picking(), 'agenda-row-completed': historical() || props.row.task.status === 'done', 'agenda-row-cancelled': !historical() && props.row.task.status === 'cancelled' }} aria-busy={busy()} onKeyDown={keydown}>
    <Show when={props.nowBefore}><span class="agenda-now" aria-hidden="true"><Show when={props.showNow}><span>{props.now}</span></Show></span></Show>
    <Show when={props.timetable}><span class="agenda-time-gutter" classList={{ 'week-ledger-due': !!props.deadlineLabel && !time() && props.row.task.deadline === props.date }}>{time() || (props.deadlineLabel && props.row.task.deadline === props.date ? 'Due' : '')}</span></Show>
    <Show when={!historical()} fallback={<span class="agenda-status task-status-button" data-status="done" aria-label="Done"><Icon name="check" /></span>}>
      <Button class="agenda-status task-status-button" data-status={props.row.task.status} label={`${unfinished() ? 'Complete' : 'Reopen'} task (${statusLabels[props.row.task.status]}): ${props.row.source.block.text}`} title={`${unfinished() ? `Complete on ${props.date}` : 'Reopen task'} · right-click for status`} disabled={busy() || props.disabled} aria-haspopup="menu" aria-expanded={menu()?.kind === 'status'}
        onContextMenu={event => { event.preventDefault(); if (!busy() && !props.disabled) setMenu({ kind: 'status', anchor: event.currentTarget }); }}
        onClick={event => { void (unfinished() ? complete(event.currentTarget, props.date) : reopen()); }}><Icon name={statusIcons[props.row.task.status]} /></Button>
    </Show>
    <button type="button" class="agenda-source" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, opensBeside(event))} title={`Open source · ${besideHint}`}>
      <span class="agenda-source-text"><BlockText text={props.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
      <Show when={!props.timetable && props.row.source.page.id !== props.pageId}><span class="agenda-source-page">{props.row.source.page.text}</span></Show>
    </button>
    <Show when={props.timetable && props.row.source.page.id !== props.pageId}>
      <button type="button" class="agenda-provenance" aria-label={`Open source page, ${props.row.source.page.text}`} title={props.row.source.page.text} onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, opensBeside(event))}>{props.row.source.page.kind === 'journal' ? 'Journal' : props.row.source.page.text}</button>
    </Show>
    <span class="agenda-row-meta">
      <Show when={!props.timetable && time()}><span class="agenda-time">{time()}</span></Show>
      <For each={facts().filter(fact => !fact.priority)}>{fact => <span classList={{ 'agenda-late': !!fact.late }} title={fact.label}>{fact.text}</span>}</For>
      <Show when={unfinished()}><Button class="agenda-priority" label={`Priority: ${priorityLabel(props.row.task.priority)}`} title={`Priority: ${priorityLabel(props.row.task.priority)} (P)`} disabled={busy() || props.disabled} aria-haspopup="menu" aria-expanded={menu()?.kind === 'priority'} onClick={event => setMenu({ kind: 'priority', anchor: event.currentTarget })}><PriorityBars priority={props.row.task.priority} label={`${priorityLabel(props.row.task.priority)} priority`} /></Button></Show>
      {/* A project the row already names as its source page is not repeated among the facts. */}
      <Show when={props.row.project_id !== props.pageId && props.row.project_id !== props.row.source.page.id ? props.row.project_id : null}>{id => <span><BlockText text={props.notebook.lookup(id())()?.text ?? ''} notebook={props.notebook} interactive={false} /></span>}</Show>
    </span>
    <Show when={props.plan && unfinished()}>
      <span class="agenda-row-actions">
        <Show when={props.row.task.scheduled !== today()}><Button disabled={busy() || props.disabled} title="Schedule for today (T)" onClick={() => reschedule(today())}>Today</Button></Show>
        <Show when={props.row.task.scheduled !== tomorrow()}><Button disabled={busy() || props.disabled} title="Schedule for tomorrow (M)" onClick={() => reschedule(tomorrow())}>Tomorrow</Button></Show>
        <Button class="agenda-row-pick" icon="calendar" label="Reschedule…" shortcut="S" disabled={busy() || props.disabled} onClick={event => setPicking(event.currentTarget)} />
      </span>
    </Show>
    <Show when={picking()}>{anchor => <DatePicker notebook={props.notebook} anchor={anchor()} label="Reschedule" value={props.row.task.scheduled} time={props.row.task.scheduled_time} contextDate={props.notebook.todayDate()} onDismiss={() => setPicking(null)} onSelect={value => reschedule(value.date, value.time)} />}</Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.kind === 'status' ? 'Task status' : 'Priority'} onDismiss={() => { setMenu(null); item.querySelector<HTMLElement>('.agenda-source')?.focus({ preventScroll: true }); }} items={state.kind === 'status'
      ? statusMenuItems(props.row.task, status => changeStatus(status, state.anchor), busy() || props.disabled ? 'Task is unavailable.' : undefined)
      : priorityMenuItems(props.row.task.priority, changePriority, busy() || props.disabled ? 'Task is unavailable.' : undefined)} />}</Show>
    <Show when={busy()}><p class="agenda-message" role="status">Saving… <Show when={props.notebook.saveState() !== 'saved'}>{props.notebook.saveMessage() || props.notebook.saveState()}</Show></p></Show>
    <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={props.onChanged}>Refresh</Button></div></Show>
    <Show keyed when={running()}>{state => <Popup anchor={state.anchor} label="Stop work and complete?" onDismiss={() => { if (!busy()) setRunning(null); }}>
      <p>Stop work and complete this task on {state.date}?</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setRunning(null)}>Cancel</Button><Button class="bordered" disabled={busy() || props.disabled} onClick={() => { void complete(state.anchor, state.date, state.session, state.row); }}>Stop and complete</Button></div>
    </Popup>}</Show>
  </li>;
}
