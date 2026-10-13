import { For, Show, createMemo, createResource, onCleanup } from 'solid-js';
import type { RelationRow } from '../api/types';
import type { BlockState, NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { plainText } from './names';
import { incomingRelationLabels, relationLabels } from './relations';
import './relations.css';

interface RelationProps {
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

/** Incoming names describe the source, but always open its authored reading, not its holder page. */
export function IncomingRelationLine(props: RelationProps & { rows: readonly RelationRow[] }) {
  return <Show when={props.rows.length}><div class="relation-line" onMouseDown={event => event.stopPropagation()}>
    <For each={props.rows}>{(row, index) => {
      const source = row.source.block.block;
      const label = createMemo(() => {
        const holder = row.source.holder_id;
        const text = holder ? props.notebook.lookup(holder)()?.text : props.notebook.lookup(source.id)()?.text ?? source.text;
        return plainText(text ?? '', id => props.notebook.lookup(id)) || (holder ? 'Loading holder…' : 'Empty block');
      });
      return <><Show when={index() > 0}><span aria-hidden="true"> · </span></Show><span>{incomingRelationLabels[row.kind]} <Button onClick={event => { event.stopPropagation(); props.onOpen({ kind: 'page', pageId: row.source.block.page.id, blockId: source.kind === 'block' ? source.id : undefined }, event.shiftKey); }}>{label()}</Button></span></>;
    }}</For>
  </div></Show>;
}

/** Visible targets share the outline's settled-change clock; unreferenced rows issue no query. */
export function IncomingRelations(props: RelationProps & { target: string; version: number; enabled?: boolean }) {
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());
  const [rows] = createResource(() => props.enabled === false ? false : `${props.target}:${props.version}:${props.notebook.connection() === 'live'}`, async () => {
    request?.abort();
    request = new AbortController();
    return props.notebook.api.relations({ target: props.target }, request.signal);
  });
  return <Show when={props.enabled !== false}>
    <Show when={!rows.error} fallback={<div class="relation-line" role="status">Relations unavailable.</div>}><IncomingRelationLine rows={rows() ?? []} notebook={props.notebook} onOpen={props.onOpen} /></Show>
  </Show>;
}

/** Reading cards show authored edges as apparatus, never as reading prose. */
export function OutgoingRelations(props: RelationProps & { rows: readonly BlockState[] }) {
  return <Show when={props.rows.length}><div class="relation-line">
    <For each={props.rows}>{(row, index) => <Show when={row.relation}>{relation => {
      const target = () => relation().target_id ? props.notebook.lookup(relation().target_id!)() : null;
      const label = () => {
        const block = target();
        return block ? plainText(block.text, id => props.notebook.lookup(id)) || 'Empty block' : relation().target_id ? 'Loading reference…' : 'No target';
      };
      return <><Show when={index() > 0}><span aria-hidden="true"> · </span></Show><span>{relationLabels[relation().kind]} <Button onClick={event => {
        const block = target();
        props.onOpen({ kind: 'page', pageId: block?.page_id ?? row.pageId, blockId: block ? block.kind === 'block' ? block.id : undefined : row.id }, event.shiftKey);
      }}>{label()}</Button><Show when={relation().problem}>{problem => <span class="relation-problem" role="img" aria-label={problem()} title={problem()}><Icon name="warning" /></span>}</Show></span></>;
    }}</Show>}</For>
  </div></Show>;
}
