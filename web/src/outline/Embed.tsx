import { opensBeside } from '../shell/beside';
import { Show, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { BlockText } from './BlockText';
import { BlockTree } from './BlockTree';
import type { TreeRow } from './BlockTree';
import { streamDay } from './streams';
import './streams.css';

export function Embed(props: {
  target: string;
  fallback: JSX.Element;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const tree = props.notebook.watchSubtree(props.target);
  onCleanup(tree.release);
  const source = () => tree.value()?.rows.length ? props.notebook.lookup(props.target)() : undefined;
  const page = () => tree.value()?.page;
  const [expanded, setExpanded] = createSignal(false);
  const descendants = createMemo(() => tree.value()?.rows.slice(1) ?? []);
  const rows = createMemo<TreeRow[]>(() => (expanded() ? descendants() : descendants().slice(0, 12)).map(row => ({ id: row.block.id, depth: row.depth - 1, role: 'body' })));
  return <Show when={source()?.kind === 'block'} fallback={props.fallback}>
    <div class="outline-embed" data-embed-target={props.target}>
      <div class="stream-embed-line">
        <div class="static-text"><BlockText text={source()?.text ?? ''} blockId={props.target} notebook={props.notebook} onOpen={props.onOpen} /></div>
        <Button class="stream-provenance" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); props.onOpen({ kind: 'page', pageId: source()!.page_id, blockId: props.target }, opensBeside(event)); }}>{page()?.kind === 'journal' ? streamDay(page()!.text) : page()?.text}</Button>
      </div>
      <Show when={rows().length}><div class="stream-embed-children" onMouseDown={event => event.stopPropagation()}>
        <BlockTree rows={rows()} block={id => props.notebook.lookup(id)() ?? undefined} notebook={props.notebook} onOpen={props.onOpen} />
      </div></Show>
      <Show when={!expanded() && descendants().length > 12}><Button class="stream-more" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setExpanded(true); }}>Show {descendants().length - 12} more</Button></Show>
      <Show when={tree.value()?.truncated}><span class="stream-fact">More rows at source</span></Show>
      <Show when={tree.error()}><p role="alert">{tree.error()}</p></Show>
    </div>
  </Show>;
}
