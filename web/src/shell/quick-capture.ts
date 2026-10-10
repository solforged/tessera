import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';

export interface QuickCaptureSource {
  /** Returns whether a capture was requested, and clears the request. */
  take(): boolean;
  /** Raises the on-screen keyboard where focusing an editor from script does not. */
  showKeyboard?(): void;
}

let source: QuickCaptureSource | undefined;

/** Android's launcher shortcut leaves a request in the activity; the shell takes it once. */
export function setQuickCaptureSource(next: QuickCaptureSource): void {
  source = next;
}

/** Waits this long for the capture's editor to take focus before giving up on the keyboard. */
const KEYBOARD_WAIT_MS = 5000;

/** Runs `capture` for each launcher request, after the shell has restored its navigation. */
export function installQuickCapture(ready: Accessor<boolean>, capture: () => void): void {
  const [requested, setRequested] = createSignal(false);
  let stopWaiting: (() => void) | undefined;
  const take = () => { if (source?.take()) setRequested(true); };
  const raiseKeyboardOnEditor = () => {
    const show = source?.showKeyboard;
    if (!show) return;
    stopWaiting?.();
    const focused = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.isContentEditable) return;
      stopWaiting?.();
      show();
    };
    const timer = window.setTimeout(() => stopWaiting?.(), KEYBOARD_WAIT_MS);
    document.addEventListener('focusin', focused);
    stopWaiting = () => { clearTimeout(timer); document.removeEventListener('focusin', focused); stopWaiting = undefined; };
  };
  createEffect(() => {
    if (!requested() || !ready()) return;
    setRequested(false);
    raiseKeyboardOnEditor();
    capture();
  });
  const visible = () => { if (document.visibilityState === 'visible') take(); };
  onMount(() => {
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('tessera-quick-capture', take);
    take();
  });
  onCleanup(() => {
    stopWaiting?.();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('tessera-quick-capture', take);
  });
}
