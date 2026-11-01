import { Show, createEffect, createResource, createSignal } from 'solid-js';
import type { WorkSession } from '../api/types';
import type { Edit, NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { WorkSessions } from './WorkSessions';
import './work-sessions.css';

interface WorkHistory { sessions: WorkSession[]; active: WorkSession | null }

/** A listed task's Work sessions: the popup the outline opens, saving each edit through the task's source page. */
export function AgendaWork(props: {
  notebook: NotebookClient;
  /** The task block. */
  id: string;
  text: string;
  anchor: HTMLElement;
  /** Opens the source page, applies one edit and saves it; rejects with the reason it was refused. */
  save(edit: Edit): Promise<void>;
  onDismiss(): void;
}) {
  const load = async (): Promise<WorkHistory> => {
    const [sessions, active] = await Promise.all([props.notebook.api.workSessions(props.id), props.notebook.api.activeWorkSession()]);
    return { sessions, active };
  };
  const [history, { refetch }] = createResource(() => props.notebook.changeSequence(), load);
  const [shown, setShown] = createSignal<WorkHistory>();
  createEffect(() => { if (!history.error) { const value = history(); if (value) setShown(value); } });
  const start = async () => {
    const current = await load();
    if (current.active) throw new Error(current.active.block_id === props.id ? 'Work is already running on this task.' : 'Work is already running on another task.');
    await props.save({ kind: 'startWork', id: props.id, startedAt: Date.now() });
    await refetch();
  };
  const change = async (kind: 'stopWork' | 'workNote', sessionId: string, note: string) => {
    const session = shown()?.sessions.find(value => value.id === sessionId) ?? (shown()?.active?.id === sessionId ? shown()?.active : null);
    if (!session || session.block_id !== props.id) throw new Error('The work session is no longer available.');
    await props.save(kind === 'stopWork' ? { kind, id: props.id, session, endedAt: Date.now(), note } : { kind, id: props.id, session, note });
    await refetch();
  };
  return <Popup anchor={props.anchor} ready={!!shown() || !!history.error} label="Work sessions" class="outline-capability-popup work-sessions-popup" onDismiss={props.onDismiss}>
    <header class="task-planning-header">
      <p class="task-planning-kicker">Work</p>
      <h2 class="popup-title task-planning-title"><BlockText text={props.text} notebook={props.notebook} interactive={false} /></h2>
    </header>
    <Show when={history.loading && !shown()}><p class="outline-capability-notice" role="status">Loading work sessions…</p></Show>
    <Show when={history.error}><p class="error" role="alert">{String(history.error)} <Button onClick={() => { void refetch(); }}>Retry</Button></p></Show>
    <Show when={shown()}>{value => <WorkSessions sessions={value().sessions} active={value().active?.block_id === props.id ? value().active : null} today={props.notebook.todayDate()}
      disabled={!!history.error} onStart={start} onStop={(id, note) => change('stopWork', id, note)} onEdit={(id, note) => change('workNote', id, note)} />}</Show>
  </Popup>;
}
