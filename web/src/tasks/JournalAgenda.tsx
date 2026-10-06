import { For, Show, createEffect, createMemo, createRoot, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import { ApiError } from '../api/client';
import type { Agenda, AgendaItem, TaskRow, WorkSession } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import './agenda.css';

export interface JournalAgendaProps {
  date: string;
  /** The journal root; its own tasks are already visible in the outline below. */
  pageId: string;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

const collapsedKey = 'tessera.journal-agenda.collapsed';
// One device preference shared by every journal pane.
const [collapsed, setCollapsedSignal] = createRoot(() => createSignal((() => { try { return localStorage.getItem(collapsedKey) === '1'; } catch { return false; } })()));
const setCollapsed = (value: boolean) => {
  setCollapsedSignal(value);
  try { if (value) localStorage.setItem(collapsedKey, '1'); else localStorage.removeItem(collapsedKey); } catch { /* The preference lasts for this tab. */ }
};

export function JournalAgenda(props: JournalAgendaProps) {
  const id = createUniqueId();
  const [showUnplanned, setShowUnplanned] = createSignal(false);
  const [agenda, setAgenda] = createSignal<Agenda>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  createEffect(() => {
    const date = props.date;
    props.notebook.changeSequence(); refresh();
    let current = true;
    setLoading(true); setError('');
    if (untrack(agenda)?.date !== date) setAgenda(undefined);
    void props.notebook.api.agenda(date).then(value => {
      if (current) { setAgenda(value); setLoading(false); }
    }).catch(reason => {
      if (current) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => { current = false; });
  });
  const groups = createMemo(() => {
    const planned: AgendaItem[] = [], done: AgendaItem[] = [], open: AgendaItem[] = [];
    let late = 0, here = 0;
    for (const item of agenda()?.items ?? []) {
      if (item.source.page.id === props.pageId) { if (!item.reasons.includes('unplanned')) here++; continue; }
      if (item.reasons.includes('recently_completed')) done.push(item);
      else if (item.reasons.length === 1 && item.reasons[0] === 'unplanned') open.push(item);
      else {
        planned.push(item);
        if (item.reasons.includes('overdue') || !!item.task.scheduled && item.task.scheduled < props.date) late++;
      }
    }
    return { planned, done, open, late, here };
  });
  const summary = createMemo(() => {
    const { planned, done, late } = groups();
    return [
      ...planned.length ? [{ text: `${planned.length} to do` }] : [],
      ...late ? [{ text: `${late} overdue`, late: true }] : [],
      ...done.length ? [{ text: `${done.length} done` }] : [],
    ];
  });
  const rowProps = { get date() { return props.date; }, get pageId() { return props.pageId; }, notebook: props.notebook, get disabled() { return loading() || !!error(); }, onOpen: props.onOpen, onChanged: () => setRefresh(value => value + 1) };
  return <section class="journal-agenda" aria-label="Agenda">
    <Button class="journal-agenda-toggle" aria-expanded={!collapsed()} aria-controls={id} onClick={() => setCollapsed(!collapsed())}>
      <Icon name="down" />Agenda
      <span class="agenda-summary">{loading() && !agenda() ? 'Loading…' : summary().length ? <For each={summary()}>{(part, index) => <>{index() ? ' · ' : ''}<span classList={{ 'agenda-late': !!part.late }}>{part.text}</span></>}</For> : groups().here ? 'Nothing else planned' : 'Nothing planned'}</span>
    </Button>
    <Show when={!collapsed()}><div id={id} class="journal-agenda-body" aria-busy={loading()}>
      <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={groups().planned.length || groups().done.length}><TaskSourceRows rows={[...groups().planned, ...groups().done]} {...rowProps} /></Show>
      <Show when={groups().open.length}>
        <Button class="journal-agenda-toggle" aria-expanded={showUnplanned()} onClick={() => setShowUnplanned(value => !value)}>
          <Icon name="down" />Unplanned<span class="agenda-summary">{groups().open.length}</span>
        </Button>
        <Show when={showUnplanned()}><TaskSourceRows rows={groups().open} {...rowProps} /></Show>
      </Show>
    </div></Show>
  </section>;
}

const statusLabels = { doing: 'Doing', waiting: 'Waiting' } as const;
const priorityLabels = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' } as const;
const clock = (time: string | null) => time ? ` ${time}` : '';

/** Planning relative to the displayed day; facts implied by being listed on that day are omitted. */
function planning(row: TaskRow | AgendaItem, date: string, historical: boolean): { text: string; late?: boolean }[] {
  const task = row.task;
  if (historical) return [];
  const labels: { text: string; late?: boolean }[] = [];
  if (task.status === 'doing' || task.status === 'waiting') labels.push({ text: statusLabels[task.status] });
  if (task.status === 'done' && task.completed_on) labels.push({ text: `Done ${task.completed_on}` });
  if (task.scheduled && task.scheduled !== date) labels.push({ text: `Scheduled ${task.scheduled}${clock(task.scheduled_time)}`, late: task.scheduled < date && task.status !== 'done' });
  if (task.deadline) {
    const late = task.deadline < date && task.status !== 'done';
    labels.push({ text: task.deadline === date ? `Due${'time' in row ? '' : clock(task.deadline_time)}` : `${late ? 'Was due' : 'Due'} ${task.deadline}${clock(task.deadline_time)}`, late });
  }
  if (task.priority) labels.push({ text: priorityLabels[task.priority] });
  return labels;
}

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
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const byId = createMemo(() => new Map(props.rows.map(row => [row.source.block.id, row])));
  const ids = createMemo(() => [...byId().keys()]);
  return <ul class="agenda-rows"><For each={ids()}>{id => {
    const initial = byId().get(id)!;
    return <TaskSourceRow row={byId().get(id) ?? initial} date={props.date} pageId={props.pageId} notebook={props.notebook} disabled={props.disabled} onOpen={props.onOpen} onChanged={props.onChanged} />;
  }}</For></ul>;
}

function TaskSourceRow(props: {
  row: TaskRow | AgendaItem;
  date: string;
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [running, setRunning] = createSignal<{ anchor: HTMLElement; session: WorkSession; date: string; row: TaskRow | AgendaItem } | null>(null);
  const historical = () => 'reasons' in props.row && props.row.reasons.includes('recently_completed');
  const unfinished = () => !historical() && !['done', 'cancelled'].includes(props.row.task.status);
  const complete = async (anchor: HTMLElement, date: string, stopWork?: WorkSession, row = props.row) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    const doc = props.notebook.open(row.source.page.id);
    try {
      await documentReady(doc);
      let active: WorkSession | null | undefined;
      if (props.notebook.connection() !== 'offline') {
        try { active = await props.notebook.api.activeWorkSession(); }
        catch (reason) { if (!(reason instanceof ApiError) || !reason.uncertain) throw reason; }
      }
      const source = doc.block(row.source.block.id);
      if (!source?.task || source.revision !== row.source.block.revision || ['done', 'cancelled'].includes(source.task.status)) {
        throw new Error('This task changed. Refresh or open its source before completing it.');
      }
      if (active?.block_id === source.id && (!stopWork || stopWork.id !== active.id || stopWork.revision !== active.revision)) {
        setRunning({ anchor, session: active, date, row });
        return;
      }
      const stopping = active === undefined ? stopWork : active?.block_id === source.id ? stopWork : undefined;
      const result = doc.edit({ kind: 'completeTask', id: source.id, completedOn: date, ...(stopping ? { stopWork: stopping } : {}) });
      if (!result.ok) throw new Error(result.reason);
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
  return <li class="agenda-row" classList={{ 'agenda-row-completed': historical() || props.row.task.status === 'done' }} aria-busy={busy()}>
    <Show when={unfinished()} fallback={<span class="agenda-status" aria-label={props.row.task.status === 'cancelled' ? 'Cancelled' : 'Done'}><Icon name={props.row.task.status === 'cancelled' ? 'close' : 'check'} /></span>}>
      <Button class="agenda-status" label={`Complete task: ${props.row.source.block.text}`} title={`Complete on ${props.date}`} disabled={busy() || props.disabled} onClick={event => { void complete(event.currentTarget, props.date); }}><Icon name="select" /></Button>
    </Show>
    <button type="button" class="agenda-source" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, event.shiftKey)} title="Open source · Shift to open beside">
      <span class="agenda-source-text"><BlockText text={props.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
      <Show when={props.row.source.page.id !== props.pageId}><span class="agenda-source-page">{props.row.source.page.text}</span></Show>
    </button>
    <span class="agenda-row-meta">
      <Show when={'time' in props.row && props.row.time}><span class="agenda-time">{'time' in props.row ? props.row.time : null}</span></Show>
      <For each={planning(props.row, props.date, historical())}>{label => <span classList={{ 'agenda-late': !!label.late }}>{label.text}</span>}</For>
    </span>
    <Show when={busy()}><p class="agenda-message" role="status">Saving completion… <Show when={props.notebook.saveState() !== 'saved'}>{props.notebook.saveMessage() || props.notebook.saveState()}</Show></p></Show>
    <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={props.onChanged}>Refresh</Button></div></Show>
    <Show keyed when={running()}>{state => <Popup anchor={state.anchor} label="Stop work and complete?" onDismiss={() => { if (!busy()) setRunning(null); }}>
      <p>Stop work and complete this task on {state.date}?</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setRunning(null)}>Cancel</Button><Button class="bordered" disabled={busy() || props.disabled} onClick={() => { void complete(state.anchor, state.date, state.session, state.row); }}>Stop and complete</Button></div>
    </Popup>}</Show>
  </li>;
}
