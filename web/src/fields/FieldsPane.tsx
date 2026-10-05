import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { api } from '../api/client';
import type { FieldKind, FieldSummary, Fields } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { FieldsViewState, OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';
import { kindLabels } from './kinds';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import './fields.css';

interface FieldsPaneProps {
  view: FieldsViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: FieldsViewState): void;
}

export function FieldsPane(props: FieldsPaneProps) {
  const [data, setData] = createSignal<Fields>();
  const [doc, setDoc] = createSignal<PageDocument>();
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [retry, setRetry] = createSignal(0);
  const [search, setSearch] = createSignal('');
  const [kindMenu, setKindMenu] = createSignal<{ field: FieldSummary; anchor: HTMLElement } | null>(null);
  const fields = createMemo(() => [...(data()?.fields ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  const visibleFields = createMemo(() => {
    const needle = search().trim().toLocaleLowerCase();
    return fields().filter(field => field.name.toLocaleLowerCase().includes(needle));
  });
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
    if (!document || field.kind === value) return;
    const result = document.edit({ kind: 'fieldKind', definition: field, value });
    if (!result.ok) setError(result.reason);
  };
  return <div class="fields-pane" role="region" tabIndex={0} aria-label="Fields" onFocusIn={props.onActivate} onKeyDown={event => {
    if (!(event.target instanceof HTMLInputElement) && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) doc()?.redo(); else doc()?.undo();
    }
  }}>
    <div class="fields-toolbar">
      <input class="input fields-search" type="search" aria-label="Filter fields" placeholder="Filter fields…" value={search()} onInput={event => setSearch(event.currentTarget.value)} />
      <Button icon="edit" disabled={!pageId()} onClick={event => props.onOpen({ kind: 'page', pageId: pageId()! }, event.shiftKey)}>Edit definitions</Button>
      <div class="fields-actions"><Button icon="undo" label="Undo field changes" disabled={!doc()?.canUndo()} onClick={() => doc()?.undo()} /><Button icon="redo" label="Redo field changes" disabled={!doc()?.canRedo()} onClick={() => doc()?.redo()} /></div>
    </div>
    <Show when={error()}><div class="pane-error" role="alert">{error()} <Button onClick={() => setRetry(value => value + 1)}>Retry</Button></div></Show>
    <Show when={loading() && !data()}><p class="empty-state" role="status">Loading fields…</p></Show>
    <div ref={scroll} class="fields-scroll" onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
      <Show when={data()}>
        <Show when={fields().length} fallback={<p class="empty-state">No fields yet. Edit definitions or type <code>Name::</code> in a block to add one.</p>}>
          <Show when={visibleFields().length} fallback={<p class="empty-state">No matching fields. <Button onClick={() => setSearch('')}>Clear filter</Button></p>}>
            <table class="fields-index"><thead><tr><th scope="col">Name</th><th scope="col" class="fields-kind">Kind</th><th scope="col" class="fields-count">Used by</th><th scope="col">Templates</th></tr></thead><tbody>
              <For each={visibleFields()}>{field => <tr>
                <td><Button class="field-name" title={`Edit ${field.name} definition · Shift to open beside`} onClick={event => openDefinition(field, event.shiftKey)}>{field.name}</Button></td>
                <td><Button class="bordered" aria-label={`Kind for ${field.name}`} aria-haspopup="menu" disabled={loading() || doc()?.status() !== 'ready' || doc()?.saveState() !== 'saved'} onClick={event => setKindMenu({ field, anchor: event.currentTarget })}>{kindLabels[field.kind]} <Icon name="down" /></Button></td>
                <td class="fields-count"><Button label={`Show blocks with ${field.name}`} title={`Blocks using ${field.name}: ${field.owners} · Shift to open beside`} onClick={event => props.onOpen({ kind: 'table', typeId: null, viewId: null, query: { type: null, text: null, filters: [{ field: field.id, op: 'present', value: null }], sort: [], limit: null } }, event.shiftKey)}>{field.owners}</Button></td>
                <td><div class="fields-types"><For each={field.types} fallback={<span class="muted">None</span>}>{type => <Button class="outline-tag" title={`Open ${type.name} table · Shift to open beside`} onClick={event => props.onOpen({ kind: 'table', typeId: type.id, viewId: null, query: typeQuery(type.id) }, event.shiftKey)}>#{type.name}</Button>}</For></div></td>
              </tr>}</For>
            </tbody></table>
          </Show>
        </Show>
      </Show>
    </div>
    <footer class="fields-footer"><span role="status">{visibleFields().length} of {fields().length} fields</span><span>Changing kind leaves value text unchanged.</span></footer>
    <Show keyed when={kindMenu()}>{state => <Menu anchor={state.anchor} label={`Kind for ${state.field.name}`} onDismiss={() => setKindMenu(null)} items={(Object.keys(kindLabels) as FieldKind[]).map(kind => ({ label: kindLabels[kind], icon: kind === state.field.kind ? 'check' : undefined, action: () => changeKind(state.field, kind) }))} />}</Show>
  </div>;
}
