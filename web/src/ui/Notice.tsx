import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { createRetained } from '../shell/retained';
import { Button } from './Button';
import type { IconName } from './Icon';
import './overlays.css';

/** One button on a notice, and what it does. */
export interface NoticeAction {
  label: string;
  icon?: IconName;
  run(): void | Promise<void>;
}

/** The notice's markup, shared by `showNotice` and by a surface that keeps its own notice state (the outline's per-pane notice).
 * On a phone the stylesheet draws it as one glass capsule above the tab bar; elsewhere it is the toast at the window's foot. */
export function NoticeView(props: {
  text: JSX.Element;
  actions?: NoticeAction[];
  /** An action is running: its buttons are held shut. */
  busy?: boolean;
  /** The exit animation is playing. */
  leaving?: boolean;
  /** The accessible name of the close cross; without it the notice has no cross. A phone notice with actions hides the cross. */
  dismissLabel?: string;
  onAction(action: NoticeAction): void;
  onDismiss?(): void;
  /** The pointer or focus is on the notice, so it should wait; false when both have left. */
  onHold(held: boolean): void;
  class?: string;
}) {
  return <div class={`undo-toast notice${props.actions?.length ? ' notice-actionable' : ''} ${props.class ?? ''}`} classList={{ leaving: props.leaving }} inert={props.leaving} role="status"
    onPointerEnter={() => props.onHold(true)} onPointerLeave={() => props.onHold(false)} onFocusIn={() => props.onHold(true)}
    onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onHold(false); }}>
    <span class="notice-text">{props.text}</span>
    <For each={props.actions}>{action => <Button class="notice-action" icon={action.icon} disabled={props.busy} onClick={() => props.onAction(action)}>{action.label}</Button>}</For>
    <Show when={props.dismissLabel}>{label => <Button class="notice-dismiss" icon="close" label={label()} disabled={props.busy} onClick={() => props.onDismiss?.()} />}</Show>
  </div>;
}

export interface NoticeOptions {
  /** What happened, in a sentence; markup may bold the one thing that matters ("Moved to <b>Friday</b>"). */
  text: JSX.Element;
  /** What can be done about it, usually Undo. A button runs its action, is held shut while it runs, and closes the notice when
   * it succeeds. A failure leaves the notice up and goes to `onError`. */
  action?: NoticeAction | NoticeAction[];
  /** How long the notice waits, in milliseconds, with nothing resting on it. Default 8000. */
  duration?: number;
  /** Where a failed action's error goes; without it the error is reported as an uncaught one. */
  onError?(reason: unknown): void;
}

interface Live { options: NoticeOptions; actions: NoticeAction[] }
const DURATION = 8000;
const [current, setCurrent] = createSignal<Live>();
const [held, setHeld] = createSignal(false);
const [busy, setBusy] = createSignal(false);
let mounted = false;

async function run(live: Live, action: NoticeAction) {
  if (busy()) return;
  setBusy(true);
  try { await action.run(); if (current() === live) setCurrent(undefined); }
  catch (reason) { if (live.options.onError) live.options.onError(reason); else reportError(reason); }
  finally { setBusy(false); }
}

function NoticeHost() {
  // The notice stays mounted through its exit animation.
  const shown = createRetained(current);
  createEffect(() => {
    const live = current();
    if (!live || held()) return;
    const timer = setTimeout(() => setCurrent(value => value === live ? undefined : value), live.options.duration ?? DURATION);
    onCleanup(() => clearTimeout(timer));
  });
  return <Show when={shown()}>{item => <NoticeView text={item().value.options.text} actions={item().value.actions} busy={busy()} leaving={item().leaving} dismissLabel="Dismiss notification"
    onAction={action => void run(item().value, action)} onDismiss={() => setCurrent(undefined)} onHold={value => setHeld(value)} />}</Show>;
}

/** Shows a notice: a short statement with the action that takes it back. One at a time: a newer notice replaces the one up. On a
 * phone it is the glass capsule above the tab bar; elsewhere the toast at the window's foot. Returns a function that closes
 * this notice if it is still the one showing. */
export function showNotice(options: NoticeOptions): () => void {
  if (!mounted) {
    mounted = true;
    // Inside the app, so the stylesheet's phone variables (the tab bar's height) reach it; `contents` keeps the host out of the grid.
    const host = document.createElement('div');
    host.style.display = 'contents';
    (document.querySelector('.app') ?? document.body).append(host);
    render(() => <NoticeHost />, host);
  }
  const live: Live = { options, actions: options.action === undefined ? [] : Array.isArray(options.action) ? options.action : [options.action] };
  setHeld(false);
  setCurrent(live);
  return () => setCurrent(value => value === live ? undefined : value);
}

/** Closes whichever notice is showing. */
export function dismissNotice(): void {
  setCurrent(undefined);
}
