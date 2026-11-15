import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

export function GlobalBanner(props: { notebook: NotebookClient; onReview(): void }) {
  const text = createMemo(() => {
    if (props.notebook.localPersistence() === 'failed') return 'Not saved locally · Keep this tab open';
    const state = props.notebook.saveState();
    if (state === 'error' || props.notebook.rejectedText()) return 'Couldn’t save · Local changes kept';
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (props.notebook.connection() === 'offline' || state === 'offline') {
      const count = props.notebook.queuedChanges();
      if (!count && (state === 'saving' || state === 'queued')) return 'Saving…';
      return count ? `Offline · ${count} changes queued locally` : 'Offline · All changes saved';
    }
    return '';
  });
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => {
    text();
    props.notebook.rejectedText();
    setCopyMessage('');
  });
  return (
    <Show when={text()}>
      <div class={`save-banner ${props.notebook.saveState()}`} role="status">
        <Icon name={props.notebook.connection() === 'offline' ? 'offline' : 'warning'} />
        <span>{text()}</span>
        <Show when={props.notebook.conflictedPages().length}>
          <Button onClick={props.onReview}>Review conflict</Button>
        </Show>
        <Show when={props.notebook.saveState() === 'error' || props.notebook.connection() === 'offline'}>
          <Button onClick={() => props.notebook.retry()}>Retry</Button>
        </Show>
        <Show when={props.notebook.localPersistence() === 'failed' || props.notebook.rejectedText()}>
          <Button
            onClick={() => {
              navigator.clipboard.writeText(props.notebook.rejectedText() || props.notebook.unsavedText()).then(
                () => setCopyMessage('Copied unsaved text'),
                () => setCopyMessage('Couldn’t copy · Select and copy your text manually'),
              );
            }}
          >
            Copy unsaved text
          </Button>
        </Show>
        <Show when={copyMessage()}>
          <span>{copyMessage()}</span>
        </Show>
        <Show when={props.notebook.saveMessage() && props.notebook.saveMessage() !== text()}>
          <details>
            <summary>Details</summary>
            {props.notebook.saveMessage()}
          </details>
        </Show>
        <Show when={props.notebook.rejectedText()}>
          <div class="rejected-changes">
            <pre tabIndex={0} aria-label="Rejected changes kept locally">
              {props.notebook.rejectedText()}
            </pre>
            <Button onClick={() => props.notebook.dismissRejected()}>Dismiss</Button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
