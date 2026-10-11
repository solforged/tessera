import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { createNotebookClient } from '../document';
import type { NotebookInfo } from '../api/types';
import type { CaptureRequest } from '../shell/quick-capture';
import { shortDay } from '../shell/desk-counts';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { CaptureField } from './CaptureField';

interface CaptureBodyProps {
  notebook: NotebookClient;
  request: CaptureRequest;
  /** After a save that closes the sheet, or on Escape. */
  onDone(): void;
  inputRef?(input: HTMLInputElement): void;
}

/** The sheet's contents: where the line goes, the line, then its keys and Add. */
function CaptureBody(props: CaptureBodyProps) {
  const [added, setAdded] = createSignal(0);
  return <div class="capture">
    <header class="capture-head">
      <span class="capture-title">Add to today</span>
      <span class="capture-where">{shortDay(props.notebook.todayDate())} · end of journal</span>
    </header>
    <CaptureField notebook={props.notebook} contextDate={() => props.notebook.todayDate()} initialTask={props.request.task} initialText={props.request.text}
      label="Add to today" placeholder="A note, or ⌘↵ for a task · [[ links · @fri plans" inputRef={props.inputRef}
      onSaved={again => { if (again) setAdded(count => count + 1); else props.onDone(); }} onCancel={props.onDone}>
      {state => <footer class="capture-foot">
        <span class="capture-keys">
          <Show when={added()} fallback={<><kbd>↵</kbd> Add <kbd>⇧↵</kbd> Add another <kbd>⌘↵</kbd> {state.task() ? 'Note' : 'Task'} <kbd>esc</kbd> Close</>}>
            <span class="capture-added" role="status">{added()} added to today</span>
          </Show>
        </span>
        <Button class="bordered" onClick={() => state.submit(false)}>Add</Button>
      </footer>}
    </CaptureField>
  </div>;
}

/** ⌘E, the desktop menu and Android's shortcuts: one line for today's journal over whatever is open. */
export function CaptureSheet(props: { notebook: NotebookClient; request: CaptureRequest; onDismiss(): void }) {
  // The cover screen raises it from the bottom edge, above the keyboard.
  const touch = window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
  return <Popup anchor={document.body} placement={touch ? 'sheet' : 'top'} width={560} label="Add to today" class="capture-sheet" onDismiss={props.onDismiss}>
    <CaptureBody notebook={props.notebook} request={props.request} onDone={props.onDismiss} />
  </Popup>;
}

type CaptureWindow = Window & { __tesseraCaptureDone?: () => void };

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
  const focus = () => requestAnimationFrame(() => input?.focus());
  onMount(() => {
    document.documentElement.classList.add('capture-window');
    window.addEventListener('tessera-quick-capture', focus);
    focus();
  });
  onCleanup(() => window.removeEventListener('tessera-quick-capture', focus));
  return <CaptureBody notebook={notebook} request={{ task: false, text: '' }} inputRef={element => { input = element; }} onDone={() => (window as CaptureWindow).__tesseraCaptureDone?.()} />;
}
