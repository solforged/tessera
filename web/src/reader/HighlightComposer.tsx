import { Show, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { NotebookClient } from '../document/contract';
import { formatProgress } from '../library/query';
import { documentReady } from '../tasks/JournalAgenda';
import { Button } from '../ui/Button';
import { readerStyle } from './ReaderSettings';

export interface HighlightNoteDraft {
  sourceId: string;
  noteId: string;
  title: string;
  byline: string;
  section: string;
  progress: number;
  before: string;
  quote: string;
  after: string;
}

/**
 * The note on a new highlight, written on a touch screen with the passage still in sight above the
 * keyboard. Text saves as it is typed, like an outline row; an empty note is removed on the way back.
 */
export function HighlightComposer(props: { notebook: NotebookClient; draft: HighlightNoteDraft; onClose(): void }) {
  const doc = props.notebook.open(props.draft.sourceId);
  const [text, setText] = createSignal('');
  const [ready, setReady] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [error, setError] = createSignal('');
  let input!: HTMLTextAreaElement, context!: HTMLElement, quote!: HTMLQuoteElement, root!: HTMLDialogElement;
  let disposed = false;
  const historyKey = createUniqueId();
  const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const reader = document.querySelector<HTMLElement>('.pane.active .reader-scroll');
  let historyOwned = false;
  const historyMoved = (event: PopStateEvent) => {
    if (!historyOwned || event.state?.tesseraComposer === historyKey) return;
    historyOwned = false;
    event.stopImmediatePropagation();
    void close();
  };
  const failed = (reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); };
  /** The whole quotation and as much of the lead-in as fits; the sentence after it scrolls into view. */
  const fit = () => {
    const pad = parseFloat(getComputedStyle(context).paddingTop);
    const end = quote.offsetTop + quote.offsetHeight + pad - context.clientHeight;
    context.scrollTop = Math.max(0, Math.min(end, quote.offsetTop - pad));
  };

  onMount(() => {
    root.showModal();
    history.pushState({ ...history.state, tesseraComposer: historyKey }, '');
    historyOwned = true;
    window.addEventListener('popstate', historyMoved, true);
    onCleanup(() => {
      window.removeEventListener('popstate', historyMoved, true);
      if (historyOwned && history.state?.tesseraComposer === historyKey) history.back();
      root.close();
      const target = prior?.isConnected && prior !== document.body ? prior : reader;
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
    const observer = new ResizeObserver(fit);
    observer.observe(context);
    onCleanup(() => observer.disconnect());
    void documentReady(doc).then(() => {
      if (disposed) return;
      setText(doc.block(props.draft.noteId)?.text ?? '');
      setReady(true);
      input.focus();
    }).catch(failed);
  });
  onCleanup(() => { disposed = true; doc.release(); });

  function write(value: string) {
    setText(value);
    const result = doc.edit({ kind: 'text', id: props.draft.noteId, text: value });
    setError(result.ok ? '' : result.reason);
  }

  /** Text is already saved as it is typed; closing removes an empty note, waits for the save, then lets the page show through. */
  async function close() {
    if (closing()) return;
    setClosing(true);
    try {
      if (ready() && !text().trim()) {
        const result = doc.edit({ kind: 'delete', ids: [props.draft.noteId] });
        if (!result.ok) throw new Error(result.reason);
      }
      await doc.flush();
      if (disposed) return;
      input.blur();
      root.classList.add('reader-compose-leaving');
      await root.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'fade-out')?.finished.catch(() => undefined);
      if (!disposed) props.onClose();
    } catch (reason) {
      failed(reason); setClosing(false);
      if (!historyOwned) {
        history.pushState({ ...history.state, tesseraComposer: historyKey }, '');
        historyOwned = true;
      }
    }
  }

  const status = () => error() || (ready() ? doc.saveMessage() : 'Loading…');
  return <Portal><dialog ref={root} class="reader-compose" style={readerStyle()} aria-label="Note on this passage"
    onCancel={event => { event.preventDefault(); void close(); }}
    onKeyDown={event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close(); }
      else if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    }}>
    <header class="reader-compose-header">
      <h2>{props.draft.title}</h2>
      <Show when={props.draft.byline}><p>{props.draft.byline}</p></Show>
    </header>
    <div class="reader-progress-rule" aria-hidden="true"><span style={{ width: `${props.draft.progress * 100}%` }} /></div>
    <section ref={context} class="reader-compose-context" aria-label="Passage">
      <div class="reader-compose-meta"><span>{props.draft.section}</span><span>{formatProgress(props.draft.progress)}</span></div>
      <Show when={props.draft.before}><p class="reader-compose-around">{props.draft.before}</p></Show>
      <blockquote ref={quote}>{props.draft.quote}</blockquote>
      <Show when={props.draft.after}><p class="reader-compose-around">{props.draft.after}</p></Show>
    </section>
    <section class="reader-compose-sheet">
      {/* One way back: Keep note once there is text, Back to reading while it is empty (and the empty note goes). */}
      <div class="reader-compose-heading">
        <label for="reader-compose-note">A thought on this passage</label>
        <Button class="reader-compose-close" classList={{ 'reader-compose-keep': !!text().trim() }} icon={text().trim() ? 'check' : undefined} disabled={closing()} onClick={() => { void close(); }}>{text().trim() ? 'Keep note' : 'Back to reading'}</Button>
      </div>
      <textarea ref={input} id="reader-compose-note" placeholder="What do you want to remember?" disabled={!ready() || closing()}
        value={text()} onInput={event => write(event.currentTarget.value)} />
      <p class="reader-compose-status" role="status" classList={{ error: !!error() }}>{status()}</p>
    </section>
  </dialog></Portal>;
}
