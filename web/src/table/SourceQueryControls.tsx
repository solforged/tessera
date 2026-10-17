import { For, Show, createMemo, createSignal } from 'solid-js';
import type { FieldDefinition, IndexKind, Query } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { noteKindIcon } from '../notes/kinds';
import { Picker } from '../ui/Picker';
import { FilterPopup } from './FilterPopup';
import { addFilter, filterLabel, removeFilter } from './query';
import './table.css';
import './source-query.css';

export interface SourceQueryControlsProps {
  query: Query | null;
  /** Registry tags with a type page, as the sidebar index lists them. */
  types: readonly IndexKind[];
  fields: readonly FieldDefinition[];
  notebook: NotebookClient;
  disabled?: boolean;
  sections?: 'all' | 'source' | 'fields';
  onChange(query: Query | null): void;
}
const emptySource: Query = { type: null, text: null, filters: [], sort: [], limit: null };
type TypeChoice = { id: string | null; text: string; icon?: IconName; meta?: string };

/** Tasks and decks constrain canonical sources with the same field picker as tables. */
export function SourceQueryControls(props: SourceQueryControlsProps) {
  const [popup, setPopup] = createSignal<{ kind: 'type' | 'filter'; anchor: HTMLElement } | null>(null);
  const [search, setSearch] = createSignal('');
  const query = () => props.query ?? emptySource;
  const types = createMemo(() => props.types.filter((kind): kind is IndexKind & { type_id: string } => !!kind.type_id));
  const choices = createMemo((): TypeChoice[] => {
    const needle = search().trim().toLocaleLowerCase();
    return [{ id: null, text: 'Any type' }, ...types().filter(kind => kind.name.toLocaleLowerCase().includes(needle)).map(kind => ({ id: kind.type_id, text: kind.name, icon: noteKindIcon(kind), meta: kind.cards ? `${kind.cards} ${kind.cards === 1 ? 'card' : 'cards'}` : undefined }))];
  });
  const update = (value: Query) => {
    if (!props.disabled) props.onChange(value.type || value.text?.trim() || value.filters.length ? value : null);
  };
  return <div class="source-query-controls" role="group" aria-label="Source filters">
    <Show when={props.sections !== 'fields'}>
    <Button class="bordered" disabled={props.disabled} aria-haspopup="dialog" aria-expanded={popup()?.kind === 'type'} onClick={event => { setSearch(''); setPopup({ kind: 'type', anchor: event.currentTarget }); }}>
      {query().type ? types().find(type => type.type_id === query().type)?.name ?? 'Unavailable type' : 'Any type'}<Icon name="down" />
    </Button>
    <input class="input source-query-text" type="search" aria-label="Search source text" placeholder="Search source text" value={query().text ?? ''} disabled={props.disabled} onInput={event => update({ ...query(), text: event.currentTarget.value || null })} />
    </Show>
    <Show when={props.sections !== 'source'}>
    <For each={query().filters}>{(filter, index) => <span class="table-chip">{filterLabel(filter, props.fields, props.notebook)}<Button disabled={props.disabled} label={`Remove ${filterLabel(filter, props.fields, props.notebook)}`} onClick={() => update(removeFilter(query(), index()))}>×</Button></span>}</For>
    <Button disabled={props.disabled || !props.fields.length} title={props.fields.length ? undefined : 'Create field definitions in Fields first'} onClick={event => setPopup({ kind: 'filter', anchor: event.currentTarget })}>+ Filter</Button>
    </Show>
    <Show keyed when={popup()}>{state => state.kind === 'type'
      ? <Picker<TypeChoice> anchor={state.anchor} label="Source type" query={search()} onQuery={setSearch} placeholder="Type name" items={choices()} key={item => item.id ?? 'any'} onDismiss={() => setPopup(null)} onPick={item => { update({ ...query(), type: item.id }); setPopup(null); }} row={item => <><Icon name={item.id === query().type ? 'check' : item.icon ?? 'tag'} /><span class="picker-text">{item.text}</span><Show when={item.meta}><span class="picker-meta">{item.meta}</span></Show></>} empty="No matching types." />
      : <FilterPopup anchor={state.anchor} fields={props.fields} notebook={props.notebook} initialField="" onDismiss={() => setPopup(null)} onAdd={filter => { update(addFilter(query(), filter)); setPopup(null); }} />}</Show>
  </div>;
}
