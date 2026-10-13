import { createMemo, createResource, createSignal } from 'solid-js';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { createInstance, instancePages } from './instances';
import { completeNames } from '../outline/names';

type InstanceRow = { kind: 'page'; page: Block; alias: string | null } | { kind: 'create'; title: string; type?: Block };

export function InstancePicker(props: {
  anchor: PopupAnchor; field: FieldDefinition; notebook: NotebookClient; current?: string;
  onPick(page: Block): void | Promise<void>; onDismiss(): void; onError(message: string): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [pages] = createResource(() => ({ targets: props.field.targets, sequence: props.notebook.changeSequence() }), ({ targets }) => instancePages(props.notebook, targets));
  const [types] = createResource(() => props.field.targets, targets => Promise.all(targets.map(id => props.notebook.api.block(id))));
  const [matches] = createResource(() => pages() && { query: query(), pages: pages()!, sequence: props.notebook.changeSequence() }, state => completeNames(props.notebook, state.query, state.pages));
  const rows = createMemo<InstanceRow[]>(() => {
    const title = query().trim();
    const rows: InstanceRow[] = (matches()?.rows ?? []).map(match => ({ kind: 'page', ...match }));
    if (title && matches()?.canCreate && !matches.loading && !matches.error && !pages.loading && !pages.error && !types.error) {
      if (props.field.targets.length) rows.push(...(types() ?? []).filter(type => !type.archived).map(type => ({ kind: 'create' as const, title, type })));
      else rows.push({ kind: 'create', title });
    }
    return rows;
  });
  async function pick(row: InstanceRow) {
    if (busy()) return;
    setBusy(true);
    try { await props.onPick(row.kind === 'page' ? row.page : await createInstance(props.notebook, row.title, row.type?.text)); }
    catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Picker<InstanceRow> anchor={props.anchor} label={props.field.name} query={query()} onQuery={setQuery} placeholder="Page name"
    items={busy() ? [] : rows()} key={row => row.kind === 'page' ? row.page.id : `create:${row.type?.id ?? ''}`}
    onPick={row => void pick(row)} onDismiss={props.onDismiss}
    row={row => row.kind === 'page' ? <><Icon name={row.page.id === props.current ? 'check' : 'page'} /><span class="picker-text">{row.page.text}</span>{row.alias && <span class="reference-via">via {row.alias}</span>}</>
      : <><Icon name="plus" /><span class="picker-text">Create {row.type?.text.toLowerCase() ?? 'page'} “{row.title}”</span></>}
    empty={busy() ? 'Creating…' : pages.error || types.error || matches.error ? 'Could not load pages.' : pages.loading || matches.loading ? 'Loading…' : 'No matching pages.'} />;
}
