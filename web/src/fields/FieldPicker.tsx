import { Show, createMemo, createSignal } from 'solid-js';
import type { FieldDefinition, FieldKind } from '../api/types';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { fieldKinds, fieldNameProblem, kindLabels } from './kinds';
import { Menu } from '../ui/Menu';

type FieldRow = { kind: 'field'; field: FieldDefinition; template: boolean } | { kind: 'new' | 'as'; name: string };

/**
 * Pick a field by name: `template` fields first in their order, then the rest by name, skipping `exclude`.
 * A new name offers Text or the kind list when `onCreate` is given.
 */
export function FieldPicker(props: {
  anchor: PopupAnchor; label: string; fields: readonly FieldDefinition[]; template?: readonly string[]; templateLabel?: string; exclude?: ReadonlySet<string>;
  onPick(field: FieldDefinition): void; onCreate?(name: string, kind: FieldKind): void; onDismiss(): void;
}) {
  const [query, setQuery] = createSignal('');
  const [creating, setCreating] = createSignal<string | null>(null);
  const rows = createMemo<FieldRow[]>(() => {
    const needle = query().trim().toLowerCase();
    const template = props.template ?? [];
    const byId = new Map(props.fields.map(field => [field.id, field]));
    const available = (field: FieldDefinition | undefined): field is FieldDefinition => !!field && !field.archived && !!field.name.trim() && !props.exclude?.has(field.id) && field.name.toLowerCase().includes(needle);
    const first = template.map(id => byId.get(id)).filter(available);
    const rest = props.fields.filter(field => !template.includes(field.id) && available(field)).sort((a, b) => a.name.localeCompare(b.name));
    const result: FieldRow[] = [...first.map(field => ({ kind: 'field' as const, field, template: true })), ...rest.map(field => ({ kind: 'field' as const, field, template: false }))];
    const exact = props.fields.some(field => field.name.toLowerCase() === needle);
    if (props.onCreate && needle && !exact && !fieldNameProblem(query())) result.push({ kind: 'new', name: query().trim() }, { kind: 'as', name: query().trim() });
    return result;
  });
  return <Show keyed when={creating()} fallback={<Picker<FieldRow> anchor={props.anchor} label={props.label} width={320} query={query()} onQuery={setQuery} placeholder="Field name"
    items={rows()} key={row => row.kind === 'field' ? row.field.id : `${row.kind}:${row.name}`}
    section={row => row.kind === 'field' ? row.template ? props.templateLabel ?? 'Template' : props.template?.length ? 'Other fields' : undefined : undefined}
    onPick={row => row.kind === 'field' ? props.onPick(row.field) : row.kind === 'as' ? setCreating(row.name) : props.onCreate?.(row.name, 'text')} onDismiss={props.onDismiss}
    row={row => row.kind === 'field'
      ? <><Icon name="field" /><span class="picker-text">{row.field.name}</span><span class="picker-meta">{kindLabels[row.field.kind]}</span></>
      : <><Icon name="plus" /><span class="picker-text">{row.kind === 'as' ? `Create field “${row.name}” as…` : `Create text field “${row.name}”`}</span></>}
    empty={query().trim() ? 'No matching fields.' : props.exclude?.size ? 'No other fields.' : 'No fields yet.'} />}>{name => <Menu anchor={props.anchor} label="Kind" header={<div class="menu-section">Create field “{name}” as…</div>} onDismiss={props.onDismiss} items={fieldKinds.map(kind => ({ label: kindLabels[kind], action: () => props.onCreate?.(name, kind) }))} />}</Show>;
}
