import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { WorkshopClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

export function GlobalBanner(props: { workshop: WorkshopClient; onReview(): void }) {
  const text = createMemo(() => {
    if (props.workshop.localPersistence() === 'failed') return 'Not saved locally · Keep this tab open';
    const state = props.workshop.saveState();
    if (state === 'error' || props.workshop.rejectedText()) return 'Couldn’t save · Local changes kept';
    if (state === 'conflict') return 'Conflict · Both versions kept';
    if (props.workshop.connection() === 'offline' || state === 'offline') {
      const count = props.workshop.queuedChanges();
      if (!count && (state === 'saving' || state === 'queued')) return 'Saving…';
      return count ? `Offline · ${count} changes queued locally` : 'Offline · All changes saved';
    }
    return '';
  });
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => {
    text();
    props.workshop.rejectedText();
    setCopyMessage('');
  });
  return (
    <Show when={text()}>
      <div class={`save-banner ${props.workshop.saveState()}`} role="status">
        <Icon name={props.workshop.connection() === 'offline' ? 'offline' : 'warning'} />
        <span>{text()}</span>
        <Show when={props.workshop.conflictedPages().length}>
          <Button onClick={props.onReview}>Review conflict</Button>
        </Show>
        <Show when={props.workshop.saveState() === 'error' || props.workshop.connection() === 'offline'}>
          <Button onClick={() => props.workshop.retry()}>Retry</Button>
        </Show>
        <Show when={props.workshop.localPersistence() === 'failed' || props.workshop.rejectedText()}>
          <Button
            onClick={() => {
              navigator.clipboard.writeText(props.workshop.rejectedText() || props.workshop.unsavedText()).then(
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
        <Show when={props.workshop.saveMessage() && props.workshop.saveMessage() !== text()}>
          <details>
            <summary>Details</summary>
            {props.workshop.saveMessage()}
          </details>
        </Show>
        <Show when={props.workshop.rejectedText()}>
          <div class="rejected-changes">
            <pre tabIndex={0} aria-label="Rejected changes kept locally">
              {props.workshop.rejectedText()}
            </pre>
            <Button onClick={() => props.workshop.dismissRejected()}>Dismiss</Button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
