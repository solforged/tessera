import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { createNotebookClient } from '../document';
import type { NotebookInfo } from '../api/types';
import { blankCapture, parseCreateRequest } from '../create/request';
import { CreateSlipBody } from '../create/CreateSlip';

type CaptureWindow = Window & {
  __tesseraCaptureDone?: () => void;
  __tesseraCaptureSize?: (height: number) => void;
  __tesseraCaptureOpen?: (target: string) => void;
};

/**
 * `?capture`: the desktop's global capture panel. It stays loaded while hidden, so a draft survives clicking away;
 * each `tessera-quick-capture` event from the shell focuses it again.
 */
export function CaptureWindow() {
  const identityKey = `tessera.identity.${location.origin}`;
  let cachedIdentity: NotebookInfo | undefined;
  try { cachedIdentity = JSON.parse(localStorage.getItem(identityKey) ?? 'null') ?? undefined; } catch { /* The panel works without a cached identity. */ }
  const notebook = createNotebookClient({ notebookId: cachedIdentity?.id });
  onCleanup(() => { void notebook.dispose(); });
  const [request, setRequest] = createSignal(blankCapture());
  let body!: HTMLDivElement;
  let fontsReady = false;
  let lastHeight = 0;
  const panel = window as CaptureWindow;
  const reportSize = (force = false) => {
    if (!fontsReady || !panel.__tesseraCaptureSize) return;
    const choices = document.querySelector<HTMLElement>('.popup.capture-choices');
    const list = choices?.querySelector<HTMLElement>('.picker-list');
    // Completions live in a portal, outside the sheet's natural height. Reserve
    // their full height below the line, then let the native cap bound the list.
    const line = body.querySelector<HTMLElement>('.capture-line');
    const gap = Number.parseFloat(getComputedStyle(body).getPropertyValue('--space-4')) || 0;
    const choicesBottom = choices && list && line
      ? line.getBoundingClientRect().bottom + gap + list.scrollHeight + choices.offsetHeight - choices.clientHeight + gap * 3
      : 0;
    const height = Math.ceil(Math.max(body.getBoundingClientRect().height, choicesBottom));
    if (height > 0 && (force || height !== lastHeight)) {
      lastHeight = height;
      panel.__tesseraCaptureSize(height);
    }
  };
  const focus = (event?: Event) => {
    const detail = event instanceof CustomEvent ? event.detail : undefined;
    const next = parseCreateRequest(detail);
    if (next && detail && (next.text || (typeof detail === 'object' && detail.kind) || typeof detail === 'string')) setRequest(next);
    // Reopening sends even an unchanged height so the native panel can show
    // only after fitting its retained draft.
    reportSize(true);
    requestAnimationFrame(() => body.querySelector<HTMLElement>('textarea,input:not([type="file"])')?.focus());
  };
  onMount(() => {
    document.documentElement.classList.add('capture-window');
    window.addEventListener('tessera-quick-capture', focus);
    if (panel.__tesseraCaptureSize) {
      // Only the native capture panel injects this bridge. No sizing observer
      // runs for the main sheet, browser or Android.
      const observer = new ResizeObserver(() => reportSize());
      observer.observe(body);
      // Observe portal rows too; mutation tracking only discovers additions or
      // removals, while ResizeObserver measures changing rendered content.
      let choices: HTMLElement | null = null;
      const watchChoices = () => {
        const next = document.querySelector<HTMLElement>('.popup.capture-choices .picker-list');
        if (next !== choices) {
          if (choices) observer.unobserve(choices);
          choices = next;
          if (choices) observer.observe(choices);
        }
        reportSize();
      };
      const portals = new MutationObserver(watchChoices);
      portals.observe(document.body, { childList: true, subtree: true });
      let disposed = false;
      onCleanup(() => { disposed = true; observer.disconnect(); portals.disconnect(); });
      void document.fonts.ready.then(() => {
        if (disposed) return;
        fontsReady = true;
        focus();
      });
    } else {
      focus();
    }
  });
  onCleanup(() => {
    window.removeEventListener('tessera-quick-capture', focus);
    document.documentElement.classList.remove('capture-window');
  });
  return <div ref={body}><Show keyed when={request()}>{value => <CreateSlipBody notebook={notebook} request={value} onDismiss={() => panel.__tesseraCaptureDone?.()} onOpen={target => {
    if (target.kind === 'page' && panel.__tesseraCaptureOpen) panel.__tesseraCaptureOpen(JSON.stringify(target));
    else panel.__tesseraCaptureDone?.();
  }} />}</Show></div>;
}
