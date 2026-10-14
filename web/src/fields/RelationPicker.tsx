import { createMemo, createResource, createSignal } from 'solid-js';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { createInstance, relationCandidates, relationMembers } from './instances';
import type { RelationCandidate } from './instances';
import { SOURCE_TARGET, typeTargets } from './targets';

type RelationRow = { kind: 'target'; target: RelationCandidate } | { kind: 'create'; title: string; type?: Block; source?: boolean };

/**
 * Picks a relation's target: members of its Links to types, or any page and searched blocks. Creation files a
 * page only for types whose members are all pages, so a picker never makes a page out of a block type.
 */
export function RelationPicker(props: {
  anchor: PopupAnchor; field: FieldDefinition; notebook: NotebookClient; current?: string; owner?: { id: string; page: string };
  onPick(target: Block): void | Promise<void>; onDismiss(): void; onError(message: string): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [members] = createResource(() => ({ targets: props.field.targets, sequence: props.notebook.changeSequence() }), ({ targets }) => relationMembers(props.notebook, targets));
  const [types] = createResource(() => props.field.targets, targets => Promise.all(typeTargets(targets).map(id => props.notebook.api.block(id))));
  const [matches] = createResource(() => members() && { query: query(), members: members()!, sequence: props.notebook.changeSequence() },
    state => relationCandidates(props.notebook, state.members, props.field.targets.length > 0, state.query, props.owner));
  const rows = createMemo<RelationRow[]>(() => {
    const title = query().trim();
    const rows: RelationRow[] = (matches()?.rows ?? []).map(target => ({ kind: 'target', target }));
    if (title && matches()?.canCreate && !matches.loading && !matches.error && !members.loading && !members.error && !types.error) {
      if (props.field.targets.includes(SOURCE_TARGET)) rows.push({ kind: 'create', title, source: true });
      if (props.field.targets.length) rows.push(...(types() ?? []).filter(type => !type.archived).map(type => ({ kind: 'create' as const, title, type })));
      else rows.push({ kind: 'create', title });
    }
    return rows;
  });
  async function pick(row: RelationRow) {
    if (busy()) return;
    setBusy(true);
    try { await props.onPick(row.kind === 'target' ? row.target.block : await createInstance(props.notebook, row.title, row.type?.text, row.source)); }
    catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const blocks = () => !props.field.targets.length || !!members()?.blocks.length;
  return <Picker<RelationRow> anchor={props.anchor} label={props.field.name} query={query()} onQuery={setQuery} placeholder={blocks() ? 'Find a page or block' : 'Page name'}
    items={busy() ? [] : rows()} key={row => row.kind === 'target' ? row.target.block.id : `create:${row.source ? SOURCE_TARGET : row.type?.id ?? ''}`}
    initial={Math.max(0, rows().findIndex(row => row.kind === 'target' && row.target.block.id === props.current))}
    isCurrent={row => row.kind === 'target' && row.target.block.id === props.current}
    section={row => row.kind !== 'target' ? undefined : row.target.here ? 'On this page' : !row.target.page ? (blocks() ? 'Pages' : undefined) : 'Blocks'}
    onPick={row => void pick(row)} onDismiss={props.onDismiss}
    row={row => row.kind === 'target'
      ? <><Icon name={row.target.block.id === props.current ? 'check' : row.target.page ? 'bullet' : 'page'} /><span class="picker-text" title={row.target.label}>{row.target.label}</span>
        {row.target.alias && <span class="reference-via">via {row.target.alias}</span>}
        {row.target.page && !row.target.here && <span class="picker-meta">{row.target.page.text}</span>}</>
      : <><Icon name="plus" /><span class="picker-text">Create {row.source ? 'source' : row.type?.text.toLowerCase() ?? 'page'} “{row.title}”</span></>}
    empty={busy() ? 'Creating…' : members.error || types.error || matches.error ? 'Could not load targets.' : members.loading || matches.loading ? 'Loading…'
      : !props.field.targets.length && query().trim().length < 3 && query().trim() ? 'No matching pages. Keep typing to search blocks.' : 'No matches.'} />;
}
