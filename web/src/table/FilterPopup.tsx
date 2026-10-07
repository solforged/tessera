import { Show, createMemo, createSignal } from 'solid-js';
import type { FieldDefinition, Filter, FilterOp } from '../api/types';
import { partialDatePlaceholder } from '../fields/kinds';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { filterLabels } from './query';

type FilterRow = { kind: 'field'; id: string; name: string } | { kind: 'new-field'; name: string } | { kind: 'op'; op: FilterOp } | { kind: 'value'; value: string; label: string };
/** Three picker steps: field, operator, value. A chip trail above the rows shows what is chosen so far; Backspace on an empty query steps back. */
export function FilterPopup(props: { anchor: HTMLElement; fields: readonly FieldDefinition[]; initialField: string; initialFilter?: Filter; label?: string; onDismiss(): void; onNewField?(name: string): Promise<string>; onAdd(filter: Filter): void }) {
  const initialField = props.initialFilter?.field ?? props.initialField;
  const initial = props.fields.find(candidate => candidate.id === initialField);
  const [field, setField] = createSignal<{ id: string | null; name: string } | null>(initial ? { id: initial.id, name: initial.name } : props.initialFilter ? { id: initialField, name: initialField } : null);
  const [op, setOp] = createSignal<FilterOp | null>(props.initialFilter?.op ?? null);
  const [query, setQuery] = createSignal(props.initialFilter?.value ?? '');
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const step = () => !field() ? 'field' : !op() || op() === 'present' || op() === 'set' || op() === 'empty' ? 'op' : 'value';
  const definition = () => props.fields.find(candidate => candidate.id === field()?.id);
  const needle = () => query().trim().toLocaleLowerCase();
  const rows = createMemo((): FilterRow[] => {
    if (step() === 'field') {
      const matching = props.fields.filter(candidate => candidate.name.toLocaleLowerCase().includes(needle())).map((candidate): FilterRow => ({ kind: 'field', id: candidate.id, name: candidate.name }));
      const exact = props.fields.some(candidate => candidate.name.toLocaleLowerCase() === needle());
      return props.onNewField && query().trim() && !exact ? [...matching, { kind: 'new-field', name: query().trim() }] : matching;
    }
    if (step() === 'op') return (Object.keys(filterLabels) as FilterOp[]).filter(candidate => filterLabels[candidate].includes(needle())).map(candidate => ({ kind: 'op', op: candidate }));
    const options = definition()?.options ?? [];
    const choices = options.filter(option => option.text.toLocaleLowerCase().includes(needle())).map((option): FilterRow => ({ kind: 'value', value: option.text, label: option.text }));
    const unchanged = props.initialFilter?.value === query();
    const typed = unchanged ? query() : query().trim();
    return (typed || unchanged) && !options.some(option => option.text === typed) ? [...choices, { kind: 'value', value: typed, label: `“${typed}”` }] : choices;
  });
  const finish = async (value: string | null) => {
    if (busy()) return; setBusy(true);
    try {
      const chosen = field()!;
      const id = chosen.id ?? await props.onNewField?.(chosen.name);
      if (!id) throw new Error('Choose a field.');
      props.onAdd({ field: id, op: op()!, value });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const pick = (row: FilterRow) => {
    setQuery(''); setError('');
    if (row.kind === 'field') setField({ id: row.id, name: row.name });
    else if (row.kind === 'new-field') setField({ id: null, name: row.name });
    else if (row.kind === 'op') { setOp(row.op); if (row.op === 'present' || row.op === 'set' || row.op === 'empty') void finish(null); }
    else void finish(row.value);
  };
  const placeholder = () => step() === 'field' ? 'Field name' : step() === 'op' ? 'Condition' : definition()?.kind === 'date' ? partialDatePlaceholder : definition()?.kind === 'choice' ? 'Choose or type a value' : 'Value';
  return <Picker<FilterRow> anchor={props.anchor} width={320} label={props.label ?? (props.initialFilter ? 'Edit condition' : 'Add filter')} onDismiss={props.onDismiss}
    query={query()} onQuery={setQuery} placeholder={placeholder()}
    prefix={<><Show when={field()}>{chosen => <span class="table-chip">{chosen().name}</span>}</Show><Show when={op()}>{chosen => <span class="table-chip">{filterLabels[chosen()]}</span>}</Show></>}
    items={rows()} key={row => row.kind === 'field' ? row.id : row.kind === 'op' ? row.op : row.kind === 'value' ? row.value : 'new'}
    initial={props.initialFilter ? Math.max(0, rows().findIndex(row => row.kind === 'value' ? row.value === props.initialFilter!.value : row.kind === 'op' && row.op === props.initialFilter!.op)) : undefined}
    onPick={pick}
    onKey={event => {
      if (event.key !== 'Backspace' || query()) return false;
      if (op()) setOp(null); else if (field()) setField(null); else return false;
      return true;
    }}
    busy={busy()} error={error() || undefined} empty={step() === 'value' ? 'Type a value.' : 'No matches.'}
    row={row => row.kind === 'field' ? <><Icon name="field" /><span class="picker-text">{row.name}</span></>
      : row.kind === 'new-field' ? <><Icon name="plus" /><span class="picker-text">New field “{row.name}”</span></>
        : row.kind === 'op' ? <span class="picker-text">{filterLabels[row.op]}</span>
          : <span class="picker-text">{row.label}</span>} />;
}
