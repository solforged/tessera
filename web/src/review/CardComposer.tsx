import { Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { forwardCardText } from './card-text';
import './card-composer.css';

export interface CardComposerProps {
  /** The trigger the draft hangs from; without one it opens near the top of the viewport. */
  anchor?: PopupAnchor;
  /** Where the card is written, in the slip's rubric line. */
  where: string;
  initialBack?: string;
  /** Resolve only after acknowledgement; reject only when no submitted insertion remains queued. `again` keeps the draft
   * open for the next card, so the caller must not navigate. */
  onSave(text: string, again: boolean): Promise<void>;
  onDismiss(): void;
}

/** Grow with the text up to the CSS max-height, then scroll. */
function fit(field: HTMLTextAreaElement) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

/** A front/back draft laid out like the card it makes: the question in the display voice over a fold, the answer under it,
 * then its keys and Create on a hairline, as in Add to today. */
export function CardComposer(props: CardComposerProps) {
  const [front, setFront] = createSignal('');
  const [back, setBack] = createSignal(props.initialBack ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [added, setAdded] = createSignal(0);
  const id = createUniqueId();
  const sheet = window.matchMedia('(pointer: coarse)').matches;
  let frontField!: HTMLTextAreaElement;
  let backField!: HTMLTextAreaElement;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => { fit(frontField); fit(backField); });

  // An unfinished side is not a problem to report; only text that cannot make one forward card is.
  const draft = createMemo((): { text: string } | { problem: string } | null => {
    if (!front().trim() || !back().trim()) return null;
    try { return { text: forwardCardText(front(), back()) }; } catch (reason) { return { problem: reason instanceof Error ? reason.message : String(reason) }; }
  });
  const problem = () => { const value = draft(); return value && 'problem' in value ? value.problem : ''; };

  async function save(again: boolean) {
    const value = draft();
    if (busy() || !value || !('text' in value)) return;
    setError('');
    setBusy(true);
    let next = false;
    try {
      await props.onSave(value.text, again);
      if (disposed) return;
      if (!again) { props.onDismiss(); return; }
      setAdded(count => count + 1);
      setFront('');
      setBack(props.initialBack ?? '');
      fit(frontField); fit(backField);
      next = true;
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setBusy(false);
    }
    // The fields were disabled while saving; focus can return only once they are enabled again.
    if (next) frontField.focus();
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.key !== 'Enter') return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault(); event.stopPropagation();
      void save(event.shiftKey);
    } else if (event.target === frontField && !event.shiftKey && !event.altKey) {
      // The front is usually one line; Enter turns to the answer and Shift-Enter breaks the line.
      event.preventDefault();
      backField.focus();
      backField.setSelectionRange(backField.value.length, backField.value.length);
    }
  };

  const status = () => busy() ? 'Saving…' : added() ? `${added()} ${added() === 1 ? 'card' : 'cards'} added` : '';
  return <Popup anchor={props.anchor ?? document.body} label="Create a card" placement={sheet ? 'sheet' : props.anchor ? 'anchor' : 'top'} fitContent width={560} class="card-composer" onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <form class="card-composer-form" onSubmit={event => { event.preventDefault(); void save(false); }} onKeyDown={keydown} aria-busy={busy()}>
      <header class="card-composer-head">
        <span class="card-composer-title">New card</span>
        <span class="card-composer-where">{props.where}</span>
      </header>
      <div class="card-composer-side card-composer-front">
        <label class="card-composer-label" for={`${id}-front`}>Front</label>
        <textarea ref={frontField} id={`${id}-front`} class="card-composer-input" rows={1} enterkeyhint="next" value={front()} disabled={busy()} placeholder="What do you want to remember?"
          onInput={event => { setFront(event.currentTarget.value); fit(event.currentTarget); }} />
      </div>
      <div class="card-composer-side card-composer-back">
        <label class="card-composer-label" for={`${id}-back`}>Back</label>
        <textarea ref={backField} id={`${id}-back`} class="card-composer-input" rows={2} value={back()} disabled={busy()} placeholder="The answer"
          aria-describedby={problem() ? `${id}-problem` : undefined} onInput={event => { setBack(event.currentTarget.value); fit(event.currentTarget); }} />
      </div>
      <Show when={error() || problem()}><p id={`${id}-problem`} class="card-composer-problem" role="alert">{error() || problem()}</p></Show>
      <footer class="card-composer-foot">
        <span class="card-composer-keys">
          <Show when={status()} fallback={<span class="card-composer-key-hints"><kbd>⌘↵</kbd> Create <kbd>⇧⌘↵</kbd> Create another <kbd>esc</kbd> Close</span>}>
            <span role="status">{status()}</span>
          </Show>
        </span>
        <Button disabled={busy()} onClick={props.onDismiss}>{added() ? 'Done' : 'Cancel'}</Button>
        <Button type="submit" class="bordered" disabled={busy() || !draft() || !!problem()}>Create card</Button>
      </footer>
    </form>
  </Popup>;
}
