import { createMemo, createSignal } from 'solid-js';
import type { FieldDefinition } from '../api/types';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { fieldNameProblem, kindLabels } from './kinds';

type FieldRow = { kind: 'field'; field: FieldDefinition; template: boolean } | { kind: 'new'; name: string };

/**
 * Pick a field by name: `template` fields first in their order, then the rest by name, skipping `exclude`.
 * A name no field has offers Create field when `onCreate` is given.
 */
export function FieldPicker(props: {
  anchor: PopupAnchor; label: string; fields: readonly FieldDefinition[]; template?: readonly string[]; exclude?: ReadonlySet<string>;
  onPick(field: FieldDefinition): void; onCreate?(name: string): void; onDismiss(): void;
}) {
  const [query, setQuery] = createSignal('');
  const rows = createMemo<FieldRow[]>(() => {
    const needle = query().trim().toLowerCase();
    const template = props.template ?? [];
    const byId = new Map(props.fields.map(field => [field.id, field]));
    const available = (field: FieldDefinition | undefined): field is FieldDefinition => !!field && !props.exclude?.has(field.id) && field.name.toLowerCase().includes(needle);
    const first = template.map(id => byId.get(id)).filter(available);
    const rest = props.fields.filter(field => !template.includes(field.id) && available(field)).sort((a, b) => a.name.localeCompare(b.name));
    const result: FieldRow[] = [...first.map(field => ({ kind: 'field' as const, field, template: true })), ...rest.map(field => ({ kind: 'field' as const, field, template: false }))];
    const exact = props.fields.some(field => field.name.toLowerCase() === needle);
    if (props.onCreate && needle && !exact && !fieldNameProblem(query())) result.push({ kind: 'new', name: query().trim() });
    return result;
  });
  return <Picker<FieldRow> anchor={props.anchor} label={props.label} width={320} query={query()} onQuery={setQuery} placeholder="Field name"
    items={rows()} key={row => row.kind === 'field' ? row.field.id : `new:${row.name}`}
    section={row => row.kind === 'field' ? row.template ? 'Template' : props.template?.length ? 'Other fields' : undefined : undefined}
    onPick={row => row.kind === 'field' ? props.onPick(row.field) : props.onCreate?.(row.name)} onDismiss={props.onDismiss}
    row={row => row.kind === 'field'
      ? <><Icon name="field" /><span class="picker-text">{row.field.name}</span><span class="picker-meta">{kindLabels[row.field.kind]}</span></>
      : <><Icon name="plus" /><span class="picker-text">Create field “{row.name}”</span></>}
    empty={props.exclude?.size ? 'No other fields.' : 'No fields yet.'} />;
}
