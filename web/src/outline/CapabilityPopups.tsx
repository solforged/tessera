import { Show, createEffect, createResource, createSignal } from 'solid-js';
import type { Block, WorkSession } from '../api/types';
import { ProjectControls } from '../projects/ProjectControls';
import { DatePicker } from '../tasks/DatePicker';
import { RepeatPopup, TaskControls } from '../tasks/TaskControls';
import { WorkSessions } from '../tasks/WorkSessions';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockText } from './BlockText';
import type { CapabilityPopup } from './capabilities';
import type { OutlineContext } from './context';

interface WorkHistory { sessions: WorkSession[]; active: WorkSession | null; source: Block | null }
export function createCapabilityPopups(context: Pick<OutlineContext, 'doc' | 'props' | 'capabilities' | 'contextDate'>) {
  const { doc, props, capabilities, contextDate } = context;
  function WorkPopup(propsWork: { state: CapabilityPopup }) {
    const state = propsWork.state;
    const load = async () => {
      await doc.flush();
      const [sessions, active] = await Promise.all([props.notebook.api.workSessions(state.id), props.notebook.api.activeWorkSession()]);
      const source = active ? await props.notebook.api.block(active.block_id) : null;
      return { sessions, active, source };
    };
    const [history, { refetch, mutate }] = createResource(() => props.notebook.changeSequence(), load);
    const [shown, setShown] = createSignal<WorkHistory>();
    createEffect(() => { if (!history.error) { const value = history(); if (value) setShown(value); } });
    const another = () => shown()?.active && shown()!.active!.block_id !== state.id;
    async function start() {
      const startedAt = Date.now();
      await capabilities.run(state.id, async () => {
        const current = await load();
        mutate(current);
        if (current.active) throw new Error(current.active.block_id === state.id ? 'Work is already running on this task.' : 'Work is already running on another task.');
        await capabilities.save({ kind: 'startWork', id: state.id, startedAt });
        await refetch();
      });
    }
    async function change(kind: 'stopWork' | 'workNote', sessionId: string, note: string) {
      const session = shown()?.sessions.find(session => session.id === sessionId) ?? (shown()?.active?.id === sessionId ? shown()?.active : null);
      if (!session || session.block_id !== state.id) throw new Error('The work session is no longer available.');
      await capabilities.edit(state.id, kind === 'stopWork'
        ? { kind, id: state.id, session, endedAt: Date.now(), note }
        : { kind, id: state.id, session, note });
      await refetch();
    }
    return <Popup anchor={state.anchor} label="Work sessions" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
      <Show when={history.loading}><p class="outline-capability-notice" role="status">Loading work sessions…</p></Show>
      <Show when={history.error}><p class="error" role="alert">{String(history.error)} <Button onClick={() => { void refetch(); }}>Retry</Button></p></Show>
      <Show when={another() && shown()?.source}>{source => <div class="outline-running-task">
        <span>Work is running on</span>
        <BlockText text={source().text} notebook={props.notebook} onOpen={props.onOpen} />
        <Button onClick={event => props.onOpen({ kind: 'page', pageId: source().page_id, blockId: source().id }, event.shiftKey)}>Open running task</Button>
      </div>}</Show>
      <Show when={shown()}>{value => <WorkSessions sessions={value().sessions} active={value().active?.block_id === state.id ? value().active : null}
        disabled={history.loading || !!history.error || capabilities.busy(state.id)}
        onStart={start} onStop={(id, note) => change('stopWork', id, note)} onEdit={(id, note) => change('workNote', id, note)} />}</Show>
      <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
    </Popup>;
  }
function CapabilityPopups(){ return <>
    <Show keyed when={capabilities.popup()}>{state => <>
      {state.kind === 'task' && <Popup anchor={state.anchor} label="Task" class="outline-capability-popup task-planning-slip" fitContent onDismiss={() => capabilities.dismiss(state)}>
        <header class="task-planning-header">
          <p class="task-planning-kicker">Planning</p>
          <h2 class="popup-title task-planning-title"><BlockText text={doc.block(state.id)?.text ?? ''} notebook={props.notebook} interactive={false} /></h2>
        </header>
        <Show when={doc.block(state.id)?.task} fallback={<p class="outline-capability-notice">Task removed.</p>}>{task => <TaskControls notebook={props.notebook} task={task()} contextDate={contextDate()} disabled={capabilities.busy(state.id)} onChange={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value })} />}</Show>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
      {state.kind === 'review-date' && <Show when={doc.block(state.id)?.question}>{question => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Set review date" value={question().state.review_on} contextDate={props.notebook.todayDate()} onDismiss={() => capabilities.dismiss(state)}
        onSelect={value => capabilities.edit(state.id, { kind: 'question', id: state.id, value: { ...question().state, review_on: value.date } })} />}</Show>}
      {state.kind === 'schedule' && <Show when={doc.block(state.id)?.task}>{task => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Schedule task" value={task().scheduled} time={task().scheduled_time} contextDate={contextDate()} marks={task().deadline ? { [task().deadline!]: 'Deadline' } : undefined} onDismiss={() => capabilities.dismiss(state)}
        onSelect={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), scheduled: value.date, scheduled_time: value.date ? value.time : null } })} />}</Show>}
      {state.kind === 'deadline' && <Show when={doc.block(state.id)?.task}>{task => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Deadline" value={task().deadline} time={task().deadline_time} contextDate={contextDate()} marks={task().scheduled ? { [task().scheduled!]: 'Scheduled' } : undefined} onDismiss={() => capabilities.dismiss(state)}
        onSelect={value => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), deadline: value.date, deadline_time: value.date ? value.time : null, warning_days: value.date ? task().warning_days : null } })} />}</Show>}
      {state.kind === 'repeat' && <Show when={doc.block(state.id)?.task}>{task => <RepeatPopup anchor={state.anchor} value={task().repeater} disabled={capabilities.busy(state.id)} onDismiss={() => capabilities.dismiss(state)}
        onSave={repeater => capabilities.edit(state.id, { kind: 'task', id: state.id, value: { ...task(), repeater } })} />}</Show>}
      {state.kind === 'project' && <Popup anchor={state.anchor} label="Project" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
        <ProjectControls notebook={props.notebook} project={doc.block(state.id)?.project ?? null} contextDate={contextDate()} disabled={capabilities.busy(state.id)} onChange={value => capabilities.edit(state.id, { kind: 'project', id: state.id, value })} />
        <Show when={doc.block(state.id)?.project}><Button onClick={event => capabilities.showActions(state.id, event.shiftKey)}>Show actions</Button></Show>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
      {state.kind === 'work' && <WorkPopup state={state} />}
      {state.kind === 'complete' && <Popup anchor={state.anchor} label="Stop work and complete?" class="outline-capability-popup" onDismiss={() => capabilities.dismiss(state)}>
        <p>Stop work and complete?</p>
        <div class="outline-capability-actions"><Button class="bordered" disabled={capabilities.busy(state.id)} onClick={() => capabilities.invoke(capabilities.complete(state))}>Stop and complete</Button><Button onClick={() => capabilities.dismiss(state)}>Cancel</Button></div>
        <Show when={capabilities.busy(state.id)}><p class="outline-capability-notice" role="status">Saving…</p></Show>
        <Show when={capabilities.error(state.id)}><p class="error" role="alert">{capabilities.error(state.id)}</p></Show>
      </Popup>}
    </>}</Show>
</>; }
  return { CapabilityPopups };
}
