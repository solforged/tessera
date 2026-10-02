import { For, Show, createEffect, createMemo, createResource, createRoot, createSignal, onCleanup, onMount } from 'solid-js';
import { ulid } from 'ulid';
import { api } from '../api/client';
import type { FieldDefinition, FieldKind, Fields, FilterOp, Operation, Query, QueryResult, QueryRow, SortKey, Type, View } from '../api/types';
import type { Edit, NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget, PaneId, TableViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { Picker } from '../ui/Picker';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, filterLabel, filterLabels, queriesEqual, removeFilter, removeSort, sortLabel } from './query';
import './table.css';

type TableTarget = Extract<OpenTarget, { kind: 'table' }>;
interface TablePaneProps {
  pane: PaneId; target: TableTarget; view: TableViewState; notebook: NotebookClient; active: boolean;
  onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void;
  onTargetChange(target: TableTarget): void; onViewChange(view: TableViewState): void;
}
type PopupState = { kind: 'menu'; anchor: HTMLElement; items: MenuItem[]; label: string }
  | { kind: 'filter'; anchor: HTMLElement; field: string }
  | { kind: 'name'; anchor: HTMLElement; action: 'save' | 'rename' | 'field'; addColumn?: boolean }
  | null;
const kindLabels: Record<FieldKind, string> = { text: 'Text', number: 'Number', date: 'Date', checkbox: 'Checkbox', choice: 'Choice', instance: 'Instance' };

export function TablePane(props: TablePaneProps) {
  const [query, setQuery] = createSignal(copyQuery(props.view.query));
  const [search, setSearch] = createSignal(query().text ?? '');
  const [result, setResult] = createSignal<QueryResult>();
  const [definitions, setDefinitions] = createSignal<Fields>();
  const [type, setType] = createSignal<Type>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [focused, setFocused] = createSignal({ row: 0, column: 0 });
  const [editing, setEditing] = createSignal<{ row: QueryRow; field: FieldDefinition; text: string } | null>(null);
  const [deleted, setDeleted] = createSignal<View | null>(null);
  const [savedRevision, setSavedRevision] = createSignal(0);
  let region!: HTMLDivElement; let scroll!: HTMLDivElement;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let deletedTimer: ReturnType<typeof setTimeout> | undefined;
  let restoredScroll = false;
  const message = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const viewId = createMemo(() => props.target.viewId);
  createEffect(() => {
    const change = props.notebook.lastChange();
    if ((change?.views ?? []).includes(viewId() ?? '')) setSavedRevision(change!.seq);
  });
  const [saved, { refetch: refetchSaved, mutate: setSaved }] = createResource(
    () => ({ id: viewId(), revision: savedRevision() }),
    async ({ id }) => {
      if (!id) return undefined;
      try { return await api.view(id); }
      catch (reason) { message(reason); return undefined; }
    },
  );
  const fields = createMemo(() => {
    const combined = new Map<string, FieldDefinition>((definitions()?.fields ?? []).map(field => [field.id, field]));
    for (const field of result()?.fields ?? []) if (!combined.has(field.id)) combined.set(field.id, field);
    return [...combined.values()];
  });
  const fieldById = (id: string) => fields().find(field => field.id === id);
  const changed = () => !!saved() && !queriesEqual(query(), saved()!.query);
  const title = () => type()?.page.text ?? props.notebook.lookup(query().type ?? '')()?.text ?? '';
  const updateQuery = (next: Query) => {
    setQuery(copyQuery(next));
    props.onViewChange({ query: copyQuery(next), scroll: scroll?.scrollTop ?? props.view.scroll });
  };
  createEffect(() => {
    const value = copyQuery(query()); props.notebook.changeSequence();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void Promise.all([api.query(value, controller.signal), api.fields(controller.signal), value.type ? api.type(value.type, controller.signal) : Promise.resolve(undefined)])
        .then(([rows, allFields, pageType]) => {
          if (controller.signal.aborted) return;
          setResult(rows); setDefinitions(allFields); setType(pageType); setError(''); setLoading(false);
          if (!restoredScroll) {
            restoredScroll = true;
            requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });
          }
        }).catch(reason => { if (!controller.signal.aborted) { message(reason); setLoading(false); } });
    }, 150);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  onCleanup(() => { clearTimeout(searchTimer); clearTimeout(deletedTimer); });
  const submit = async (operation: Operation) => {
    await api.submit({ actor: { kind: 'client', name: 'tessera-web-table' }, idempotency_key: ulid(), operations: [operation] });
  };
  const withDocument = async (pageId: string, action: (doc: PageDocument) => void | Promise<void>) => {
    const doc = props.notebook.open(pageId);
    try {
      const ready = Promise.withResolvers<void>();
      createRoot(dispose => {
        createEffect(() => {
          const status = doc.status();
          if (status === 'ready') { dispose(); ready.resolve(); }
          else if (status !== 'loading') { dispose(); ready.reject(new Error(doc.statusMessage())); }
        });
      });
      await ready.promise;
      await action(doc);
    } finally { doc.release(); }
  };
  const appendField = async (fieldId: string) => {
    const currentType = type(); if (!currentType || !query().type) return;
    if (currentType.fields.includes(fieldId)) return;
    await submit({ op: 'set_type_fields', type_id: currentType.page.id, base_revision: currentType.page.revision, fields: [...currentType.fields, fieldId] });
  };
  const saveView = async (name: string, rename = false) => {
    const previous = saved(); const id = rename ? previous!.id : ulid();
    const value = rename ? previous!.query : copyQuery(query());
    await submit({ op: 'save_view', id, base_revision: rename ? previous!.revision : null, name, query: value });
    setSaved(await api.view(id));
    props.onTargetChange({ kind: 'table', typeId: query().type, viewId: id, query: copyQuery(query()) });
    setPopup(null);
  };
  const saveChanges = async () => {
    const value = saved(); if (!value) return;
    await submit({ op: 'save_view', id: value.id, base_revision: value.revision, name: value.name, query: copyQuery(query()) });
    await refetchSaved();
  };
  const deleteView = async () => {
    const value = saved(); if (!value) return;
    await submit({ op: 'delete_view', id: value.id, base_revision: value.revision });
    setDeleted(value); setSaved(undefined);
    props.onTargetChange({ kind: 'table', typeId: query().type, viewId: null, query: copyQuery(query()) });
    clearTimeout(deletedTimer); deletedTimer = setTimeout(() => setDeleted(null), 10000);
  };
  const undoDelete = async () => {
    const value = deleted(); if (!value) return;
    await submit({ op: 'save_view', id: value.id, base_revision: null, name: value.name, query: value.query });
    setDeleted(null); props.onTargetChange({ kind: 'table', typeId: query().type, viewId: value.id, query: copyQuery(query()) });
    await refetchSaved();
  };
  const createField = async (name: string, addColumn: boolean) => {
    const all = await api.fields(); let fieldId = all.fields.find(field => field.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())?.id;
    if (!fieldId) await withDocument(all.page_id, async doc => {
      // An empty page is seeded with one blank block on load; name it instead of adding a sibling.
      const blank = doc.outline.children(all.page_id).find(id => { const block = doc.block(id); return block && !block.archived && !block.text.trim(); });
      const baseRevision = blank ? doc.block(blank)?.revision ?? 0 : 0;
      const written = blank
        ? doc.edit({ kind: 'text', id: blank, text: name.trim() })
        : doc.edit({ kind: 'insert', parentId: all.page_id, after: doc.outline.children(all.page_id).at(-1) ?? null, text: name.trim() });
      if (!written.ok) throw new Error(written.reason);
      fieldId = blank ?? written.created[0]!;
      // A query or template can only refer to the definition after its document commits.
      const committed = Promise.withResolvers<void>();
      createRoot(dispose => {
        createEffect(() => {
          if ((doc.block(fieldId!)?.revision ?? 0) > baseRevision) { dispose(); committed.resolve(); }
          else if (doc.saveState() === 'error' || doc.saveState() === 'conflict') { dispose(); committed.reject(new Error(doc.saveMessage())); }
        });
      });
      await committed.promise;
    });
    if (addColumn) await appendField(fieldId!);
    setDefinitions(await api.fields()); setPopup(null);
    return fieldId!;
  };
  const viewMenu = (anchor: HTMLElement) => setPopup({ kind: 'menu', anchor, label: 'Views', items: [
    { label: 'Save as view…', action: () => setPopup({ kind: 'name', anchor, action: 'save' }) },
    ...(props.target.viewId ? [
      ...(changed() ? [{ label: 'Save', action: () => { void saveChanges().catch(message); } }] : []),
      { label: 'Rename view…', disabledReason: !saved() ? 'Loading…' : undefined, action: () => setPopup({ kind: 'name', anchor, action: 'rename' }) },
      { label: 'Delete view', icon: 'trash' as const, danger: true, disabledReason: !saved() ? 'Loading…' : undefined, action: () => { void deleteView().catch(message); } },
    ] : []),
  ] });
  const showFilter = (anchor: HTMLElement, field = '') => setPopup({ kind: 'filter', anchor, field });
  const columnMenu = (anchor: HTMLElement, field: FieldDefinition | undefined) => {
    const key: Pick<SortKey, 'by' | 'field'> = field ? { by: 'field', field: field.id } : { by: 'title', field: null };
    const sorted = query().sort.findIndex(sort => sort.by === key.by && sort.field === key.field);
    setPopup({ kind: 'menu', anchor, label: field?.name ?? 'Title', items: [
      { label: 'Sort ascending', action: () => updateQuery(chooseSort(query(), key, 'asc')) },
      { label: 'Sort descending', action: () => updateQuery(chooseSort(query(), key, 'desc')) },
      ...(sorted >= 0 ? [{ label: 'Clear sort', action: () => updateQuery(removeSort(query(), sorted)) }] : []),
      ...(field ? [
        { label: 'Filter…', action: () => showFilter(anchor, field.id) },
        ...Object.entries(kindLabels).map(([kind, label], index): MenuItem => ({ label, section: index === 0 ? 'Field kind' : undefined, icon: field.kind === kind ? 'check' : undefined, action: () => { void withDocument(definitions()!.page_id, doc => { const result = doc.edit({ kind: 'fieldKind', definition: field, value: kind as FieldKind }); if (!result.ok) throw new Error(result.reason); }).catch(message); } })),
        ...(query().type && type()?.fields.includes(field.id) ? [{ label: 'Remove column', action: () => { const current = type()!; void submit({ op: 'set_type_fields', type_id: current.page.id, base_revision: current.page.revision, fields: current.fields.filter(id => id !== field.id) }).catch(message); } }] : []),
      ] : []),
    ] });
  };
  const addColumnMenu = (anchor: HTMLElement) => setPopup({ kind: 'menu', anchor, label: 'Add column', items: [
    ...fields().filter(field => !result()?.columns.includes(field.id)).map((field): MenuItem => ({ label: field.name, disabledReason: !query().type ? 'Open a type to add columns' : undefined, action: () => { void appendField(field.id).catch(message); } })),
    { label: 'New field…', disabledReason: !query().type ? 'Open a type to add columns' : undefined, action: () => setPopup({ kind: 'name', anchor, action: 'field', addColumn: true }) },
  ] });
  const sortMenu = (anchor: HTMLElement) => setPopup({ kind: 'menu', anchor, label: 'Sort', items: [
    ...(['title', 'created', 'updated'] as const).map((by): MenuItem => ({ label: { title: 'Title', created: 'Created', updated: 'Updated' }[by], action: () => updateQuery(chooseSort(query(), { by, field: null })) })),
    ...(result()?.columns ?? []).map(id => ({ label: fieldById(id)?.name ?? id, action: () => updateQuery(chooseSort(query(), { by: 'field', field: id })) })),
  ] });
  const openRow = (row: QueryRow, beside: boolean) => props.onOpen({ kind: 'page', pageId: row.block.page.id, ...(row.block.block.kind === 'block' ? { blockId: row.block.block.id } : {}) }, beside);
  const startEdit = (row: QueryRow, field: FieldDefinition) => {
    if (!['text', 'number', 'date'].includes(field.kind)) { openRow(row, true); return; }
    setEditing({ row, field, text: row.values[field.id]?.[0]?.text ?? '' });
  };
  const commitEdit = async () => {
    const current = editing(); if (!current) return;
    setEditing(null);
    try {
      await withDocument(current.row.block.page.id, doc => {
        const first = current.row.values[current.field.id]?.[0];
        const apply = (edit: Edit) => { const value = doc.edit(edit); if (!value.ok) throw new Error(value.reason); return value; };
        if (first) {
          if (current.text === '') apply({ kind: 'delete', ids: [first.id] });
          else apply({ kind: 'text', id: first.id, text: current.text });
        } else {
          const owner = current.row.block.block.id;
          let entryId = doc.outline.children(owner).find(id => fieldEntryId(doc.block(id)?.text ?? '') === current.field.id && !doc.block(id)?.archived);
          if (!entryId) entryId = apply({ kind: 'insert', parentId: owner, after: doc.outline.children(owner).at(-1) ?? null, text: fieldEntryText(current.field.id) }).created[0]!;
          apply({ kind: 'insert', parentId: entryId, after: null, text: current.text });
        }
      });
    } catch (reason) { message(reason); }
    requestAnimationFrame(() => region?.querySelector<HTMLElement>(`[data-row="${focused().row}"][data-column="${focused().column}"]`)?.focus());
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    const current = focused(); const row = result()?.rows[current.row];
    if (event.key === 'Escape') { region.focus(); event.preventDefault(); return; }
    if (event.key === 'Enter' && row) {
      if (!current.column) openRow(row, event.metaKey);
      else { const field = fieldById(result()!.columns[current.column - 1]!); if (field) startEdit(row, field); }
      event.preventDefault(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const next = { row: Math.max(0, Math.min((result()?.rows.length ?? 1) - 1, current.row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))), column: Math.max(0, Math.min(result()?.columns.length ?? 0, current.column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) };
    setFocused(next); region.querySelector<HTMLElement>(`[data-row="${next.row}"][data-column="${next.column}"]`)?.focus(); event.preventDefault();
  };
  onMount(() => { if (props.active) region.focus({ preventScroll: true }); });
  return <div ref={region} class="table-pane" tabIndex={0} role="region" aria-label="Table" onFocusIn={props.onActivate} onPointerDown={props.onActivate} onKeyDown={keydown}>
    <header class="table-header">
      <Show when={query().type}><Button class="outline-tag tag" onClick={event => props.onOpen({ kind: 'page', pageId: query().type! }, event.metaKey)}>#{title()}</Button></Show>
      <Button class="table-title" label={saved()?.name ?? 'Views'} onClick={event => viewMenu(event.currentTarget)}>{saved()?.name ?? ''}<Icon name="down" /></Button>
      <Show when={props.target.viewId && saved()}><span class="table-view-status">{changed() ? 'Unsaved changes' : 'Saved view'}</span></Show>
    </header>
    <div class="table-toolbar">
      <input class="input table-search" placeholder="Search results…" aria-label="Search results…" value={search()} onInput={event => {
        const text = event.currentTarget.value; setSearch(text); clearTimeout(searchTimer);
        searchTimer = setTimeout(() => updateQuery({ ...query(), text: text.trim() ? text : null }), 150);
      }} />
      <For each={query().sort}>{(key, index) => <span class="table-chip">{sortLabel(key, fields())}<Button label={`Remove ${sortLabel(key, fields())}`} onClick={() => updateQuery(removeSort(query(), index()))}>×</Button></span>}</For>
      <For each={query().filters}>{(filter, index) => <span class="table-chip">{filterLabel(filter, fields())}<Button label={`Remove ${filterLabel(filter, fields())}`} onClick={() => updateQuery(removeFilter(query(), index()))}>×</Button></span>}</For>
      <Button onClick={event => showFilter(event.currentTarget)}>+ Filter</Button><Button onClick={event => sortMenu(event.currentTarget)}>Sort <Icon name="down" /></Button>
    </div>
    <div ref={scroll} class="table-scroll" onScroll={() => props.onViewChange({ query: copyQuery(query()), scroll: scroll.scrollTop })}>
      <table class="type-table" role="grid"><thead><tr><th class="table-title-column"><Button onClick={event => columnMenu(event.currentTarget, undefined)}>Title</Button></th>
        <For each={result()?.columns ?? []}>{id => <th><Button onClick={event => columnMenu(event.currentTarget, fieldById(id))}>{fieldById(id)?.name ?? id}</Button></th>}</For>
        <th class="table-add-column"><Button label="Add column" title={!query().type ? 'Open a type to add columns' : undefined} onClick={event => addColumnMenu(event.currentTarget)}>+</Button></th>
      </tr></thead><tbody><For each={result()?.rows ?? []}>{(row, rowIndex) => <tr>
        <td class="table-title-column table-cell" data-row={rowIndex()} data-column={0} tabIndex={focused().row === rowIndex() && focused().column === 0 ? 0 : -1} onFocus={() => setFocused({ row: rowIndex(), column: 0 })} onClick={event => openRow(row, event.metaKey)}>
          <BlockText text={props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text} notebook={props.notebook} interactive={false} />
          <Show when={row.block.block.id !== row.block.page.id}><div class="table-page-title">{row.block.page.text}</div></Show>
        </td>
        <For each={result()?.columns ?? []}>{(id, columnIndex) => {
          const field = () => fieldById(id); const current = () => editing();
          return <td class={`table-cell ${field()?.kind === 'number' ? 'table-number' : ''}`} data-row={rowIndex()} data-column={columnIndex() + 1} tabIndex={focused().row === rowIndex() && focused().column === columnIndex() + 1 ? 0 : -1} onFocus={() => setFocused({ row: rowIndex(), column: columnIndex() + 1 })} onDblClick={() => { if (field()) startEdit(row, field()!); }}>
            <Show when={current()?.row.block.block.id === row.block.block.id && current()?.field.id === id} fallback={<For each={row.values[id] ?? []}>{(value, index) => <>
              {index() > 0 ? ', ' : ''}<Show when={value.reading.ok} fallback={<span class="table-reading-problem" title={`Not a ${field()?.kind ?? 'text'}`}>{value.text}</span>}>
                <span class={field()?.kind === 'choice' || field()?.kind === 'instance' ? 'table-value-pill' : ''}>{value.reading.ok ? field()?.kind === 'checkbox' ? value.reading.value ? '☑' : '☐' : String(value.reading.value) : ''}</span>
              </Show>
            </>}</For>}>
              <input class="input table-cell-input" type={field()?.kind === 'date' ? 'date' : 'text'} inputmode={field()?.kind === 'number' ? 'decimal' : undefined} value={current()?.text ?? ''} ref={input => queueMicrotask(() => { input.focus(); if (input.type !== 'date') input.select(); })} onInput={event => { const text = event.currentTarget.value; setEditing(value => value ? { ...value, text } : null); }} onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void commitEdit(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); region.focus(); }
              }} onBlur={() => { void commitEdit(); }} />
            </Show>
          </td>;
        }}</For><td /></tr>}</For></tbody></table>
    </div>
    <footer class="table-footer" role="status"><Show when={deleted()} fallback={<>{loading() ? 'Loading…' : error() || `${result()?.rows.length ?? 0} of ${result()?.total ?? 0} rows`}</>}>View deleted · <Button onClick={() => { void undoDelete().catch(message); }}>Undo</Button></Show></footer>
    <Show keyed when={popup()}>{state => <>
      {state.kind === 'menu' && <Menu anchor={state.anchor} label={state.label} items={state.items} onDismiss={() => setPopup(null)} />}
      {state.kind === 'filter' && <FilterPopup anchor={state.anchor} fields={fields()} initialField={state.field} onDismiss={() => setPopup(null)} onNewField={async name => createField(name, false)} onAdd={filter => { updateQuery(addFilter(query(), filter)); setPopup(null); }} />}
      {state.kind === 'name' && <NamePopup anchor={state.anchor} action={state.action} name={state.action === 'rename' ? saved()?.name ?? '' : ''} onDismiss={() => setPopup(null)} onSave={async name => { if (state.action === 'field') await createField(name, !!state.addColumn); else await saveView(name, state.action === 'rename'); }} />}
    </>}</Show>
  </div>;
}

function NamePopup(props: { anchor: HTMLElement; action: 'save' | 'rename' | 'field'; name: string; onDismiss(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = createSignal(props.name); const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const submit = async () => { if (busy() || !name().trim()) return; setBusy(true); try { await props.onSave(name()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <Popup anchor={props.anchor} label={props.action === 'field' ? 'New field…' : props.action === 'rename' ? 'Rename view…' : 'Save as view…'} onDismiss={props.onDismiss} width={320}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}><input class="input" placeholder={props.action === 'field' ? 'Field name' : 'View name'} aria-label={props.action === 'field' ? 'Field name' : 'View name'} value={name()} onInput={event => setName(event.currentTarget.value)} maxlength={props.action === 'field' ? undefined : 120} />
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={!name().trim() || busy()}>Save</Button></div>
    </form>
  </Popup>;
}
type FilterRow = { kind: 'field'; id: string; name: string } | { kind: 'new-field'; name: string } | { kind: 'op'; op: FilterOp } | { kind: 'value'; value: string; label: string };
/** Three picker steps: field, operator, value. A chip trail above the rows shows what is chosen so far; Backspace on an empty query steps back. */
function FilterPopup(props: { anchor: HTMLElement; fields: FieldDefinition[]; initialField: string; onDismiss(): void; onNewField(name: string): Promise<string>; onAdd(filter: { field: string; op: FilterOp; value: string | null }): void }) {
  const initial = props.fields.find(candidate => candidate.id === props.initialField);
  const [field, setField] = createSignal<{ id: string | null; name: string } | null>(initial ? { id: initial.id, name: initial.name } : null);
  const [op, setOp] = createSignal<FilterOp | null>(null);
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const step = () => !field() ? 'field' : !op() ? 'op' : 'value';
  const definition = () => props.fields.find(candidate => candidate.id === field()?.id);
  const needle = () => query().trim().toLocaleLowerCase();
  const rows = createMemo((): FilterRow[] => {
    if (step() === 'field') {
      const matching = props.fields.filter(candidate => candidate.name.toLocaleLowerCase().includes(needle())).map((candidate): FilterRow => ({ kind: 'field', id: candidate.id, name: candidate.name }));
      const exact = props.fields.some(candidate => candidate.name.toLocaleLowerCase() === needle());
      return query().trim() && !exact ? [...matching, { kind: 'new-field', name: query().trim() }] : matching;
    }
    if (step() === 'op') return (Object.keys(filterLabels) as FilterOp[]).filter(candidate => filterLabels[candidate].includes(needle())).map(candidate => ({ kind: 'op', op: candidate }));
    const options = definition()?.options ?? [];
    const choices = options.filter(option => option.text.toLocaleLowerCase().includes(needle())).map((option): FilterRow => ({ kind: 'value', value: option.text, label: option.text }));
    const typed = query().trim();
    return typed && !options.some(option => option.text === typed) ? [...choices, { kind: 'value', value: typed, label: `“${typed}”` }] : choices;
  });
  const finish = async (value: string | null) => {
    if (busy()) return; setBusy(true);
    try {
      const chosen = field()!;
      const id = chosen.id ?? await props.onNewField(chosen.name);
      props.onAdd({ field: id, op: op()!, value });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const pick = (row: FilterRow) => {
    setQuery(''); setError('');
    if (row.kind === 'field') setField({ id: row.id, name: row.name });
    else if (row.kind === 'new-field') setField({ id: null, name: row.name });
    else if (row.kind === 'op') { setOp(row.op); if (row.op === 'set' || row.op === 'empty') void finish(null); }
    else void finish(row.value);
  };
  const placeholder = () => step() === 'field' ? 'Field name' : step() === 'op' ? 'Condition' : definition()?.kind === 'date' ? 'YYYY-MM-DD' : definition()?.kind === 'choice' ? 'Choose or type a value' : 'Value';
  return <Picker<FilterRow> anchor={props.anchor} width={320} label="Add filter" onDismiss={props.onDismiss}
    query={query()} onQuery={setQuery} placeholder={placeholder()}
    prefix={<><Show when={field()}>{chosen => <span class="table-chip">{chosen().name}</span>}</Show><Show when={op()}>{chosen => <span class="table-chip">{filterLabels[chosen()]}</span>}</Show></>}
    items={rows()} key={row => row.kind === 'field' ? row.id : row.kind === 'op' ? row.op : row.kind === 'value' ? row.value : 'new'}
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
          : <><Icon name="check" /><span class="picker-text">{row.label}</span></>} />;
}
