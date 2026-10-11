import { For, Show, createEffect, createMemo, createRoot, createSignal } from 'solid-js';
import { ApiError } from '../api/client';
import type { AgendaItem, TaskRow, WorkSession } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { statusIcons, statusLabels } from './TaskControls';
import { agendaTaskTime, isFinished, taskFacts } from './task-labels';
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
  /** Day view puts the clock in a fixed gutter and provenance at the trailing edge. */
  timetable?: boolean;
  /** A lookahead group implies this plan date, while completion still uses the displayed date. */
  plannedDate?: string;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const byId = createMemo(() => new Map(props.rows.map(row => [row.source.block.id, row])));
  const ids = createMemo(() => [...byId().keys()]);
  return <ul class="agenda-rows"><For each={ids()}>{id => {
    const initial = byId().get(id)!;
    return <TaskSourceRow row={byId().get(id) ?? initial} date={props.date} pageId={props.pageId} notebook={props.notebook} disabled={props.disabled} timetable={props.timetable} plannedDate={props.plannedDate} onOpen={props.onOpen} onChanged={props.onChanged} />;
  }}</For></ul>;
}

function TaskSourceRow(props: {
  row: TaskRow | AgendaItem;
  date: string;
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  timetable?: boolean;
  plannedDate?: string;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [running, setRunning] = createSignal<{ anchor: HTMLElement; session: WorkSession; date: string; row: TaskRow | AgendaItem } | null>(null);
  const historical = () => 'reasons' in props.row && props.row.reasons.includes('recently_completed');
  const unfinished = () => !historical() && !isFinished(props.row.task);
  const time = createMemo(() => props.timetable ? agendaTaskTime(props.row, props.plannedDate ?? props.date) : 'time' in props.row ? props.row.time : null);
  const facts = createMemo(() => historical() ? [] : taskFacts(props.row.task, { date: props.plannedDate ?? props.date, today: props.notebook.todayDate(), listed: props.timetable || 'reasons' in props.row, timeShown: !!time() }));
  /** Opens the canonical source, runs one edit on its task block and saves it. */
  const editSource = async (row: TaskRow | AgendaItem, edit: (doc: PageDocument) => Promise<boolean | void>) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    const doc = props.notebook.open(row.source.page.id);
    try {
      await documentReady(doc);
      if (await edit(doc) === false) return;
      await doc.flush();
      setRunning(null);
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      doc.release();
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
  return <li class="agenda-row" classList={{ 'agenda-row-timetable': props.timetable, 'agenda-row-completed': historical() || props.row.task.status === 'done', 'agenda-row-cancelled': !historical() && props.row.task.status === 'cancelled' }} aria-busy={busy()}>
    <Show when={props.timetable}><span class="agenda-time-gutter">{time()}</span></Show>
    <Show when={!historical()} fallback={<span class="agenda-status task-status-button" data-status="done" aria-label="Done"><Icon name="check" /></span>}>
      <Button class="agenda-status task-status-button" data-status={props.row.task.status} label={`${unfinished() ? 'Complete' : 'Reopen'} task (${statusLabels[props.row.task.status]}): ${props.row.source.block.text}`} title={unfinished() ? `Complete on ${props.date}` : 'Reopen task'} disabled={busy() || props.disabled}
        onClick={event => { void (unfinished() ? complete(event.currentTarget, props.date) : reopen()); }}><Icon name={statusIcons[props.row.task.status]} /></Button>
    </Show>
    <button type="button" class="agenda-source" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, event.shiftKey)} title="Open source · Shift to open beside">
      <span class="agenda-source-text"><BlockText text={props.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
      <Show when={!props.timetable && props.row.source.page.id !== props.pageId}><span class="agenda-source-page">{props.row.source.page.text}</span></Show>
    </button>
    <Show when={props.timetable && props.row.source.page.id !== props.pageId}>
      <button type="button" class="agenda-provenance" aria-label={`Open source page, ${props.row.source.page.text}`} title={props.row.source.page.text} onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, event.shiftKey)}>{props.row.source.page.kind === 'journal' ? 'Journal' : props.row.source.page.text}</button>
    </Show>
    <span class="agenda-row-meta">
      <Show when={!props.timetable && time()}><span class="agenda-time">{time()}</span></Show>
      <For each={facts()}>{fact => <span classList={{ 'agenda-late': !!fact.late }} title={fact.label}>{fact.text}</span>}</For>
    </span>
    <Show when={busy()}><p class="agenda-message" role="status">Saving… <Show when={props.notebook.saveState() !== 'saved'}>{props.notebook.saveMessage() || props.notebook.saveState()}</Show></p></Show>
    <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={props.onChanged}>Refresh</Button></div></Show>
    <Show keyed when={running()}>{state => <Popup anchor={state.anchor} label="Stop work and complete?" onDismiss={() => { if (!busy()) setRunning(null); }}>
      <p>Stop work and complete this task on {state.date}?</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setRunning(null)}>Cancel</Button><Button class="bordered" disabled={busy() || props.disabled} onClick={() => { void complete(state.anchor, state.date, state.session, state.row); }}>Stop and complete</Button></div>
    </Popup>}</Show>
  </li>;
}
