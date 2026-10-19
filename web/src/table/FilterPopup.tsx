import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Block, FieldDefinition, FieldKind, Filter, FilterOp } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { instancePages, relationMembers } from '../fields/instances';
import { completeNames, targetLabel } from '../outline/names';
import { kindLabels, partialDatePlaceholder } from '../fields/kinds';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { filterOperatorLabel, filterOperators } from './query';

type FilterRow = { kind: 'field'; id: string; name: string; type: FieldKind } | { kind: 'new-field'; name: string } | { kind: 'op'; op: FilterOp } | { kind: 'value'; value: string; label: string };
/** Three picker steps: field, operator, value. A chip trail above the rows shows what is chosen so far; Backspace on an empty query steps back. */
export function FilterPopup(props: { anchor: HTMLElement; fields: readonly FieldDefinition[]; notebook: NotebookClient; initialField: string; initialFilter?: Filter; label?: string; sheet?: boolean; onDismiss(): void; onNewField?(name: string): Promise<string>; onAdd(filter: Filter): void }) {
  const initialField = props.initialFilter?.field ?? props.initialField;
  const initial = props.fields.find(candidate => candidate.id === initialField);
  const [field, setField] = createSignal<{ id: string | null; name: string } | null>(initial ? { id: initial.id, name: initial.name } : props.initialFilter ? { id: initialField, name: initialField } : null);
  const [op, setOp] = createSignal<FilterOp | null>(props.initialFilter?.op ?? (props.sheet && initial?.kind === 'choice' ? 'is' : null));
  const initialIdentity = initial?.kind === 'instance' && (props.initialFilter?.op === 'is' || props.initialFilter?.op === 'is_not');
  const initialValue = props.initialFilter?.value;
  const resolvedInitial = !!initialValue && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(initialValue);
  const [query, setQuery] = createSignal(initial?.kind === 'checkbox' ? '' : initialIdentity && resolvedInitial ? (target => target ? target.kind === 'page' ? target.text : targetLabel(target.text, id => props.notebook.lookup(id)) : '')(props.notebook.lookup(initialValue!)()) : initialValue ?? '');
  const [draftValue, setDraftValue] = createSignal<string | null | undefined>(initialIdentity && !resolvedInitial ? undefined : initialValue);
  const [orEmpty, setOrEmpty] = createSignal(props.initialFilter?.or_empty ?? false);
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const step = () => !field() ? 'field' : !op() || op() === 'present' || op() === 'set' || op() === 'empty' || definition()?.kind === 'checkbox' ? 'op' : 'value';
  const definition = () => props.fields.find(candidate => candidate.id === field()?.id);
  const needle = () => query().trim().toLocaleLowerCase();
  const identity = () => definition()?.kind === 'instance' && (op() === 'is' || op() === 'is_not');
  const unresolved = () => initialIdentity && !resolvedInitial && draftValue() === undefined && query() === initialValue ? `Unresolved value “${initialValue}”. Choose a target.` : '';
  const [pages] = createResource(() => identity() && [definition()!, props.notebook.changeSequence(), definition()?.id === '@cited_in' ? query() : ''] as const, async ([field, , search]) => {
    if (field.id === '@parent' || field.id === '@program' || field.id === '@subject' || field.id === '@question') {
      const questions = await props.notebook.api.questions({ include_inline: true });
      const candidates = questions.filter(row => field.id !== '@program' || !row.info.parent_id).map(row => row.block.block);
      return field.id === '@subject' ? [...await instancePages(props.notebook, []), ...candidates.filter(block => block.kind === 'block')] : candidates;
    }
    if (field.id === '@cited_in') {
      const result = search.trim()
        ? await props.notebook.api.search(search, 100)
        : (await props.notebook.api.query({ source: 'positions', type: null, text: null, filters: [], sort: [], limit: 2000 })).rows.map(row => row.block);
      return [...new Map([...props.notebook.roots().filter(block => !block.archived), ...result.map(row => row.block)].map(block => [block.id, block])).values()];
    }
    if (field.id === '@page') return props.notebook.roots().filter(block => !block.archived);
    if (field.id === '@project') {
      const projects = await props.notebook.api.projects();
      return Promise.all(projects.map(project => props.notebook.api.block(project.block_id)));
    }
    const members = await relationMembers(props.notebook, field.targets);
    return [...members.pages, ...members.blocks.map(row => row.block)];
  });
  const label = (block: Block) => block.kind === 'page' ? block.text : targetLabel(block.text, id => props.notebook.lookup(id)) || 'Empty atom';
  const [names] = createResource(() => identity() && pages() ? { pages: pages()!, query: query() } : false, async ({ pages, query }) => {
    const names = await completeNames(props.notebook, query, pages);
    const other = pages.filter(block => block.kind !== 'page');
    const matches = query.trim() && other.length ? new Set((await props.notebook.api.search(query, 100)).map(row => row.block.id)) : null;
    return { ...names, rows: [...names.rows, ...other.filter(block => !matches || matches.has(block.id)).map(page => ({ page, alias: null }))] };
  });
  const valueError = createMemo(() => identity() && (pages.error || names.error) ? 'Could not load targets.' : '');
  const rows = createMemo((): FilterRow[] => {
    if (step() === 'field') {
      const matching = props.fields.filter(candidate => candidate.name.toLocaleLowerCase().includes(needle())).map((candidate): FilterRow => ({ kind: 'field', id: candidate.id, name: candidate.name, type: candidate.kind }));
      const exact = props.fields.some(candidate => candidate.name.toLocaleLowerCase() === needle());
      return props.onNewField && query().trim() && !exact ? [...matching, { kind: 'new-field', name: query().trim() }] : matching;
    }
    if (step() === 'op') return filterOperators(definition()?.kind).filter(candidate => filterOperatorLabel(candidate, definition()?.kind).includes(needle())).map(candidate => ({ kind: 'op', op: candidate }));
    if (identity()) return (names()?.rows ?? []).map(match => ({ kind: 'value', value: match.page.id, label: match.alias ? `${match.alias} · ${match.page.text}` : label(match.page) }));
    const options = definition()?.options ?? [];
    const choices = options.filter(option => option.text.toLocaleLowerCase().includes(needle())).map((option): FilterRow => ({ kind: 'value', value: definition()?.id.startsWith('@') ? option.id : option.text, label: option.text }));
    if (definition()?.kind === 'choice') return choices;
    if (definition()?.kind === 'date') {
      const dates = [{ value: 'today', label: 'Today' }, { value: '-30d', label: '30 days ago' }, { value: '+7d', label: 'A week from now' }].filter(value => value.label.toLocaleLowerCase().includes(needle())).map((value): FilterRow => ({ kind: 'value', ...value }));
      if (query().trim()) dates.push({ kind: 'value', value: query().trim(), label: `Date: ${query().trim()}` });
      return dates;
    }
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
      props.onAdd({ field: id, op: op()!, value, ...(orEmpty() && definition()?.kind === 'date' && (op() === 'lt' || op() === 'gt') ? { or_empty: true } : {}) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const pick = (row: FilterRow) => {
    setQuery(''); setError(''); setDraftValue(undefined);
    if (row.kind === 'field') { setField({ id: row.id, name: row.name }); setOp(props.sheet && props.fields.find(field => field.id === row.id)?.kind === 'choice' ? 'is' : null); }
    else if (row.kind === 'new-field') { setField({ id: null, name: row.name }); setOp(null); }
    else if (row.kind === 'op') {
      setOp(row.op);
      if (row.op === 'present' || row.op === 'set' || row.op === 'empty') { if (props.sheet) setDraftValue(null); else void finish(null); }
      else if (definition()?.kind === 'checkbox') { if (props.sheet) setDraftValue('true'); else void finish('true'); }
    } else if (props.sheet) setDraftValue(row.value);
    else void finish(row.value);
  };
  const placeholder = () => step() === 'field' ? 'Field name' : step() === 'op' ? 'Condition' : identity() ? 'Choose a target' : definition()?.kind === 'date' ? partialDatePlaceholder : definition()?.kind === 'choice' ? 'Choose an option' : 'Value';
  return <Show when={props.sheet} fallback={<Picker<FilterRow> anchor={props.anchor} width={320} label={props.label ?? (props.initialFilter ? 'Edit condition' : 'Add filter')} onDismiss={props.onDismiss}
    query={query()} onQuery={setQuery} placeholder={placeholder()}
    prefix={<><Show when={field()}>{chosen => <span class="table-chip">{chosen().name}</span>}</Show><Show when={op()}>{chosen => <span class="table-chip">{filterOperatorLabel(chosen(), definition()?.kind)}</span>}</Show><Show when={unresolved()}><span class="table-chip">{unresolved()}</span></Show></>}
    status={<Show when={definition()?.kind === 'date' && (op() === 'lt' || op() === 'gt')}><label class="table-column-choice"><input type="checkbox" checked={orEmpty()} onChange={event => setOrEmpty(event.currentTarget.checked)} />Or empty</label></Show>}
    items={rows()} key={row => row.kind === 'field' ? row.id : row.kind === 'op' ? row.op : row.kind === 'value' ? row.value : 'new'}
    initial={props.initialFilter ? Math.max(0, rows().findIndex(row => row.kind === 'value' ? row.value === props.initialFilter!.value : row.kind === 'op' && row.op === props.initialFilter!.op)) : undefined}
    onPick={pick}
    onKey={event => {
      if (event.key !== 'Backspace' || query()) return false;
      if (op()) { setOp(null); setDraftValue(undefined); } else if (field()) setField(null); else return false;
      return true;
    }}
    busy={busy() || !!(identity() && (pages.loading || names.loading))} error={error() || valueError() || undefined} empty={step() === 'value' ? identity() ? unresolved() || 'No matches.' : definition()?.kind === 'choice' ? 'No matching options.' : 'Type a value.' : 'No matches.'}
    row={row => row.kind === 'field' ? <><Icon name="field" /><span class="picker-text">{row.name}</span><span class="picker-meta">{kindLabels[row.type]}</span></>
      : row.kind === 'new-field' ? <><Icon name="plus" /><span class="picker-text">New field “{row.name}”</span></>
        : row.kind === 'op' ? <span class="picker-text">{filterOperatorLabel(row.op, definition()?.kind)}</span>
          : <span class="picker-text">{row.label}</span>} />}>
    <Portal><div class="table-sheet-shade" aria-hidden="true" onPointerDown={props.onDismiss} /></Portal>
    <Popup anchor={props.anchor} placement="sheet" class="table-filter-sheet" label="Filters" onDismiss={props.onDismiss} autofocus={false} style={{ '--bottom-nav-height': getComputedStyle(props.anchor).getPropertyValue('--bottom-nav-height') || '0px' }}>
      <div class="table-popup-heading">Filters<Button onClick={props.onDismiss}>Cancel</Button></div>
      <div class="table-filter-steps">
        <Button class="bordered" onClick={() => { setField(null); setOp(null); setQuery(''); setDraftValue(undefined); }}>{field()?.name ?? 'Field'}<Icon name="down" /></Button>
        <Button class="bordered" disabled={!field()} onClick={() => { setOp(null); setQuery(''); setDraftValue(undefined); }}>{op() ? filterOperatorLabel(op()!, definition()?.kind) : 'Condition'}<Icon name="down" /></Button>
      </div>
      <input class="input table-filter-input" aria-label={placeholder()} placeholder={placeholder()} value={query()} onInput={event => { const value = event.currentTarget.value; setQuery(value); if (step() === 'value') setDraftValue(identity() || definition()?.kind === 'choice' ? undefined : value.trim() || undefined); }} />
      <div class="table-filter-options" classList={{ 'table-filter-choices': step() === 'value' && definition()?.kind === 'choice' }}>
        <For each={rows()}>{row => <Button class="bordered" classList={{ selected: row.kind === 'value' && draftValue() === row.value }} aria-pressed={row.kind === 'value' ? draftValue() === row.value : undefined} disabled={busy()} onClick={() => pick(row)}>
          <span>{row.kind === 'field' ? row.name : row.kind === 'new-field' ? `New field “${row.name}”` : row.kind === 'op' ? filterOperatorLabel(row.op, definition()?.kind) : row.label}</span><Show when={row.kind === 'value' && draftValue() === row.value}><Icon name="check" /></Show>
        </Button>}</For>
      </div>
      <Show when={definition()?.kind === 'date' && (op() === 'lt' || op() === 'gt')}><label class="table-column-choice"><input type="checkbox" checked={orEmpty()} onChange={event => setOrEmpty(event.currentTarget.checked)} />Or empty</label></Show>
      <Show when={unresolved()}><p class="field-note">{unresolved()}</p></Show>
      <Show when={valueError()}><p class="error" role="alert">{valueError()}</p></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button onClick={() => { setField(null); setOp(null); setQuery(''); setDraftValue(undefined); }}>Reset</Button><Button class="bordered table-filter-apply" disabled={!field() || !op() || draftValue() === undefined || busy()} onClick={() => { void finish(draftValue() ?? null); }}>Apply</Button></div>
    </Popup>
  </Show>;
}
