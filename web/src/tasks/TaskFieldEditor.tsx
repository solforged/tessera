import { Match, Show, Switch } from 'solid-js';
import type { TaskState, TaskStatus } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { createOutlineCapabilities } from '../outline/capabilities';
import { TaskProjectPicker } from '../projects/TaskProjectControl';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';
import { Popup, type PopupAnchor } from '../ui/Popup';
import { DatePicker } from './DatePicker';
import { RepeatPopup, priorityMenuItems, statusMenuItems } from './TaskControls';
import { planTask } from './task-labels';
import { newTask } from './quick-date';
import { taskFieldLabel, type TaskFieldName } from './task-fields';

/** One editor for task-backed bed rows and table cells, using the document's undoable commands. */
export function TaskFieldEditor(props: {
  notebook: NotebookClient; doc: PageDocument; id: string; field: TaskFieldName; anchor: PopupAnchor;
  contextDate: string; onDismiss(): void; onSaved?(): void | Promise<void>;
}) {
  const capabilities = createOutlineCapabilities({ doc: props.doc, notebook: props.notebook, contextDate: () => props.contextDate, caret: () => null, anchor: () => props.anchor, onOpen: () => {} });
  const task = () => props.doc.block(props.id)?.task ?? newTask();
  const change = async (patch: Partial<TaskState>) => {
    await capabilities.edit(props.id, { kind: 'task', id: props.id, value: planTask(task(), patch, props.contextDate) });
    await props.onSaved?.();
  };
  const status = async (value: TaskStatus | null) => {
    if (value === task().status) { props.onDismiss(); return; }
    await capabilities.status(props.id, value);
    if (capabilities.popup()?.kind !== 'complete') { await props.onSaved?.(); props.onDismiss(); }
  };
  return <Show when={capabilities.popup()?.kind === 'complete' ? capabilities.popup() : undefined} fallback={<>
    <Switch>
      <Match when={props.field === 'status'}><Menu anchor={props.anchor} label="Status" closeOnSelect={false} header={<Show when={capabilities.error(props.id)}><p class="error" role="alert">{capabilities.error(props.id)}</p></Show>} onDismiss={() => { if (!capabilities.busy(props.id)) props.onDismiss(); }} items={statusMenuItems(task().status === null ? undefined : task(), value => capabilities.invoke(status(value)), capabilities.busy(props.id) ? 'Saving…' : undefined)} /></Match>
      <Match when={props.field === 'scheduled' || props.field === 'deadline'}>
        <DatePicker anchor={props.anchor} notebook={props.notebook} label={taskFieldLabel(props.field)} value={props.field === 'scheduled' ? task().scheduled : task().deadline} time={props.field === 'scheduled' ? task().scheduled_time : task().deadline_time} warningDays={props.field === 'deadline' ? task().warning_days : undefined} contextDate={props.contextDate} onDismiss={props.onDismiss} onSelect={value => change(props.field === 'scheduled' ? { scheduled: value.date, scheduled_time: value.time } : { deadline: value.date, deadline_time: value.time, warning_days: value.warning_days ?? null })} />
      </Match>
      <Match when={props.field === 'priority'}><Menu anchor={props.anchor} label="Priority" closeOnSelect={false} header={<Show when={capabilities.error(props.id)}><p class="error" role="alert">{capabilities.error(props.id)}</p></Show>} onDismiss={props.onDismiss} items={priorityMenuItems(task().priority, value => capabilities.invoke(change({ priority: value }).then(props.onDismiss)), capabilities.busy(props.id) ? 'Saving…' : undefined)} /></Match>
      <Match when={props.field === 'repeat'}><RepeatPopup anchor={props.anchor} value={task().repeater} firstDate={task().scheduled || task().deadline ? undefined : props.contextDate} disabled={capabilities.busy(props.id)} onDismiss={props.onDismiss} onSave={repeater => change({ repeater })} /></Match>
      <Match when={props.field === 'project'}><TaskProjectPicker notebook={props.notebook} doc={props.doc} id={props.id} anchor={props.anchor} onSaved={props.onSaved} onDismiss={props.onDismiss} /></Match>
    </Switch>
  </>}>{state => <Popup anchor={props.anchor} label="Stop work and complete?" onDismiss={props.onDismiss}>
    <p>Stop work and complete?</p><Button class="bordered" disabled={capabilities.busy(props.id)} onClick={() => { const value = state(); if (value?.kind === 'complete') capabilities.invoke(capabilities.complete(value).then(async () => { await props.onSaved?.(); props.onDismiss(); })); }}>Stop and complete</Button>
    <Show when={capabilities.error(props.id)}><p class="error" role="alert">{capabilities.error(props.id)}</p></Show>
  </Popup>}</Show>;
}
