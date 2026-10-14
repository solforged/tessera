import { opensBeside } from '../shell/beside';
import { For, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { FieldOwner, IncomingFieldValue, RelationRow } from '../api/types';
import type { BlockState, NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { plainText, targetLabel } from './names';
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
      return <><Show when={index() > 0}><span aria-hidden="true"> · </span></Show><span>{incomingRelationLabels[row.kind]} <Button onClick={event => { event.stopPropagation(); props.onOpen({ kind: 'page', pageId: row.source.block.page.id, blockId: source.kind === 'block' ? source.id : undefined }, opensBeside(event)); }}>{label()}</Button></span></>;
    }}</For>
  </div></Show>;
}

/** Built-in relations their targets already list: creators as Works, collections as their members. */
const listedElsewhere = new Set(['author', 'editor', 'translator', 'collections']);
const ownersShown = 3;

/** Relation fields read from the target as `← name`, one group per field, each owner opening where it is written. */
export function IncomingFieldLine(props: RelationProps & { rows: readonly IncomingFieldValue[] }) {
  const groups = createMemo(() => {
    const byField = new Map<string, { id: string; name: string; owners: FieldOwner[] }>();
    for (const row of props.rows) {
      if (listedElsewhere.has(row.field_name.trim().toLowerCase())) continue;
      const group = byField.get(row.field_id) ?? { id: row.field_id, name: row.field_name, owners: [] };
      if (!group.owners.some(owner => owner.id === row.owner.id)) group.owners.push(row.owner);
      byField.set(row.field_id, group);
    }
    return [...byField.values()];
  });
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const label = (owner: FieldOwner) => targetLabel(props.notebook.lookup(owner.id)()?.text ?? owner.text, props.notebook.lookup) || 'Empty block';
  return <Show when={groups().length}><div class="relation-line incoming-fields" onMouseDown={event => event.stopPropagation()}>
    <For each={groups()}>{(group, index) => {
      const shown = () => expanded().has(group.id) ? group.owners : group.owners.slice(0, ownersShown);
      return <><Show when={index() > 0}><span aria-hidden="true"> · </span></Show><span><span class="incoming-field-name" title={`Values of ${group.name} that link here`}>← {group.name}</span> <For each={shown()}>{(owner, at) => <><Show when={at() > 0}><span aria-hidden="true">, </span></Show><Button title={owner.id === owner.page_id ? owner.page_title : `In ${owner.page_title}`} onClick={event => { event.stopPropagation(); props.onOpen({ kind: 'page', pageId: owner.page_id, blockId: owner.id === owner.page_id ? undefined : owner.id }, opensBeside(event)); }}>{label(owner)}</Button></>}</For>
        <Show when={shown().length < group.owners.length}> <Button onClick={event => { event.stopPropagation(); setExpanded(previous => new Set(previous).add(group.id)); }}>{`+${group.owners.length - shown().length} more`}</Button></Show></span></>;
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
    const [relations, fields] = await Promise.all([
      props.notebook.api.relations({ target: props.target }, request.signal),
      // Relation fields are secondary here; an older service without the route still shows arguments.
      props.notebook.api.incomingFields(props.target, request.signal).catch(() => [] as IncomingFieldValue[]),
    ]);
    return { relations, fields };
  });
  return <Show when={props.enabled !== false}>
    <Show when={!rows.error} fallback={<div class="relation-line" role="status">Arguments unavailable.</div>}>
      <IncomingRelationLine rows={rows()?.relations ?? []} notebook={props.notebook} onOpen={props.onOpen} />
      <IncomingFieldLine rows={rows()?.fields ?? []} notebook={props.notebook} onOpen={props.onOpen} />
    </Show>
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
        props.onOpen({ kind: 'page', pageId: block?.page_id ?? row.pageId, blockId: block ? block.kind === 'block' ? block.id : undefined : row.id }, opensBeside(event));
      }}>{label()}</Button><Show when={relation().problem}>{problem => <span class="relation-problem" role="img" aria-label={problem()} title={problem()}><Icon name="warning" /></span>}</Show></span></>;
    }}</Show>}</For>
  </div></Show>;
}
