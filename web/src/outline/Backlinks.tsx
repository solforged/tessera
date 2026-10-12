import { For, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText } from './BlockText';
import { BlockTree, blockContextRows } from './BlockTree';
import './backlinks.css';

interface SourceProps {
  block: Block;
  page: Block;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

/** Mounted only while a source is expanded (or its count popup is open). */
function SourceContext(props: SourceProps) {
  const doc = createMemo(() => {
    const value = props.notebook.open(props.page.id);
    onCleanup(() => value.release());
    return value;
  });
  const rows = createMemo(() => doc().status() === 'ready' ? blockContextRows(doc(), props.block.id, 6) : []);
  return <Show when={doc().status() === 'ready'} fallback={<p role="status">{doc().status() === 'loading' ? 'Loading context…' : doc().statusMessage()}</p>}>
    <BlockTree rows={rows()} block={id => doc().block(id)} notebook={props.notebook} onOpen={props.onOpen} />
  </Show>;
}

export function BacklinkSource(props: SourceProps & { context?: boolean; breadcrumb?: boolean }) {
  const [expanded, setExpanded] = createSignal(false);
  const live = createMemo(() => props.notebook.lookup(props.block.id)());
  const target = (): OpenTarget => ({ kind: 'page', pageId: props.page.id, blockId: props.block.id });
  return <div class="backlink-source">
    <Show when={props.breadcrumb}><div class="related-breadcrumb"><BlockBreadcrumb block={live() ?? props.block} notebook={props.notebook} omitParent={props.context} /></div></Show>
    <div class="backlink-source-line">
      <Show when={!props.context}><Button class="backlink-disclosure" icon={expanded() ? 'down' : 'right'} label={expanded() ? 'Hide context' : 'Show context'} aria-expanded={expanded()} onClick={() => setExpanded(value => !value)} /></Show>
      <div class="backlink-source-body" role="link" tabIndex={0} title="Open · Shift opens beside" onClick={event => props.onOpen(target(), event.shiftKey)} onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) props.onOpen(target(), event.shiftKey); }}>
        <Show when={props.context || expanded()} fallback={<BlockText text={live()?.text ?? props.block.text} blockId={props.block.id} notebook={props.notebook} onOpen={props.onOpen} />}><SourceContext {...props} /></Show>
      </div>
      <Button class="text-button backlink-beside" onClick={() => props.onOpen(target(), true)}>Open beside</Button>
    </div>
  </div>;
}

export function BlockReferenceCount(props: {
  id: string;
  count: number;
  version: number;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  function Sources() {
    let request: AbortController | undefined;
    onCleanup(() => request?.abort());
    const [rows] = createResource(() => [props.id, props.version] as const, async ([id]) => {
      request?.abort();
      request = new AbortController();
      return props.notebook.api.backlinks(id, 100, request.signal);
    });
    const values = createMemo(() => new Map((rows.error ? [] : rows() ?? []).map(row => [row.source.id, row])));
    const ids = createMemo(() => [...values().keys()]);
    return <>
      <Show when={rows.loading && !rows()}><p role="status">Loading backlinks…</p></Show>
      <Show when={rows.error}><p role="alert">Couldn't load backlinks.</p></Show>
      <For each={ids()}>{id => <BacklinkSource block={values().get(id)!.source} page={values().get(id)!.page} notebook={props.notebook} onOpen={(target, beside) => { setAnchor(undefined); props.onOpen(target, beside); }} context breadcrumb />}</For>
      <Show when={!rows.loading && !rows.error && !ids().length}><p>No backlinks.</p></Show>
    </>;
  }
  return <><Button class="block-reference-count" label={`${props.count} ${props.count === 1 ? 'backlink' : 'backlinks'}`} aria-haspopup="dialog" aria-expanded={!!anchor()} onClick={event => setAnchor(previous => previous ? undefined : event.currentTarget)}>{props.count}</Button>
    <Show when={anchor()}>{element => <Popup anchor={element()} label="Block backlinks" class="block-backlinks-popup" onDismiss={() => setAnchor(undefined)}><Sources /></Popup>}</Show>
  </>;
}
