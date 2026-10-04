import { For, Show, createEffect, createMemo, createRoot, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import { ApiError } from '../api/client';
import type { Agenda, AgendaItem, AgendaReason, TaskRow, WorkSession } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import './agenda.css';

export interface JournalAgendaProps {
  date: string;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

export function JournalAgenda(props: JournalAgendaProps) {
  const id = createUniqueId();
  const [expanded, setExpanded] = createSignal(true);
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
  return <section class="journal-agenda" aria-label="Agenda">
    <Button class="journal-agenda-toggle" aria-expanded={expanded()} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <Icon name={expanded() ? 'down' : 'right'} />Agenda
      <Show when={agenda()}>{value => <span class="agenda-count">{value().items.length}</span>}</Show>
    </Button>
    <Show when={expanded()}><div id={id} class="journal-agenda-body" aria-busy={loading()}>
      <Show when={loading()}><p class="agenda-message" role="status">Loading agenda…</p></Show>
      <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <Show when={!loading() && !error() && agenda()?.items.length === 0}><p class="agenda-message">Nothing planned</p></Show>
      <TaskSourceRows rows={agenda()?.items ?? []} date={props.date} notebook={props.notebook} disabled={loading() || !!error()} onOpen={props.onOpen} onChanged={() => setRefresh(value => value + 1)} />
    </div></Show>
  </section>;
}

const reasonLabels: Record<AgendaReason, string> = {
  scheduled: 'Scheduled', deadline: 'Deadline', warning: 'Deadline warning', overdue: 'Overdue', unplanned: 'Unplanned', recently_completed: 'Completed',
};

/** Agenda and task queries render the same canonical source, never journal copies. */
export function TaskSourceRows(props: {
  rows: readonly (TaskRow | AgendaItem)[];
  date: string;
  notebook: NotebookClient;
  disabled?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const byId = createMemo(() => new Map(props.rows.map(row => [row.source.block.id, row])));
  const ids = createMemo(() => [...byId().keys()]);
  return <ul class="agenda-rows"><For each={ids()}>{id => {
    const initial = byId().get(id)!;
    return <TaskSourceRow row={byId().get(id) ?? initial} date={props.date} notebook={props.notebook} disabled={props.disabled} onOpen={props.onOpen} onChanged={props.onChanged} />;
  }}</For></ul>;
}

function TaskSourceRow(props: {
  row: TaskRow | AgendaItem;
  date: string;
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
      const ready = Promise.withResolvers<void>();
      createRoot(dispose => {
        createEffect(() => {
          const status = doc.status();
          if (status === 'ready') { dispose(); ready.resolve(); }
          else if (status !== 'loading') { dispose(); ready.reject(new Error(doc.statusMessage())); }
        });
      });
      await ready.promise;
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
  return <li class="agenda-row" classList={{ 'agenda-row-completed': historical() }} aria-busy={busy()}>
    <div class="agenda-row-main">
      <Show when={unfinished()} fallback={<span class="agenda-status" aria-label={props.row.task.status === 'cancelled' ? 'Cancelled' : 'Done'}><Icon name={props.row.task.status === 'cancelled' ? 'close' : 'check'} /></span>}>
        <Button class="agenda-status" label={`Complete task: ${props.row.source.block.text}`} title={`Complete on ${props.date} · ${props.row.task.status}`} disabled={busy() || props.disabled} onClick={event => { void complete(event.currentTarget, props.date); }}><Icon name="select" /></Button>
      </Show>
      <button type="button" class="agenda-source" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, event.shiftKey)} title="Open source · Shift to open beside">
        <span class="agenda-source-text"><BlockText text={props.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
        <span class="agenda-source-page">{props.row.source.page.text}</span>
      </button>
      <Show when={'time' in props.row && props.row.time}><span class="agenda-time">{'time' in props.row ? props.row.time : null}</span></Show>
    </div>
    <div class="agenda-row-meta">
      <Show when={historical()} fallback={<Show when={props.row.task.completed_on}><span>Completed {props.row.task.completed_on}</span></Show>}><span>Completed {props.row.task.completed_on} · historical occurrence</span></Show>
      <Show when={props.row.task.scheduled}><span>Scheduled {props.row.task.scheduled}{props.row.task.scheduled_time ? ` ${props.row.task.scheduled_time}` : ''}</span></Show>
      <Show when={props.row.task.deadline}><span>Deadline {props.row.task.deadline}{props.row.task.deadline_time ? ` ${props.row.task.deadline_time}` : ''}</span></Show>
      <Show when={props.row.task.priority}><span>Priority: {props.row.task.priority}</span></Show>
      <For each={'reasons' in props.row ? props.row.reasons.filter(reason => reason !== 'recently_completed') : []}>{reason => <span>{reasonLabels[reason]}</span>}</For>
    </div>
    <Show when={busy()}><p class="agenda-message" role="status">Saving completion… <Show when={props.notebook.saveState() !== 'saved'}>{props.notebook.saveMessage() || props.notebook.saveState()}</Show></p></Show>
    <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={props.onChanged}>Refresh</Button></div></Show>
    <Show keyed when={running()}>{state => <Popup anchor={state.anchor} label="Stop work and complete?" onDismiss={() => { if (!busy()) setRunning(null); }}>
      <p>Stop work and complete this task on {state.date}?</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setRunning(null)}>Cancel</Button><Button class="bordered" disabled={busy() || props.disabled} onClick={() => { void complete(state.anchor, state.date, state.session, state.row); }}>Stop and complete</Button></div>
    </Popup>}</Show>
  </li>;
}
