import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { FieldViewState, OpenTarget } from '../shell/contract';
import { FieldDetails } from './FieldDetails';

export function FieldPane(props: {
  target: Extract<OpenTarget, { kind: 'field' }>;
  view: FieldViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onTargetChange(target: OpenTarget): void;
  onViewChange(view: FieldViewState): void;
}) {
  const [doc, setDoc] = createSignal<PageDocument>();
  const [error, setError] = createSignal('');
  let scroll!: HTMLDivElement;
  let restored = false;
  createEffect(() => {
    const controller = new AbortController();
    let document: PageDocument | undefined;
    void props.notebook.api.pageByTitle('Fields', controller.signal).then(page => {
      if (!controller.signal.aborted) { document = props.notebook.open(page.id); setDoc(document); }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => { controller.abort(); document?.release(); });
  });
  return <div ref={scroll} class="field-page-pane" role="region" tabIndex={0} aria-label="Field page" onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })} onKeyDown={event => {
    if (!(event.target instanceof HTMLInputElement) && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) doc()?.redo(); else doc()?.undo();
    }
  }}>
    {error() && <p class="error" role="alert">{error()}</p>}
    <FieldDetails fieldId={props.target.fieldId} previewKind={props.target.previewKind} section={props.target.section} notebook={props.notebook} document={doc()} onOpen={props.onOpen}
      onPreview={previewKind => props.onTargetChange({ kind: 'field', fieldId: props.target.fieldId, ...(previewKind ? { previewKind } : {}) })}
      onReady={() => { if (!restored) { restored = true; requestAnimationFrame(() => { if (!props.target.section) scroll.scrollTop = props.view.scroll; }); } }} />
  </div>;
}
