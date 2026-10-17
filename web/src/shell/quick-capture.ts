import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import { blankCapture, parseCreateRequest } from '../create/request';
import type { CreateRequest } from '../create/request';

export interface QuickCaptureSource {
  /** The pending request, cleared by taking it; null when none. */
  take(): CreateRequest | null;
  /** Raises the on-screen keyboard where focusing an editor from script does not. */
  showKeyboard?(): void;
}

let source: QuickCaptureSource | undefined;

/** Android's launcher shortcuts, share sheet, widget and tile leave a request in the activity; the shell takes it once. */
export function setQuickCaptureSource(next: QuickCaptureSource): void {
  source = next;
}

/** Waits this long for the capture's editor to take focus before giving up on the keyboard. */
const KEYBOARD_WAIT_MS = 5000;

/**
 * Runs `capture` for each request once the shell has restored its navigation. Requests come from the native source
 * (Android), or from a `tessera-quick-capture` event whose detail, when given, is the request (the desktop menu and
 * global shortcut).
 */
export function installQuickCapture(ready: Accessor<boolean>, capture: (request: CreateRequest) => void): void {
  const [requested, setRequested] = createSignal<CreateRequest | null>(null);
  let stopWaiting: (() => void) | undefined;
  const take = () => { const request = source?.take(); if (request) setRequested(request); };
  const event = (event: Event) => {
    if (source) { take(); return; }
    const detail = (event as CustomEvent<unknown>).detail;
    setRequested(detail ? parseCreateRequest(detail) ?? blankCapture() : blankCapture());
  };
  const raiseKeyboardOnEditor = () => {
    const show = source?.showKeyboard;
    if (!show) return;
    stopWaiting?.();
    const focused = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || !(event.target.isContentEditable || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
      stopWaiting?.();
      show();
    };
    const timer = window.setTimeout(() => stopWaiting?.(), KEYBOARD_WAIT_MS);
    document.addEventListener('focusin', focused);
    stopWaiting = () => { clearTimeout(timer); document.removeEventListener('focusin', focused); stopWaiting = undefined; };
  };
  createEffect(() => {
    const request = requested();
    if (!request || !ready()) return;
    setRequested(null);
    raiseKeyboardOnEditor();
    capture(request);
  });
  const visible = () => { if (document.visibilityState === 'visible') take(); };
  onMount(() => {
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('tessera-quick-capture', event);
    take();
  });
  onCleanup(() => {
    stopWaiting?.();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('tessera-quick-capture', event);
  });
}
