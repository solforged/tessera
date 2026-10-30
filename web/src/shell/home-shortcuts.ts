import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';

/** The iOS app's Home Screen quick actions (Info.plist `UIApplicationShortcutItems`). */
export type HomeShortcut = 'capture' | 'today' | 'review' | 'library';
const shortcuts: readonly HomeShortcut[] = ['capture', 'today', 'review', 'library'];

type ShortcutMessage = 'take' | { keyboard: [number, number, number, number] };
interface ShortcutBridge {
  webkit?: { messageHandlers?: { tesseraShortcut?: { postMessage(message: ShortcutMessage): Promise<unknown> } } };
}

/** Gives up on the capture's editor after this long. */
const KEYBOARD_WAIT_MS = 5000;
/** The editor counts as placed once its rect holds still for this many frames, after the sheet's entrance. */
const STILL_FRAMES = 3;

const editable = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && (element.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement);

/**
 * Runs `run` for each quick action once the shell has restored its navigation. The iOS app keeps the chosen action
 * until the page takes it: a cold launch chooses it before the page loads, and a running app also fires
 * `tessera-shortcut`. Elsewhere there is no handler and nothing happens.
 *
 * WebKit shows the keyboard for a focus only while the person touches the page, so after a capture the page tells
 * the app where its focused editor settled, and the app focuses it again as a touch would.
 */
export function installHomeShortcuts(ready: Accessor<boolean>, run: (shortcut: HomeShortcut) => void): void {
  const handler = (window as unknown as ShortcutBridge).webkit?.messageHandlers?.tesseraShortcut;
  if (!handler) return;
  const [requested, setRequested] = createSignal<HomeShortcut | null>(null);
  let frame = 0;
  const stopWaiting = () => { cancelAnimationFrame(frame); frame = 0; };
  const raiseKeyboard = () => {
    stopWaiting();
    const until = performance.now() + KEYBOARD_WAIT_MS;
    let last = '', still = 0;
    const check = () => {
      frame = 0;
      if (performance.now() > until) return;
      const focused = document.activeElement;
      if (editable(focused)) {
        const rect = focused.getBoundingClientRect();
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        still = key === last ? still + 1 : 0;
        last = key;
        if (still >= STILL_FRAMES) {
          void handler.postMessage({ keyboard: [rect.x, rect.y, rect.width, rect.height] }).catch(() => { /* The editor stays focused without the keyboard. */ });
          return;
        }
      } else { last = ''; still = 0; }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  };
  const take = () => {
    void handler.postMessage('take').then(value => {
      if (shortcuts.includes(value as HomeShortcut)) setRequested(value as HomeShortcut);
    }, () => { /* A page without the native handler has no quick actions. */ });
  };
  createEffect(() => {
    const shortcut = requested();
    if (!shortcut || !ready()) return;
    setRequested(null);
    run(shortcut);
    if (shortcut === 'capture') raiseKeyboard();
  });
  const visible = () => { if (document.visibilityState === 'visible') take(); };
  onMount(() => {
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('tessera-shortcut', take);
    take();
  });
  onCleanup(() => {
    stopWaiting();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('tessera-shortcut', take);
  });
}
