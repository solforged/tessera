import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { forwardCardText, parseCardText } from './card-text';
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
  /** Constrains the popup to its pane as well as the viewport. */
  bounds?: () => DOMRect | null;
}

export interface CardComposerBodyProps extends Omit<CardComposerProps, 'anchor' | 'where'> {
  initialText?: string;
  onTextChange?(text: string): void;
  onBusyChange?(busy: boolean): void;
  /** True while the draft holds text the writer typed. */
  onDirtyChange?(dirty: boolean): void;
  /** Text to start from instead of the initial text: a draft the writer closed with Escape. */
  restore?: { front: string; back: string };
  /** Called with both sides after each edit. */
  onEdit?(front: string, back: string): void;
  /** Cancel was chosen: the draft ends. */
  onDiscard?(): void;
  sheet?: boolean;
  status?: string;
  /** The slip has its own rubric; the standalone wrapper supplies this one. */
  where?: string;
}

/** Grow with the text up to the CSS max-height, then scroll. */
function fit(field: HTMLTextAreaElement) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

/** A front/back draft laid out like the card it makes: the question in the display voice over a fold, the answer under it,
 * then its keys and Create on a hairline, as in Add to today. */
export function CardComposerBody(props: CardComposerBodyProps) {
  const parsed = parseCardText(props.initialText ?? '').cards[0];
  const [front, setFront] = createSignal(props.restore?.front ?? parsed?.front ?? props.initialText ?? '');
  const [back, setBack] = createSignal(props.restore?.back ?? parsed?.back ?? props.initialBack ?? '');
  const [original, setOriginal] = createSignal(parsed ? props.initialText : undefined);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [added, setAdded] = createSignal(0);
  const id = createUniqueId();
  function changed() {
    setOriginal(undefined);
    props.onTextChange?.(back().trim() ? `${front()} >> ${back()}` : front());
    props.onEdit?.(front(), back());
  }
  let frontField!: HTMLTextAreaElement;
  let backField!: HTMLTextAreaElement;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => { fit(frontField); fit(backField); });
  // Typed text, not a prefilled answer, is what an outside click must not discard.
  createEffect(() => props.onDirtyChange?.(!!front().trim() || back().trim() !== (props.initialBack ?? '').trim()));

  // An unfinished side is not a problem to report; only text that cannot make one forward card is.
  const draft = createMemo((): { text: string } | { problem: string } | null => {
    if (original()) return { text: original()! };
    if (!front().trim() || !back().trim()) return null;
    try { return { text: forwardCardText(front(), back()) }; } catch (reason) { return { problem: reason instanceof Error ? reason.message : String(reason) }; }
  });
  const problem = () => { const value = draft(); return value && 'problem' in value ? value.problem : ''; };

  async function save(again: boolean) {
    const value = draft();
    if (busy() || !value || !('text' in value)) return;
    setError('');
    setBusy(true);
    props.onBusyChange?.(true);
    let next = false;
    try {
      await props.onSave(value.text, again);
      if (disposed) return;
      if (!again) { props.onDismiss(); return; }
      setAdded(count => count + 1);
      setOriginal(undefined);
      setFront('');
      setBack(props.initialBack ?? '');
      fit(frontField); fit(backField);
      next = true;
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setBusy(false);
      props.onBusyChange?.(false);
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

  const status = () => busy() ? 'Saving…' : props.status ?? (added() ? `${added()} ${added() === 1 ? 'card' : 'cards'} added` : '');
  return <form class="card-composer-form" onSubmit={event => { event.preventDefault(); void save(false); }} onKeyDown={keydown} aria-busy={busy()}>
      <Show when={props.where !== undefined}><header class="card-composer-head">
        <span class="card-composer-title">New card</span>
        <span class="card-composer-where">{props.where}</span>
      </header></Show>
      <div class="card-composer-side card-composer-front">
        <label class="card-composer-label" for={`${id}-front`}>Front</label>
        <textarea ref={frontField} id={`${id}-front`} class="card-composer-input" rows={1} enterkeyhint="next" value={front()} disabled={busy()} placeholder="What do you want to remember?"
          onInput={event => { setFront(event.currentTarget.value); fit(event.currentTarget); changed(); }} />
      </div>
      <div class="card-composer-side card-composer-back">
        <label class="card-composer-label" for={`${id}-back`}>Back</label>
        <textarea ref={backField} id={`${id}-back`} class="card-composer-input" rows={2} value={back()} disabled={busy()} placeholder="The answer"
          aria-describedby={problem() ? `${id}-problem` : undefined} onInput={event => { setBack(event.currentTarget.value); fit(event.currentTarget); changed(); }} />
      </div>
      <Show when={error() || problem()}><p id={`${id}-problem`} class="card-composer-problem" role="alert">{error() || problem()}</p></Show>
      <footer class="card-composer-foot">
        <span class="card-composer-keys">
          <Show when={status()} fallback={<Show when={!props.sheet}><span class="card-composer-key-hints"><kbd>⌘↵</kbd> Create <kbd>⇧⌘↵</kbd> Create another <kbd>esc</kbd> Close</span></Show>}>
            <span role="status">{status()}</span>
          </Show>
        </span>
        <Show when={!props.sheet}><Button disabled={busy()} onClick={() => { props.onDiscard?.(); props.onDismiss(); }}>{added() ? 'Done' : 'Cancel'}</Button></Show>
        <Button type="submit" class="bordered" disabled={busy() || !draft() || !!problem()}>Create card</Button>
      </footer>
    </form>;
}

/** The standalone composer's unsent text, by the answer it was opened with (a highlight's passage, or none). */
const composerDrafts = new Map<string, { front: string; back: string }>();

/** Highlights keep the standalone composer, with the same keys and save contract. */
export function CardComposer(props: CardComposerProps) {
  const sheet = window.matchMedia('(pointer: coarse)').matches;
  const [busy, setBusy] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const key = props.initialBack ?? '';
  const restore = composerDrafts.get(key);
  // Escape and an outside click close the composer but keep what was typed for its next opening; Create and Cancel end the draft.
  const save = async (text: string, again: boolean) => { await props.onSave(text, again); composerDrafts.delete(key); };
  return <Popup anchor={props.anchor ?? document.body} label="Create a card" placement={sheet ? 'sheet' : props.anchor ? 'anchor' : 'top'} fitContent width={560} class="card-composer" bounds={props.bounds} dirty={dirty} onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <CardComposerBody {...props} onSave={save} sheet={sheet} restore={restore} onBusyChange={setBusy} onDirtyChange={setDirty}
      onEdit={(front, back) => { if (front.trim() || back.trim() !== key.trim()) composerDrafts.set(key, { front, back }); else composerDrafts.delete(key); }} onDiscard={() => { composerDrafts.delete(key); }} />
  </Popup>;
}
