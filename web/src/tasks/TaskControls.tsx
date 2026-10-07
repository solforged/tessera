import { Show, createMemo, createSignal } from 'solid-js';
import type { TaskState, TaskStatus } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { DatePicker } from './DatePicker';
import './task-controls.css';

export const statuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
export const statusLabels: Record<TaskStatus, string> = { todo: 'Todo', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
export const statusIcons: Record<TaskStatus, IconName> = { todo: 'select', doing: 'play', waiting: 'more', done: 'check', cancelled: 'close' };
type Priority = TaskState['priority'];
type Repeater = NonNullable<TaskState['repeater']>;
export const priorities: Priority[] = [null, 'high', 'medium', 'low'];
export const priorityLabel = (value: Priority) => value === null ? 'None' : value === 'high' ? 'High' : value === 'medium' ? 'Medium' : 'Low';
const repeatModes: (Repeater['mode'] | null)[] = [null, 'fixed', 'catch_up', 'after_completion'];
const repeatLabels: Record<Repeater['mode'], string> = { fixed: 'Fixed', catch_up: 'Catch up', after_completion: 'After completion' };
const repeatUnits: Repeater['unit'][] = ['day', 'week', 'month', 'year'];
const unitLabels: Record<Repeater['unit'], string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
const maxCount = 4_294_967_295;
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const dateLabel = (date: string | null, time: string | null) => date ? `${date}${time ? ` ${time}` : ''}` : 'None';

export function TaskStatusButton(props: { task: TaskState | null; disabled?: boolean; onChange(status: TaskStatus | null): void | Promise<void> }) {
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<{ status: TaskStatus | null; message: string } | null>(null);
  const blocked = () => !!props.disabled || busy();
  const change = async (status: TaskStatus | null) => {
    if (blocked()) return;
    setBusy(true); setFailure(null);
    try { await props.onChange(status); }
    catch (reason) { setFailure({ status, message: errorMessage(reason) }); }
    finally { setBusy(false); }
  };
  return <span class="task-status-control" aria-busy={busy()}>
    <Button class="task-status-button" data-status={props.task?.status} label={props.task ? `Task status: ${statusLabels[props.task.status]}` : 'Make task'} disabled={blocked()} aria-haspopup="menu" aria-expanded={!!menu()} onClick={event => setMenu({ anchor: event.currentTarget })}>
      <Show when={props.task} fallback="Make task">{task => <Icon name={statusIcons[task().status]} />}</Show>
    </Button>
    <Show keyed when={failure()}>{state => <span class="task-control-error" role="alert">
      <span>{state.status === null ? 'Remove task' : statusLabels[state.status]}: {state.message}</span>
      <Button disabled={blocked()} label={state.status === null ? 'Retry removing task' : `Retry task status: ${statusLabels[state.status]}`} onClick={() => { void change(state.status); }}>Retry</Button>
    </span>}</Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label="Task status" onDismiss={() => setMenu(null)} items={[
      ...statuses.map(status => ({ label: statusLabels[status], icon: props.task?.status === status ? 'check' as const : undefined, disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => { void change(status); } })),
      { label: 'Remove task', danger: true, disabledReason: blocked() ? 'Task is unavailable.' : !props.task ? 'Not a task.' : undefined, action: () => { void change(null); } },
    ]} />}</Show>
  </span>;
}

type TaskPopup = { kind: 'scheduled' | 'deadline' | 'warning' | 'priority' | 'repeat'; anchor: HTMLElement };

export function TaskControls(props: { notebook: NotebookClient; task: TaskState; contextDate: string; disabled?: boolean; onChange(value: TaskState): void | Promise<void> }) {
  const [popup, setPopup] = createSignal<TaskPopup | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<{ priority: Priority; message: string } | null>(null);
  const blocked = () => !!props.disabled || busy();
  const warningLabel = createMemo(() => props.task.warning_days === null ? 'None' : `${props.task.warning_days} days`);
  const repeatDescription = createMemo(() => {
    const value = props.task.repeater;
    return value ? `${repeatLabels[value.mode]} · ${value.every} ${value.unit}${value.every === 1 ? '' : 's'}` : 'None';
  });
  const dismiss = (state: TaskPopup) => { if (!busy() && popup() === state) setPopup(null); };
  const open = (kind: TaskPopup['kind'], anchor: HTMLElement) => { if (!blocked()) setPopup({ kind, anchor }); };
  const change = async (patch: Partial<TaskState>) => {
    if (blocked()) throw new Error('Task is unavailable.');
    setBusy(true);
    try { await props.onChange({ ...props.task, ...patch }); }
    finally { setBusy(false); }
  };
  const changePriority = async (priority: Priority) => {
    if (blocked()) return;
    setFailure(null);
    try { await change({ priority }); }
    catch (reason) { setFailure({ priority, message: errorMessage(reason) }); }
  };
  return <div class="task-controls" role="group" aria-label="Task planning" aria-busy={busy()}>
    <Button class="task-metadata task-planning-row" label={`Scheduled: ${dateLabel(props.task.scheduled, props.task.scheduled_time)}`} disabled={blocked()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'scheduled'} onClick={event => open('scheduled', event.currentTarget)}>
      <span class="task-planning-label">Scheduled</span><span class="task-metadata-value task-planning-value">{dateLabel(props.task.scheduled, props.task.scheduled_time)}</span>
    </Button>
    <Button class="task-metadata task-planning-row" label={`Deadline: ${dateLabel(props.task.deadline, props.task.deadline_time)}`} disabled={blocked()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'deadline'} onClick={event => open('deadline', event.currentTarget)}>
      <span class="task-planning-label">Deadline</span><span class="task-metadata-value task-planning-value">{dateLabel(props.task.deadline, props.task.deadline_time)}</span>
    </Button>
    <Button class="task-metadata task-planning-row" label={`Priority: ${priorityLabel(props.task.priority)}`} disabled={blocked()} aria-haspopup="menu" aria-expanded={popup()?.kind === 'priority'} onClick={event => open('priority', event.currentTarget)}>
      <span class="task-planning-label">Priority</span><span class="task-metadata-value task-planning-value">{priorityLabel(props.task.priority)}</span>
    </Button>
    <Button class="task-metadata task-planning-row" label={`Repeat: ${repeatDescription()}`} disabled={blocked()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'repeat'} onClick={event => open('repeat', event.currentTarget)}>
      <span class="task-planning-label">Repeat</span><span class="task-metadata-value task-planning-value">{repeatDescription()}</span>
    </Button>
    <Show when={props.task.deadline}>
      <Button class="task-metadata task-planning-row" label={`Deadline warning: ${warningLabel()}`} disabled={blocked()} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'warning'} onClick={event => open('warning', event.currentTarget)}>
        <span class="task-planning-label">Warning</span><span class="task-metadata-value task-planning-value">{warningLabel()}</span>
      </Button>
    </Show>
    <Show keyed when={failure()}>{state => <span class="task-control-error" role="alert">
      <span>Priority: {priorityLabel(state.priority)} · {state.message}</span>
      <Button disabled={blocked()} label={`Retry priority: ${priorityLabel(state.priority)}`} onClick={() => { void changePriority(state.priority); }}>Retry</Button>
    </span>}</Show>
    <Show keyed when={popup()}>{state => <>
      {(state.kind === 'scheduled' || state.kind === 'deadline') && <DatePicker notebook={props.notebook} anchor={state.anchor} label={state.kind === 'scheduled' ? 'Scheduled' : 'Deadline'} value={props.task[state.kind]} time={state.kind === 'scheduled' ? props.task.scheduled_time : props.task.deadline_time} contextDate={props.contextDate}
        marks={state.kind === 'scheduled' ? props.task.deadline ? { [props.task.deadline]: 'Deadline' } : undefined : props.task.scheduled ? { [props.task.scheduled]: 'Scheduled' } : undefined} onDismiss={() => dismiss(state)} onSelect={async value => {
        if (state.kind === 'scheduled') await change({ scheduled: value.date, scheduled_time: value.date ? value.time : null });
        else await change({ deadline: value.date, deadline_time: value.date ? value.time : null, warning_days: value.date ? props.task.warning_days : null });
      }} />}
      {state.kind === 'priority' && <Menu anchor={state.anchor} label="Priority" onDismiss={() => dismiss(state)} items={priorities.map(priority => ({ label: priorityLabel(priority), icon: props.task.priority === priority ? 'check' : undefined, disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => { void changePriority(priority); } }))} />}
      {state.kind === 'warning' && <WarningPopup anchor={state.anchor} value={props.task.warning_days} disabled={blocked() || !props.task.deadline} onDismiss={() => dismiss(state)} onSave={warning_days => change({ warning_days })} />}
      {state.kind === 'repeat' && <RepeatPopup anchor={state.anchor} value={props.task.repeater} disabled={blocked()} onDismiss={() => dismiss(state)} onSave={repeater => change({ repeater })} />}
    </>}</Show>
  </div>;
}

function WarningPopup(props: { anchor: PopupAnchor; value: number | null; disabled: boolean; onDismiss(): void; onSave(value: number | null): Promise<void> }) {
  const [days, setDays] = createSignal(props.value === null ? '' : String(props.value));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const blocked = () => props.disabled || busy();
  const submit = async () => {
    if (blocked()) return;
    const text = days().trim();
    const value = text ? Number(text) : null;
    if (value !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value > maxCount)) { setError('Enter a nonnegative whole number of days, or leave blank for None.'); return; }
    setBusy(true); setError('');
    try { await props.onSave(value); setBusy(false); props.onDismiss(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  return <Popup anchor={props.anchor} label="Deadline warning" class="task-control-popup" fitContent onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <form class="task-control-form" aria-busy={busy()} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label class="task-control-field">Warning lead (days)<input class="input" inputmode="numeric" value={days()} disabled={blocked()} placeholder="None" onInput={event => setDays(event.currentTarget.value)} /></label>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={blocked()} onClick={() => { setDays(''); void submit(); }}>Clear</Button><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={blocked()}>Apply</Button></div>
    </form>
  </Popup>;
}

export function RepeatPopup(props: { anchor: PopupAnchor; value: TaskState['repeater']; disabled: boolean; onDismiss(): void; onSave(value: TaskState['repeater']): Promise<void> }) {
  const [mode, setMode] = createSignal<Repeater['mode'] | null>(props.value?.mode ?? null);
  const [every, setEvery] = createSignal(String(props.value?.every ?? 1));
  const [unit, setUnit] = createSignal<Repeater['unit']>(props.value?.unit ?? 'day');
  const [menu, setMenu] = createSignal<{ kind: 'mode' | 'unit'; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const blocked = () => props.disabled || busy();
  const modeLabel = createMemo(() => { const value = mode(); return value === null ? 'None' : repeatLabels[value]; });
  const submit = async () => {
    if (blocked()) return;
    const selectedMode = mode();
    const text = every().trim();
    const interval = Number(text);
    if (selectedMode !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(interval) || interval < 1 || interval > maxCount)) { setError('Enter a positive whole-number interval.'); return; }
    const value = selectedMode === null ? null : { mode: selectedMode, every: interval, unit: unit() };
    setBusy(true); setError('');
    try { await props.onSave(value); setBusy(false); props.onDismiss(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  return <Popup anchor={props.anchor} label="Repeat" class="task-control-popup" fitContent onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <form class="task-control-form" aria-busy={busy()} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label class="task-control-field">Mode<Button class="bordered" label={`Repeat mode: ${modeLabel()}`} disabled={blocked()} aria-haspopup="menu" aria-expanded={menu()?.kind === 'mode'} onClick={event => setMenu({ kind: 'mode', anchor: event.currentTarget })}>{modeLabel()}</Button></label>
      <Show when={mode() !== null}><div class="task-repeat-interval">
        <label class="task-control-field">Every<input class="input" inputmode="numeric" value={every()} disabled={blocked()} onInput={event => setEvery(event.currentTarget.value)} /></label>
        <label class="task-control-field">Unit<Button class="bordered" label={`Repeat unit: ${unitLabels[unit()]}`} disabled={blocked()} aria-haspopup="menu" aria-expanded={menu()?.kind === 'unit'} onClick={event => setMenu({ kind: 'unit', anchor: event.currentTarget })}>{unitLabels[unit()]}</Button></label>
      </div></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={blocked()}>Apply</Button></div>
    </form>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.kind === 'mode' ? 'Repeat mode' : 'Repeat unit'} onDismiss={() => setMenu(null)} items={state.kind === 'mode'
      ? repeatModes.map(value => ({ label: value === null ? 'None' : repeatLabels[value], icon: value === mode() ? 'check' : undefined, disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => setMode(value) }))
      : repeatUnits.map(value => ({ label: unitLabels[value], icon: value === unit() ? 'check' : undefined, disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => setUnit(value) }))} />}</Show>
  </Popup>;
}
