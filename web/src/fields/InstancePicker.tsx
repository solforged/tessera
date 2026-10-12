import { createMemo, createResource, createSignal } from 'solid-js';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { createInstance, instancePages } from './instances';

type InstanceRow = { kind: 'page'; page: Block } | { kind: 'create'; title: string; type?: Block };

export function InstancePicker(props: {
  anchor: PopupAnchor; field: FieldDefinition; notebook: NotebookClient;
  onPick(page: Block): void; onDismiss(): void; onError(message: string): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [pages] = createResource(() => ({ targets: props.field.targets, sequence: props.notebook.changeSequence() }), ({ targets }) => instancePages(props.notebook, targets));
  const [types] = createResource(() => props.field.targets, targets => Promise.all(targets.map(id => props.notebook.api.block(id))));
  const rows = createMemo<InstanceRow[]>(() => {
    const title = query().trim(); const needle = title.toLowerCase();
    const matches = (pages() ?? []).filter(page => page.text.toLowerCase().includes(needle));
    const rows: InstanceRow[] = matches.map(page => ({ kind: 'page', page }));
    if (title && !matches.some(page => page.text.toLowerCase() === needle) && !pages.loading && !pages.error && !types.error) {
      if (props.field.targets.length) rows.push(...(types() ?? []).filter(type => !type.archived).map(type => ({ kind: 'create' as const, title, type })));
      else rows.push({ kind: 'create', title });
    }
    return rows;
  });
  async function pick(row: InstanceRow) {
    if (busy()) return;
    setBusy(true);
    try { props.onPick(row.kind === 'page' ? row.page : await createInstance(props.notebook, row.title, row.type?.text)); }
    catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Picker<InstanceRow> anchor={props.anchor} label={props.field.name} query={query()} onQuery={setQuery} placeholder="Page name"
    items={busy() ? [] : rows()} key={row => row.kind === 'page' ? row.page.id : `create:${row.type?.id ?? ''}`}
    onPick={row => void pick(row)} onDismiss={props.onDismiss}
    row={row => row.kind === 'page' ? <><Icon name="page" /><span class="picker-text">{row.page.text}</span></>
      : <><Icon name="plus" /><span class="picker-text">Create {row.type?.text.toLowerCase() ?? 'page'} “{row.title}”</span></>}
    empty={busy() ? 'Creating…' : pages.error || types.error ? 'Could not load pages.' : pages.loading ? 'Loading…' : 'No matching pages.'} />;
}
