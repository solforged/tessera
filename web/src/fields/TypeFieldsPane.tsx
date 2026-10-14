import { Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { FieldsViewState, OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { noteKindIcon } from '../notes/kinds';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { TemplateEditor } from './TemplateEditor';
import './fields.css';

interface TypeFieldsPaneProps {
  typeId: string;
  view: FieldsViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: FieldsViewState): void;
}

/** The type template stays in the same register as its finding aid and table. */
export function TypeFieldsPane(props: TypeFieldsPaneProps) {
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal('');
  let scroll!: HTMLDivElement;
  let restored = false;
  createEffect(on(() => props.notebook.changeSequence(), () => {
    const timer = setTimeout(() => setVersion(value => value + 1), 150);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  const [data] = createResource(() => [props.typeId, version()] as const, async ([id]) => {
    try {
      const [type, fields, index] = await Promise.all([props.notebook.api.type(id), props.notebook.api.fields(), props.notebook.api.noteIndex()]);
      setError('');
      return { type, fields, kind: index.kinds.find(kind => kind.type_id === id) };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  });
  const title = createMemo(() => data.latest?.type.page.text ?? props.notebook.lookup(props.typeId)()?.text ?? 'Type');
  createEffect(() => {
    if (!data.latest || restored) return;
    restored = true;
    requestAnimationFrame(() => { scroll.scrollTop = props.view.scroll; });
  });
  return <div ref={scroll} class="type-fields-pane" role="region" tabIndex={0} data-pane-pending={!data.latest && !error() ? '' : undefined} aria-label={`${title()} fields`} onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="type-fields-register">
      <header class="type-fields-heading">
        <div class="fields-register"><Button class="type-fields-crumb" onClick={event => props.onOpen({ kind: 'page', pageId: props.typeId }, opensBeside(event))}>{title()}</Button><span> / Template</span></div>
        <div class="type-fields-title"><h1><Show when={data.latest?.kind}>{kind => <Icon name={noteKindIcon(kind())} />}</Show>{data.latest?.kind?.plural ?? title()}</h1><span>{data.latest?.type.fields.length ?? 0} fields</span></div>
      </header>
      <TypeModeTabs active="fields" indexCount={data.latest?.kind?.count} tableCount={data.latest?.type.members} fieldsCount={data.latest?.type.fields.length}
        cardsCount={data.latest?.type.card_templates} onCards={event => props.onOpen({ kind: 'cards', typeId: props.typeId }, opensBeside(event))}
        onIndex={event => props.onOpen({ kind: 'index', key: data.latest?.kind?.key ?? `type:${props.typeId}` }, opensBeside(event))}
        onTable={event => props.onOpen({ kind: 'table', typeId: props.typeId, viewId: null, query: typeQuery(props.typeId) }, opensBeside(event))}
        onFields={() => { scroll.scrollTop = 0; }} />
      <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setVersion(value => value + 1)}>Retry</Button></p></Show>
      <Show when={data.latest} fallback={<Show when={!error()}><p class="empty-state" role="status">Loading fields…</p></Show>}>{value =>
        <TemplateEditor type={value().type} fields={value().fields.fields} notebook={props.notebook} onError={setError} register={{ fields: value().fields.fields, pageId: value().fields.page_id, onOpen: props.onOpen }} />
      }</Show>
    </div>
  </div>;
}
