import { opensBeside, listOpensBeside } from '../shell/beside';
import { For, Show, createEffect, createMemo, createResource, createSignal, onMount, untrack } from 'solid-js';
import { ulid } from 'ulid';
import type { FieldDefinition, Filter, Operation, Query, QueryResult, QueryRow, View } from '../api/types';
import type { TablePaneProps } from '../table/TablePane';
import { attributeDefinitions } from '../table/attributes';
import { copyQuery, queriesEqual, removeQueryField } from '../table/query';
import { FilterPopup } from '../table/FilterPopup';
import { MissingFields } from '../table/MissingFields';
import { missingQueryFields } from '../table/query';
import { BlockText } from '../outline/BlockText';
import { plainText } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { columnNames, columnQuery, deskConditionLabel, initialSelection, linkedQuery, positionLocators, rowTarget, updateColumn } from './query';
import type { DeskColumn } from './query';
import './desk.css';

const columns: DeskColumn[] = [0, 1, 2];
const emptyResult: QueryResult = { fields: [], columns: [], rows: [], total: 0 };
const selectionKey = ['question', 'position', 'source'] as const;

export function DeskPane(props: TablePaneProps) {
  const api = props.notebook.api;
  const [query, setQuery] = createSignal(copyQuery(props.view.query));
  const [selection, setSelection] = createSignal(initialSelection(query(), props.view.desk));
  const [limits, setLimits] = createSignal([500, 500, 500]);
  const [editing, setEditing] = createSignal<DeskColumn | null>(null);
  const [filter, setFilter] = createSignal<{ column: DeskColumn; anchor: HTMLElement; index?: number }>();
  const [saveAnchor, setSaveAnchor] = createSignal<HTMLElement>();
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [pendingFocus, setPendingFocus] = createSignal<DeskColumn | null>(null);
  const [history, setHistory] = createSignal<{ before?: View; after: View; undone: boolean }>();
  let region!: HTMLDivElement;
  const [fields] = createResource(() => props.notebook.changeSequence(), () => api.fields());
  const [saved, { mutate: setSaved }] = createResource(() => props.target.viewId, id => api.view(id));
  const missing = createMemo(() => fields() ? missingQueryFields(query(), fields()!.fields) : []);
  const columnQueries = columns.map(column => createMemo(() => columnQuery(query(), column)));
  const results = columns.map(column => {
    const signature = createMemo(() => JSON.stringify({ ...columnQueries[column]!(), offset: 0, limit: limits()[column] }));
    const enabled = createMemo(() => !missing().length && (column === 0 || !!selection()[column === 1 ? 'question' : 'position']));
    return createResource(() => enabled() && { signature: signature(), seq: props.notebook.changeSequence() }, async ({ signature }) => {
      const value = JSON.parse(signature) as Query;
      const wanted = value.limit ?? 500;
      const first = await api.query({ ...value, limit: Math.min(wanted, 2000) });
      while (first.rows.length < Math.min(wanted, first.total)) {
        const next = await api.query({ ...value, offset: first.rows.length, limit: Math.min(2000, wanted - first.rows.length) });
        if (!next.rows.length) break;
        first.rows.push(...next.rows);
      }
      return first;
    });
  });
  const result = (column: DeskColumn) => results[column]![0]() ?? emptyResult;
  const loading = (column: DeskColumn) => results[column]![0].loading;
  const enabled = (column: DeskColumn) => column === 0 || !!selection()[column === 1 ? 'question' : 'position'];
  const ordered = columns.map(column => createMemo(() => {
    const value = result(column);
    if (!columnQueries[column]!().group || !value.groups?.length) return value.rows;
    const byId = new Map(value.rows.map(row => [row.block.block.id, row]));
    return value.groups.flatMap(group => group.row_ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []));
  }));
  const orderedRows = (column: DeskColumn) => ordered[column]!();
  const selectedRow = (column: DeskColumn) => result(column).rows.find(row => row.block.block.id === selection()[selectionKey[column]]);
  const pickerFields = (column: DeskColumn): FieldDefinition[] => [...attributeDefinitions(columnQueries[column]!().source), ...fields()?.fields ?? []];
  const report = () => props.onViewChange({ ...props.view, query: copyQuery(query()), desk: { ...selection() }, scroll: 0 });
  const changeQuery = (value: Query) => { setQuery(value); report(); };
  const changeColumn = (column: DeskColumn, value: Query) => {
    setLimits(values => values.map((limit, index) => index === column ? 500 : limit));
    changeQuery(updateColumn(query(), column, value));
  };
  const select = (column: DeskColumn, row: QueryRow, advance = false) => {
    const id = row.block.block.id;
    const changed = selection()[selectionKey[column]] !== id;
    setSelection(value => ({ ...value, [selectionKey[column]]: id, column: advance && column < 2 ? column + 1 as DeskColumn : column,
      ...(changed && column === 0 ? { position: null, source: null } : changed && column === 1 ? { source: null } : {}) }));
    if (changed && column === 0) {
      let next = updateColumn(query(), 1, linkedQuery(columnQueries[1]!(), '@question', id));
      next = updateColumn(next, 2, linkedQuery(columnQueries[2]!(), '@cited_in', null));
      setQuery(next);
    } else if (changed && column === 1) setQuery(updateColumn(query(), 2, linkedQuery(columnQueries[2]!(), '@cited_in', id)));
    report();
  };
  for (const column of columns) createEffect(() => {
    const resource = results[column]![0];
    const value = resource();
    const id = selection()[selectionKey[column]];
    if (!enabled(column) || resource.state !== 'ready' || !value || value.rows.length < value.total || !id || value.rows.some(row => row.block.block.id === id)) return;
    untrack(() => {
      setSelection(value => ({ ...value, [selectionKey[column]]: null, ...(column === 0 ? { position: null, source: null } : column === 1 ? { source: null } : {}) }));
      if (column === 0) setQuery(updateColumn(query(), 1, linkedQuery(columnQueries[1]!(), '@question', null)));
      if (column < 2) setQuery(updateColumn(query(), 2, linkedQuery(columnQueries[2]!(), '@cited_in', null)));
      report();
    });
  });
  const focusColumn = (column: DeskColumn) => {
    setSelection(value => ({ ...value, column })); report();
    if (loading(column)) { setPendingFocus(column); return; }
    const row = selectedRow(column) ?? orderedRows(column)[0];
    if (row) {
      select(column, row);
      region.querySelector<HTMLElement>(`[data-desk-column="${column}"] [data-desk-row="${row.block.block.id}"]`)?.focus();
    } else region.querySelector<HTMLElement>(`[data-desk-column="${column}"] .desk-rows`)?.focus();
  };
  createEffect(() => {
    const column = pendingFocus();
    if (column !== null && !loading(column)) { setPendingFocus(null); untrack(() => focusColumn(column)); }
  });
  const [positionPage] = createResource(() => {
    const position = selectedRow(1);
    return position && { pageId: position.block.page.id, positionId: position.block.block.id, seq: props.notebook.changeSequence() };
  }, async ({ pageId, positionId }) => positionLocators(await api.page(pageId), positionId));
  const attribute = (row: QueryRow, key: string) => row.attributes?.[key]?.map(value => value.text).join(' · ') ?? '';
  const fieldValue = (row: QueryRow, label: string) => {
    const definition = fields()?.fields.find(field => field.name.toLocaleLowerCase() === label.toLocaleLowerCase());
    return definition ? (row.values[definition.id] ?? []).map(value => value.text).join('\n') : '';
  };
  const title = (row: QueryRow, column: DeskColumn) => column === 1 ? attribute(row, '@holder') || row.block.block.text : row.block.block.text;
  const conditionLabel = (column: DeskColumn, condition: Filter) => deskConditionLabel(condition, pickerFields(column), props.notebook, result(1).rows);
  const label = (column: DeskColumn) => {
    const value = columnQueries[column]!();
    const words = value.filters.map(condition => conditionLabel(column, condition));
    if (value.text) words.unshift(`Text contains ${value.text}`);
    if (value.type) words.unshift(`Tag is ${props.notebook.lookup(value.type)()?.text ?? 'Unavailable tag'}`);
    return words.length ? words.join('; ') : column === 1 ? 'Perspectives on the selected question' : column === 2 ? 'Sources cited by the selected perspective' : 'All questions';
  };
  const openRow = (row: QueryRow, beside: boolean) => props.onOpen(rowTarget(row), beside);
  const submit = (operation: Operation) => api.submit({ actor: { kind: 'client', name: 'tessera-web-desk' }, idempotency_key: ulid(), operations: [operation] });
  const failure = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const save = async (create: boolean) => {
    if (busy() || create && !name().trim()) return;
    setBusy(true); setError('');
    try {
      const before = create ? undefined : saved();
      const id = before?.id ?? ulid();
      await submit({ op: 'save_view', id, base_revision: before?.revision ?? null, name: create ? name().trim() : before!.name, query: copyQuery(query()) });
      const after = await api.view(id);
      setHistory({ before, after, undone: false }); setSaved(after); setSaveAnchor(undefined);
      props.onTargetChange({ kind: 'table', typeId: null, viewId: id, query: copyQuery(query()) }); report();
    } catch (reason) { failure(reason); } finally { setBusy(false); }
  };
  const replay = async () => {
    const entry = history(); if (!entry || busy()) return;
    setBusy(true); setError('');
    try {
      const value = entry.undone ? entry.after : entry.before;
      if (value) {
        await submit({ op: 'save_view', id: value.id, base_revision: entry.undone && !entry.before ? null : (await api.view(value.id)).revision, name: value.name, query: copyQuery(value.query) });
        const current = await api.view(value.id); setSaved(current); changeQuery(copyQuery(current.query));
        props.onTargetChange({ kind: 'table', typeId: null, viewId: current.id, query: copyQuery(current.query) });
      } else {
        const current = await api.view(entry.after.id);
        await submit({ op: 'delete_view', id: current.id, base_revision: current.revision });
        setSaved(undefined); props.onTargetChange({ kind: 'table', typeId: null, viewId: null, query: copyQuery(query()) });
      }
      setHistory({ ...entry, undone: !entry.undone }); report();
    } catch (reason) { failure(reason); } finally { setBusy(false); }
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && history()) {
      if (!!event.shiftKey === !!history()!.undone) { event.preventDefault(); void replay(); } return;
    }
    if (target !== region && !target.closest('.desk-rows')) return;
    const column = Number(target.closest<HTMLElement>('[data-desk-column]')?.dataset.deskColumn ?? selection().column) as DeskColumn;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); const next = column + (event.key === 'ArrowRight' ? 1 : -1);
      if (next >= 0 && next <= 2 && enabled(next as DeskColumn)) focusColumn(next as DeskColumn);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const rows = orderedRows(column); const index = rows.findIndex(row => row.block.block.id === selection()[selectionKey[column]]);
      const row = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? event.key === 'ArrowDown' ? 0 : rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (row) { select(column, row); focusColumn(column); }
    } else if (event.key === 'Enter' && selectedRow(column)) { event.preventDefault(); openRow(selectedRow(column)!, listOpensBeside(event, !!props.neighbour)); }
  };
  onMount(() => { if (props.active) region.focus({ preventScroll: true }); report(); });
  const clear = (column: DeskColumn) => changeColumn(column, { ...columnQueries[column]!(), text: null, filters: columnQueries[column]!().filters.filter(filter => column === 1 ? filter.field === '@question' : column === 2 ? filter.field === '@cited_in' : false) });
  const addFilter = (column: DeskColumn, condition: Filter, index?: number) => {
    const value = columnQueries[column]!();
    changeColumn(column, { ...value, filters: index === undefined ? [...value.filters, condition] : value.filters.map((filter, position) => position === index ? condition : filter) });
    setFilter(undefined);
  };
  return <div ref={region} class="research-desk" tabIndex={-1} onKeyDown={keydown} onFocusIn={props.onActivate}>
    <header class="desk-heading"><div><p class="desk-rubric">Research desk</p><h1>{saved()?.name ?? 'Questions, perspectives, sources'}</h1></div><div class="desk-actions">
      <Show when={saved() && !queriesEqual(saved()!.query, query())}><Button disabled={busy()} onClick={() => void save(false)}>Save changes</Button></Show>
      <Button class="bordered" onClick={event => { setName(''); setSaveAnchor(event.currentTarget); }}>Save desk</Button>
      <Show when={history()}><Button disabled={busy()} onClick={() => void replay()}>{history()!.undone ? 'Redo save' : 'Undo save'}</Button></Show>
    </div></header>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <MissingFields fields={missing()} busy={busy()} onRemove={id => changeQuery(removeQueryField(query(), id))} />
    <nav class="desk-breadcrumb" aria-label="Research desk steps"><For each={columns}>{column => <><Show when={column > 0}><span aria-hidden="true">›</span></Show><Button disabled={!enabled(column)} aria-current={selection().column === column ? 'step' : undefined} onClick={() => focusColumn(column)}>{column === 0 ? 'Question' : column === 1 ? 'Perspective' : 'Sources'}</Button></>}</For></nav>
    <div class="desk-columns"><For each={columns}>{column => <section data-desk-column={column} class="desk-column" classList={{ 'desk-current': selection().column === column }} aria-label={columnNames[column]}>
      <header class="desk-column-heading"><h2>{columnNames[column]} <span>{enabled(column) ? result(column).total : ''}</span></h2><Button aria-label={`Edit ${columnNames[column].toLowerCase()} query`} aria-expanded={editing() === column} onClick={() => setEditing(editing() === column ? null : column)}>Edit</Button></header>
      <p class="desk-query">{label(column)}<Show when={columnQueries[column]!().group}><span>; grouped by {pickerFields(column).find(field => field.id === columnQueries[column]!().group!.key)?.name ?? 'field'}</span></Show></p>
      <Show when={editing() === column}><div class="desk-query-edit">
        <input class="input" type="search" aria-label={`Search ${columnNames[column].toLowerCase()}`} placeholder="Search rows" value={columnQueries[column]!().text ?? ''} onInput={event => changeColumn(column, { ...columnQueries[column]!(), text: event.currentTarget.value || null })} />
        <For each={columnQueries[column]!().filters}>{(condition, index) => <span class="table-chip"><Button onClick={event => setFilter({ column, index: index(), anchor: event.currentTarget })}>{conditionLabel(column, condition)}</Button><Button label="Remove condition" onClick={() => changeColumn(column, { ...columnQueries[column]!(), filters: columnQueries[column]!().filters.filter((_, position) => position !== index()) })}>×</Button></span>}</For>
        <Button onClick={event => setFilter({ column, anchor: event.currentTarget })}>+ Filter</Button><Button onClick={() => clear(column)}>Clear filters</Button>
      </div></Show>
      <div class="desk-rows" role="listbox" aria-label={columnNames[column]} tabIndex={0}>
        <Show when={enabled(column)} fallback={<p class="desk-empty">{column === 1 ? 'Select a question to see its perspectives.' : 'Select a perspective to see its sources.'}<Button onClick={() => focusColumn(column === 1 ? 0 : selection().question ? 1 : 0)}>{column === 1 || !selection().question ? 'Choose a question' : 'Choose a perspective'}</Button></p>}>
          <Show when={results[column]![0].error}><p class="error" role="alert">{String(results[column]![0].error)}<Button onClick={() => results[column]![1].refetch()}>Try again</Button></p></Show>
          <Show when={!loading(column) && !result(column).rows.length && !results[column]![0].error}><p class="desk-empty">No {columnNames[column].toLowerCase()} match this query.<Button onClick={() => { setEditing(column); clear(column); }}>Clear filters</Button><Show when={column > 0}><Button onClick={() => focusColumn(column === 1 ? 0 : 1)}>Choose another {column === 1 ? 'question' : 'perspective'}</Button></Show></p></Show>
          <For each={orderedRows(column)}>{(row, index) => <>
            <Show when={columnQueries[column]!().group && (index() === 0 || attribute(orderedRows(column)[index() - 1]!, columnQueries[column]!().group!.key) !== attribute(row, columnQueries[column]!().group!.key)) && plainText(attribute(row, columnQueries[column]!().group!.key), id => props.notebook.lookup(id)) !== plainText(title(row, column), id => props.notebook.lookup(id))}><h3 class="desk-group"><BlockText text={attribute(row, columnQueries[column]!().group!.key) || 'None'} notebook={props.notebook} interactive={false} /></h3></Show>
            <div class="desk-row" role="option" tabIndex={selection()[selectionKey[column]] === row.block.block.id ? 0 : -1} aria-selected={selection()[selectionKey[column]] === row.block.block.id} data-desk-row={row.block.block.id} onClick={event => { if (opensBeside(event)) { openRow(row, true); return; } select(column, row, getComputedStyle(region.querySelector('.desk-breadcrumb')!).display !== 'none'); }} onDblClick={event => openRow(row, listOpensBeside(event, !!props.neighbour))}>
              <div class="desk-row-title"><BlockText text={title(row, column)} notebook={props.notebook} interactive={false} /></div>
              <Show when={column === 0}><p class="desk-meta">{attribute(row, '@state')} · {attribute(row, '@readings')} {attribute(row, '@readings') === '1' ? 'perspective' : 'perspectives'}</p><p class="desk-meta">Last assessed {attribute(row, '@last_assessed') || 'never'} · Revisit {attribute(row, '@revisit') || 'not set'}</p></Show>
              <Show when={column === 1}><Show when={fieldValue(row, 'Gist')}><p class="desk-gist"><BlockText text={fieldValue(row, 'Gist')} notebook={props.notebook} interactive={false} /></p></Show><Show when={fieldValue(row, 'Work')}><p class="desk-meta">Work · <BlockText text={fieldValue(row, 'Work')} notebook={props.notebook} interactive={false} /></p></Show></Show>
              <Show when={column === 2}><p class="desk-meta">{attribute(row, '@creator') || 'Creator not recorded'}<Show when={fieldValue(row, 'Published')}> · {plainText(fieldValue(row, 'Published'), id => props.notebook.lookup(id))}</Show></p><Show when={positionPage()?.get(row.block.block.id)?.length}><p class="desk-locators">{positionPage()!.get(row.block.block.id)!.join(' · ')}</p></Show></Show>
              <div class="desk-row-actions"><Button label={`Open ${column === 0 ? 'question' : column === 1 ? 'perspective' : 'source'}`} onClick={event => { event.stopPropagation(); openRow(row, listOpensBeside(event, !!props.neighbour)); }}>Open<Icon name="right" /></Button><Button icon="panes" label="Open beside" onClick={event => { event.stopPropagation(); openRow(row, true); }} /></div>
            </div>
          </>}</For>
          <Show when={result(column).rows.length < result(column).total}><Button disabled={loading(column)} onClick={() => setLimits(values => values.map((value, index) => index === column ? value + 500 : value))}>Show more</Button></Show>
        </Show>
      </div>
    </section>}</For></div>
    <Show keyed when={filter()}>{state => <FilterPopup anchor={state.anchor} fields={pickerFields(state.column)} notebook={props.notebook} initialField="" initialFilter={state.index === undefined ? undefined : columnQueries[state.column]!().filters[state.index]} sheet={window.matchMedia('(max-width: 599px)').matches} onDismiss={() => setFilter(undefined)} onAdd={condition => addFilter(state.column, condition, state.index)} />}</Show>
    <Show when={saveAnchor()}><Popup anchor={saveAnchor()!} label="Save desk" width={320} onDismiss={() => setSaveAnchor(undefined)}><form onSubmit={event => { event.preventDefault(); void save(true); }}><input class="input" aria-label="Desk name" placeholder="Desk name" value={name()} onInput={event => setName(event.currentTarget.value)} maxlength={120} /><div class="popup-actions"><Button onClick={() => setSaveAnchor(undefined)}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !name().trim()}>Save</Button></div></form></Popup></Show>
  </div>;
}
