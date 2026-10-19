import { Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { TaskState, TaskStatus } from '../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import './task-controls.css';

export const statuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
export const statusLabels: Record<TaskStatus, string> = { todo: 'Todo', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
export const statusIcons: Record<TaskStatus, IconName> = { todo: 'select', doing: 'play', waiting: 'waiting', done: 'check', cancelled: 'close' };
/** Every status with its glyph, the current one checked, then Remove task. */
export function statusMenuItems(task: TaskState | null | undefined, choose: (status: TaskStatus | null) => void, disabledReason?: string): MenuItem[] {
  if (task?.status === null) return [];
  return [
    ...statuses.map((status): MenuItem => ({ label: statusLabels[status], icon: statusIcons[status], checked: task?.status === status, disabledReason, action: () => choose(status) })),
    ...(task ? [{ label: 'Remove task', icon: 'close' as const, danger: true, disabledReason, action: () => choose(null) }] : []),
  ];
}
type Priority = TaskState['priority'];
type Repeater = NonNullable<TaskState['repeater']>;
export const priorities: Priority[] = [null, 'high', 'medium', 'low'];
export const priorityLabel = (value: Priority) => value === null ? 'None' : value === 'high' ? 'High' : value === 'medium' ? 'Medium' : 'Low';
/** The same checked priority choices in field beds and task lists. */
export function priorityMenuItems(value: Priority, choose: (priority: Priority) => void, disabledReason?: string): MenuItem[] {
  return priorities.map(priority => ({ label: priorityLabel(priority), checked: value === priority, disabledReason, action: () => choose(priority) }));
}
const repeatModes: (Repeater['mode'] | null)[] = [null, 'fixed', 'catch_up', 'after_completion'];
const repeatLabels: Record<Repeater['mode'], string> = { fixed: 'Fixed', catch_up: 'Catch up', after_completion: 'After completion' };
const repeatUnits: Repeater['unit'][] = ['day', 'week', 'month', 'year'];
const unitLabels: Record<Repeater['unit'], string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
const maxCount = 4_294_967_295;
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** The task glyph. A click completes or reopens; the context menu or ⌘⇧Enter chooses any status. */
export function TaskStatusButton(props: { task: TaskState | null; disabled?: boolean; onRestoreFocus?(): void; onChange(status: TaskStatus | null): void | Promise<void> }) {
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<{ status: TaskStatus | null; message: string } | null>(null);
  let control!: HTMLSpanElement;
  // Only a change seen while mounted pops the glyph; rows scrolled into view stay still.
  createEffect(on(() => props.task?.status, status => {
    if (status !== 'done' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    queueMicrotask(() => control.querySelector('.task-status-button .icon')?.animate([{ scale: 0.4, opacity: 0.4 }, { scale: 1.15 }, { scale: 1, opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' }));
  }, { defer: true }));
  const blocked = () => !!props.disabled || busy();
  const change = async (status: TaskStatus | null) => {
    if (blocked()) return;
    props.onRestoreFocus?.();
    setBusy(true); setFailure(null);
    try { await props.onChange(status); }
    catch (reason) { setFailure({ status, message: errorMessage(reason) }); }
    finally { setBusy(false); }
  };
  const finished = () => props.task?.status === 'done' || props.task?.status === 'cancelled';
  const label = () => props.task?.status ? `${finished() ? 'Reopen' : 'Complete'} task (${statusLabels[props.task.status]})` : 'Make task';
  return <Show when={props.task?.status !== null}><span ref={control} class="task-status-control" aria-busy={busy()}>
    <Button class="task-status-button" data-status={props.task?.status} label={label()} title={`${label()} · right-click for status`} disabled={blocked()} aria-expanded={menu() ? true : undefined}
      onClick={() => { void change(!props.task || finished() ? 'todo' : 'done'); }}
      onContextMenu={event => { event.preventDefault(); if (!blocked()) setMenu({ anchor: event.currentTarget }); }}>
      <Show when={props.task?.status} fallback="Make task">{status => <Icon name={statusIcons[status()]} />}</Show>
    </Button>
    <Show keyed when={failure()}>{state => <span class="task-control-error" role="alert">
      <span>{state.status === null ? 'Remove task' : statusLabels[state.status]}: {state.message}</span>
      <Button disabled={blocked()} label={state.status === null ? 'Retry removing task' : `Retry task status: ${statusLabels[state.status]}`} onClick={() => { void change(state.status); }}>Retry</Button>
    </span>}</Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label="Task status" onDismiss={() => { setMenu(null); props.onRestoreFocus?.(); }} items={statusMenuItems(props.task, status => { void change(status); }, blocked() ? 'Task is unavailable.' : undefined)} />}</Show>
  </span></Show>;
}


const repeatHints: Record<Repeater['mode'], string> = {
  fixed: 'Moves one interval from the planned date, even if that is still past.',
  catch_up: 'Moves by whole intervals until the next date is after completion.',
  after_completion: 'Counts one interval from the day you complete it.',
};

/** `firstDate` is set when the task has no date yet; applying a repeat schedules it then. */
export function RepeatPopup(props: { anchor: PopupAnchor; value: TaskState['repeater']; firstDate?: string; disabled: boolean; onDismiss(): void; onSave(value: TaskState['repeater']): Promise<void> }) {
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
      <Show when={mode()}>{value => <p class="task-control-note">{repeatHints[value()]}</p>}</Show>
      <Show when={mode() !== null}><div class="task-repeat-interval">
        <label class="task-control-field">Every<input class="input" inputmode="numeric" value={every()} disabled={blocked()} onInput={event => setEvery(event.currentTarget.value)} /></label>
        <label class="task-control-field">Unit<Button class="bordered" label={`Repeat unit: ${unitLabels[unit()]}`} disabled={blocked()} aria-haspopup="menu" aria-expanded={menu()?.kind === 'unit'} onClick={event => setMenu({ kind: 'unit', anchor: event.currentTarget })}>{unitLabels[unit()]}</Button></label>
      </div></Show>
      <Show when={mode() !== null && props.firstDate}>{date => <p class="task-control-note">A repeat counts from a date, so this schedules the task for <span class="task-control-date">{date()}</span>.</p>}</Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={blocked()}>Apply</Button></div>
    </form>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.kind === 'mode' ? 'Repeat mode' : 'Repeat unit'} onDismiss={() => setMenu(null)} items={state.kind === 'mode'
      ? repeatModes.map(value => ({ label: value === null ? 'None' : repeatLabels[value], checked: value === mode(), disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => setMode(value) }))
      : repeatUnits.map(value => ({ label: unitLabels[value], checked: value === unit(), disabledReason: blocked() ? 'Task is unavailable.' : undefined, action: () => setUnit(value) }))} />}</Show>
  </Popup>;
}
