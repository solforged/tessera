import { createMemo, createResource, createSignal } from 'solid-js';
import { ulid } from 'ulid';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient, RelationPickIntent } from '../document/contract';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { relationCandidates, relationMembers } from './instances';
import type { RelationCandidate } from './instances';
import { SOURCE_TARGET, typeTargets } from './targets';
import { noteIndex, noteKindIcon } from '../notes/kinds';

type RelationRow = { kind: 'target'; target: RelationCandidate } | { kind: 'create'; title: string; type?: Block; source?: boolean };

/**
 * Picks a relation's target: members of its Links to types, or any page and searched blocks. Creation files a
 * page only for types whose members are all pages, so a picker never makes a page out of a block type.
 */
export function RelationPicker(props: {
  anchor: PopupAnchor; field: FieldDefinition; notebook: NotebookClient; current?: string; owner?: { id: string; page: string };
  onPick(intent: RelationPickIntent): void | Promise<void>; onDismiss(): void; onError(message: string): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [members] = createResource(() => ({ targets: props.field.targets, sequence: props.notebook.changeSequence() }), ({ targets }) => relationMembers(props.notebook, targets));
  const [types] = createResource(() => props.field.targets, targets => Promise.all(typeTargets(targets).map(id => props.notebook.api.block(id))));
  const index = noteIndex(props.notebook);
  const targetKind = createMemo(() => props.field.targets.length === 1
    ? index()?.kinds.find(kind => kind.type_id === props.field.targets[0] || kind.key === props.field.targets[0])
    : undefined);
  const prompt = createMemo(() => {
    const kind = targetKind()?.name.toLowerCase();
    return kind ? `Find ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}…` : `${props.field.name}…`;
  });
  const [matches] = createResource(() => members() && { query: query(), members: members()!, sequence: props.notebook.changeSequence() }, state =>
    relationCandidates(props.notebook, state.members, props.field.targets.length > 0, state.query, props.owner).then(result => ({ ...result, query: state.query })));
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
    setBusy(true);
    try {
      // Persist the accepted query before any lookup. The document outbox owns its resolution/replay.
      await props.onPick({
        query: query(), targets: [...props.field.targets], owner: props.owner,
        ...(row?.kind === 'target' ? { targetId: row.target.block.id } : {
          createId: ulid(),
          ...(row?.kind === 'create' ? { create: { typeTitle: row.type?.text, source: row.source } } : {}),
        }),
      });
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const blocks = () => !props.field.targets.length || !!members()?.blocks.length;
  // Place the popup once, at the size of its first rows; refreshes after that keep it ready.
  const loaded = () => members.state === 'errored' || (members.state !== 'pending' && members.state !== 'unresolved' && matches.state !== 'pending' && matches.state !== 'unresolved');
  return <Picker<RelationRow> anchor={props.anchor} label={props.field.name} query={query()} onQuery={setQuery} placeholder={prompt()} ready={loaded()}
    items={busy() ? [] : rows()} key={row => row.kind === 'target' ? row.target.block.id : `create:${row.source ? SOURCE_TARGET : row.type?.id ?? ''}`}
    initial={Math.max(0, rows().findIndex(row => row.kind === 'target' && row.target.block.id === props.current))}
    isCurrent={row => row.kind === 'target' && row.target.block.id === props.current}
    section={row => row.kind !== 'target' ? undefined : row.target.here ? 'On this atom' : !row.target.page ? (blocks() ? targetKind()?.plural ?? 'Atoms' : undefined) : targetKind()?.plural ?? 'Atoms'}
    onPick={row => void pick(row)} onDismiss={() => { if (!busy()) props.onDismiss(); }}
    onPendingPick={event => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) void pick();
    }}
    row={row => row.kind === 'target'
      ? <><Icon name={row.target.block.id === props.current ? 'check' : targetKind() ? noteKindIcon(targetKind()!) : row.target.page ? 'bullet' : 'page'} /><span class="picker-text" title={row.target.label}>{row.target.label}</span>
        {row.target.alias && <span class="reference-via">via {row.target.alias}</span>}
        {row.target.page && !row.target.here && <span class="picker-meta">{row.target.page.text}</span>}</>
      : <><Icon name="plus" /><span class="picker-text">Create {row.source ? 'source' : row.type?.text.toLowerCase() ?? 'page'} “{row.title}”</span></>}
    empty={busy() ? 'Choosing…' : members.error || types.error || matches.error ? 'Could not load targets.' : members.loading || matches.loading ? 'Loading…'
      : !props.field.targets.length && query().trim().length < 3 && query().trim() ? 'No matching atoms. Keep typing to search atoms.' : 'No matches.'} />;
}
