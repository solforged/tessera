import { Show, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { forwardCardText } from './card-text';
import './card-composer.css';

export interface CardComposerProps {
  anchor: PopupAnchor;
  initialBack?: string;
  context?: JSX.Element;
  onSave(text: string): Promise<void>;
  onDismiss(): void;
}

export function CardComposer(props: CardComposerProps) {
  const [front, setFront] = createSignal('');
  const [back, setBack] = createSignal(props.initialBack ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const id = createUniqueId();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  async function save() {
    if (busy()) return;
    setError('');
    try {
      const text = forwardCardText(front(), back());
      setBusy(true);
      await props.onSave(text);
      if (!disposed) props.onDismiss();
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return <Popup anchor={props.anchor} label="Create a card" placement={window.matchMedia('(pointer: coarse)').matches ? 'sheet' : 'top'} class="card-composer" onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={busy()}>
      <h2>Create a card</h2>
      <Show when={props.context}><div class="card-composer-context">{props.context}</div></Show>
      <label for={`${id}-front`}>Front<textarea id={`${id}-front`} class="input" rows={3} value={front()} disabled={busy()} placeholder="What do you want to remember?" onInput={event => setFront(event.currentTarget.value)} /></label>
      <label for={`${id}-back`}>Back<textarea id={`${id}-back`} class="input" rows={4} value={back()} disabled={busy()} placeholder="Write the answer" onInput={event => setBack(event.currentTarget.value)} /></label>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <Show when={busy()}><p class="card-composer-context" role="status">Saving card…</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={busy()}>Create card</Button></div>
    </form>
  </Popup>;
}
