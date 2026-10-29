import { Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js';
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
  // The parent hands a new draft to a new composer, so the draft is read once; later reads of `props.draft` could be stale.
  const draft = props.draft;
  const doc = props.notebook.open(draft.sourceId);
  const noteId = draft.noteId;
  const [text, setText] = createSignal('');
  const [ready, setReady] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [error, setError] = createSignal('');
  let input!: HTMLTextAreaElement, context!: HTMLElement, quote!: HTMLQuoteElement, root!: HTMLDialogElement;
  let disposed = false, leaving = false;
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
  /** A Back that could not close the sheet leaves it open, so Back must reach it again. */
  const reclaimHistory = () => {
    if (historyOwned || disposed) return;
    history.pushState({ ...history.state, tesseraComposer: historyKey }, '');
    historyOwned = true;
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
      setText(doc.block(noteId)?.text ?? '');
      setReady(true);
      input.focus();
    }).catch(failed);
  });
  onCleanup(() => {
    disposed = true;
    // Any way out, not only close(): a pane closing or a route change must not leave an empty note under the highlight.
    // `props.draft` is a stale accessor once the parent's Show has closed, so only the captured id is read here.
    const block = ready() ? doc.block(noteId) : undefined;
    if (block && !block.text.trim() && doc.edit({ kind: 'delete', ids: [noteId] }).ok) void doc.flush().catch(() => undefined).finally(() => doc.release());
    else doc.release();
  });

  function write(value: string) {
    setText(value);
    const result = doc.edit({ kind: 'text', id: noteId, text: value });
    setError(result.ok ? '' : result.reason);
  }

  /** A locally queued note is kept even without an acknowledgement from the service. */
  async function leave() {
    if (leaving) return;
    leaving = true;
    input.blur();
    root.classList.add('reader-compose-leaving');
    await root.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'fade-out')?.finished.catch(() => undefined);
    if (!disposed) props.onClose();
  }
  createEffect(() => {
    if (!closing()) return;
    const state = doc.saveState();
    if (state === 'saved' || state === 'saving' || state === 'offline') void leave();
    else if (state === 'error' || state === 'conflict') { setError(doc.saveMessage()); setClosing(false); reclaimHistory(); }
  });
  function close() {
    if (closing()) return;
    if (ready() && !text().trim()) {
      const result = doc.edit({ kind: 'delete', ids: [noteId] });
      if (!result.ok) { setError(result.reason); reclaimHistory(); return; }
    }
    setClosing(true);
    void doc.flush().catch(reason => { failed(reason); if (!disposed) { setClosing(false); reclaimHistory(); } });
  }

  const status = () => error() || (ready() ? doc.saveMessage() : 'Loading…');
  return <Portal><dialog ref={root} class="reader-compose" style={readerStyle()} aria-label="Annotation on this passage"
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
      <h2>{draft.title}</h2>
      <Show when={draft.byline}><p>{draft.byline}</p></Show>
    </header>
    <div class="reader-progress-rule" aria-hidden="true"><span style={{ width: `${draft.progress * 100}%` }} /></div>
    <section ref={context} class="reader-compose-context" aria-label="Passage">
      <div class="reader-compose-meta"><span>{draft.section}</span><span>{formatProgress(draft.progress)}</span></div>
      <Show when={draft.before}><p class="reader-compose-around">{draft.before}</p></Show>
      <blockquote ref={quote}>{draft.quote}</blockquote>
      <Show when={draft.after}><p class="reader-compose-around">{draft.after}</p></Show>
    </section>
    <section class="reader-compose-sheet">
      {/* One way back: Keep note once there is text, Back to reading while it is empty (and the empty note goes). */}
      <div class="reader-compose-heading">
        <label for="reader-compose-note">A thought on this passage</label>
        <Button class="reader-compose-close" classList={{ 'reader-compose-keep': !!text().trim() }} icon={text().trim() ? 'check' : undefined} disabled={closing()} onClick={() => { void close(); }}>{text().trim() ? 'Keep annotation' : 'Back to reading'}</Button>
      </div>
      <textarea ref={input} id="reader-compose-note" placeholder="What do you want to remember?" disabled={!ready() || closing()}
        value={text()} onInput={event => write(event.currentTarget.value)} />
      <p class="reader-compose-status" role="status" classList={{ error: !!error() }}>{status()}</p>
    </section>
  </dialog></Portal>;
}
