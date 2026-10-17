import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { createNotebookClient } from '../document';
import type { NotebookInfo } from '../api/types';
import { blankCapture } from '../create/request';
import type { CreateRequest } from '../create/request';
import { shortDay } from '../shell/desk-counts';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { CaptureField } from './CaptureField';

interface CaptureBodyProps {
  notebook: NotebookClient;
  request: CreateRequest;
  /** After a save that closes the sheet, or on Escape. */
  onDone(): void;
  inputRef?(input: HTMLInputElement): void;
  bodyRef?(body: HTMLDivElement): void;
}

/** The sheet's contents: where the line goes, the line, then its keys and Add. */
function CaptureBody(props: CaptureBodyProps) {
  const [added, setAdded] = createSignal(0);
  const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  return <div ref={props.bodyRef} class="capture">
    <header class="capture-head">
      <span class="capture-title">Add to today</span>
      <span class="capture-where">{shortDay(props.notebook.todayDate())} · end of journal</span>
    </header>
    <CaptureField notebook={props.notebook} contextDate={() => props.notebook.todayDate()} initialTask={props.request.kind === 'task'} initialText={props.request.text}
      label="Add to today" placeholder={touch ? 'Add a note or task' : 'A note, or ⌘↵ for a task · [[ links · @fri plans'} inputRef={props.inputRef}
      onSaved={again => { if (again) setAdded(count => count + 1); else props.onDone(); }} onCancel={props.onDone}>
      {state => <footer class="capture-foot">
        <span class="capture-keys">
          <Show when={added()} fallback={<span class="capture-key-hints"><kbd>↵</kbd> Add <kbd>⇧↵</kbd> Add another <kbd>⌘↵</kbd> {state.task() ? 'Note' : 'Task'} <kbd>esc</kbd> Close</span>}>
            <span class="capture-added" role="status">{added()} added to today</span>
          </Show>
        </span>
        <Button class="capture-cancel" onClick={props.onDone}>Cancel</Button>
        <Button class="bordered" onClick={() => state.submit(false)}>Add</Button>
      </footer>}
    </CaptureField>
  </div>;
}

/** ⌘E, the desktop menu and Android's shortcuts: one line for today's journal over whatever is open. */
export function CaptureSheet(props: { notebook: NotebookClient; request: CreateRequest; onDismiss(): void }) {
  // The cover screen raises it from the bottom edge, above the keyboard.
  const touch = window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
  return <Popup anchor={document.body} placement={touch ? 'sheet' : 'top'} width={560} label="Add to today" class="capture-sheet" onDismiss={props.onDismiss}>
    <CaptureBody notebook={props.notebook} request={props.request} onDone={props.onDismiss} />
  </Popup>;
}

type CaptureWindow = Window & {
  __tesseraCaptureDone?: () => void;
  __tesseraCaptureSize?: (height: number) => void;
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
  let input: HTMLInputElement | undefined;
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
  const focus = () => {
    // Reopening sends even an unchanged height so the native panel can show
    // only after fitting its retained draft.
    reportSize(true);
    requestAnimationFrame(() => input?.focus());
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
  return <CaptureBody notebook={notebook} request={blankCapture()} bodyRef={element => { body = element; }} inputRef={element => { input = element; }} onDone={() => panel.__tesseraCaptureDone?.()} />;
}
