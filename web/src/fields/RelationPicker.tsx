import { createMemo, createResource, createSignal } from 'solid-js';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { createInstance, relationCandidates, relationMembers } from './instances';
import type { RelationCandidate, RelationCandidates, RelationMembers } from './instances';
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
  let membersRequest: Promise<RelationMembers> | undefined;
  const [members] = createResource(() => ({ targets: props.field.targets, sequence: props.notebook.changeSequence() }), ({ targets }) => membersRequest = relationMembers(props.notebook, targets));
  const [types] = createResource(() => props.field.targets, targets => Promise.all(typeTargets(targets).map(id => props.notebook.api.block(id))));
  let candidateRequest: { query: string; promise: Promise<RelationCandidates> } | undefined;
  const [matches] = createResource(() => members() && { query: query(), members: members()!, sequence: props.notebook.changeSequence() }, state => {
    const promise = relationCandidates(props.notebook, state.members, props.field.targets.length > 0, state.query, props.owner);
    candidateRequest = { query: state.query, promise };
    return promise.then(result => ({ ...result, query: state.query }));
  });
  const rows = createMemo<RelationRow[]>(() => {
    const title = query().trim();
    const rows: RelationRow[] = (!matches.loading && matches()?.query === query() ? matches()?.rows ?? [] : []).map(target => ({ kind: 'target', target }));
    if (title && matches()?.query === query() && matches()?.canCreate && !matches.loading && !matches.error && !members.loading && !members.error && !types.error) {
      if (props.field.targets.includes(SOURCE_TARGET)) rows.push({ kind: 'create', title, source: true });
      if (props.field.targets.length) rows.push(...(types() ?? []).filter(type => !type.archived).map(type => ({ kind: 'create' as const, title, type })));
      else rows.push({ kind: 'create', title });
    }
    return rows;
  });
  async function pick(row?: RelationRow) {
    if (busy()) return;
    const wanted = query();
    const request = candidateRequest?.query === wanted ? candidateRequest.promise
      : (membersRequest ?? relationMembers(props.notebook, props.field.targets)).then(found => relationCandidates(props.notebook, found, props.field.targets.length > 0, wanted, props.owner));
    setBusy(true);
    try {
      // Enter owns this query now, even while the visible list belongs to an older request.
      const found = await request;
      let chosen = row;
      if (!chosen) {
        if (found.rows[0]) chosen = { kind: 'target', target: found.rows[0] };
        else if (wanted.trim() && found.canCreate) {
          if (props.field.targets.includes(SOURCE_TARGET)) chosen = { kind: 'create', title: wanted.trim(), source: true };
          else {
            const allowed = await Promise.all(typeTargets(props.field.targets).map(id => props.notebook.api.block(id)));
            const type = allowed.find(type => !type.archived);
            if (type || !props.field.targets.length) chosen = { kind: 'create', title: wanted.trim(), type };
          }
        }
      }
      if (chosen) await props.onPick(chosen.kind === 'target' ? chosen.target.block : await createInstance(props.notebook, chosen.title, chosen.type?.text, chosen.source));
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const blocks = () => !props.field.targets.length || !!members()?.blocks.length;
  return <Picker<RelationRow> anchor={props.anchor} label={props.field.name} query={query()} onQuery={setQuery} placeholder={blocks() ? 'Find a page or block' : 'Page name'}
    items={busy() ? [] : rows()} key={row => row.kind === 'target' ? row.target.block.id : `create:${row.source ? SOURCE_TARGET : row.type?.id ?? ''}`}
    initial={Math.max(0, rows().findIndex(row => row.kind === 'target' && row.target.block.id === props.current))}
    isCurrent={row => row.kind === 'target' && row.target.block.id === props.current}
    section={row => row.kind !== 'target' ? undefined : row.target.here ? 'On this page' : !row.target.page ? (blocks() ? 'Pages' : undefined) : 'Blocks'}
    onPick={row => void pick(row)} onDismiss={() => { if (!busy()) props.onDismiss(); }}
    onPendingPick={event => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) void pick();
    }}
    row={row => row.kind === 'target'
      ? <><Icon name={row.target.block.id === props.current ? 'check' : row.target.page ? 'bullet' : 'page'} /><span class="picker-text" title={row.target.label}>{row.target.label}</span>
        {row.target.alias && <span class="reference-via">via {row.target.alias}</span>}
        {row.target.page && !row.target.here && <span class="picker-meta">{row.target.page.text}</span>}</>
      : <><Icon name="plus" /><span class="picker-text">Create {row.source ? 'source' : row.type?.text.toLowerCase() ?? 'page'} “{row.title}”</span></>}
    empty={busy() ? 'Choosing…' : members.error || types.error || matches.error ? 'Could not load targets.' : members.loading || matches.loading ? 'Loading…'
      : !props.field.targets.length && query().trim().length < 3 && query().trim() ? 'No matching pages. Keep typing to search blocks.' : 'No matches.'} />;
}
