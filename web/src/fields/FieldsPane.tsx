import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { api } from '../api/client';
import type { FieldKind, FieldSummary, Fields } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { FieldsViewState, OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import './fields.css';

interface FieldsPaneProps {
  view: FieldsViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: FieldsViewState): void;
}
const kindLabels: Record<FieldKind, string> = { text: 'Text', number: 'Number', date: 'Date', checkbox: 'Checkbox', choice: 'Choice', instance: 'Instance' };

export function FieldsPane(props: FieldsPaneProps) {
  const [data, setData] = createSignal<Fields>();
  const [doc, setDoc] = createSignal<PageDocument>();
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [retry, setRetry] = createSignal(0);
  const fields = createMemo(() => [...(data()?.fields ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  const pageId = createMemo(() => data()?.page_id);
  let scroll!: HTMLDivElement;
  let restoredScroll = false;
  createEffect(() => {
    const id = pageId();
    if (!id) return;
    const document = props.notebook.open(id);
    setDoc(document);
    onCleanup(() => { setDoc(undefined); document.release(); });
  });
  createEffect(() => {
    props.notebook.changeSequence(); retry();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void api.fields(controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setData(value); setError(''); setLoading(false);
        if (!restoredScroll) {
          restoredScroll = true;
          requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });
        }
      }).catch(reason => {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      });
    }, 150);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  const openDefinition = (field: FieldSummary, beside: boolean) => {
    const id = pageId();
    if (id) props.onOpen({ kind: 'page', pageId: id, blockId: field.id }, beside);
  };
  const changeKind = (field: FieldSummary, value: FieldKind) => {
    const document = doc();
    if (!document) return;
    const result = document.edit({ kind: 'fieldKind', definition: field, value });
    if (!result.ok) setError(result.reason);
  };
  return <div class="fields-pane" tabIndex={0} aria-label="Fields" onFocusIn={props.onActivate} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) doc()?.redo(); else doc()?.undo();
    }
  }}>
    <div class="fields-actions"><Button icon="undo" disabled={!doc()?.canUndo()} onClick={() => doc()?.undo()}>Undo</Button><Button icon="redo" disabled={!doc()?.canRedo()} onClick={() => doc()?.redo()}>Redo</Button></div>
    <Show when={error()}><div class="pane-error" role="alert">{error()} <Button onClick={() => setRetry(value => value + 1)}>Retry</Button></div></Show>
    <Show when={loading() && !data()}><p class="empty-state" role="status">Loading fields…</p></Show>
    <div ref={scroll} class="fields-scroll" onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
      <Show when={data()}>
        <Show when={fields().length} fallback={<p class="empty-state">No fields yet. Type <code>Name::</code> in a block to define one.</p>}>
          <table class="fields-index"><thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Owners</th><th scope="col">Template types</th><th scope="col">Actions</th></tr></thead><tbody>
            <For each={fields()}>{field => <tr tabIndex={0} aria-label={field.name} onKeyDown={event => {
              if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); openDefinition(field, event.shiftKey); }
            }}>
              <td>{field.name}</td>
              <td><select class="input" aria-label={`Kind for ${field.name}`} value={field.kind} disabled={loading() || doc()?.status() !== 'ready' || doc()?.saveState() !== 'saved'} onChange={event => { changeKind(field, event.currentTarget.value as FieldKind); event.currentTarget.value = field.kind; }}><For each={Object.entries(kindLabels)}>{([kind, label]) => <option value={kind}>{label}</option>}</For></select></td>
              <td>{field.owners}</td><td>{field.types.map(type => type.name).join(', ') || 'None'}</td>
              <td><div class="fields-actions"><Button onClick={event => openDefinition(field, event.shiftKey)}>Open definition</Button><Button onClick={event => props.onOpen({ kind: 'table', typeId: null, viewId: null, query: { type: null, text: null, filters: [{ field: field.id, op: 'set', value: null }], sort: [], limit: null } }, event.shiftKey)}>Show owners</Button></div></td>
            </tr>}</For>
          </tbody></table>
        </Show>
      </Show>
    </div>
  </div>;
}
